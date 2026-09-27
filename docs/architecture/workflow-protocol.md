# PixivFlow ↔ TelePost Workflow Protocol v1

Status: DRAFT（规范先定稿，实现分片落地；v1 只增不改）
Protocol version: `"1"`
Owners: PixivFlow = 生产者（内容采集与处理引擎）；TelePost = 消费者与编排者（内容工作流平台）
Related: `refetch-silent-failure-cure.md`（触发本协议的重抓静默故障）、`refetch-job-model.md`（现状模型）

---

## 0 为什么需要这份协议

重抓故障的根因不是某一个 bug，而是**两个项目互相知道对方的业务**：

| 现状耦合 | 证据（生产/代码） |
|---|---|
| PixivFlow 知道「Telegram 审核」 | 槽位名硬编码 `审核群重抓`；`refetchOutcomeUrl`；投递字段 `refetch_request_id`；回调体 `disposition: no_alternative\|failed`；`manual_request_id` |
| TelePost 知道 PixivFlow 的执行细节 | 轮询 `GET /internal/targets/{target}/refetch/{id}` 并自行解释 `state`；把「远端状态未变」当作停摆；`_submit_pixivflow_refetch` 依赖 202 + `status="accepted"` + `slotId` |
| 双方靠隐式约定通信 | `state` 投影无时间戳；`202` 只表示「本进程接单」；延迟投递被 400 拒绝后**双方都认为对方会处理** |

一旦任一侧演进（自动发布、多平台、多账号、多来源、WebUI 任务控制、集群部署），这种耦合就会再次以「状态错乱」的形式爆出来。因此本协议的目标不是「再修一次重抓」，而是**让两侧只认识协议对象，不再认识对方的业务**。

---

## 1 职责边界

| | PixivFlow（生产者） | TelePost（消费者 / 编排者） |
|---|---|---|
| 负责 | Pixiv API 访问、搜索与召回、tag 分析与给出匹配依据、下载、元数据、媒体处理与资产分类、候选生成 | Telegram 交互、审核与候选历史、队列与重试、发布、用户可见语义、权限、媒体发送策略 |
| 不负责 | Telegram、审核、发布、用户按钮、审核状态、媒体发送策略 | Pixiv 细节、搜索/过滤/排序逻辑、下载实现 |
| 允许的知识 | 自己的 `job_type`、参数与结果 schema | 协议对象 + 通过 `GET /capabilities` 发现的能力 |
| 禁止的知识 | 消费者业务名词（review / 审核 / 重抓 / 替换 / 发布） | 生产者内部表结构、内部字段语义、内部阶段名 |

### 1.1 设计原则

1. **不透明关联**：`idempotency_key` / `correlation_id` / `labels` 由消费者生成，生产者**只回传不解释**。
2. **能力发现**：消费者不硬编码 job 类型清单，先 `GET /capabilities`。
3. **状态语义封闭**：跨边界状态只能用协议枚举；生产者可附不透明 `progress.stage` 供展示，消费者**不得据此分支**。
4. **失败机器可读**：`error.code` + `retryable`，禁止靠 message 文本判断。
5. **至少一次 + 去重 + 对账**：事件送达不依赖「单次 HTTP 成功」。
6. **只增不改**：未知字段必须忽略；删除/改语义需大版本。
7. **每个 Job 有预算**：心跳 + deadline，生产者不得无限运行。
8. **禁止专用端点 + 专用字段成对出现**：新需求必须表达为既有对象的新 `job_type`／新 `asset`／新 `error.code`。

---

## 2 对象模型

### 2.1 Task（请求，消费者 → 生产者）

```jsonc
{
  "protocol_version": "1",
  "job_type": "candidate_search",
  "idempotency_key": "c78dd065-60aa-4e7a-bba5-38275019217c", // 必填，生产者保证同键至多一个 Job
  "correlation_id": "review-chain:135",                        // 可选，不透明，原样回传
  "labels": { "origin": "moderation", "tenant": "bot1" },       // 可选，不透明字符串表
  "callback_url": "https://…/api/bot1/v1/jobs/events",         // 可选，事件投递地址
  "deadline_ms": 5400000,                                       // 可选，硬上限（默认按 job_type 的能力声明）
  "params": { /* job_type 专属，见 §6 */ }
}
```

### 2.2 Job（执行，生产者持有，持久化）

| 字段 | 类型 | 说明 |
|---|---|---|
| `job_id` | string | 生产者生成，稳定不变 |
| `status` | enum | `queued` / `running` / `succeeded` / `failed` / `cancelled` / `expired` |
| `job_type` | string | 回显 |
| `protocol_version` | string | 回显 |
| `idempotency_key` / `correlation_id` / `labels` | string / string / map | 原样回传，不解释 |
| `created_at` / `started_at` / `updated_at` / `heartbeat_at` / `deadline_at` | epoch ms | **必须提供**，否则消费者无法区分「刚排队」与「已死」 |
| `lease_active` | bool | 是否有活跃租约（进程真的在跑） |
| `progress` | object | `{ stage: string(不透明), message?: string, at: epoch ms }` |
| `attempt` | int | 已尝试次数 |
| `result` | Result? | 终态成功时 |
| `error` | Error? | 终态失败时 |
| `events_url` | string | 事件历史/对账入口 |

### 2.3 Event（生命周期，生产者 → 消费者，至少一次）

```jsonc
{
  "protocol_version": "1",
  "event_id": "evt-…",           // 生产者生成，消费者按此去重
  "job_id": "job-…",
  "type": "job.succeeded",        // 见 §8
  "at": 1790481174570,
  "correlation_id": "review-chain:135",
  "payload": { /* 终态事件带 result / error */ }
}
```

### 2.4 Result / Asset（产物）

```jsonc
// Result（candidate_search）
{
  "candidates": [
    {
      "candidate_id": "abc",
      "platform": "pixiv",
      "work_id": "149713091",
      "work_type": "illustration",
      "url": "https://…",
      "tags": [ { "tag": "西瓜肚", "source": "seed|related|autocomplete", "weight": 1.0 } ],
      "assets": [ /* Asset[] 主资产 */ ]
    }
  ],
  "scanned": 6,
  "filtered": [ { "work_id": "149638093", "reason": "duplicate" } ]
}

// Asset（生产者只描述，不决定发不发）
{
  "asset_id": "asset-…",
  "type": "image | novel | metadata | cover",
  "role": "primary | cover | preview",
  "source": "pixiv | author | generated | unknown",
  "quality": "default | custom | unknown",   // generated/模板类资产 = default
  "width": 640, "height": 900,
  "mime": "image/jpeg", "bytes": 84213, "hash": "sha256:…",
  "locator": { "kind": "url | path | inline", "value": "…" }
}
```

**媒体策略归消费者**：生产者只做分类与描述（`source`/`quality`/`role`），是否随审核卡发送由 TelePost 决定。PixivFlow 现有的 `download.novelCover.unknown` 开关在过渡期保留（默认值 = 现行为），最终由 TelePost 的策略决定。

---

## 3 HTTP 面（v1）

| 方法 | 路径 | 用途 | 成功 |
|---|---|---|---|
| `GET` | `/capabilities` | 能力发现：协议版本、job 类型与 schema、资产类型/质量枚举、限额 | 200 |
| `POST` | `/jobs` | 提交 Task（幂等） | `202 { job }`，重复键返回同一 Job（200/202 均可，body 必须相同语义） |
| `GET` | `/jobs/{job_id}` | Job 投影（§2.2 全字段） | 200 / 404 |
| `GET` | `/jobs?idempotency_key=…&correlation_id=…&status=…&limit=…` | 查询与对账 | 200 `$defs/JobPage`（`{ jobs, next_cursor?, server_time? }`）；分页只能用**不透明游标**，禁止暴露生产者表 id |
| `POST` | `/jobs/{job_id}/cancel` | 取消（尽力，返回最终投影） | 200 |
| `GET` | `/jobs/{job_id}/events?after=…&unacked=1` | 事件历史与对账（消费者补拉未 Ack 事件） | 200 `$defs/EventPage`（`{ job_id, events, next_after?, unacked?, server_time? }`，按时间**升序**，`next_after` 直接回传当游标）|
| `POST` | `/jobs/{job_id}/events/ack` | 消费者回写「已持久记录到哪条」（补拉后的确认） | 200 `$defs/AckResult`（`{ job_id, acked, unacked }`）|
| `POST` | `{callback_url}` | 事件投递（生产者 → 消费者），消费者返回 2xx 即 Ack | 2xx |

约定：

- 认证：`Authorization: Bearer <token>`；token 按调用方（消费者实例）签发，能力范围由 `/capabilities` 声明。
- 所有时间字段为 **epoch 毫秒整数**；所有 ID 为不透明字符串。
- 幂等：同 `idempotency_key` 必须解析到**同一个** Job（含跨进程/重启/集群）；键冲突但参数不同 → `409 { error: { code: "idempotency_conflict" } }`。
- 未知字段忽略；`protocol_version` 不支持 → `400 { error: { code: "unsupported_protocol_version" } }`。
- 列表与批量：所有查询有 `limit`（默认 100，上限 500）。
- **确认有两条路**：回调 `POST {callback_url}` 返回 2xx（推送路径），或消费者补拉后 `POST /jobs/{job_id}/events/ack {ack_through}`（拉取路径）。`ack_through` **单调、幂等**，未知或更旧的 `event_id` 一律按 no-op 接受（不得报错），且 **ack 绝不改变 Job 状态**——确认不是状态迁移。消费者必须在**持久化之后**才 ack（先确认后落库等于数据丢失）。
- 生产者的 `unacked` 必须反映真实未确认数（含回调死信），否则对账无法发现「投递失败」；`job.accepted` 之前不得回 202。

### 3.1 兼容（过渡期，v1 内保留，v2 移除）

| 今天 | v1 等价 | 过渡策略 |
|---|---|---|
| `POST /internal/targets/{target}/refetch {requestId, correlationId}` | `POST /jobs {job_type:"candidate_search", idempotency_key:requestId, correlation_id:correlationId}` | 旧端点保留为 shim，内部转成 Job；响应字段 `slotId` 保留 |
| `GET /internal/targets/{target}/refetch/{requestId}` | `GET /jobs/{job_id}`（或 `?idempotency_key=`） | shim：旧路径按幂等键解析 Job 后返回**增强后**的投影（旧字段保留、新增字段） |
| `refetchOutcomeUrl` + `disposition` | 事件回调 `job.failed` / `job.succeeded` + `error.code` | 同一持久义务机制；旧回调体在过渡期继续发送（双写），TelePost 优先读事件 |
| 投递字段 `refetch_request_id = {{refetchRequestId}}` | 投递字段 `correlation_id` / `job_id` | 消费者兼容读旧字段；新配置只写通用字段 |
| `slot_name='审核群重抓'` | `labels.origin`（不透明） | 停止使用业务名，生产端不得按名字分支 |
| `manual_request_id` 列 | `jobs.idempotency_key` | 列保留（additive），语义通用化 |
| `download.novelCover.unknown` | `Asset.quality` + 消费者策略 | 开关保留，默认 = 现行为 |

---

## 4 Job 状态机与预算

```
queued ──claim──▶ running ──▶ succeeded
   │                 │
   │                 ├──▶ failed      （error.code 必填，retryable 明确）
   │                 ├──▶ cancelled   （消费者取消）
   │                 └──▶ expired     （超过 deadline_ms；error.code=deadline_exceeded）
   └──▶ expired      （从未被 claim 且超过 queued 预算）
```

| 预算 | 默认（可按 job_type 在 `/capabilities` 声明） | 判据 | 终态 |
|---|---|---|---|
| 排队预算 | 30 min | `queued` 且无活跃租约超时 | `expired` / `queued_too_long` |
| 停摆预算 | 15 min | `running` 且 **心跳与状态都过期** | `expired` / `stalled_no_progress` |
| 硬上限 | `deadline_ms` | 绝对上限 | `expired` / `deadline_exceeded` |

规则：`heartbeat_at` 由生产者周期刷新（默认 30 s，`/capabilities` 声明）；**心跳或状态刷新即重置停摆时钟**；任何终态都必须带 `result` 或 `error`，且**必须产生一个终态事件**（至少一次，可对账）。长跑正常（2–20 分钟，排队可达数小时）**不得**因为「安静」被误判。

---

## 5 错误模型

```jsonc
{ "code": "no_candidate", "message": "human readable", "retryable": false, "detail": { } }
```

| code | 含义 | retryable |
|---|---|---|
| `no_candidate` | 搜完但没有可用候选（可能全是重复/被排除） | true |
| `source_error` | 上游（Pixiv）错误：网络、HTTP、下载、元数据 | true |
| `auth_error` | 上游凭证失效，必须有人先处理 | false |
| `quota_exceeded` | 限流/配额耗尽，退避后可再试 | true |
| `resource_busy` | 资源竞争，本次没能开始执行 | true |
| `queued_too_long` | 已准入但超出排队预算仍未开始 | true |
| `stalled_no_progress` | 已开始后失去心跳（进程中断/卡死）超预算 | true |
| `deadline_exceeded` | 整个 job 超过硬上限（含执行超时） | true |
| `cancelled_by_consumer` | 消费者取消 | false |
| `idempotency_conflict` | 同一 idempotency_key 用了不同参数 | false |
| `unsupported_protocol_version` | 生产者不支持所请求的协议版本 | false |
| `invalid_params` | 参数不满足 `capabilities` 声明的 `params_schema` | false |
| `delivery_failed` | 结果已产出，但交给下游投递平台失败 | true |
| `delivery_rejected` | 下游平台拒绝结果，契约或内容必须改变 | false |
| `delivery_abandoned` | 投递意图已无可用重试，被生产者收敛为失败 | true |
| `internal_error` | 生产者无法归类；诊断细节放 `detail` | false |

**禁止**用 `message` 文本做跨边界判断（现状：TelePost 靠 `reason` 字符串识别 `refetch attempt is obsolete`）。

### 5.1 封闭词表与生产者内部原因码的映射（阶段 B/C 的硬要求）

协议的错误码是**封闭集合**：生产者的内部原因码必须在 job facade 处映射到这张表，**不得**把内部码原样透出给消费者；否则消费者又要去理解生产者的私有词汇（这正是今天 `refetch attempt is obsolete` 那类字符串判断的成因）。

- 映射表是机器可读的：`protocol/v1/error-mapping.json` → `producer_internal`。`scripts/verify-protocol-v1.py` 会校验它：每个目标的协议码必须存在于 schema enum，且当生产者工作区可达时（`<repo>/src/scheduler/TargetOutcome.ts`），其 `TerminalReasonCode` 联合类型的**每个成员都必须被映射**——新增内部原因码而忘记给消费者语义会让验收脚本失败。
- `protocol_codes` 必须与 schema enum 完全一致（多一个漏一个都算失败），每个码都要给出 `retryable` 默认值。
- 载荷里带 `retryable` 时，**以载荷为准**；缺省时消费者回退到 `error-mapping.json` 的默认值。两者都不做「看 message 猜」。
- 现状映射（PixivFlow `TerminalReasonCode`，19 个 → 16 个协议码；`filter_exhausted`/`duplicate_exhausted`/`no_candidate` 都并到 `no_candidate`，`stalled_no_heartbeat` → `stalled_no_progress`，`configuration_error` → `internal_error` 并在 `detail.internal_code` 里保留原名）。
- 兼容期例外：**legacy `/refetch/status` 端点继续返回内部码**（诊断价值），只有 `GET /jobs/{job_id}` 走映射；这正是「shim 与协议面分离」的用意。
- `Job.status` 的对应关系同理：生产者内部 `partial` 视为**成功但带警告**，映射为协议 `succeeded`，明细放 `progress`/`error`；内部 `claimed` 属生产者的记账细节（可由 `status != queued` 推出），facade 可以丢弃。

---

## 6 job_type 目录（v1）

### 6.1 `candidate_search`（首个落地；取代 `refetch`）

```jsonc
"params": {
  "source": { "platform": "pixiv", "account": "default" },
  "query": { "tags": ["西瓜肚"], "expand": true },
  "constraints": {
    "exclude": [ { "kind": "work", "id": "149713091" } ],
    "limit": 1, "scan_limit": 5,
    "work_types": ["illustration","novel"]
  }
}
```

- `constraints.exclude` 是**通用排除**（今天对应「排除当前候选 + 已投过的作品」），生产端不解释其业务含义。
- `GET /capabilities` 里 `candidate_search.params_schema` 指向 `#/$defs/CandidateSearchParams`（本仓 `protocol/v1/protocol.schema.json`），消费端据此在本地先校验参数，而不是靠「发过去看什么错」。
- `query.tags` 由消费者给定；`expand=true` 表示允许生产者做召回扩展（关联 tag / autocomplete），但**匹配依据必须回传** `matched_tags[{tag, source, weight}]`，让消费者自行决定是否采纳。
- 这也正是「Tag Query Engine」的边界：生产者只回答「给我这些 tag 的排序候选」，**不判断是否进入审核**。

### 6.2 预留（不在本阶段实现，仅声明扩展方式）

`asset_fetch`（按 work_id/id 取资产）、`tag_query`（纯 tag → 排序候选，无下载）、`publish_probe`（平台可达性探测）。新增 job_type 只走 `/capabilities` + 本文件新增小节，**不新增专用端点**。

---

## 7 事件类型

| type | 时机 | payload |
|---|---|---|
| `job.accepted` | 幂等解析成功、Job 已持久化 | `{ job }` |
| `job.started` | 取得租约、开始执行 | `{ job }` |
| `job.progress` | 阶段变化（可选、限频） | `{ job }` |
| `job.succeeded` | 终态成功 | `{ job, result }` |
| `job.failed` / `job.expired` / `job.cancelled` | 终态失败 | `{ job, error }` |

投递语义：

1. **至少一次**：生产者持久化「未 Ack 事件」为义务，重试直到 2xx 或达到死信上限。
2. **去重**：消费者按 `event_id` 去重（唯一索引）。
3. **对账**：消费者可用 `GET /jobs/{job_id}/events?unacked=1` 与 `GET /jobs?status=…` 补拉，再用 `POST /jobs/{job_id}/events/ack` 回写游标；生产者的死信必须**可被对账发现**（不得像今天那样：`kind='notification'` 死信后无人知晓）。
4. **确认≠终态**：回调未到、ack 未到都**不能**推断作业成功或失败；唯一判据是 `GET /jobs/{job_id}.status` 与事件流。**「没收到回调就当作没发生」正是本次静默事故的根因**。
5. **顺序**：不保证；消费者按 `at` + `job.status` 幂等归并（`EventPage` 按 `at` 升序返回，`next_after` 可直接当游标）。

---

## 8 反耦合清单（DO NOT）

1. 禁止在协议对象里出现消费者业务名词（review / 审核 / 重抓 / 替换 / 发布 / 卡片）。
2. 禁止「专用端点 + 专用字段」成对新增；新需求必须归入既有对象。
3. 生产者不得读消费者数据库/状态；消费者不得读生产者内部表（只能读协议投影）。
4. 关联只允许 `idempotency_key` / `correlation_id` / `job_id` / `labels`，且生产端不得解释其内容。
5. 跨边界状态只用协议枚举；`progress.stage` 仅供展示，不得用于控制流。
6. 失败判断只看 `error.code`，不得匹配 message 文本。
7. 事件不得依赖「单次 HTTP 成功」；必须有幂等键、去重键与对账入口。
8. 协议只增不改；未知字段忽略；语义变更走大版本。
9. 任何跨边界调用必须有超时预算与幂等键，生产者不得无限运行。
10. 契约变更必须同时更新 `docs/protocol/v1/` 的 schema/fixtures 与**两仓**契约测试。

---

## 9 面向未来的扩展（协议必须已能承载）

| 未来需求 | 协议如何承载（不需要新的耦合） |
|---|---|
| 自动发布 | 新 `job_type`（如 `publish`）或由 TelePost 自行编排；协议对象不变 |
| 多平台发布 | `source.platform` / `delivery` 作为参数与能力声明，而非新端点 |
| 多 Pixiv 账号 | `source.account` + `resource_busy`/`quota_exceeded` 错误码；`labels` 携带账务标识 |
| 多来源采集 | `GET /capabilities` 声明 `sources[]`；`correlation_id` 与 `labels` 保持不变 |
| WebUI 任务控制 | 复用 `GET /jobs?...`、`POST /jobs/{id}/cancel`；WebUI 读协议投影即可 |
| 集群部署 | 幂等键全局唯一 + 租约/心跳 + `GET /jobs` 对账；**协议不得假设单实例或内存状态** |
| 消费者多实例 | 事件按 `event_id` 去重；`correlation_id` 携带实例标识 |

---

## 10 落地顺序（与 `refetch-silent-failure-cure.md` 的关系）

1. **阶段 A（进行中）**：两侧 Job 生命周期可信 —— 生产者补状态投影时间戳、停摆清扫、`finish()` 收敛被遗弃投递；消费者建持久 Job + 30 s 心跳 + 活性预算 + 启动恢复 + 终态必通知 + doctor 监控。**这是协议的前提**：投影不可信，协议再漂亮也只是换名字。
2. **阶段 B**：生产者把既有 slot/execution 机制**包一层 job facade**（`POST /jobs`、`GET /jobs/{id}`、`GET /capabilities`），旧 refetch 端点降级为 shim；不重写执行引擎。
3. **阶段 C**：消费者切到通用 Job API；`refetch_request_id` 等业务字段迁移为 `correlation_id`/`job_id`。
4. **阶段 D**：事件持久义务 + 对账（取代单次 `refetchOutcomeUrl` 成功假设）；Result/Asset 描述符落地，媒体策略归消费者。
5. **阶段 E**：契约测试与 fixtures 双仓校验；文档同步（本文件为 SSOT）。

## 11 阶段 B / C 的文件级落地映射（避免实现时又长出耦合）

本节把第 3 节的 HTTP 面钉到**既有机制**上：B 阶段只是「包一层 facade」，不重写执行引擎；C 阶段只换消费者的一处端口。写在这里，是为了让两个仓库的实现者按同一张表改，而不是各自发挥。

### 11.1 生产者（PixivFlow，B 阶段）

| 协议元素 | 落到哪里 | 规则 |
|---|---|---|
| `GET /capabilities` | `src/scheduler/ScheduleTriggerServer.ts`（沿用现有 trigger/refetch token 鉴权） | 声明 `job_types:[candidate_search]` 与预算；预算值来自配置（`queuedTimeoutMs`/`stallTimeoutMs`），**不得**由调用方硬编码 |
| `POST /jobs` | 新 handler，复用 `SchedulerCommand` 的 admission（现 `src/commands/SchedulerCommand.ts:175-217`） | 请求体是 `Task`；`job_type` 未知 → `400 unsupported?`→ 用 `invalid_params`；目标不唯一 → `409`（沿用 `ambiguous target` 语义，但 body 为协议 `Error`） |
| `GET /jobs/{job_id}` | `src/scheduler/JobProjection.ts`（A 阶段已建） | 投影即 Job；`job_id` 对消费者不透明（v1 实现上等于 slotId，但**禁止**在协议里暴露 `slot*` 语义字段名） |
| `GET /jobs?idempotency_key=…` | `SlotRepository.findManualSlot` 一族 | 重放同一 `idempotency_key` 必须返回**同一个** job（幂等可视） |
| `POST /jobs/{job_id}/cancel` | 一个事务：slot + cells → 终态 | 走既有 cell FSM，不新增 cell 状态：`failed` + `terminal_reason_code='cancelled_by_consumer'`，作业 `error.code='cancelled_by_consumer'`。**取消是「作业已终结」而不是系统故障**：生产者必须把它记成可辨认的原因码（`cancelled_by_consumer` 同时是生产者内部原因码之一，映射到同名协议码），并且取消不得计入 alertable / `business_status=failed`，否则每次用户取消都会误告警 |
| `GET /jobs/{job_id}/events?unacked=1` | 既有 `delivery_events` | 事件至少一次；`event_id` 去重；回调 POST 与 Ack/对账属 D 阶段（替代 `refetchOutcomeUrl` 的单次成功假设） |

**身份（同时修掉 RC10）**：`job_id = slotId`、`idempotency_key = manual_request_id`；B 阶段新增迁移，给 `manual_request_id` 加**非空唯一索引**，老旧 refetch shim 把 `{requestId}` 翻译成 `Task{job_type:'candidate_search', idempotency_key:requestId, correlation_id}`，于是两个入口共用**同一身份空间**，同一请求不会铸出两个 slot / 两次投递。

**`candidate_search` 参数 → 既有配置**：`source.platform='pixiv'`；`source.account` → `pixiv-account:<accountId>` 资源键；`query.tags` → 该 target 的检索 tag 覆盖；`constraints.exclude` → 候选排除集合；`limit`/`scan_limit`/`work_types` → 既有扫描与类型开关。v1 的 `params` **只允许**覆盖检索与约束，不得覆盖投递目标、delivery 字段、计划身份。

**B 阶段禁止**：新增 `refetch*` 前缀字段/端点；按 `slot_name='审核群重抓'` 之类的业务值分支；改动既有 `slot_name` 取值（历史行还在库里，迁移属于更后面的阶段）；给两个入口各写一套执行路径。

**取消的落地顺序（已确认的坑）**：`TerminalReasonCode` 现有 19 个成员里**没有**任何「取消」语义，直接写 `terminal_reason_code='cancelled_by_consumer'` 会绕过 `OPERATIONAL_REASON_POLICY` 的类型约束并让消费者拿到未映射的内部码。因此 B 阶段要按顺序做：(1) 给 `TerminalReasonCode` + `OPERATIONAL_REASON_POLICY` 补上 `cancelled_by_consumer`（retryable=false，且**不计入** alertable/`business_status=failed`）；(2) 由 SSOT 侧在 `error-mapping.json` 的 `producer_internal` 补同一行（`cancelled_by_consumer` → `cancelled_by_consumer`）并同步两仓副本；(3) 之后 `scripts/verify-protocol-v1.py` 的 union 覆盖率检查才会重新变绿 —— 顺序反过来会先红后绿，属预期。

### 11.2 消费者（TelePost，C 阶段）

| 协议元素 | 落到哪里 | 规则 |
|---|---|---|
| `PixivFlowJobClient`（`submit`/`get`/`cancel`/`capabilities`） | `telepost/application/pixivflow_jobs.py`（A 阶段已建） | **全仓唯一**知道协议 URL 的模块；其它模块（含 `handlers/review.py`）不得自己拼 `/internal/targets/...` |
| 切到 `POST /jobs` / `GET /jobs/{id}` | 只改该端口的 URL 与报文映射 | v1 期间默认仍走旧 URL；切换等于改一处 + 配置开关 |
| Job ↔ 审核的语义 | `telepost/application/review_queue.py` 的替换逻辑（现 `:598-660`） | 生产者只给候选；**替换哪条审核、是否替换、是否发布**全部留在消费者 |
| `Asset`（`type/role/source/quality`） | TelePost 媒体策略 | `source='generated' & quality='default'` 等判定是**消费者**的策略输入，生产者不得自己丢/留资产 |
| 心跳与预算 | A 阶段的心跳循环 | 只允许依据 `status` + `heartbeat_at`（缺失时 `updated_at`）+ 时间戳判定停摆；**禁止**按 `progress.stage` 文案或远端业务名判状态 |

### 11.3 B 阶段验收清单

1. `GET /capabilities` 列出 `candidate_search`，且其预算与配置一致（改配置 → 能力声明跟着变）。
2. 同一 `idempotency_key` 提交两次 → 同一个 `job_id`，且没有第二个 slot、第二次投递（DB 断言）。
3. `GET /jobs/{id}` 在 `queued`/`running`/终态下都带 `created_at/updated_at`，进行中带 `heartbeat_at` 与 `lease_active`。
4. 未知 `job_type` / 非法 `params` / 未知 `job_id` / 协议大版本不匹配 → 协议 `Error`（`invalid_params` / `unsupported_protocol_version`），**不回退到字符串判断**。
5. `cancel` 后 `status='cancelled'` 且不再产生投递；重复 cancel 幂等。
6. `grep` 断言：`/jobs` 面不出现 `refetch*` 字段名，且既有 `slot_name` 取值未被改写。
7. 契约测试新增一条：把**真实产生的 Job 投影**用 `protocol/v1` 的 `$defs/Job` 校验通过（满足 `protocol/README.md` §2 第 1 条要求的「真实报文」部分）。


### 11.4 D 阶段：事件与 Ack/对账的文件级映射（不要造第二套投递）

现状（2026-09-28 核实）已经具备**至少一次 + 幂等键去重**的雏形，D 阶段要复用它而不是新建通道：

| 协议义务 | 现有实现（复用点） | D 阶段要补的 |
| --- | --- | --- |
| 事件落库（append-only） | `delivery_events` 表（`src/storage/DatabaseMigration.ts:187-202`，`id INTEGER PRIMARY KEY AUTOINCREMENT` 单调）；写入 `OutboxRepository.recordEvent`（`src/storage/repositories/OutboxRepository.ts:397-412`，短 JSON、不存密钥） | 事件体要能投影成协议 `$defs/Event`（`event_id`/`job_id`/`type`/`at` + 可选 `progress`/`error`），因此需要 `slot_id → job_id` 与内部事件名 → 协议 `type` 的**映射表**（放 facade，不写进表） |
| 事件读取 | `OutboxRepository.listEvents({executionId?, outboxId?, limit?})`（`:423-435`，`ORDER BY ts DESC, id DESC`，limit ≤ 500） | 增加按 `slot_id` 读取 + `after=<event_id>` 游标（升序），协议 `GET /jobs/{job_id}/events?after=` |
| 终态回调（至少一次 + 去重） | `NotificationPolicy.noteRefetchOutcome`（`src/notification/NotificationPolicy.ts:267-323`）→ `DeliveryService.enqueueNotification(...)`（`:311-316`），幂等键 `refetch-outcome:<slotId>:<targetId>`（`:64`）；disposition 只有 `no_alternative` / `failed`（成功由投稿负载自带的 request id 关联） | 通用化为「job 事件投递」：同一个 outbox 通道，`callback_url` 来自 `Task`/能力协商，事件体是 `$defs/Event`；`refetchOutcomeUrl`（`src/config/types.ts:720`，校验 `src/config/validation.ts:432-437`）保留为 v1 shim |
| Ack / 对账 | 无（生产现状：`pixivflow/config/production.json` 的 `delivery.targets.bot1-submit` 就是 `type:"httpMultipart"` + `refetchOutcomeUrl: ${TELEPOST_API_BASE_URL}/api/bot1/v1/refetch/outcomes`，bot2 同形） | 消费者持久化 `(job_id, last_event_id)` 游标并显式 ack；`unacked=1` 或游标落后即可重放。**禁止**为 ack 新建第二套队列——它只是读游标 |
| 死信可发现 | outbox 死信行 + `pixivflow outbox retry <id>`（`docs/CONFIG.md` refetch 段落） | 协议侧暴露「有终态 job 的最后一个事件仍是未确认」的计数（`doctor`/CLI 任一即可），不做自动重投 |

约束：

1. **不新增第二套投递系统**：事件通道就是既有 outbox + `delivery_events`；若某事件走不通（例如目标 `type !== 'httpMultipart'` 时 `noteRefetchOutcome` 直接 return，见 `NotificationPolicy.ts:276`），那是**能力声明**的问题（`/capabilities` 应如实说明回调可用性），而不是再写一条通路。
2. **回调失败不改终态**：现有实现只 `logger.warn` 并依赖 outbox 重试；协议侧同理——事件投递失败只影响「消费者多快看到」，不影响 job 终态。
3. **消费者不得靠「没收到回调」判定作业失败**：必须以 `GET /jobs/{id}` + 游标对账为准（这正是「重抓静默」的根因：回调丢了就永远没有下文）。
4. 协议事件名与内部事件名的映射放 facade，**禁止**把 `delivery_events.event` 的字面量当协议枚举使用。

## 12 已知耦合清单与收口计划（机器可校验）

「只在一处知道对方内部路径」不能靠自觉，必须能被 CI 拒绝。`scripts/verify-protocol-v1.py` 的离线检查已加入两项静态门：

| 门 | 规则 | 现状（2026-09-28 实测） |
| --- | --- | --- |
| `check_boundary_discipline()` | 扫描 TelePost 检出的 `**/*.py`，`/internal/targets/` 字面量只允许出现在**唯一端口** `telepost/application/pixivflow_jobs.py`；其它文件出现即 **FAIL**（打印 `文件:行号`） | 端口 4 处 OK；3 个文件命中但已进「已知耦合」白名单 → 只 SKIP，不 FAIL |
| `check_producer_protocol_codes()` | `PixivFlow/src/scheduler/ProtocolErrors.ts` 的 `ProtocolErrorCode` 必须与 `$defs/Error.code.enum` **完全一致**（缺码或自造码都 FAIL） | 16 个码完全一致 |

白名单（`BOUNDARY_KNOWN_LEAKS`，每条都要有出处与收口计划，**禁止**往表里新增而不写理由）：

| 文件 | 事实 | 收口计划 |
| --- | --- | --- |
| `telepost/application/refetch.py:215-217,419-468` | 仍保留一个「handlers.review 不可导入」时的兜底提交器 `_default_submit_pixivflow_refetch`，**自己拼** `/internal/targets/{t}/refetch`（端口之外的第二套 HTTP 客户端） | C 阶段收口：提交/读取一律经端口（`handlers.review._refetch_client()` 或 `pixivflow_jobs_port`），删除该兜底器；如需无循环兜底则让它**委托端口**而不是重建 URL。删除后同步移出本白名单，门自动变紧 |
| `telepost/application/recovery.py:229` | `POST /internal/targets/{target}/recover` —— 非 Job 面的 PixivFlow 内部命令 | 协议 v2：以 `/capabilities` 如实声明 + 或在 v1 内明确列为「非协议面」并停止扩张；本轮不动（不属 v1 范围，也不在本轮改造范围） |
| `telepost/domain/refetch_state.py:130` | 仅注释里提到远端路径，无调用 | 无需处理（保留在表里以减少评审噪音） |

反向验证（防止门本身失效）：在临时检出里放一个 `/internal/targets/` 新泄漏 → 实测 `[FAIL] 出现新的 PixivFlow 内部路径耦合：handlers/leak.py:2`，退出码 1。

卫生要求：调试用的临时测试文件（如 `tests/test_zzprobe.py`）**不得提交**；端口收口完成后，`telepost/application/refetch.py` 必须从白名单移出。
