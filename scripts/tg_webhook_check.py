#!/usr/bin/env python3
"""Telegram webhook 归属只读核对（argv 泄漏修复版 helper）。

背景
----
``scripts/verify-webhooks.sh`` 原先直接执行：

    curl -s --max-time 20 "https://api.telegram.org/bot${token}/getWebhookInfo"

bot token 因此出现在 **curl 的 argv** 里，同机器上任何用户执行 ``ps`` 都能读到，
并且会写进 shell history / 进程审计日志。这个 helper 把 token 从 argv 中彻底移除：

* token **只**通过 ``--env <NAME>``（继承环境，不落 argv）或 **stdin** 进入进程；
* 请求 URL 在进程内拼接，**从不**作为命令行参数、从不打印；
* 输出固定 5 个字段，**不含 token、不含完整 URL**（只含 webhook 归属主机名，
  该主机名与脚本内置的期望值同级，本身不是机密）。

输出契约（JSON，单行，恰好 5 个字段）
-------------------------------------
    {"label": str, "status": str, "host": str|null,
     "matches_expected_host": bool, "pending_update_count": int|null}

``status`` 取值：``OK`` / ``INVALID_TOKEN`` / ``NO_WEBHOOK`` / ``HOST_MISMATCH`` /
``API_ERROR``。

退出码：``OK`` → 0；``INVALID_TOKEN`` / ``NO_WEBHOOK`` / ``HOST_MISMATCH`` →
1（配置不合格）；``API_ERROR`` → 2（无法判定，区别于「不合格」）。

安全约束
--------
* 任何异常都在此捕获，**绝不**把异常对象（HTTPError 的 str 含完整 URL）写出去；
* 不读剪贴板、不访问 BotFather、不写入任何文件、不打印 token 的任何前缀或后缀。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

TOKEN_SHAPE_RE = re.compile(r"^[0-9]{6,}:[A-Za-z0-9_-]{30,}$")
API_TEMPLATE = "https://api.telegram.org/bot{token}/getWebhookInfo"

OUTPUT_FIELDS = ("label", "status", "host",
                 "matches_expected_host", "pending_update_count")


def read_token(env_name: str | None) -> str:
    """token 只从继承环境或 stdin 读取，绝不来自 argv。"""
    if env_name:
        return (os.environ.get(env_name) or "").strip()
    return (sys.stdin.readline() or "").strip()


def emit(label: str, status: str, host: str | None,
         matches: bool, pending: int | None) -> None:
    payload = {
        "label": label,
        "status": status,
        "host": host,
        "matches_expected_host": bool(matches),
        "pending_update_count": pending,
    }
    assert tuple(payload.keys()) == OUTPUT_FIELDS, "output field contract broken"
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def fetch_webhook_info(token: str, timeout: float) -> dict:
    """进程内构造 URL 并发起只读请求。返回 Telegram 响应 JSON。

    异常一律不向外冒泡出原始对象：HTTPError 的字符串包含完整 URL（含 token）。
    """
    url = API_TEMPLATE.format(token=token)  # 仅存在于本进程内存
    req = urllib.request.Request(url, headers={"User-Agent": "TelePost-WebhookCheck/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read(1_000_000)
    except urllib.error.HTTPError as exc:
        # 401/403 的响应体是 Telegram 的 JSON（不含 token），可以安全解析
        try:
            raw = exc.read(1_000_000)
        except Exception:  # noqa: BLE001
            raise OSError("http error without body") from None
    except Exception:  # noqa: BLE001 - 绝不外泄底层异常文本
        raise OSError("transport failure") from None
    try:
        payload = json.loads(raw.decode("utf-8", "replace"))
    except Exception:  # noqa: BLE001
        raise OSError("response is not JSON") from None
    if not isinstance(payload, dict):
        raise OSError("unexpected response shape")
    return payload


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Telegram webhook 归属只读核对（token 不经 argv）")
    ap.add_argument("--label", required=True, help="报告用标签，例如 BOT1")
    ap.add_argument("--expected-host", required=True, help="期望的 webhook 主机名")
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--env", help="从该环境变量读取 token（推荐）")
    src.add_argument("--stdin", action="store_true", help="从 stdin 读取一行 token")
    ap.add_argument("--timeout", type=float, default=20.0)
    ap.add_argument("--dry-run", action="store_true",
                    help="不发网络请求（仅用于 argv/stdout/stderr 泄漏自测）")
    ap.add_argument("--linger", type=float, default=0.0,
                    help="在请求前停留若秒，便于外部抓取 ps 做 argv 自测")
    args = ap.parse_args(argv)

    token = read_token(args.env if args.env else None)

    if args.linger and args.linger > 0:
        time.sleep(args.linger)

    if not token:
        emit(args.label, "INVALID_TOKEN", None, False, None)
        return 1
    if not TOKEN_SHAPE_RE.match(token):
        # 形态不符（多半是 .env 里的占位符/旧值）→ 不发起调用
        emit(args.label, "INVALID_TOKEN", None, False, None)
        return 1

    if args.dry_run:
        # 自测路径：仍然走一次「进程内构造 URL」的代码，但不发请求、不打印 URL
        _ = API_TEMPLATE.format(token=token)
        emit(args.label, "OK", args.expected_host, True, None)
        return 0

    try:
        payload = fetch_webhook_info(token, args.timeout)
    except OSError:
        emit(args.label, "API_ERROR", None, False, None)
        return 2

    if not payload.get("ok"):
        # 只报告结论，不复述任何响应细节（响应体可能含 description，不含 token）
        emit(args.label, "INVALID_TOKEN", None, False, None)
        return 1

    result = payload.get("result") or {}
    url = result.get("url") or ""
    pending = result.get("pending_update_count")
    if not isinstance(pending, int):
        pending = None
    if not url:
        emit(args.label, "NO_WEBHOOK", None, False, pending)
        return 1

    host = url.split("/")[2] if "://" in url else url
    if host != args.expected_host:
        emit(args.label, "HOST_MISMATCH", host, False, pending)
        return 1

    emit(args.label, "OK", host, True, pending)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
