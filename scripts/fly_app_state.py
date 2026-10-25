#!/usr/bin/env python3
"""Classify the state of a Fly application without parsing terminal tables.

`fly apps list` plain output is a rendered table whose padding differs across
CLI versions and platforms (rows may start with a space), which made
`grep -q "^<app>"` report a live app as missing. This module uses
`fly apps list --json` and returns one of:

    deployed      app exists and is not suspended
    suspended     app exists and is suspended (design-intended idle stop for PixivFlow)
    missing       app is absent from the org's app list
    cli_failure   fly CLI itself failed (not installed, network, auth) —
                  NOT evidence about the app, must not be reported as "missing"
"""
from __future__ import annotations

import json
import subprocess
import sys

DEPLOYED = "deployed"
SUSPENDED = "suspended"
MISSING = "missing"
CLI_FAILURE = "cli_failure"

EXIT_OK = 0
EXIT_MISSING = 1
EXIT_CLI_FAILURE = 2


def resolve_app_state(app_name: str, *, runner=subprocess.run) -> dict:
    """Return {"state": <one of the four>, "detail": <human-readable reason>}."""
    try:
        proc = runner(["fly", "apps", "list", "--json"], capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {"state": CLI_FAILURE, "detail": f"fly CLI unavailable: {type(exc).__name__}"}
    if proc.returncode != 0:
        stderr = (proc.stderr or "").strip().splitlines()
        reason = stderr[-1] if stderr else f"exit code {proc.returncode}"
        return {"state": CLI_FAILURE, "detail": f"fly apps list failed: {reason[:200]}"}
    try:
        apps = json.loads(proc.stdout)
    except json.JSONDecodeError:
        return {"state": CLI_FAILURE, "detail": "fly apps list returned non-JSON output"}
    if not isinstance(apps, list):
        apps = [apps]
    for app in apps:
        if not isinstance(app, dict):
            continue
        if app.get("Name") != app_name and app.get("name") != app_name:
            continue
        status = str(app.get("Status") or app.get("status") or "").lower()
        if status == "suspended":
            return {"state": SUSPENDED, "detail": "app suspended (expected idle state)"}
        return {"state": DEPLOYED, "detail": f"app status: {status or 'unknown'}"}
    return {"state": MISSING, "detail": "app not present in fly apps list --json"}


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: fly_app_state.py <app-name>", file=sys.stderr)
        return EXIT_CLI_FAILURE
    result = resolve_app_state(argv[1])
    print(f"{result['state']}: {result['detail']}")
    return {DEPLOYED: EXIT_OK, SUSPENDED: EXIT_OK,
            MISSING: EXIT_MISSING, CLI_FAILURE: EXIT_CLI_FAILURE}[result["state"]]


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
