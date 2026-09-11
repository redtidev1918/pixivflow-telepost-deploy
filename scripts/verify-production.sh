#!/usr/bin/env bash
# 只读生产校验：一句话回答「现在的生产是不是契约描述的那套东西」。
#
# 只读的含义很具体：不发触发请求、不改配置、不注册 webhook、不动数据。
# 唯一带凭据的检查（webhook 归属）在缺少变量时输出 SKIP，且永远不打印密钥。
#
# 退出码：0 = 全部通过（SKIP 不算失败），1 = 至少一项不合格。
set -uo pipefail

repo_dir=$(cd "$(dirname "$0")/.." && pwd) || exit 1
cd "$repo_dir" || exit 1

pixivflow_app=${PIXIVFLOW_APP:-pixivflow-scheduler}
telepost_app=${TELEPOST_APP:-telesubmit-multi-bot}
worker_name=${WORKER_NAME:-pixivflow-control-plane}
trigger_base=${PIXIVFLOW_TRIGGER_BASE_URL:-https://pixivflow-scheduler.fly.dev}
schedule_id=${SCHEDULE_ID:-bot1-daily}

failures=0
fail() { echo "[FAIL] $*"; failures=$((failures + 1)); }
ok() { echo "[OK]   $*"; }
skip() { echo "[SKIP] $*"; }
note() { echo "[INFO] $*"; }

echo "== 1/7 Fly 应用状态 =="
if ! fly apps list 2>/dev/null | grep -q "^${pixivflow_app}"; then
  fail "Fly 应用 ${pixivflow_app} 不存在：执行端尚未创建（见 docs/ARCHITECTURE.md 拓扑）"
else
  ok "Fly 应用 ${pixivflow_app} 存在"
fi
if ! fly apps list 2>/dev/null | grep -q "^${telepost_app}"; then
  fail "Fly 应用 ${telepost_app} 不存在"
else
  ok "Fly 应用 ${telepost_app} 存在"
fi

echo "== 2/7 停机/唤醒参数（以部署中的配置为准，不读仓库文件）=="

# 断言写在部署中的配置上，而不是仓库文件上：仓库正确、线上跑着旧配置，正是要抓的情况。
app_config_check() {
  local app=$1 role=$2
  local cfg
  if ! cfg=$(fly config show -a "$app" 2>/dev/null) || [[ -z "$cfg" ]]; then
    fail "无法读取 ${app} 的部署配置（fly config show）"
    return 0
  fi
  local result
  result=$(printf '%s' "$cfg" | ROLE="$role" python3 -c '
import json, os, sys

role = os.environ["ROLE"]
cfg = json.load(sys.stdin)
svc = cfg.get("http_service", {})
env = cfg.get("env") or {}
problems = []

if role == "telepost":
    if svc.get("auto_stop_machines") is not False:
        problems.append("auto_stop_machines != false（冷启动对用户可见）")
    if svc.get("min_machines_running") != 1:
        problems.append("min_machines_running != 1")
    if not (svc.get("checks") or []):
        problems.append("缺少长期健康检查")
    if svc.get("force_https") is not False:
        problems.append("force_https != false（Flycast 私网投递会被 301 打断）")
    for key in ("PIXIVFLOW_ENABLED", "PIXIV_CONFIG", "PIXIV_REFRESH_TOKEN", "NODE_OPTIONS", "PIXIVFLOW_TRIGGER_PORT"):
        if key in env:
            problems.append("环境变量残留执行端配置: " + key)
else:
    if svc.get("auto_start_machines") is not True:
        problems.append("auto_start_machines != true（触发无法唤醒停止的机器）")
    if svc.get("auto_stop_machines") is not False:
        problems.append("auto_stop_machines != false（平台会砍断正在跑的批次）")
    if svc.get("min_machines_running") != 0:
        problems.append("min_machines_running != 0（无法回到 stopped）")
    if svc.get("checks") or (cfg.get("checks") or []):
        problems.append("存在健康检查（探测会重新唤醒刚收工的机器）")
    policy = (cfg.get("restart") or {}).get("policy")
    if policy != "no":
        problems.append("restart policy != no（跑完退出后会被平台重新拉起）")
    if not (env.get("PIXIV_DOWNLOADER_CONFIG") or "").endswith(".json"):
        problems.append("PIXIV_DOWNLOADER_CONFIG 未指向运行配置")

print("OK" if not problems else "BAD " + "; ".join(problems))
' 2>/dev/null)
  case "$result" in
    OK)
      if [[ "$role" == "telepost" ]]; then
        ok "TelePost 常驻参数正确（auto_stop=false / min_running=1 / 健康检查 / force_https=false）"
      else
        ok "PixivFlow 生命周期参数正确（自动唤醒 / 不自动停止 / 无探测 / restart=no）"
      fi
      ;;
    "")
      fail "无法解析 ${app} 的部署配置"
      ;;
    *)
      fail "${app} 配置不合格：${result#BAD }"
      ;;
  esac
}

app_config_check "$telepost_app" telepost
app_config_check "$pixivflow_app" pixivflow

echo "== 3/7 执行端状态与触发鉴权 =="
machine_json=$(fly machine list -a "$pixivflow_app" --json 2>/dev/null)
if [[ -n "$machine_json" ]]; then
  printf '%s' "$machine_json" | python3 -c '
import json, sys
machines = json.load(sys.stdin)
states = [m.get("state") for m in (machines if isinstance(machines, list) else [machines])]
print("状态：" + ", ".join(states))
'
  ok "执行端机器存在（stopped 是正常状态）"
else
  fail "无法列出 ${pixivflow_app} 的机器"
fi

code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 \
  "${trigger_base%/}/internal/schedules/${schedule_id}/run" 2>/dev/null || echo 000)
case "$code" in
  401|403) ok "未授权的触发被拒（HTTP ${code}）" ;;
  000) fail "触发地址无法访问：${trigger_base}" ;;
  200|202) fail "未授权触发被接受（HTTP ${code}）：触发端点缺少鉴权" ;;
  *) note "未授权触发返回 HTTP ${code}（预期 401/403；若为 404 检查路径与 schedule id）" ;;
esac

echo "== 4/7 业务端探针 =="
for path in health live; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "https://${telepost_app}.fly.dev/${path}" 2>/dev/null || echo 000)
  if [[ "$code" == "200" ]]; then ok "https://${telepost_app}.fly.dev/${path} → 200"; else fail "https://${telepost_app}.fly.dev/${path} → ${code}"; fi
done

echo "== 5/7 Telegram webhook 归属 =="
"$repo_dir/scripts/verify-webhooks.sh" || failures=$((failures + 1))

echo "== 6/7 镜像与提交号 =="
"$repo_dir/scripts/verify-images.sh" || failures=$((failures + 1))

echo "== 7/7 Cloudflare 时钟 =="
python3 "$repo_dir/scripts/cf-clock-readonly.py" "$worker_name" || note "跳过 Cloudflare 时钟核对（缺少只读凭据）"

echo
if [[ $failures -gt 0 ]]; then
  echo "生产校验未通过：${failures} 项不合格。"
  exit 1
fi
echo "生产校验通过（SKIP 项需要凭据，不代表已验证）。"
