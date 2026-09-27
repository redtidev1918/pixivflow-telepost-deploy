# 架构级审计与改造方案：重抓生命周期 / Tag 扩展 / 候选生命周期 / 媒体封面

Status: P0/P1 IMPLEMENTED + VERIFIED（TelePost 2.69.0 / 2.70.0 / 2.70.1 + PixivFlow 3.1.0；release → pin → 部署 → 运行时取证全部完成，见 `docs/operations/current-state.md` §4）→ 业务面现场验收 `EXTERNAL_ACCEPTANCE_REQUIRED`
Scope（实施）: `redtidev1918/TelePost` @ `fa9323d`（2.69.0，功能提交 `69849e2` / `266017d`）、`redtidev1918/PixivFlow` @ `583a74c`（3.1.0，功能提交 `661964c` / `d23fed2`）、本仓库（pin/契约/运维面）
Scope（审计基线）: `redtidev1918/TelePost` @ `8cb6e95`（2.68.1）、`redtidev1918/PixivFlow` @ `3775a8d`（3.0.3）
Method: 三份只读审计（重抓生命周期 / Tag 扩展 / 健康与幂等面）+ 维护者第一手代码核对，全部结论都带 `文件:行号`

> §1–§7 是**改造前（审计基线）**的记录。§2/§3 中已被 2.69.0 / 3.1.0 推翻的句子**保留原文并就地标注「改造前事实」**，
> 不删除证据（历史审计证据与现状描述必须可区分）；实施结果见 §0，持久架构参考见 `docs/architecture/refetch-job-model.md`。

## 0 实施结果（2026-09-27）

P0（TelePost 重抓作业状态机 + 只读 doctor）与 P1（Tag provenance、封面内容类型）已 IMPLEMENTED，
对应关系如下（「验证」列只写**实际跑过**或**提交信息声明**的结果，其余一律 `待确认`）：

| 缺失的模型 | 落地实现（文件 / 提交） | 版本 | 验证 |
| --- | --- | --- | --- |
| 作业单一权威（状态 + 迁移表） | `telepost/domain/refetch_state.py`（254 行：9 个规范状态 `:41-49`、`ALLOWED` `:90-111`、`assert_transition` `:223`） | TelePost 2.69.0（`69849e2`） | **本机复跑**（`/tmp/tp-venv312`）：`pytest -q -p no:cacheprovider --no-cov` → `1110 passed, 1 skipped in 48.86s`；四个重抓套件 → `62 passed in 2.60s`（早期基线连续 5 次复跑均 61 passed） |
| 唯一写入口 | `RefetchRepository.apply_transition_on`（`telepost/storage/sqlite/refetch.py:200-279`） | 同上 | 6 个调用点全部在同一文件内（`:287`、`:340`、`:487`、`:500`、`:558`、`:566`） |
| 逐次事件时间线 | 新表 `refetch_events`（`database/db_manager.py:364-377`）+ `list_events`（`refetch.py:114-121`） | 同上 | API 投影为 `events[]`（`telepost/application/refetch.py:265-277`） |
| 候选因果（谁被拒绝/替换） | `refetch_seen_candidates` 增列 `request_id/outcome/reason/decided_at/replaced_by`（`db_manager.py:406-418`）+ `_record_candidate_outcome`（`refetch.py:419-437`） | 同上 | 投影为 `lineage[]`（`application/refetch.py:243-262`） |
| 进度投影（任务 ID / 阶段 / 已等待） | `refetch_task_id`（`application/refetch.py:289-297`）、`refetch_pending_text`（`telepost/telegram/review_keyboard.py:116-138`）、`GET /api/v1/reviews/{id}/refetch`（`utils/api_server.py:2308-2326`，路由 `:2533`） | 同上 | 现场点击验收 = `EXTERNAL_ACCEPTANCE_REQUIRED`（待执行） |
| 看门狗四道闸门（可重复提醒 + 必达终态） | `handlers/review.py:489-714`；默认 2 / 10 / 20 / 12 / 30 分钟（`:88-108`） | 同上 | 同上（代码路径已核对，行为待现场） |
| 只读健康自检 `telepost doctor` | `telepost/observability/doctor.py`（989 行）+ `cli.py`（148 行），提交 `266017d`；2.70.1（`95ddc64`）修正账本历史行误报 | 2.69.0 / 2.70.1 | **本机复跑** `tests/test_doctor.py` → `31 passed`；**现场复验**（容器内 `doctor --all-bots`）→ `HEALTHY / 16 OK / 0 WARN / exit 0` |
| Tag 关系与权重（provenance） | `src/topic/types.ts:21,35,37`、`src/topic/TopicPipeline.ts`（`:210` 先过滤再检索）、`AUTOCOMPLETE_ONLY_SCORE = 0.27`（`src/topic/TopicTagScorer.ts:54`），提交 `d23fed2` | PixivFlow 3.1.0（`583a74c`） | **本机复跑**（本地工作树 HEAD `d23fed2`，比 `583a74c` 落后 1 个提交）：`node_modules/.bin/jest --silent` → `Test Suites: 129 passed, 129 total` / `Tests: 1424 passed, 1424 total`；`node_modules/.bin/tsc --noEmit` exit 0 |
| 封面内容类型（§4 的 P2，第二批） | `src/domain/media/NovelCoverPolicy.ts`（84 行：`classifyNovelCover()` / `coverDeliveryDecision()`）、`src/utils/imageDimensions.ts`（97 行，3.0.3 的 `182694d`），提交 `661964c` | 同上 | 同上；`download.novelCover.unknown` 默认 `skip`（`src/domain/media/NovelCoverPolicy.ts:56`） |
| 文档 | PixivFlow `docs/TAG_RANKING.md`（141 行）；本仓库 `docs/architecture/refetch-job-model.md` | 3.1.0 / 本仓库 | 文件存在 |

**仍未完成或与方案有出入**

* **P2 推广**：把「内容类型」从封面推广到媒体资产管线（插图/内嵌图同样带来源与类型标注），以及新文档 `docs/MEDIA_PIPELINE.md`——未开始（§4 P2「后续」）。
* **会话读模型**：§4 P0.5 的 `ReviewSession{current_candidate, history[]}` 类在 TelePost 中不存在（全仓库无 `ReviewSession`）；落地形式是 `refetch_seen_candidates` 的因果列 + `lineage[]` 投影（`telepost/application/refetch.py:243-262`）。
* **迟到替换稿被接受**：§4 P0.4 的后半段未实现——源审核已结束后的迟到结果仍按 `obsolete` 处置（`telepost/AGENTS.md:103`、`telepost/docs/CONFIGURATION.md:214`），只是该路径现在经状态机写成 `CANCELLED`。
* **`telepost doctor` 的 HTTP 就绪面检查**：§4 P0.6 列出的「HTTP 就绪面」未在落地版本中实现；实际检查项见 `docs/architecture/refetch-job-model.md` §9。
* **本仓库的 pin/现场核对**：已完成（2.70.1 / 3.1.0 已 pin、部署、`/health` + `verify-images.sh` + `doctor --all-bots` + 容器内 grep 全部通过）；
  证据见 `docs/operations/current-state.md` §4；只剩业务面现场验收（真实点一次重抓 / 小程序禁用态）。

§7 的三条非目标保持不变：不在 TelePost 做封面/媒体类型过滤；不实现 QQ/微信协议、不新建第二套任务系统、不复制既有幂等键。

---

## 1 审计结论摘要

四个现场问题不是四个孤立的 bug，而是四条链路各自缺了一层**模型**：

| 现场现象 | 缺失的模型 | 现有实现把什么当成了什么 |
| --- | --- | --- |
| 点「重抓」后长时间无反馈、超时无结论 | **作业（job）状态机 + 事件时间线** | 把重抓当成「一次 HTTP 触发 + 观察者式看门狗」：状态字符串从 5 处（含 2 处绕过仓储）写入，无迁移校验、无逐次进度 |
| Tag 联想跑偏（相关热门 Tag 顶掉原始 Tag） | **关系类型与权重（provenance）** | 把「联想」当成「候选检索池」：原始 Tag 与扩展 Tag 在同一分数空间里按热度竞争 |
| 卡片上「拒绝」与「重抓」语义纠缠 | **会话（ReviewSession）：当前候选 + 候选历史** | 以「审核记录 `pending_reviews`」为中心，候选历史只留在 `refetch_seen_candidates` 且没有 attempt/原因/时间关联 |
| 默认封面被当成封面投递 | **媒体资产的内容类型（content type）** | 把封面当成一个 URL 字符串，靠 URL 猜测；没有 `unknown` 安全模式 |

---

## 2 现状流程（证据）

### 2.1 重抓链路（TelePost ↔ PixivFlow）

```
按钮(review_keyboard.py:31-34, 仅 source='api' 且有 pixiv_id)
  → callback_handlers.py:74-76 → handlers/review.py:835 refetch_review
  → application/refetch.py:72 request_refetch（唯一入口）
      ├─ 门禁 :98-105  ├─ 配置 :106-107  ├─ 回调重放 :114-130
      ├─ 链/代/种子 :133-135  ├─ create_attempt(storage/sqlite/refetch.py:82) :137-143
      └─ asyncio.create_task(_do_refetch) :209   ← 非持久化
  → handlers/review.py:747 _submit_pixivflow_refetch
      POST {base}/internal/targets/{id}/refetch  {requestId, correlationId} → 202 accepted
  → PixivFlow ScheduleTriggerServer.ts:298；作业状态 = slot cell status
      SlotStateMachine.ts: pending→selected→artifact_ready→delivery_pending→submitted
  → 状态读取 handlers/review.py:774 _read_pixivflow_refetch_status
      GET /internal/targets/:targetId/refetch/:requestId → ScheduleTriggerServer.ts:327
  → 替换稿回传 utils/api_server.py:1497 create_submission → review_queue.py:598 _reserve_replacement
  → 提交 storage/sqlite/reviews.py:203 finalize_control → storage/sqlite/refetch.py:213 finalize_replacement
  → 结果回执 POST /api/v1/refetch/outcomes → refetch.py:264 apply_outcome
  → 看门狗 handlers/review.py:439 monitor_refetch_progress（main.py:786，300s，每个 bot 进程各跑一遍）
```

状态写入点（**改造前事实（2.68.1）**；**5 处，其中 2 处绕过仓储**）：`storage/sqlite/refetch.py:91`(`requested`)、`:120`(`admitted`)、`:129`(`failed`)、`:146/:254`(`replaced`)、`:240/:300`(`obsolete`)、`:306`(`no_alternative`|`failed`)；绕过的两处为 `storage/sqlite/reviews.py:224-228` 与 `application/review_queue.py:617-621`。

### 2.2 Tag 扩展链路（PixivFlow）

```
TopicPipeline.selectWorks (src/topic/TopicPipeline.ts:68)
  → TopicResolver.resolve (:52) → TopicCache.loadFresh (TopicCache.ts:48) → 未命中则 discover() (:97)
      gatherSamples (:146)：/v2/search/autocomplete(app-api/tags.ts:8) + 种子检索 + 背景采样
      TopicTagScorer.score (TopicTagScorer.ts:62)
      score = recall × specificity × suggestionWeight × genericPenalty   (:123-127)
  → 空间装配 TopicResolver.ts:115-130（种子硬编码 score=1；相关 ≥ minScore 0.22；maxTags-1）
  → 召回分支 TopicPipeline.ts:136-151（默认 relatedTags='always' ⇒ 每个 Tag 都是一条独立检索通道）
  → acceptedWorks (:230) / metadataScore (:258) → topByPopularity (:321) / rankCompare (:312)
```

`ResolvedTag` 只保留 `seed`/`suggested` 两个布尔；`translated_name` 与 `add_by_uploaded_user` **从未参与匹配**（`TopicPipeline.ts:213`、`:262-267`、`TopicResolver.ts:117`）。阈值 0.6/0.6/0.5、`AUTOCOMPLETE_ONLY_SCORE=0.27`、lift 常数 0.03、泛化惩罚 0.4、建议加成 1.1 全部硬编码。
（**改造前事实（3.0.3）**：3.1.0 起 `ResolvedTag` 增加可选 `source`/`weight`（`src/topic/types.ts:21,35,37`），
`translated_name` 可经 `topicDiscovery.matchTranslatedNames` 参与匹配（默认 `false`），
`add_by_uploaded_user` 仍未参与匹配。）

### 2.3 候选/审核生命周期（TelePost）

`pending_reviews`（db_manager.py:91-120 + ALTER 121-250）以记录为中心：`status ∈ {pending, preparing, publishing, published, failed, rejected, expired, superseded}`；`refetch_attempts`（:271-311）以**尝试**为中心；`refetch_seen_candidates`（:317-327）以**链**为中心，`UNIQUE(review_chain_id, candidate_id)`、`source ∈ {original, replacement}`——**没有 attempt 关联，也没有原因/时间**（**改造前事实（2.68.1）**：2.69.0 已为其增加 `request_id`/`outcome`/`reason`/`decided_at`/`replaced_by`）。`request_refetch` 只读 `status`（application/refetch.py:98-101）；卡片文案「视为已拒绝」只是文案（review_keyboard.py:125），`rejected` 只在 reviews.py:486 写入——**源码永不被重抓路径误判为已拒绝**（这一点现有实现是对的，必须保持）。

### 2.4 媒体/封面链路（PixivFlow → TelePost）

封面在获取阶段只是一个 URL：`NovelDownloader` 记录 `cover_url`（src/download/NovelDownloader.ts:236-237），产出 `pixiv:<id>:novelcover` 资产；TelePost 侧 `novel_cover_preview_url()`（application/review_queue.py）+ `handlers/publish.py novel_cover_asset_ids()` 消费。Pixiv 把**作者封面**与**现场渲染的设计封面**放在同一条 CDN 路径（`novel-cover-master/img/...`，每篇一个独立哈希），API 无任何区分字段。（**改造前事实（3.0.3 之前）**：3.0.3 的 `182694d` 起按画布尺寸判定（恰好 640x900），3.1.0 的 `661964c` 把它收敛为内容类型 + 投递策略，见 §0。）

---

## 3 根因分析

### R1 重抓：状态是「字符串」，不是「状态机」

- **无单一权威**：`refetch_attempts.state` 由 5 处写入，2 处绕过仓储（`reviews.py:224-228`、`review_queue.py:617-621`），没有迁移表校验，非法迁移无法被拦下——回归防护表（允许/禁止）在代码里根本不存在。（**改造前事实（2.68.1）**：2.69.0 的迁移表见 `telepost/domain/refetch_state.py:90-111`，唯一写入口为 `apply_transition_on`。）
- **无事件时间线**：终态原因只落在 `audit_events`（db_manager.py:588），无法按 attempt 查询；用户和运维都看不到「什么时候进入哪个阶段」。（**改造前事实（2.68.1）**：2.69.0 新增 `refetch_events` 逐次时间线。）
- **看门狗是观察者，不是执行者**：提醒只发一次（`review.py:584-587` 的 `if last: continue`），一旦 `admitted` 且远端持续返回 ACTIVE/空串，控制流走到 `:582-586` 后**永久 `continue`**；90 分钟硬超时只在 `remote_state == "unavailable"` 分支（`:542-543`）可达 ⇒ **存在无限静默的窗口**（违反 §refetch-terminal-notify 的硬 SLA）。（**改造前事实（2.68.1）**：2.69.0 起提醒按 `REFETCH_PROGRESS_REMIND_MINUTES`（默认 2 分钟）周期重复，STAGE/STALE/HARD 三道闸门都必须走向终态。）
- **本地时间 vs 远端真相**：45 分钟 stale 直接 `mark_failed('admission_timeout')`，之后真实的晚到替换稿会被 `resolve_replacement` 的 ACTIVE_STATES 校验拒绝（refetch.py:192 → review_queue.py:614-615）——迟到的合法结果被自己的看门狗丢掉。（**改造前事实（2.68.1）**：2.69.0 保留 20 分钟 admission 超时（`REFETCH_STALE_TIMEOUT_MINUTES`），但已受理的 attempt 先读远端 durable cell 再判定。）
- **进程模型**：远端提交是 `asyncio.create_task`（application/refetch.py:209），不是持久化任务；多 bot 部署下每个 bot 进程都跑一份看门狗（main.py:786），彼此没有分工。
- **静默终态**：`finalize_control` 的 obsolete 路径删掉新控制消息并抛 `RuntimeError`（review_queue.py:439-441）→ 502，**没有任何通知与卡片刷新**。（**改造前事实（2.68.1）**：2.69.0 起该路径经 `mark_cancelled_on` 走状态机，见 §0。）

### R2 Tag：只有「相关度」，没有「关系」

- `score` 表达的是「在这批作品里共现有多强」，**不区分关系类型**（原始 tag / Pixiv 官方联想 / 用户共现），也不表达方向与层级；同一空间里按分数取前 `maxTags-1`，再用热度排序 ⇒ 热门但语义较远的相关 Tag 可以顶掉原始 Tag。
- 默认 `relatedTags='always'` 让每个 Tag 成为**独立检索通道**（TopicPipeline.ts:136-151）：相关 Tag 不是「提示」，而是「替代主题」。这正是现场「西瓜肚 → 丸吞」的机理。
- 已存在的语义信号被浪费：`translated_name`（中/英译名）与 `add_by_uploaded_user` 从未参与匹配；`suggested` 只是 1.1 的乘法加成，无法表达「官方联想 = 中等权重」。

### R3 候选生命周期：以「记录」为中心而不是以「会话」为中心

卡片只有「发布/拒绝/重抓/遮罩」四个动作，而「拒绝当前候选」与「继续寻找候选」在数据上不可区分：`pending_reviews` 只保存当前候选，历史候选只在 `refetch_seen_candidates`，且**没有 attempt/原因/时间**——「谁被拒绝、为什么、何时被替换、替换来源」无法回答。用户连续重抓 A→B→C 时，链与代（`review_chain_id`/`generation`/`supersedes_review_id`）已经正确工作，但缺少**会话视图**：当前候选 + 候选历史 + 每次替换的因果。

### R4 封面：媒体资产没有内容类型维度

获取阶段只搬运 URL 字符串，`novel-cover-(master-)?default` 这类 URL 特征已经失效（Pixiv 改为逐篇渲染），于是「有没有自定义封面」这个**内容类型问题**被错当成「URL 模式问题」。同时缺少 `unknown` 安全模式：Pixiv 结构变化时既不能静默投递设计封面，也不能静默丢图。

---

## 4 改造方案

原则：**先建模，再改行为**；所有新增行为都要有默认值保持向后兼容；不在 TelePost 里过滤封面（内容类型判定留在获取阶段）；不引入第二套任务系统（复用 Telegram 侧既有仓储 + PixivFlow 既有 cell 状态与幂等键）。

### P0 重抓作业（TelePost）

1. **单一状态机**：新增 `telepost/domain/refetch_state.py`，定义规范状态与迁移表：

   ```
   REQUESTED → SEARCHING → FILTERING → CANDIDATE_FOUND → REPLACED
        ↘ FAILED / TIMEOUT / NO_CANDIDATE / CANCELLED（终态，不可回流）
   ```
   旧值映射：`requested`→REQUESTED、`admitted`→SEARCHING、`no_alternative`→NO_CANDIDATE、`obsolete`→CANCELLED；`FILTERING`/`CANDIDATE_FOUND` 由 `monitor_refetch_progress` 依据远端 cell 状态推进（`selected/artifact_ready/delivery_pending` ⇒ CANDIDATE_FOUND）。
   禁止迁移（回归表）：终态不可回流、`REPLACED` 之后不得再 `REQUESTED`（同链需新建代）、`FAILED/TIMEOUT/NO_CANDIDATE/CANCELLED` 不得进入 `FILTERING`。**在仓储层强制**（唯一写入口 `_transition()` → `assert_transition`）。
2. **事件时间线**：新增 `refetch_events(request_id, from_state, to_state, reason, actor, remote_state, created_at)`；每次迁移 1 行 + 结构化日志（`request_id`、`review_id`、`state`、`elapsed_ms`），实现「关键流程 begin / state change / end」可追溯。
3. **进度投影**：卡片文案带 `任务ID: refetch-<review>-<ts>`、开始时间、当前阶段与已等待时长；阶段由「本地作业状态 + 远端 cell 状态」共同决定（远端不可达时显示「远端状态不可用」而不是假装在搜索）。
4. **看门狗重写**：任何分支都必须走向终态——提醒按 `notify_count` 周期性发出（默认每 2 分钟，带已等待时长），15 分钟等待告警、30 分钟自动终止（可配置，必须低于现有 45/90 分钟），终止即 `TIMEOUT` + 群通知 + 卡片交还；`admitted` 期间不得仅凭本地时间判死（先读远端 durable cell）；晚到结果改为**可被接受**（终态若为 `TIMEOUT` 且替换稿确实到达，走「迟到替换」路径并通知）。
5. **候选历史**（R3）：`refetch_seen_candidates` 增加 `request_id`/`attempt_id`/`outcome`/`reason`/`decided_at`/`replaced_by`；新增会话读模型 `ReviewSession{current_candidate, history[]}`；卡片与 Mini App 都能回答「上一个候选是谁、为什么被换掉」。
6. **`telepost doctor`**：新增 `telepost/observability/doctor.py`（`python -m telepost.observability.cli doctor [--json]`），检查：卡住的重抓（15 分钟 WARN / 30 分钟 FAIL）、>30 分钟 RUNNING 行、孤儿审核（`status='pending'` 且无控制消息）、未发送媒体（delivery_ledger/outbox）、`publishing` 卡住、`refetch` 部分唯一索引不变量、HTTP 就绪面。退出码 0/1/2（干净/失败/无法验证），一次运行即产出 `HEALTHY`/`DEGRADED`/`FAILED` 摘要块。

### P1 Tag 关系与权重（PixivFlow）

1. `ResolvedTag` 增加可选 `source: 'seed'|'cooccurrence'|'autocomplete'|'cooccurrence+autocomplete'` 与 `weight`（= 现有 score，保持兼容）；评分器/解析器负责填充。
2. 配置（全部可选，默认 = 今日行为）：
   ```json
   { "relatedTags": "always",
     "tagRelations": { "allowSources": ["seed","cooccurrence","autocomplete"], "deny": [], "allow": [] },
     "seedTier": "off" }
   ```
   `tagRelations` 过滤/强制 Tag 集合（deny 优先）；`seedTier='on'` 强制「原始 Tag 永远排在扩展 Tag 之前」的硬层级（默认关闭，因为默认关闭是现有测试与产品决定所要求的）。
3. 消费既有语义信号：`translatedName` 参与匹配（中/英检索命中不再丢失），`add_by_uploaded_user` 作为来源标注（官方用户标签）。
4. 诊断：`pixivflow topic inspect` 输出 Top-N Tag 及其 `{name, source, weight}`；验收要求「原始 Tag 权重最高、相关权重不得超过原始、弱语义扩展被降权或丢弃」。
5. 新文档 `docs/TAG_RANKING.md`（分值语义 / 关系类型 / 配置 / 诊断）。

### P2 媒体内容类型（PixivFlow，已落地第一版）

- `src/domain/media/NovelCoverPolicy.ts`：`classifyNovelCover()`（custom / pixiv_generated / unknown）+ `coverDeliveryDecision()`；`pixiv_generated`（恰好 640x900）永不投递；`unknown` 默认 `skip`（安全模式，`download.novelCover.unknown`），**探测失败**（`probe_failed`）保留封面。
- 后续：把「内容类型」从封面推广到媒体资产管线（插图/内嵌图同样带来源与类型标注），新文档 `docs/MEDIA_PIPELINE.md`。

---

## 5 数据模型与迁移（TelePost）

| 变更 | 内容 |
| --- | --- |
| `refetch_attempts` | 新增 `updated_at`、`last_remote_state`、`notify_count`、`terminal_reason`、`result_review_id`、`operation_id`；`state` 迁移到规范值；重建部分唯一索引 `WHERE state IN ('requested','searching','filtering','candidate_found')` |
| `refetch_events`（新） | 迁移时间线：`request_id`、`from_state`、`to_state`、`reason`、`actor`、`remote_state`、`created_at` + 索引 |
| `refetch_seen_candidates` | 新增 `request_id`、`outcome`、`reason`、`decided_at`、`replaced_by` |
| 兼容 | 迁移是幂等 ALTER + 数据映射；旧值读取方（应用层、Mini App、测试）统一经 `refetch_state.from_legacy()`，不保留双写 |

回滚：迁移只增列/改字符串，回滚 = 恢复旧值映射（`searching`→`admitted` 等），实现层保留 `to_legacy()` 以支持一次性回滚脚本。

---

## 6 验收矩阵

**功能层**：重抓正常替换；超时自动结束；无候选；连续重抓 A→B→C（不冻结、不覆盖、不丢历史）；失败必带原因；25 分钟内任何一次点击都有可见反馈（任务ID + 开始时间 + 阶段）。
**回归层**：迁移表（允许/禁止）以单元测试固化；`PENDING→PUBLISHED`、终态回流、`FAILED` 重新进入正常流程全部被拒；现有 31+12+9 个重抓测试不得回归。（**最终复核**：`tests/test_refetch.py` 32 个 `def test_`、`tests/test_refetch_card_state.py` 12、`tests/test_refetch_replacement.py` 10、`tests/test_identity_provenance.py` 8，共 **62**；`tests/test_doctor.py` 31 项。第 62 例为连续重抓 A→B→C 回归测试 `test_chained_refetch_a_to_b_to_c_keeps_one_active_generation`。）
**线上自适应层**：健康巡检（15 分钟 WARN / 30 分钟终止）；周期性扫描 `RUNNING` 且 `updated_at < now()-timeout` 并自动修复；`operation_id` 保证重复请求幂等。
**故障注入**：Pixiv API 超时、Telegram 发送失败、DB 锁等待、任务进程退出、重复点击、bot 重启 —— 每种都要么恢复要么显式失败，**不得进入未知状态**。
**日志**：所有关键流程带 `request_id`（形如 `refetch-135-20260926xxxx`）与 begin / state change / end 三类事件。

---

## 7 非目标与风险

- 不在 TelePost 里做封面/媒体类型过滤（契约：内容类型在获取阶段判定）。
- 不实现 QQ/微信协议、不新建第二套任务系统、不复制既有幂等键。
- 风险：状态值迁移影响 Mini App 与既有测试（用 `from_legacy()` 兼容 + 全量跑测试）；看门狗阈值下调会加快终止（先在 doctor 里 WARN 观察，再随版本收紧）；`asyncio.create_task` 的持久化改造需保证不重复提交（沿用 `request_id`/`callback_key` 幂等）。
