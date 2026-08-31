#!/usr/bin/env python3
"""Extract one release section from CHANGELOG.md for GitHub Release notes."""

from __future__ import annotations

import re
import sys
from pathlib import Path


def main() -> int:
    if len(sys.argv) != 2:
        print(f"Usage: {Path(sys.argv[0]).name} <version>", file=sys.stderr)
        return 2

    version = sys.argv[1]
    if version.startswith("v"):
        version = version[1:]
    changelog = Path(__file__).resolve().parent.parent / "CHANGELOG.md"
    content = changelog.read_text(encoding="utf-8")
    heading = re.compile(rf"^## \[{re.escape(version)}\](?:\s+-\s+[^\n]+)?\s*$", re.MULTILINE)
    match = heading.search(content)
    if not match:
        print(f"CHANGELOG.md has no section for {version}", file=sys.stderr)
        return 1

    next_heading = re.search(r"^## \[", content[match.end() :], re.MULTILINE)
    end = match.end() + next_heading.start() if next_heading else len(content)
    notes = content[match.end() : end].strip()
    if not notes:
        print(f"CHANGELOG.md section for {version} is empty", file=sys.stderr)
        return 1
    print(notes)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
