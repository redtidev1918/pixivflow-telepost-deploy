#!/usr/bin/env python3
"""只读核对 Cloudflare 时钟：这个 Worker 现在挂了哪些 cron。

只做一件事：读 `/{account}/workers/scripts/{name}/schedules`，打印 cron 列表，并与
`control-plane/src/cron-map.ts` + `control-plane/wrangler.toml` 里的期望值比对。

凭据来源（按顺序）：
  1. 环境变量 CLOUDFLARE_API_TOKEN（+ 可选 CLOUDFLARE_ACCOUNT_ID）
  2. Wrangler 的 OAuth 配置（`wrangler login` 留下的本地凭据）

任何凭据都不会被打印。缺少凭据时以退出码 2 结束，调用方据此输出 SKIP。
"""

from __future__ import annotations

import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

API = "https://api.cloudflare.com/client/v4"
REPO_ROOT = Path(__file__).resolve().parent.parent

WRANGLER_CONFIG_CANDIDATES = [
    Path(os.environ.get("WRANGLER_HOME", "")) / "config" / "default.toml" if os.environ.get("WRANGLER_HOME") else None,
    Path.home() / "Library" / "Preferences" / ".wrangler" / "config" / "default.toml",
    Path.home() / ".config" / ".wrangler" / "config" / "default.toml",
    Path.home() / ".wrangler" / "config" / "default.toml",
]


def expected_crons() -> list[str]:
    """The two lists that must agree: the Worker's map and wrangler.toml."""
    map_text = (REPO_ROOT / "control-plane" / "src" / "cron-map.ts").read_text(encoding="utf-8")
    wrangler = (REPO_ROOT / "control-plane" / "wrangler.toml").read_text(encoding="utf-8")
    declared = re.search(r"^\s*crons\s*=\s*\[([^\]]*)\]", wrangler, re.M)
    if not declared:
        return []
    from_wrangler = re.findall(r"['\"]([^'\"]+)['\"]", declared.group(1))
    from_map = re.findall(r"^\s*'([^']+)':\s*\{", map_text, re.M)
    if sorted(from_wrangler) != sorted(from_map):
        print(f"[FAIL] wrangler.toml 与 cron-map.ts 不一致：{from_wrangler} vs {from_map}")
        raise SystemExit(1)
    return from_wrangler


def credential() -> tuple[str, str | None]:
    token = os.environ.get("CLOUDFLARE_API_TOKEN", "").strip()
    account = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "").strip() or None
    if token:
        return token, account
    for candidate in WRANGLER_CONFIG_CANDIDATES:
        if candidate and candidate.is_file():
            text = candidate.read_text(encoding="utf-8")
            found = re.search(r'^\s*oauth_token\s*=\s*"([^"]+)"', text, re.M)
            if found:
                acc = re.search(r'^\s*(?:account_id|default_account_id)\s*=\s*"([^"]+)"', text, re.M)
                return found.group(1), (acc.group(1) if acc else account)
    raise SystemExit(2)


def request(token: str, path: str) -> dict:
    req = urllib.request.Request(f"{API}{path}", headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=20) as response:  # noqa: S310 - fixed API host
        return json.load(response)


def main() -> int:
    worker = sys.argv[1] if len(sys.argv) > 1 else "pixivflow-control-plane"
    want = expected_crons()
    try:
        token, account = credential()
    except SystemExit as exc:
        if exc.code == 2:
            print("[SKIP] 无 Cloudflare 只读凭据（CLOUDFLARE_API_TOKEN 或 wrangler login）")
            return 0
        raise

    if not account:
        try:
            accounts = request(token, "/accounts").get("result") or []
        except urllib.error.HTTPError as exc:
            print(f"[FAIL] 读取 Cloudflare 账号失败（HTTP {exc.code}）")
            return 1
        except Exception:  # noqa: BLE001 - network failures are reported, not raised
            print("[FAIL] 读取 Cloudflare 账号失败（网络）")
            return 1
        if not accounts:
            print("[FAIL] 该凭据下没有可读账号")
            return 1
        account = accounts[0]["id"]

    try:
        payload = request(token, f"/accounts/{account}/workers/scripts/{worker}/schedules")
    except urllib.error.HTTPError as exc:
        if exc.code in (401, 403):
            print(f"[FAIL] 无权读取 Worker {worker} 的 schedules（HTTP {exc.code}）")
        elif exc.code == 404:
            print(f"[FAIL] Worker {worker} 不存在或未部署")
        else:
            print(f"[FAIL] 读取 schedules 失败（HTTP {exc.code}）")
        return 1
    except Exception:  # noqa: BLE001
        print("[FAIL] 读取 schedules 失败（网络）")
        return 1

    result = payload.get("result") or {}
    active = sorted(entry.get("cron", "") for entry in (result.get("schedules") or []))
    if not active or all(not cron for cron in active):
        print(f"[FAIL] Worker {worker} 没有任何 cron：时钟停了，到点不会有人唤醒执行端")
        return 1
    if active != sorted(want):
        print(f"[FAIL] cron 与期望不一致：线上 {active}，期望 {sorted(want)}")
        return 1
    print(f"[OK]   Worker {worker} 的 cron 与映射一致：{active}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
