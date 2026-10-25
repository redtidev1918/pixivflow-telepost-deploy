#!/usr/bin/env python3
"""Tests for scripts/fly_app_state.py — fly CLI output must never be
misread as evidence about an app's existence (2026-10-26 smoke false alarm:
padded table rows made `grep -q "^<app>"` report a live app as missing)."""
import json
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).parent))

from fly_app_state import (CLI_FAILURE, DEPLOYED, MISSING, SUSPENDED, main,
                           resolve_app_state)


def runner(stdout="", returncode=0, stderr=""):
    return lambda argv, **_: SimpleNamespace(stdout=stdout, stderr=stderr, returncode=returncode)


def failing_runner(exc):
    def _run(argv, **_):
        raise exc
    return _run


class ResolveAppStateTest(unittest.TestCase):
    def test_deployed_app_is_found_despite_padded_table_style_names(self):
        # JSON is parsed structurally; leading/trailing padding in any raw
        # output is irrelevant. Name matches exactly.
        apps = [{"Name": " other-app", "Status": "deployed"},
                {"Name": "pixivflow-scheduler", "Status": "deployed"}]
        result = resolve_app_state("pixivflow-scheduler", runner=runner(json.dumps(apps)))
        self.assertEqual(result["state"], DEPLOYED)

    def test_suspended_app_is_reported_as_suspended_not_missing(self):
        apps = [{"Name": "pixivflow-scheduler", "Status": "suspended"}]
        result = resolve_app_state("pixivflow-scheduler", runner=runner(json.dumps(apps)))
        self.assertEqual(result["state"], SUSPENDED)

    def test_empty_app_list_is_missing_not_cli_failure(self):
        result = resolve_app_state("pixivflow-scheduler", runner=runner("[]"))
        self.assertEqual(result["state"], MISSING)

    def test_app_absent_from_list_is_missing(self):
        apps = [{"Name": "something-else", "Status": "deployed"}]
        result = resolve_app_state("pixivflow-scheduler", runner=runner(json.dumps(apps)))
        self.assertEqual(result["state"], MISSING)

    def test_nonzero_exit_is_cli_failure_never_missing(self):
        # Network outage / auth failure must not be reported as "app missing".
        result = resolve_app_state(
            "pixivflow-scheduler",
            runner=runner("", returncode=1, stderr="Could not resolve App\n"),
        )
        self.assertEqual(result["state"], CLI_FAILURE)
        self.assertIn("Could not resolve App", result["detail"])

    def test_unavailable_cli_is_cli_failure(self):
        result = resolve_app_state(
            "pixivflow-scheduler", runner=failing_runner(OSError("no fly binary")))
        self.assertEqual(result["state"], CLI_FAILURE)

    def test_non_json_output_is_cli_failure(self):
        # Legacy padded-table output (the exact false-alarm shape) is not
        # interpretable as JSON → CLI failure, NOT "missing".
        table = " NAME                 │ OWNER\n pixivflow-scheduler  │ personal"
        result = resolve_app_state("pixivflow-scheduler", runner=runner(table))
        self.assertEqual(result["state"], CLI_FAILURE)


class MainExitCodesTest(unittest.TestCase):
    def _main_with(self, state):
        calls = {}

        def fake_resolve(app_name, *, runner=None):
            calls["app"] = app_name
            return {"state": state, "detail": "x"}

        code = main(["fly_app_state.py", "pixivflow-scheduler"]) if False else None
        return calls, code, fake_resolve

    def test_exit_codes_distinguish_missing_from_cli_failure(self):
        import unittest.mock as mock
        with mock.patch("fly_app_state.resolve_app_state",
                        return_value={"state": MISSING, "detail": "d"}):
            self.assertEqual(main(["x", "app"]), 1)
        with mock.patch("fly_app_state.resolve_app_state",
                        return_value={"state": CLI_FAILURE, "detail": "d"}):
            self.assertEqual(main(["x", "app"]), 2)
        with mock.patch("fly_app_state.resolve_app_state",
                        return_value={"state": SUSPENDED, "detail": "d"}):
            self.assertEqual(main(["x", "app"]), 0)
        with mock.patch("fly_app_state.resolve_app_state",
                        return_value={"state": DEPLOYED, "detail": "d"}):
            self.assertEqual(main(["x", "app"]), 0)

    def test_usage_error_is_cli_failure(self):
        self.assertEqual(main(["fly_app_state.py"]), 2)


if __name__ == "__main__":
    unittest.main()
