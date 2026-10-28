#!/usr/bin/python3
"""Safety checks for the diagnostic; no real D-Bus connection is permitted."""

import os
from pathlib import Path
import runpy
import tempfile
import unittest
from unittest.mock import patch


probe = runpy.run_path(str(Path(__file__).with_name("verify-agy-linux-isolation.py")))


class WorkerBoundaries(unittest.TestCase):
    def test_arbitrary_directory_is_rejected_before_connecting(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch("dbus.SessionBus", side_effect=AssertionError("Must not connect")):
                with self.assertRaises(probe["ProbeError"]):
                    probe["worker"](Path(directory), None)

    def test_combined_and_foreign_bus_addresses_are_rejected_before_connecting(self):
        with tempfile.TemporaryDirectory(prefix="zerosub-agy-") as directory:
            root = Path(directory) / "a"
            root.mkdir(mode=0o700)
            (root / ".synthetic-only").touch(mode=0o600)
            own = "unix:path=" + str(root / "runtime" / "bus")
            for address in ["unix:path=/run/user/1000/bus", own + ";unix:path=/run/user/1000/bus",
                            "unix:path=/run/user/1000/bus;" + own]:
                with self.subTest(address_kind=address.startswith(own)):
                    with patch.dict(os.environ, {"HOME": str(root / "home"),
                                                 "DBUS_SESSION_BUS_ADDRESS": address}):
                        with patch("dbus.SessionBus", side_effect=AssertionError("Must not connect")):
                            with self.assertRaises(probe["ProbeError"]):
                                probe["worker"](root, None)

    def test_kernel_guard_allows_local_ipc_and_denies_outgoing_network(self):
        probe["check_offline_guard"]()


if __name__ == "__main__":
    unittest.main()
