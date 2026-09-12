#!/usr/bin/env python3
"""verify-webhooks.sh argv 泄漏修复的三通道自测（不触网、不打印真 token）。

被测对象：``scripts/tg_webhook_check.py``（argv 修复版 helper）。

三个通道逐一验证 —— 合成 token 在任何一条输出里都不得出现：

1. **argv**：以合成 token 经环境变量启动 helper 并令其驻留，外部读取
   ``ps -o args= -p <pid>``，断言标记串不在其中（这正是旧 ``curl "…/bot$token/…"``
   的泄漏通道）。
2. **stdout**：抓取 helper 的 stdout，断言标记串不在其中。
3. **stderr**：抓取 helper 的 stderr，断言标记串不在其中。

另外验证 stdin 通道（``--stdin``）同样不泄漏。

合成 token 的形态合法（满足 Telegram 形态）但**并非真实凭据**：其主体含易于检索的
标记串，因此"未泄漏"的断言是可靠的。
"""

from __future__ import annotations

import json
import os
import pathlib
import subprocess
import sys
import time

HERE = pathlib.Path(__file__).resolve().parent
HELPER = HERE.parent / "scripts" / "tg_webhook_check.py"

# 合成 token：数字 ID + 冒号 + 含独特标记的合法形态主体（>=30 位 [A-Za-z0-9_-]）
MARKER = "ZZSELFTESTMARKERZZNOTAREALTOKEN"
FAKE_TOKEN = "1234567890:" + ("A" * 10) + MARKER + ("B" * 10)

ENV_NAME = "SELFTEST_BOT_TOKEN"


def _assert_no_marker(name: str, text: str, results: list) -> None:
    leaked = MARKER in (text or "")
    results.append({"channel": name, "leaked": leaked,
                    "detail": "marker absent" if not leaked else "MARKER FOUND"})
    if leaked:
        print(f"[FAIL] {name}: token marker leaked", file=sys.stderr)


def check_argv(results: list) -> None:
    env = dict(os.environ)
    env[ENV_NAME] = FAKE_TOKEN
    proc = subprocess.Popen(
        [sys.executable, str(HELPER), "--label", "SELFTEST",
         "--expected-host", "example.invalid", "--env", ENV_NAME,
         "--dry-run", "--linger", "3"],
        env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    seen_args = []
    try:
        deadline = time.time() + 2.5
        while time.time() < deadline and proc.poll() is None:
            ps = subprocess.run(["ps", "-o", "args=", "-p", str(proc.pid)],
                                capture_output=True, text=True)
            seen_args.append(ps.stdout.strip())
            time.sleep(0.25)
        out, err = proc.communicate(timeout=20)
    finally:
        if proc.poll() is None:
            proc.kill()
            out, err = proc.communicate()

    argv_blob = "\n".join(seen_args)
    results.append({"channel": "argv.samples", "leaked": False,
                    "detail": f"{len(seen_args)} ps samples taken"})
    _assert_no_marker("argv", argv_blob, results)
    _assert_no_marker("stdout", out, results)
    _assert_no_marker("stderr", err, results)

    try:
        payload = json.loads(out.strip().splitlines()[-1])
        results.append({"channel": "stdout.contract", "leaked": False,
                        "detail": "fields=" + ",".join(payload.keys())})
    except Exception:  # noqa: BLE001
        results.append({"channel": "stdout.contract", "leaked": False,
                        "detail": "NOT_JSON"})


def check_stdin(results: list) -> None:
    proc = subprocess.run(
        [sys.executable, str(HELPER), "--label", "SELFTEST",
         "--expected-host", "example.invalid", "--stdin", "--dry-run"],
        input=FAKE_TOKEN + "\n", capture_output=True, text=True, timeout=30,
    )
    _assert_no_marker("stdin.stdout", proc.stdout, results)
    _assert_no_marker("stdin.stderr", proc.stderr, results)


def main() -> int:
    if not HELPER.is_file():
        print(f"helper not found: {HELPER}", file=sys.stderr)
        return 2
    results: list[dict] = []
    check_argv(results)
    check_stdin(results)

    payload = {
        "schema": "webhook-token-leak-selftest/v1",
        "target": str(HELPER),
        "channels_checked": ["argv", "stdout", "stderr", "stdin.stdout", "stdin.stderr"],
        "synthetic_token_used": True,
        "real_credential_used": False,
        "network_calls_made": 0,
        "results": results,
        "passed": all(not r["leaked"] for r in results),
    }
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0 if payload["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
