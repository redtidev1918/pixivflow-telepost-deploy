#!/usr/bin/env bash
# 只读冒烟：业务端是否常驻、可达、且投稿接口确实要鉴权。
#
# 刻意不做的事：不提交任何投稿（那会进入真实审核队列）。所以只验证「没有令牌就进不来」。
set -uo pipefail

telepost_app=${TELEPOST_APP:-telesubmit-multi-bot}
base="https://${telepost_app}.fly.dev"

failures=0
fail() { echo "[FAIL] $*"; failures=$((failures + 1)); }
ok() { echo "[OK]   $*"; }

for path in health live; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "${base}/${path}" 2>/dev/null || echo 000)
  if [[ "$code" == "200" ]]; then ok "${base}/${path} → 200"; else fail "${base}/${path} → ${code}"; fi
done

for bot in bot1 bot2; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -X POST \
    -H 'Content-Type: application/json' \
    -d '{}' \
    "${base}/api/${bot}/v1/submissions" 2>/dev/null || echo 000)
  case "$code" in
    401|403) ok "${bot} 投稿接口无令牌被拒（HTTP ${code}）" ;;
    000) fail "${bot} 投稿接口不可达" ;;
    *) fail "${bot} 投稿接口未按预期拒绝无令牌请求（HTTP ${code}）" ;;
  esac
done

exit $(( failures > 0 ? 1 : 0 ))
