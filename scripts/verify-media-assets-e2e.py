#!/usr/bin/env python3
"""Read-only production probe for the media_assets E2E (Batch 4 gate).

Checks, for a slot date (default today, Asia/Shanghai):
  1. whether today's bot1/bot2 slot created reviews,
  2. whether those chains carry media_asset_refs with i.pximg.net source_url
     and no Telegram file_id yet,
  3. whether GET /api/botN/v1/reviews/{id}/delivery-plan returns
     strategy=remote_url with a MEDIA_PROXY_BASE_URL/media/i.pximg.net/... URL,
  4. whether that proxied URL answers 200 image/*.

Strictly read-only: SQLite mode=ro, GET-only API calls, no writes, no Telegram
calls. Never prints credentials; the review token is read from the container
environment only.

Run against the publisher container:

    fly ssh console -a telesubmit-multi-bot -C "sh -c 'python3 -'" \\
        < scripts/verify-media-assets-e2e.py

Optional positional arg: YYYY-MM-DD (default today Asia/Shanghai).
"""
from __future__ import annotations

import datetime
import glob
import json
import os
import sqlite3
import sys
import urllib.error
import urllib.request

SHANGHAI = datetime.timezone(datetime.timedelta(hours=8))
API_PORT = 8080


def target_date(argv: list[str]) -> str:
    for arg in argv:
        if len(arg) == 10 and arg[4] == "-" and arg[7] == "-":
            return arg
    return datetime.datetime.now(SHANGHAI).strftime("%Y-%m-%d")


def databases() -> list[str]:
    return sorted(glob.glob("/app/data/bot*/submissions.db"))


def review_token() -> str:
    return os.environ.get("TELEPOST_MCP_REVIEW_TOKEN") or os.environ.get("TELEPOST_REVIEW_TOKEN") or ""


def delivery_plan(bot: int, review_id: int) -> dict:
    token = review_token()
    url = f"http://127.0.0.1:{API_PORT}/api/bot{bot}/v1/reviews/{review_id}/delivery-plan"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.load(resp)


def fetch_url(url: str) -> tuple[int, str]:
    # Cloudflare bot protection on workers.dev 403s the default
    # "Python-urllib/x" User-Agent; the real delivery consumer (Telegram's
    # URL fetcher) passes. Use a benign UA so the probe measures the proxy,
    # not our own client fingerprint.
    req = urllib.request.Request(url, headers={"User-Agent": "telepost-e2e-probe/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return resp.status, resp.headers.get("content-type", "")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.headers.get("content-type", "")
    except Exception as exc:
        return 0, type(exc).__name__


def probe_db(path: str, day: str) -> dict:
    bot = int(os.path.basename(os.path.dirname(path)).removeprefix("bot"))
    out: dict = {"bot": bot, "day": day, "submissions": [], "media_asset_refs": [], "delivery_plans": []}
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    rows = con.execute(
        "SELECT id, review_chain_id, source_ref, title, work_type, status "
        "FROM pending_reviews WHERE source_ref LIKE ? ORDER BY id",
        (f"%@{day}T%",),
    ).fetchall()
    for row in rows:
        out["submissions"].append(dict(row))
        chain = row["review_chain_id"] or ""
        refs = con.execute(
            "SELECT asset_id, kind, source_url, mime_type, file_id "
            "FROM media_asset_refs WHERE review_chain_id=? ORDER BY id", (chain,),
        ).fetchall()
        out["media_asset_refs"].extend(dict(r) for r in refs)
        if refs:
            try:
                plan = delivery_plan(bot, row["id"])
                entries = (plan.get("data") or {}).get("entries") or []
                proxied = []
                for entry in entries:
                    url = entry.get("source_url") or ""
                    if entry.get("strategy") == "remote_url" and url:
                        status, ctype = fetch_url(url)
                        proxied.append({"url": url, "status": status, "content_type": ctype})
                out["delivery_plans"].append({"review_id": row["id"], "plan": plan, "proxied": proxied})
            except Exception as exc:
                out["delivery_plans"].append({"review_id": row["id"], "error": f"{type(exc).__name__}: {exc}"})
    con.close()
    return out


def main(argv: list[str]) -> int:
    day = target_date(argv)
    report = {"date": day, "bots": [probe_db(p, day) for p in databases()]}
    print(json.dumps(report, ensure_ascii=False, indent=1))
    new_refs = sum(len(b["media_asset_refs"]) for b in report["bots"])
    if not any(b["submissions"] for b in report["bots"]):
        print("NO_SUBMISSIONS: 今日槽位无投稿（可能无候选或未到时间）")
        return 1
    if not new_refs:
        print("NO_MEDIA_ASSET_REFS: 今日投稿未携带 media_assets")
        return 1
    # A plan that resolved every asset to Telegram file_id legitimately has no
    # proxied URL; remote_url plans must each answer 200 image/*.
    remote_plans = [
        p for b in report["bots"] for p in b["delivery_plans"]
        if any((e.get("strategy") == "remote_url") for e in ((p.get("plan") or {}).get("data") or {}).get("entries", []))
    ]
    ok = bool(remote_plans) and all(
        p.get("proxied") and all(x.get("status") == 200 and "image/" in (x.get("content_type") or "") for x in p.get("proxied", []))
        for p in remote_plans
    )
    print("E2E_OK" if ok else "E2E_INCOMPLETE")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
