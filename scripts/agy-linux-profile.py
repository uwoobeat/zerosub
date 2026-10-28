#!/usr/bin/python3
"""Manual live validation profiles. OAuth stays entirely inside official agy.

login requires a user TTY; never capture that terminal. Profiles are preserved.
The existing ignored .env UBCORE_PASSWORD unlocks only these test keyrings.
"""

import argparse
import datetime
import fcntl
import json
import math
import os
from pathlib import Path
import pwd
import re
import selectors
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
from xml.sax.saxutils import escape


REPO = Path(__file__).resolve().parent.parent
BASE = Path(pwd.getpwuid(os.getuid()).pw_dir) / ".local/state/zerosub-agy-check"


class CheckError(RuntimeError):
    pass


def require(condition, message):
    if not condition:
        raise CheckError(message)


def private_directory(path):
    if not path.exists() and not path.is_symlink():
        path.mkdir(mode=0o700)
    metadata = path.lstat()
    require(stat.S_ISDIR(metadata.st_mode) and metadata.st_uid == os.getuid() and
            metadata.st_mode & 0o077 == 0, "Unsafe validation directory.")


def open_private(path, flags):
    descriptor = os.open(path, flags | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    metadata = os.fstat(descriptor)
    if not (stat.S_ISREG(metadata.st_mode) and metadata.st_uid == os.getuid() and
            metadata.st_mode & 0o077 == 0 and metadata.st_nlink == 1):
        os.close(descriptor)
        raise CheckError("Unsafe validation file.")
    return descriptor


def load_password():
    env_file = REPO / ".env"
    descriptor = open_private(env_file, os.O_RDONLY)
    os.close(descriptor)
    node = shutil.which("node")
    require(node, "Node.js is required to read the ignored .env safely.")
    result = subprocess.run(
        [node, "-e", "process.loadEnvFile(process.argv[1]); process.stdout.write(process.env.UBCORE_PASSWORD || '')", str(env_file)],
        env={"PATH": os.environ.get("PATH", "/usr/bin:/bin")},
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=5,
    )
    require(result.returncode == 0 and 0 < len(result.stdout) <= 4096 and b"\0" not in result.stdout,
            "Could not load the test keyring unlock password.")
    return result.stdout


def credential_metadata(profile, keyring_present):
    path = profile / "home/.gemini/antigravity-cli/antigravity-oauth-token"
    file_present = False
    if path.exists() or path.is_symlink():
        metadata = path.lstat()
        require(path.resolve() == path and stat.S_ISREG(metadata.st_mode) and
                metadata.st_uid == os.getuid() and metadata.st_mode & 0o077 == 0 and
                metadata.st_nlink == 1, "Unsafe native CLI credential file.")
        file_present = metadata.st_size > 0
    return {"credential_item_present": bool(keyring_present),
            "credential_file_present": file_present}


def stop(process):
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    try:
        process.wait(timeout=3)
    except subprocess.TimeoutExpired:
        pass
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    process.wait(timeout=3)


def wait_for(predicate):
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.1)
    raise CheckError("Private keyring is not ready or remains locked.")


def quota_summary(raw):
    try:
        value = json.loads(raw)
    except (ValueError, TypeError):
        raise CheckError("Native usage did not return valid JSON.") from None
    require(isinstance(value, dict) and value.get("status") == "SUCCESS" and
            type(value.get("num_turns")) is int and value["num_turns"] == 0,
            "Native usage was unsuccessful or unexpectedly ran a model turn.")
    command = value.get("command")
    require(isinstance(command, dict) and command.get("name") == "usage" and
            isinstance(command.get("data"), dict), "Unexpected usage command response.")
    groups = command["data"].get("groups")
    require(isinstance(groups, list) and 0 < len(groups) <= 100, "Missing quota groups.")
    output = []
    for group in groups:
        require(isinstance(group, dict) and isinstance(group.get("buckets"), list), "Invalid quota group.")
        for bucket in group["buckets"]:
            require(isinstance(bucket, dict), "Invalid quota bucket.")
            if bucket.get("disabled") is True:
                continue
            fraction = bucket.get("remaining_fraction")
            identifier = bucket.get("id")
            window = bucket.get("window")
            reset = bucket.get("reset_time")
            require(type(fraction) in [int, float] and math.isfinite(fraction) and 0 <= fraction <= 1,
                    "Invalid quota fraction.")
            require(isinstance(identifier, str) and re.fullmatch(r"[a-zA-Z0-9_.:-]{1,160}", identifier) and
                    isinstance(window, str) and re.fullmatch(r"[a-zA-Z0-9_-]{1,40}", window),
                    "Invalid quota identifier or window.")
            require(reset is None or (isinstance(reset, str) and
                    re.fullmatch(r"[0-9TtZz:.+\-]{1,64}", reset)), "Invalid quota reset time.")
            if reset is not None:
                try:
                    parsed_reset = datetime.datetime.fromisoformat(reset[:-1] + "+00:00" if reset[-1:] in ["Z", "z"] else reset)
                except ValueError:
                    raise CheckError("Invalid quota reset date.") from None
                require(parsed_reset.tzinfo is not None, "Quota reset time has no timezone.")
                reset = parsed_reset.astimezone(datetime.timezone.utc).isoformat()
            output.append({"id": identifier, "window": window,
                           "remaining_percent": round(fraction * 100, 3), "resets_at": reset})
    require(output, "No usable quota buckets.")
    return output


def bounded_usage(command, env, cwd):
    process = subprocess.Popen(command, env=env, cwd=cwd, stdin=subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, start_new_session=True)
    buffer = bytearray()
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    deadline = time.monotonic() + 45
    try:
        while selector.get_map():
            require(time.monotonic() < deadline, "Native usage timed out.")
            for key, _ in selector.select(0.2):
                chunk = os.read(key.fd, 65536)
                if not chunk:
                    selector.unregister(key.fileobj)
                    continue
                buffer.extend(chunk)
                require(len(buffer) <= 1024 * 1024, "Native usage exceeded the output limit.")
        require(process.wait(timeout=3) == 0, "Native usage failed; raw diagnostics suppressed.")
        return quota_summary(buffer)
    finally:
        selector.close()
        process.stdout.close()
        stop(process)


def run_profile(operation, name, agy):
    import dbus

    BASE.parent.mkdir(parents=True, exist_ok=True)
    private_directory(BASE)
    profile = BASE / name
    private_directory(profile)
    lock = open_private(profile / "profile.lock", os.O_CREAT | os.O_RDWR)
    try:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise CheckError("This profile is already in use.") from None
        for directory in ["home", "config", "data", "cache", "work"]:
            private_directory(profile / directory)
        password = load_password()
        with tempfile.TemporaryDirectory(prefix="zs-agy-" + name + "-") as temporary:
            runtime = Path(temporary)
            (runtime / "control").mkdir(mode=0o700)
            (runtime / "tmp").mkdir(mode=0o700)
            socket_path = str(runtime / "bus")
            require(len(socket_path.encode()) < 100, "Private bus socket path is too long.")
            config = runtime / "bus.conf"
            config.write_text('<busconfig><type>session</type><listen>unix:path=' + escape(socket_path) +
                              '</listen><auth>EXTERNAL</auth><policy context="default"><allow user="' +
                              str(os.getuid()) + '"/><allow own="*"/><allow send_destination="*"/>'
                              '<allow receive_sender="*"/></policy></busconfig>')
            env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "LANG": "C.UTF-8",
                   "TERM": os.environ.get("TERM", "xterm-256color"),
                   "HOME": str(profile / "home"), "XDG_CONFIG_HOME": str(profile / "config"),
                   "XDG_DATA_HOME": str(profile / "data"), "XDG_CACHE_HOME": str(profile / "cache"),
                   "XDG_RUNTIME_DIR": str(runtime), "TMPDIR": str(runtime / "tmp"),
                   "AGY_CLI_DISABLE_AUTO_UPDATE": "true", "BROWSER": "/usr/bin/false"}
            daemon = subprocess.Popen([shutil.which("dbus-daemon"), "--nofork", "--nopidfile",
                                       "--print-address=1", "--config-file=" + str(config)],
                                      env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                      stderr=subprocess.DEVNULL, start_new_session=True)
            keyring = None
            connection = None
            try:
                selector = selectors.DefaultSelector()
                try:
                    selector.register(daemon.stdout, selectors.EVENT_READ)
                    require(selector.select(5), "Private D-Bus did not start.")
                    address = daemon.stdout.readline(512).decode().strip()
                finally:
                    selector.close()
                require(re.fullmatch("unix:path=" + re.escape(socket_path) + "(?:,guid=[0-9a-f]{32})?", address),
                        "Unexpected private D-Bus address.")
                env["DBUS_SESSION_BUS_ADDRESS"] = address
                keyring = subprocess.Popen(
                    [shutil.which("gnome-keyring-daemon"), "--foreground", "--unlock", "--components=secrets",
                     "--control-directory", str(runtime / "control")], env=env,
                    stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                    start_new_session=True)
                keyring.stdin.write(password)
                keyring.stdin.close()
                del password
                connection = dbus.bus.BusConnection(address)
                wait_for(lambda: connection.name_has_owner("org.freedesktop.secrets"))
                properties = dbus.Interface(connection.get_object("org.freedesktop.secrets",
                                            "/org/freedesktop/secrets/collection/login"),
                                            "org.freedesktop.DBus.Properties")
                wait_for(lambda: not bool(properties.Get("org.freedesktop.Secret.Collection", "Locked", timeout=2)))
                collection = dbus.Interface(connection.get_object("org.freedesktop.secrets",
                                            "/org/freedesktop/secrets/collection/login"),
                                            "org.freedesktop.Secret.Collection")

                def credential_present():
                    return bool(collection.SearchItems(dbus.Dictionary(
                        {"service": "gemini", "username": "antigravity"}, signature="ss"), timeout=3))

                if operation == "login":
                    print("프로필 " + name.upper() + ": 공식 Google 로그인을 완료한 뒤 Ctrl+C로 agy를 종료하세요.", flush=True)
                    # Paseo is a remote terminal: request the CLI's own SSH code flow.
                    env["SSH_CONNECTION"] = "127.0.0.1 1 127.0.0.1 1"
                    old_handler = signal.signal(signal.SIGINT, signal.SIG_IGN)
                    try:
                        def child_signals():
                            signal.signal(signal.SIGINT, signal.SIG_DFL)
                        subprocess.run([agy, "--log-file", "/dev/null"], env=env, cwd=profile / "work",
                                       preexec_fn=child_signals)
                    finally:
                        signal.signal(signal.SIGINT, old_handler)
                    metadata = credential_metadata(profile, credential_present())
                    require(any(metadata.values()), "No saved CLI credential was found in this profile.")
                    print(json.dumps({"profile": name, **metadata, "credentials_preserved": True}), flush=True)
                else:
                    metadata = credential_metadata(profile, credential_present())
                    if operation == "status":
                        print(json.dumps({"profile": name, **metadata,
                                          "private_keyring_unlocked": True}), flush=True)
                    else:
                        require(any(metadata.values()), "Complete this profile's official login first.")
                        windows = bounded_usage([agy, "--print", "/usage", "--output-format", "json",
                                                 "--log-file", "/dev/null"], env, profile / "work")
                        print(json.dumps({"profile": name, "checked_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                                          "num_turns": 0, "quota": windows}), flush=True)
            finally:
                if connection:
                    connection.close()
                if keyring:
                    stop(keyring)
                stop(daemon)
                daemon.stdout.close()
    finally:
        os.close(lock)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=["login", "status", "usage"])
    parser.add_argument("profile", choices=["a", "b"])
    args = parser.parse_args()
    require(sys.platform == "linux", "This helper is Linux-only.")
    for command in ["agy", "node", "dbus-daemon", "gnome-keyring-daemon"]:
        require(shutil.which(command), "Missing prerequisite: " + command)
    if args.operation == "login":
        require(sys.stdin.isatty() and sys.stdout.isatty() and sys.stderr.isatty(),
                "Login requires a user-operated terminal on all three streams.")
    run_profile(args.operation, args.profile, str(Path(shutil.which("agy")).resolve()))


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
