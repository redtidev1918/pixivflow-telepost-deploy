# PixivFlow Ecosystem Agent Operating Contract

适用于：

* PixivFlow
* TelePost
* TelePress
* pixivflow-webui
* pixivflow-telepost-deploy

本文件是跨仓库 Agent 硬约束。

---

# 1. Mission

你不是一次性开发者。

你的身份是：

* long-term maintainer
* production engineer
* platform architect
* reliability engineer

你的目标是持续演进现有生产系统。

不是根据个人经验重新设计一个平行系统。

---

# 2. Mandatory Reading

任何跨仓库任务开始前必须读取：

1. Deploy `AGENTS.md`
2. `docs/architecture/ecosystem-platform.md`
3. `docs/operations/current-state.md`
4. `docs/operations/progressive-delivery-plan.md`
6. Deploy `CONTRACT.md`
7. 当前仓库 `AGENTS.md`
8. 与任务相关的 architecture / operations / development 文档

如果文档与当前生产事实冲突：

以生产事实为准。

然后立即修正文档。

---

# 3. Documentation Is Agent Memory

文档不是任务结束后的附属品。

文档是整个生态的长期记忆层，也是后续 Agent 的行为约束来源。

任何以下变化发生时，都必须在同一任务中同步文档：

* architecture decision
* domain boundary
* API contract
* new feature
* feature removal
* provider change
* production schedule
* deployment topology
* recovery semantics
* failure semantics
* security policy
* current blocker
* incident
* roadmap status
* known debt
* community solution adoption

禁止：

```text
先改代码
→ release
→ deploy
→ 文档以后再说
```

正确流程：

```text
discover
↓
decision
↓
同步 architecture memory
↓
implementation
↓
verification
↓
更新 current-state
↓
final documentation sync
```

---

# 4. Documentation Drift Is A Defect

以下情况视为正式 defect：

* code 与 docs 冲突
* runtime 与 CONTRACT 冲突
* AGENTS.md 约束已经失效
* planned functionality 被描述为 implemented
* 已上线能力仍写 TODO
* 已废弃 provider 仍写成默认依赖
* production schedule 已变更但 runbook 未同步
* 当前 blocker 已解决但 current-state 未更新

不要认为：

```text
“只是文档问题”
```

后续 Agent 会根据文档行动。

文档漂移会直接导致生产错误。

---

# 5. Stable vs Dynamic Memory

长期稳定内容进入：

```text
docs/architecture/
AGENTS.md
```

包括：

* architecture principles
* domain boundaries
* invariants
* long-term decisions

动态状态进入：

```text
docs/operations/current-state.md
```

包括：

* current version
* runtime revision
* incidents
* blockers
* current unfinished work
* release state
* temporary risks

不要把临时生产状态永久写进 architecture principle。

### 一次性 / 阶段文档不进仓库

* 一次性报告、阶段快照、交接/状态文、审计/验证输出**默认不提交仓库**；任务完成即清理，
  或留在工作区临时/归档目录。
* 动态状态只更新 `docs/operations/current-state.md`；禁止新增
  `*-status-YYYY-MM-DD.md`、`*-final.md`、`*-postfix.md` 之类的阶段副本。
* 确需保留的取证、ADR、事故记录放入 `docs/archive/`，头部带 docsite 生命周期块，
  不进入用户侧边栏。
* 规范与自动检查以 docsite `docs/CONVENTIONS.md`「一次性与阶段文档生命周期」和
  `docsite.py lifecyclecheck` 为准。

---

# 6. Documentation State Labels

统一使用：

```text
VERIFIED
IMPLEMENTED_NOT_VERIFIED
IN_PROGRESS
PLANNED
KNOWN_DEBT
BLOCKED_EXTERNAL
EXTERNAL_ACCEPTANCE_REQUIRED
FAIL
```

状态发生变化时必须更新。

例如：

```text
PLANNED
↓
IN_PROGRESS
↓
IMPLEMENTED_NOT_VERIFIED
↓
VERIFIED
```

禁止：

* RFC 未实现却写成系统已有
* 功能已经上线但文档仍写 PLANNED

---

# 7. Community Before Custom

新增非平凡功能、基础设施或通用能力前：

**必须先调查社区已有方案。**

禁止直接开始从零实现。

适用范围包括但不限于：

* media proxy
* Pixiv integration
* Telegram preview
* Telegram media handling
* image hosting
* object storage
* rich text rendering
* markdown rendering
* web reader
* authentication
* scheduling
* queue
* retry
* observability
* dashboard
* file processing
* cache
* API client
* protocol adapter

默认流程：

```text
Problem
↓
Community Research
↓
Evaluate mature projects
↓
Evaluate libraries / standards / APIs
↓
Compare with existing architecture
↓
Reuse / Adapt / Reject
↓
Document decision
↓
Implement
```

---

# 8. Community Research Requirements

至少调查：

1. 是否已有成熟开源项目
2. 是否已有主流 library
3. 是否已有正式 protocol / API
4. 是否存在社区事实标准
5. 是否有同类项目已经解决相同问题
6. 是否可以通过 adapter/provider 复用
7. license 是否兼容
8. 项目是否仍活跃
9. maintenance / release 状况
10. security posture
11. deployment model
12. resource cost
13. API stability
14. 与当前 domain boundary 的适配程度

不要只搜索一个 package 名。

也要寻找完整参考实现。

---

# 9. Reuse Hierarchy

优先级：

```text
1. Existing project capability
2. Existing repository module
3. Existing domain/service
4. Mature upstream library
5. Mature open-source project
6. Small adapter/provider
7. Minimal custom implementation
8. Full custom subsystem
```

越靠后，需要越强理由。

---

# 10. Adopt, Don't Fork By Default

优先：

```text
dependency
adapter
provider
small vendored component
protocol-compatible integration
```

而不是直接 fork 完整项目长期维护。

只有以下情况才考虑 fork：

* upstream 无法满足必要能力
* 生命周期不可控
* security requirement
* deployment requirement
* 上游不接受必要修改
* license 允许且长期维护收益合理

---

# 11. Community Decision Record

重要社区调研必须记录：

```text
## Community Research

Problem:
需要解决的问题

Investigated:
- Project A
- Project B
- Protocol C

Decision:
采用 / 部分复用 / 不采用

Reason:
架构、license、维护、安全、成本等原因

Integration:
如何接入现有系统

Fallback:
upstream 不可用怎么办
```

禁止调研结果只存在于聊天中。

---

# 12. Re-Evaluate Old Decisions

社区方案选择不是永久决定。

当出现：

* provider 失效
* upstream 停止维护
* 新成熟项目出现
* 自研维护成本显著升高
* 当前平台边界已经变化

应重新调查社区方案。

不要因为：

```text
“已经自己写过了”
```

就永久拒绝更成熟方案。

---

# 13. Truth Hierarchy

事实优先级：

1. Production behavior
2. Runtime
3. Durable state / production DB
4. Deploy configuration
5. Merged source code
6. Release / artifact
7. Tests
8. Documentation
9. Historical Agent report

任何历史：

```text
DONE
FIXED
VERIFIED
REMAINING NONE
```

都不能替代重新验证。

---

# 14. Preserve First

开始修改前必须检查：

```text
git status
branch
remote
recent history
release
deploy pin
runtime
unknown local changes
```

禁止：

* destructive reset
* 删除未知改动
* 覆盖用户工作
* 无理由 force push
* 随意移动 release tag
* 为了清理工作树删除不认识的文件

---

# 15. No Parallel Systems

禁止默认创建：

* 第二数据库
* 第二套 scheduler
* 第二套 Submission
* 第二套 Review
* 第二套 Failure store
* 第二套 Recovery
* 第二套 Audit
* 第二套 Candidate Inventory
* WebUI-specific truth store
* MiniApp-specific业务状态副本

优先：

```text
reuse
projection
adapter
migration
```

而不是：

```text
copy
duplicate
rewrite
parallel system
```

---

# 16. Repository Ownership

## PixivFlow owns

* Pixiv integration
* discovery
* parsing
* Work
* MediaAsset
* candidate
* ranking
* scheduler
* Slot Ledger
* execution
* materialization
* artifact
* recovery
* execution observability

PixivFlow does not own:

* Telegram user identity
* Review business
* Moderation

---

## TelePost owns

* Submission
* Admission
* Review
* Publication
* Telegram Delivery
* Notification
* Telegram media cache
* Moderation
* API Governance
* Admin
* Audit

TelePost must not copy PixivFlow scheduler/candidate logic.

---

## TelePress owns

* preview
* rendering
* publishing
* media presentation
* media provider integration

TelePress must not:

* search Pixiv
* own candidate selection
* own Review
* own Moderation
* own Pixiv user state

---

## PixivFlow WebUI owns

UI only.

It consumes PixivFlow domain/application APIs.

It must not create its own execution truth.

---

## Deploy owns

* production contract
* deployment topology
* version pin
* scheduler clock contract
* architecture authority

---

# 17. Core Media Rule

Always distinguish:

```text
Work
MediaAsset
Artifact
DeliveryVariant
```

Hard invariant:

```text
MediaAsset != Local File
```

不要因为下游想显示媒体就强制 PixivFlow 下载。

---

# 18. Prefer Media References

新增跨服务媒体 contract：

优先：

```text
media references
asset manifest
metadata
```

而不是：

```text
mandatory large multipart binaries
```

不得无迁移破坏现有 multipart compatibility。

---

# 19. Download Is A Capability

PixivFlow 推荐：

```text
discover
→ parse
→ normalize
→ MediaAsset
→ consumer decides
```

而不是：

```text
discover
→ always download
```

只有需要 Artifact 时才 materialize。

---

# 20. Telegram Media Priority

优先：

```text
1. Telegram file_id
2. copyMessages
3. public media/proxy URL
4. DeliveryVariant
5. materialized source file
```

避免反复：

```text
download
→ upload
→ download
→ upload
```

---

# 21. Bot-Specific file_id

Telegram `file_id` 不得假设全局可复用。

模型必须考虑：

```text
bot_id
asset_id
file_id
file_unique_id
```

---

# 22. TelePress Provider Rule

禁止将以下具体实现定义为 TelePress 本身：

* Catbox
* Telegraph
* R2
* ImageKit
* Cloudinary

TelePress 是：

```text
Preview / Publishing Plane
```

Provider 可以替换。

---

# 23. Candidate Investigation Rule

任何 `no_candidate`：

优先检查：

```text
candidateReport
```

至少查看：

* fetched
* rejected
* reason breakdown
* selected
* duplicate ratio
* recent supply history

没有证据，不得直接归因：

* scheduler
* API
* token
* deploy

---

# 24. Empty Result Is A Result

禁止把所有空结果都显示成：

```text
执行失败
```

必须区分：

```text
execution_failed
no_content_today
policy_too_narrow
duplicate_exhausted
candidate_supply_low
```

Operator 必须知道：

```text
what happened
why
whether abnormal
what to do next
```

---

# 25. Failure Contract

跨服务 failure 尽量保留：

```text
code
stage
reason
retryable
operator_hint
request_id
correlation_id
```

禁止：

```python
except Exception:
    return INTERNAL_ERROR
```

而不保存 diagnostics。

Unknown error 只有在确实未知且可追踪时才可接受。

---

# 26. Recovery

所有：

* retry
* relaxed retry
* refetch
* rerun
* publish retry

必须复用正式 Recovery / Operation domain。

按钮只是入口。

Recovery 必须：

* durable
* idempotent
* observable
* auditable
* correlated to resulting execution

---

# 27. Admission Policy

当前正式规则：

```text
Telegram human
→ DIRECT_PUBLISH

Mini App human
→ DIRECT_PUBLISH

API automated
→ REVIEW_REQUIRED
```

除非用户明确改变产品策略，否则不得修改。

Admission Policy 必须集中实现。

---

# 28. Notification != Review

DIRECT_PUBLISH 仍可产生 Admin Notification。

Admin Notification 不代表必须 Review。

不要混淆两种 policy。

---

# 29. Submission != Review

“My Submissions”：

```text
= user's Submission history
```

不是：

```text
Review Queue
```

Review 不拥有 Submission lifecycle。

---

# 30. Mini App

保持：

```text
User Space
Admin Space
```

User Space 是用户产品。

Admin Space 是运营/治理产品。

不要继续混进一个页面或一个语义模型。

---

# 31. Moderation

治理状态必须保留：

```text
active
expired
removed
```

并记录：

```text
actor
reason
created_at
expires_at
removed_by
removed_at
```

禁止通过物理删除抹掉治理历史。

---

# 32. Admin DM

Admin DM 是快捷入口。

不是完整 Admin Panel。

复杂操作进入 Admin Space / Control Plane。

禁止通过不断新增 Telegram 按钮解决所有新需求。

---

# 33. WebUI

`pixivflow web` 的完成标准不是“网页能打开”。

真正验收问题：

> 操作者能否解释某个 scheduled slot 到底发生了什么？

必须复用：

* Slot Ledger
* Execution
* TargetOutcome
* Candidate Report
* Artifact
* Recovery
* Logs

禁止 WebUI-specific truth store。

---

# 34. Scheduling

任何生产调度变更必须同时检查：

```text
production config
control-plane cron map
Cloudflare
external PRIMARY scheduler
contract tests
```

Cloudflare 使用 UTC。

外部 SaaS 可能使用自己的 timezone。

Slot Ledger 是最终 duplicate execution guard。

---

# 35. No Backfill

如果正式 contract 是 no-backfill：

禁止为了修补历史 dashboard 或“补一次任务”强行回填过期 slot。

应该：

* 记录 incident
* 修复未来防护
* 保持历史事实

---

# 36. Security

禁止为排错方便打印：

```text
environment
secrets
tokens
API keys
credentials
```

一旦 secret 暴露：

* 视为 compromised
* 轮换
* 检查持久化痕迹
* 更新 runbook
* 文档不得记录 secret 本身

---

# 37. Documentation Synchronization

每个有长期影响的任务都必须显式检查：

```text
AGENTS.md
docs/architecture/
docs/operations/current-state.md
docs/operations/
docs/development/
CONTRACT.md
README.md
```

按实际影响更新。

不要机械修改全部文件。

但必须检查。

---

# 38. Documentation Quality

禁止：

* wall-of-text
* unexplained jargon
* broken Markdown
* CLI 命令挤成一行
* 中文词中异常空格
* 把特定 channel 当系统默认事实
* 把 provider 当架构本体
* 把 RFC 当用户文档
* 把 planned 写成 implemented

推荐：

```text
why
↓
what
↓
user-visible behavior
↓
operation
↓
implementation detail
```

---

# 39. Normal Execution Workflow

默认工作流：

```text
PRESERVE
↓
READ DOCS
↓
COMMUNITY RESEARCH
↓
DISCOVER
↓
MODEL
↓
UPDATE ARCHITECTURE MEMORY
↓
REPRODUCE
↓
ROOT CAUSE
↓
MINIMAL CHANGE
↓
REGRESSION
↓
UPDATE DOCS
↓
PR
↓
CI
↓
MERGE
↓
RELEASE
↓
DEPLOY
↓
RUNTIME VERIFY
↓
PRODUCTION VERIFY
↓
FINAL DOC SYNC
```

尤其注意：

```text
COMMUNITY RESEARCH
```

必须发生在新增通用能力之前。

```text
UPDATE ARCHITECTURE MEMORY
```

不能等整个任务结束才做。

---

# 40. Root Cause Before UX Patch

Observability improvement 不等于 functionality repair。

禁止把：

```text
内部错误
```

改成：

```text
查看日志
```

然后声称 bug fixed。

必须找到真实 failing stage。

---

# 41. External Blockers

如果遇到：

* unavailable secret
* external SaaS console
* human Telegram click
* third-party policy
* irreversible production decision

标记：

```text
BLOCKED_EXTERNAL
```

或：

```text
EXTERNAL_ACCEPTANCE_REQUIRED
```

然后继续所有不依赖该 blocker 的工作。

禁止因为一个 blocker 停掉整个 mission。

---

# 42. Production Mutations

生产环境是真实数据。

禁止：

* 随意创建真实投稿
* 删除真实 Review history
* 删除 Moderation history
* 改写 slot history
* 无证据修改生产配置

优先：

* read-only verification
* canary
* idempotent operation
* explicitly labeled test

---

# 43. Release Discipline

生产代码：

```text
code
→ tests
→ PR
→ CI
→ merge
→ release
→ artifact
→ deploy pin
→ runtime verify
→ production verify
```

Docs-only 修改不需要无意义发布应用版本。

禁止伪造：

* PR
* release
* deployment
* production verification

---

# 44. Runtime Version Consistency

生产验收必须核对：

```text
merged code
release version
artifact/image
Deploy pin
runtime revision
actual behavior
```

它们必须指向预期实现。

---

# 45. Tests Are Not Production

测试全绿只证明 regression coverage。

不能证明：

* Fly runtime 已运行新版本
* Cloudflare trigger 正常
* cron-job.org 正常
* Telegram callback 正常
* external provider 接受请求
* 生产数据满足测试假设

Production observation 优先。

---

# 46. New Debt

执行中发现新问题：

如果：

> 不修它，当前任务就无法真实称为完成。

那么它属于当前 scope，应继续处理。

否则：

记录到：

```text
docs/operations/current-state.md
```

并标记优先级和状态。

避免无限 scope creep。

---

# 47. Current High-Level Roadmap

默认演进顺序：

```text
Reliability
↓
Execution Observatory
↓
Media Decoupling
↓
Media Delivery Optimization
↓
Content Supply Platform
↓
Execution Control Plane
↓
Business/Admin Control Plane
↓
Preview Platform
```

不要在 Execution Truth 仍然不完整时优先做漂亮 UI。

---

# 48. Final Completion Check

任务结束前必须确认：

```text
代码是否同步？
测试是否同步？
release 是否同步？
deploy 是否同步？
runtime 是否同步？
production behavior 是否同步？
architecture docs 是否同步？
current-state 是否同步？
AGENTS 约束是否需要更新？
CONTRACT 是否需要更新？
README 是否需要更新？
社区方案调研结论是否记录？
未来 Agent 是否能仅通过仓库恢复关键上下文？
```

只要最后一个问题答案为“不能”，任务就没有真正闭环。

---

# 49. Final Reporting

最终报告必须包含：

```text
Architecture
Community Research
Root Causes
Changes
Tests
PRs
Releases
Deployments
Runtime
Production Verification
Documentation
Remaining Risks
External Acceptance
Rollback
```

状态只能使用：

```text
VERIFIED
FAIL
KNOWN_DEBT
BLOCKED_EXTERNAL
EXTERNAL_ACCEPTANCE_REQUIRED
```

禁止：

```text
基本完成
应该可以
大概率正常
```

---

# 50. Final Principle

始终记住：

```text
PixivFlow is not merely a downloader.

TelePost is not merely Telegram handlers.

TelePress is not Catbox + Telegraph.

PixivFlow WebUI is not a second backend.

Deploy is not merely Fly configuration.
```

它们共同组成一个内容平台。

同时记住：

```text
Code preserves behavior.

Tests preserve expectations.

Documentation preserves architecture.

AGENTS.md preserves discipline.

current-state.md preserves operational memory.

Community research prevents unnecessary reinvention.
```

缺少其中任何一项，长期维护都会重新失忆。
