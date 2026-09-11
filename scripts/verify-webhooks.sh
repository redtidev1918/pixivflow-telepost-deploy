#!/usr/bin/env bash
# 只读核对：投稿机器人的 Telegram webhook 是否仍然指向 TelePost。
#
# 这一项不能靠静态检查回答：webhook 的归属是运行时的外部状态。历史上它被指到过
# Cloudflare Worker 上，而 Worker 对每条 update 都回 200 {ok:true}，于是 Telegram 报告
# 一切健康，用户投稿却被静默丢弃。所以这里用真实 API 只读地问一次。
#
# 需要 BOT1_TOKEN / BOT2_TOKEN（可从环境或仓库根的 .env 读取）。缺一个就 SKIP 一个，
# 任何情况下都不打印令牌，只打印归属主机。
set -uo pipefail

repo_dir=$(cd "$(dirname "$0")/.." && pwd)
expected_host=${TELEPOST_HOST:-telesubmit-multi-bot.fly.dev}

# 显式导出的环境变量优先于 .env。`.env` 属于本地 compose 部署，里面常是占位符或
# 与生产 Fly secrets 不同的旧值；`set -a; . .env` 会无条件覆盖已导出的变量，于是
# 「运维显式给了真 token」照样得到 SKIP——又一个看起来在做、其实没做的核对。
_explicit_bot1=${BOT1_TOKEN:-}
_explicit_bot2=${BOT2_TOKEN:-}

if [[ -f "$repo_dir/.env" ]]; then
  set -a
  # shellcheck source=/dev/null
  . "$repo_dir/.env" >/dev/null 2>&1 || true
  set +a
fi

[[ -n "$_explicit_bot1" ]] && BOT1_TOKEN=$_explicit_bot1
[[ -n "$_explicit_bot2" ]] && BOT2_TOKEN=$_explicit_bot2

failures=0
checked=0

# Telegram bot token 的形态是 "<数字>:<35 位以上 [A-Za-z0-9_-]>"。仓库根的 .env 属于
# 本地 compose 部署，里面可能是占位符或与生产 Fly secrets 不同的旧值；拿它去查生产
# webhook 只会得到 401「invalid token specified」，把「未提供可用凭据」误报成「生产
# 不合格」。所以形态不符时按未提供处理，绝不发起调用。
token_looks_valid() {
  [[ "$1" =~ ^[0-9]{6,}:[A-Za-z0-9_-]{30,}$ ]]
}

check_bot() {
  local label=$1 token=$2
  if [[ -z "${token:-}" ]]; then
    echo "[SKIP] ${label}: 未提供 token（导出 ${label}_TOKEN 或写入 .env）"
    return 0
  fi
  if ! token_looks_valid "$token"; then
    echo "[SKIP] ${label}: token 形态不像 Telegram bot token（本地 .env 大概是占位符/旧值），未做归属核对"
    return 0
  fi
  checked=$((checked + 1))
  local body
  body=$(curl -s --max-time 20 "https://api.telegram.org/bot${token}/getWebhookInfo" 2>/dev/null)
  if [[ -z "$body" ]]; then
    echo "[FAIL] ${label}: getWebhookInfo 无响应"
    failures=$((failures + 1))
    return 0
  fi
  local rc=0
  BODY="$body" python3 - "$label" "$expected_host" <<'PY' || rc=$?
import json, os, sys
label, expected = sys.argv[1], sys.argv[2]
try:
    payload = json.loads(os.environ["BODY"])
except Exception:
    print(f"[FAIL] {label}: 响应不是 JSON")
    raise SystemExit(1)
if not payload.get("ok"):
    # 401 说明 token 无效；这里只报告结论，不复述任何响应细节。
    print(f"[FAIL] {label}: Telegram 拒绝该 token（{payload.get('description', 'unknown')}）")
    raise SystemExit(1)
result = payload.get("result") or {}
url = result.get("url") or ""
if not url:
    print(f"[FAIL] {label}: 没有注册 webhook（用户投稿不会被接收）")
    raise SystemExit(1)
host = url.split("/")[2] if "://" in url else url
if host != expected:
    print(f"[FAIL] {label}: webhook 指向 {host}，期望 {expected}（投稿会被错误的一方吞掉）")
    raise SystemExit(1)
pending = result.get("pending_update_count")
print(f"[OK]   {label}: webhook 归属 {host}（待处理更新 {pending}）")
PY
  if [[ $rc -ne 0 ]]; then failures=$((failures + 1)); fi
}

check_bot BOT1 "${BOT1_TOKEN:-}"
check_bot BOT2 "${BOT2_TOKEN:-}"

if [[ $checked -eq 0 ]]; then
  echo "[SKIP] 未提供任何 bot token，webhook 归属未验证"
  exit 0
fi
exit $(( failures > 0 ? 1 : 0 ))
