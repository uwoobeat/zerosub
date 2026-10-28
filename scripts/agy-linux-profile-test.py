#!/usr/bin/python3
"""Regression checks use fake data and temporary directories, never CLI logins."""

import fcntl
import io
import json
import os
from pathlib import Path
import runpy
import sys
import tempfile
import unittest
from unittest.mock import patch


module = runpy.run_path(str(Path(__file__).with_name("agy-linux-profile.py")))
CheckError = module["CheckError"]


def response():
    return {"status": "SUCCESS", "num_turns": 0, "command": {"name": "usage", "data": {
        "groups": [{"name": "Gemini 4 Argon", "buckets": [{"id": "gemini-argon-wtu-weekly",
            "window": "weekly", "remaining_fraction": 0.513, "reset_time": "2026-10-24T00:42:59Z"}]}]}}}


class LiveValidationSafety(unittest.TestCase):
    def test_dynamic_quota_is_normalized_without_extra_fields(self):
        raw = response()
        raw["token"] = "SYNTHETIC_DO_NOT_PUBLISH"
        result = module["quota_summary"](json.dumps(raw))
        self.assertEqual(result, [{"id": "gemini-argon-wtu-weekly", "window": "weekly",
                                  "remaining_percent": 51.3, "resets_at": "2026-10-24T00:42:59+00:00"}])
        self.assertNotIn("SYNTHETIC_DO_NOT_PUBLISH", json.dumps(result))

    def test_generated_turn_and_invalid_quota_are_rejected(self):
        for changes in [{"num_turns": 1}, {"num_turns": False}, {"num_turns": "0"}, {"status": "ERROR"}]:
            raw = response()
            raw.update(changes)
            with self.assertRaises(CheckError):
                module["quota_summary"](json.dumps(raw))
        for value in [True, -0.1, 1.1, None, float("nan")]:
            raw = response()
            raw["command"]["data"]["groups"][0]["buckets"][0]["remaining_fraction"] = value
            with self.assertRaises(CheckError):
                module["quota_summary"](json.dumps(raw))

    def test_invalid_date_and_missing_timezone_are_rejected(self):
        for value in ["---", "2026-02-30T00:00:00Z", "2026-10-24T00:00:00"]:
            raw = response()
            raw["command"]["data"]["groups"][0]["buckets"][0]["reset_time"] = value
            with self.assertRaises(CheckError):
                module["quota_summary"](json.dumps(raw))

    def test_symlink_directory_and_secret_file_are_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            target = root / "target"
            target.mkdir(mode=0o700)
            alias = root / "alias"
            alias.symlink_to(target, target_is_directory=True)
            with self.assertRaises(CheckError):
                module["private_directory"](alias)
            with self.assertRaises(OSError):
                module["open_private"](alias, 0)

    def test_same_profile_cannot_start_another_keyring(self):
        function = module["run_profile"]
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary) / "profiles"
            base.mkdir(mode=0o700)
            profile = base / "a"
            profile.mkdir(mode=0o700)
            descriptor = module["open_private"](profile / "profile.lock", os.O_CREAT | os.O_RDWR)
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                with patch.dict(function.__globals__, {"BASE": base}):
                    with patch("subprocess.Popen", side_effect=AssertionError("Must not spawn")):
                        with self.assertRaises(CheckError):
                            function("status", "a", "/usr/bin/false")
            finally:
                os.close(descriptor)

    def test_native_file_storage_is_detected_without_reading_credentials(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            path = root / "home/.gemini/antigravity-cli/antigravity-oauth-token"
            path.parent.mkdir(parents=True)
            path.write_bytes(b"SYNTHETIC_DO_NOT_READ")
            path.chmod(0o600)
            with patch.object(Path, "read_bytes", side_effect=AssertionError("Must not read credentials")):
                metadata = module["credential_metadata"](root, False)
            self.assertEqual(metadata, {"credential_item_present": False, "credential_file_present": True})
            path.chmod(0o644)
            with self.assertRaises(CheckError):
                module["credential_metadata"](root, False)

    def test_native_credential_symlink_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            path = root / "home/.gemini/antigravity-cli/antigravity-oauth-token"
            path.parent.mkdir(parents=True)
            target = root / "other-profile-token"
            target.write_bytes(b"SYNTHETIC_DO_NOT_READ")
            target.chmod(0o600)
            path.symlink_to(target)
            with self.assertRaises(CheckError):
                module["credential_metadata"](root, False)

    def test_login_needs_all_three_terminal_streams(self):
        for redirected in [0, 1, 2]:
            streams = [io.StringIO(), io.StringIO(), io.StringIO()]
            for index, stream in enumerate(streams):
                stream.isatty = lambda index=index: index != redirected
            with patch.object(sys, "argv", ["agy-linux-profile.py", "login", "a"]):
                with patch.object(sys, "stdin", streams[0]), patch.object(sys, "stdout", streams[1]), patch.object(sys, "stderr", streams[2]):
                    with patch.dict(module["main"].__globals__, {"run_profile": lambda *args: self.fail("Must not start login")}):
                        with self.assertRaises(CheckError):
                            module["main"]()


if __name__ == "__main__":
    unittest.main()
