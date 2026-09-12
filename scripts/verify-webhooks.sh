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

  # token 经**继承环境变量**交给 helper，URL 由 helper 在进程内拼接；
  # token 从不进入 argv、不打印、不落文件。
  # 旧实现 `curl -s ".../bot${token}/getWebhookInfo"` 会把 token 放进 curl 的 argv，
  # 同机上任何用户 `ps` 一下就能读走，也会写进 shell history / 进程审计日志。
  local out rc=0
  out=$(TG_WEBHOOK_CHECK_TOKEN="$token" python3 "$repo_dir/scripts/tg_webhook_check.py" \
         --label "$label" --expected-host "$expected_host" --env TG_WEBHOOK_CHECK_TOKEN) || rc=$?

  local status host pending
  status=""
  host=""
  pending=""
  if [[ -n "$out" ]]; then
    read -r status host pending < <(printf '%s' "$out" | python3 -c '
import json, sys
try:
    obj = json.load(sys.stdin)
except Exception:
    raise SystemExit(0)
p = obj.get("pending_update_count")
print(obj.get("status", "API_ERROR"), obj.get("host") or "-",
      p if isinstance(p, int) else "-")
' 2>/dev/null)
  fi

  case "${status:-API_ERROR}" in
    OK)
      echo "[OK]   ${label}: webhook 归属 ${host}（待处理更新 ${pending}）"
      ;;
    NO_WEBHOOK)
      echo "[FAIL] ${label}: 没有注册 webhook（用户投稿不会被接收）"
      failures=$((failures + 1))
      ;;
    HOST_MISMATCH)
      echo "[FAIL] ${label}: webhook 指向 ${host}，期望 ${expected_host}（投稿会被错误的一方吞掉）"
      failures=$((failures + 1))
      ;;
    INVALID_TOKEN)
      echo "[FAIL] ${label}: Telegram 拒绝该 token（或本地值是占位符/旧值）"
      failures=$((failures + 1))
      ;;
    *)
      echo "[FAIL] ${label}: getWebhookInfo 无响应"
      failures=$((failures + 1))
      ;;
  esac
  return 0
}

check_bot BOT1 "${BOT1_TOKEN:-}"
check_bot BOT2 "${BOT2_TOKEN:-}"

if [[ $checked -eq 0 ]]; then
  echo "[SKIP] 未提供任何 bot token，webhook 归属未验证"
  exit 0
fi
exit $(( failures > 0 ? 1 : 0 ))
