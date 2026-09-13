# `single-machine-worker-sleep` —— 单机 + 执行进程休眠

| | |
| --- | --- |
| 支持等级 | **Experimental** |
| 实现状态 | **仅设计。本仓库没有实现：`implemented=false`、`tested=false`、`productionProven=false`** |
| 平台 | Fly.io（1×512 MiB Machine）、Docker Compose、systemd——均为「按本设计实现后」 |
| 一句话 | 一台机器两个角色：`publisher` 常驻，`executor` 只在有活时作为子进程存在，空闲即退出。机器本身永不停机。 |

机器可读定义见
[`architecture-matrix.json` 的 `presets.single-machine-worker-sleep`](https://github.com/redtidev1918/pixivflow-telepost-deploy/blob/main/docs/reference/architecture-matrix.json)。

> **本页是设计契约，不是使用说明。** 按本文部署之前，先确认矩阵里该 preset 的
> `status.implemented` 已经变成 `true`。现在它还是 `false`。

---

## 适合谁

- 只有一台 512 MiB 机器（Fly Machine 或 VPS），必须同时承载两个角色的人。
- 希望**空闲时内存占用接近只有业务端**，但不想引入外部时钟、Cloudflare Worker、
  第二个卷或跨机私网的人。
- 接受「机器常驻计费」这一前提，只想要内存收益的人。
- 不介意 `executor` 与 `publisher` 同故障域的人。

如果目标是**降低计算账单**，这个 preset 帮不上忙，去看 [`split-worker`](split-worker.md)。

---

## 拓扑

```text
Machine (always on)
│
├─ 容器 telepost（上游 TelePost 镜像，本 preset 不改它）   always-on
│    ├─ publisher                                       always-on
│    ├─ telegram-ingress                                always-on
│    └─ clock(internal)                                 always-on / 极小
│
├─ 容器 pixivflow-sleep（本仓库镜像 docker/worker-sleep.Dockerfile）  always-on
│    └─ supervisor（本仓库 supervisor/）                 always-on
│         └─ executor 子进程                             无任务 → 进程不存在
│                                                        有任务 → spawn
│                                                        任务完成 + grace → exit
│
└─ 一个物理卷，两个互不相交的角色命名空间（SI-7）
     ├─ data/bot{N}/             每 Bot SQLite、runtime-policy.json
     └─ data/pixivflow/          pixivflow.db、下载缓存、outbox
```

**两个常驻容器，一个按需子进程。** 机器上没有任何东西会停止；`executor` 不是容器，而是常驻
supervisor 拉起的子进程。业务侧仍是未经修改的上游 TelePost 镜像。

**进程编排属于部署层，不属于 TelePost。** 负责 spawn executor 的是本仓库的 `supervisor/`
组件（Go，仅标准库），不是 TelePost 的功能——业务仓库不实现部署编排，部署仓库不实现业务。

两个 Bot 共享同一个常驻 `publisher`，因此 Bot 数量增加时只增加 `publisher` 侧的 Python
子进程数，不增加机器数。

`executor` 与 `publisher` 经 `loopback-http` 通信，不经过任何代理、overlay 或公网。

---

## 资源要求

| 项目 | 要求 |
| --- | --- |
| 机器 | 1 台，512 MiB 是设计目标；`256m` 档不支持同时承载两个角色 |
| `publisher` | 空闲约 170 MiB，双 Bot 峰值约 200–230 MiB |
| `executor` | 空闲 0（进程不存在）；运行期受 `--max-old-space-size` 与 `download.concurrency=1` 约束 |
| `bots` | 512 MiB 下 `1..2`；`>=3` 需要更大档位 |
| `search` | 必须 `disabled` |
| `network` | 512 MiB 机器优先使用**外部**代理；内置代理本身要 50–100 MiB |

**`executor` 与 `publisher` 争内存是常态。** 这个 preset 成立的前提就是「大部分时间只有
一个角色在吃内存」，因此必须把下载并发与图像处理并发硬性限制住，不能依赖操作系统的 OOM
选择器替你做决定。

---

## 生命周期

| 角色 | 生命周期 | 谁唤醒 | 谁决定停机 |
| --- | --- | --- | --- |
| `publisher` | `always-on` | 不适用 | 永不停止 |
| `telegram-ingress` | `always-on` | 不适用 | 永不停止 |
| `clock` | `always-on` | 不适用 | 不适用 |
| `executor` | `spawn-on-demand` | supervisor 在触发到来时 spawn | **`executor` 自己的账本**（`exitWhenIdle`） |

```text
无任务                    有触发
   │                        │
   ▼                        ▼
进程不存在  ────────────►  spawn executor
   ▲                        │
   │                        │ 跑完 + 空闲 grace
   └────────────────────────┘  exit(0)
```

### 必须守住的四条不变量

1. **进程休眠 ≠ 机器休眠。** 机器永不停机；不使用平台 auto-stop、不使用 suspend、
   不配置任何会停止机器的机制。本 preset 的可休眠对象只有 `executor` 进程。
2. **省内存 ≠ 省账单。** 进程退出只释放 RAM。机器仍在计费，这一点必须写进预期，
   不能当作 `split-worker` 的替代品。
3. **停机决策权归 `executor` 自己的账本。** 空闲判定只读本进程的权威状态：无进行中的槽位、
   无被租约持有的运行、无进行中的下载、无处理中或立即待处理的投递项，全部为 0 才算空闲，
   再过 `idleGraceMs` 宽限才 `exit(0)`。supervisor 的超时、平台探针、连接空闲都不能替代它。
4. **没有健康检查指向 `executor` 的触发端口。** 探测本身就是请求；在 `wake-run-exit` 形态下
   它会把刚刚收工的机器叫醒，在这个 preset 下它会**把刚退出的子进程重新拉起**，形成停不下来的循环。

### 为什么这个 preset 不是「机器级 auto-stop 回来了」

历史上存在过一个机器级拓扑：commit `9f3fc53` 引入、commit `a98c3a7` 删除的 autosleep 合体配置，
1×512 合一台、`auto_stop_machines="stop"`、`min_machines_running=0`，由 Telegram 流量或
外部时钟唤醒整台机器。它在 commit `a98c3a7` 被删除，原因是结构性缺陷：

> 触发端在 occurrence 落库后立即应答是刻意的（10–40 分钟的运行活不过代理超时），
> 代理看到的「连接已空闲」并不代表任务结束。**停机决策权归执行端自己的账本。**

`single-machine-worker-sleep` 是同一个内存目标在**进程层**的正确做法：机器不动，
停止的是 `executor` 进程，决策者是 `executor` 自己的账本。二者的区别不是实现细节，
而是「谁有权判断任务结束」。**重新引入机器级停止就是重新引入这个缺陷。**

---

## 状态位置

| 状态 | 路径 | 说明 |
| --- | --- | --- |
| TelePost 每 Bot SQLite | `data/bot{N}/` | 投稿幂等键、审核队列、发布记录 |
| TelePost 运行策略覆盖 | `data/bot{N}/runtime-policy.json` | OWNER 经 `/botconfig` 原子写入 |
| PixivFlow 槽位账本 | `data/pixivflow/pixivflow.db` | occurrence、slot、slot item |
| 下载缓存与元数据 | `data/pixivflow/` 下的相对路径 | 必须是相对路径，见下 |
| 投递 outbox | 同上，manifest 引用文件 | 跨 `executor` 进程重启保留 |

**一个物理卷，两个互不相交的角色命名空间（SI-7）。** TelePost 只写 `data/bot{N}/`，executor
只写 `data/pixivflow/`；supervisor spawn executor 时只能把它自己的命名空间暴露给子进程。
命名空间重叠才是非法组合；共享物理卷本身合法。

> **路径规则（commit `71b4c7c` 的教训）：** PixivFlow 的配置加载器会把「落在配置文件所在目录
> 之外」的绝对路径按自己的默认值改写并回写配置，改写结果是 `/app/downloads`——**在卷之外**。
> 所以配置文件**文件本身**的路径用绝对路径，配置里**存储路径**必须保持 `./data/...` 形式。
> 这条规则对所有 preset 成立，不是本 preset 专属。

---

## 网络

| 项目 | 取值 |
| --- | --- |
| `executor` → `publisher` | `loopback-http`，`http://127.0.0.1:8080/api/bot{N}/v1/submissions` |
| 触发入站 | `supervisor` 常驻占住的端口 8090（仅回环可见），由它转发给子进程 |
| `telegram-ingress` | `webhook`（公网 HTTPS）或 `polling`（无入站） |
| 出口 | `direct` 或 `proxy`；512 MiB 机器优先外部代理 |

回环投递不经过 proxy，因此**不重置任何平台的空闲计时**。这不是本 preset 的依赖项
（本 preset 不依赖任何平台停机机制），但在排查「投递后机器行为异常」时是有用的事实。

---

## 优点

- **部署简单。** 一个机器、一个卷、一套进程编排；不需要外部时钟，不需要 Cloudflare，不需要私网。
- **空闲 RSS 很低。** 空闲时只有 `publisher` 在占内存，`executor` 贡献 0。
- **一个卷即可备份。**
- **同机 localhost 通信。** 投递不经过代理、不计公网流量、不受 overlay 故障影响。
- **不需要公网唤醒路径。** 与 `split-worker` 相比少一个组件（外部时钟）和一条平台依赖。

---

## 缺点

- **Fly Machine 仍然常驻计费。** 省的是内存，不是账单。
- **`executor` 与 `publisher` 同故障域。** 机器级故障同时影响投稿与执行。
- **下载期间内存竞争。** 必须严格限制下载并发与图像处理并发，否则 OOM 会打到 `publisher`，
  用户看到的是投稿机器人坏掉。
- **主机级凭据隔离不成立**（矩阵字段 `hostCredentialIsolation=false`；同一台机器、同一个文件系统），但 executor 进程**不持有** Telegram
  凭据（SI-1 全局成立）。隔离靠 supervisor 的**环境白名单**：spawn executor 时只传 Pixiv 与调度
  凭据（`PIXIV_*`、`SCHEDULER_TRIGGER_TOKEN`、`TELEPOST_BOT*_SUBMIT_TOKEN`），绝不继承
  `BOT*_TOKEN` / `BOT*_CHANNEL_ID` / `BOT*_WEBHOOK_SECRET_TOKEN`。实现时必须有一条测试守护这份
  白名单；在该测试存在之前，本 preset 不得标记为已实现。
- **`review` 与 `publish` 不受保护。** `split-worker` 里「执行端崩溃/OOM 不影响 Telegram」
  这条性质在这里不成立。
- **只实现了一部分。** supervisor 组件（`supervisor/`）已实现并有测试，包括设计要求的
  **环境白名单守护测试**；但本 preset 仍**不可部署**：没有镜像、没有平台配置，部署步骤依然是
  设计。因此矩阵里它保持 `implemented=false` / `support=experimental`，直到整条路径可执行。

---

## 故障模型

| 故障 | 影响面 | 表现 | 恢复 |
| --- | --- | --- | --- |
| `executor` 运行期 OOM | 同机全部角色 | 子进程被杀或触发内核 OOM killer 波及 `publisher` | supervisor 必须能区分「正常 exit(0)」与「被信号杀死」 |
| `publisher` 崩溃 | 全部角色 | 机器重启后 `executor` 不存在 | 机器常驻，重启即恢复常驻角色 |
| 卷损坏 | 两个角色一起丢状态 | 审核队列与 outbox 同时消失 | 从卷快照恢复 |
| supervisor 判定空闲过早 | 批次被截断 | 下载中的批次消失 | **这是本 preset 唯一的致命误配**，空闲判定必须只读 `executor` 自己的账本 |
| 出口被 Pixiv 限流 | 只有 `executor` | `rate limit cooldown`、penalty 升级 | 换出口；见 [事故记录](../incidents/2026-09-11-pixiv-egress-rate-limit.md) |

故障域是 `single`。与 `single-host` 唯一的区别是：这里多了一个「supervisor 可能错误地
结束 `executor`」的新故障模式，而它恰恰是最难排查的一类。

---

## 成本模型

| 项目 | 说明 |
| --- | --- |
| 机器 | 常驻计费，与有没有任务无关 |
| `publisher` | 常驻内存，约 170–230 MiB |
| `executor` | 只在运行期占用内存与 CPU；空闲 0 |
| 相对 `single-host` | 省内存 |
| 相对 `split-worker` | 多付「业务机常驻」与「执行机常驻」之间的差额，换来少一个外部时钟和一条私网 |

---

## 实现状态

| 组件 | 状态 | 位置 |
| --- | --- | --- |
| supervisor 二进制 | **已实现**（Go，仅标准库） | `supervisor/`（main.go / server.go / child.go） |
| 环境白名单 | **已实现并有测试** | `supervisor/child.go` + `supervisor/supervisor_test.go` |
| 执行侧容器镜像 | **已实现**（CI 构建） | `docker/worker-sleep.Dockerfile` |
| compose 形态（覆盖层） | **已实现并有校验** | `docker-compose.worker-sleep.yml` |
| Fly / systemd 形态 | 缺失 | —— |
| 部署步骤 | 仍是设计 | 本页 |

supervisor 已经能做的事，都有真实子进程的测试守护：

- 常驻占住触发端口，路径与鉴权契约与 `split-worker` 的执行端**完全一致**
  （`POST /internal/schedules/{scheduleId}/run` + Bearer），所以迁移时时钟侧不用改；
- 只有**通过鉴权**的 POST 才拉起 executor：探测（GET）得到 404，令牌错误得到 401，
  两者都不会 spawn —— 「一次探测把刚退出的子进程拉回来」的循环就此断掉；
- 同一时刻只有一个 executor（SI-4）；子进程退出后**不重启**；
- supervisor **不会**因空闲杀掉子进程：停机决策权只属于 executor 自己的账本；
- 能区分「正常 exit(0)」「被信号杀死（OOM/崩溃）」「supervisor 自己发起的停止」三种结局；
- 收到停止信号时把信号转给子进程，不留孤儿；
- 传给子进程的环境是 **deny-by-default 白名单**：只有 `PIXIV_*`、`SCHEDULER_*`、
  `*_SUBMIT_TOKEN` 与通用运行变量放行；任何 Telegram 凭据名一律拒绝启动子进程。

### 端口分工由 supervisor 拥有

```text
8090  supervisor 常驻占住的对外触发端口     <- 时钟照旧 POST 到这里，路径与鉴权不变
8091  executor 子进程自己的触发端口         <- supervisor 转发到它
```

supervisor 启动时会拒绝「两个端口相同」的配置，并且**替子进程指定**它的触发端口
（通过 `SCHEDULER_TRIGGER_PORT`）——让运维手工对齐两个端口，就是一个静默的失配来源：
子进程占住 8090、supervisor 在 8091 等它，表现为「触发一直 503」，而两边配置各自看起来都没问题。

镜像里**没有** `HEALTHCHECK`，也显式清掉了从基础镜像继承来的健康检查：指向执行端触发端口的
探测会把刚退出的子进程重新拉起来。唯一允许被检查的是 supervisor 自己的 `/healthz`，
而它由运维在平台侧配置，不写进镜像。

## 部署步骤

**compose 形态可执行；Fly / systemd 形态还没有配置。**

### compose 形态（已实现）

```bash
WORKER_SLEEP_IMAGE=<执行侧镜像> \
docker compose -f docker-compose.yml -f docker-compose.worker-sleep.yml up -d
```

覆盖层**不是第二份拓扑来源**：拓扑仍只由 `docker-compose.yml` 定义，这一层只把 `pixivflow`
服务从「常驻 executor」换成「常驻 supervisor + 按需 executor」——同一个服务名、同一个卷、
同一个网络，所以角色归属与 SI-7 都没变。业务侧服务（`telepost`）连同它自己的健康检查原样保留。

不用 profile 表达的原因：Compose 里没有 profile 的服务永远启动，而 `pixivflow` 正是无 profile
的；用 profile 表达「要么常驻执行端、要么按需执行端」会让默认的 `docker compose up -d` 静默
少起一个执行端——那是破坏默认路径，不是新增部署方式。

`scripts/validate.sh` 会把合并后的模型渲染成 JSON 并断言：镜像换成了执行侧镜像、**健康检查已
禁用**、端口分工存在、`telepost` 服务未被改动。少了健康检查那一条，探测就会把刚按账本收工的
子进程重新拉起来。

### Fly / systemd 形态

**缺失。** Fly 形态需要这个 preset 自己的机器拓扑，也就是第三份 `fly/*.toml`，而它与
「只有两份 Fly 配置」的契约冲突——这需要先决定怎么表达，见
[ROADMAP-MULTI-ARCH.md](../ROADMAP-MULTI-ARCH.md) 的 Phase 3。

### compose 的完整步骤形态

1. 准备一个卷，`data/bot{N}/` 与 `data/pixivflow/` 都落在卷上，挂给两个容器。
2. 部署常驻 `publisher`（上游 TelePost 镜像，不改），确认私聊投稿可用、webhook 或 polling 已建立。
3. 配置常驻 supervisor（`SUPERVISOR_CHILD_CMD` / `SCHEDULER_TRIGGER_TOKEN` /
   `SUPERVISOR_LISTEN` / `SUPERVISOR_CHILD_TRIGGER`）：触发到来时 spawn `executor`，
   `executor` 退出后不重启它。`SUPERVISOR_CHILD_CMD` 必须是**单条命令**（supervisor 以
   `sh -c "exec <cmd>"` 启动，不留包装 shell，否则信号与退出状态会失真）；需要管道或
   多步逻辑就写一个包装脚本。
4. 在 `executor` 的配置里设 `schedulerRuntime.mode`、`exitWhenIdle=true`、`idleGraceMs`、
   `maxLifetimeMs`，并确认**没有**任何指向 `executor` 触发端口的健康检查。
5. 验证：无任务时 `executor` 进程不存在；一次触发后进程出现；账本空了之后进程退出；
   整个过程机器从未停止。
6. 验证反例：触发后立刻探测 `executor`，确认探针**没有**把已退出的进程拉回来。

---

## 迁移路径

| 来源 | 目标 | 需要搬的状态 |
| --- | --- | --- |
| `single-host` | 本 preset | 同一个 `./data` 目录；改的是进程编排，不是数据 |
| `split-worker` | 本 preset | 两个卷合并成一个；把执行端的下载缓存与账本并入 `data/pixivflow/` |
| 本 preset | `single-host` | 同一个目录；去掉按需 spawn，改为常驻 |
| 本 preset | `split-worker` | 拆成两个卷、加外部时钟与私网投递 |

数据清单、需要与不需要迁移的内容见 [migration.md](migration.md)。

---

## 术语速查

| 说法 | 是否成立 |
| --- | --- |
| 「这台机器会休眠」 | **不成立。** 机器永不停机。 |
| 「空闲时执行端进程不存在」 | 成立。这是本 preset 的全部收益。 |
| 「可以省 Fly 计算费用」 | **不成立。** 机器常驻计费。 |
| 「可以用平台 auto-stop 实现同样效果」 | **不成立。** 那是被删除的缺陷拓扑。 |
