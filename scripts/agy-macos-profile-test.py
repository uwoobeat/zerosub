#!/usr/bin/python3
"""Synthetic regressions; --macos-integration creates only temporary Keychains.

No .env, real Google login, credential value read, native CLI, or network call.
"""

import fcntl
import io
import os
from pathlib import Path
import runpy
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


module = runpy.run_path(str(Path(__file__).with_name("agy-macos-profile.py")))
CheckError = module["CheckError"]
INTEGRATION = "--macos-integration" in sys.argv
if INTEGRATION:
    sys.argv.remove("--macos-integration")


def apple_split(line):
    """Reference the states in Apple's security.c split_line, including no concat."""
    arguments, value, state, quote = [], "", "skip", None
    for character in line:
        if state == "skip":
            if character.isspace():
                continue
            value = ""
            if character in "\"'":
                state, quote = "quoted", character
                continue
            state = "argument"
        if state in ["escaped", "quoted-escaped"]:
            value += character
            state = "argument" if state == "escaped" else "quoted"
        elif state == "argument":
            if character == "\\":
                state = "escaped"
            elif character.isspace():
                arguments.append(value)
                state = "skip"
            else:
                value += character
        elif state == "quoted":
            if character == "\\":
                state = "quoted-escaped"
            elif character == quote:
                arguments.append(value)
                state = "skip"
            else:
                value += character
    if state != "skip":
        arguments.append(value)
    return arguments


def profile_tree(base):
    base.mkdir(mode=0o700)
    profile = base / "a"
    profile.mkdir(mode=0o700)
    for relative in ["home", "config", "data", "cache", "work", "home/.gemini",
                     "home/.gemini/antigravity-cli", "home/Library", "home/Library/Keychains",
                     "home/Library/Preferences"]:
        (profile / relative).mkdir(mode=0o700)
    descriptor = module["helper"]["open_private"](profile / "profile.lock", os.O_CREAT | os.O_RDWR)
    os.close(descriptor)
    return profile


class MacProfileSafety(unittest.TestCase):
    def test_security_parser_roundtrip_handles_quotes_backslashes_and_unicode(self):
        for value in ["", "plain", "space $d ; # &", "single' double\" back\\slash", "한글 ü \\\"'"]:
            arguments = ["unlock-keychain", "-p", value, "/tmp/synthetic path/keychain"]
            line = module["security_line"](arguments)
            self.assertEqual(apple_split(line.decode()), arguments)
        # Apple's parser intentionally does not implement POSIX adjacent quotes.
        self.assertNotEqual(apple_split("'single'\"'\"'quote'\n"), ["single'quote"])

    def test_security_input_rejects_line_injection_and_line_limit(self):
        for value in ["a\nb", "a\rb", "a\0b"]:
            with self.assertRaises(CheckError):
                module["security_line"](["unlock-keychain", "-p", value])
        with self.assertRaises(CheckError):
            module["security_line"](["unlock-keychain", "-p", "\\" * 2048])

    def test_password_only_enters_security_stdin(self):
        function = module["security_stdin"]
        secret = "SYNTHETIC single' double\" \\ $ ;"
        with patch("subprocess.run", return_value=subprocess.CompletedProcess([], 0, b"")) as execute:
            function(["unlock-keychain", "-p", secret, "/tmp/synthetic.keychain-db"], Path("/tmp/private"))
        arguments, options = execute.call_args
        self.assertEqual(arguments[0], ["/usr/bin/security", "-q", "-i"])
        self.assertNotIn(secret, str(arguments))
        self.assertNotIn(secret, str(options["env"]))
        self.assertEqual(apple_split(options["input"].decode())[2], secret)
        self.assertEqual(options["stderr"], subprocess.DEVNULL)

    def test_password_stdin_is_bounded_and_not_a_tty(self):
        function = module["stdin_password"]
        for raw in [b"", b"x" * 2049, b"a\nb", b"a\0b", b"\xff"]:
            stream = type("Input", (), {"isatty": lambda self: False, "buffer": io.BytesIO(raw)})()
            with patch.object(sys, "stdin", stream):
                with self.assertRaises(CheckError):
                    function()
        with patch.object(sys, "stdin", type("Input", (), {"isatty": lambda self: True})()):
            with self.assertRaises(CheckError):
                function()

    def test_interactive_unlock_inherits_tty_and_targets_only_private_keychain(self):
        function = module["unlock_keychain"]
        home = Path("/tmp/private/home")
        keychain = home / "Library/Keychains/account.keychain-db"
        streams = [io.StringIO(), io.StringIO(), io.StringIO()]
        for stream in streams:
            stream.isatty = lambda: True
        replacements = {"private_keychain_metadata": lambda path: self.assertEqual(path, keychain),
                        "keychain_unlocked": unittest.mock.Mock(side_effect=[False, True])}
        with patch.dict(function.__globals__, replacements):
            with patch.object(sys, "stdin", streams[0]), patch.object(sys, "stdout", streams[1]), patch.object(sys, "stderr", streams[2]):
                with patch("subprocess.run", return_value=subprocess.CompletedProcess([], 0)) as execute:
                    function(home, keychain)
        self.assertEqual(execute.call_args.args[0], ["/usr/bin/security", "unlock-keychain", str(keychain)])
        self.assertEqual(execute.call_args.kwargs, {"env": module["security_env"](home)})

    def test_unlock_rejects_redirected_prompt_and_failed_unlock(self):
        function = module["unlock_keychain"]
        replacements = {"private_keychain_metadata": lambda path: None, "keychain_unlocked": lambda path: False}
        home = Path("/tmp/private/home")
        keychain = home / "Library/Keychains/account.keychain-db"
        with patch.dict(function.__globals__, replacements):
            with patch.object(sys, "stdin", io.StringIO()):
                with patch("subprocess.run", side_effect=AssertionError("Must not prompt without TTY")):
                    with self.assertRaises(CheckError):
                        function(home, keychain)
            with patch.dict(function.__globals__, {"security_stdin": lambda *args: None}):
                with self.assertRaises(CheckError):
                    function(home, keychain, "SYNTHETIC")

    def test_usage_unlocks_before_credential_inspection_and_native_start(self):
        function = module["run_profile"]
        events = []
        secret = "SYNTHETIC"
        def unlock(home, keychain, password):
            self.assertEqual(password, secret)
            events.append("unlock")
        def metadata(*args):
            events.append("metadata")
            return {"private_keychain_unlocked": True, "credential_item_present": True,
                    "credential_file_present": False}
        def usage(command, env, cwd):
            events.append("native")
            self.assertNotIn(secret, str(command))
            self.assertNotIn(secret, str(env))
            return []
        replacements = {"host_snapshot": lambda: "unchanged", "verify_selection": lambda *args: None,
                        "private_preferences": lambda *args: None, "unlock_keychain": unlock,
                        "credential_status": metadata}
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary).resolve() / "profiles"
            profile_tree(base)
            with patch.dict(function.__globals__, replacements):
                with patch.dict(module["helper"], {"bounded_usage": usage}):
                    result = function("usage", "a", "/usr/bin/false", base=base, password=secret)
        self.assertEqual(events, ["unlock", "metadata", "native"])
        self.assertTrue(result["real_keychain_settings_unchanged"])

    def test_unlock_failure_cannot_query_credentials_or_start_native(self):
        function = module["run_profile"]
        def fail_unlock(*args):
            raise CheckError("Synthetic unlock failure")
        replacements = {"host_snapshot": lambda: "unchanged", "verify_selection": lambda *args: None,
                        "private_preferences": lambda *args: None, "unlock_keychain": fail_unlock,
                        "credential_status": lambda *args: self.fail("Must unlock before inspecting credentials")}
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary).resolve() / "profiles"
            profile_tree(base)
            with patch.dict(function.__globals__, replacements):
                with patch("subprocess.Popen", side_effect=AssertionError("Must not start native CLI")):
                    for operation in ["usage", "session"]:
                        with self.assertRaises(CheckError):
                            function(operation, "a", "/usr/bin/false", base=base, password="SYNTHETIC")

    def test_login_cannot_read_unlock_password_from_redirected_stdin(self):
        function = module["main"]
        with patch.object(sys, "platform", "darwin"):
            with patch.object(sys, "argv", ["helper", "login", "a", "--unlock-stdin"]):
                with patch.dict(function.__globals__, {"stdin_password": lambda: self.fail("Must not read password")}):
                    with self.assertRaises(CheckError):
                        function()

    def test_login_uses_read_only_usage_and_inherits_all_terminal_streams(self):
        function = module["run_profile"]
        streams = [io.StringIO(), io.StringIO(), io.StringIO()]
        for stream in streams:
            stream.isatty = lambda: True
        metadata = {"private_keychain_unlocked": True, "credential_item_present": False,
                    "credential_file_present": False}
        saved = dict(metadata, credential_item_present=True)
        replacements = {"host_snapshot": lambda: "unchanged", "verify_selection": lambda *args: None,
                        "private_preferences": lambda *args: None, "unlock_keychain": lambda *args: None,
                        "credential_status": unittest.mock.Mock(side_effect=[metadata, saved])}
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary).resolve() / "profiles"
            profile_tree(base)
            with patch.dict(function.__globals__, replacements):
                with patch.dict(os.environ, {"SSH_CONNECTION": "127.0.0.1 1 127.0.0.1 2"}):
                    with patch.object(sys, "stdin", streams[0]), patch.object(sys, "stdout", streams[1]), patch.object(sys, "stderr", streams[2]):
                        with patch("subprocess.run", return_value=subprocess.CompletedProcess([], 0)) as execute:
                            result = function("login", "a", "/tmp/official-agy", base=base)
        command = execute.call_args.args[0]
        self.assertEqual(command, ["/tmp/official-agy", "--print", "/usage", "--output-format", "json", "--log-file", "/dev/null"])
        for option in ["stdin", "stdout", "stderr", "capture_output", "shell"]:
            self.assertNotIn(option, execute.call_args.kwargs)
        self.assertTrue(result["credentials_preserved"])
        self.assertEqual(result["login_command_exit"], 0)
        self.assertTrue(result["real_keychain_settings_unchanged"])

    def test_failed_login_command_is_not_success_even_with_saved_credentials(self):
        function = module["run_profile"]
        streams = [io.StringIO(), io.StringIO(), io.StringIO()]
        for stream in streams:
            stream.isatty = lambda: True
        replacements = {"host_snapshot": lambda: "unchanged", "verify_selection": lambda *args: None,
                        "private_preferences": lambda *args: None, "unlock_keychain": lambda *args: None,
                        "credential_status": lambda *args: {"private_keychain_unlocked": True,
                            "credential_item_present": True, "credential_file_present": False}}
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary).resolve() / "profiles"
            profile = profile_tree(base)
            token = profile / "home/.gemini/antigravity-cli/antigravity-oauth-token"
            token.write_bytes(b"SYNTHETIC_DO_NOT_READ")
            token.chmod(0o600)
            with patch.dict(function.__globals__, replacements):
                with patch.dict(os.environ, {"SSH_CONNECTION": "127.0.0.1 1 127.0.0.1 2"}):
                    with patch.object(sys, "stdin", streams[0]), patch.object(sys, "stdout", streams[1]), patch.object(sys, "stderr", streams[2]):
                        with patch("subprocess.run", return_value=subprocess.CompletedProcess([], 1)):
                            with self.assertRaisesRegex(CheckError, "saved credentials are preserved"):
                                function("login", "a", "/tmp/official-agy", base=base)
            self.assertTrue(token.is_file())

    def test_native_environment_omits_ambient_auth_and_passwords(self):
        with patch.dict(os.environ, {"MACAIR_PASSWORD": "SYNTHETIC", "GEMINI_API_KEY": "SYNTHETIC",
                                    "AGY_ADC_AUTH": "true", "DBUS_SESSION_BUS_ADDRESS": "SYNTHETIC",
                                    "TERM": "xterm", "TERM_PROGRAM": "Paseo",
                                    "SSH_CONNECTION": "127.0.0.1 1 127.0.0.1 2"}):
            env = module["profile_env"](Path("/tmp/profile"), Path("/tmp/runtime"))
        for key in ["MACAIR_PASSWORD", "GEMINI_API_KEY", "AGY_ADC_AUTH", "DBUS_SESSION_BUS_ADDRESS"]:
            self.assertNotIn(key, env)
        self.assertEqual(env["HOME"], "/tmp/profile/home")
        self.assertEqual(env["TERM_PROGRAM"], "Paseo")
        self.assertIn("SSH_CONNECTION", env)

    def test_terminal_identity_is_optional_and_validated(self):
        function = module["profile_env"]
        for value in ["x\ny", "x" * 81, "with space", "/bin/bash"]:
            with patch.dict(os.environ, {"TERM_PROGRAM": value}):
                with self.assertRaises(CheckError):
                    function(Path("/tmp/profile"), Path("/tmp/runtime"))
        with patch.dict(os.environ, {}, clear=True):
            self.assertNotIn("TERM_PROGRAM", function(Path("/tmp/profile"), Path("/tmp/runtime")))

    def test_private_keychain_and_preference_links_are_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            home = root / "home"
            (home / "Library/Preferences").mkdir(parents=True)
            target = root / "synthetic"
            target.write_bytes(b"synthetic")
            target.chmod(0o600)
            keychain = root / "keychain"
            keychain.symlink_to(target)
            with self.assertRaises(CheckError):
                module["private_keychain_metadata"](keychain)
            preference = home / "Library/Preferences/com.apple.security.plist"
            preference.symlink_to(target)
            with self.assertRaises(CheckError):
                module["private_preferences"](home)
            preference.unlink()
            os.link(target, preference)
            with self.assertRaises(CheckError):
                module["private_preferences"](home)

    def test_private_selection_allows_only_own_user_list_and_optional_empty_system(self):
        function = module["verify_selection"]
        home = Path("/tmp/private-profile/home").resolve()
        keychain = home / "Library/Keychains/account.keychain-db"
        system = "/Library/Keychains/System.keychain"
        def selection(arguments, home):
            return [str(keychain), system] if arguments == ["list-keychains"] else [str(keychain)]
        with patch.dict(function.__globals__, {"security_paths": selection}):
            with patch("subprocess.run", return_value=subprocess.CompletedProcess([], 44)) as execute:
                function(home, keychain)
                command = execute.call_args[0][0]
                self.assertEqual(command[-1], system)
                self.assertNotIn("-g", command)
                self.assertNotIn("-w", command)
            for exit_code in [0, 36, 51]:
                with patch("subprocess.run", return_value=subprocess.CompletedProcess([], exit_code)):
                    with self.assertRaises(CheckError):
                        function(home, keychain)
        with patch.dict(function.__globals__, {"security_paths": lambda *args: [str(keychain)]}):
            with patch("subprocess.run", side_effect=AssertionError("No System lookup expected")):
                function(home, keychain)

    def test_private_selection_rejects_real_login_or_other_profile_keychains(self):
        function = module["verify_selection"]
        home = Path("/tmp/private-profile/home").resolve()
        keychain = home / "Library/Keychains/account.keychain-db"
        for extra in ["/Users/synthetic/Library/Keychains/login.keychain-db",
                      "/tmp/other-profile/home/Library/Keychains/account.keychain-db"]:
            def selection(arguments, home):
                return [str(keychain), extra] if arguments == ["list-keychains"] else [str(keychain)]
            with patch.dict(function.__globals__, {"security_paths": selection}):
                with self.assertRaises(CheckError):
                    function(home, keychain)

    def test_selection_canonicalizes_system_path_aliases_without_linking_credentials(self):
        function = module["verify_selection"]
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            target = root / "physical"
            target.mkdir()
            alias = root / "alias"
            alias.symlink_to(target, target_is_directory=True)
            keychain = target / "synthetic.keychain-db"
            with patch.dict(function.__globals__, {"security_paths": lambda *args: [str(alias / keychain.name)]}):
                function(target, keychain)

    def test_status_queries_attributes_only_and_preserves_native_file_fallback(self):
        function = module["credential_status"]
        with tempfile.TemporaryDirectory() as temporary:
            profile = Path(temporary).resolve()
            token = profile / "home/.gemini/antigravity-cli/antigravity-oauth-token"
            token.parent.mkdir(parents=True)
            token.write_bytes(b"SYNTHETIC_DO_NOT_READ")
            token.chmod(0o600)
            with patch.dict(function.__globals__, {"private_keychain_metadata": lambda path: None,
                                                   "keychain_unlocked": lambda path: True}):
                with patch.object(Path, "read_bytes", side_effect=AssertionError("Never read credentials")):
                    with patch("subprocess.run", return_value=subprocess.CompletedProcess([], 44)) as execute:
                        result = function(profile, {"HOME": str(profile / "home")})
            command = execute.call_args[0][0]
            self.assertNotIn("-w", command)
            self.assertNotIn("-g", command)
            self.assertEqual(command[-1], str(profile / "home/Library/Keychains/account.keychain-db"))
            self.assertFalse(result["credential_item_present"])
            self.assertTrue(result["credential_file_present"])

    def test_profile_lock_rejects_concurrent_operations_before_any_security_call(self):
        function = module["run_profile"]
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary).resolve() / "profiles"
            profile = profile_tree(base)
            descriptor = module["helper"]["open_private"](profile / "profile.lock", os.O_RDWR)
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                with patch("subprocess.run", side_effect=AssertionError("Must not spawn")):
                    with self.assertRaises(CheckError):
                        function("status", "a", base=base)
            finally:
                os.close(descriptor)

    def test_missing_credentials_cannot_start_usage_or_session(self):
        function = module["run_profile"]
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary).resolve() / "profiles"
            profile_tree(base)
            replacements = {"host_snapshot": lambda: "unchanged", "verify_selection": lambda *args: None,
                            "private_preferences": lambda *args: None,
                            "credential_status": lambda *args: {"private_keychain_unlocked": True,
                                "credential_item_present": False, "credential_file_present": False}}
            with patch.dict(function.__globals__, replacements):
                with patch("subprocess.Popen", side_effect=AssertionError("Must not start native CLI")):
                    for operation in ["usage", "session"]:
                        with self.assertRaises(CheckError):
                            function(operation, "a", "/usr/bin/false", base=base)

    def test_login_needs_all_three_terminal_streams(self):
        for redirected in [0, 1, 2]:
            streams = [io.StringIO(), io.StringIO(), io.StringIO()]
            for index, stream in enumerate(streams):
                stream.isatty = lambda index=index: index != redirected
            with patch.object(sys, "platform", "darwin"), patch.object(sys, "argv", ["helper", "login", "a"]):
                with patch.object(sys, "stdin", streams[0]), patch.object(sys, "stdout", streams[1]), patch.object(sys, "stderr", streams[2]):
                    with patch.dict(module["main"].__globals__, {"run_profile": lambda *args: self.fail("Must not log in")}):
                        with self.assertRaises(CheckError):
                            module["main"]()


@unittest.skipUnless(INTEGRATION and sys.platform == "darwin", "Explicit macOS synthetic integration only")
class SyntheticMacKeychain(unittest.TestCase):
    def test_prepare_special_passwords_unlock_across_commands_without_host_changes(self):
        before = module["host_snapshot"]()
        passwords = ["SYNTHETIC spaces $d ; # &", "SYNTHETIC single' double\" back\\slash ü"]
        with tempfile.TemporaryDirectory(prefix="zerosub-mac-helper-test-") as temporary:
            base = Path(temporary).resolve() / "profiles"
            for name, password in zip(["a", "b"], passwords):
                result = module["run_profile"]("prepare", name, base=base, password=password)
                self.assertTrue(result["private_keychain_unlocked"])
                status = module["run_profile"]("status", name, base=base)
                self.assertFalse(status["credential_item_present"])
                self.assertFalse(status["credential_file_present"])
                self.assertTrue(status["private_keychain_unlocked"])
                profile = base / name
                keychain = profile / "home/Library/Keychains/account.keychain-db"
                self.assertEqual(stat.S_IMODE(keychain.stat().st_mode), 0o600)
                module["security_run"](["lock-keychain", str(keychain)], profile / "home")
                self.assertFalse(module["keychain_unlocked"](keychain))
                module["run_profile"]("prepare", name, base=base, password=password)
                self.assertTrue(module["run_profile"]("status", name, base=base)["private_keychain_unlocked"])
                module["security_run"](["lock-keychain", str(keychain)], profile / "home")
                # Same invocation unlocks before inspecting any saved credential.
                status = module["run_profile"]("status", name, base=base, password=password)
                self.assertTrue(status["private_keychain_unlocked"])
                self.assertFalse(status["credential_item_present"])
        self.assertEqual(module["host_snapshot"](), before)


if __name__ == "__main__":
    os.umask(0o077)
    unittest.main()
