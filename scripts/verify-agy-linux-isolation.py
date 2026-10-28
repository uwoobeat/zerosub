#!/usr/bin/python3
"""Exercise private Linux keyrings with synthetic data, never a real Google login.

Run with the system Python that provides python3-dbus. Supplying --agy also
checks native credential reads offline. Landlock denies TCP connections and
seccomp denies Internet datagram/raw sockets before exec. Local TCP listeners
and Unix sockets remain available. This is not a production account launcher.
"""

import argparse
import concurrent.futures
import ctypes
import errno
import json
import os
from pathlib import Path
import platform
import re
import secrets
import shutil
import signal
import subprocess
import sys
import tempfile
import time


class ProbeError(RuntimeError):
    """Only diagnostics authored here, never external process output."""


def require(condition, message):
    if not condition:
        raise ProbeError(message)


def offline_network():
    """Child-only kernel restrictions; fail closed before exec if unavailable."""
    architectures = {
        "x86_64": (0xC000003E, 41),
        "aarch64": (0xC00000B7, 198),
    }
    architecture, socket_call = architectures[platform.machine()]

    class Filter(ctypes.Structure):
        _fields_ = [("code", ctypes.c_ushort), ("jt", ctypes.c_ubyte),
                    ("jf", ctypes.c_ubyte), ("k", ctypes.c_uint)]

    class Program(ctypes.Structure):
        _fields_ = [("length", ctypes.c_ushort), ("filter", ctypes.POINTER(Filter))]

    class Ruleset(ctypes.Structure):
        _fields_ = [("filesystem", ctypes.c_uint64), ("network", ctypes.c_uint64)]

    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(38, 1, 0, 0, 0):
        os._exit(125)
    # Landlock ABI >= 4: handle CONNECT_TCP, grant no destination ports.
    # AF_UNIX is unaffected, and agy's local bootstrap can still bind/listen.
    ruleset = Ruleset(0, 2)
    descriptor = libc.syscall(444, ctypes.byref(ruleset), ctypes.sizeof(ruleset), 0)
    if descriptor < 0 or libc.syscall(446, descriptor, 0):
        os._exit(125)
    os.close(descriptor)
    rows = [
        (0x20, 0, 0, 4),  # seccomp_data.arch
        (0x15, 1, 0, architecture),
        (0x06, 0, 0, 0x80000000),  # reject other ABIs
        (0x20, 0, 0, 0),  # seccomp_data.nr
        (0x35, 0, 2, 425),  # io_uring_setup/enter/register can bypass socket()
        (0x25, 1, 0, 427),
        (0x06, 0, 0, 0x50000 | errno.EPERM),
        (0x15, 0, 8, socket_call),
        (0x20, 0, 0, 16),  # socket's domain argument
        (0x15, 6, 0, 1),  # AF_UNIX
        (0x15, 1, 0, 2),  # AF_INET
        (0x15, 0, 3, 10),  # AF_INET6; reject other domains
        (0x20, 0, 0, 24),  # socket's type argument
        (0x54, 0, 0, 0xF),  # ignore CLOEXEC/NONBLOCK flags
        (0x15, 1, 0, 1),  # SOCK_STREAM only; Landlock handles connect
        (0x06, 0, 0, 0x50000 | errno.EPERM),
        (0x06, 0, 0, 0x7FFF0000),
    ]
    filters = (Filter * len(rows))(*(Filter(*row) for row in rows))
    program = Program(len(rows), filters)
    if libc.prctl(22, 2, ctypes.byref(program), 0, 0):
        os._exit(125)


def stop(process):
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=3)


def wait_for(predicate):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.05)
    raise ProbeError("Private Secret Service did not become ready.")


def check_offline_guard():
    smoke = '''import errno,json,socket
checks = {}
listener = socket.socket()
listener.bind(("127.0.0.1", 0))
listener.listen()
checks["tcp_listener_allowed"] = True
try:
    socket.socket().connect(("127.0.0.1", 9))
except OSError as error:
    checks["tcp_connect_denied"] = error.errno == errno.EACCES
try:
    socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
except OSError as error:
    checks["udp_denied"] = error.errno == errno.EPERM
left, right = socket.socketpair()
left.send(b"x")
checks["unix_socket_allowed"] = right.recv(1) == b"x"
left.close()
right.close()
print(json.dumps(checks))
'''
    result = subprocess.run([sys.executable, "-c", smoke], preexec_fn=offline_network,
                            capture_output=True, text=True, timeout=5)
    require(result.returncode == 0, "Offline kernel guard is unavailable.")
    checks = json.loads(result.stdout)
    require(len(checks) == 4 and all(value is True for value in checks.values()),
            "Offline kernel guard smoke check failed.")


def native_read(agy, root, alternate_home=False):
    """Observe method-call headers only on our private, synthetic D-Bus."""
    monitor = subprocess.Popen(
        [shutil.which("dbus-monitor"), "--session",
         "type='method_call',interface='org.freedesktop.Secret.Item',member='GetSecret'"],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
    )
    try:
        # Wait for the monitor's acquisition event instead of racing agy startup.
        import select
        ready, _, _ = select.select([monitor.stdout], [], [], 5)
        require(ready, "Private D-Bus monitor did not become ready.")
        monitor.stdout.readline()
        env = dict(os.environ)
        if alternate_home:
            home = root / "alternate-home"
            home.mkdir(mode=0o700)
            env["HOME"] = str(home)
            # Intentionally keep the bus: HOME alone must not select another account.
        process = subprocess.Popen(
            [agy, "--print", "/usage", "--output-format", "json",
             "--log-file", str(root / "native.log")],
            env=env, cwd=root, stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            preexec_fn=offline_network,
        )
        timed_out = False
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            timed_out = True
            stop(process)
    finally:
        stop(monitor)
    output, _ = monitor.communicate(timeout=3)
    reads = [line for line in output.splitlines()
             if "member=GetSecret" in line and "path=/org/freedesktop/secrets/collection/login/" in line]
    require(reads, "Native keyring read not observed; exit=" + str(process.returncode) +
            ", monitored_calls=" + str(output.count("method call")) + ".")
    return {"private_keyring_read": True, "exit_code": process.returncode,
            "stopped_after_timeout": timed_out,
            "internet_disabled": True}


def worker(root, agy):
    import dbus

    require(root.is_absolute() and root.resolve() == root and root.name in ["a", "b"] and
            root.parent.name.startswith("zerosub-agy-") and
            root.parent.stat().st_uid == os.getuid() and (root.parent.stat().st_mode & 0o077) == 0 and
            root.stat().st_uid == os.getuid() and (root.stat().st_mode & 0o077) == 0 and
            (root / ".synthetic-only").is_file() and not (root / ".synthetic-only").is_symlink(),
            "Refusing a non-synthetic worker directory.")
    require(os.environ["HOME"] == str(root / "home"), "Unsafe probe HOME.")
    address_pattern = "unix:path=" + re.escape(str(root / "runtime" / "bus")) + "(?:,guid=[0-9a-f]{32})?"
    require(re.fullmatch(address_pattern, os.environ.get("DBUS_SESSION_BUS_ADDRESS", "")),
            "Refusing to use a non-private D-Bus.")
    password = secrets.token_urlsafe(32).encode()
    marker = ("ZEROSUB_SYNTHETIC_" + secrets.token_hex(16)).encode()
    bus = dbus.SessionBus()

    def start_keyring():
        process = subprocess.Popen(
            [shutil.which("gnome-keyring-daemon"), "--foreground", "--unlock",
             "--components=secrets", "--control-directory", str(root / "control")],
            stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        process.stdin.write(password)
        process.stdin.close()
        try:
            wait_for(lambda: bus.name_has_owner("org.freedesktop.secrets"))
            return process
        except Exception:
            stop(process)
            raise

    def session():
        service = dbus.Interface(bus.get_object("org.freedesktop.secrets", "/org/freedesktop/secrets"),
                                 "org.freedesktop.Secret.Service")
        alias = service.ReadAlias("default", timeout=5)
        require(str(alias) == "/org/freedesktop/secrets/collection/login", "Unexpected collection.")
        _, handle = service.OpenSession("plain", dbus.String("", variant_level=1), timeout=5)
        return service, handle, alias

    def read_marker():
        service, handle, alias = session()
        collection = dbus.Interface(bus.get_object("org.freedesktop.secrets", alias),
                                    "org.freedesktop.Secret.Collection")
        items = collection.SearchItems(dbus.Dictionary({"service": "gemini", "username": "antigravity"},
                                                       signature="ss"), timeout=5)
        require(len(items) == 1, "Private keyring must contain exactly one synthetic item.")
        item = dbus.Interface(bus.get_object("org.freedesktop.secrets", items[0]), "org.freedesktop.Secret.Item")
        value = bytes(item.GetSecret(handle, timeout=5)[2])
        dbus.Interface(bus.get_object("org.freedesktop.secrets", handle), "org.freedesktop.Secret.Session").Close(timeout=5)
        return value

    process = start_keyring()
    try:
        if agy:
            check_offline_guard()
        _, handle, alias = session()
        collection = dbus.Interface(bus.get_object("org.freedesktop.secrets", alias),
                                    "org.freedesktop.Secret.Collection")
        properties = dbus.Dictionary({
            "org.freedesktop.Secret.Item.Label": dbus.String("ZeroSub synthetic isolation probe"),
            "org.freedesktop.Secret.Item.Attributes": dbus.Dictionary(
                {"service": "gemini", "username": "antigravity"}, signature="ss"),
        }, signature="sv")
        secret = dbus.Struct((handle, dbus.ByteArray(b""), dbus.ByteArray(marker), "text/plain"), signature="oayays")
        _, prompt = collection.CreateItem(properties, secret, True, timeout=5)
        require(str(prompt) == "/", "Synthetic keyring unexpectedly requested interaction.")
        require(read_marker() == marker, "Private keyring roundtrip failed.")
        report = {"synthetic_roundtrip": True}
        if agy:
            report["native"] = native_read(agy, root)
            report["home_only_control"] = native_read(agy, root, alternate_home=True)
        stop(process)
        wait_for(lambda: not bus.name_has_owner("org.freedesktop.secrets"))
        process = start_keyring()
        require(read_marker() == marker, "Private keyring did not survive its daemon restart.")
        report["restart_persistence"] = True
        files = list((root / "data" / "keyrings").glob("*"))
        require(files, "Private keyring files were not created under XDG_DATA_HOME.")
        require(all(path.is_file() and (path.stat().st_mode & 0o077) == 0 for path in files),
                "Private keyring files are not restricted to their owner.")
        report["private_file_permissions"] = True
        report["bus_address"] = os.environ["DBUS_SESSION_BUS_ADDRESS"]
        # Random synthetic markers are not credentials; used only to compare profiles.
        report["synthetic_marker"] = marker.decode()
        return report
    finally:
        stop(process)
        bus.close()


def profile(base, name, agy):
    root = base / name
    root.mkdir(mode=0o700)
    (root / ".synthetic-only").touch(mode=0o600)
    for directory in ["home", "config", "data", "cache", "runtime", "control", "tmp"]:
        (root / directory).mkdir(mode=0o700)
    config = root / "bus.conf"
    config.write_text(
        '<busconfig><type>session</type><listen>unix:path=' + str(root / "runtime" / "bus") +
        '</listen><auth>EXTERNAL</auth><policy context="default"><allow user="' + str(os.getuid()) +
        '"/><allow own="*"/><allow send_destination="*"/><allow receive_sender="*"/>'
        '<allow eavesdrop="true"/></policy></busconfig>'
    )
    # No ambient auth, desktop bus, browser or SSH variables enter this profile.
    env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "LANG": "C.UTF-8",
           "HOME": str(root / "home"), "XDG_CONFIG_HOME": str(root / "config"),
           "XDG_DATA_HOME": str(root / "data"), "XDG_CACHE_HOME": str(root / "cache"),
           "XDG_RUNTIME_DIR": str(root / "runtime"), "TMPDIR": str(root / "tmp"),
           "AGY_CLI_DISABLE_AUTO_UPDATE": "true", "BROWSER": "/usr/bin/false"}
    command = [shutil.which("dbus-run-session"), "--config-file", str(config), "--",
               sys.executable, str(Path(__file__).resolve()), "--worker", str(root)]
    if agy:
        command += ["--agy", agy]
    process = subprocess.Popen(command, env=env, stdin=subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               text=True, start_new_session=True)
    try:
        output, diagnostics = process.communicate(timeout=55)
        # Do not disclose unexpected worker/CLI output on failure.
        if process.returncode != 0:
            try:
                error = next(json.loads(line) for line in diagnostics.splitlines()
                             if line.startswith('{"ok": false'))
                if error.get("error_type") == "ProbeError":
                    raise ProbeError("Profile " + name + ": " + error["message"])
                kind = error.get("error_type", "")
                if isinstance(kind, str) and kind.isidentifier():
                    raise ProbeError("Private profile " + name + " failed (" + kind + ").")
            except (ValueError, TypeError, KeyError, StopIteration):
                pass
            raise ProbeError("Private profile " + name + " failed; no raw diagnostics disclosed.")
        return json.loads(output)
    finally:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        # Reap helpers in the group even if dbus-run-session has already exited.
        deadline = time.monotonic() + 1
        while time.monotonic() < deadline:
            try:
                os.killpg(process.pid, 0)
            except ProcessLookupError:
                break
            time.sleep(0.05)
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait(timeout=3)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--agy", help="Absolute native agy path; runs only under offline Landlock/seccomp.")
    parser.add_argument("--worker", type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args()
    require(sys.platform == "linux", "This diagnostic is Linux-only.")
    for command in ["dbus-run-session", "gnome-keyring-daemon", "dbus-monitor"]:
        require(shutil.which(command), "Missing prerequisite: " + command)
    if args.agy:
        require(Path(args.agy).is_absolute() and os.access(args.agy, os.X_OK), "--agy must be an absolute executable path.")
        require(platform.machine() in ["x86_64", "aarch64"], "Unsupported seccomp architecture.")
    if args.worker:
        print(json.dumps(worker(args.worker, args.agy)))
        return
    import dbus  # Fail before creating profiles when system python3-dbus is absent.
    with tempfile.TemporaryDirectory(prefix="zerosub-agy-") as temporary:
        base = Path(temporary)
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(profile, base, name, args.agy) for name in ["a", "b"]]
            reports = [future.result() for future in futures]
        require(reports[0]["bus_address"] != reports[1]["bus_address"], "Profiles shared a D-Bus.")
        require(reports[0]["synthetic_marker"] != reports[1]["synthetic_marker"], "Profiles shared a marker.")
        for report in reports:
            del report["bus_address"]
            del report["synthetic_marker"]
        print(json.dumps({"profiles": reports, "separate_buses": True,
                          "separate_synthetic_values": True, "real_login_tested": False,
                          "temporary_profiles_removed": True}, indent=2))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # A dbus or CLI error may contain unexpected data; publish only the class.
        report = {"ok": False, "error_type": type(error).__name__}
        if isinstance(error, ProbeError):
            report["message"] = str(error)
        print(json.dumps(report), file=sys.stderr)
        sys.exit(1)
