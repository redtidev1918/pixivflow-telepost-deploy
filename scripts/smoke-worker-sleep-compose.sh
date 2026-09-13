#!/usr/bin/env bash
# worker-sleep 的 compose 集成冒烟：从**宿主机**经发布出来的端口打通整条链路。
#
# 它验证的是网络可达性，而不是「模型看起来对」：
#
#   宿主 127.0.0.1:8090  ->  supervisor（容器网络内 0.0.0.0:8090）
#                        ->  鉴权通过才 spawn
#                        ->  转发到 executor 子进程（容器内 127.0.0.1:8091，永不发布）
#
# 所以断言全部从宿主机发请求，绝不用 `docker compose exec ... curl localhost` 代替——
# 那只能证明容器内部能连上自己，恰恰是本次要修的 bug 所掩盖的那种假通过。
#
# 需要：docker + docker compose。executor 用容器内自带的 node 起一个最小假实现，
# 因此不需要任何凭据、不访问 Pixiv、不碰 Telegram。
#
# 唯一用到 `compose exec` 的地方是**数进程**（判断有没有被拉起），不是判断网络是否可达：
# 可达性的每一条断言都从宿主机发请求。
#
# 用法：./scripts/smoke-worker-sleep-compose.sh
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || exit 1

COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.worker-sleep.yml)
TEST_IMAGE="${WORKER_SLEEP_SMOKE_IMAGE:-$(grep -m1 '^ARG PIXIVFLOW_IMAGE=' docker/worker-sleep.Dockerfile | cut -d= -f2)}"
HOST_PORT="${WORKER_SLEEP_SMOKE_PORT:-18090}"
TOKEN="smoke-$(date +%s)-token"
PROJECT="worker-sleep-smoke"
ENV_FILE="$(mktemp -t worker-sleep-smoke-env.XXXXXX)"

pass=0
fail=0
ok()   { printf '  \033[1;32m✓\033[0m %s\n' "$1"; pass=$((pass + 1)); }
bad()  { printf '  \033[1;31m✗\033[0m %s\n' "$1"; fail=$((fail + 1)); }
info() { printf '  \033[36m▸\033[0m %s\n' "$1"; }

# 由下面的 EXIT trap 调用：shellcheck 看不到间接调用，于是既报「函数从未被调用」(SC2329)
# 也把函数体当成不可达代码 (SC2317)。两个都禁用，仅限这个函数。
# shellcheck disable=SC2329,SC2317
cleanup() {
  info "清理冒烟资源"
  "${COMPOSE[@]}" --project-name "$PROJECT" --env-file "$ENV_FILE" down -v --remove-orphans >/dev/null 2>&1 || true
  rm -f "$ENV_FILE"
}
trap cleanup EXIT

if ! command -v curl >/dev/null; then
  echo "[SKIP] curl 不可用，无法从宿主机发请求"
  exit 0
fi
if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
  echo "[SKIP] docker compose 不可用，无法运行 compose 冒烟"
  exit 0
fi
if ! docker info >/dev/null 2>&1; then
  echo "[SKIP] docker daemon 未运行，无法运行 compose 冒烟"
  exit 0
fi

# 冒烟用的环境：只给最小必需项。executor 换成「容器内 node 起的最小假实现」，单条命令，
# 因此 supervisor 的 `sh -c "exec <cmd>"` 能直接 exec 它，不需要真实 PixivFlow 与凭据。
cat > "$ENV_FILE" <<EOF
TZ=UTC
PIXIVFLOW_IMAGE=${TEST_IMAGE}
WORKER_SLEEP_IMAGE=${TEST_IMAGE}
TELEPOST_IMAGE=busybox:1.36
BOT1_TOKEN=smoke-not-a-real-token
BOT1_CHANNEL_ID=-100000000
BOT1_OWNER_ID=1
BOT1_REVIEW_CHAT_ID=-100000001
TELEPOST_BOT1_SUBMIT_TOKEN=smoke-submit-token
PIXIV_REFRESH_TOKEN=smoke-not-a-real-refresh-token
SCHEDULER_TRIGGER_TOKEN=${TOKEN}
WORKER_SLEEP_TRIGGER_PORT=${HOST_PORT}
SUPERVISOR_CHILD_CMD=node -e "require('http').createServer((q,s)=>{if(q.method!=='POST'){s.writeHead(404);return s.end()}s.writeHead(202,{'content-type':'application/json'});s.end(JSON.stringify({disposition:'accepted'}))}).listen(8091,'127.0.0.1')"
EOF

echo "▸ 启动 worker-sleep 拓扑（项目 ${PROJECT}，宿主端口 127.0.0.1:${HOST_PORT}）"
# telepost 在冒烟里用 busybox 顶替：本脚本只验证触发链路，不启动真实业务端。
# --no-deps：本脚本只验证触发链路，不启动真实业务端；否则 compose 会等一个不会 healthy
# 的占位 telepost。executor 在这次冒烟里由容器内的假实现顶替，不解析 telepost 服务名。
if ! "${COMPOSE[@]}" --project-name "$PROJECT" --env-file "$ENV_FILE" up -d --no-deps pixivflow >/dev/null 2>&1; then
  echo "  [FAIL] 无法启动 pixivflow 服务"
  "${COMPOSE[@]}" --project-name "$PROJECT" --env-file "$ENV_FILE" logs pixivflow 2>&1 | tail -20
  exit 1
fi

BASE="http://127.0.0.1:${HOST_PORT}"
# 只从宿主机发请求；curl 必须绕过任何本地代理，否则测的是代理不是拓扑。
http() { curl -s --noproxy '*' -o /dev/null -w '%{http_code}' "$@"; }
body() { curl -s --noproxy '*' "$@"; }

echo "▸ 等待 supervisor 在宿主机端口上可响应"
ready=0
for _ in $(seq 1 60); do
  [[ "$(http "${BASE}/healthz")" == "200" ]] && { ready=1; break; }
  sleep 1
done
if [[ $ready == 1 ]]; then ok "宿主 -> 127.0.0.1:${HOST_PORT}/healthz 返回 200"; else bad "宿主无法访问 127.0.0.1:${HOST_PORT}/healthz（发布或监听地址不对）"; fi

# 数 executor 子进程。基础镜像是 slim，没有 ps/procps，所以直接读 /proc；
# 标记用 createServer（计数脚本自己的 cmdline 里不出现它，不会被数进去）。
children() {
  # shellcheck disable=SC2016  # 这段由容器内的 sh 展开，不属于宿主 shell
  "${COMPOSE[@]}" --project-name "$PROJECT" --env-file "$ENV_FILE" exec -T pixivflow sh -c '
    n=0
    for f in /proc/[0-9]*/cmdline; do
      grep -qa "createServer" "$f" 2>/dev/null && n=$((n + 1))
    done
    echo "$n"' 2>/dev/null | tr -d "[:space:]"
}

info "executor 子进程数（触发前）：$(children)"

# 1) 探测不得拉起进程
body "${BASE}/healthz" >/dev/null
if [[ "$(children)" == "0" ]]; then ok "/healthz 之后 executor 仍不存在（探测不会 spawn）"; else bad "/healthz 之后出现了 executor 子进程"; fi

# 2) GET 探测必须 404，且不 spawn（只注册 POST）
if [[ "$(http "${BASE}/internal/schedules/abc/run")" == "404" ]]; then ok "GET 探测返回 404（不暴露鉴权状态，也不 spawn）"; else bad "GET 探测的响应不是 404"; fi
if [[ "$(children)" == "0" ]]; then ok "GET 探测之后 executor 仍不存在"; else bad "GET 探测拉起了 executor"; fi

# 3) 错误 token 必须 401，且不 spawn
code=$(http -X POST -H "Authorization: Bearer wrong-token" -H 'content-type: application/json' -d '{"label":"smoke"}' "${BASE}/internal/schedules/abc/run")
if [[ "$code" == "401" ]]; then ok "错误 token 返回 401"; else bad "错误 token 返回 ${code}，期望 401"; fi
if [[ "$(children)" == "0" ]]; then ok "错误 token 之后 executor 仍不存在"; else bad "错误 token 拉起了 executor"; fi

# 4) 正确 token：拉起**一个** executor，并转发拿到子进程的应答
code=$(http -X POST -H "Authorization: Bearer ${TOKEN}" -H 'content-type: application/json' -d '{"label":"smoke"}' "${BASE}/internal/schedules/abc/run")
if [[ "$code" == "202" ]]; then ok "宿主机经 8090 触发得到 202（转发到子进程的应答）"; else bad "触发返回 ${code}，期望 202"; fi
count=$(children)
if [[ "$count" == "1" ]]; then ok "恰好一个 executor 子进程"; else bad "executor 子进程数 ${count}，期望 1"; fi

# 5) 第二次触发：仍是同一个 executor，不产生第二个
code=$(http -X POST -H "Authorization: Bearer ${TOKEN}" -H 'content-type: application/json' -d '{"label":"smoke"}' "${BASE}/internal/schedules/abc/run")
if [[ "$code" == "202" ]]; then ok "第二次触发同样得到 202"; else bad "第二次触发返回 ${code}"; fi
count=$(children)
if [[ "$count" == "1" ]]; then ok "第二次触发没有产生第二个 executor（SI-4）"; else bad "executor 子进程数 ${count}，期望 1"; fi

# 6) 子进程端口不能被发布到宿主机
if [[ "$(http "http://127.0.0.1:8091/healthz")" != "200" ]]; then ok "宿主 8091 不可达（子进程端口未发布）"; else bad "宿主 8091 可达——子进程端口被发布了"; fi

# 7) 反代路径之外的路径不得触发 spawn
code=$(http -X POST -H "Authorization: Bearer ${TOKEN}" "${BASE}/api/whatever")
if [[ "$code" == "404" ]]; then ok "非触发路径返回 404"; else bad "非触发路径返回 ${code}，期望 404"; fi

echo
if [[ $fail == 0 ]]; then
  echo "compose 冒烟通过：${pass} 项"
  exit 0
fi
echo "compose 冒烟失败：${pass} 项通过 / ${fail} 项失败"
"${COMPOSE[@]}" --project-name "$PROJECT" --env-file "$ENV_FILE" logs pixivflow 2>&1 | tail -30
exit 1
