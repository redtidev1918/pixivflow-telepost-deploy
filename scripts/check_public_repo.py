#!/usr/bin/env python3
"""Fail validation when tracked files contain deployment secrets or runtime data."""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path, PurePosixPath


ROOT = Path(__file__).resolve().parent.parent
TEXT_SUFFIXES = {
    "",
    ".conf",
    ".dockerfile",
    ".env",
    ".example",
    ".json",
    ".md",
    ".py",
    ".sh",
    ".toml",
    ".txt",
    ".yaml",
    ".yml",
}
SECRET_PATTERNS = {
    "GitHub token": re.compile(r"\bgh[pousr]_[A-Za-z0-9_]{20,}\b"),
    "Telegram bot token": re.compile(r"\b\d{8,10}:[A-Za-z0-9_-]{30,}\b"),
    "TelePost submit token": re.compile(r"\btp_[A-Za-z0-9_-]{20,}\b"),
    "local macOS path": re.compile(r"/Users/[A-Za-z0-9._-]+/"),
    "local Linux home path": re.compile(r"/home/[A-Za-z0-9._-]+/"),
}


def tracked_files() -> list[str]:
    result = subprocess.run(
        ["git", "ls-files", "-z"],
        cwd=ROOT,
        check=True,
        capture_output=True,
    )
    return [item.decode("utf-8") for item in result.stdout.split(b"\0") if item]


def is_runtime_path(path: str) -> bool:
    item = PurePosixPath(path)
    if path == "telesubmit.fly.toml":
        return True
    if item.name == ".env" or (
        item.name.startswith(".env.") and item.name != ".env.example"
    ):
        return True
    if item.parts and item.parts[0] in {"data", "proxy-data"}:
        return True
    if path.startswith("fly/data/") or (
        path.startswith("fly/scripts/") and path.endswith(".env")
    ):
        return True
    if path.startswith("fly/config/") and path.endswith(".json") and not path.endswith(".example.json"):
        return True
    return item.suffix in {".db", ".upload"} or path.endswith((".db-shm", ".db-wal"))


def is_text_file(path: Path) -> bool:
    return path.name == "Dockerfile" or path.suffix.lower() in TEXT_SUFFIXES


def main() -> int:
    failures: list[str] = []
    for relative in tracked_files():
        if is_runtime_path(relative):
            failures.append(f"tracked runtime/secret path: {relative}")
            continue

        path = ROOT / relative
        if not path.is_file() or not is_text_file(path) or path.stat().st_size > 2_000_000:
            continue
        try:
            content = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        for label, pattern in SECRET_PATTERNS.items():
            if pattern.search(content):
                failures.append(f"possible {label}: {relative}")

    if failures:
        for failure in failures:
            print(f"[FAIL] {failure}", file=sys.stderr)
        return 1

    print("[OK] tracked files contain no known runtime paths or credential patterns")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
