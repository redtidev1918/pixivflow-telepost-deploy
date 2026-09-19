# PixivFlow Ecosystem Progressive Delivery Plan

Status: Active Execution Roadmap
Scope: PixivFlow / TelePost / TelePress / PixivFlow WebUI / Deploy
Authority: `pixivflow-telepost-deploy`

---

# 1. Purpose

本文回答一个问题：

> 当前生态下一步具体应该做什么？

它不是架构 RFC。

长期目标见：

`docs/architecture/ecosystem-platform.md`

当前生产状态见：

`docs/operations/current-state.md`

Agent 行为约束见：

`AGENTS.md`

本文负责：

* 阶段顺序
* 阶段依赖
* 每阶段目标
* 每阶段允许做什么
* 每阶段禁止做什么
* 验收条件
* 进入下一阶段的 Gate
* 可并行工作
* 文档同步要求

---

# 2. Execution Principle

本路线采用：

```text
渐进演进
+
生产优先
+
兼容优先
+
事实优先
```

禁止：

```text
先设计最终系统
→ 一次性大重构
→ 最后统一上线
```

正确模式：

```text
稳定现状
↓
建立事实
↓
补齐 contract
↓
解耦模型
↓
逐步切换消费者
↓
启用新能力
↓
淘汰旧路径
```

---

# 3. Global Phase Rule

每一个 Phase 都必须走：

```text
READ DOCS
↓
VERIFY CURRENT STATE
↓
COMMUNITY RESEARCH
↓
UPDATE DESIGN MEMORY
↓
IMPLEMENT MINIMAL SLICE
↓
TEST
↓
INTEGRATION VERIFY
↓
UPDATE DOCS
↓
PR / CI / MERGE
↓
RELEASE
↓
DEPLOY
↓
RUNTIME VERIFY
↓
PRODUCTION VERIFY
↓
UPDATE current-state.md
```

如果只是 docs / RFC：

不要求无意义 release。

---

# 4. Phase Status

每个 Phase 只能使用：

```text
NOT_STARTED
IN_PROGRESS
BLOCKED
IMPLEMENTED_NOT_VERIFIED
VERIFIED
DEFERRED
```

不要使用：

```text
差不多完成
基本完成
应该可以
```

---

# 5. Gate Rule

进入下一阶段前：

必须满足当前 Phase 的 Gate。

如果某项：

```text
BLOCKED_EXTERNAL
```

但不会破坏下一阶段正确性：

可以记录 blocker 后继续。

如果 blocker 会让下一阶段建立在错误假设上：

不得跳过。

---

# 6. Parallelism Rule

以下工作通常可以并行：

```text
文档同步
社区调研
只读 WebUI
测试补强
runbook
代码审计
```

以下工作通常不能乱序：

```text
失败语义
→ Failure Center

MediaAsset model
→ Telegram delivery optimization

Candidate observability
→ Candidate Inventory

Recovery correctness
→ WebUI recovery write
```

不要在基础 contract 还没稳定时先做高级 UI。

---

# 7. Phase 0 — Re-Baseline Production

Priority: P0
Goal: 重新确认“我们现在实际运行的是什么”。

这是任何长周期 Agent 接手后的第一步。

---

## 7.1 Verify Repositories

检查：

* PixivFlow HEAD
* TelePost HEAD
* TelePress HEAD
* WebUI HEAD
* Deploy HEAD

记录：

```text
branch
commit
release
image
deploy pin
runtime revision
```

---

## 7.2 Verify Scheduling

确认：

```text
bot1
10:00 Asia/Shanghai

bot2
10:10 Asia/Shanghai
```

检查：

* production config
* control-plane cron map
* Cloudflare
* cron-job.org PRIMARY
* contract tests

确认旧晚间 schedule 已关闭。

---

## 7.3 Verify Secrets

重点检查历史暴露：

```text
TELEPRESS_API_KEY
TELEGRAPH_ACCESS_TOKEN
```

如果尚未轮换：

优先轮换。

禁止打印新值。

---

## 7.4 Verify Production Health

至少确认：

* `/live`
* `/ready`
* `/status`
* scheduler health
* worker health
* TelePost health
* TelePress health

---

## Phase 0 Gate

只有可以准确回答：

```text
当前运行版本是什么？
当前每天什么时候执行？
当前由哪些 clock 触发？
当前哪些 secret 已确认安全？
```

才允许进入 Phase 1。

---

# 8. Phase 1 — Close P0 Failure Semantics

Priority: P0

目标：

> 生产系统不能继续出现无法解释的“内部错误”。

---

# 9. Phase 1.1 — Novel INTERNAL_ERROR RCA

当前最明确的问题：

```text
小说：
执行失败
原因：
内部错误
```

必须追踪完整链路：

```text
Candidate
↓
NovelDownloader
↓
Novel Parser
↓
Media Parsing
↓
Filter
↓
Artifact
↓
TelePress Preview
↓
Delivery
↓
TargetOutcome
```

寻找：

> 第一次丢失真实错误语义的位置。

---

## 必须确认

真实异常属于：

```text
candidate
pixiv_fetch
pixiv_download
novel_parse
media_resolve
artifact
telepress_publish
delivery
notification
```

中的哪一层。

---

## 修复要求

最终 failure 至少包含：

```text
code
stage
reason
retryable
operator_hint
request_id / correlation_id
```

未知异常仍然可以 INTERNAL_ERROR。

但必须可追踪。

---

# 10. Phase 1.2 — Unified Failure Contract Audit

审计：

* illustration
* novel
* recovery
* relaxed retry
* refetch
* publish
* notification

寻找所有：

```python
except Exception:
```

以及：

```text
generic 500
generic failure
请稍后重试
内部错误
```

确认是否错误压平。

禁止为了“统一”而大重写。

只修 contract 断点。

---

# 11. Phase 1.3 — Recovery Real E2E

已实现的 Recovery 修复不能只依赖 unit test。

验证：

```text
Telegram callback
↓
TelePost
↓
PixivFlow Recovery API
↓
Recovery request
↓
Slot / execution
↓
new outcome
↓
Telegram result
```

至少验证：

```text
Retry
Relaxed Retry
```

如果必须真人 Telegram 点击：

标记：

```text
EXTERNAL_ACCEPTANCE_REQUIRED
```

并继续所有可自动验证工作。

---

## Phase 1 Gate

必须满足：

* Novel 不再出现不可解释 INTERNAL_ERROR
* Operational Result Contract 在主要路径贯通
* Recovery 自动部分 VERIFIED
* 真人部分明确标记状态
* docs/current-state 已同步

完成后才能把 Failure Center 当作可靠 UI 数据源。

---

# 12. Phase 2 — Complete Execution Observatory

Priority: P0/P1

目标：

> 系统能够完整解释每一次 scheduled execution。

---

# 13. Phase 2.1 — Candidate Report Coverage

确认所有 target 都能记录：

```text
fetched
selected
rejected
reasons[]
```

推荐：

```json
{
  "fetched": 72,
  "selected": 0,
  "rejected": 72,
  "reasons": [
    {
      "code": "duplicate",
      "count": 12
    }
  ]
}
```

不要继续新增：

```text
aiExcluded
languageExcluded
...
```

固定 contract 字段。

---

# 14. Phase 2.2 — Empty Result Projection

统一推导：

```text
no_content_today
policy_too_narrow
duplicate_exhausted
candidate_supply_low
```

这些是运营 projection。

不要覆盖原始 terminal reason。

---

# 15. Phase 2.3 — TelePost Outcome UX

审核/管理消息按 target 分段。

不要：

```text
插画失败
小说失败
```

只给一句话。

需要显示：

```text
扫描
过滤
重复
候选
判断
建议
```

按钮：

```text
[重试·插画]
[放宽·插画]

[重试·小说]
[放宽·小说]
```

---

# 16. Phase 2.4 — Execution Truth Model

确保一个 execution 能串起：

```text
schedule
slot
target
execution
candidate report
artifact
delivery
notification
outcome
recovery
```

不要创建第二套 history。

复用现有 durable state。

---

## Phase 2 Gate

必须能够回答：

> 今天 10:00 bot1 到底发生了什么？

并给出：

* trigger
* slot
* candidate funnel
* terminal result
* delivery result
* next action

---

# 17. Phase 3 — Media Model Foundation

Priority: P1

这是下一阶段最重要的架构演进。

目标：

```text
Work
MediaAsset
Artifact
DeliveryVariant
```

正式成为代码和 contract 中可表达的不同概念。

---

# 18. Phase 3.1 — Community Research

实现前先调查：

* media manifest patterns
* content-addressed media models
* Telegram media cache patterns
* mature Pixiv clients
* existing Pixiv media metadata structures

记录 Community Research。

不要一上来重新设计复杂 DAM 系统。

---

# 19. Phase 3.2 — Introduce MediaAsset

第一阶段只新增描述能力。

不要马上删除旧文件路径。

例如：

```json
{
  "id": "123_p0",
  "kind": "image",
  "source": "pixiv",
  "sourceUrl": "...",
  "mimeType": "image/jpeg",
  "width": 2000,
  "height": 3000
}
```

---

# 20. Phase 3.3 — Artifact Separation

明确：

```text
MediaAsset
```

不代表：

```text
local path
```

只有 materialize 后才产生：

```text
Artifact
```

保留现有 downloader。

但把它变成：

```text
materialize(MediaAsset)
```

概念上的 capability。

---

# 21. Phase 3.4 — Compatibility Layer

旧消费者仍可以收到：

```text
files[]
```

新消费者可以开始使用：

```text
media[]
artifacts[]
```

禁止一次 release 直接切断旧路径。

---

## Phase 3 Gate

必须满足：

* MediaAsset 有 canonical model
* Artifact 已与 source media 解耦
* 旧下载链保持兼容
* 新 contract 有 regression tests
* 无生产消费者被强制迁移

这时才能继续优化 Telegram / TelePress。

---

# 22. Phase 4 — Telegram Media Delivery Optimization

Priority: P1

目标：

> TelePost 不再要求 PixivFlow 为“让 Telegram 用户看到图片”而无条件下载媒体。

---

# 23. Phase 4.1 — Community Research

调查：

* Telegram Bot API URL media delivery
* `file_id`
* `file_unique_id`
* `copyMessage`
* `copyMessages`
* album/media-group behavior
* size limits
* retry behavior

记录结论。

优先使用 Telegram 官方能力。

---

# 24. Phase 4.2 — TelegramMediaCache

建立：

```text
(bot_id, asset_id)
→ file_id
→ file_unique_id
```

不要全局保存一个 file_id。

---

# 25. Phase 4.3 — Delivery Priority

实现渐进策略：

```text
1. existing file_id
2. copyMessages / existing Telegram media
3. public media URL
4. DeliveryVariant
5. local materialized source
```

每次 fallback 必须可观察。

---

# 26. Phase 4.4 — Large Image Strategy

不要再出现：

```text
一组图片
+
一组 document
```

但操作者不知道为什么。

需要明确：

```text
source media
→ Telegram capability check
→ delivery variant
→ photo/document decision
```

如果生成 DeliveryVariant：

保留 source identity。

---

## Phase 4 Gate

必须证明：

* 首次投稿可以不依赖强制本地下载的场景已存在
* 重复发布可复用 Telegram media
* album 行为正确
* 大图 fallback 明确
* 原有 download path 仍可作为 fallback

---

# 27. Phase 5 — TelePress Preview Decoupling

Priority: P1

目标：

> Rich Novel 不再把第三方图床视为强制基础设施。

---

# 28. Phase 5.1 — Community Research

重点调查：

* Pixiv.Cat
* pximg proxy 类方案
* Telegram Instant View
* FxTwitter / FixupX 架构
* lightweight public reader
* Cloudflare Worker proxy

评估：

* license
* activity
* security
* maintenance
* NSFW constraints
* cost
* proxy abuse risk

记录 ADR。

---

# 29. Phase 5.2 — Provider Model

TelePress 逐步明确：

```text
MediaProvider

├── ProxyProvider
└── UploadProvider
```

不要删除已有 ImageHost。

先兼容。

---

# 30. Phase 5.3 — Rich Novel Asset Manifest

扩展 `/publish/rich-novel`：

支持：

```text
NovelDocument
MediaReference[]
```

或等价 manifest。

保持：

```text
md + images[]
```

兼容。

---

# 31. Phase 5.4 — Pixiv Proxy Provider

优先适配成熟开源 proxy。

不要默认自己重写所有：

* Referer handling
* cache
* streaming
* Pixiv CDN quirks

如果采用 Cloudflare Worker：

目标新增成本尽量：

```text
$0
```

---

# 32. Phase 5.5 — Rich Novel Renderer

优先路径：

```text
Pixiv media refs
↓
proxy URL
↓
Telegraph or Web Reader
```

UploadProvider 作为：

```text
fallback / local-only media
```

---

# 33. Phase 5.6 — Failure Isolation

必须保证：

```text
preview failed
```

不会导致：

```text
TXT failed
ZIP failed
Novel processing failed
```

Preview 是独立 capability。

---

## Phase 5 Gate

必须真实验证：

```text
Pixiv rich novel
→ inline images
→ public preview
→ Telegram online reading
```

并且不依赖 Catbox 成功。

---

# 34. Phase 6 — Content Supply Platform

Priority: P1/P2

在 Candidate Observatory 完成以后推进。

---

# 35. Phase 6.1 — Topic Health

先不要建复杂 Candidate Inventory。

先建立供给健康指标：

```text
recent success rate
candidate count
duplicate ratio
filter ratio
zero-result streak
```

输出：

```text
healthy
warning
critical
```

---

# 36. Phase 6.2 — Topic Profile

把：

```text
topic = "ボテ腹"
```

逐步升级成：

```text
primary tags
related tags
ranking
fallback
supply policy
```

先设计兼容格式。

不要立即自动扩 tag。

---

# 37. Phase 6.3 — Candidate Inventory

只有 Topic Health 和 Candidate Report 稳定后才实现。

目标：

```text
Collector
↓
Inventory
↓
Ranking
↓
Reservation
↓
Scheduler
```

库存状态应与现有 Candidate domain 整合。

不能创建平行数据库。

---

# 38. Phase 6.4 — Adaptive Strategy

最后再考虑：

```text
扩大窗口
related tags
ranking adjustment
frequency suggestion
```

自动调整必须：

* 可解释
* 可回滚
* 有上限
* 不突破 hard constraints

不要直接让 Agent 自己改生产 tag。

---

## Phase 6 Gate

bot1 这类低供给主题不能再只有：

```text
今天失败
```

系统至少能够提前表达：

```text
库存不足
供应下降
预计无法覆盖下一发布周期
```

---

# 39. Phase 7 — PixivFlow Control Center

Priority: P2

这时已有足够可靠的 Execution Truth。

再把 WebUI 做深。

---

# 40. Phase 7.1 — Read-Only First

先完整实现：

* Dashboard
* Scheduler
* Slot Ledger
* Execution
* Candidate Report
* Artifact
* Logs
* Supply Health

所有数据来自正式 API。

---

# 41. Phase 7.2 — Failure Center

展示：

```text
stage
code
reason
retryable
operator_hint
execution
logs
recovery history
```

---

# 42. Phase 7.3 — Recovery Safety Review

在允许写操作前验证：

* auth
* CSRF/origin
* operator identity
* audit
* idempotency
* concurrency
* allowed states
* confirmation UX

---

# 43. Phase 7.4 — Recovery Actions

只有安全评审通过才启用：

```text
Retry
Relaxed Retry
```

WebUI 必须调用现有 Recovery service。

---

## Phase 7 Gate

WebUI 必须能够完成：

```text
发现异常
↓
解释原因
↓
查看 execution
↓
查看 logs
↓
判断 retryability
↓
执行安全恢复
↓
查看 resulting execution
```

---

# 44. Phase 8 — TelePost Product Model

Priority: P2/P3

---

# 45. Phase 8.1 — Admission Policy Audit

确认：

```text
Telegram human
→ DIRECT_PUBLISH

Mini App human
→ DIRECT_PUBLISH

API automated
→ REVIEW_REQUIRED
```

清理旧 handler-specific policy。

---

# 46. Phase 8.2 — Submission / Review Separation

正式保证：

```text
Submission
!=
Review
```

我的投稿：

```text
Submission history
```

不是 Review Queue。

---

# 47. Phase 8.3 — User Space

完善：

* 首页
* 投稿
* 我的投稿
* 搜索
* 标签云
* Hot
* 帮助
* 设置
* soft delete

---

# 48. Phase 8.4 — Moderation Lifecycle

实现：

```text
active
expired
removed
```

保留完整 audit。

---

# 49. Phase 8.5 — Admin Space

完善：

* Dashboard
* Review
* All Submissions
* Failure
* User Governance
* API Governance
* Moderation
* Audit

Admin DM 保留为快捷入口。

---

## Phase 8 Gate

TelePost 不再只是：

```text
Bot handlers + buttons
```

而形成清晰：

```text
User Product
+
Admin Product
+
Business Domain
```

---

# 50. Phase 9 — Documentation & Platform Hardening

Priority: Continuous / Finalization

这不是最后才开始。

前面各阶段一直同步。

这一阶段负责全局清理。

---

# 51. Documentation Quality Pass

系统性检查：

* README
* AGENTS
* CONTRACT
* architecture
* operations
* development

修复：

* 过度压缩
* 中文异常空格
* 错误 Markdown
* CLI 命令挤压
* provider 被写成架构
* 当前状态与实现不符

---

# 52. Deprecation Cleanup

当新路径真实 VERIFIED 后：

才能开始考虑淘汰旧路径。

例如：

```text
mandatory rich-novel Catbox upload
```

只有新 preview path 稳定以后才能降级/弃用。

禁止：

```text
新路径刚实现
→ 立即删旧路径
```

---

# 53. Contract Tests

为跨仓核心 contract 补测试：

* media manifest
* Outcome
* Recovery
* scheduler
* admission
* rich novel
* provider fallback

---

# 54. Production Acceptance

最终执行真实场景矩阵：

```text
bot1 no-content
bot2 success
illustration single image
illustration multi-image
large image
novel text-only
novel rich-media
API submission
Telegram human submission
Mini App submission
Recovery
Provider failure
Worker restart
```

---

# 55. Phase 9 Gate

只有：

```text
architecture
code
tests
release
deploy
runtime
production
docs
```

全部一致时：

才能称为平台阶段完成。

---

# 56. Immediate Next Actions

从当前已知状态出发，下一位 Agent 不要从 Phase 6 或 Phase 8 开始。

默认下一步：

```text
1. Phase 0
   Re-baseline production

2. Phase 1
   Novel INTERNAL_ERROR RCA
   Unified Failure Contract
   Recovery verification

3. Phase 2
   Complete Candidate / Execution observability

4. Phase 3
   Introduce MediaAsset / Artifact model

5. Phase 4 + Phase 5
   Telegram media optimization
   TelePress preview decoupling
```

Phase 6 以后建立在这些基础上。

---

# 57. Recommended Near-Term Milestones

## Milestone 1 — Production Truth

交付：

* Novel error explained
* structured failure complete
* recovery state known
* candidate report consistent

---

## Milestone 2 — Media Contract

交付：

```text
Work
MediaAsset
Artifact
DeliveryVariant
```

并保持 legacy compatibility。

---

## Milestone 3 — No Mandatory Download For Telegram

交付：

* TelegramMediaCache
* URL/file_id path
* local fallback

---

## Milestone 4 — No Mandatory Catbox For Rich Novel

交付：

* community proxy integration
* ProxyProvider
* media manifest
* real rich novel E2E

---

## Milestone 5 — Content Supply Intelligence

交付：

* Topic Health
* Topic Profile
* Candidate Inventory

---

## Milestone 6 — Control Plane

交付：

* PixivFlow WebUI complete execution flow
* Failure Center
* safe Recovery

---

## Milestone 7 — Business Platform

交付：

* Mini App User/Admin split
* Moderation
* API Governance
* Admin Audit

---

# 58. Documentation Checkpoint Per Phase

每结束一个 Phase：

必须更新：

```text
current-state.md
```

如果产生长期决定：

更新：

```text
ecosystem-platform.md
```

如果 Agent 行为约束需要改变：

更新：

```text
AGENTS.md
```

如果生产 contract 改变：

更新：

```text
CONTRACT.md
```

如果用户使用方式改变：

更新：

```text
README.md
```

---

# 59. Community Research Checkpoint Per Phase

任何新增通用能力前：

都必须重新问：

> 社区是否已经有成熟方案？

必须记录：

```text
Investigated
Adopted
Rejected
Reason
License
Integration
Fallback
```

不能因为之前某一阶段没有合适方案，就永远不再调查。

---

# 60. Stop Conditions

Agent 只允许在以下情况下暂停：

```text
BLOCKED_EXTERNAL
EXTERNAL_ACCEPTANCE_REQUIRED
irreversible production decision
missing required permission/secret
```

否则：

不要完成一个子任务就等待用户说“继续”。

继续推进到当前 Phase Gate。

---

# 61. Final Principle

推进顺序始终遵守：

```text
先知道发生了什么
↓
再定义正确模型
↓
再解除旧耦合
↓
再优化投递
↓
再增加智能策略
↓
最后扩大控制面
```

不要反过来。

尤其禁止：

```text
Execution Truth 还不完整
↓
先做漂亮 Dashboard

MediaAsset 还不存在
↓
先做复杂 media proxy contract

Candidate Report 还不可靠
↓
先做自动 Topic 策略
```

长期目标不是快速堆功能。

而是让每一阶段都成为下一阶段可靠的地基。

这份文档最重要的是最后的 **Immediate Next Actions + Gate**。以后 Agent 打开仓库，不需要重新从几十个目标里猜优先级，而是先看 `current-state.md`，再沿这个计划找到“当前第一个未通过 Gate 的 Phase”，从那里继续。
