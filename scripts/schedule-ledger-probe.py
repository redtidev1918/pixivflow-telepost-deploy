#!/usr/bin/env python3
"""Read-only snapshot of the executor's durable schedule ledger.

WHY THIS IS READ-ONLY AND WHY IT MATTERS

After a missed occurrence the only trustworthy answers live in the durable
ledger, not in logs and not in "the Machine started". A Machine start proves
nothing: the app runs with `auto_start_machines = true` and
`min_machines_running = 0`, so ANY public HTTP request can start it.

This script is therefore opened with SQLite `mode=ro` and only ever SELECTs. It
is intended to run inside the executor container via:

    fly ssh console -a pixivflow-scheduler -C "sh -c 'python3 - < /dev/null'"

Run it from the repository root on the host instead and it will look at the local
`./data` tree, which is only useful for development.

Usage:
    python3 scripts/schedule-ledger-probe.py                    # today, in the schedule tz
    python3 scripts/schedule-ledger-probe.py 2026-09-13         # one occurrence date
    python3 scripts/schedule-ledger-probe.py 2026-09-13 --json  # machine-readable
"""
from __future__ import annotations

import datetime
import glob
import json
import os
import sqlite3
import sys
from typing import Any

DEFAULT_TZ_OFFSET_HOURS = 8  # Asia/Shanghai; the schedules declare this explicitly.
LEDGER_KEYWORDS = ("slot", "cell", "outbox", "delivery", "schedul", "lease", "trigger")


def occurrence_date(argv: list[str]) -> str:
    for arg in argv:
        if len(arg) == 10 and arg[4] == "-" and arg[7] == "-":
            return arg
    tz = datetime.timezone(datetime.timedelta(hours=DEFAULT_TZ_OFFSET_HOURS))
    return datetime.datetime.now(tz).strftime("%Y-%m-%d")


def iso_utc(value: Any) -> str | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number > 1e12:
        number /= 1000.0
    try:
        return datetime.datetime.fromtimestamp(number, datetime.timezone.utc).strftime(
            "%Y-%m-%dT%H:%M:%SZ"
        )
    except (OverflowError, OSError, ValueError):
        return None


def candidate_databases() -> list[str]:
    patterns = (
        "/app/data/*.db",
        "/app/data/*/*.db",
        "./data/pixivflow/*.db",
        "./data/*.db",
    )
    found: list[str] = []
    for pattern in patterns:
        found.extend(glob.glob(pattern))
    return sorted(set(found))


def normalise(row: sqlite3.Row) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key in row.keys():
        value = row[key]
        if isinstance(value, float) and value > 1e9:
            out[key] = value
            out[f"{key}_utc"] = iso_utc(value)
        elif isinstance(value, str) and len(value) > 300:
            out[key] = value[:300] + "..."
        else:
            out[key] = value
    return out


def probe(path: str, target_date: str) -> dict[str, Any]:
    report: dict[str, Any] = {"database": path, "tables": [], "sections": {}}
    connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    try:
        cursor = connection.cursor()
        tables = [
            row[0]
            for row in cursor.execute(
                "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
            )
        ]
        report["tables"] = tables

        for table in tables:
            lowered = table.lower()
            if not any(keyword in lowered for keyword in LEDGER_KEYWORDS):
                continue
            columns = [row[1] for row in cursor.execute(f"PRAGMA table_info({table})")]
            if not columns:
                continue

            where = " OR ".join(f"CAST({column} AS TEXT) LIKE ?" for column in columns)
            params = [f"%{target_date}%" for _ in columns]
            rows = cursor.execute(
                f"SELECT * FROM {table} WHERE {where} LIMIT 200", params
            ).fetchall()

            newest = cursor.execute(
                f"SELECT * FROM {table} ORDER BY rowid DESC LIMIT 12"
            ).fetchall()

            report["sections"][table] = {
                "columns": columns,
                "rows_matching_date": len(rows),
                "matching": [normalise(row) for row in rows],
                "newest": [normalise(row) for row in newest],
            }
    finally:
        connection.close()
    return report


def main() -> int:
    argv = sys.argv[1:]
    target_date = occurrence_date(argv)
    as_json = "--json" in argv

    databases = candidate_databases()
    output: dict[str, Any] = {
        "occurrence_date": target_date,
        "explicit_timezone_offset_hours": DEFAULT_TZ_OFFSET_HOURS,
        "config_path": os.environ.get("PIXIV_DOWNLOADER_CONFIG"),
        "databases": databases,
        "reports": [],
    }
    if not databases:
        output["error"] = "no database found; looked for /app/data/*.db and ./data/pixivflow/*.db"
    for path in databases:
        try:
            output["reports"].append(probe(path, target_date))
        except Exception as error:  # noqa: BLE001 - a probe must report, not crash
            output["reports"].append({"database": path, "error": str(error)})

    if as_json:
        print(json.dumps(output, ensure_ascii=False, indent=1))
        return 0

    print(f"occurrence date (Asia/Shanghai +8): {target_date}")
    print(f"config: {output['config_path']}")
    print(f"databases: {databases or 'NONE FOUND'}")
    for report in output["reports"]:
        print(f"\n===== {report['database']} =====")
        if "error" in report:
            print(f"  error: {report['error']}")
            continue
        print(f"  all tables: {report['tables']}")
        for table, section in report["sections"].items():
            print(f"\n  -- {table} (rows matching {target_date}: {section['rows_matching_date']})")
            for row in section["matching"][:20]:
                print(f"     {json.dumps(row, ensure_ascii=False)}")
            print("     newest:")
            for row in section["newest"]:
                print(f"     {json.dumps(row, ensure_ascii=False)}")
    print("\n=== probe complete ===")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
