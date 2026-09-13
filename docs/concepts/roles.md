# 逻辑角色模型（职责契约）

> **本页是三个仓库之间「哪个角色拥有哪个决定」的唯一权威描述。** 它描述的是**逻辑**契约，
> 与部署形态无关：`single-host`、`single-machine-worker-sleep`、`split-worker`、`remote-worker`
> 四个 preset 共享同一份角色契约，preset 只改变角色**在哪里运行**。
>
> 机器可读的枚举、preset 与安全不变量以
> [architecture-matrix.json](https://github.com/redtidev1918/pixivflow-telepost-deploy/blob/main/docs/reference/architecture-matrix.json)
> 为准（docsify 无法渲染 JSON，因此用绝对链接）。矩阵中 `dimensions[logical-architecture]` 的
> `variesByDeployment` 为 `false`，本页即它的文字展开。部署形态见 `../architectures/overview.md`。

## 三句话契约（与拓扑无关）

1. **时钟（`clock`）只决定「何时唤醒」**：把 cron 表达式映射为 schedule 标识，发一个带触发
   令牌的 POST，然后结束。它不计算 occurrence、不换算时区、不生成槽位标识、不写任何业务表。
2. **执行端（`executor`）只决定「执行哪些 Pixiv 工作、如何可靠执行与投递」**：拥有调度域、
   槽位账本、执行租约、下载、投递 outbox 与重试。它可以平时停止，被触发唤醒，账本空了自行退出。
3. **业务端（`publisher` + `telegram-ingress`）只决定「投稿如何审核与发布」**：它是唯一持有
   Telegram 令牌、唯一能发布到频道的角色。人工批准之前，任何作品都不会进入频道。

这三句话在任何 preset 下都成立。`single-host` 把三个角色塞进同一台机器时，句子里的「谁」变了，
「谁拥有什么」没变。

## 角色表

`角色` 一列是矩阵 `roles[].id` 的原文，不得改写。凭据一列只写占位名，任何情况下不写值。

| 角色 | 负责人 | 拥有状态 | 生命周期 | 凭据 | 入站 | 出站 | 故障域 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `clock` | control-plane（Cloudflare Worker）或 PixivFlow internal 调度器 | 无（cron → scheduleId 映射在配置文件里） | `always-on` | `SCHEDULER_TRIGGER_TOKEN` | 平台 cron 事件 | 一次 `POST /internal/schedules/{scheduleId}/run` | 漏唤醒即漏跑一次，永不回补 |
| `executor` | PixivFlow | 槽位账本、下载缓存与元数据、投递 outbox、Pixiv 凭据材料、限流状态 | `always-on` / `wake-run-exit` / `spawn-on-demand`（由 preset 决定） | `PIXIV_CLIENT_ID`、`PIXIV_CLIENT_SECRET`、`PIXIV_DEVICE_TOKEN`、`PIXIV_REFRESH_TOKEN`、`TELEPOST_BOT*_SUBMIT_TOKEN`、`SCHEDULER_TRIGGER_TOKEN` | 受认证触发 POST | 对投稿接口的 `multipart/form-data` 投递 | 与 Telegram 隔离；崩溃或 OOM 不会丢掉用户投稿 |
| `publisher` | TelePost | 每 Bot SQLite、审核队列、发布记录、每 Bot 幂等记录、运行时策略覆盖 | `always-on` | `BOT*_TOKEN`、`BOT*_CHANNEL_ID`、`BOT*_OWNER_ID`、`TELEPOST_BOT*_SUBMIT_TOKEN` | 投稿 API、审核回调 | Telegram Bot API（审核群、频道） | 用户可见；冷启动表现为「投稿按钮坏了」 |
| `telegram-ingress` | TelePost | 无（webhook 归属是平台侧状态） | `always-on` | `BOT*_TOKEN`、`BOT*_WEBHOOK_SECRET_TOKEN` | Telegram update（webhook 或 polling） | 交给 `publisher` 的同一进程处理 | 第二个 webhook 负责人出现时，每条投稿被签收后静默丢弃 |
| `state` | 写入它的那个角色 | 见 [state.md](./state.md) | `always-on` | 无 | 不适用（不是网络实体） | 不适用 | 状态丢失不可恢复；卷快照是唯一备份手段 |
| `network` | 平台 + 部署者选择的出口 | 无 | `always-on` | `SUB_URL`（可选，仅内置代理时） | 不适用 | 角色之间的传输路径 | 出口不合格时表现为 Pixiv 限流，而不是传输错误 |

`网络` 与 `持久状态` 是**能力（capability）**，不是进程；矩阵里它们的 `kind` 是 `capability`。
它们有明确的拥有者与故障域，因此同样受本页约束。

## 所有权划分

| 决定 | 拥有者 | 本仓库是否有权实现 |
| --- | --- | --- |
| Pixiv 查询、榜单与主题解析、候选排序 | PixivFlow | 否 |
| 候选选择（哪一篇作品被选中） | PixivFlow | 否 |
| occurrence 计算、槽位标识、时区换算 | PixivFlow | 否 |
| 执行调度（何时跑哪个 schedule、何时重试） | PixivFlow | 否 |
| 下载与下载缓存、限流与退避 | PixivFlow | 否 |
| 投递 outbox 与投递重试 | PixivFlow | 否 |
| Telegram 入站（webhook 或 polling） | TelePost | 否 |
| 投稿接口与投稿幂等 | TelePost | 否 |
| 审核 FSM 与人工决定 | TelePost | 否 |
| 频道发布与频道凭据 | TelePost | 否 |
| cron → scheduleId 映射、一次触发 POST | 本仓库 `control-plane/` | 是，且仅此一项 |
| 部署拓扑（两份 Fly 配置）、卷与生命周期参数 | 本仓库 `fly/` | 是 |
| 运行配置的随镜像发布（`pixivflow/config/production.json`） | 本仓库 | 是 |
| 只读运维与验收脚本 | 本仓库 `scripts/` | 是 |

## 共置只是物理事实，所有权永不合并

> **`single-host` 与 `single-machine-worker-sleep` 把角色放进同一台机器，只是物理共置；
> 逻辑所有权不发生任何合并。** 执行端仍然不拥有审核，业务端仍然不拥有 Pixiv 登录，
> 时钟仍然不拥有 occurrence——无论它们是不是同一个进程树。

这条推论决定了两件具体的事：

- 执行端在共置 preset 下**仍然**不得把审核逻辑拿进来「顺手做掉」。它跨进程调用的是同一个
  投稿接口，只是目标地址从 Flycast 变成容器网络地址。
- 共置 preset 下变化的是**主机级凭据隔离**（`hostCredentialIsolation=false`），不是逻辑所有权：
  `executor` 单元在任何 preset 下都不接收 Telegram bot token 与频道 ID（`SI-1`，全局成立）；
  共置只是说同机进程理论上能从共享环境读到业务端的 secret。见 [credentials.md](./credentials.md)
  与矩阵 `combinationRules.supportedWithLimitations.co-located-hosts`。

## 每个角色绝不拥有什么

| 角色 | 绝不拥有 | 为什么 |
| --- | --- | --- |
| `clock` | occurrence、槽位状态、运行时区运算、触发令牌以外的任何凭据 | 一旦它开始计算 occurrence，就会出现第二份「同一个问题两个答案」的实现 |
| `executor` | Telegram bot token、频道 id、审核决定、发布 | 持有 Telegram 凭据就使执行端成为候选 webhook 负责人，并允许它在审核之外发布 |
| `publisher` | Pixiv 登录、下载、槽位调度、选择候选 | 业务端不能成为第二个 Pixiv 执行面，否则同一 Pixiv 凭据被两处争用 |
| `telegram-ingress` | 调度触发 | Telegram 活动不能触发 Pixiv 定时投稿（见 [scheduling.md](./scheduling.md) 第 8 条不变量） |
| `state` | 只存在于容器文件系统的内容、构建缓存、临时媒体 | 这些东西随机器消失，把它们当状态会让「重启即恢复」变成假象 |
| `network` | 任何业务状态 | 出口可替换是刻意的；出口永远不是第二个调度器 |

## 改动该落在哪个仓库

| 你要改的东西 | 落点 |
| --- | --- |
| cron → scheduleId 映射、触发 POST 的重试与超时 | 本仓库 `control-plane/src/` |
| 部署拓扑、卷、生命周期、镜像 pin | 本仓库 `fly/deploy.pixivflow.toml`、`fly/deploy.telepost.toml` |
| 只读验收脚本 | 本仓库 `scripts/` |
| 槽位账本、occurrence 语义、执行重试、下载、投递 outbox | **PixivFlow** 仓库 |
| Pixiv 鉴权、限流、榜单/主题/候选排序 | **PixivFlow** 仓库 |
| 投稿接口契约之外的入站行为、审核 FSM、发布、频道策略 | **TelePost** 仓库 |
| Telegram 凭据、webhook 注册/删除、Bot 命令 | **TelePost** 仓库 |
| 运行配置默认值（`schedulerRuntime`、`delivery` 模板等） | 本仓库只**固定**随镜像发布的 `pixivflow/config/production.json`；字段语义以 **PixivFlow** 的 `CONFIG.md` 为准 |

本仓库没有第四条去处。任何「顺手在这里再实现一遍」的改动都会与上表冲突；
`control-plane/test/no-business-state.test.ts`、`deployment-contract.test.ts`、
`webhook-ownership.test.ts` 是这三条边界的静态守护。

## 为什么不需要租约 / 围栏令牌（fencing token）

本套件**没有**跨平面的分布式锁：没有执行租约跨仓库下发，没有围栏令牌，没有认证的
`register` 协调协议，也没有用于「确认哪个平面是主」的会话密钥。这不是尚未实现，
而是刻意的终局决定：

- **不变量是「只有一个生产执行平面」，而不是「多个平面用锁协调」。** 矩阵 `SI-4` 要求
  「同一 Pixiv 凭据最多只有一个在跑的生产执行」。满足它的方式是**不部署第二个执行平面**：
  矩阵把 `second-clock` 列为 `invalid` 组合，理由正是「重复触发是幂等的，凭据争用不是」。
- **幂等已经覆盖了重复。** 触发是幂等的（同一 occurrence 收敛到同一个 Slot），Slot 级
  与作品级幂等由 PixivFlow 与 TelePost 各自拥有（见 [delivery.md](./delivery.md)）。
  在幂等之上再加一层锁，只是在给一个已经收敛的系统增加一个新的失败模式。
- **锁需要第二个权威**，而第二个权威就是这条契约要禁止的东西：谁来发租约、租约过期判给谁、
  两个平面都认为自己有效时以谁为准——每一个问题都会把「唯一权威」变回「两个答案」。

唯一的例外在**语义上不构成平面间锁**：投稿接口自身的认证是 `Authorization: Bearer
<submit-token>` 加上按幂等键的会话记录语义（`idempotent_replay` 与 `duplicate_existing`）。
它只回答「这条投递是否已经受理过」，回答不了也不回答「哪个平面是主」。因此它替代不了
上面那条不变量，也不被当作租约使用。

## 促成这条契约的历史故障

**投稿被签收后静默丢弃。** 早期控制面是一个 Cloudflare Worker，带 D1 影子账本与一套
Worker 内实现的审核状态机，同时存在完整的 Pixiv 执行与审核两条链路。结果是投稿机器人的
webhook 被指向该 Worker，而 Worker 的处理函数对**每一条** update 都回答 `200 {ok:true}`。
Telegram 因此报告 webhook 健康、投递无积压，而每一条私聊投稿都被确认并丢弃——没有报错，
没有积压，没有任何可见故障。

那次收敛（commit `0f90451`）删除了 Worker 里的调度/审核/凭据/Telegram 实现，只留下
`index.ts`、`dispatch.ts`、`cron-map.ts` 三个源文件与一次带令牌的 POST；随后 commit
`a98c3a7` 删除了与之配套的一次性执行平面与混部拓扑（GitHub Actions 执行平面、
`deploy.fly-multi-bot.toml`、`deploy.fly-autosleep.toml`）。守护测试
`no-business-state.test.ts` 与 `webhook-ownership.test.ts` 存在的目的就是阻止它们回来。

这条故障给出两条长期规则，它们与拓扑无关：

1. **「200 且没有报错」不是投递成功的证据。** 一个会对所有输入回答成功的实现，会让上游
   的可靠性机制全部失效。这也是 [delivery.md](./delivery.md) 里「终态下游状态压过
   传输层 2xx」这条规则的来源。
2. **同一份职责只能有一个实现。** 只要存在第二个实现，就一定会有人把流量指向它，
   而两边都「看起来在工作」。

## 与其他页面的关系

- 谁可以睡、谁唤醒谁、谁决定停止：[lifecycle.md](./lifecycle.md)
- 哪些东西是持久状态、备份必须包含什么：[state.md](./state.md)
- 触发与槽位幂等：[scheduling.md](./scheduling.md)
- 投递契约与幂等键：[delivery.md](./delivery.md)
- 凭据归属与处理不变量：[credentials.md](./credentials.md)
- 角色之间的传输、出口与代理：[network.md](./network.md)
- preset 索引与拓扑差异：`../architectures/overview.md`
