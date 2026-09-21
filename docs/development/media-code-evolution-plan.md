# PixivFlow Ecosystem Media Code Evolution Plan

Status: ACTIVE — Steps 20-22 closed (PixivFlow 2.45.0): all download paths emit canonical
`Artifact[]`, delivery paths are derived from artifacts, and the legacy
`DownloadedArtifact.files[]` projection is removed. Remaining pieced outside the
media-code plan are tracked in the operational docs (EXTERNAL_ACCEPTANCE_REQUIRED /
KNOWN_DEBT items).
Progress: Step 1 (manifest/proxy) DONE; Steps 2-7 IMPLEMENTED on PixivFlow master (08ec9d0, ec74b21, eea6f7e, 37bd9ca, ff736e9); Step 8 (TelePress MediaReference) DONE + VERIFIED (TelePress 0.12.1 runtime E2E returns assetId; PixivFlow 2.39.0 sends assetId/sourceUrl). Step 9 (on-demand preview via MediaReference manifest) RELEASED + DEPLOYED (PixivFlow v2.41.0/471ff53 live on pixivflow-scheduler; config materializationPolicy=on-demand in production.json) — 真实小说槽位 manifest-only 预览生产观测 EXTERNAL_ACCEPTANCE_REQUIRED. Step 10 (TelePost Delivery Asset Contract) RELEASED + DEPLOYED (TelePost 2.49.0 live on telesubmit-multi-bot; /health version=2.49.0; media_asset_refs VERIFIED on bot1/bot2 生产库). 真实 media_assets 生产 E2E EXTERNAL_ACCEPTANCE_REQUIRED（今日 10:00 槽位）；PixivFlow 上游发送 media_assets 已 VERIFIED（代码：v2.43.1 09d5c68 multipart fields.media_assets，PR #161 映射为 TelePost 契约形状 asset_id/source_url），TelePost multipart 解析已 VERIFIED（代码：2.57.0）。 Step 11 (DeliveryPlanner) RELEASED + DEPLOYED (TelePost 2.50.0 live; /health version=2.50.0; GET /api/bot1/v1/reviews/{id}/delivery-plan route VERIFIED 401-without-auth); 发布链路采纳该 plan VERIFIED（TelePost 2.52.0: publish_from_file_ids 通过 DeliveryPlanner 构建 items）。 Step 12 (TelegramMediaCache) RELEASED + DEPLOYED (TelePost 2.51.0 live; /health version=2.51.0; media_asset_refs.file_id/file_unique_id columns VERIFIED on bot1/bot2 生产库). 送达链路调用 mark_delivered_for_chain VERIFIED（TelePost 2.52.0: 确认送达后写回 media_asset_refs）。Step 11—13 完成；TelePost 2.53.0 增加 reaction-based heat（message_reaction_count → published_posts.reactions/heat_score）；Step 14 (Reuse Telegram Media) VERIFIED（同 asset 第二次投递使用 media_asset_refs.file_id，通过 Step 14 测试）。TelePost 2.54.1 隐藏 views/forwards 展示。TelePress deploy pin 收敛到 0.14.1，runtime package/version、health 和 generic-route Rich Novel E2E VERIFIED（三张真实 Pixiv novel-cover 图片 status=proxied，Telegraph 引用媒体代理，图片 200 image/jpeg）。scheduled PixivFlow manifest-only slot 观测仍 EXTERNAL_ACCEPTANCE_REQUIRED。
Batch 5 (TelePost MediaAsset 领域模型 + DeliveryVariant) RELEASED + DEPLOYED (TelePost 2.58.0, PR #223; 2.57.1 PR #221 修复新评审行 chain 只有重启才回填、导致 media_asset_refs 静默丢失的缺陷; 2026-09-21 生产自测: bot1 review 122 chain-122 落 10 行 i.pximg.net refs, delivery-plan 10 entries — 首次真实 media_assets 生产 E2E 证据; 10:00/10:10 槽位 VERIFIED，bot2 review 91 published 且 chain-91 file_id/file_unique_id 写回 VERIFIED；bot1 122/123/124 rejected，bot2 92 failed 属审批/发布结果，不代表 ingest/delivery-plan 链路失败)。TelePost 2.59.0 继续把 Step 17 的整组投递规划锁进回归测试，并把 `media_delivery_strategy` 记入 publish audit。
Scope: PixivFlow / TelePost / TelePress / Deploy
Type: Code-level migration plan

---

# 1. Purpose

本文不重新定义平台架构。

长期架构见：

```text
docs/architecture/ecosystem-platform.md
```

当前生产状态见：

```text
docs/operations/current-state.md
```

阶段推进顺序见：

```text
docs/operations/media-decoupling-delivery-plan.md
```

本文只回答：

> 代码具体应该怎么一步一步改，才能从当前 file-first 架构演进到 MediaAsset-first 架构，同时不破坏现有生产。

---

# 2. Current Code Shape

当前历史模型大致是：

```text
Pixiv API
↓
PixivFlow parser
↓
PixivFlow downloader
↓
local file
↓
DownloadedArtifact.files[]
↓
TelePost / TelePress
```

当前核心问题不是 Downloader 本身。

而是：

```text
Local File
```

同时承担了：

* source media identity
* transport format
* delivery input
* archive input
* preview input

导致所有消费者都被迫依赖下载。

---

# 3. Target Code Shape

目标：

```text
ResolvedWork
├── metadata
└── mediaAssets[]
       │
       ├── TelePost DeliveryPlanner
       ├── TelePress MediaProvider
       └── Materializer
              ↓
          Artifact[]
```

代码层必须逐步形成：

```text
Work
MediaAsset
Artifact
DeliveryVariant
```

核心不变量：

```text
MediaAsset != localPath
```

---

# 4. Migration Rule

整个演进过程必须遵守：

```text
ADD
↓
ADAPT
↓
MIGRATE CONSUMERS
↓
VERIFY PRODUCTION
↓
DEPRECATE
↓
REMOVE
```

禁止：

```text
RENAME EVERYTHING
↓
BREAK ALL CALLERS
↓
FIX AFTERWARD
```

---

# 5. Step 1 — Add Remote Media Reference To Existing Flow

目标：

不动核心下载模型，先让现有 Rich Novel 链路能够传递：

```text
local markdown ref
→ source URL
```

---

## 5.1 PixivFlow

当前已有类似 metadata：

```ts
assets?: Array<{
  marker: string;
  kind: 'uploadedimage' | 'pixivimage';
  sourceId: string;
  url?: string;
  localPath?: string;
  status: 'pending' | 'downloaded' | 'failed' | 'unavailable';
}>
```

第一步不要重写它。

直接从这里生成 Rich Novel manifest：

```ts
interface RichNovelMediaReference {
  local: string;
  source: string;
  kind?: string;
  sourceId?: string;
}
```

例如：

```json
{
  "local": "images/001.jpg",
  "source": "https://i.pximg.net/...",
  "kind": "uploadedimage",
  "sourceId": "123"
}
```

---

## 5.2 Transport

当前：

```text
multipart
├── md
└── images[]
```

演进为：

```text
multipart
├── md
├── manifest
└── images[]
```

注意：

`images[]` 暂时不删除。

---

## 5.3 TelePress

增加：

```python
manifest: Optional[str]
```

解析后：

```text
local ref
+
source URL
↓
MediaProvider decision
```

Pixiv URL：

```text
https://i.pximg.net/...
```

如果配置 legacy：

```text
TELEPRESS_PIXIV_PROXY_BASE
```

则改写成：

```text
<proxy>/pixiv/...
```

生产现在使用通用且受限的配置：

```text
TELEPRESS_MEDIA_PROXY_BASE
TELEPRESS_MEDIA_PROXY_HOSTS
```

命中 allowlist 时改写成：

```text
<proxy>/media/<host>/...
```

否则：

```text
继续 local upload fallback
```

---

## Step 1 Completion

必须有测试证明：

```text
old client without manifest
→ works

new client with manifest
→ works

proxy disabled
→ fallback works
```

---

# 6. Step 2 — Introduce MediaAsset Type In PixivFlow

在 proxy 路径生产 VERIFIED 后，开始正式模型迁移。

新增独立 domain type。

建议位置：

```text
src/domain/media/
```

或与当前项目结构一致的 domain/types 目录。

不要为了这个类型整体重排仓库。

---

## 6.1 Initial MediaAsset

第一版尽量简单：

```ts
export interface MediaAsset {
  id: string;
  source: 'pixiv';
  kind: 'image';

  sourceUrl: string;

  mimeType?: string;
  width?: number;
  height?: number;

  page?: number;

  sourceRef?: {
    workId: string;
    sourceId?: string;
    marker?: string;
  };
}
```

---

## 6.2 不应出现

MediaAsset 第一版禁止要求：

```ts
localPath: string
```

可以允许：

```ts
artifactId?: string
```

但不要把 Artifact 重新塞回 MediaAsset。

---

## 6.3 Stable Identity

不要简单把 URL 当唯一 ID。

建议：

```text
pixiv:<workId>:<media identity>
```

例如：

```text
pixiv:123456:p0
pixiv:987654:uploadedimage:111
```

要求：

* stable
* deterministic
* consumer-independent

禁止：

```text
telegram:file_id
```

进入 MediaAsset identity。

---

# 7. Step 3 — Introduce Artifact Type

现有：

```ts
DownloadedArtifact
```

承担太多职责。

不要立即删除。

先增加更基础的：

```ts
export interface Artifact {
  id: string;
  sourceAssetId?: string;
  workId: string;

  variant:
    | 'original'
    | 'text'
    | 'markdown'
    | 'zip'
    | 'metadata'
    | 'delivery';

  path: string;
  mimeType?: string;
  size?: number;
  checksum?: string;
}
```

---

# 8. Step 4 — Evolve DownloadedArtifact Additively

当前：

```ts
interface DownloadedArtifact {
  pixivId: string;
  type: DeliveryItemType;
  title: string;
  files: string[];
  ...
}
```

不要直接改成新的 incompatible 类型。

先增加：

```ts
interface DownloadedArtifact {
  // legacy
  files: string[];

  // new
  mediaAssets?: MediaAsset[];
  artifacts?: Artifact[];
}
```

规则：

```text
files[]
```

继续作为 compatibility projection。

---

## 8.1 Projection

可以临时实现：

```ts
function projectLegacyFiles(
  artifacts: Artifact[]
): string[] {
  return artifacts
    .filter(...)
    .map(a => a.path);
}
```

也就是说：

未来真实 source of truth：

```text
artifacts[]
```

旧消费者仍看到：

```text
files[]
```

---

# 9. Step 5 — Extract Materializer

当前 downloader 通常是：

```text
fetch
+
decode
+
save
+
metadata
+
artifact bookkeeping
```

下一阶段要分离：

```text
resolve
```

和：

```text
materialize
```

---

## 9.1 Materializer Interface

建议：

```ts
interface MediaMaterializer {
  materialize(
    asset: MediaAsset,
    options?: MaterializationOptions
  ): Promise<Artifact>;
}
```

---

## 9.2 Options

例如：

```ts
interface MaterializationOptions {
  variant?: 'original' | 'delivery';
  destination?: string;
}
```

第一版不要引入复杂 policy engine。

---

## 9.3 Existing Downloader

不要重写下载逻辑。

把已有下载实现包在：

```text
MediaMaterializer
```

后面。

也就是说：

```text
new architecture
→ adapter
→ existing downloader logic
```

而不是重新写一套 HTTP download。

---

# 10. Step 6 — Separate Resolve From Materialize

当前小说/插画流程可能是：

```text
API detail
↓
download
↓
return artifact
```

逐渐改为：

```text
API detail
↓
resolveWork()
↓
ResolvedWork
├── metadata
└── mediaAssets[]
```

然后：

```text
MaterializationPolicy
↓
optional materialization
```

---

## 10.1 ResolvedWork

建议：

```ts
interface ResolvedWork {
  work: Work;
  mediaAssets: MediaAsset[];
}
```

不要一开始塞：

```text
scheduler
delivery
telegram
preview
```

相关字段。

---

# 11. Step 7 — Materialization Policy

只有完成 resolve/materialize 分离后，再引入 policy。

建议：

```ts
type MaterializationMode =
  | 'eager'
  | 'on-demand';
```

第一阶段默认：

```text
eager
```

确保生产行为不变。

---

## 11.1 Later

等消费者迁移后：

```text
preview-only
→ on-demand

archive
→ eager/original

delivery
→ consumer-driven
```

---

# 12. Step 8 — Migrate TelePress Consumer

这是第一个适合迁移的消费者。

当前：

```text
PixivFlow
→ local images
→ TelePress
```

迁移到：

```text
PixivFlow
→ MediaAsset references
→ TelePress
```

---

## 12.1 TelePress Request V2

不要马上删除 multipart。

可以增加一个明确 contract，例如：

```json
{
  "document": {...},
  "media": [
    {
      "local": "images/001.jpg",
      "assetId": "pixiv:123:uploadedimage:1",
      "sourceUrl": "https://i.pximg.net/..."
    }
  ]
}
```

---

## 12.2 TelePress Internal Model

建议形成：

```python
MediaReference
```

例如：

```python
@dataclass
class MediaReference:
    asset_id: str | None
    local_ref: str
    source_url: str | None
    local_path: str | None
```

---

## 12.3 Provider Resolution

TelePress 内部：

```text
MediaReference
↓
ProviderResolver
```

决策：

```text
remote Pixiv source
→ ProxyProvider

local file
→ UploadProvider

already public URL
→ pass-through / policy
```

---

# 13. Step 9 — Stop Mandatory Novel Image Download

完成 TelePress MediaReference E2E 后：

小说 Preview path 可以从：

```text
download inline images
↓
build markdown
↓
send binaries
```

变成：

```text
parse markers
↓
resolve media assets
↓
build markdown refs
↓
send MediaReference[]
```

---

## Current status

IMPLEMENTED — PixivFlow PR #154 (master `3e2df03`):

- on-demand mode no longer requires local inline images; md sidecar uses `renderNovelMarkdownReference` with sourceId-based `images/<sourceId>.<ext>` refs.
- metadata keeps pending assets (`status: pending`, no `localPath`); `TelePressRichNovel` reads them as a proxy manifest when the work has no downloaded originals.
- preview publishing proceeds with manifest-only input (`imagePaths.length === 0, manifest.length > 0`).
- ZIP / full archive still requires downloaded originals (unchanged).

Runtime: DEPLOYED — PixivFlow v2.41.0 (`471ff53`) running on `pixivflow-scheduler` (logs show `PIXIVFLOW_REVISION=2.41.0+471ff53...`, scheduler initialised bot1/bot2). `production.json` carries `download.materializationPolicy: "on-demand"`.

EXTERNAL_ACCEPTANCE_REQUIRED — 需下一次真实小说槽位运行观测：NovelDownloader 保持 pending manifest（无 localPath）、md sidecar 用 MediaReference、TelePress 走 proxy 返回 `status=proxied`。

## 13.1 Important

这里只停止：

```text
preview path mandatory download
```

不要停止：

```text
ZIP creation
archive
explicit download
```

---

## 13.2 ZIP

当 ZIP 被要求时：

```text
mediaAssets
↓
materializer
↓
artifacts
↓
zip builder
```

---

# 14. Step 10 — Introduce TelePost Delivery Asset Contract

不要让 TelePost 直接吃 PixivFlow domain object 全部字段。

定义最小 delivery contract。

```ts
interface DeliveryMedia {
  assetId: string;
  kind: 'image';
  sourceUrl?: string;
  mimeType?: string;
}
```

现状（IMPLEMENTED on TelePost）：

- `POST /api/v1/submissions` 的 JSON `file_id` 路径接受可选 `media_assets` 数组，
  每项 `{asset_id, kind:'image', source_url, mime_type?}`；重复 `asset_id`、
  未知 `kind`、非 `http(s)` URL 一律 400 `invalid_media_asset`。
- refs 按 `review_chain_id` 落库到 SQLite `media_asset_refs`（替换语义，幂等）。
- `GET /api/v1/reviews/{id}` 返回 `media_assets`。
- 不传 `media_assets` 行为完全不变；本地 `file_id` 仍走原有
  `media_json`/`documents_json`。

| 状态 | 说明 |
|---|---|
| VERIFIED（Release+Deploy） | TelePost main 已合并（PR #184），release 已发布 v2.49.0，Fly 已部署；`/health` version=2.49.0，`media_asset_refs` 表在 bot1/bot2 生产库 VERIFIED；单元/API 集成测试 926 passed |
| EXTERNAL_ACCEPTANCE_REQUIRED | 用真实 `media_assets` payload（带有效 API token / 真实 PixivFlow 投稿）做生产 E2E，确认 201、DB 落库、`GET /api/v1/reviews/{id}` 读回 |
| VERIFIED（代码） | PixivFlow 上游发送 `media_assets`：v2.43.0（c27c924c）`src/delivery/HttpMultipartDelivery.ts` 把 `request.mediaAssets` 序列化为 multipart `fields.media_assets`；`OutboxWorker`/`DeliveryService` 从 `artifact.mediaAssets` 透传 |
| VERIFIED（代码） | TelePost multipart 子段解析 `media_assets`：2.57.0 `utils/api_server.py` multipart 路径 pop `media_assets` JSON 字符串字段并走同一 `_validate_media_assets`（JSON 与 multipart 共用同一校验/落库） |

---

# 15. Step 11 — DeliveryPlanner In TelePost

TelePost 应该自己决定：

```text
怎么把 MediaAsset 送到 Telegram
```

新增：

```text
DeliveryPlanner
```

而不是把这些判断继续放 PixivFlow。

策略：

```text
telegram_file_id
remote_url
local_upload / delivery_variant（未来）
```

现状（foundation IMPLEMENTED）：

- 新增 `telepost/application/delivery_planner.py`：纯函数 `plan_review_media`，
  输入审核稿本地 `media_json`/`documents_json` 与 `media_asset_refs`，输出
  `MediaDeliveryPlan`（整体 strategy + 逐项 entry）。
- 逐项策略：有本地 `file_id` → `telegram_file_id`（零重传）；否则 canonical
  `source_url` → `remote_url`（Telegram 自取）。
- 只读 API `GET /api/v1/reviews/{id}/delivery-plan`：审核/owner 权限可读，只返回
  plan，不改投递状态。
- 现有 `telepost/telegram/delivery/planner.py`（批次/专辑编排）继续承担“怎么发”，
  Step 11 planner 承担“用什么源发”。

| 状态 | 说明 |
|---|---|
| VERIFIED（Release+Deploy） | TelePost 2.50.0 已发布并部署；/health version=2.50.0；delivery-plan 路由在线（未鉴权 401-proof）；测试 934 passed |
| PLANNED | 把 plan 接入 ReviewService/PublicationService 的实际发布路径（当 review 只有 `media_assets` 而无 file_id 时按 `remote_url` 投递） |
| PLANNED | `local_upload` / `delivery_variant` 策略建模（multipart 已走 LocalFile，不重复建模） |

---

# 16. Step 12 — TelegramMediaCache

必须先检查现有 TelePost 数据模型。

如果已有：

```text
Delivery
Publication
Submission asset state
```

优先扩展现有表。

禁止直接创建：

```text
telegram_media_cache
```

新表而不调查已有状态归属。

现状（foundation IMPLEMENTED）：

- 不新建 `telegram_media_cache`；复用 `media_asset_refs` 同一行。
- 表已加 `file_id` / `file_unique_id` 列（幂等 `ADD COLUMN`，兼容存量库）。
- 新增 `mark_delivered_for_chain(chain_id, delivered)`：确认送达后按
  `(review_chain_id, asset_id)` 写入 cache，未知 asset 不幻行。
- `DeliveredMessage` / sender 已捕获 `file_unique_id`；`delivery_ledger.progress_json`
  同步记录。
- `GET /api/v1/reviews/{id}` 与 delivery-plan 会透出 `file_id` / `file_unique_id`；
  planner 在 cache 已有 file_id 时直接 `telegram_file_id`（即使 media_json 为空）。

| 状态 | 说明 |
|---|---|
| VERIFIED（Release） | TelePost 2.52.0：publish_from_file_ids 已接入 DeliveryPlanner 并调用 `mark_delivered_for_chain`；2.53.0 再叠加 reaction-based heat。运行时见 fly/deploy.telepost.toml 的 2.54.1 pin 与 /health version=2.54.1 |
| VERIFIED（DB） | media_asset_refs.file_id/file_unique_id 列在 bot1/bot2 生产库 VERIFIED；message_reaction_counts 表随 2.53.0 部署自动创建；Step 14 file_id 复用测试 VERIFIED |
| EXTERNAL_ACCEPTANCE_REQUIRED | 真实 media_assets 生产 E2E（PixivFlow 上游发送 media_assets）仍待生产确认 |

---

## 16.1 Required State

至少需要表达：

```text
bot identity
asset identity
file_id
file_unique_id
```

---

## 16.2 Scope

必须：

```text
(bot_id, asset_id)
```

而不是：

```text
asset_id -> file_id
```

---

# 17. Step 13 — Capture Telegram file_id

首次发送：

```text
remote URL
or
local upload
```

Telegram 返回 Message。

从结果里提取：

```text
file_id
file_unique_id
```

持久化到现有 Delivery state。

---

# 18. Step 14 — Reuse Telegram Media

第二次投递同 asset：

```text
lookup asset
↓
file_id exists?
↓
send using file_id
```

不再：

```text
Pixiv refetch
```

也不：

```text
local upload
```

---

# 19. Step 15 — Review Message Reuse

SKIPPED — YAGNI（2026-09-20）。

审核通过后走 `publish_from_file_ids`，媒体本来就是 Telegram file_id（零重传）。
copyMessages 只省「多调一次 API」，却引入 caption / 顺序 / 源消息存活三重校验
和新的失败语义；file_id resend 已经达到同样的零重传目标，复杂度不划算。

升级路径：只有当出现「同一 review 在多处发布、caption 完全一致且相册顺序固定」
的真实需求时，再评估 copyMessages；当前无此场景。

---

# 20. Step 16 — DeliveryVariant

处理 Telegram 平台限制。

新增：

```ts
interface DeliveryVariant {
  assetId: string;
  target: 'telegram';
  variant: string;

  artifact?: Artifact;
}
```

例如：

```text
telegram-photo
telegram-document
telegram-preview
```

---

## 20.1 Important

DeliveryVariant 不属于 source media identity。

不要把：

```text
compressed JPEG
```

写回：

```text
MediaAsset.sourceUrl
```

---

# 21. Step 17 — Album-Level Delivery Planning

不要按单文件独立决定：

```text
image
document
image
document
```

否则会再次出现：

```text
一组图片
+
一组 document
```

的混乱。

应先建立：

```text
SubmissionDeliveryPlan
```

针对整组媒体决定 presentation。

---

## 21.1 Example

```text
all photo-compatible
→ media group

some require variant
→ generate variants and keep group

cannot coherently present
→ explicit fallback mode
```

## 21.2 Status

| 状态 | 说明 |
|---|---|
| VERIFIED（代码） | TelePost `telepost/telegram/delivery/planner.py` already plans whole ordered media runs into homogeneous visual / document / animation / audio batches before send.  `tests/test_media_delivery_pipeline.py::test_novel_cover_assets_and_txt_never_mix_album_families` now locks the production-shape regression: 25 novel covers + one TXT must remain 25 photos + one document, never a mixed album. |

---

# 22. Step 18 — TelePress Web Reader

只有 TelePress provider model 稳定后才做。

新增：

```text
Renderer
```

抽象：

```python
class Renderer:
    publish(...)
```

实现：

```text
TelegraphRenderer
WebReaderRenderer
```

## 22.1 Decision

SKIPPED — YAGNI（2026-09-21）。TelePress 已经把 Telegraph 作为可用的在线阅读
renderer，且 `publication_previews` 已经持久化 URL。当前没有 first-party Web
Reader 的真实需求。只有当后续确有非 Telegraph 的 reader 目标时，再把抽象
renderer 抽出来。

---

# 23. Step 19 — Preview Persistence Decision

Web Reader 需要正文持久化。

必须做 ADR。

候选：

```text
A. PixivFlow Artifact Store
B. TelePress preview storage
C. shared object storage
```

选择前必须调查现有持久化和社区方案。

禁止直接：

```text
new sqlite db
```

只因为实现方便。

## 23.1 Decision

No new persistence layer is needed. TelePress keeps publishing stateless; the
production TelePost database already owns the durable `publication_previews`
row keyed by the publication. That is sufficient for the current Telegraph-only
Web path. Revisit this only when a first-party Web Reader is actually built.

---

# 24. Step 20 — Remove Mandatory Local File Assumptions

只有以下全部 VERIFIED 后才开始：

```text
TelePress remote refs
Telegram remote/file_id
Materializer
Artifact
DeliveryVariant
legacy fallback
```

---

## 24.1 Search

全仓搜索：

```text
files[0]
localPath!
existsSync(...)
readFile(media...)
download before deliver
```

找出：

> 哪些调用仍然假设 MediaAsset 一定有 local file。

---

## 24.2 Replace

逐步改为：

```text
need file?
↓
materialize()
```

而不是：

```text
file should already exist
```

## 24.3 Progress

| 状态 | 说明 |
|---|---|
| IMPLEMENTED | TelePress rich-novel 预览先从 `DownloadedArtifact.artifacts` 解析 `text` / `markdown` / `metadata`（2.44.0）；插画/ugoira/on-disk recovery 也统一产出 canonical `Artifact[]`，`DeliveryService.enqueue` 通过 `deliveryFilePaths()` 从 `artifacts` 派生投递路径，不再读取 legacy `files[]`。本地文件仍是真的 transport 输入，但只有消费者主动 `materialize()` 后才有路径事实。 |

---

# 25. Step 21 — Deprecate Legacy DownloadedArtifact Semantics

到这里：

```text
DownloadedArtifact.files[]
```

应该只剩 compatibility。

标记：

```ts
/** @deprecated use artifacts/mediaAssets */
files: string[];
```

但不要立即删除。

至少保留一个 release cycle。

## 25.1 Status

| 状态 | 说明 |
|---|---|
| IMPLEMENTED | `DownloadedArtifact.files[]` 已在 2.44.0 标记为 `@deprecated use artifacts/mediaAssets`；随后被 2.45.0 正式移除，仅保留一个 release cycle 的兼容窗口。 |

---

# 26. Step 22 — Remove Legacy Compatibility

删除前必须验证：

* TelePost 不再依赖 `files[]`
* TelePress 不再依赖 `files[]`
* CLI download path 使用 Artifact
* ZIP path 使用 Artifact
* tests 没有隐式依赖
* docs 不再描述旧 contract

然后才允许删除：

```text
legacy file-only contract
```

## 26.1 Status

| 状态 | 说明 |
|---|---|
| IMPLEMENTED | `DownloadedArtifact.files[]` 已从领域类型移除（PixivFlow 2.45.0）。`DeliveryRequest.files` 保留为 wire transport 字段：PixivFlow 在 enqueue 时从 canonical `Artifacts` 派生路径，TelePost multipart / Telegram upload 仍按该契约收本地文件；历史 outbox 行与 legacy outbox manifest 的 `files` 字段不变，继续由迁移器读取。 |

---

# 27. Error Evolution

代码模型迁移同时必须推进错误 contract。

每个关键层应有自己的 stage。

建议至少：

```text
discovery
resolve_work
resolve_media
materialize
transform
preview
delivery
publication
notification
```

---

## 27.1 Do Not Flatten

禁止：

```ts
catch {
  return INTERNAL_ERROR
}
```

正确：

```text
原始错误
↓
domain classification
↓
OperationalResult
```

包含：

```text
code
stage
reason
retryable
operator_hint
correlation_id
```

---

# 28. Observability Evolution

随着新路径增加，记录：

```text
media_delivery_strategy
```

候选值：

```text
proxy
upload_provider
telegram_file_id
telegram_copy
remote_url
delivery_variant
materialized_source
```

目的不是新建大型 telemetry 平台。

而是回答：

> 这次媒体最终走了哪条路？

---

# 29. Persistence Ownership

必须保持：

```text
PixivFlow
→ media/source/artifact execution state

TelePost
→ Telegram/business delivery state

TelePress
→ preview/publishing state only when required
```

禁止：

```text
PixivFlow 保存 telegram_file_id
```

禁止：

```text
TelePost 保存 Pixiv candidate inventory
```

---

# 30. API Evolution Strategy

API 改动统一采用：

```text
optional additive field
↓
new consumers adopt
↓
production verify
↓
legacy deprecation
↓
removal
```

优先：

```json
{
  "files": [...],
  "media": [...],
  "artifacts": [...]
}
```

过渡。

不要突然：

```text
files removed
```

---

# 31. Test Evolution

每次新增代码层，都必须同时补对应测试。

---

## MediaAsset

测试：

* stable id
* no localPath requirement
* multi-image ordering
* novel uploadedimage
* pixivimage

---

## Materializer

测试：

* success
* retry
* source unavailable
* checksum
* duplicate materialization

---

## TelePress

测试：

* proxy rewrite
* invalid host rejected
* no proxy config fallback
* local upload fallback
* mixed refs
* provider failure isolation

---

## TelePost

测试：

* first upload
* file_id persistence
* file_id reuse
* bot isolation
* copyMessages
* deleted source message fallback
* URL failure fallback
* large-media variant
* album coherence

---

# 32. Production Migration Order

生产切换必须按以下顺序：

```text
1. Add proxy capability
2. Add manifest
3. Verify proxy E2E
4. Add MediaAsset
5. Keep eager materialization
6. Migrate TelePress
7. Enable lazy preview materialization
8. Migrate TelePost
9. Enable Telegram media reuse
10. Remove mandatory materialization
11. Deprecate legacy files[]
12. Remove legacy contract
```

禁止提前做第 10–12 步。

---

# 33. Feature Flags / Safe Rollout

如果当前配置体系支持，建议使用配置而不是 hard switch。

例如：

```text
media.referenceMode
preview.preferProxy
delivery.preferTelegramCache
materialization.mode
```

但不要为了 migration 新建复杂 feature flag 平台。

配置只用于：

```text
rollback
canary
gradual enablement
```

---

# 34. Rollback Rules

每次切换必须保留上一条可用路径。

---

## Proxy

```text
proxy
↓ fail
ImageHost
```

---

## Telegram

```text
file_id
↓ fail
remote URL
↓ fail
DeliveryVariant
↓ fail
local artifact
```

---

## Materialization

```text
on-demand
↓ incompatible consumer
legacy eager mode
```

---

# 35. Documentation Synchronization

每完成一个代码阶段：

必须检查：

```text
ecosystem-platform.md
current-state.md
media-decoupling-delivery-plan.md
media-code-evolution-plan.md
AGENTS.md
CONTRACT.md
README
```

不是全部机械修改。

但必须判断是否需要更新。

---

# 36. Community Research Rule

已落地调研结论见 [community-reference-position.md](../architecture/community-reference-position.md)。



每新增通用技术层前必须重新调查社区方案。

例如：

```text
Pixiv proxy
→ Pixiv.Cat / pximg proxy

Telegram delivery
→ Telegram Bot API native capabilities

Web Reader
→ mature rendering/static publishing solutions

Media transformation
→ existing image libraries
```

调研记录必须进入 ADR / architecture docs。

---

# 37. Do Not Over-Abstract Early

禁止在第一阶段创建：

```text
IMediaSourceResolver
IMediaTransportStrategy
IMediaStorageProvider
IMediaCacheProvider
IMediaRenderPipeline
```

一大堆只有一个实现的接口。

抽象原则：

```text
先出现真实第二个实现
↓
再抽象公共边界
```

ProxyProvider / UploadProvider 是因为已经真实存在两个媒体获取路径。

不是为了“架构漂亮”。

---

# 38. Avoid Domain Leakage

PixivFlow MediaAsset 不应该出现：

```text
telegram_file_id
telegraph_url
catbox_url
```

TelePost business state 不应该出现：

```text
candidate ranking score implementation detail
```

TelePress 不应该决定：

```text
review required
```

---

# 39. Target End State

最终 PixivFlow：

```text
resolveWork()
→ Work + MediaAsset[]

materialize(asset)
→ Artifact

package(artifacts)
→ ZIP/etc.
```

最终 TelePost：

```text
Submission
→ DeliveryPlanner
→ Telegram Delivery

MediaAsset
→ file_id / URL / variant / artifact
```

最终 TelePress：

```text
Document + MediaReference[]
→ MediaProvider
→ Renderer
→ Public Preview
```

---

# 40. End-State Flow

最终 Illustration：

```text
Pixiv
↓
PixivFlow resolve
↓
MediaAsset[]
↓
TelePost
↓
DeliveryPlanner
├─ file_id
├─ proxy URL
├─ DeliveryVariant
└─ materialize fallback
↓
Telegram
```

最终 Novel Preview：

```text
Pixiv
↓
PixivFlow parse
↓
NovelDocument + MediaAsset[]
↓
TelePress
↓
ProxyProvider
↓
Renderer
├─ Telegraph
└─ Web Reader
```

最终 Archive：

```text
Work + MediaAsset[]
↓
Materializer
↓
Artifact[]
↓
ZIP
```

---

# 41. Final Removal Checklist

只有以下全部为 VERIFIED：

```text
MediaAsset canonical
Artifact canonical
Materializer stable
TelePress remote media stable
Telegram file_id stable
URL fallback stable
DeliveryVariant stable
ZIP/archive stable
production E2E stable
restart/retry stable
docs synchronized
```

才允许删除：

```text
mandatory local media assumptions
```

---

# 42. Definition Of Code Completion

代码演进真正完工的标准不是：

```text
new classes exist
```

而是：

### PixivFlow

```text
可以解析媒体而完全不下载
```

### TelePress

```text
可以只用 remote MediaReference 完成预览
```

### TelePost

```text
可以只用 MediaAsset 完成 Telegram delivery planning
```

### Artifact

```text
只有真正需要文件的 consumer 才调用 materialize
```

### Legacy

```text
files[] 不再是核心 contract
```

### Production

真实链路验证：

```text
Pixiv
→ resolve
→ consumer
```

和：

```text
Pixiv
→ resolve
→ materialize
→ artifact
```

两条路径都独立成立。

---

# 43. Short Version For Agents

如果只记住一件事：

```text
不要删除 Downloader。
不要继续让 Downloader 成为一切的入口。
```

正确演进：

```text
File-first
↓
File + Media Reference
↓
MediaAsset + Artifact
↓
Consumer-driven materialization
↓
Legacy file contract removed
```

每一步都必须：

```text
兼容
可回滚
有测试
有生产验证
同步文档
```
