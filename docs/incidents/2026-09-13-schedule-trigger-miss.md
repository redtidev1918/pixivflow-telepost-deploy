# 事故 2026-09-13 — 上午两次 occurrence 静默漏跑，且无法证明原因

> **本页记录的是事实与决策，不是复盘猜测。** 本页遵循本仓库既有的
> `docs/incidents/` 约定（与 [2026-09-11 出口限流](2026-09-11-pixiv-egress-rate-limit.md) 同一结构：
> 背景 / 症状 / 证据 / 解读 / 未知项 / 架构后果 / 后续）。没有第二套 incident/ADR 约定。

## 背景

生产是 `split-worker`：执行端（`pixivflow-scheduler`）平时 stopped，由一个**外部时钟**经平台代理
唤醒；时钟是 `control-plane/` 的薄 Cloudflare Worker，只做「cron → schedule id → 一次带令牌的
POST」，不计算 occurrence、不持有状态。

2026-09-13 之前，这个 schedule set 只有**一个**时钟。

## 症状

2026-09-13 上午两次 occurrence 没有产出任何投稿：

| schedule | 本地时间（Asia/Shanghai） | UTC |
| --- | --- | --- |
| `bot1-daily` | 10:00 | 02:00Z |
| `bot2-daily` | 10:10 | 02:10Z |

没有任何错误出现在任何一个平面上。事后能看到的只有「什么都没有」——而这正是本次事故的核心：
**「没有东西可投」与「调度根本没运行」在事后是同一种观感。**

## 证据

### TelePost：durable 证据为零

`submissions.db` 中 2026-09-13 当天的记录全部为 **0**：

| 事实 | 计数 |
| --- | --- |
| `submission` | 0 |
| `source_ref` | 0 |
| `scheduled_at` | 0 |
| audit events | 0 |
| duplicates | 0 |

即：**没有任何一次投稿请求到达过 TelePost。** 这不是「到达后被拒绝」，也不是「到达后去重」——
是链路根本没走到业务端。

### PixivFlow：没有对应的 occurrence 记录

执行端侧没有对应的 slot、没有 cell、没有终态记录。即：这次 occurrence 从来没有被物化过。

### 反例陷阱：Machine 被唤醒**不是**调度被受理的证据

执行端配置里有：

```text
auto_start_machines = true
min_machines_running = 0
```

这意味着**任何**打到该 app 公网地址的 HTTP 请求都会让平台把 stopped 的 Machine 拉起来。
所以「日志里有一次冷启动 / 机器是 running 的」这件事，**只能证明有人发了请求**，
既不能证明那个请求是**时钟**发的，更不能证明它被**受理**了。

> **推理陷阱（必须写下来）：** 用「Machine 被唤醒」推断「schedule 被受理」，是把平台代理层的
> 副作用当成了业务层的 admission 结果。这两件事之间没有任何蕴含关系，而且这条捷径看起来
> 每次都成立——直到有人用 `curl` 或一次状态轮询把它唤醒为止。

## 解读

单时钟架构下，事后**无法**区分下面三种假设：

| 假设 | 事后可区分吗（单时钟） | 需要的证据 |
| --- | --- | --- |
| 时钟从未触发 | **不能** | 时钟 provider 的触发历史 + 执行端 admission 日志 |
| 时钟触发了，但触发被拒绝 | **不能** | 执行端 admission 日志里的 disposition |
| 确实没有符合条件的作品可投 | **不能** | 执行端的终态 `schedule.outcome` 与 cell 汇总 |

这三者当时都表现为同一件事：**TelePost 侧零记录**。

这就是「单一时钟」在架构上的真正缺陷：它无法报告**自己**没有执行。触发端本身幂等、
业务端作品级幂等、槽位账本幂等——每一层都工作正常，但没有一层能证明**上游那一次 fire 存在过**。

## 决策

**采用冗余外部时钟。**

```text
PRIMARY    cron-job.org       在 occurrence 准点触发
SECONDARY  Cloudflare Cron    occurrence + 2 分钟触发
SSOT       PixivFlow durable slot ledger
```

- 两个时钟对**同一套 schedule set** 触发。
- 两者都只 POST 同一个受认证、幂等的端点：
  `POST /internal/schedules/{scheduleId}/run`。
- 两者都**不**计算 occurrence、**不**持有状态、**不**生成 slot id。
- 谁后到，就在第一个时钟创建的同一个 slot 上收敛——因为 PixivFlow 的 durable slot ledger 是
  **唯一的执行权威**。

**冗余时钟 ≠ 第二个调度器。** 这是本次决策要求文档说清楚的区别：第二个**调度器**会带来第二套
schedule 定义或第二份执行状态，那才是必须禁止的；两个只负责「发一次幂等触发」的外部时钟不会。

### 为什么 secondary 的偏移是 2 分钟

这个数字是用 PixivFlow **真实的** occurrence resolver 证出来的，不是拍的。见
`PixivFlow/src/__tests__/scheduler/redundantClockOffset.test.ts`（分支
`feat/schedule-admission-observability`，PR #74）：

- 两次 fire 相隔 12 小时，`trigger.graceMinutes = 720`，因此**约束来自 resolver 的 15 分钟
  LEAD 窗口**。
- 在该窗口下，仍能解析到**目标** occurrence 的最大延迟是 **704 分钟**。
- **负偏移**（提前触发）会解析到**下一次** fire，即完全不同的 occurrence。所以偏移必须为正。

2 分钟远在 704 分钟以内，且不会跨小时移动（跨小时就是换一个 occurrence 了）。

### 为什么 primary 是 cron-job.org，而不是 Cloudflare

2026-09-13 失效的正是**只有 Cloudflare 驱动**的那条触发链路，而且当时**没有任何东西**能把
「没有东西可投」与「调度从未运行」区分开。把两个独立故障域的 provider 放在同一个 schedule set
上，是为了让「某一个 provider 静默失败」不再等于「这次 occurrence 消失」。
Cloudflare Worker 保留为 secondary，并且**不再**是执行权威。

## 决策状态（如实记录）

**本仓库没有任何 `implemented` / `production-verified` 的决策标记约定**（矩阵的
`status.documented/implemented/tested/productionProven` 是 **preset** 的状态维度，不是决策记录的
状态标记）。因此这里不用标记词，只写事实：

| 项 | 状态 |
| --- | --- |
| 代码与配置变更 | 已合入 `main`：#81（dispatch 可观察性）、#82（双时钟 + 晚间 22:00/22:10 排班），执行端 pin 提交 `212d8e7`。 |
| 执行端镜像的生产部署 | **已部署**（2026-09-13 08:29Z，Fly release **v14**）。镜像 pin 到 PixivFlow `8938ca9`（= PR #74 merge）；生产日志在 08:28:57Z 已出现 `bot1-daily 0 10,22 * * *` / `bot2-daily 10 10,22 * * *` 的配置快照，且 readiness 探针确认 admission 日志（`schedule.trigger_received` / `attempt_id`）在线。**尚未经过真实 occurrence 验证**——下一个窗口是 2026-09-13 14:00Z（22:00 CST）。 |
| cron-job.org 控制台配置（PRIMARY 表达式） | **尚未完成，且是唯一的外部阻塞**：该 SaaS 配置只能在其控制台 / API 完成，当前会话没有其账号凭据。权威配置（两个 job、表达式、URL、headers、凭据边界、必须开启触发历史）见 [调度运维手册](../operations/scheduling.md#primary-时钟cron-joborg的权威配置)。在它配置完成前，今晚 14:00Z 的准点触发不存在，只有 14:02Z 的 SECONDARY 与人工兜底。 |
| Cloudflare Worker 的 secondary 部署 | **已部署**（2026-09-13，wrangler Version ID `e6478d49-f034-410b-a41e-fbe4f66dc2a6`）。线上 cron 已切换为 `2 2,14 * * *` / `12 2,14 * * *`（= occurrence + 2 分钟，上午与晚间各两次）。 |

> **PRIMARY 控制台配置完成、且 2026-09-13 14:00Z/14:02Z 窗口的真实结果取到之后，必须回到本节补写时间戳与处置结果。**
> 在此之前，本页**不得**被读作「已在生产验证」：已上线的是**配置与可观察性**，被验证的是**代码路径**，
> 双时钟在真实 occurrence 上的收敛仍是**待验证**状态。

## 未被采纳的方案，以及原因

### GitHub Actions 定时工作流 —— 明确**不**作为时钟，也**不**作为看门狗

不采用。本仓库此前已有过「GitHub Actions 作为执行平面」的形态，它在 2026-09-11 的出口事故里
被证明不合格（见 [出口限流事故](2026-09-11-pixiv-egress-rate-limit.md)），并且早已被删除。
定时工作流同样不适合承担时钟职责：它把「何时触发」交给一个 CI 系统，而这个系统在此前的形态里
已经被判定**不是**生产数据面的合格出口。

**本仓库不得为此新增任何 scheduled workflow。** 如果任何文档当前推荐定时工作流，那是错的。

### VPS / systemd timer —— 不是长期生产 primary 时钟

不采用。理由是**运维生命周期**，不是能力：

- 实例会到期，账单有生命周期，续费与迁移都需要人工介入；
- 这与「低维护、长期存在」的部署目标冲突；
- 一个需要人工续命的时钟，本身就是一个新的静默失败点。

**允许的用途**：开发、人工排障，以及**紧急触发**。这三件事都不构成生产 primary 时钟。

## 架构后果

1. **PixivFlow 拥有 occurrence identity 与 durable slot state。** 这一点没有变，而且现在更重要了：
   它是两个时钟收敛的**唯一**依据。
2. **外部时钟只做触发。** 不生成 slot id、不计算 occurrence、不调用 TelePost、不控制 Fly Machine。
3. **重复触发是预期的、安全的。** 一次重复触发不会跑两次，它只会得到同一个处置结果。
4. **单个时钟不再是单点失败。** 一个 provider 静默失火，另一个仍在同一 occurrence 上触发。
5. **provider 可替换，不需要改业务核心。** 执行端只认「受认证的幂等 HTTP 触发」。

## 后续

- 完成执行端镜像的生产部署与 cron-job.org 控制台配置，并回到上面的「决策状态」写入时间戳。
- 运维侧的可读性：触发是否被受理，必须能从**执行端的 admission 日志**独立读出，而不是从
  「机器起来了没有」推断。见 [调度运维手册](../operations/scheduling.md)。
- 晚间 occurrence 的业务定义在同一批变更中移到 22:00 / 22:10 CST（= 14:00Z / 14:10Z）。
