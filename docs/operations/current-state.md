# PixivFlow Ecosystem Current Production State

Snapshot: 2026-09-19
Authority: Current production evidence overrides this file

本文件保存动态状态。

它不是永久事实。

任何 Agent 开始工作前必须重新验证关键项，并在完成任务后同步本文件。

---

# 1. Status Vocabulary

只使用：

* `VERIFIED`
* `IMPLEMENTED_NOT_VERIFIED`
* `IN_PROGRESS`
* `PLANNED`
* `KNOWN_DEBT`
* `BLOCKED_EXTERNAL`
* `EXTERNAL_ACCEPTANCE_REQUIRED`
* `FAIL`

禁止：

* 基本完成
* 应该正常
* 大概没问题
* 预计能用

---

# 2. Last Known Production Baseline

最近明确记录的生产 baseline：

```text
PixivFlow: 2.34.0 / 578ff0ef
TelePost: 2.45.1
TelePress: 0.10.0
```

这是 handoff 信息。

开始 release/deploy 任务前必须重新核实：

* repository HEAD
* release
* image
* Deploy pin
* runtime revision

---

# 3. Production Scheduling

Status: `VERIFIED_WITH_EXTERNAL_CHECK`

当前目标：

```text
bot1: 每天 10:00 Asia/Shanghai
bot2: 每天 10:10 Asia/Shanghai
```

每天一次。

SECONDARY 已按单次调度方向配置。

PRIMARY 使用 cron-job.org。

必须确认外部 SaaS 中旧晚间 trigger 已经关闭。

调度合同：

```text
production.json
↔
control-plane cron map
↔
wrangler / Cloudflare
↔
external PRIMARY
↔
contract tests
```

Cloudflare Cron 使用 UTC：

```text
10:00 CST → 02:00 UTC
10:10 CST → 02:10 UTC
```

Slot Ledger 负责 PRIMARY / SECONDARY 幂等。

历史已过 expiry 的 slot 不 back-fill。

---

# 4. Historical Clock Incident

Status: `CLOSED_AS_INCIDENT`

曾发生外部 clock / watchdog 相关生产事故。

对应 slot 超过 grace 后不补跑。

正确处理：

* incident record
* watchdog
* clock contract verification
* future prevention

不为了历史记录好看而人为补成功。

---

# 5. Candidate Observability

Status: `IN_PROGRESS`

当前已经能够看到类似：

```text
候选扫描：72
重复：12
过滤：60
最终候选：0
待发池：0
判断：candidate_supply_low
```

相比过去：

```text
没找到合适的新作品
```

已有明显改善。

仍需验证：

* Illustration / Novel 是否都完整持久化 candidate report
* Slot Ledger / TargetOutcome 是否一致
* WebUI 是否完整显示
* TelePost 是否完整显示
* classification 是否仍存在误分类

---

# 6. bot1 Content Supply

Status: `KNOWN_DEBT`

bot1 / ボテ腹 长期存在低供给问题。

已观察到：

```text
fetched
→ 大量 AI / policy filtering
→ duplicate exhaustion
→ final candidate = 0
```

这不是：

* scheduler failure
* Pixiv API global failure
* token failure

而是：

```text
content supply problem
```

当前通过“每天一次”降低消费速度。

根本能力仍未实现：

* Topic Health
* Topic Profile
* related tag strategy
* Candidate Inventory
* candidate reservation
* supply forecasting
* adaptive ranking/fallback

---

# 7. Novel Failure

Status: `FAIL`

当前仍出现过：

```text
小说：执行失败
原因：内部错误
```

这是当前 P0。

必须追踪：

```text
Candidate
↓
NovelDownloader
↓
filter
↓
media parsing
↓
artifact
↓
rich preview
↓
delivery
↓
TargetOutcome
```

找到真实异常第一次被压平成 `INTERNAL_ERROR` 的位置。

完成标准：

任何 Novel failure 至少包含：

```text
code
stage
reason
retryable
operator_hint
request_id / correlation_id
```

只返回 `INTERNAL_ERROR` 时，不得认为 Failure Contract 已闭环。

---

# 8. Recovery

Status: `EXTERNAL_ACCEPTANCE_REQUIRED`

历史真实根因包括：

1. TelePost recovery request id 使用无连字符 UUID，而 PixivFlow 接口要求标准 UUID。
2. callback error helper 不接受 `show_alert`，导致真实错误再次被异常覆盖。

已知修复包括：

* 标准 UUID
* structured remote error
* 正确 4xx classification
* 不吞掉真实错误

代码、release、deploy 曾完成。

仍需真人管理员完成真实 Telegram：

```text
Retry
Relaxed Retry
```

E2E 验收。

WebUI Recovery 必须复用同一 Recovery service。

---

# 9. Retry Button UX

Status: `KNOWN_DEBT / PARTIAL`

多个 target 同时失败时，历史 UI：

```text
[再试一次] [放宽条件重试]
[再试一次] [放宽条件重试]
```

实际 callback target 不同。

目标 UX：

```text
[重试·插画] [放宽·插画]
[重试·小说] [放宽·小说]
```

按钮文本改善不能改变 callback identity。

---

# 10. Retry Semantics

Status: `IN_PROGRESS`

“放宽条件重试”不能继续作为所有 no-candidate 的万能动作。

应该根据 Candidate Report 给出不同建议：

```text
duplicate exhaustion
→ 扩时间范围可能有帮助

language filter dominant
→ 检查语言策略

candidate supply low
→ 调主题 / related tags / frequency

no content today
→ 等待下一周期
```

Hard constraints 不允许由 relaxed preset 随意取消。

---

# 11. PixivFlow WebUI Launcher

Status: `VERIFIED`

已验证：

```text
pixivflow web
```

可以启动 Web server/frontend。

因此 launcher 已不再只是规划。

---

# 12. PixivFlow Control Center

Status: `IN_PROGRESS`

已有基础 WebUI 能力。

已知 Logs / Files / Config 等页面存在。

仍未完整闭环：

* Dashboard ↔ real execution truth
* Scheduler
* Slot Ledger
* Execution detail
* Candidate Report visualization
* Artifact ↔ slot/execution lineage
* Failure Center
* Recovery history
* safe recovery write operations
* candidate supply health

完成标准：

> 操作者能通过 WebUI 解释某个 scheduled slot 从触发到终态发生了什么。

页面能打开不等于 Control Center 完成。

---

# 13. Recovery Write Safety

Status: `IN_PROGRESS`

WebUI Recovery 写操作必须评审：

* authorization
* CSRF / origin protection
* request idempotency
* double-click/concurrency
* allowed terminal states
* relaxed retry eligibility
* audit
* operator identity
* destructive-risk boundary

不能为了“完成 Phase 4”绕过安全评审。

---

# 14. Operational Result Contract

Status: `IN_PROGRESS`

PixivFlow 已经具备或曾发布：

```text
stage
retryable
operator_hint
reason
candidate_report
```

仍需验证：

* Novel path
* Recovery
* Refetch
* publish retry
* notification
* TelePost rendering
* WebUI rendering

只要真实生产仍出现不可解释的 `INTERNAL_ERROR`，就不能标记 VERIFIED。

---

# 15. Failure Center

Status: `PLANNED / PARTIAL`

目标模型：

```text
Failure

source
target
slot
execution
stage
code
reason
retryable
operator_hint
logs
recovery lineage
```

操作：

```text
Retry
Relaxed Retry
Inspect
View Logs
Acknowledge / Ignore
```

不得建立 WebUI-specific 或 TelePost-specific 第二套 failure truth。

---

# 16. Media Architecture

Status: `PLANNED`

当前仍存在强耦合：

```text
发现作品
→ 下载媒体
→ 传本地文件
→ 下游消费
```

目标：

```text
Work
MediaAsset
Artifact
DeliveryVariant
```

仍未正式完成：

* canonical MediaAsset model
* cross-service media manifest
* lazy materialization
* consumer-driven materialization
* DeliveryVariant model

这是后续核心架构工作。

---

# 17. Telegram Media Delivery

Status: `PLANNED`

当前仍大量使用：

```text
PixivFlow download
→ multipart
→ TelePost
→ Telegram
```

目标优先级：

```text
1. Telegram file_id / copyMessages
2. remote proxy URL
3. Telegram DeliveryVariant
4. PixivFlow materialized file fallback
```

尚未完成：

* TelegramMediaCache
* bot-specific file_id mapping
* file_unique_id identity usage
* copyMessages-first publication
* proxy URL delivery
* size-aware fallback

---

# 18. TelePress Current Model

Status: `IN_PROGRESS`

当前已具备：

* Markdown renderer
* Telegraph publisher
* image-host abstraction
* `/publish/rich-novel`
* Rich Novel asset result
* TXT / Markdown / ZIP related support

历史设计仍然较强依赖：

```text
image host
+
Telegraph
```

---

# 19. TelePress External Image Hosting Problem

Status: `BLOCKED_EXTERNAL / ARCHITECTURE_DEBT`

真实生产测试曾发现：

```text
Catbox
→ 412 Invalid uploader

Telegra.ph /upload
→ 400 Unknown error
```

因此：

外部图片上传不能继续作为 Rich Novel 成功的强制前置条件。

不应继续围绕 Catbox 412 无限 patch。

---

# 20. TelePress Target Architecture

Status: `PLANNED`

目标：

```text
TelePress
├── Web Reader
├── Telegraph Renderer
├── ProxyProvider
└── UploadProvider
```

Pixiv MediaAsset 优先：

```text
source URL
→ Pixiv proxy
→ public URL
```

只有 local-only artifact 才走：

```text
UploadProvider
```

Catbox 降为 optional provider。

Telegraph 降为 renderer。

---

# 21. Pixiv Media Proxy

Status: `PLANNED`

优先复用成熟社区实现：

* Pixiv.Cat 类实现
* pximg proxy 类实现
* 其他维护活跃、许可兼容的方案

不要从零开发完整 Pixiv proxy。

候选部署方向：

```text
Cloudflare Worker Free
```

目标：

* 不新增独立服务器
* 不要求独立公网 IP
* 不要求对象存储
* 降低 Fly 图片 egress
* 在个人规模下尽量保持新增成本接近 0

任何真正采用的方案必须重新调查当时的维护状态、license、安全性和成本。

---

# 22. Rich Novel Preview

Status: `IN_PROGRESS`

最终不应强制：

```text
Markdown
→ upload every image
→ Telegraph
```

目标：

```text
NovelDocument
+
MediaReference[]
→ TelePress
→ renderer decides
```

TXT / ZIP / local artifacts 与公网 preview 解耦。

Preview provider 故障时：

不得把本地小说处理一起判为 `INTERNAL_ERROR`。

---

# 23. Admission Policy

Status: `TARGET_POLICY`

当前正式规则：

```text
Telegram human submission
→ DIRECT_PUBLISH

Mini App human submission
→ DIRECT_PUBLISH

API automated submission
→ REVIEW_REQUIRED
```

必须审计代码中是否仍有旧策略残留。

---

# 24. Submission / Review Model

Status: `IN_PROGRESS`

目标：

```text
Submission
↓
Admission Policy
├── DIRECT_PUBLISH
└── REVIEW_REQUIRED
```

仍需继续清理：

* Submission 与 Review 混淆
* handler-specific admission
* Review Queue 与“我的投稿”混淆
* Notification 与 Review 混淆

---

# 25. Admin Notification

Status: `PARTIAL`

所有来源：

```text
chat
miniapp
api
```

均可通知管理员。

Admin Notification 不等于 Review。

Admin DM 当前已有部分 quick action 能力。

复杂操作最终进入 Admin Space。

---

# 26. Mini App

Status: `PLANNED / PARTIAL`

必须拆分：

```text
User Space
Admin Space
```

User Space 目标：

* 首页
* 投稿
* 我的投稿
* 搜索
* 标签云
* Hot
* 帮助
* 设置
* soft delete

“我的投稿”：

```text
Submission history
```

不是 Review Queue。

Admin Space：

* Dashboard
* Review
* Review History
* All Submissions
* Failure
* User Governance
* API Governance
* Moderation
* Audit

---

# 27. Moderation

Status: `IN_PROGRESS`

目标 subject：

```text
user:<id>
api:<id>
```

目标 state：

```text
active
expired
removed
```

仍需确认：

* expiration
* removal audit
* admin UI
* history
* API integration

禁止物理删除治理历史。

---

# 28. Admin Control Plane

Status: `IN_PROGRESS`

当前 Admin DM 主要还是：

```text
notification
+
quick action
```

目标：

```text
Notification
↓
Context
↓
Action
↓
Audit
```

Admin DM 只作为快捷入口。

复杂管理进入 Admin Space。

---

# 29. Documentation Quality

Status: `KNOWN_DEBT`

当前已发现：

* 实现细节与用户行为混在一个段落
* Outbox 文档高度压缩
* 中文词语异常空格
* 特定“频道”场景被写成通用事实
* Catbox 曾被写成 TelePress 架构职责
* Planned / Implemented 状态可能混乱
* CLI 命令可能被挤在同一行

持续整理：

```text
README
architecture
operations
development
CONTRACT
AGENTS
```

---

# 30. Documentation Synchronization

Status: `MANDATORY`

任何以下变化都必须同步文档：

* architecture decision
* new feature
* provider change
* API contract
* production schedule
* deployment topology
* failure semantics
* recovery semantics
* security policy
* roadmap status
* incident
* blocker
* community adoption

文档漂移本身视为 defect。

---

# 31. Community Research

Status: `MANDATORY`

新增非平凡通用能力前：

必须先调查成熟社区项目、库、标准和参考实现。

调研结论必须记录。

避免未来 Agent：

* 重复做同一轮调研
* 重复造轮子
* 不知道某实现来源于 upstream
* 在已有成熟解决方案时重新设计整套系统

---

# 32. Security

Status: `ACTION_REQUIRED`

历史执行环境中曾误打印：

```text
TELEPRESS_API_KEY
TELEGRAPH_ACCESS_TOKEN
```

值。

虽然没有已知仓库提交证据，但应视为暴露。

需要确认：

* secrets 是否已轮换
* Fly 是否使用新 secret
* Git history 是否无泄漏
* CI logs 是否无持久化泄漏
* artifacts 是否无泄漏

未确认前不能标记 VERIFIED。

---

# 33. Recommended Priority

## P0

### Novel INTERNAL_ERROR

恢复真实 failure semantics。

### Operational Result Contract

确保异常不再被中间层压平。

### Security Rotation

如果尚未完成，优先轮换暴露 secret。

---

## P1

### Media Model

建立：

```text
Work
MediaAsset
Artifact
DeliveryVariant
```

### Telegram Media Delivery

减少强制 download + multipart。

### TelePress ProxyProvider

解除 external image host 强依赖。

### Rich Novel E2E

完成新的生产链真实验证。

---

## P1 / P2

### Candidate Supply

* Topic Health
* Topic Profile
* Candidate Inventory

### WebUI Control Center

让 Execution Truth 真正可见。

### Failure / Recovery Center

建立统一运营入口。

---

## P2 / P3

### Mini App

User/Admin 分离。

### Moderation

生命周期完整化。

### API Governance

正式 Admin UI。

### Admin Control Plane

减少 Telegram Bot 内继续堆按钮。

---

# 34. Completion Definition

整个生态只有满足以下条件才可称为 Platform Completion：

* Work / MediaAsset / Artifact / DeliveryVariant 正式落地
* PixivFlow 不再强制所有下游先下载
* Candidate supply 可以解释并预警
* scheduled execution 可以完整追踪
* Novel failure 不再只剩 INTERNAL_ERROR
* Recovery 真实 E2E 通过
* Telegram 可复用自身媒体缓存
* TelePress 不再强依赖 Catbox
* Rich Novel 生产 E2E 通过
* `pixivflow web` 能完整解释 Execution Truth
* Failure Center 可运营
* Mini App User/Admin 分离
* Admission Policy 正确
* Moderation 生命周期完整
* Admin actions 可审计
* 文档与生产事实一致
* 社区方案调研机制真正执行
* release/deploy/runtime 完整验证

否则必须明确标记：

```text
KNOWN_DEBT
BLOCKED_EXTERNAL
EXTERNAL_ACCEPTANCE_REQUIRED
FAIL
```
