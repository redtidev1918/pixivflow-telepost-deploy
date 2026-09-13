# worker-sleep 端到端验收（512 MiB）

> **本页是一次性验收的可执行清单，不是运维日常。** 它对应
> [`single-machine-worker-sleep`](../architectures/single-machine-worker-sleep.md) 晋级到
> `implemented=true` / `support=beta` 之前的最后一步。没有跑完它就不要改矩阵里的状态字段。

## 一键入口

在一次性 512 MiB 测试主机上，准备好 `data/acceptance.env` 与已启用且到期的 schedule 之后：

```bash
./scripts/accept-worker-sleep.sh
```

它自己完成：preflight（Docker、整机内存 ≈512 MiB、swap 关闭、真实测试凭据形态、enabled schedule）
→ 启动拓扑 → idle 基线采样 → 第一轮真实 trigger → 等 executor 按账本退出 → 退出后探测 → 第二轮
→ 收集 RSS / `memory.events` / RestartCount / orphan → 判定 → 写 `acceptance-report.json`。

```text
退出码 0 = PASS   1 = FAIL   3 = BLOCKED
```

**BLOCKED 不等于通过。** 缺 Docker、机器不是 ≈512 MiB、swap 没关、凭据仍是占位值、没有 enabled
的 schedule，任一发生就 BLOCKED：不做任何测量、断言列表为空、报告里逐条写明原因。
`PASS` 需要所有断言在真实两轮里成立。

下面是人读的清单，方便在 FAIL 时定位；一键脚本就是它的可执行版本。

## 为什么必须真机跑

CI 能证明的东西到此为止：单元测试证明 supervisor 的信令、白名单、单实例与端口分工；
`validate.sh` 证明合并后的 compose 模型正确（发布面、健康检查被禁用、端口分工）；
`go test` 里的可达性测试证明「绑 0.0.0.0 才可达、绑回环不可达」。
**它们都证明不了「512 MiB 真的够」以及「真实任务跑完之后 executor 会不会自己退出」。**
那两件事只有在真实机器上跑真实负载才能知道。

## 硬性前提

| 项目 | 要求 |
| --- | --- |
| 机器预算 | **真实总内存 512 MiB**（不是给某个容器写一个 512m limit 的假象） |
| swap | **关闭**（`swapoff -a`），否则内存压力被 swap 掩盖，测不出真实峰 |
| 隔离 | 专用的一次性主机/VM；**不得**是生产 Fly App、不得动生产 Machine 与 schedule |
| 凭据 | 优先 test bot / test review chat；**不得**用生产频道做发布实验 |
| 清理 | 验收结束删除临时资源；不留下长期计费的实例 |

## 记录方法（脚本已自动采集，这里是口径）

在被测主机上按 1s 采样，直到两轮跑完：

```bash
# 总可用内存
while :; do
  printf '%s MemAvailable=%s\n' "$(date -Is)" "$(awk '/MemAvailable/{print $2}' /proc/meminfo)"
  sleep 1
done >> /tmp/accept-mem.log

# 每个常驻进程的 RSS；executor 出现/消失都要能看到
while :; do
  printf '%s ' "$(date -Is)"
  for f in /proc/[0-9]*/status; do
    name=$(awk '/^Name:/{print $2}' "$f")
    rss=$(awk '/^VmRSS:/{print $2}' "$f")
    case "$name" in
      python3|node|pixivflow-supervisor) printf '%s=%sKiB ' "$name" "$rss" ;;
    esac
  done
  echo
  sleep 1
done >> /tmp/accept-rss.log

# cgroup OOM 计数与容器重启次数（容器内跑时）
cat /sys/fs/cgroup/memory.events 2>/dev/null
docker inspect --format '{{.RestartCount}} {{.State.OOMKilled}}' <container>
```

需要填进验收记录的量：

```text
host MemAvailable（基线 / 峰值 / 回落值）
telepost RSS（基线 / 峰值）
supervisor RSS（基线 / 峰值）
executor RSS（峰值）
combined peak RSS（全部角色之和的峰值）
cgroup OOM 计数（必须为 0）
容器 RestartCount 与 OOMKilled（必须为 0 / false）
```

**记录实测值，不要用「理论上 512 MiB 够」代替。**

## 部署

```bash
# 1) 卷：两个角色共享一个物理卷，命名空间互不相交（SI-7）
mkdir -p ./data/bot1 ./data/pixivflow

# 2) 业务端（上游 TelePost 镜像，不改）
#    先用 polling 或 test bot 的 webhook，确认私聊投稿可用

# 3) 执行侧：worker-sleep 覆盖层
WORKER_SLEEP_IMAGE=<执行侧镜像> \
docker compose -f docker-compose.yml -f docker-compose.worker-sleep.yml up -d

# 4) 宿主时钟：一条 cron 或 systemd timer，POST 到宿主 loopback
#    curl --noproxy '*' -X POST -H "Authorization: Bearer $SCHEDULER_TRIGGER_TOKEN" \
#         -H 'content-type: application/json' -d '{"label":"accept"}' \
#         http://127.0.0.1:8090/internal/schedules/<scheduleId>/run
```

## 两轮流程

```text
idle -> trigger -> executor spawn -> 真实 Pixiv 查询/下载
     -> 真实提交到 TelePost review queue -> ledger/outbox 清空
     -> executor exit -> idle -> 第二次 trigger -> 第二次干净 spawn/exit
```

轮次之间不要重启容器、不要重启机器：第二轮的意义就是证明**同一台常驻机器上可以再拉起一次**。

## 必须逐条证明的断言

| # | 断言 | 判定方式 |
| --- | --- | --- |
| 1 | idle 时没有 executor 子进程 | `/proc` 里没有 executor 命令行 |
| 2 | TelePost 全程存活且可响应 | 期间多次私聊/健康检查均成功 |
| 3 | 正确 trigger 只 spawn 一个 executor | 子进程数 = 1 |
| 4 | 同时第二个 trigger 不产生第二个 executor | 并发触发后子进程数仍 = 1（SI-4） |
| 5 | 错 token 不 spawn | 401 且子进程数不变 |
| 6 | `/healthz` 不 spawn | 200 且子进程数不变 |
| 7 | executor 能通过 `http://telepost:8080` 完成真实投稿 | review queue 里出现该投稿 |
| 8 | executor 按自己的 ledger 正常退出 | 进程消失，日志是正常收工而非信号 |
| 9 | supervisor 不做 idle kill | 下载中/批次未完成时进程不被杀 |
| 10 | executor 退出后机器与两个容器都还在跑 | `up` 状态、RestartCount 不变 |
| 11 | probe 不会把 executor 重新拉起 | 退出后再打触发端口做探测，进程不出现 |
| 12 | 第二轮能重新正常 spawn/exit | 与第一轮同样成立 |
| 13 | 无 OOM kill | cgroup `memory.events` 的 `oom_kill` = 0 |
| 14 | 无容器异常 restart | RestartCount = 0 |
| 15 | 无 orphan 进程 | executor 退出后没有残留 node/ffmpeg |
| 16 | 退出后内存明显回落到常驻基线 | MemAvailable 回到 idle 基线的接近值 |

## 如果 512 MiB 下真的 OOM

**不要放宽验收条件，也不要偷偷把机器内存调大。** 先定位是哪一层吃掉的：

| 怀疑层 | 怎么确认 |
| --- | --- |
| TelePost 基线 | idle 时的 python3 RSS |
| Node/V8 heap | executor 的 `--max-old-space-size` 与实际 heap 使用 |
| 原生命令行缓冲 | node 进程的 map、图片解码路径 |
| 图片解码 | 单张大图的峰值 RSS 增量 |
| ffmpeg（ugoira 动图） | 是否只在动图任务上 OOM |
| 相册并发 | `download.concurrency`、审核相册打包并发 |

然后从**并发 / 流式处理 / heap 预算**三处改，而不是加内存。改完之后重跑上面两轮。

## 通过之后才允许做的事

```text
presets.single-machine-worker-sleep.status.implemented: false -> true
presets.single-machine-worker-sleep.status.support:     experimental -> beta
presets.single-machine-worker-sleep.platformStatus.docker-compose.status: beta（并写明验收日期与峰值）
```

**不要**写 `productionProven`：它只在真实生产负载跑过之后才写。
`systemd` 与 `flyio` 保持 `planned`，它们不阻塞这次晋级。
