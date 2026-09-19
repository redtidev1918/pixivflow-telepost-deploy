# PixivFlow Ecosystem Production Contract

本文件是当前**已经生效**的生产合同。

权威读取顺序：

1. `AGENTS.md`（Agent 执行纪律）
2. `docs/architecture/ecosystem-platform.md`（长期架构）
3. `docs/operations/current-state.md`（当前生产状态）
4. 本文件 `CONTRACT.md`（已经生效的生产合同）

状态词汇与全文统一：`VERIFIED` / `IMPLEMENTED_NOT_VERIFIED` / `IN_PROGRESS` /
`PLANNED` / `KNOWN_DEBT` / `BLOCKED_EXTERNAL` / `EXTERNAL_ACCEPTANCE_REQUIRED` / `FAIL`。
禁止把 PLANNED 写成已实现。

---

# 1. Repository Boundaries

- **PixivFlow**：内容发现 / 解析 / 候选筛选 / 调度 / 执行 / Slot Ledger / outbox / recovery / artifact。不持有 Telegram 凭据，不实现投稿业务。
- **TelePost**：Telegram Bot / Mini App / submission / admission / review / publication / notification / audit。不复制 Pixiv 调度与候选逻辑。
- **TelePress**：已审核内容的富媒体发布（Markdown / 图片 / Telegraph preview）。无业务状态、无持久库、不持有 Pixiv/Telegram 凭据。
- **PixivFlow WebUI**：Execution Truth 的观察入口。禁止浏览器直接访问数据库，禁止建立第二套状态源。
- **Deploy**：部署编排与跨仓权威文档。不把业务逻辑放进部署脚本。

# 2. Single Source of Truth

- Slot Ledger（`schedule_slots` / `schedule_slot_items`）= 调度执行的唯一事实。
- Delivery outbox = 外部副作用的 at-least-once 意图账本，幂等键去重。
- Submission / Review / Audit = 投稿、审核与操作审计的独立业务账本。
- WebUI 只见 read-only projection；Recovery 写操作必须走既有服务，不实现第二套 recovery。

# 3. Scheduler Contract

- 多个外部时钟只发送幂等触发；occurrence 计算、执行与收敛由 durable Slot Ledger 完成。
- 已过期 slot 超过 `grace` 后**不允许 back-fill**。
- 每个生产 occurrence 恰好一条 durable 终态通知（success / partial / failed 都不沉默）。
- `PRIMARY + SECONDARY + watchdog` 时钟合同必须可观测；下一次计划周期连续验证通过后方能标记 `VERIFIED`。

# 4. Execution Outcome Contract

- terminal reason 使用既有代码集（如 `no_candidate` / `duplicate_exhausted` / `download_failed` / `internal_error` 等），不得新增语义不明的通用错误。
- `no_candidate` 不等于“执行失败”；UI 必须区分正常无新内容 / 策略过窄 / 重复耗尽 / 候选供应长期偏低 / 真正执行失败。
- candidate funnel 字段（fetched / selected / rejected / reasons）必须从 Slot Ledger 持久化字段读出并展示。

# 5. Recovery Contract

- 只有终态 cell 可恢复；admission 投影：
  - `failed` → retryable + relaxed 允许
  - `no_candidate` / `duplicate` → 仅 relaxed（人工判断）
  - `submitted` / `pending` / `running` → 不可恢复
- 恢复请求必须带 UUID `requestId`（幂等键），可选 `correlationId`；并发点击重复提交由幂等键收敛。
- 每次恢复操作必须产生 audit 记录。
- WebUI 写操作只能通过服务端代理调用既有 recovery dispatcher，浏览器不得持有触发凭据。

# 6. Delivery / Publication Contract

- 投递走 SQLite outbox：一行一个外部副作用，带幂等键和行级租约；下游通过 `idempotent_replay` 或 `duplicate_existing` 收敛。
- Telegram 频道消息是业务侧展示，不是架构本体；不默认所有用户都有“频道”。
- Rich Novel 的本地 TXT / ZIP / Markdown 生成不依赖外部 image host；image upload 是 provider boundary，当前状态见 current-state。

# 7. Security Contract

- TelePost 是唯一持有 Telegram bot token 的服务；PixivFlow 不持有 Telegram 凭据。
- `TELEGRAPH_ACCESS_TOKEN` / `TELEPRESS_API_KEY` 只通过 Fly secrets 注入，绝不写日志 / 仓库 / release artifact。
- 已暴露的 secret 必须轮换；轮换后 Fly 使用新值，旧值从所有环境移除。
- 任何 agent 输出不得包含真实 secret，只允许占位符或 `sha256:` 指纹（安全审计场景）。

# 8. Documentation Contract

- 长期架构进 `docs/architecture/`。
- 动态生产状态进 `docs/operations/current-state.md`。
- Agent 纪律进 `AGENTS.md`。
- 生效生产合同进本文件 `CONTRACT.md`。
- 仓库内本地 `AGENTS.md` 只保留本仓边界与特殊约束，并指向跨仓权威文档。

# 9. Release / Deploy Contract

- 所有实际代码修改必须走：code → tests → PR → CI → merge → release → deploy pin → runtime verify → production verify。
- Docs-only 修改不需要无意义发版。
- 禁止伪造 PR / release / deployment / production verification。

# 10. Current Verified Baseline

最新 verified baseline 以 `docs/operations/current-state.md` 为准（不要在本文件更新版本号，避免双状态源）。
