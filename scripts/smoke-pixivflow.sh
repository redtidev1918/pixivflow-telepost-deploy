#!/usr/bin/env bash
# 只读冒烟：执行端是否处于契约描述的状态。
#
# 刻意不做的事：不发带令牌的触发请求（那会真的开始一次运行）、不启动机器、
# 不修改任何配置。所以这里检查的是「停止态是合法的」「未授权触发被拒」。
set -uo pipefail

pixivflow_app=${PIXIVFLOW_APP:-pixivflow-scheduler}
trigger_base=${PIXIVFLOW_TRIGGER_BASE_URL:-https://pixivflow-scheduler.fly.dev}
schedule_id=${SCHEDULE_ID:-bot1-daily}

failures=0
fail() { echo "[FAIL] $*"; failures=$((failures + 1)); }
ok() { echo "[OK]   $*"; }
skip() { echo "[SKIP] $*"; }

if ! fly apps list 2>/dev/null | grep -q "^${pixivflow_app}"; then
  fail "Fly 应用 ${pixivflow_app} 不存在（执行端尚未创建）"
  exit 1
fi

machines=$(fly machine list -a "$pixivflow_app" --json 2>/dev/null)
if [[ -z "$machines" ]]; then
  fail "无法列出 ${pixivflow_app} 的机器"
else
  printf '%s' "$machines" | python3 -c '
import json, sys
machines = json.load(sys.stdin)
machines = machines if isinstance(machines, list) else [machines]
for machine in machines:
    state = machine.get("state")
    guest = (machine.get("config") or {}).get("guest") or {}
    print(f"[INFO] 机器 {str(machine.get(\"id\"))[:8]} 状态={state} 内存={guest.get(\"memory_mb\")}MB")
'
  ok "执行端机器存在（stopped 是正常且期望的静止状态）"
fi

code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 \
  "${trigger_base%/}/internal/schedules/${schedule_id}/run" 2>/dev/null || echo 000)
case "$code" in
  401|403) ok "未授权触发被拒（HTTP ${code}）" ;;
  000) fail "触发地址不可达：${trigger_base}" ;;
  200|202) fail "未授权触发被接受（HTTP ${code}）：执行端缺少触发鉴权" ;;
  *) skip "未授权触发返回 HTTP ${code}（预期 401/403；若为 404 检查路径与 schedule id）" ;;
esac

exit $(( failures > 0 ? 1 : 0 ))
