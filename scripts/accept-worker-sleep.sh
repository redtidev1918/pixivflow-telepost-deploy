#!/usr/bin/env bash
# worker-sleep 的 512 MiB 真机验收：一条命令跑完两轮真实负载。
#
# 它回答的问题只有一个：**这套机制在真实的 512 MiB 机器上到底成不成立**
# （TelePost 常驻 + supervisor 常驻 + PixivFlow 按需 spawn + 真实媒体峰值 + 退出后回落）。
#
# 用法：
#   ./scripts/accept-worker-sleep.sh
#
# 它绝不做的事：
#   * 不伪造 PASS。缺 Docker、缺 512 MiB、缺真实测试凭据、没有 enabled 的 schedule，
#     一律 BLOCKED 并以退出码 3 结束，且在报告里写明原因。
#   * 不碰生产 Fly。只用 docker compose、独立 project name、临时采样目录。
#   * 不为了让结果好看而放宽判定。断言失败就是 FAIL。
#
# 退出码：0 = PASS，1 = FAIL，3 = BLOCKED。
#
# 需要在被测主机准备一份 env 文件（默认 ./data/acceptance.env）：
#   PIXIV_REFRESH_TOKEN / BOT1_TOKEN / BOT1_CHANNEL_ID / BOT1_OWNER_ID /
#   BOT1_REVIEW_CHAT_ID / TELEPOST_BOT1_SUBMIT_TOKEN / SCHEDULER_TRIGGER_TOKEN /
#   ACCEPT_SCHEDULE_ID
# 并且 ./data/pixivflow/config.json 里该 schedule 处于 enabled、其 occurrence 在触发时到期。
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || exit 1

ACCEPT_ENV="${ACCEPT_ENV:-data/acceptance.env}"
REPORT="${ACCEPT_REPORT:-acceptance-report.json}"
PROJECT="${ACCEPT_PROJECT:-worker-sleep-acceptance}"
HOST_TRIGGER_PORT="${ACCEPT_HOST_PORT:-8090}"
HOST_TELEPOST_PORT="${ACCEPT_TELEPOST_PORT:-8080}"
MEM_TOLERANCE_MIB="${ACCEPT_MEM_TOLERANCE_MIB:-64}"
MIN_WORK_SECONDS="${ACCEPT_MIN_WORK_SECONDS:-60}"
ROUND_TIMEOUT="${ACCEPT_ROUND_TIMEOUT:-2700}"
IDLE_SECONDS="${ACCEPT_IDLE_SECONDS:-60}"

COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.worker-sleep.yml
         --project-name "$PROJECT" --env-file "$ACCEPT_ENV")

WORK="$(mktemp -d -t worker-sleep-acceptance.XXXXXX)"
SAMPLES="$WORK/samples.csv"
SETUP_LOG="$WORK/compose-up.log"
BLOCKERS=()
ASSERTIONS=()
ROUNDS_JSON="[]"
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
SAMPLER_PID=""

say()   { printf '\033[36m▸\033[0m %s\n' "$*"; }
ok()    { printf '  \033[1;32m✓\033[0m %s\n' "$*"; }
no()    { printf '  \033[1;31m✗\033[0m %s\n' "$*"; }
warn()  { printf '  \033[1;33m!\033[0m %s\n' "$*"; }
block() { BLOCKERS+=("$1"); printf '  \033[1;33m⊘\033[0m %s\n' "$1"; }
json_str() { python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$1"; }

assert() { # assert <id> <ok:0|1> <detail>
  local id="$1" result="$2" detail="$3"
  ASSERTIONS+=("{\"id\":\"$id\",\"ok\":$([[ $result == 0 ]] && echo true || echo false),\"detail\":$(json_str "$detail")}")
  if [[ $result == 0 ]]; then ok "$id — $detail"; else no "$id — $detail"; fi
}

# 由 EXIT trap 调用；shellcheck 的指令必须放在函数定义之前，否则报 SC1123。
# shellcheck disable=SC2329,SC2317
cleanup() {
  say "清理验收资源（只清本项目，不动任何生产资源）"
  [[ -n "$SAMPLER_PID" ]] && kill "$SAMPLER_PID" 2>/dev/null
  if command -v docker >/dev/null 2>&1; then
    "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

write_report() { # write_report <verdict>
  local verdict="$1"
  if (( ${#ASSERTIONS[@]} > 0 )); then
    printf '[%s]' "$(IFS=,; echo "${ASSERTIONS[*]}")" > "$WORK/assertions.json"
  else
    echo '[]' > "$WORK/assertions.json"
  fi
  if (( ${#BLOCKERS[@]} > 0 )); then
    printf '%s\n' "${BLOCKERS[@]}" | python3 -c 'import json,sys; print(json.dumps([l for l in sys.stdin.read().splitlines() if l]))' > "$WORK/blockers.json"
  else
    echo '[]' > "$WORK/blockers.json"
  fi
  python3 - "$REPORT" "$verdict" "$STARTED_AT" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$WORK/blockers.json" "$WORK/assertions.json" "$ROUNDS_JSON" "$ACCEPT_ENV" <<'PY'
import json, sys
path, verdict, started, finished, blockers_f, assertions_f, rounds, env_file = sys.argv[1:9]
def load(path, fallback):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return fallback
report = {
    "schemaVersion": 1,
    "preset": "single-machine-worker-sleep",
    "platform": "docker-compose",
    "verdict": verdict,
    "startedAt": started,
    "finishedAt": finished,
    "envFile": env_file,
    "blockers": load(blockers_f, []),
    "assertions": load(assertions_f, []),
    "rounds": json.loads(rounds or "[]"),
    "note": ("BLOCKED means the prerequisites were not met (no Docker, not a ~512 MiB host, no "
             "real test credentials, or no enabled schedule); nothing was measured and nothing is "
             "claimed. PASS requires every assertion to hold on a real two-round run."),
}
with open(path, "w", encoding="utf-8") as fh:
    json.dump(report, fh, ensure_ascii=False, indent=2)
    fh.write("\n")
print(f"report written: {path} verdict={verdict}")
PY
}

# ---------------------------------------------------------------------------
# preflight —— 任一不满足即 BLOCKED，绝不模拟通过
# ---------------------------------------------------------------------------
say "preflight"

if [[ ! -f "$ACCEPT_ENV" ]]; then
  block "缺少验收 env 文件 ${ACCEPT_ENV}（需要真实测试凭据与 ACCEPT_SCHEDULE_ID）"
fi

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  ok "docker 可用且 daemon 在运行"
else
  block "docker 不可用或 daemon 未运行：无法做真实验收"
fi

mem_total_mib=0
swap_total_mib=0
if [[ -r /proc/meminfo ]]; then
  mem_total_mib=$(( $(awk '/^MemTotal:/{print $2}' /proc/meminfo) / 1024 ))
  swap_total_mib=$(( $(awk '/^SwapTotal:/{print $2}' /proc/meminfo) / 1024 ))
  if (( mem_total_mib >= 512 - MEM_TOLERANCE_MIB && mem_total_mib <= 512 + MEM_TOLERANCE_MIB )); then
    ok "整机内存 ${mem_total_mib} MiB（≈512 MiB）"
  else
    block "整机内存 ${mem_total_mib} MiB 不是 ≈512 MiB（容差 ±${MEM_TOLERANCE_MIB}）：512 MiB 必须是整机预算，不是某个容器的 limit"
  fi
  if (( swap_total_mib == 0 )); then
    ok "swap 已关闭"
  else
    block "swap 为 ${swap_total_mib} MiB：swap 会掩盖真实内存压力，请先 swapoff -a"
  fi
else
  block "读不到 /proc/meminfo：无法证明这是 512 MiB 的 Linux 主机"
fi

if [[ -f "$ACCEPT_ENV" ]]; then
  # 这是运维自己的文件：这里 source 它只为校验形态，任何值都不打印。
  set -a
  # shellcheck disable=SC1090  # 文件名来自环境变量，这是有意的
  . "$ACCEPT_ENV"
  set +a
  cred_problems=""
  [[ "${ACCEPT_SCHEDULE_ID:-}" =~ ^[A-Za-z0-9._-]+$ ]] || cred_problems+=" ACCEPT_SCHEDULE_ID 缺失或非法;"
  [[ "${SCHEDULER_TRIGGER_TOKEN:-}" =~ [A-Za-z0-9]{16,} ]] || cred_problems+=" SCHEDULER_TRIGGER_TOKEN 太短/缺失;"
  [[ "${BOT1_TOKEN:-}" =~ ^[0-9]{6,}:[A-Za-z0-9_-]{30,}$ ]] || cred_problems+=" BOT1_TOKEN 不是真实 Bot token 形态;"
  [[ "${BOT1_REVIEW_CHAT_ID:-}" =~ ^-?[0-9]+$ ]] || cred_problems+=" BOT1_REVIEW_CHAT_ID 缺失;"
  [[ "${BOT1_CHANNEL_ID:-}" =~ ^-?[0-9]+$ ]] || cred_problems+=" BOT1_CHANNEL_ID 缺失;"
  [[ "${TELEPOST_BOT1_SUBMIT_TOKEN:-}" =~ [A-Za-z0-9]{16,} ]] || cred_problems+=" TELEPOST_BOT1_SUBMIT_TOKEN 太短/缺失;"
  [[ "${PIXIV_REFRESH_TOKEN:-}" =~ [A-Za-z0-9_-]{40,} ]] || cred_problems+=" PIXIV_REFRESH_TOKEN 太短/缺失（可能仍是占位值）;"
  if [[ -z "$cred_problems" ]]; then ok "测试凭据形态检查通过"; else block "测试凭据不满足：$cred_problems"; fi
fi

if [[ -f data/pixivflow/config.json ]]; then
  if python3 -c '
import json,sys
cfg=json.load(open("data/pixivflow/config.json"))
sched=cfg.get("schedules") or []
def on(s):
    v=s.get("enabled")
    return v is True or str(v).lower() in ("true","1")
sys.exit(0 if any(on(s) for s in sched) else 1)'; then
    ok "data/pixivflow/config.json 里存在 enabled 的 schedule"
  else
    block "data/pixivflow/config.json 里没有 enabled 的 schedule：触发器不会产生真实工作"
  fi
else
  block "缺少 data/pixivflow/config.json（PixivFlow 的运行配置）"
fi

if (( ${#BLOCKERS[@]} > 0 )); then
  echo
  warn "验收 BLOCKED：前置条件未满足，未做任何测量，也没有模拟通过。"
  write_report "BLOCKED"
  exit 3
fi

# ---------------------------------------------------------------------------
# 采样（全部走 /proc 与 docker stats，不猜进程名）
# ---------------------------------------------------------------------------
container_exec() { "${COMPOSE[@]}" exec -T pixivflow sh -c "$1" 2>/dev/null; }

# 数 executor 子进程：模式在容器内拼接，避免把模式字面量写进自身 cmdline 被自数。
container_children() {
  # shellcheck disable=SC2016  # 这段由容器内的 sh 执行
  container_exec '
    M="dist/index.js"; S="scheduler"; pat="$M $S"; n=0
    for f in /proc/[0-9]*/cmdline; do
      tr "\0" " " < "$f" 2>/dev/null | grep -qF "$pat" && n=$((n+1))
    done
    echo "$n"' | tr -d '[:space:]'
}

# supervisor 常驻进程 RSS（MiB）。基础镜像没有 ps，直接读 /proc。
supervisor_rss_mib() {
  # shellcheck disable=SC2016  # 这段由容器内的 sh 执行
  container_exec '
    n=0
    for d in /proc/[0-9]*; do
      tr "\0" " " < "$d/cmdline" 2>/dev/null | grep -qF "pixivflow-supervisor" || continue
      rss=$(awk "/^VmRSS:/{print \$2}" "$d/status" 2>/dev/null)
      n=$((n + ${rss:-0}))
    done
    echo $((n / 1024))' | tr -d '[:space:]'
}

# executor 子进程 RSS（MiB）
executor_rss_mib() {
  # shellcheck disable=SC2016  # 这段由容器内的 sh 执行
  container_exec '
    M="dist/index.js"; S="scheduler"; pat="$M $S"; n=0
    for d in /proc/[0-9]*; do
      tr "\0" " " < "$d/cmdline" 2>/dev/null | grep -qF "$pat" || continue
      rss=$(awk "/^VmRSS:/{print \$2}" "$d/status" 2>/dev/null)
      n=$((n + ${rss:-0}))
    done
    echo $((n / 1024))' | tr -d '[:space:]'
}

# 两个容器的整机占用由 docker stats 给（按容器计，不猜进程名）。
container_mem_mib() { # container_mem_mib <service>
  local name
  name=$(docker ps --filter "label=com.docker.compose.project=$PROJECT" \
                    --filter "label=com.docker.compose.service=$1" --format '{{.Names}}' 2>/dev/null | head -1)
  [[ -n "$name" ]] || { echo 0; return; }
  docker stats --no-stream --format '{{.MemUsage}}' "$name" 2>/dev/null | head -1 \
    | python3 -c '
import re, sys
raw = sys.stdin.read().strip().split("/")[0].strip()
m = re.match(r"^([0-9.]+)\s*([KMG]i?B)?$", raw)
if not m:
    print(0); raise SystemExit
value, unit = float(m.group(1)), (m.group(2) or "B")
factor = {"B": 1/1048576, "KiB": 1/1024, "MiB": 1, "GiB": 1024, "KB": 1/1000, "MB": 1, "GB": 1000}
print(int(value * factor.get(unit, 1)))'
}

sample_once() {
  local avail tele supervisor executor
  avail=$(awk '/^MemAvailable:/{print int($2/1024)}' /proc/meminfo 2>/dev/null)
  tele=$(container_mem_mib telepost)
  supervisor=$(supervisor_rss_mib)
  executor=$(executor_rss_mib)
  printf '%s,%s,%s,%s,%s\n' "$(date +%s)" "${avail:-0}" "${tele:-0}" "${supervisor:-0}" "${executor:-0}" >> "$SAMPLES"
}

# ---------------------------------------------------------------------------
# 启动与两轮
# ---------------------------------------------------------------------------
say "启动 worker-sleep 拓扑（项目 ${PROJECT}，宿主触发端口 127.0.0.1:${HOST_TRIGGER_PORT}）"
if ! "${COMPOSE[@]}" up -d >"$SETUP_LOG" 2>&1; then
  warn "compose up 失败"
  tail -20 "$SETUP_LOG"
  write_report "FAIL"
  exit 1
fi

BASE="http://127.0.0.1:${HOST_TRIGGER_PORT}"
TELEPOST="http://127.0.0.1:${HOST_TELEPOST_PORT}"
http() { curl -s --noproxy '*' -o /dev/null -w '%{http_code}' "$@"; }
trigger() {
  curl -s --noproxy '*' -o /dev/null -w '%{http_code}' -X POST \
    -H "Authorization: Bearer ${SCHEDULER_TRIGGER_TOKEN}" \
    -H 'content-type: application/json' -d '{"label":"acceptance"}' \
    "${BASE}/internal/schedules/${ACCEPT_SCHEDULE_ID}/run"
}

say "等待业务端与 supervisor 就绪"
tele_ready=0
for _ in $(seq 1 120); do [[ "$(http "${TELEPOST}/health")" == "200" ]] && { tele_ready=1; break; }; sleep 2; done
sup_ready=0
for _ in $(seq 1 60); do [[ "$(http "${BASE}/healthz")" == "200" ]] && { sup_ready=1; break; }; sleep 1; done

printf 'ts,mem_available_mib,telepost_mib,supervisor_mib,executor_mib\n' > "$SAMPLES"
sample_once
( while :; do sample_once; sleep 2; done ) &
SAMPLER_PID=$!

say "采集 idle 基线（${IDLE_SECONDS}s）"
sleep "$IDLE_SECONDS"

assert "telepost-alive-idle" "$([[ $tele_ready == 1 ]] && echo 0 || echo 1)" "业务端 idle 期可响应"
assert "supervisor-alive-idle" "$([[ $sup_ready == 1 ]] && echo 0 || echo 1)" "supervisor idle 期可响应"
idle_children=$(container_children)
assert "idle-no-executor-process" "$([[ "$idle_children" == "0" ]] && echo 0 || echo 1)" "idle 时 executor 子进程数=$idle_children"

probe_code=$(http "${BASE}/internal/schedules/${ACCEPT_SCHEDULE_ID}/run")
assert "get-probe-404" "$([[ "$probe_code" == "404" ]] && echo 0 || echo 1)" "GET 探测返回 $probe_code"
bad_code=$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer wrong" \
  -H 'content-type: application/json' -d '{}' "${BASE}/internal/schedules/${ACCEPT_SCHEDULE_ID}/run")
assert "wrong-token-401" "$([[ "$bad_code" == "401" ]] && echo 0 || echo 1)" "错误 token 返回 $bad_code"
healthz_code=$(http "${BASE}/healthz")
assert "healthz-200" "$([[ "$healthz_code" == "200" ]] && echo 0 || echo 1)" "/healthz 返回 $healthz_code"
after_probes=$(container_children)
assert "probes-do-not-spawn" "$([[ "$after_probes" == "0" ]] && echo 0 || echo 1)" "探测与未鉴权请求之后 executor 仍不存在（子进程数=${after_probes}）"

await_children() { # await_children <want> <timeout_s> -> 打印等待秒数
  local want="$1" timeout="$2" waited=0
  while (( waited < timeout )); do
    [[ "$(container_children)" == "$want" ]] && { echo "$waited"; return 0; }
    sleep 2; waited=$((waited + 2))
  done
  echo "$waited"; return 1
}

run_round() { # run_round <n>
  local n="$1" t0 t1 lifetime peak_exec spawn_wait code
  say "第 ${n} 轮：真实 trigger"
  t0=$(date +%s)
  code=$(trigger)
  assert "round${n}-trigger-202" "$([[ "$code" == "202" ]] && echo 0 || echo 1)" "触发返回 $code"

  if ! spawn_wait=$(await_children 1 180); then
    assert "round${n}-executor-spawned" 1 "触发后 180s 内没有出现 executor 子进程"
    ROUNDS_JSON=$(python3 -c 'import json,sys; r=json.loads(sys.argv[1]); r.append({"round":int(sys.argv[2]),"spawned":False}); print(json.dumps(r))' "$ROUNDS_JSON" "$n")
    return 1
  fi
  ok "executor 已 spawn（${spawn_wait}s）"
  local right_after; right_after=$(container_children)
  assert "round${n}-single-executor" "$([[ "$right_after" == "1" ]] && echo 0 || echo 1)" "子进程数=${right_after}（SI-4）"

  trigger >/dev/null 2>&1 || true
  sleep 5
  local after_second; after_second=$(container_children)
  assert "round${n}-no-second-executor" "$([[ "$after_second" == "1" ]] && echo 0 || echo 1)" "并发第二次触发后子进程数=$after_second"

  say "第 ${n} 轮：等待 executor 按自己的账本退出（上限 ${ROUND_TIMEOUT}s）"
  while :; do
    local cur; cur=$(executor_rss_mib)
    [[ -n "$cur" ]] && (( cur > peak_exec )) && peak_exec=$cur
    [[ "$(container_children)" == "0" ]] && break
    t1=$(date +%s)
    (( t1 - t0 > ROUND_TIMEOUT )) && break
    sleep 5
  done
  t1=$(date +%s); lifetime=$(( t1 - t0 ))
  local exit_wait; exit_wait=$(await_children 0 60 || true)

  assert "round${n}-did-real-work" "$(( lifetime >= MIN_WORK_SECONDS )) && echo 0 || echo 1" \
    "executor 存活 ${lifetime}s（真实下载+投递应 ≥ ${MIN_WORK_SECONDS}s；过短通常是 schedule 的 occurrence 未到期）"
  assert "round${n}-executor-exited" "$([[ "$(container_children)" == "0" ]] && echo 0 || echo 1)" \
    "executor 已退出（等待 ${exit_wait}s）"

  # supervisor 的日志是「谁结束了 executor」的证据：正常收工 vs 被信号杀死。
  local exit_log; exit_log=$("${COMPOSE[@]}" logs --tail 300 pixivflow 2>/dev/null | grep -F "executor 已退出" | tail -1)
  if [[ "$exit_log" == *"正常 exit(0)"* ]]; then
    assert "round${n}-stopped-by-own-ledger" 0 "supervisor 记录为正常收工"
  else
    assert "round${n}-stopped-by-own-ledger" 1 "supervisor 日志不是正常收工：${exit_log:-<无记录>}"
  fi

  sleep 10
  http "${BASE}/healthz" >/dev/null
  local after_probe_exit; after_probe_exit=$(container_children)
  assert "round${n}-probe-no-resurrect" "$([[ "$after_probe_exit" == "0" ]] && echo 0 || echo 1)" \
    "退出后探测没有把 executor 拉回来（子进程数=${after_probe_exit}）"

  ROUNDS_JSON=$(python3 -c '
import json,sys
r=json.loads(sys.argv[1]); r.append({
  "round": int(sys.argv[2]), "spawned": True, "lifetimeSeconds": int(sys.argv[3]),
  "executorPeakRssMiB": int(sys.argv[4])})
print(json.dumps(r))' "$ROUNDS_JSON" "$n" "$lifetime" "${peak_exec:-0}")
  return 0
}

run_round 1 || true
run_round 2 || true

assert "telepost-alive-after-rounds" "$([[ "$(http "${TELEPOST}/health")" == "200" ]] && echo 0 || echo 1)" \
  "两轮之后业务端仍可响应"

say "等待内存回落到常驻基线（30s）"
sleep 30
kill "$SAMPLER_PID" 2>/dev/null; SAMPLER_PID=""

# ---------------------------------------------------------------------------
# 证据与判定
# ---------------------------------------------------------------------------
summary=$(python3 - "$SAMPLES" <<'PY'
import csv, sys
rows = list(csv.DictReader(open(sys.argv[1], encoding="utf-8")))
def nums(key):
    out = []
    for r in rows:
        try: out.append(int(r[key]))
        except Exception: pass
    return out
avail, tele, sup, exe = nums("mem_available_mib"), nums("telepost_mib"), nums("supervisor_mib"), nums("executor_mib")
combined = []
for r in rows:
    total = 0
    for k in ("telepost_mib", "supervisor_mib", "executor_mib"):
        try: total += int(r[k])
        except Exception: pass
    combined.append(total)
base = avail[0] if avail else 0
last = avail[-1] if avail else 0
print("\t".join(str(x) for x in [
    base, min(avail) if avail else 0, last, base - last,
    max(tele) if tele else 0, max(sup) if sup else 0, max(exe) if exe else 0,
    max(combined) if combined else 0, len(rows)]))
PY
)
IFS=$'\t' read -r base_avail low_avail last_avail fallback tele_peak sup_peak exec_peak combined_peak samples <<<"$summary"
say "内存：idle ${base_avail} MiB → 最低 ${low_avail} MiB → 回落 ${last_avail} MiB（回收 ${fallback} MiB）"
say "峰值：telepost ${tele_peak} MiB ｜ supervisor ${sup_peak} MiB ｜ executor ${exec_peak} MiB ｜ 合计 ${combined_peak} MiB（${samples} 个采样点）"
assert "memory-fell-back-after-exit" "$(( fallback >= 20 )) && echo 0 || echo 1" \
  "executor 退出后回收 ${fallback} MiB（期望明显回落，而不是停在峰值）"

oom_kill=$(awk '/^oom_kill /{print $2}' /sys/fs/cgroup/memory.events 2>/dev/null)
oom_kill=${oom_kill:-unknown}
assert "no-cgroup-oom-kill" "$([[ "$oom_kill" == "0" || "$oom_kill" == "unknown" ]] && echo 0 || echo 1)" \
  "cgroup memory.events oom_kill=${oom_kill}"

restart_bad=0; restart_detail=""
while IFS= read -r cid; do
  [[ -n "$cid" ]] || continue
  line=$(docker inspect --format '{{.Name}} restart={{.RestartCount}} oom={{.State.OOMKilled}}' "$cid" 2>/dev/null)
  restart_detail+="${line}; "
  if [[ "$line" != *"restart=0"* || "$line" != *"oom=false"* ]]; then restart_bad=1; fi
done < <("${COMPOSE[@]}" ps -q 2>/dev/null)
assert "no-container-restart-or-oom" "$restart_bad" "${restart_detail:-<无容器>}"

running=$(docker ps -q --filter "label=com.docker.compose.project=$PROJECT" 2>/dev/null | wc -l | tr -d ' ')
assert "both-containers-still-running" "$([[ "$running" == "2" ]] && echo 0 || echo 1)" \
  "两轮之后仍在运行的容器数=${running}（期望 2：telepost + pixivflow-sleep）"

stray=0
while IFS= read -r cid; do
  [[ -n "$cid" ]] || continue
  n=$(docker exec "$cid" sh -c 'c=0; for f in /proc/[0-9]*/cmdline; do tr "\0" " " < "$f" 2>/dev/null | grep -qF "ffmpeg" && c=$((c+1)); done; echo $c' 2>/dev/null | tr -d '[:space:]')
  stray=$((stray + ${n:-0}))
done < <("${COMPOSE[@]}" ps -q 2>/dev/null)
assert "no-orphan-media-process" "$([[ "$stray" == "0" ]] && echo 0 || echo 1)" "残留 ffmpeg 进程数=${stray}"

final_children=$(container_children)
assert "no-orphan-executor" "$([[ "$final_children" == "0" ]] && echo 0 || echo 1)" "结束时 executor 子进程数=$final_children"

fail_count=$(printf '%s\n' "${ASSERTIONS[@]}" | grep -c '"ok":false')
if (( fail_count == 0 )); then VERDICT="PASS"; else VERDICT="FAIL"; fi

echo
if [[ "$VERDICT" == "PASS" ]]; then
  echo "验收 PASS：${#ASSERTIONS[@]} 条断言全部成立"
else
  echo "验收 FAIL：${fail_count} 条断言不成立"
fi
write_report "$VERDICT"
if [[ "$VERDICT" == "PASS" ]]; then exit 0; else exit 1; fi
