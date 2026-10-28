#!/usr/bin/python3
"""Stream checker regressions use local fake processes, never real CLI accounts."""

import json
from pathlib import Path
import runpy
import sys
import tempfile
import unittest


module = runpy.run_path(str(Path(__file__).with_name("verify-agy-live-file.py")))


class NativeStartupReader(unittest.TestCase):
    def run_frame(self, frame):
        code = "import sys; sys.stdout.write(" + repr(json.dumps(frame) + "\n") + "); sys.stdout.flush(); sys.stdin.read()"
        with tempfile.TemporaryDirectory() as directory:
            return module["session_startup"]([sys.executable, "-c", code], {}, Path(directory))

    def test_valid_init_does_not_disclose_extra_fields(self):
        result = self.run_frame({"event": "init", "conversation_id": "synthetic-test", "init": {},
                                 "unexpected": "SYNTHETIC_DO_NOT_PUBLISH"})
        self.assertEqual(result, {"native_init_received": True, "prompts_sent": 0})
        self.assertNotIn("SYNTHETIC_DO_NOT_PUBLISH", json.dumps(result))

    def test_invalid_frame_does_not_disclose_native_diagnostics(self):
        with self.assertRaises(module["CheckError"]) as captured:
            self.run_frame({"event": "error", "message": "SYNTHETIC_DO_NOT_PUBLISH"})
        self.assertNotIn("SYNTHETIC_DO_NOT_PUBLISH", str(captured.exception))

    def test_large_unterminated_frame_is_bounded(self):
        code = "import sys; sys.stdout.write('x' * (2 * 1024 * 1024)); sys.stdout.flush(); sys.stdin.read()"
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(module["CheckError"]):
                module["session_startup"]([sys.executable, "-c", code], {}, Path(directory))


if __name__ == "__main__":
    unittest.main()
