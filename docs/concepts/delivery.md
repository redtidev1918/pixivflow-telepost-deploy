# 投递契约：执行端如何把作品交给业务端

> **本页是「执行端与业务端之间那条边」的唯一权威描述**：走什么协议、带什么字段、幂等键如何
> 生成、失败如何重试、以及「传输层 2xx 不等于业务成功」。角色所有权见 [roles.md](./roles.md)，
> 触发与 occurrence 见 [scheduling.md](./scheduling.md)。矩阵的 `SI-3` 与 `SI-1` 由本页与
> `control-plane/test/webhook-ownership.test.ts` 共同守护。

## 一句话契约

**执行端只有一条出口：把完成的作品投递到业务端的投稿接口。** 它不能发布到频道、不能注册
webhook、不能携带 Telegram 令牌或频道 ID。矩阵 `SI-1` 把它写成对**所有 preset** 成立的不变量：

```
The executor never owns or receives any Telegram bot token or channel id, in any preset.
```

`single-host` 的 compose 配置用结构保证它：pixivflow 服务只收到 `BOT*_SUBMIT_TOKEN`（投稿接口
令牌），收不到 `BOT*_TOKEN` / `BOT*_CHANNEL_ID`。`single-machine-worker-sleep` 的设计要求
supervisor 用环境白名单 spawn executor 子进程，同样不继承 Telegram secret。变化的只是主机级隔离
（共置 preset 的 `hostCredentialIsolation=false`），不是 executor 的所有权
（见 [roles.md](./roles.md)）。

## 协议：标准 multipart，不依赖私有协议

PixivFlow 把作品文件与模板字段渲染成一次标准的 `multipart/form-data` HTTP 请求：

| 维度 | 内容 |
| --- | --- |
| 方法 | `POST` |
| 路径 | `${TELEPOST_API_BASE_URL}/api/bot{N}/v1/submissions` |
| 鉴权 | `Authorization: Bearer <TELEPOST_BOT{N}_SUBMIT_TOKEN>` |
| 文件字段 | `files`（插画为图片，小说为 `.txt` document，动图为循环 GIF animation） |
| 表单字段 | `title`、`tags`、`note`、`link`、`spoiler`、`anonymous`、`idempotency_key` |
| 成功判据 | `success.statuses` 含 201，且 `jsonPath: ok` 等于 `true` |
| 重试 | `maxAttempts` / `retryDelayMs`（指数退避，由 outbox 承载） |

因此任何能发 multipart HTTP 的程序、cron 或 CI 都能复用同一接口；PixivFlow 只是其中一个上游。
反过来，`httpMultipart` delivery 也可以指向任意兼容该表单约定的接收端。

## 幂等：两种键，两个含义

幂等键由 PixivFlow 按 occurrence 生成：

```
pixivflow:<target>:<type>:<pixivId>:<slotId>:<targetId>
```

业务端（TelePost）按这个键返回两种**不同**的语义，必须区分：

| 返回 | 含义 | 触发场景 |
| --- | --- | --- |
| `idempotent_replay` | 同一次触发的 ACK 丢失后重试，带**同一个**键 | 不是新稿件；返回既有记录，不重复入队 |
| `duplicate_existing` | 新的 occurrence 又投了**同一个作品** | 走作品级历史去重；也不是新稿件 |
| 新受理（201） | 这是一个新键 | 写入审核队列，媒体暂存审核群 |

**不要用按作品固定的键。** 固定键会让「不同 occurrence 的合法重投」与「同一次触发的
ACK 丢失重试」变得无法区分：前者应当去重，后者必须被识别为同一次。

## outbox：只重试，不重跑

投递 outbox 是执行端持久状态的一部分（见 [state.md](./state.md)）。它固化了
`pixivId` 与文件引用，因此重试只做一件事：**重发既有的那一条**。

| 规则 | 内容 |
| --- | --- |
| 只重试、不重选 | 一旦某个作品被选中并下载，后续重试永远锁定它；「换一篇」只能是显式人工操作 |
| 与缓存清理解耦 | outbox **独立保留**，不参与 `cacheRetentionDays` / `cacheMaxSizeMB` 的缓存清理 |
| `kind` 决定含义 | outbox 计数同时包含**媒体投递**与**无候选通知**（`no_candidate`），处理方式完全不同 |
| 清空 = 丢件 | 删除 outbox 记录不是清理，是丢弃重试依据 |

看到 outbox 计数上升，先读清单里的 `kind`：媒体投递失败是链路问题，无候选通知往往是检索
条件没命中。诊断细节见 [troubleshooting.md](../operations/troubleshooting.md)。

## 终态下游状态压过传输层 2xx

一条必须写下来的规则：**「200 且没有报错」不是投递成功的证据。** 远端业务层可能已经失败，
而传输层给出 2xx。这种「远端失败被当成端到端成功」的语义问题已在 PixivFlow `f331cd4`
（v2.19.4）修正：投递的成功判据读的是下游的终态字段，不是 HTTP 状态码。

这条规则的来源是一次真实故障：早期控制面是一个 Cloudflare Worker，其处理函数对**每一条**
update 都回答 `200 {ok:true}`。Telegram 因此报告 webhook 健康、投递无积压，而每一条私聊投稿
都被确认并丢弃——没有报错，没有积压，没有任何可见故障（见
[roles.md](./roles.md) 的「促成这条契约的历史故障」）。

## 每条投递路径由 preset 决定

「投递」这一步在四个 preset 里走的是不同的传输，但**协议与幂等键完全相同**：

| Preset | 传输 | 路径 |
| --- | --- | --- |
| `single-host` | `container-network` | `http://telepost:8080/api/botN/v1/submissions` |
| `single-machine-worker-sleep` | `loopback-http` | `http://127.0.0.1:8080/api/botN/v1/submissions` |
| `split-worker` | `flycast` | `http://telesubmit-multi-bot.flycast/api/botN/v1/submissions` |
| `remote-worker` | `private-overlay` 或 `public-https` | 由部署者选定的地址；**必须带 bearer，即使走私网** |

矩阵 `enums.transport` 是这张表的枚举来源。`remote-worker` 的不变量明确写着：
「传输必须认证：投稿接口的 bearer 是强制的，即使走私网 overlay」。

一条与拓扑无关的传输陷阱：`force_https = false` 不能删。否则 Fly proxy 会把明文投递重定向成
HTTPS，而执行端不跟这条路，投递变成死路（见 [split-worker.md](../architectures/split-worker.md)）。

## 业务端收到之后

投递成功只表示「业务端已受理」。真正的发布仍由人工审核决定：

1. 媒体进入审核群（多页按 ≤10 张一组，批次间回复成链），原始上传文件随即从运行机器删除。
2. 审核群内只保存 Telegram `file_id`、caption 与状态——所以积压基本不占内存，也不把原图堆在卷上。
3. 人工批准后，业务端复用 `file_id` 发布到频道，不重复上传。

**没有任何 preset 允许跳过这一步。** 矩阵把 `review.enabled=false` 列为 `invalid` 组合：
未经人工批准就发布，超出产品契约。`SI-3` 由 `no-business-state.test.ts` 与
[credentials.md](./credentials.md) 共同守护。

## 相关页面

- 触发与 occurrence 的计算归属：[scheduling.md](./scheduling.md)
- 执行端为什么没有 Telegram 令牌：[credentials.md](./credentials.md)
- outbox 与缓存撑满卷的排查：[troubleshooting.md](../operations/troubleshooting.md)
- 持久状态与卷布局：[state.md](./state.md)
