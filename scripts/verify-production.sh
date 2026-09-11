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
# 不要用 `fly apps list | grep -q "^${app}"`：那是人类表格（列有前导空格），而且
# 前缀会把别的 app 误命中（pixivflow-scheduler-x 会匹配 pixivflow-scheduler）。
# 这里只信结构化来源：优先 `fly apps list --json` 精确比对 Name；老版 flyctl 没有
# --json 时退化为 `fly status -a <app>` 的退出码。
app_present() {
  local app=$1
  if fly apps list --json 2>/dev/null | python3 -c '
import json, sys
try:
    apps = json.load(sys.stdin)
except Exception:
    sys.exit(2)
apps = apps if isinstance(apps, list) else [apps]
sys.exit(0 if any((a.get("Name") == sys.argv[1]) for a in apps) else 1)
' "$app"; then
    return 0
  fi
  fly status -a "$app" >/dev/null 2>&1
}

pixivflow_exists=false
telepost_exists=false
if app_present "$pixivflow_app"; then
  pixivflow_exists=true
  ok "Fly 应用 ${pixivflow_app} 存在"
else
  fail "Fly 应用 ${pixivflow_app} 不存在：执行端尚未创建（见 docs/ARCHITECTURE.md 拓扑）"
fi
if app_present "$telepost_app"; then
  telepost_exists=true
  ok "Fly 应用 ${telepost_app} 存在"
else
  fail "Fly 应用 ${telepost_app} 不存在"
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

# force_https 只做「显式写了就必须是什么」的源配置检查。Fly 对未显式声明的默认值
# 可能根本不返回这个键（实测 TelePost 的 http_service 里就没有 force_https），
# 缺字段 != 值不对；运行期行为由 HTTP 探测单独核对，见 force_https_behavior_check。
if role == "telepost":
    if svc.get("auto_stop_machines") is not False:
        problems.append("auto_stop_machines != false（冷启动对用户可见）")
    if svc.get("min_machines_running") != 1:
        problems.append("min_machines_running != 1")
    if not (svc.get("checks") or []):
        problems.append("缺少长期健康检查")
    if "force_https" in svc and svc.get("force_https") is not False:
        problems.append("源配置 force_https != false（Flycast 私网投递会被 301 打断）")
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
    if "force_https" in svc and svc.get("force_https") is not True:
        problems.append("源配置 force_https != true（触发器必须走 HTTPS）")
    # restart.policy 的运行期权威来源是机器配置（见第 3 节），这里只在配置显式
    # 声明且值不对时报警：fly.toml 的 "never" 会被规范化成 "no"，两种拼写都收。
    raw = cfg.get("restart")
    if isinstance(raw, list):
        policies = [x.get("policy") for x in raw if isinstance(x, dict)]
    elif isinstance(raw, dict):
        policies = [raw.get("policy")]
    else:
        policies = []
    if policies and any(p not in ("no", "never") for p in policies):
        problems.append("restart policy 不是 never/no（跑完退出后会被平台重新拉起）")
    if not (env.get("PIXIV_DOWNLOADER_CONFIG") or "").endswith(".json"):
        problems.append("PIXIV_DOWNLOADER_CONFIG 未指向运行配置")

print("OK" if not problems else "BAD " + "; ".join(problems))
' 2>/dev/null)
  case "$result" in
    OK)
      if [[ "$role" == "telepost" ]]; then
        ok "TelePost 常驻参数正确（auto_stop=false / min_running=1 / 健康检查）"
      else
        ok "PixivFlow 生命周期参数正确（自动唤醒 / 不自动停止 / 无探测；restart 见第 3 节运行期核对）"
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

# force_https 的另一半是运行期行为：`fly config show` 不返回未显式声明的默认值，
# 所以「缺字段」绝不能当成「值不对」。只有明文 HTTP 探测能回答「Flycast 投递会不会
# 被 301 打断」——force_https=false 时明文应被直接服务，只有 =true 才 301/308。
# 执行端不做这个探测：请求会唤醒刚收工的机器（AGENTS.md 禁止用探测打扰它）。
force_https_behavior_check() {
  local app=$1 origin=$2
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "${origin}/health" 2>/dev/null || echo 000)
  case "$code" in
    301|308)
      fail "${app} 明文 HTTP 被强制跳转（${origin}/health → HTTP ${code}）：force_https 运行期实际为 on，Flycast 私网投递会被 301 打断" ;;
    000)
      note "${app} 明文 HTTP 探测不可达（force_https 运行期行为未能核对）" ;;
    2*|3*|4*)
      ok "${app} 明文 HTTP 未被强制跳转（${origin}/health → HTTP ${code}）：force_https 运行期行为为 off" ;;
    *)
      note "${app} 明文 HTTP 返回 HTTP ${code}（未判定 force_https）" ;;
  esac
}
if [[ "$telepost_exists" == true ]]; then
  force_https_behavior_check "$telepost_app" "http://${telepost_app}.fly.dev"
else
  note "跳过 ${telepost_app} 的 force_https 运行期核对（应用不存在）"
fi

echo "== 3/7 执行端状态、生命周期与触发鉴权 =="
machine_json=$(fly machine list -a "$pixivflow_app" --json 2>/dev/null)
machine_summary=""
if [[ -n "$machine_json" ]]; then
  machine_summary=$(printf '%s' "$machine_json" | python3 -c '
import json, sys
machines = json.load(sys.stdin)
if isinstance(machines, dict):
    machines = [machines]

def policies(cfg):
    r = cfg.get("restart")
    if isinstance(r, list):
        return [x.get("policy") for x in r if isinstance(x, dict)]
    if isinstance(r, dict):
        return [r.get("policy")]
    return []

states = []
bad = []
for m in machines:
    states.append(m.get("state") or "?")
    ps = [p for p in policies(m.get("config") or {})]
    if not ps or any(p not in ("no", "never") for p in ps):
        bad.append("%s restart.policy=%s" % (
            m.get("id") or "?",
            ",".join(str(p) for p in ps) if ps else "缺失(平台默认=always)"))
print(json.dumps({"states": states, "bad": bad}))
' 2>/dev/null)
fi
if [[ "$pixivflow_exists" != true ]]; then
  note "跳过 ${pixivflow_app} 的机器核对（应用不存在）"
elif [[ -z "$machine_summary" ]]; then
  fail "无法列出 ${pixivflow_app} 的机器"
else
  ok "执行端机器存在（stopped 是正常状态）：$(printf '%s' "$machine_summary" | python3 -c 'import json, sys; print(", ".join(json.load(sys.stdin)["states"]))')"
  # 生命周期契约的运行期一半：进程 exit(0) 后平台不得把它拉回来。Machines API 把
  # fly.toml 的 "never" 规范化成 "no"（源拼写 != 运行期拼写），所以按运行期值判定，
  # 且只读结构化 JSON，不 grep 人类表格。
  bad_policy=$(printf '%s' "$machine_summary" | python3 -c 'import json, sys; print("; ".join(json.load(sys.stdin)["bad"]))')
  if [[ -n "$bad_policy" ]]; then
    fail "执行端机器 restart.policy 不是 no（进程退出后会被平台重新拉起）：${bad_policy}"
  else
    ok "执行端机器 restart.policy = no（进程 exit(0) 后不会被重启）"
  fi
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
# 退出码约定：0 = 已核对一致，2 = 无法核对（缺凭据/无权）→ SKIP，其余 = 真的核对失败。
# 「无法核对」必须与「失败」区分开，否则输出里会出现一行 [FAIL] 而整轮却算通过，
# 逼着人手工解释——那正是这个脚本要消灭的东西。
cf_rc=0
python3 "$repo_dir/scripts/cf-clock-readonly.py" "$worker_name" || cf_rc=$?
case "$cf_rc" in
  0) ;;
  2) note "跳过 Cloudflare 时钟核对（缺只读凭据或凭据无权）" ;;
  *) failures=$((failures + 1)) ;;
esac

echo
if [[ $failures -gt 0 ]]; then
  echo "生产校验未通过：${failures} 项不合格。"
  exit 1
fi
echo "生产校验通过（SKIP 项需要凭据，不代表已验证）。"
