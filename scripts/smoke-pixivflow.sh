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

script_dir=$(cd "$(dirname "$0")" && pwd)
# Structured app-state probe (fly apps list --json). Never parses terminal
# tables: padded rows once made this script report a live app as missing.
# States: deployed | suspended | missing | cli_failure (never "missing" on CLI/network/auth errors).
app_state=$(python3 "$script_dir/fly_app_state.py" "$pixivflow_app" 2>/dev/null | head -1)
case "$app_state" in
  deployed:*)
    ok "Fly 应用 ${pixivflow_app} 存在（${app_state#deployed: }）"
    ;;
  suspended:*)
    ok "Fly 应用 ${pixivflow_app} 已挂起（设计上的空闲自停，非缺失）"
    ;;
  missing:*)
    fail "Fly 应用 ${pixivflow_app} 不存在（执行端尚未创建）"
    exit 1
    ;;
  *)
    skip "无法用 fly CLI 判定应用状态（CLI/网络/认证问题，非应用缺失证据）：${app_state:-no output}"
    ;;
esac

machines=$(fly machine list -a "$pixivflow_app" --json 2>/dev/null)
if [[ -z "$machines" ]]; then
  fail "无法列出 ${pixivflow_app} 的机器"
else
  # Print machine lines; a JSON/parse failure must be visible, never printed
  # after-the-fact as success (the old inline f-string broke silently on some
  # python3 builds and still emitted [OK]).
  if printf '%s' "$machines" | python3 -c '
import json, sys
machines = json.load(sys.stdin)
machines = machines if isinstance(machines, list) else [machines]
for machine in machines:
    state = machine.get("state")
    guest = (machine.get("config") or {}).get("guest") or {}
    mid = str(machine.get("id"))[:8]
    mem = guest.get("memory_mb")
    print("[INFO] 机器 {} 状态={} 内存={}MB".format(mid, state, mem))
'; then
    ok "执行端机器存在（stopped 是正常且期望的静止状态）"
  else
    fail "机器列表 JSON 解析失败（输出格式异常，不判为健康）"
  fi
fi

# Must be a POST: the route only registers POST (a bare GET 404s before auth,
# which made this check report SKIP/404 forever). A tokenless POST is answered
# 401 by auth BEFORE any execution logic runs (verified 2026-10-26).
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -X POST \
  -H 'Content-Type: application/json' --data '{}' \
  "${trigger_base%/}/internal/schedules/${schedule_id}/run" 2>/dev/null || echo 000)
case "$code" in
  401|403) ok "未授权触发被拒（HTTP ${code}）" ;;
  000) fail "触发地址不可达：${trigger_base}" ;;
  200|202) fail "未授权触发被接受（HTTP ${code}）：执行端缺少触发鉴权" ;;
  *) skip "未授权触发返回 HTTP ${code}（预期 401/403；若为 404 检查路径与 schedule id）" ;;
esac

exit $(( failures > 0 ? 1 : 0 ))
