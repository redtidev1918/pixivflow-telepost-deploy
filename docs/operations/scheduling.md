# 调度运维手册：一次定时投稿到底在哪一步断了

> **本页是运维手册，不是契约。** 调度语义、occurrence 归属、槽位模型与幂等不变量写在
> [调度契约](../concepts/scheduling.md)；时钟**可以**做什么、**绝不**做什么写在
> [角色契约](../concepts/roles.md) 与
> [部署契约](../reference/deployment-contract.md)。本页只回答一个问题：
> **「今天的投稿没出来」时，按什么顺序、看什么证据，才能定位到是哪一步断了。**

本页描述的是 `split-worker`（当前生产）的**冗余外部时钟**运维姿势：

```text
PRIMARY    cron-job.org       在 occurrence 准点触发
SECONDARY  Cloudflare Cron    occurrence + 2 分钟触发
SSOT       PixivFlow durable slot ledger
```

两个时钟都只 POST 同一个幂等端点 `POST /internal/schedules/{scheduleId}/run`。
谁都不计算 occurrence、不持有状态、不生成 slot id。事故背景见
[2026-09-13 漏跑事故](../incidents/2026-09-13-schedule-trigger-miss.md)。

---

## 一次健康运行的证据链

任何一次成功的定时投稿，都必须能逐段拿出证据。**跳过任何一段都是在猜。**

```text
① clock fired         时钟 provider 自己的触发历史：某时刻对某 schedule 发过
        │
        ▼
② trigger accepted    执行端 admission 日志：schedule.trigger_accepted（或 already_running /
        │             already_completed），携带 attempt_id / http_status / disposition
        ▼
③ slot exists         durable slot ledger：`<scheduleId>@<occurrenceStamped>` 这一行存在
        │
        ▼
④ execution           该 slot 的 cell 跑完，状态收敛到终态
        │
        ▼
⑤ delivery/outbox     投递 outbox：每个 cell 的投递项进入终态
        │
        ▼
⑥ TelePost            TelePost 侧收到投稿（submission / source_ref / scheduled_at 有记录）
```

**§3 的 slot 存在，是整条链的分水岭。** 有 slot = 触发被受理了，问题在业务侧；
没有 slot = **触发面**的问题，或者时钟根本没响。

---

## 排查顺序（按此顺序做，不要跳）

| 顺序 | 看什么 | 断在这里意味着 |
| --- | --- | --- |
| 1 | **PRIMARY 时钟历史**（cron-job.org 控制台 / 触发历史） | primary 没 fire —— 看 secondary 是否补上了 |
| 2 | **SECONDARY 时钟历史**（Cloudflare Worker 的 cron 执行记录） | 两个都没 fire → 问题不在时钟，或时钟配置漂移 |
| 3 | **PixivFlow admission 日志**（`schedule.trigger_*`，用 `attempt_id` 关联） | 时钟 fire 了但执行端没受理 → 401/404/410/425/429/5xx |
| 4 | **slot ledger**（`schedule_slots`） | 受理了但没有 slot → 不该发生；先确认是不是查错了 occurrence |
| 5 | **cells**（`schedule_slot_items`） | 有 slot 但 cell 全非成功 → 选品 / 下载 / 执行失败 |
| 6 | **delivery / outbox** | cell 成功了但没投出去 → 投递或重试链路 |
| 7 | **TelePost** | 投出去了但业务端没记录 → 业务端侧问题（见 [故障排查](troubleshooting.md)） |

先看 1、2 再看 3 的原因：如果**两个**时钟都没有 fire 记录，那么执行端日志里没有 admission
记录是**预期**结果，不是新证据。反过来，如果时钟 fire 了而执行端毫无记录，问题就在链路中段。

---

## 警告：「Machine started」不是任何事情的证据

```text
auto_start_machines = true
min_machines_running = 0
```

执行端被配置成**任何**打到它公网地址的 HTTP 请求都会启动 stopped 的 Machine。所以：

| 观察到 | 它能证明的 | 它**不能**证明的 |
| --- | --- | --- |
| Machine 从 stopped 变成 running | 有人发了请求 | 请求来自时钟 |
| 日志里有一次冷启动 | 平台代理兑付了一次请求 | 这次请求被**受理**了 |
| `fly machine list` 显示 running | 现在有请求在路径上 | 这次 occurrence 存在 |

> **这是本页最重要的一句话：用「机器起来了」推断「schedule 被受理了」，是把平台代理层的副作用
> 当成了业务层的 admission 结果。** 更糟的是这条捷径看起来每次都成立——直到有人做了一次状态
> 轮询或 `curl` 把它唤醒为止，那时它就变成了一个会说谎的证据。
> 2026-09-13 的事故正是因为当时只能看到这一类证据。

**要判断「触发是否被受理」，唯一的证据是 §3 的 PixivFlow admission 日志。**

---

## 读 PixivFlow 的 admission 日志

执行端对每一次触发都会留下一条终局记录。事件名是固定的：

| 事件 | 含义 |
| --- | --- |
| `schedule.trigger_received` | 收到了一个触发请求（**尚未**鉴权） |
| `schedule.trigger_unauthorized` | 鉴权失败（token 错或缺失）→ HTTP 401 |
| `schedule.trigger_not_found` | schedule id 未知 → HTTP 404 |
| `schedule.trigger_accepted` | **受理**：这一 occurrence 归本进程执行（落库即应答） |
| `schedule.trigger_already_running` | 该 occurrence 已有执行在跑 → 收敛，不启动第二次 |
| `schedule.trigger_already_completed` | 该 occurrence 已完成 → 收敛，不重跑 |
| `schedule.trigger_rejected` | 被语义拒绝（未到点 425 / 已过期 410 / 已拒绝） |
| `schedule.trigger_error` | 服务端错误（含饱和 503） |
| `schedule.outcome` | **终态**：本次 occurrence 的最终结果（见下一节） |

可用字段：

| 字段 | 用途 |
| --- | --- |
| `attempt_id` | **关联键**：与时钟侧同一次触发的 `attempt_id` 相同 |
| `provider` | 触发来源自报（`X-Schedule-Provider`）；**只用于观测**，绝不用于授权 |
| `schedule_id` | 哪个 schedule |
| `slot_id` | 对应的 durable slot（受理之后才有） |
| `occurrence_at` | 解析出的 occurrence 时间 |
| `http_status` | 应答给时钟的 HTTP 状态 |
| `disposition` | 语义处置（`accepted` / `running` / `completed` / `rejected` …） |
| `reason` | 拒绝 / 错误的原因 |
| `elapsed_ms` | 从收到请求到作出处置的耗时 |
| `trigger_source` | 触发来源类别 |

### 用 `attempt_id` 把两半日志接起来

一次触发会在**两个不同平面**各留一行，靠 `attempt_id` 关联：

```text
时钟（Cloudflare Worker）:
  trigger.dispatch_started   attempt_id=<id>  schedule_id=<id>
  trigger.dispatched         attempt_id=<id>  schedule_id=<id>  http_status=<n>  disposition=<...>

执行端（PixivFlow）:
  schedule.trigger_received  attempt_id=<id>  schedule_id=<id>
  schedule.trigger_accepted  attempt_id=<id>  slot_id=<slot>  http_status=<n>
  schedule.outcome           attempt_id=<id>  slot_id=<slot>  status=<...>
```

- `trigger.dispatch_started` / `trigger.dispatched` 是**同一次调用**的前后两半，
  `attempt_id` 相同；不同调用之间 `attempt_id` 不同。
- 同一个 `attempt_id` 被**所有重试**复用：一次重试是「时钟在重复自己」，不是第二次触发。
- 因此：**有时钟侧 `attempt_id`、执行端无对应行** → 请求没到达执行端（网络 / 代理 / DNS）；
  **两侧都有但 disposition 是拒绝** → 到达了但没被受理；**两侧都有且 accepted** → 受理成功。

> `attempt_id` 是独立命名空间里的 UUID，**不**由 token、origin 或 schedule id 派生，
> 所以它可以在日志里自由流转，不携带任何密钥片段。

---

## 读终态 `schedule.outcome`

`schedule.outcome` 是**终态**事件，字段：

| 字段 | 含义 |
| --- | --- |
| `schedule_id` | 哪个 schedule |
| `slot_id` | 哪个 slot |
| `occurrence_at` | 这一次 occurrence |
| `status` | `success` / `partial` / `failed` |
| `duration_ms` | 本次 occurrence 从开始到终态的耗时 |
| `cells` | 每个 cell 的处置汇总 |

`cells` 汇总区分这几种结果：

| cell 结果 | 含义 |
| --- | --- |
| `submitted` | 成功投递给 TelePost |
| `no_match` | 该 cell **没有符合条件的候选**（业务结论，不是故障） |
| `duplicate` | 幂等收敛到已有记录；`all_duplicates` 表示本次**全部** cell 都是重复 |
| `executor_failed` | 该 cell 执行失败（选品 / 下载 / 执行） |
| `delivery_failed` | 该 cell 执行成功但投递失败 |

### 「22:00 没有投稿」必须被读成一句确定的话

这两种情况在**观感上完全一样**，在**运维上完全相反**：

| 你看到 | 正确读法 | 结论 |
| --- | --- | --- |
| `schedule.outcome` 存在，`status=success/partial`，`cells.illustration=no_match`，`cells.novel=no_match` | 「22:00 completed，illustration=no_match，novel=no_match」 | **调度成功**：系统按计划运行了，业务上确实没有合格作品。这是**已证明的调度成功**。 |
| **没有** `schedule.outcome`，**也没有** slot，时钟侧也没有 fire | 「22:00 完全没有 slot」 | **TRIGGER FAILURE**：触发面断了。这不是「没有东西可投」。 |

> **把第一种读成第二种（或反过来）是本次架构变更要消灭的那一类误判。**
> 第一种要去看 Pixiv 侧为什么没候选；第二种要去看时钟与 admission —— 两条完全不同的修复路径。
> 在单时钟时代这两件事**无法区分**，这正是 2026-09-13 事故的实质。

---

## 五个状态不是一件事

触发链路上有五个彼此独立的阶段。把它们读成一个「好了 / 没好了」的布尔值，是误诊的主要来源。

| 状态 | 含义 | 谁会报 |
| --- | --- | --- |
| `configured` | 某个值**存在**（token 有值、URL 有值、cron 有表达式） | 配置 / `/health` |
| `dispatched` | 时钟**发出了**请求 | 时钟日志 `trigger.dispatched` |
| `accepted` | 执行端**受理**了这一 occurrence | 执行端 `schedule.trigger_accepted` |
| `running` | 该 slot **正在执行** | 执行端 slot ledger |
| `completed` | 该 occurrence **跑到终态** | 执行端 `schedule.outcome` |

> **`tokenConfigured=true` 只意味着「有一个值存在」。**
> 时钟的 `/health` 报出 `tokenConfigured=true` 时，它证明的是「环境里配了一个非空值」——
> 不是「这个 token 有效」，也不是「触发能被受理」，更不是「调度投递是健康的」。
> **绝不**把 `tokenConfigured=true` 当作调度健康的证据。

同理：`configured` 与 `dispatched` 之间隔着「cron 是否真的 fire」，`dispatched` 与 `accepted`
之间隔着「鉴权、schedule id、occurrence 窗口」——每一段都可能单独断掉。

---

## 关键操作警告：不要轮询执行端

```text
不要 curl 执行端的触发端点 / 健康端点来「看状态」。
```

原因就是本节开头那条配置：

```text
auto_start_machines = true
min_machines_running = 0
```

**一次状态轮询本身就是一个请求，它会冷启动一台已经停机的 Machine**，而且：

1. 它**烧掉一个 idle grace 窗口**（`idleGraceMs = 900000`，10 分钟）——机器会因此多活 10 分钟，
   计费也随之变化；
2. 它污染证据：之后你看到的「机器起来了」正是你自己造成的，而不是时钟造成的；
3. 它让「执行端 stopped」这个**健康状态**看起来像故障，诱使你去「修」一个正常的东西。

**正确做法**：读 durable 证据，不要读进程状态。

| 想知道的 | 读这个 | 不要读这个 |
| --- | --- | --- |
| occurrence 有没有被受理、有没有 slot | 执行端日志 `schedule.trigger_*`、`schedule.outcome` | 触发端点的 HTTP 应答 |
| 这一 occurrence 跑到哪一步了 | slot ledger（`schedule_slots` / `schedule_slot_items`） | `fly machine list` |
| 投递有没有成功 | 投递 outbox | 业务端 `/health` 的计数轮询 |
| 时钟有没有 fire | provider 自己的触发历史（只读接口 / 控制台） | 反复 POST 触发端点 |

执行端**没有**健康检查也是同一个道理，而且这是刻意的（见
[生命周期](../concepts/lifecycle.md) 与 [监控](monitoring.md)）。

---

## 只读诊断与人工补触发

| 目的 | 命令 |
| --- | --- |
| Cloudflare（secondary）实际挂了哪些 cron，与仓库期望是否一致 | `scripts/verify-production.sh` 第 7 段，或 `scripts/cf-clock-readonly.py` |
| 执行端 stopped 是正常静止态 + 未授权触发被拒 | `scripts/smoke-pixivflow.sh` |
| **两个时钟都可疑**时人工补一次触发 | `scripts/trigger-schedule.sh <scheduleId>` |

`scripts/trigger-schedule.sh` 是**第三条**、由人操作的路径。它刻意**不是**时钟：不计算 slot id、
不推导 occurrence、不读写任何账本、不碰 Fly Machines API、不调用 TelePost。
它只把同一个 schedule id POST 到时钟用的同一个端点，由 PixivFlow 决定这是哪一次 occurrence
以及是否已经跑过，因此人工补触发同样会在**同一个** durable slot 上收敛。

它的退出码把三种结局分开：

| 退出码 | 含义 |
| --- | --- |
| `0` | 被受理，或已收敛（`accepted` / `running` / `completed`） |
| `1` | 被拒绝或失败（401 / 404 / 410 / 425 / 429 / 5xx / 超时 / rejected） |
| `2` | 用法或本地配置问题（无 schedule id、无 token、主机不可达） |

---

## PRIMARY 时钟（cron-job.org）的权威配置

PRIMARY 是一个**第三方 SaaS**，它的配置**不在这个仓库里**，因此这一节是它唯一的成文位置。
控制台里的每一个值都必须与仓库里的声明一致；不一致时以
`control-plane/src/cron-map.ts` 的 `primaryCron` 字段为准（`redundant-clock.test.ts` 会失败）。

一个 schedule 一个 job，共两个。每个 job 每天触发**两次**（上午 + 晚间）。

| Job | 计划（Asia/Shanghai） | URL |
| --- | --- | --- |
| `pixivflow-primary-bot1-daily` | 每天 `10:00` 与 `22:00` | `https://pixivflow-scheduler.fly.dev/internal/schedules/bot1-daily/run` |
| `pixivflow-primary-bot2-daily` | 每天 `10:10` 与 `22:10` | `https://pixivflow-scheduler.fly.dev/internal/schedules/bot2-daily/run` |

等价的 UTC 表达（`deploy manifest` / `cron-map.ts` 里读到的就是这两个）：

```text
bot1-daily   0 2,14 * * *
bot2-daily  10 2,14 * * *
```

请求设置：

| 字段 | 值 |
| --- | --- |
| Method | `POST` |
| Body | 空（执行端从 schedule 自己的 cron 解析 occurrence；请求体里没有日期，因此不可能回填历史） |
| Header | `Authorization: Bearer <SCHEDULER_TRIGGER_TOKEN>` |
| Header | `X-Schedule-Provider: cron-job-org` |
| Header | `X-Schedule-Attempt-Id`：**留空**。cron-job.org 无法生成一次性 id，而填一个固定值会伪装成「每次都是同一次调用」。执行端在缺少这个 header 时会**省略**该字段，因此「这个时钟没有发 attempt id」仍然是可见的，而不是被一个假 id 掩盖。 |
| 触发历史 | **开启**（保存响应），否则 §1 的证据链第一段就无法取证 |
| 失败通知 | **开启**，指向一个有人看的地址 |

**时区**：cron-job.org 的计划按账号时区解释。账号设为 `Asia/Shanghai`，或按上面的 UTC
表达式配置——**不要**依赖本机时区，这与执行端 `production.json` 里显式声明
`"timezone": "Asia/Shanghai"` 是同一个理由。

**凭据边界**：cron-job.org **只**持有 `SCHEDULER_TRIGGER_TOKEN`，它是 scheduler-only 的。
它**绝不**持有 Fly API token、Telegram bot token 或 channel id、TelePost submit token、
Pixiv 凭据、GitHub token 或 Cloudflare API token。因此这个 provider 被攻破或泄漏时，
后果只有一条：**轮换 schedule trigger credential**，不需要动任何别的凭据。

**它在结构上不能做的事**（不是「我们让它别做」，是它拿不到）：它无法生成 slot id、无法
计算 occurrence、无法写任何业务表、无法启动或停止 Fly Machine、无法直连 TelePost。

**它不需要、也不应该被健康检查轮询**：该 app 的 `auto_start_machines = true`，任何公网请求
都会冷启动执行端。不要用轮询「确认 clock 活着」——那本身就是一次虚假唤醒。

### 两个时钟的处置必须被记住

| 观察 | 含义 | 处置 |
| --- | --- | --- |
| PRIMARY 到点、SECONDARY 得到 `already_running` / `already_completed` | 正常成功。**这不是重复执行**，是收敛 | 什么都不做 |
| PRIMARY 没到、SECONDARY 得到 `accepted` | PRIMARY 漏跑；本次 occurrence 已被 SECONDARY 救回 | 本次成功，但要查 PRIMARY 的**触发历史**为什么没 fire |
| 两个都到、都是 `accepted` | 不可能同时发生（同一 slot 只有一个能被受理） | 若观察到，说明是两次不同 occurrence → 检查时间配置 |
| 两个都没到 | 两个独立故障域同时失效，或配置漂移 | 走人工补触发并开事故记录 |

---
## 相关页面

- 调度语义、槽位模型、触发 API：[调度契约](../concepts/scheduling.md)
- 谁拥有哪个决定、时钟绝不拥有什么：[角色契约](../concepts/roles.md)
- stopped 是健康状态、为什么禁止健康检查：[生命周期](../concepts/lifecycle.md)
- 只读核对脚本与 `/health` 字段：[监控与只读核对](monitoring.md)
- 症状对照与其它反模式：[故障排查](troubleshooting.md)
- 2026-09-13 漏跑事故与冗余时钟决策：[事故记录](../incidents/2026-09-13-schedule-trigger-miss.md)
