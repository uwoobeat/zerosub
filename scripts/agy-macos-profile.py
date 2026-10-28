#!/usr/bin/python3
"""Manual macOS live checks; the official native CLI owns all Google credentials.

prepare reads only a Keychain password from non-TTY stdin, never argv/env/.env.
login needs three user-operated TTY streams over SSH. No OAuth code is captured.
Login uses the read-only /usage print command, not the interactive TUI.
Only these profiles' Keychains get a 1-hour idle lock and lock-on-sleep policy.
Unlock happens in the same SSH connection as the native command: Apple's TTY
prompt for login, or --unlock-stdin for noninteractive checks.
Credentials and profiles are preserved. This is not a production launcher.
"""

import argparse
import ctypes
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import runpy
import shlex
import signal
import stat
import subprocess
import sys
import tempfile


helper = runpy.run_path(str(Path(__file__).with_name("agy-linux-profile.py")))
stream_helper = runpy.run_path(str(Path(__file__).with_name("verify-agy-live-file.py")))
CheckError = helper["CheckError"]
require = helper["require"]
REAL_HOME = Path(pwd.getpwuid(os.getuid()).pw_dir)
BASE = REAL_HOME / ".local/state/zerosub-agy-check"
SECURITY = "/usr/bin/security"
PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
LOCK_SECONDS = 3600


def security_quote(value):
    """Apple split_line ends an argument at its closing quote: no shell concat.

    shlex.quote cannot be used: its single-quote escape creates extra arguments.
    Apple's quoted parser instead accepts escaped backslashes and double quotes.
    See SecurityTool/macOS/security.c split_line in apple-oss-distributions/Security.
    """
    require(isinstance(value, str) and not any(char in value for char in "\0\r\n"),
            "Invalid security command argument.")
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def security_line(arguments):
    line = (" ".join(security_quote(value) for value in arguments) + "\n").encode("utf-8")
    require(len(line) < 4096, "Security command exceeds its safe input limit.")
    return line


def security_env(home):
    return {"HOME": str(home), "PATH": PATH, "LANG": "en_US.UTF-8"}


def security_run(arguments, home, interactive_input=None):
    result = subprocess.run([SECURITY] + list(arguments), env=security_env(home),
                            input=interactive_input,
                            stdin=subprocess.DEVNULL if interactive_input is None else None,
                            stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, timeout=10)
    require(len(result.stdout) <= 65536, "Unexpected security command output size.")
    return result


def security_stdin(arguments, home):
    # One command per process: a later successful command must not hide failure.
    result = security_run(["-q", "-i"], home, security_line(arguments))
    require(result.returncode == 0, "Private Keychain command failed; diagnostics suppressed.")


def host_snapshot():
    values = []
    for arguments in (["default-keychain"], ["list-keychains"],
                      ["default-keychain", "-d", "user"], ["list-keychains", "-d", "user"]):
        result = security_run(arguments, REAL_HOME)
        values.append((result.returncode, result.stdout))
    preference = REAL_HOME / "Library/Preferences/com.apple.security.plist"
    if preference.exists() or preference.is_symlink():
        metadata = preference.lstat()
        require(stat.S_ISREG(metadata.st_mode) and metadata.st_uid == os.getuid() and
                metadata.st_size <= 1024 * 1024, "Unsafe real Keychain preferences metadata.")
        descriptor = os.open(preference, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
        try:
            with os.fdopen(descriptor, "rb") as source:
                fingerprint = hashlib.sha256(source.read(1024 * 1024 + 1)).digest()
        except Exception:
            raise CheckError("Cannot fingerprint real Keychain preferences.") from None
    else:
        fingerprint = None
    return values, fingerprint


def private_keychain_metadata(keychain):
    require(keychain.resolve() == keychain, "Private Keychain path contains a symlink.")
    metadata = keychain.lstat()
    require(stat.S_ISREG(metadata.st_mode) and metadata.st_uid == os.getuid() and
            metadata.st_mode & 0o077 == 0 and metadata.st_nlink == 1,
            "Unsafe private Keychain file.")


def private_preferences(home):
    preference = home / "Library/Preferences/com.apple.security.plist"
    if preference.exists() or preference.is_symlink():
        metadata = preference.lstat()
        require(preference.resolve() == preference and stat.S_ISREG(metadata.st_mode) and
                metadata.st_uid == os.getuid() and metadata.st_nlink == 1,
                "Unsafe private Keychain preferences file.")


def keychain_unlocked(keychain):
    """Security.framework metadata only; never asks for an item or secret value."""
    framework = ctypes.CDLL("/System/Library/Frameworks/Security.framework/Security")
    core = ctypes.CDLL("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")
    framework.SecKeychainSetUserInteractionAllowed.argtypes = [ctypes.c_ubyte]
    framework.SecKeychainOpen.argtypes = [ctypes.c_char_p, ctypes.POINTER(ctypes.c_void_p)]
    framework.SecKeychainGetStatus.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint32)]
    core.CFRelease.argtypes = [ctypes.c_void_p]
    require(framework.SecKeychainSetUserInteractionAllowed(False) == 0,
            "Cannot disable Keychain metadata interaction.")
    reference = ctypes.c_void_p()
    require(framework.SecKeychainOpen(os.fsencode(keychain), ctypes.byref(reference)) == 0,
            "Cannot open private Keychain metadata.")
    try:
        status = ctypes.c_uint32()
        require(framework.SecKeychainGetStatus(reference, ctypes.byref(status)) == 0,
                "Cannot inspect private Keychain lock status.")
        return bool(status.value & 1)
    finally:
        core.CFRelease(reference)


def security_paths(arguments, home):
    result = security_run(arguments, home)
    require(result.returncode == 0, "Cannot inspect private Keychain selection.")
    try:
        return shlex.split(result.stdout.decode("utf-8"))
    except (ValueError, UnicodeError):
        raise CheckError("Invalid private Keychain selection output.") from None


def verify_selection(home, keychain):
    expected = [keychain]
    for arguments in (["default-keychain"], ["default-keychain", "-d", "user"],
                      ["list-keychains", "-d", "user"]):
        require([Path(path).resolve() for path in security_paths(arguments, home)] == expected,
                "Private HOME does not exclusively select its own Keychain.")
    implicit = [Path(path).resolve() for path in security_paths(["list-keychains"], home)]
    system = Path("/Library/Keychains/System.keychain")
    require(keychain in implicit and len(implicit) == len(set(implicit)) and
            all(path in [keychain, system] for path in implicit),
            "Private HOME search includes an unexpected Keychain.")
    if system in implicit:
        # macOS appends its system domain even to a private user-domain list.
        # Check attributes only: a shared native-auth item would make selection ambiguous.
        result = subprocess.run([SECURITY, "find-generic-password", "-s", "gemini", "-a", "antigravity",
                                 str(system)], env=security_env(home), stdin=subprocess.DEVNULL,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
        require(result.returncode == 44, "System Keychain may contain an ambiguous native credential item.")


def credential_status(profile, env):
    keychain = profile / "home/Library/Keychains/account.keychain-db"
    private_keychain_metadata(keychain)
    # Attributes only, explicit private path, output discarded: never -w or -g.
    result = subprocess.run([SECURITY, "find-generic-password", "-s", "gemini", "-a", "antigravity",
                             str(keychain)], env=env, stdin=subprocess.DEVNULL,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
    require(result.returncode in [0, 44], "Cannot inspect private credential item metadata.")
    metadata = helper["credential_metadata"](profile, result.returncode == 0)
    return dict(metadata, credential_item_check_exit=result.returncode,
                private_keychain_unlocked=keychain_unlocked(keychain))


def profile_env(profile, runtime):
    env = {"PATH": PATH, "LANG": "en_US.UTF-8", "HOME": str(profile / "home"),
           "XDG_CONFIG_HOME": str(profile / "config"), "XDG_DATA_HOME": str(profile / "data"),
           "XDG_CACHE_HOME": str(profile / "cache"), "TMPDIR": str(runtime) + "/",
           "AGY_CLI_DISABLE_AUTO_UPDATE": "true", "BROWSER": "/usr/bin/false"}
    terminal = os.environ.get("TERM", "xterm-256color")
    require(re.fullmatch(r"[A-Za-z0-9_.:+-]{1,80}", terminal), "Invalid terminal environment.")
    env["TERM"] = terminal
    # Without a supplied identity, native agy 1.4.6 can wait indefinitely for
    # a DA2 reply on /dev/tty. Preserve the caller's real terminal identity.
    terminal_program = os.environ.get("TERM_PROGRAM")
    if terminal_program:
        require(re.fullmatch(r"[A-Za-z0-9_.:+-]{1,80}", terminal_program),
                "Invalid terminal program environment.")
        env["TERM_PROGRAM"] = terminal_program
    for key in ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"]:
        value = os.environ.get(key)
        if value:
            require(len(value) <= 1024 and "\0" not in value, "Invalid SSH environment.")
            env[key] = value
    return env


def stdin_password():
    require(not sys.stdin.isatty(), "Keychain passwords are accepted only from non-TTY stdin.")
    password = sys.stdin.buffer.read(2049)
    require(0 < len(password) <= 2048, "Invalid Keychain password input length.")
    try:
        value = password.decode("utf-8")
    except UnicodeError:
        raise CheckError("Keychain password input must be UTF-8.") from None
    require(not any(character in value for character in "\0\r\n"),
            "Keychain password must contain no NUL or line breaks.")
    return value


def unlock_keychain(home, keychain, password=None):
    private_keychain_metadata(keychain)
    if password is not None:
        security_stdin(["unlock-keychain", "-p", password, str(keychain)], home)
    elif not keychain_unlocked(keychain):
        require(all(stream.isatty() for stream in [sys.stdin, sys.stdout, sys.stderr]),
                "Unlock requires a user-operated terminal or --unlock-stdin.")
        print("이 프로필의 Keychain을 해제하려면 Apple 암호 프롬프트에 Mac 암호를 입력하세요.", flush=True)
        # Apple prompts on the inherited TTY without echo. Never pass -p here,
        # and never pipe, capture, or log this interactive command's streams.
        result = subprocess.run([SECURITY, "unlock-keychain", str(keychain)], env=security_env(home))
        require(result.returncode == 0, "Private Keychain unlock failed.")
    require(keychain_unlocked(keychain), "Private Keychain remains locked in this SSH connection.")


def prepare(profile, password):
    home = profile / "home"
    private_preferences(home)
    keychain = home / "Library/Keychains/account.keychain-db"
    if not keychain.exists() and not keychain.is_symlink():
        security_stdin(["create-keychain", "-p", password, str(keychain)], home)
    private_keychain_metadata(keychain)
    # A locked existing Keychain refuses set-keychain-settings; unlock first.
    security_stdin(["unlock-keychain", "-p", password, str(keychain)], home)
    for arguments in (["default-keychain", "-d", "user", "-s", str(keychain)],
                      ["list-keychains", "-d", "user", "-s", str(keychain)],
                      ["set-keychain-settings", "-l", "-u", "-t", str(LOCK_SECONDS), str(keychain)]):
        require(security_run(arguments, home).returncode == 0, "Private Keychain preparation failed.")
    verify_selection(home, keychain)
    require(keychain_unlocked(keychain), "Private Keychain remains locked.")
    return {"private_keychain_prepared": True, "private_keychain_unlocked": True,
            "idle_lock_seconds": LOCK_SECONDS, "lock_on_sleep": True,
            "credentials_preserved": True}


def run_profile(operation, name, agy=None, base=None, password=None):
    base = BASE if base is None else base
    require(operation in ["prepare", "login", "status", "usage", "session"], "Invalid validation operation.")
    require(name in ["a", "b"], "Invalid validation profile.")
    require(base.is_absolute() and base.resolve() == base, "Unsafe validation base path.")
    if operation == "prepare":
        base.parent.mkdir(parents=True, exist_ok=True)
        helper["private_directory"](base)
        helper["private_directory"](base / name)
    else:
        require(base.is_dir() and (base / name).is_dir(), "Prepare this profile first.")
        helper["private_directory"](base)
        helper["private_directory"](base / name)
    profile = base / name
    flags = os.O_RDWR | (os.O_CREAT if operation == "prepare" else 0)
    lock = helper["open_private"](profile / "profile.lock", flags)
    try:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise CheckError("This profile is already in use.") from None
        directories = ["home", "config", "data", "cache", "work", "home/.gemini",
                       "home/.gemini/antigravity-cli", "home/Library",
                       "home/Library/Keychains", "home/Library/Preferences"]
        for directory in directories:
            require(operation == "prepare" or (profile / directory).is_dir(), "Incomplete prepared profile.")
            helper["private_directory"](profile / directory)
        before = host_snapshot()
        try:
            if operation == "prepare":
                require(isinstance(password, str) and password, "Prepare requires its stdin password.")
                result = prepare(profile, password)
            else:
                keychain = profile / "home/Library/Keychains/account.keychain-db"
                private_preferences(profile / "home")
                verify_selection(profile / "home", keychain)
                with tempfile.TemporaryDirectory(prefix="zs-agy-mac-" + name + "-") as temporary:
                    env = profile_env(profile, Path(temporary))
                    if operation == "login":
                        require(all(stream.isatty() for stream in [sys.stdin, sys.stdout, sys.stderr]),
                                "Login requires a user-operated terminal on all three streams.")
                        require(env.get("SSH_CONNECTION"), "Login requires a real SSH terminal for the native code flow.")
                        require(password is None, "Login uses only Apple's interactive unlock prompt.")
                        unlock_keychain(profile / "home", keychain)
                    elif password is not None:
                        unlock_keychain(profile / "home", keychain, password)
                    metadata = credential_status(profile, env)
                    if operation == "status":
                        result = metadata
                    else:
                        require(metadata["private_keychain_unlocked"],
                                "Unlock this private Keychain in this connection with --unlock-stdin.")
                        if operation == "login":
                            print("프로필 " + name.upper() + ": 터미널의 공식 로그인 URL·코드 절차를 완료하세요. /usage 조회 후 자동 종료됩니다.", flush=True)
                            previous = signal.signal(signal.SIGINT, signal.SIG_IGN)
                            try:
                                def child_signals():
                                    signal.signal(signal.SIGINT, signal.SIG_DFL)
                                completed = subprocess.run(
                                    [agy, "--print", "/usage", "--output-format", "json", "--log-file", "/dev/null"],
                                    env=env, cwd=profile / "work", preexec_fn=child_signals)
                            finally:
                                signal.signal(signal.SIGINT, previous)
                            result = credential_status(profile, env)
                            require(result["credential_item_present"] or result["credential_file_present"],
                                    "No saved CLI credential was found in this profile.")
                            require(completed.returncode == 0,
                                    "Native login /usage failed; any saved credentials are preserved. Check usage separately.")
                            result["credentials_preserved"] = True
                            result["login_command_exit"] = completed.returncode
                        else:
                            require(metadata["credential_item_present"] or metadata["credential_file_present"],
                                    "Complete this profile's official login first.")
                            command = [agy]
                            if operation == "usage":
                                command += ["--print", "/usage", "--output-format", "json", "--log-file", "/dev/null"]
                                result = {"num_turns": 0, "quota": helper["bounded_usage"](command, env, profile / "work"),
                                          "checked_at": datetime.datetime.now(datetime.timezone.utc).isoformat()}
                            else:
                                require(operation == "session", "Invalid validation operation.")
                                command += ["--input-format", "stream-json", "--output-format", "stream-json",
                                            "--add-dir", str(profile / "work"), "--disable-slash-commands",
                                            "--dangerously-skip-permissions", "--log-file", "/dev/null"]
                                result = stream_helper["session_startup"](command, env, profile / "work")
        finally:
            require(host_snapshot() == before, "Real HOME Keychain settings changed; stop validation.")
        return dict(result, profile=name, operation=operation, real_keychain_settings_unchanged=True)
    finally:
        os.close(lock)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=["prepare", "login", "status", "usage", "session"])
    parser.add_argument("profile", choices=["a", "b"])
    parser.add_argument("--agy", default="/opt/homebrew/bin/agy", help="Absolute official native CLI path.")
    parser.add_argument("--unlock-stdin", action="store_true",
                        help="Unlock in this SSH connection using non-TTY stdin (status/usage/session only).")
    args = parser.parse_args()
    require(sys.platform == "darwin", "This helper is macOS-only.")
    require(not args.unlock_stdin or args.operation in ["status", "usage", "session"],
            "--unlock-stdin is only for noninteractive checks.")
    if args.operation == "login":
        require(all(stream.isatty() for stream in [sys.stdin, sys.stdout, sys.stderr]),
                "Login requires a user-operated terminal on all three streams.")
    if args.operation in ["login", "usage", "session"]:
        require(Path(args.agy).is_absolute() and os.access(args.agy, os.X_OK),
                "An absolute executable native agy path is required.")
    password = stdin_password() if args.operation == "prepare" or args.unlock_stdin else None
    result = run_profile(args.operation, args.profile, args.agy, password=password)
    del password
    print(json.dumps(result), flush=True)


if __name__ == "__main__":
    os.umask(0o077)
    try:
        main()
    except CheckError as error:
        print(json.dumps({"ok": False, "message": str(error)}), file=sys.stderr)
        sys.exit(1)
    except (Exception, KeyboardInterrupt) as error:
        print(json.dumps({"ok": False, "error_type": type(error).__name__}), file=sys.stderr)
        sys.exit(1)
