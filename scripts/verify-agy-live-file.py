#!/usr/bin/python3
"""Validate an already signed-in profile without D-Bus, keyring or .env reads."""

import argparse
import fcntl
import json
import os
from pathlib import Path
import runpy
import selectors
import shutil
import subprocess
import sys
import tempfile
import time


helper = runpy.run_path(str(Path(__file__).with_name("agy-linux-profile.py")))
CheckError = helper["CheckError"]
require = helper["require"]


def session_startup(command, env, cwd):
    process = subprocess.Popen(command, env=env, cwd=cwd, stdin=subprocess.PIPE,
                               stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, start_new_session=True)
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    buffer = bytearray()
    total = 0
    deadline = time.monotonic() + 30
    try:
        while time.monotonic() < deadline:
            for key, _ in selector.select(0.2):
                chunk = os.read(key.fd, 65536)
                require(chunk, "Native stream closed before initialization.")
                total += len(chunk)
                require(total <= 1024 * 1024, "Native initialization exceeded the output limit.")
                buffer.extend(chunk)
                while b"\n" in buffer:
                    line, _, rest = buffer.partition(b"\n")
                    buffer = bytearray(rest)
                    if not line.strip():
                        continue
                    try:
                        frame = json.loads(line)
                    except ValueError:
                        raise CheckError("Invalid native initialization frame.") from None
                    require(isinstance(frame, dict) and frame.get("event") == "init" and
                            isinstance(frame.get("conversation_id"), str) and frame["conversation_id"] and
                            isinstance(frame.get("init"), dict), "Unexpected native initialization frame.")
                    return {"native_init_received": True, "prompts_sent": 0}
        raise CheckError("Native stream did not initialize within 30 seconds.")
    finally:
        selector.close()
        process.stdin.close()
        helper["stop"](process)
        process.stdout.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("profile", choices=["a", "b"])
    parser.add_argument("operation", choices=["usage", "session"])
    args = parser.parse_args()
    require(sys.platform == "linux", "This probe is Linux-only.")
    for command in ["agy", "strace"]:
        require(shutil.which(command), "Missing prerequisite: " + command)
    base = helper["BASE"]
    helper["private_directory"](base)
    profile = base / args.profile
    helper["private_directory"](profile)
    for directory in ["home", "config", "data", "cache", "work"]:
        helper["private_directory"](profile / directory)
    lock = helper["open_private"](profile / "profile.lock", os.O_RDWR)
    try:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise CheckError("This profile is already in use.") from None
        require(helper["credential_metadata"](profile, False)["credential_file_present"],
                "Complete this profile's official login first.")
        with tempfile.TemporaryDirectory(prefix="zs-agy-file-" + args.profile + "-") as temporary:
            runtime = Path(temporary)
            trace = runtime / "syscalls"
            trace.touch(mode=0o600)
            env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "LANG": "C.UTF-8",
                   "HOME": str(profile / "home"), "XDG_CONFIG_HOME": str(profile / "config"),
                   "XDG_DATA_HOME": str(profile / "data"), "XDG_CACHE_HOME": str(profile / "cache"),
                   "XDG_RUNTIME_DIR": str(runtime), "TMPDIR": str(runtime),
                   "DBUS_SESSION_BUS_ADDRESS": "", "AGY_CLI_DISABLE_AUTO_UPDATE": "true",
                   "BROWSER": "/usr/bin/false"}
            command = [shutil.which("strace"), "-f", "-qq", "-e", "trace=openat,connect",
                       "-o", str(trace), str(Path(shutil.which("agy")).resolve())]
            if args.operation == "usage":
                command += ["--print", "/usage", "--output-format", "json", "--log-file", "/dev/null"]
                result = {"num_turns": 0, "quota": helper["bounded_usage"](command, env, profile / "work")}
            else:
                command += ["--input-format", "stream-json", "--output-format", "stream-json",
                            "--add-dir", str(profile / "work"), "--disable-slash-commands",
                            "--dangerously-skip-permissions", "--log-file", "/dev/null"]
                result = session_startup(command, env, profile / "work")
            # Syscall names, file paths and socket addresses only; no read/write payloads.
            lines = trace.read_text().splitlines()
            file_opened = any("openat(" in line and
                              str(profile / "home/.gemini/antigravity-cli/antigravity-oauth-token") in line
                              for line in lines)
            bus_connections = sum("connect(" in line and "AF_UNIX" in line and
                                  ("/bus" in line or "dbus" in line) for line in lines)
            require(file_opened and bus_connections == 0, "Expected native file authentication was not observed.")
            print(json.dumps({"profile": args.profile, "operation": args.operation,
                              "native_credential_file_opened": file_opened,
                              "dbus_connections_observed": bus_connections, **result}))
    finally:
        os.close(lock)


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
