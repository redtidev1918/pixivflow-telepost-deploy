#!/usr/bin/env python3
"""Read-only probe of TelePost's submission ledger for one day.

WHY THIS EXISTS

The 2026-09-13 missed occurrence was eventually proven only by the ABSENCE of
durable rows here: zero submissions, zero source refs, zero audit events. That is
the strongest evidence this system can produce, and it should be one command
rather than an afternoon of ad-hoc SQL.

It is strictly read-only: every database is opened with SQLite `mode=ro` and only
SELECTed from. It never writes, never deletes, never touches Telegram.

Run it against the publisher container:

    fly ssh console -a telesubmit-multi-bot -C "sh -c 'python3 -'" \\
        < scripts/telepost-submission-probe.py

Usage inside the container:
    python3 -                      # today, Asia/Shanghai
    python3 - 2026-09-13           # one date
    python3 - 2026-09-13 --json
"""
from __future__ import annotations

import datetime
import glob
import json
import sqlite3
import sys

SHANGHAI = datetime.timezone(datetime.timedelta(hours=8))
INTERESTING = ("submission", "source_ref", "audit", "scheduled", "duplicate", "review", "publish")


def target_date(argv: list[str]) -> str:
    for arg in argv:
        if len(arg) == 10 and arg[4] == "-" and arg[7] == "-":
            return arg
    return datetime.datetime.now(SHANGHAI).strftime("%Y-%m-%d")


def databases() -> list[str]:
    found: list[str] = []
    for pattern in ("/app/data/*/submissions.db", "/app/data/*/*/submissions.db"):
        found.extend(glob.glob(pattern))
    return sorted(set(found))


def probe(path: str, day: str) -> dict:
    report: dict = {"database": path, "tables": [], "sections": {}}
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
            if not any(key in table.lower() for key in INTERESTING):
                continue
            columns = [row[1] for row in cursor.execute(f"PRAGMA table_info({table})")]
            if not columns:
                continue
            where = " OR ".join(f"CAST({column} AS TEXT) LIKE ?" for column in columns)
            params = [f"%{day}%" for _ in columns]
            matching = cursor.execute(
                f"SELECT * FROM {table} WHERE {where} LIMIT 100", params
            ).fetchall()
            newest = cursor.execute(
                f"SELECT * FROM {table} ORDER BY rowid DESC LIMIT 10"
            ).fetchall()
            report["sections"][table] = {
                "columns": columns,
                "rows_for_day": len(matching),
                "matching": [dict(row) for row in matching],
                "newest": [dict(row) for row in newest],
            }
    finally:
        connection.close()
    return report


def main() -> int:
    argv = sys.argv[1:]
    day = target_date(argv)
    as_json = "--json" in argv
    output = {"day": day, "timezone": "Asia/Shanghai (+8)", "reports": []}
    for path in databases():
        try:
            output["reports"].append(probe(path, day))
        except Exception as error:  # noqa: BLE001 - a probe reports, it does not crash
            output["reports"].append({"database": path, "error": str(error)})

    if as_json:
        print(json.dumps(output, ensure_ascii=False, indent=1, default=str))
        return 0

    print(f"day: {day} ({output['timezone']})")
    if not output["reports"]:
        print("no submissions.db found under /app/data/*/")
        return 1
    for report in output["reports"]:
        print(f"\n===== {report['database']} =====")
        if "error" in report:
            print(f"  error: {report['error']}")
            continue
        total_for_day = 0
        for table, section in report["sections"].items():
            total_for_day += section["rows_for_day"]
            print(f"  -- {table}: rows for {day} = {section['rows_for_day']}")
            for row in section["matching"][:10]:
                print(f"     {json.dumps(row, ensure_ascii=False, default=str)[:300]}")
            if section["rows_for_day"] == 0 and section["newest"]:
                print("     newest (proves the table itself is live):")
                for row in section["newest"][:3]:
                    print(f"     {json.dumps(row, ensure_ascii=False, default=str)[:300]}")
        print(f"  >>> TOTAL durable rows for {day}: {total_for_day}")
        if total_for_day == 0:
            print("  >>> ZERO: no submission request reached TelePost for this day.")
            print("  >>> This is a scheduling/admission finding, NOT a 'nothing to post' finding.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
