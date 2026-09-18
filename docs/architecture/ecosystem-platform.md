# PixivFlow Ecosystem Platform Architecture

Status: Living Architecture
Authority: `pixivflow-telepost-deploy`
Scope: PixivFlow / TelePost / TelePress / PixivFlow WebUI / Deploy

---

# 1. Purpose

PixivFlow、TelePost、TelePress 已经不是三个互相独立的小项目。

它们共同组成一个正在真实生产运行的内容平台。

历史上很多问题表面上互不相关：

* PixivFlow 多图下载造成内存峰值
* bot1 长期没有候选
* `no_candidate` 被显示成“执行失败”
* Recovery 按钮存在，但恢复链路曾实际失败
* Novel failure 被压平成 `INTERNAL_ERROR`
* 为了 Telegram 展示而强制下载媒体
* TelePost 审核和 Submission 模型混乱
* Mini App 的“我的投稿”和 Review Queue 混在一起
* Admin DM 不断增加按钮
* Rich Novel 依赖 Catbox / Telegraph 图片上传
* Catbox 被 Fly egress 拒绝
* Telegraph 图片上传不稳定
* WebUI 页面存在，但无法解释某个计划任务实际发生了什么
* 文档把 Catbox、Telegram channel、Telegraph 等具体实现误写成架构本身

这些问题存在一个共同根因：

> 系统仍然残留“下载器 + Telegram Bot”的历史模型，但产品实际上已经演进成内容发现、解析、筛选、执行、投递、发布、运营和治理平台。

本文定义这个生态的长期架构。

当前版本号、线上状态、未完成事项、事故和临时阻塞不写死在本文中，而维护在：

`docs/operations/current-state.md`

---

# 2. Platform Goal

长期目标：

```text
                        Human / Operator
                               │
                ┌──────────────┴──────────────┐
                │                             │
         PixivFlow WebUI               TelePost Admin
         Execution Control             Business Control
                │                             │
                └──────────────┬──────────────┘
                               │
                            TelePost
                         Business Plane
                               │
                 ┌─────────────┴─────────────┐
                 │                           │
             PixivFlow                   TelePress
          Execution / Media            Preview / Publishing
             Parsing Plane                  Plane
                 │                           │
                 └─────────────┬─────────────┘
                               │
                     Telegram / Public Web
```

平台最终应具备：

* 内容发现
* 内容解析
* 候选筛选
* 排名
* 调度
* 执行
* 可观察性
* 恢复
* 媒体投递
* 富媒体预览
* 运营
* 治理
* 审计

目标不是继续把所有能力堆进 Telegram Bot handler。

---

# 3. Repository Boundaries

## 3.1 PixivFlow

定位：

**Execution Plane + Media Parsing Plane**

负责：

* Pixiv API / source integration
* Work discovery
* Work parsing
* MediaAsset parsing
* tag / topic search
* candidate collection
* candidate filtering
* ranking
* scheduler
* targets
* Slot Ledger
* execution lifecycle
* TargetOutcome
* candidate observability
* recovery
* artifact materialization
* packaging
* execution-level diagnostics

PixivFlow 不负责：

* Telegram 用户体系
* Submission ownership
* Review 业务
* Moderation
* Telegram Admin UI
* Telegram Bot handler 业务状态

PixivFlow 不再定义为“下载器”。

下载只是它的一项 capability。

---

## 3.2 TelePost

定位：

**Business Plane + Telegram Plane**

负责：

* Telegram Bot
* Telegram Mini App
* Submission
* Admission Policy
* Review
* Publication
* Telegram Delivery
* Telegram media cache
* Notification
* Moderation
* API Governance
* Admin Control
* Audit

TelePost 不应复制：

* PixivFlow scheduler
* Pixiv candidate logic
* Pixiv parsing
* Pixiv ranking
* TelePress rendering

---

## 3.3 TelePress

定位：

**Preview / Publishing Plane**

核心职责：

> 将上游已经准备好的内容转换成公开可访问的富媒体预览或发布结果。

TelePress 可以使用：

* Telegraph
* Web Reader
* media proxy
* external image host
* Markdown renderer
* gallery renderer

这些都是 provider / renderer。

它们不是 TelePress 的领域定义。

因此：

```text
Catbox != TelePress

Telegraph != TelePress

R2 != TelePress
```

TelePress 不负责：

* Pixiv 搜索
* Pixiv candidate selection
* Pixiv 用户登录态
* Submission
* Review
* Moderation
* Telegram 用户状态

---

## 3.4 PixivFlow WebUI

定位：

**PixivFlow Execution Control Plane**

入口：

```text
pixivflow web
```

目标体验：

```text
pixivflow web
      ↓
启动 backend
      ↓
提供 frontend
      ↓
打开浏览器
      ↓
Execution Control Center
```

WebUI 不拥有 execution truth。

它只能消费 PixivFlow 正式 application/domain API。

禁止浏览器直接访问生产数据库。

---

## 3.5 Deploy

定位：

**Production Contract Authority**

负责：

* Fly deployment
* image/version pin
* runtime topology
* scheduler clock contract
* secrets topology
* cross-repo contracts
* production verification
* architecture authority

跨仓库架构文档以 Deploy 仓库为权威。

各子仓库不复制完整跨仓架构，只保留本仓职责和指向总文档的引用。

---

# 4. Core Content Model

未来架构必须明确区分：

```text
Work
MediaAsset
Artifact
DeliveryVariant
```

这是整个媒体架构最重要的边界。

---

# 5. Work

Work 表示作品本身。

典型 Work：

```text
Pixiv Illustration
Pixiv Novel
Pixiv Series
```

Work 可以包含：

* source
* source work id
* work type
* title
* author
* tags
* source URL
* publish time
* metadata
* content structure

Work 不等于文件。

---

# 6. MediaAsset

MediaAsset 表示作品关联的远端媒体事实。

例如：

```text
123456_p0
123456_p1
novel_uploaded_image_01
```

逻辑模型示例：

```json
{
  "id": "123456_p0",
  "source": "pixiv",
  "kind": "image",
  "sourceUrl": "https://i.pximg.net/...",
  "width": 3000,
  "height": 4000,
  "mimeType": "image/jpeg",
  "page": 0
}
```

核心不变量：

```text
MediaAsset != Local File
```

媒体资产存在，不意味着 PixivFlow 必须已经下载它。

---

# 7. Artifact

Artifact 是已经物化出的文件结果。

例如：

* TXT
* Markdown
* ZIP
* downloaded image
* compressed image
* metadata JSON
* generated preview bundle

逻辑模型可以包含：

```text
artifact id
source work
source asset
variant
storage/local location
mime
size
checksum
created_at
```

Artifact 是可选结果。

不是 Work 或 MediaAsset 存在的前提。

---

# 8. DeliveryVariant

DeliveryVariant 是为了某个下游平台生成的媒体版本。

例如 Telegram 可能需要：

```text
Pixiv 原图
    ↓
resize / recompress
    ↓
Telegram-friendly JPEG
```

因此：

```text
Source Asset != Delivery Variant
```

禁止为了 Telegram 展示而修改原始媒体的语义。

---

# 9. Lazy Materialization

历史模型：

```text
discover
→ download
→ deliver
```

目标模型：

```text
discover
→ parse
→ normalize
→ MediaAsset
→ consumer decides
```

只有真正需要文件时：

```text
MediaAsset
    ↓
materialize()
    ↓
Artifact
```

PixivFlow 应逐步明确 capability：

```text
discover
parse
normalize
collect
filter
rank
select
resolve-media
materialize
package
deliver
```

`materialize` 不是所有执行的强制步骤。

---

# 10. Cross-Service Media Contract

跨服务传递媒体时，应优先传：

```text
Work
MediaAsset[]
Artifact[]
```

其中：

```text
Artifact[]
```

可以为空。

新增媒体 contract 应优先支持：

* media references
* asset manifest
* metadata

而不是默认要求：

```text
large multipart binary files
```

现有 multipart contract 可以保留，用于兼容和确实需要真实文件的场景。

---

# 11. Telegram Media Delivery

TelePost 的媒体投递策略应逐步演进成：

```text
L1 Telegram cached media
   file_id / copyMessages

L2 Public remote media
   proxy URL

L3 DeliveryVariant
   transformed media

L4 Local materialized file
   PixivFlow fallback
```

而不是默认：

```text
PixivFlow download
→ multipart
→ TelePost
→ Telegram
```

---

# 12. Telegram Media Cache

Telegram 成功接收媒体后，TelePost 应允许记录：

```text
bot_id
asset_id
file_id
file_unique_id
```

规则：

* `file_id` 用于当前 Bot 重发
* `file_unique_id` 用于身份识别或去重
* `file_id` 不应假设跨 Bot 可复用

因此禁止：

```text
asset_id -> one global file_id
```

推荐模型：

```text
TelegramMediaCache

(bot_id, asset_id)
→ file_id
→ file_unique_id
```

---

# 13. Review → Publication Media Reuse

如果审核群已经拥有最终媒体，应优先评估：

```text
copyMessages
```

或者：

```text
file_id
```

避免：

```text
重新抓 Pixiv
→ 重新下载
→ 重新上传 Telegram
```

Telegram 本身也是 delivery media cache。

---

# 14. TelePress Media Architecture

历史 Rich Novel：

```text
PixivFlow
→ local image
→ TelePress
→ Catbox
→ Telegraph
```

这会让第三方图床成为关键依赖。

目标结构：

```text
                       TelePress
                          │
             ┌────────────┼─────────────┐
             │            │             │
         Web Reader   Telegraph     MediaProvider
                                      │
                          ┌───────────┴───────────┐
                          │                       │
                    ProxyProvider           UploadProvider
                          │                       │
                     Pixiv Proxy       R2/Catbox/ImageKit/...
```

---

# 15. ProxyProvider

如果 MediaAsset 本身已经存在远端 source：

优先：

```text
source media
→ safe proxy
→ public URL
```

不必重新上传一份。

Pixiv media proxy 应优先复用成熟社区实现。

禁止无必要从零重新实现完整 Pixiv CDN proxy。

---

# 16. UploadProvider

只有真正只有本地文件时才需要：

```text
local artifact
→ UploadProvider
→ public URL
```

Catbox、R2、ImageKit、S3 等均属于 optional provider。

不允许重新把某个 provider 写成领域硬依赖。

---

# 17. Rich Novel Contract

长期方向：

```text
NovelDocument
+
MediaReference[]
```

而不是：

```text
Markdown
+
mandatory binary images[]
```

现有 multipart `images[]` 必须保持兼容。

未来允许增加：

```text
asset manifest
source media refs
proxy refs
```

---

# 18. Telegraph

Telegraph 是 renderer。

不是 TelePress 的领域定义。

长期允许：

```text
Telegraph
Web Reader
Other Reader
```

同时存在。

如果 Telegraph 或某个图片 provider 失败：

不得让：

```text
TXT
ZIP
local artifacts
```

一起失败。

Preview failure 和 Artifact failure 必须解耦。

---

# 19. Content Supply Is A First-Class Concern

低供给主题已经证明：

```text
fixed tag
+
fixed lookback
+
runtime search
```

无法保证长期内容供应。

系统必须把：

```text
content supply
```

作为一等运营问题。

---

# 20. Candidate Report

每个 target 应产生候选漏斗。

推荐结构：

```json
{
  "fetched": 72,
  "selected": 0,
  "rejected": 72,
  "reasons": [
    {
      "code": "duplicate",
      "count": 12
    },
    {
      "code": "ai_filtered",
      "count": 50
    },
    {
      "code": "language_filter",
      "count": 10
    }
  ]
}
```

禁止不断往 contract 增加：

```text
aiExcluded
languageExcluded
scoreExcluded
...
```

过滤原因应该可扩展。

---

# 21. Empty Result Semantics

必须区分：

```text
execution_failed
no_content_today
policy_too_narrow
duplicate_exhausted
candidate_supply_low
```

其中：

```text
candidate_supply_low
```

是运营 projection，不是绝对事实。

---

# 22. Execution Outcome Requirement

每个 scheduled target 最终必须能够回答：

1. 是否执行？
2. 看到了多少候选？
3. 为什么没有选中？
4. 下一步能做什么？

禁止长期只返回：

```text
执行失败
内部错误
没找到合适的新作品
```

而不给任何可操作上下文。

---

# 23. Topic Profile

当前：

```text
topic = "ボテ腹"
```

长期应该演进成：

```yaml
name: ボテ腹

primary:
  - ボテ腹

related:
  - ...

ranking:
  freshness_weight: ...
  popularity_weight: ...
  diversity_weight: ...

fallback:
  ...
```

Topic Profile 表示的是“主题策略”，不是一个字符串 tag。

---

# 24. Candidate Inventory

长期内容供应架构：

```text
Topic Profile
     ↓
Candidate Collector
     ↓
Candidate Inventory
     ↓
Ranking
     ↓
Reservation
     ↓
Scheduler
     ↓
Publication
```

这样 scheduled time 做的是：

```text
reserve candidate
```

而不是每次临时重新搜索。

Candidate Inventory 属于 PixivFlow。

禁止 TelePost 创建平行候选库存。

---

# 25. Scheduling

生产时钟属于 Deploy Contract。

修改 schedule 时必须同步检查：

```text
production config
↔
control-plane cron map
↔
Cloudflare
↔
external PRIMARY scheduler
↔
contract tests
```

PRIMARY / SECONDARY 必须由 Slot Ledger 幂等保护。

历史过期 slot 不应为了“看起来成功”破坏 no-backfill 不变量。

---

# 26. Execution Truth

Control Plane 的基础不是 UI，而是 Execution Truth。

系统应能够重建：

```text
Scheduled
↓
Triggered
↓
Slot Created
↓
Execution Started
↓
Candidate Evaluated
↓
Media / Artifact Processing
↓
Delivery
↓
Publication
↓
Notification
↓
Terminal Outcome
```

正常空结果也必须产生终态。

禁止 silent success。

禁止 silent failure。

---

# 27. Operational Result Contract

跨 PixivFlow、TelePost、WebUI 的结果应尽量保留：

```text
code
stage
reason
retryable
operator_hint
request_id
correlation_id
candidateReport
```

未知异常可以使用 internal error。

但必须保留：

```text
diagnostic / correlation id
```

禁止中间层无条件吞掉真实错误。

---

# 28. Recovery

以下操作均属于 Recovery / Operation domain：

* retry
* relaxed retry
* refetch
* rerun
* publish retry

必须复用统一 Recovery service。

Telegram callback 和 WebUI button 只是入口。

Recovery 应满足：

* durable request
* idempotency
* execution lineage
* retryability
* result
* audit
* operator-visible failure reason

---

# 29. PixivFlow WebUI

`pixivflow web` 是 PixivFlow Execution Control Plane 的统一入口。

目标页面：

## Dashboard

显示：

* runtime
* version
* scheduler health
* active/recent slots
* recent outcomes
* failures
* no-content results
* candidate supply warnings

## Scheduler

显示：

* target
* schedule
* next run
* history

## Slot Ledger

显示：

* slot id
* scheduled time
* trigger
* target
* status
* terminal outcome
* recovery lineage

## Execution

显示：

* execution id
* stages
* outcome
* candidate report
* artifacts
* logs

## Failure / Recovery

显示：

* stage
* code
* reason
* retryable
* operator hint
* logs
* recovery history
* retry actions

## Artifact

显示：

* TXT
* ZIP
* metadata
* images
* preview URL
* artifact status

## Configuration

只暴露适合安全修改的配置。

危险操作必须确认并审计。

---

# 30. Submission Domain

TelePost 必须明确区分：

```text
Submission
Admission
Review
Publication
Delivery
```

Submission 表示投稿事实。

Review 不是 Submission 本身。

---

# 31. Admission Policy

当前正式产品规则：

```text
Telegram human submission
→ DIRECT_PUBLISH

Mini App human submission
→ DIRECT_PUBLISH

API automated submission
→ REVIEW_REQUIRED
```

Admission Policy 必须集中实现。

禁止散落在多个 Telegram handler。

---

# 32. Notification Is Not Review

管理员通知策略和 Review 策略是两个概念。

因此：

```text
DIRECT_PUBLISH
```

仍然可以：

```text
Admin Notification
```

同样：

```text
Admin Notification
```

也不代表必须 Review。

---

# 33. Mini App

必须明确分：

```text
Mini App
├── User Space
└── Admin Space
```

User Space：

* 首页
* 投稿
* 我的投稿
* 搜索
* 标签云
* Hot
* 帮助
* 设置

“我的投稿”：

```text
= 用户自己的 Submission history
```

不是 Review Queue。

删除优先采用 soft delete。

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

# 34. Moderation

Moderation 是独立治理层。

Subject identity：

```text
user:<telegram_id>
api:<token_id>
```

生命周期：

```text
active
expired
removed
```

必须保留：

* created_by
* reason
* created_at
* expires_at
* removed_by
* removed_at

禁止删除治理历史。

---

# 35. Admin DM

Admin DM 是快捷 Control Entry。

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

简单动作可以留在 Telegram。

复杂运营进入 Admin Space。

禁止无限向 Bot 消息里堆按钮。

---

# 36. Outbox

Outbox 是可靠性基础设施。

用户层只需要理解：

* 网络失败会自动恢复
* 投递不容易丢失
* ACK 丢失不会轻易造成重复可见结果

具体：

```text
lease
retry
dead letter
idempotency
reconciliation
```

应分别放在 architecture / operations 文档。

不要把所有实现细节塞进 README 一个长段落。

---

# 37. Documentation Architecture

统一：

```text
README.md
    用户入口 / 快速开始

docs/architecture/
    领域模型 / 边界 / RFC / invariants

docs/operations/
    当前状态 / 部署 / 故障 / runbook

docs/development/
    内部实现机制

CONTRACT.md
    当前已经生效的生产合同

AGENTS.md
    Agent 执行纪律
```

---

# 38. Documentation Is Long-Term Memory

文档不是附属物。

它是整个生态的长期记忆层。

架构决策、领域边界、长期原则必须进入：

```text
docs/architecture/
AGENTS.md
```

生产状态、incident、blocker、当前版本等动态事实进入：

```text
docs/operations/current-state.md
```

不能只存在于：

* 聊天记录
* PR description
* commit message
* Agent final report

---

# 39. Documentation State Vocabulary

使用：

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

禁止把 PLANNED 写成 implemented。

禁止已上线功能长期仍写成 TODO。

---

# 40. Documentation Quality

禁止：

* 高度压缩的技术长段落
* 无上下文术语堆积
* 中文词语之间莫名空格
* 把 channel/provider 当成系统默认事实
* 把 RFC 混进用户快速开始
* 多条 CLI 命令挤在一行
* 把实现细节写成产品行为

推荐表达顺序：

```text
为什么存在
↓
解决什么问题
↓
用户能看到什么
↓
怎么操作
↓
内部怎么实现
```

---

# 41. Community Before Custom

非业务核心的通用能力，在自研前必须先调查成熟社区方案。

包括但不限于：

* media proxy
* Pixiv integration
* Telegram preview
* Telegram media handling
* storage
* image hosting
* markdown rendering
* web reader
* authentication
* scheduling
* queue
* retry
* observability
* dashboards
* file processing
* cache
* protocol adapters

默认：

```text
Problem
↓
Community Research
↓
Evaluate Projects / Libraries / Standards
↓
Reuse / Adapt / Reject
↓
Document Decision
↓
Implement
```

---

# 42. Community Research Requirements

至少评估：

* 是否已有成熟开源项目
* 是否已有主流 library
* 是否已有正式协议/API
* 是否已有社区事实标准
* license
* maintenance activity
* release health
* issue health
* security posture
* deployment model
* resource cost
* API stability
* 与当前领域边界的适配程度

开源不等于自动采用。

---

# 43. Reuse Hierarchy

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

越靠后，需要越强的理由。

---

# 44. Community Decision Record

重要调研应在 architecture/RFC 中记录：

```text
## Community Research

Problem:
要解决什么

Investigated:
- Project A
- Project B
- Protocol C

Decision:
采用 / 部分复用 / 不采用

Reason:
架构、license、维护、安全、成本等

Integration:
如何接入现有系统

Fallback:
upstream 不可用时怎么办
```

让下一位 Agent 不需要重新搜索同一问题。

---

# 45. Release & Deployment

任何生产代码变更必须经过：

```text
code
↓
tests
↓
PR
↓
CI
↓
merge
↓
release
↓
artifact / image
↓
deploy pin
↓
runtime verification
↓
production verification
```

测试绿不等于生产完成。

Release 成功也不等于生产完成。

---

# 46. Evolution Roadmap

## Phase A — Reliability Baseline

目标：

* scheduler
* Slot Ledger
* outbox
* idempotency
* recovery
* release/deploy discipline

---

## Phase B — Execution Observatory

目标：

* candidate report
* structured outcomes
* execution truth
* no silent outcome
* supply diagnostics

---

## Phase C — Media Decoupling

目标：

```text
Work
MediaAsset
Artifact
DeliveryVariant
```

正式分离。

逐步移除：

```text
所有下游必须等待 PixivFlow 先下载
```

---

## Phase D — Media Delivery Optimization

Telegram：

```text
file_id
→ proxy URL
→ DeliveryVariant
→ materialized fallback
```

TelePress：

```text
ProxyProvider
+
UploadProvider
```

---

## Phase E — Content Supply Platform

目标：

* Topic Profile
* Topic Health
* Candidate Inventory
* ranking
* reservation
* supply forecasting

---

## Phase F — Platform Control Plane

PixivFlow：

```text
pixivflow web
```

成为真实 Execution Control Center。

TelePost：

完成：

* Failure Center
* User/Admin separation
* API Governance
* Moderation
* Audit
* Admin Control Plane

---

## Phase G — Preview Platform

TelePress 从：

```text
Telegraph publisher
```

演进成：

```text
Preview Platform
```

支持：

* Telegraph
* Web Reader
* Pixiv media proxy
* optional UploadProvider

---

# 47. Core Principles

## Content is not a file

作品和媒体事实先于文件。

## Download is a capability

不是平台本身。

## No candidate is not automatically failure

内容供给不足需要解释。

## Telegram is also a media cache

充分利用 Telegram 已经持有的媒体。

## Catbox is a provider

不是架构依赖。

## Telegraph is a renderer

不是 TelePress 的领域定义。

## UI never owns execution truth

Control Plane 只消费正式 domain state。

## One semantic owner per state

一个业务事实不能在多个仓库独立维护。

## Community before custom

通用能力先调查社区成熟方案。

## Documentation is architecture

架构决定没有进入文档，不视为真正闭环。

## Documentation is agent memory

未来 Agent 应能够仅通过仓库恢复核心上下文，而不是依赖历史聊天。
