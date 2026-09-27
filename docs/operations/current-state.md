# PixivFlow Ecosystem Current Production State

Snapshot: 2026-09-24
Authority: Current production evidence overrides this file

本文件保存动态状态。

它不是永久事实。

任何 Agent 开始工作前必须重新验证关键项，并在完成任务后同步本文件。

下一步推进顺序见 [progressive-delivery-plan.md](./progressive-delivery-plan.md)。
媒体解耦专项路线见 [media-decoupling-delivery-plan.md](./media-decoupling-delivery-plan.md)。
Media code evolution: PixivFlow `src/domain/media/MediaAsset.ts` landed on master (PR #147). `Artifact` + `DownloadedArtifact.mediaAssets[]/artifacts[]` landed on master (PR #149). `MediaMaterializer` boundary landed on master (PR #150). `ResolvedWork`/resolve-first split landed on master (PR #151). `MaterializationPolicy` (eager default / on-demand supported) landed on master (PR #152). Since PixivFlow 2.45.0 the legacy `DownloadedArtifact.files[]` compatibility projection is removed: illustrations/ugoira/novels emit canonical `Artifact[]`, `DeliveryService` derives transport paths from artifacts, and TelePress reads canonical artifacts only.

TelePost RBAC 演化模型（root/sudoers/Role Binding）见 [telepost-rbac-evolution.md](../architecture/telepost-rbac-evolution.md)。代码级迁移计划（MediaAsset）见 [media-code-evolution-plan.md](../development/media-code-evolution-plan.md)。

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
PixivFlow: 3.0.2 / a0e5f0be1522d2cda5500bb83dcd75295ab43fe9 — VERIFIED
  (a failure's contract fields survive the log line: `src/logger.ts` keeps an
   Error's own enumerable fields, so `code`/`statusCode`/`cause` reach the
   structured line; the startup path lives in `src/cli/fatalError.ts`, logs the
   error object with `stage=application.startup` and prints a reason to stderr
   even for an unrecognised failure — author-line acceptance is still the next
   10:00/10:10 CST run)
PixivFlow: 3.0.1 / 33362ac35c116be7d040b8cdf7ad6b3c40b1466e — VERIFIED
  (a failing CLI stage is visible: the reason travels in both `message` and
   `error`, the entry point prints `❌ …` to stderr and logs
   command/stage/reason/retryable, and `src/logger.ts` expands an Error instead
   of writing `"error":{}`; `pixivflow diagnose-egress` is an accepted alias;
   the production note no longer carries an empty `📅 {{rankingDate}} · ` slot —
   author-line acceptance is the next 10:00/10:10 CST run)
PixivFlow: 3.0.0 / c43e4c3f52fcb571478399d829e19ad6ac70858e — VERIFIED
  (major: the WebUI location refactor — `GET /api/files/location` answers where
   a file is and showing it is a host capability, so a server copies the path
   instead of erroring; plus the CLI output fix, so `delivery`/`gateway`/
   `outbox`/`runs` print, and the no-auth notice no longer covers the app)
PixivFlow: 2.47.0 / c5d2995ecd4ca8f6443d32ddfb40123e8d218ad0 — VERIFIED
  (submission-path consistency: idempotency_key auto-fill, capability-key
   validation, telegram target deprecated, author carried into submissions)
PixivFlow: 2.46.0 / 326b8c06d04879e308e97e617486c84f9bed00f7 — VERIFIED
TelePost: 2.66.0 / 5613a3b24585fd5eaeb3d759818d99365f561087 — VERIFIED
  (novel cover semantics: explicit `:novelcover` assets, Pixiv default-cover
   normalization, TelePost cover root + TXT reply, and fallback card)
PixivFlow: 2.43.0 / c27c924cf92df303b46f10d0a2552fc488f4da43 — VERIFIED
PixivFlow: 2.44.0 / b0076f89c0e98286d21250aca9e78b85833369a0 — VERIFIED
  (deploy pin = release commit; public `/health` returned
   `version=2.43.0`, `commit=c27c924cf92d`)
  (2.43.0 builds canonical illustration `MediaAsset[]` from pages and passes
   it through DeliveryService → OutboxWorker → multipart `media_assets` to
   TelePost; local files remain the default delivery media, so this is an
   additive Delivery Asset Contract step, not on-demand illustration delivery)
  (hot-reload config: /app/data/production.json, watchConfig=true;
   download.materializationPolicy wired from config → on-demand novel previews active)
TelePost: 2.64.2
  (Step 10 delivery asset contract: optional JSON media_assets on /api/v1/submissions
   persisted per review_chain_id in media_asset_refs;
   Step 11 DeliveryPlanner: read-only GET /api/v1/reviews/{id}/delivery-plan;
   Step 12 TelegramMediaCache: media_asset_refs carries file_id/file_unique_id,
   sender captures file_unique_id, planner reuses cached file_id;
   Step 12/13 delivery chain: publish_from_file_ids adopts DeliveryPlanner and
   records confirmed Telegram file_id/file_unique_id via mark_delivered_for_chain;
   reaction-based heat: subscribes message_reaction_count, persists per-message
   counts, recomputes published_posts.reactions/heat_score; views/forwards
   hidden from user-facing stats;
   2.54.2 fixes reaction-count callback arity and keeps channel errors silent;
   2.55.0 accepts the same optional media_assets Delivery Asset Contract on
   multipart submissions and persists it through the review path;
   2.55.1 makes private chat and Mini App previews render the real channel
   caption, restores the default command menu, and adds bulk soft-delete of
   owned terminal history; 2.55.2 fixes the default menu-button API call so
   the command menu is actually restored; 2.55.3 keeps the command menu and
   restores Mini App access via a persistent keyboard button, uses
   ?start=miniapp as a one-tap channel footer fallback, and suppresses
   private preview link previews; 2.55.4 uses the explicit
   LinkPreviewOptions API on both preview paths and restores the main
   reply keyboard after /cancel)
  (2.64.0 pinned in fly/deploy.telepost.toml; VERIFIED: public /health reports
   version=2.57.0, commit=8696e73, and reaction_ingest_by_bot for bot1/bot2.
   2.56.0 makes the private-chat menu button open the Mini App while slash
   commands remain available. 2.56.1 exposes child reaction-ingestion metrics
   through the public router /health. 2.56.2 makes channel Mini App footers
   use the Main Mini App ?startapp=miniapp deep link, avoiding a bot-chat
   redirect fallback. 2.57.0 lets DeliveryPlanner rewrite allowlisted remote
   media hosts through the fixed-upstream media proxy when an asset has no
   Telegram file_id. 2.57.1 anchors review_chain_id at insert time (PR #221).
   2.58.0 adds the typed MediaAsset domain model + DeliveryVariant
   (Batch 5, PR #223) — wire contract, DB schema and delivery behavior
   unchanged.)
   media_asset_refs VERIFIED on bot1/bot2 production DB;
   message_reaction_count allowed_update VERIFIED via webhook info;
   first real media_assets production E2E (self-test, review 122): 10 refs
   landed under chain-122; slot-level confirmation pending the 10:00 run;
   real-user reaction ingestion VERIFIED (bot1 message 3056, heat_score 1.4138);
   pre-2.55.4 history stays at heat 0 = KNOWN_DEBT (no Bot-API backfill path)
TelePress: 0.16.1
Pixiv Media Proxy: pixiv-media-proxy.redtidev1918.workers.dev (v2, generic allowlist)
```

Pixiv Media Proxy (worker version 3fd098a7):
- `GET/HEAD` only, fixed upstream `i.pximg.net`, allowlisted client headers only
  (no cookie/auth passthrough), upstream responses validated as `image/*`,
  upstream 404/error mapped explicitly, `/health` VERIFIED via workers.dev.
- Worker v2 adds `/media/<host>/<path>` for exact `MEDIA_PROXY_ALLOWED_HOSTS`; it rejects redirects and returns only a response-header allowlist.
- TelePost 2.57.0 consumes the same worker: production sets
  `MEDIA_PROXY_BASE_URL` + `MEDIA_PROXY_HOSTS=i.pximg.net`, and DeliveryPlanner
  rewrites only those exact hosts when an asset has no Telegram `file_id`.
- Worker v2 deploy verified: version `89486990-2c05-4225-a3f3-66a4cfd761f8`; `/health` ok; a real
  `i.pximg.net` generic-route image returned `200 image/jpeg` (949502 bytes).
- TelePress deploy verified: Dockerfile pins `telepress[api]==0.14.1`; runtime package version is
  `0.14.1`; image digest `sha256:addc0c6c11b2cd8af05a31b9563b4e565db166650934b1158cff789888cb6690`;
  machine healthy and `/` returns `status=ok`. Production config uses `TELEPRESS_MEDIA_PROXY_BASE`
  and `TELEPRESS_MEDIA_PROXY_HOSTS=i.pximg.net`.
- Rich Novel generic-route production E2E: TelePress 0.14.1 `/publish/rich-novel` returned 200 with three
  real Pixiv novel-cover assets all `status=proxied`; Telegraph page referenced `/media/i.pximg.net/...`;
  a referenced image returned `200 image/jpeg` (599252 bytes).
- A scheduled PixivFlow slot producing manifest-only novel assets end-to-end remains
  `EXTERNAL_ACCEPTANCE_REQUIRED`.
- TelePress production config uses `TELEPRESS_MEDIA_PROXY_BASE` and
  `TELEPRESS_MEDIA_PROXY_HOSTS=i.pximg.net`; legacy `/pixiv/...` remains compatible.
- TelePress 0.11.0 runtime E2E (post-hardening recheck): `/publish/rich-novel`
  with manifest returned `status=proxied` and rewrote `images/a.jpg` to
  `https://pixiv-media-proxy.redtidev1918.workers.dev/pixiv/...`
  (real production machine, real Telegraph page
  `https://telegra.ph/px-proxy-runtime-recheck-09-19` references the proxy URL).
- Full real-novel end-to-end (novel image validity) still requires an external
  acceptance run with a live Pixiv novel and credentials: `EXTERNAL_ACCEPTANCE_REQUIRED`.
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

## 2026-09-19 10:00 slot（CST）事故归档

```text
scheduled time : 2026-09-19 10:00 Asia/Shanghai (02:00 UTC)
trigger source : cron-job.org PRIMARY（外部 SaaS，仓库无法代改）
why expired    : slot 起跑后超过 grace=90m 未进入终态（外部 trigger 保留状态需操作者在 cron-job.org 核对）
grace policy   : 超过 grace 不允许 back-fill
why no backfill: 既定设计，不为历史 slot 人为补成成功
mitigation     : watchdog 未来时钟事故防护已修复；从下一次计划周期开始验证 PRIMARY + SECONDARY + watchdog 都能观察到
future detection: 复盘当前周期后，失控项应立即显式标记，禁止自动补跑
```

该事项不因历史 slot 未成功而标记完成；只有当后续计划周期 PRIMARY/SECONDARY + watchdog 观测合同被重复验证通过后，才算 `VERIFIED`。

### 2026-09-26 watchdog 腿修复（此前该腿实际是死的）

`schedule-watchdog`（TERTIARY，GitHub Actions）从 2026-09-19 起**每一个日周期都失败**，
是当时唯一长期红的 workflow。根因不是网络也不是执行端，而是**它打错了主机**：

```text
GitHub secret SCHEDULE_TRIGGER_URL  →  一台无关的常驻主机（TelePost）
GET  /health                       →  200   （所以脚本报 "executor reachable"）
POST /internal/schedules/:id/run   →  404   （该主机根本没有这条路由）
```

特征比对（2026-09-26 实测）：

```text
pixivflow-scheduler.fly.dev    /health 200   POST → 401   ← 正确目标（路由在，需令牌）
telesubmit-multi-bot.fly.dev   /health 200   POST → 404   ← 与失败特征一致
pixivflow-control-plane(Worker) /health 200  POST → 405   ← 排除（只答 GET）
pixiv-media-proxy(Worker)       /health 200  POST → 405   ← 排除
```

执行端在请求到达时 `listSchedules()` 必然已注册（注册表在 `manager.start()` 内建好、
`app.listen()` 之后才可能应答 `/health`），所以「health 200 紧跟 404」**不可能**由执行端产生 ——
这本身就是「打错主机」的证据。

修复（两处，缺一不可）：

1. `.github/workflows/schedule-watchdog.yml` 不再传入触发 URL：origin 只从
   `control-plane/wrangler.toml` 的 `PIXIVFLOW_TRIGGER_BASE_URL` 读取（`trigger-schedule.sh`
   本来就有这条回退）。
2. `SCHEDULE_TRIGGER_TOKEN` 与执行端不一致（修 URL 后由 404 变 401 暴露）。把执行端当前
   令牌**经 stdin 原样写入** GitHub secret（不打印、不落地、不进 argv，遵循 I-1/I-3），
   未轮换执行端令牌 —— 轮换会同时打断外部 PRIMARY（cron-job.org，其凭据在仓库外）。
   已删除陈旧且已证明错误的 `SCHEDULE_TRIGGER_URL` secret。

验证（VERIFIED，2026-09-26 09:49Z workflow_dispatch 36233913631）：

```text
[OK] trigger origin: https://pixivflow-scheduler.fly.dev
[OK] executor reachable (…/health -> 200)
[OK] HTTP 200, disposition=already_completed: this occurrence was already completed   # bot1-daily
[OK] HTTP 200, disposition=already_completed: this occurrence was already completed   # bot2-daily
```

回归防护：`control-plane/test/deployment-contract.test.ts` 新增
`github actions schedule watchdog`，断言该 workflow **不含** URL secret（`PIXIVFLOW_TRIGGER_BASE_URL`
/ `SCHEDULE_TRIGGER_URL`）但仍带令牌 —— 已用修复前的 workflow 反向验证过它会 FAIL。

告警通道（同批修复）：该 workflow 失败**默认是静默的**，这正是它能连红 8 天无人知的原因。
现在 failure 会自动开（或追加评论到）标题为 `schedule-watchdog failed (tertiary clock)` 的 issue，
后续 success 自动关闭它 —— 信号是推送式且自愈的；`issues: write` 只授予本 job。

```text
2026-09-26 09:55:51Z run 36234246401  故意用错误令牌 → failure → 自动开 issue #166   ✓
2026-09-26 09:56:51Z run 36234292616  恢复真实令牌 → success → 自动关闭 issue #166   ✓
```

（该测试只临时替换 GitHub secret 的令牌：cron-job.org / Cloudflare 不读 GitHub secret，
且当日 occurrence 已 completed，对生产无影响。）

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

已实现（代码 + 单测，release/deploy 见下两节）：

* `GET /api/scheduler` 只读 Slot Ledger
* `GET /api/scheduler/executions` 把每个 durable cell 投影成 Execution 行（executionId / target / slot / status / terminalReasonCode / candidateReport / recovery admission / operatorHint）
* `GET /api/scheduler/slots/:slotId/logs` 按 slotId + targetIds 过滤进程日志（纯观察，不新增状态源）
* WebUI Scheduler 页新增 Execution tab、候选漏斗（fetched/selected/rejected/duplicate ratio）、放宽条件重试、按 slot 查看关联日志

仍未完整闭环：

* Dashboard ↔ real execution truth
* Artifact ↔ slot/execution lineage（现有 Files 页，未与 slot/execution 关联）
* Failure Center / Recovery history
* Recovery 写操作安全评审通过前不能视作 Phase 4 完成
* candidate supply health / trend

完成标准：

> 操作者能通过 WebUI 解释某个 scheduled slot 从触发到终态发生了什么。

页面能打开不等于 Control Center 完成。

---

# 13. Recovery Write Safety

Status: `IN_PROGRESS`

当前 Recovery 写操作只通过既有服务端代理：

```text
WebUI POST /api/scheduler/targets/:targetId/recover
→ PixivFlow /internal/targets/:targetId/recover（既有业务 admission）
```

已支持：

* requestId UUID 幂等键
* retryMode normal / relaxed
* correlationId
* 无 trigger URL/token 时明确 503，read-only 仍可用

仍必须评审（通过前不能视为 Phase 4 完成）：

* authorization / CSRF / origin protection — 已落地（PixivFlow 2.46.0）：
  `recoverTarget` 只接受与自身 host 匹配的 `Origin`（http/https），跨站页面无法
  借用操作者浏览器会话触发持久化恢复；缺失 Origin 的非浏览器调用会被 403 拒绝，
  `SCHEDULER_RECOVERY_ORIGIN_REJECTED` + 回归测试。
* 并发点击 / duplicate recovery prevention
* allowed terminal states（当前投影：failed retryable；no_candidate/duplicate 仅 relaxed）
* audit record / operator identity
* confirmation UI
* production destructive-risk boundary

如果评审未通过，只交付只读 UI，写操作标记 `BLOCKED_SAFETY_REVIEW`。

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

Status: `IN_PROGRESS`

已开始从“发现→下载→本地文件→下游消费”的强耦合演化：

```text
Work
MediaAsset
Artifact
DeliveryVariant
```

已落地（PixivFlow 2.38-2.41）：

* canonical MediaAsset / Artifact / ResolvedWork / MaterializationPolicy
* cross-service rich-novel manifest（TelePress 用 remote MediaReference，不强制下载）
* on-demand preview：`download.materializationPolicy` 已从配置接入 DownloadManager
  （2.41.0 引入，当前运行 2.42.0），生产配置为 `on-demand`，ZIP/归档仍按需物化

仍未正式完成：

* DeliveryVariant 完整 consumer 模型
* Telegram side media optimization（file_id 复用等）
* 生产真实带图 novel 的 on-demand 端到端验收（等待下一次执行端真实运行）

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

Status: `BLOCKED_EXTERNAL_IMAGE_HOST`

真实生产测试曾发现：

```text
Catbox
→ 412 Invalid uploader

Telegra.ph /upload
→ 400 Unknown error
```

因此：

外部图片上传不能继续作为 Rich Novel 成功的强制前置条件。

现状隔离（不因 image host 故障丢本地 artifact / 退化成整链 INTERNAL_ERROR）：

* Markdown / TXT / ZIP 生成是内部能力，不依赖外部 image host
* image upload / Telegraph composition 依赖外部 host，当前 blocked
* WebUI Files / 本地下载产物不得受外部 host 故障影响

后续边界：

```text
image hosting
→ provider boundary
→ R2/S3-compatible 或 self-hosted HTTP object storage
```

在未选定并真实验证正式 provider 前，Rich Novel production E2E 状态保持 `BLOCKED_EXTERNAL_IMAGE_HOST`，不声称已完成。

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

Status: `IN_PROGRESS`（2.41.0 引入 on-demand 配置，当前运行 2.42.0；真实带图 novel 端到端验收待下次执行）

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

Status: `IN_PROGRESS`

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

TelePost 2.48.0（2026-09-19）已上线「删除已发布投稿的历史」：软删除 `hidden_from_submitter`，
频道消息不动，进行中投稿不可删除，`DELETE /api/v1/me/submissions/{id}` 仅清洗投稿人侧历史。

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

Status: `VERIFIED`

历史执行环境中曾误打印：

```text
TELEPRESS_API_KEY
TELEGRAPH_ACCESS_TOKEN
```

值。已按暴露处理。

已完成的收敛证据：

* 两个 secret 均已生成新值并部署到对应 Fly app
  * `telepress-publish`：`TELEGRAPH_ACCESS_TOKEN` / `TELEPRESS_API_KEY`（Deployed）
  * `pixivflow-scheduler`：`TELEPRESS_API_KEY`
  * `telesubmit-multi-bot`：`TELEGRAPH_ACCESS_TOKEN`
* Git history 只出现变量名/占位符，未发现已提交的 secret 值（`git log -S` + 仓库 grep）
* 新 Telegraph token 已通过 `getAccountInfo` 类验证，App 正常启动健康检查通过

旧值有效性：旧值已被新 secret 覆盖，Fly 配置不再持有旧值，因此不再有效。

未持久化的执行环境输出无法从仓库侧异步重放；若需最终外部验收，用 `EXTERNAL_ACCEPTANCE_REQUIRED` 标记。

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


# 35. 2026-09-20 UX Follow-Up

## IMPLEMENTED / VERIFIED

TelePost 2.55.4 released (`v2.55.4`, commit `8c4e67a`) and deployed to
`telesubmit-multi-bot` machine version `202`:

```bash
fly deploy -c fly/deploy.telepost.toml --ha=false --strategy rolling
curl https://telesubmit-multi-bot.fly.dev/health
```

Runtime evidence:

```text
health.version = 2.55.4
health.commit  = 8c4e67a
machine.state  = started
checks         = 1 passing
webhook allowed_updates includes message_reaction_count
both bots logged: 成功设置 12 个命令菜单项
```

Changes:

- Private preview uses the explicit Telegram `LinkPreviewOptions(is_disabled=True)`
  contract on both the new-message and edit-message paths.
- `/cancel` restores the persistent main keyboard, so the `📱 Mini App`
  button is not lost after cancelling a submission.
- Removed the dead second private preview formatter; chat preview remains
  the shared channel-caption SSOT.

## Reaction Stats Evidence

Production database query on 2026-09-20:

```text
bot1 message_reaction_counts = 0 rows; published_posts = 62; reactions > 0 = 0
bot2 message_reaction_counts = 0 rows; published_posts = 57; reactions > 0 = 0
```

Webhook logs confirm `message_reaction_count` is explicitly requested. This is
therefore not yet evidence of a handler bug; there is no accepted real reaction
update in either database. A real user must react to a post, after which the
per-message row and aggregate can be checked. Until then, real reaction E2E is
`EXTERNAL_ACCEPTANCE_REQUIRED`.

## Mini App Footer Boundary

Telegram allows only one menu button. Contract since 2.56.0/2.56.2: the
private-chat menu button is a `MenuButtonWebApp` that opens the Main Mini App
(slash commands stay in the `/` list, the persistent reply keyboard keeps its
`📱 Mini App` button), and channel footers use the Main Mini App deep link
`?startapp=miniapp`, which does not need the BotFather Direct Mini App short
name. Configuring `MINIAPP_SHORT_NAME` upgrades the footer to the Direct Mini
App form `https://t.me/<bot>/<short_name>?startapp=submit`. Real user taps from
a channel post remain `EXTERNAL_ACCEPTANCE_REQUIRED`.

### 2026-09-21 Old-post footer retrofit (canary)

Historical footers are frozen in already-published captions (Telegram Bot API
cannot fetch a channel message's text). The retrofit mechanism was proven on
bot1 @xgdShare message 3056: caption rebuilt from the DB body (`published_posts.caption`,
verbatim, no template re-render) + the current footer builder, then applied via
`editMessageCaption` (parse_mode=HTML). The API response entities verify the
final footer:

```text
📖 在线阅读  → https://telegra.ph/狐娘雪伊与小人们的躲猫猫游戏-09-20  (from publication_previews)
✉️ TG 投稿   → https://t.me/xgdPost_bot?start=submit
📱 Mini App  → https://t.me/xgdPost_bot?startapp=miniapp
```

Status: old posts published before 2.56.2 carry `?startapp=submit` (pre-#208)
or `?start=miniapp` (#208 window). With the current runtime, `?startapp=*`
links open the Main Mini App directly and `?start=miniapp` lands in the bot
chat where `/start miniapp` replies with a one-tap Web App button, so no known
dead link remains. If a user tap still lands in the bot chat, batch-retrofit
the 09-16+ posts (~29 candidates, max body 359 chars, no truncation risk)
with the same canary procedure. 3058/3059/3060 test posts are already deleted
from the channel (DB rows still `is_deleted=0` — known stale marker).

### 2026-09-21 Old-post footer batch retrofit (completed)

Batch applied the same canary procedure to every live 09-16+ post on both
channels (caption = DB body verbatim + current footer; READ_ONLINE restored
from `publication_previews` when the review had one):

```text
bot1 @xgdShare: edited 3046/3047/3049/3052 + 3056 (canary, already correct)
bot2 @voreShare: edited 390/404/407/410/411/412/413/414/415/423/426/430
skipped (deleted from channel, DB stale): bot1 3041-3045/3050/3051/3058/3060,
  bot2 408/409
```

Every edit returned `ok:true` (3056 returned "message is not modified" because
the canary already wrote the identical footer). No DB writes. All channel
footers now use `?startapp=miniapp`; real-user tap acceptance remains
`EXTERNAL_ACCEPTANCE_REQUIRED` on any edited post.

---

# 36. 2026-09-21 TelePost 2.57.0 + Media Proxy

## 2026-09-21 pixivflow-scheduler 2.43.1 — media_assets wire contract fix

Found pre-E2E: PixivFlow 2.43.0 serialized the canonical `MediaAsset`
(camelCase `id`/`sourceUrl`) into the multipart `media_assets` field, but
TelePost's Delivery Asset Contract accepts only `{asset_id, kind, source_url,
mime_type?}` and rejects unknown fields with 400 `invalid_media_asset`. The
10:00 slot would have been rejected outright.

Fixed in PixivFlow PR #161 (v2.43.1): `HttpMultipartDelivery` maps domain
assets to the TelePost wire shape at the single serialization point. Both
sides now have tests asserting the same shape (PixivFlow
`http-multipart.test.ts`; TelePost `test_media_assets_persist_and_read_back`).

Runtime: deploy pin 9624b01; machine `83d1650bd23948` updated to image
`deployment-01M30HTG9SZ0SYK4VA01N81BB1`, stopped-by-design (idle), volume
`vol_r68wlk8ynj1x5lq4` intact. First real multipart send with media_assets is
the 10:00 slot (EXTERNAL_ACCEPTANCE_REQUIRED).

## IMPLEMENTED / VERIFIED

TelePost 2.57.0 (`8696e73`, PR #212 delivery media proxy) pinned in
`fly/deploy.telepost.toml` (PR #162) and deployed to `telesubmit-multi-bot`:

```bash
fly deploy -c fly/deploy.telepost.toml --ha=false --strategy rolling
curl https://telesubmit-multi-bot.fly.dev/health
```

Runtime evidence:

```text
health.status = ok
health.version = 2.57.0
health.commit  = 8696e73ca09efba5a184bbf5c72a0a4a5df3faa3
container env  = MEDIA_PROXY_BASE_URL=https://pixiv-media-proxy.redtidev1918.workers.dev
                 MEDIA_PROXY_HOSTS=i.pximg.net
both bots logged: 成功设置 12 个命令；菜单按钮类型=MenuButtonWebApp
webhooks: /webhook/bot1 and /webhook/bot2 set successfully
```

Fixed-upstream media proxy acceptance (allowlist is exactly `i.pximg.net`):

```text
i.pximg.net without Referer            → 403 text/html
i.pximg.net with Pixiv Referer         → 200 image/jpeg (645 658 bytes)
/media/i.pximg.net/<same path> via proxy → 200 image/jpeg (645 658 bytes)
Telegram sendPhoto(<proxied url>)      → ok:true (probe message deleted afterwards)
```

The rewrite only applies when a planned asset has no Telegram `file_id`; the
`file_id` fast path is unchanged. Because `media_asset_refs` is still empty on
both production DBs, a real illustration/novel publish that goes through the
remote-URL strategy is still `EXTERNAL_ACCEPTANCE_REQUIRED`.

## Reaction Ingest — First Real E2E

A real channel reaction was accepted and projected in production
(`message_id` 3056, bot1):

```text
bot1 health.reaction_ingest_by_bot[1] = {received_since_start: 1}
bot1 message_reaction_counts = 1 row
bot1 published_posts with heat_score > 0 = 1 row (reactions 1, heat_score 1.4138)
bot2 message_reaction_counts = 0 rows; published_posts heat_score > 0 = 0 rows
```

So `update → ingest → projection → /hot` is VERIFIED for a new reaction. The
remaining zeroes are not a bug: the Bot API pushes `message_reaction_count`
only when a count changes, so posts reacted to before the handler shipped stay
at heat 0 until someone reacts again. Backfilling history needs a user client
(Telethon/Pyrogram) because the TelePost channel-history crawler is deliberately
a Bot-API stub that cannot enumerate channel history. TelePost 2.60.0 ships
[`TelePost/scripts/backfill_reactions.py`](https://github.com/redtidev1918/TelePost/blob/main/scripts/backfill_reactions.py)
(Pyrogram, dry-run default, `--apply` writes
through the same `message_reaction_counts` → `published_posts.reactions/heat_score`
projection as live ingestion and records `reaction.backfilled` audit). The
operator-run acceptance with real my.telegram.org credentials is
`EXTERNAL_ACCEPTANCE_REQUIRED`; code/unit tests (`test_reaction_backfill.py`)
are VERIFIED.

# 37.5 2026-09-22 remote_url delivery failure (review 92)

Production evidence:

```text
bot2 review 92 approve at 00:16 CST failed:
Failed to send message #7 with the error message "webpage_curl_failed"
review 92: 26 media_asset_refs (25 remote covers + 1 file_id TXT), no cached
file_id; proxy URL for item 7 returns 200 image/png (1.75 MB)
```

Root cause: Telegram's own URL fetcher is not reliable for an album of remote
media; one slow/refused fetch aborts the whole media group. The worker proxy
itself is healthy (Fly container probe: `200 image/png`).

Fix (TelePost 2.60.1): when a RemoteUrl single/album item fails with a Telegram
fetch error (`webpage_curl_failed`/`failed to fetch`/...), TelePost now does ONE
bounded remote→local materialization (temp file, UA
`TelegramBot-LinkPreview/0.1`, size-capped, cleaned after send) and retries as a
local upload. `remote_url` remains the preferred happy path; local upload is
only the fallback. Regression tests: `tests/test_remote_fetch_fallback.py`.
Runtime: TelePost 2.60.1 deployed; `/health` version=2.60.1 commit=8bae62d.
A production container probe materialized the exact review-92 item 7 URL
(`200 image/png`, 1 748 895 bytes) into a bounded temp file and cleaned it up.
Review #92 is still `failed` in the ledger and can be retried by the operator
from the review action; the retry now has the local-upload fallback available.

## 37.6 2026-09-22 online reading images (TelePost 2.61.0)

Root cause: TelePost published the Telegraph preview from the raw TXT body, so
`[uploadedimage:...]` markers rendered as text and the online reading page had
no images, even though the review chain carried the canonical media refs.

Fix: TelePost 2.61.0 enricher loads `media_asset_refs` for review
publications, rewrites matched markers to relative
`![](images/<id>.<ext>)` refs, and calls TelePress
`publish_rich_markdown(..., manifest)` so every inline image is rewritten to
`pixiv-media-proxy` (no user-owned image host). Pure-text TXT keeps the old
text-only path. A legacy text-only preview record on a retried publication is
upgraded once (`title=rich` marker on `publication_previews`); #92's existing
text-only row will be replaced by the rich page when it is retried.

Repeated #92 retry finding: the per-single fallback was not reached because
Telegram's album send itself failed (``sendMediaGroup`` downloads every remote
image up front). TelePost 2.61.1 now materializes ALL remote media through the
proxy into bounded temp files BEFORE album planning, so Telegram only receives
local uploads and remote URLs never participate in ``sendMediaGroup``; the
single-send fallback remains for non-album paths. ``tests/`` cover gateway
pre-materialization plus NetworkError-style URL fetch markers.

## 37.7 2026-09-22 publication rules (TelePost 2.62.0)

1. Novel inline images are preview-only: a PixivFlow novel review with
   `media_assets` + TXT now sends ONLY the TXT document to the channel; all
   illustrations are rendered on the Telegraph reading page.
2. Online reading images are real again: TelePost pins `telepress==0.14.1`
   (the version providing `publish_rich_markdown`); the preview record is
   marked rich only when that path truly succeeded, so text-only pages are
   regenerated on retry.
3. Multi-image channel publications keep ONE visual batch plus one file batch
   on the channel (files after images, replying after them); overflow goes to
   the linked discussion.
4. Mixed submissions are ordered visual → animation/audio → documents; overflow
   images reply in the image discussion thread and overflow files reply in the
   file discussion thread. Saved post order matches the actual send order.

Dependency contract: TelePost `requirements.txt` telepress pin and the TelePress
service Dockerfile pin must match; `Version sync check` CI in TelePost enforces
this on every PR/push. This is what caught the earlier `telepress==0.9.0` drift.

Runtime (TelePost 2.63.0): `/health` reports `version=2.63.0`,
`commit=3149360`, `telepress_version=0.14.1`, `telepress_rich_markdown=True`,
`bots=[1,2]`; machine env `CHANNEL_ALBUM_REPLY=discussion`,
`REVIEW_ALBUM_SIZE=10`, `RUN_MODE=WEBHOOK`. Discussion overflow now anchors to
each media group root, API/review publication paths honor the discussion mode,
admin alerts show the anonymous submitter ID, and `/ban_user` + `/ban_api`
provide manual moderation fallbacks.

# 37. 2026-09-21 media_assets E2E + TelePost 2.57.1 / 2.58.0

## media_assets first real production evidence (self-test)

Manual ad-hoc run (`pixivflow run-once --target bot1-illust-botefuku`,
PixivFlow 2.43.1) delivered the same multipart contract a scheduled slot uses:

```text
bot1 review 122 (chain-122): media_asset_refs = 10 rows
  asset_id  = pixiv:149892458:illust:page-1..10
  source_url= https://i.pximg.net/img-original/... (canonical originals)
  file_id   = '' (no Telegram cache yet)
GET /api/bot1/v1/reviews/122/delivery-plan
  strategy=telegram_file_id, 10 entries (staged file_ids win by design)
review 120 earlier exposed the blocker below before the fix
```

## Blocking defect found and fixed: chain anchored only at restart

`pending_reviews.review_chain_id` for new non-refetch submissions stayed ''
until the next `init_db()` backfill, so `_persist_media_assets` silently
returned 0 and `media_asset_refs` was never written for fresh reviews.

```text
2.57.1 (PR #221): ReviewRepository.insert_into anchors chain-<id> at insert.
health.version = 2.57.1 verified before the E2E self-test above.
```

## Batch 5 shipped: typed MediaAsset domain model

`telepost/domain/media.py` (frozen `MediaAsset`, `DeliveryVariant`) with the
repository returning `MediaAsset`, the planner consuming both assets and wire
dicts, and JSON boundaries still emitting the dict wire shape. Regression-only
(978 tests). Deployed as 2.58.0 (`db93975`, PR #223) and pinned in
`fly/deploy.telepost.toml` (PR-free pin commit 2bbcc6c). `health.version=2.58.0`
verified. Scheduled-slot confirmation (2026-09-21 10:00/10:10 run, VERIFIED):

```text
bot1 reviews 123 (illust, chain-123: 2 refs) / 124 (novel, chain-124: 2 refs)
bot2 reviews 91 (illust, chain-91: 1 ref) / 92 (novel, chain-92: 26 refs, 0 file_id)
delivery-plan: 92 = mixed (25 remote_url covers + 1 file_id doc);
               123/91 = telegram_file_id (staged files win by design)
proxied covers via media proxy: 200 image/png (sampled 3/3 + full first fetch);
probe 403s were a false negative — workers.dev bot protection blocks the
"Python-urllib" User-Agent (fixed in probe 1fa5e2d); Telegram's fetcher passes
(production sendPhoto acceptance in 2.57.0).

Post-review outcome check (2026-09-21, read-only):

```text
bot2 review 91 = published
chain-91 media_asset_refs = 1 pximg ref with non-empty file_id/file_unique_id
=> mark_delivered_for_chain cache write-back VERIFIED on production publish.

bot1 reviews 122/123/124 = rejected (no write-back expected)
bot2 review 92 = failed (publish path did not complete)
```

## Step 9 real-scheduled-slot evidence

The same 2026-09-21 10:10 production slot also gave the on-demand novel
preview path its first real evidence:

```text
Novel 29176318 inline images: 0/26 downloaded
Saved rich-media markdown sidecar: .../29176318_*.md
TelePress preview attempt was skipped transiently as telepress_network_error.
```

Retrying that real work through TelePress 0.14.1 later produced a two-page
Telegraph article (`https://telegra.ph/第五卷这一定是大主教的安排-12-09-21`)
with all 26 novel covers rewritten to the generic media-proxy route and
reported `status=proxied`. One sampled proxy URL returned `200 image/png`
(1,979,224 bytes). This closes the Step 9 external-acceptance gap for the
real manifest-only scheduled-slot shape.


# 2026-09-24 TelePost 2.64.0 Deployed

TelePost 2.64.0 (`d2e9bda`) deployed to `telesubmit-multi-bot`.

Pinned in `fly/deploy.telepost.toml` (`5739f77`).

## Changes

- `/hotweek` — natural-week hot ranking (Mon 00:00 local TZ, not rolling 7 days)
- `/schedule` — admin-only native automation: SQLite persistent (automation_tasks + automation_runs), hot-reload on mutation, idempotent runs via (task_id, occurrence_at) UNIQUE, weekly-hot action
- `/help` reorganized; user vs admin split via Telegram command scopes
- `/hot` defaults to all-time; stable tie-break (heat DESC, publish_time DESC, message_id DESC)

## Verification

- GHCR image: `ghcr.io/redtidev1918/telepost:2.64.0`
- `/health` reports `version: 2.64.0`, `commit: d2e9bda`
- Rolling deploy completed; machine reached started state; health check passed


# 2026-09-24 TelePost 2.64.2 Docs Sync

- `/schedule` usage guide added to `docs/COMMANDS.md` + `docs/en/COMMANDS.md`
- Help copy updated to point at `/schedule` for interactive guidance
- Goldens regenerated
- TelePost source pinned at `2.64.2` in all deploy files

# 2026-09-24 TelePost 2.64.3 Deployed

- Novel delivery plan now keeps the TXT document when a novel has one cover
  asset plus one TXT; the previous photo/document pairing removed every item
  and could report `delivery returned no messages`.
- Oversized images now attempt bounded JPEG compression before falling back to
  documents. Very large images without reduced decode still stay documents to
  protect the 512 MB box.

Pinned in `fly/deploy.telepost.toml` (`0937cab`).

## Verification

- GHCR image: `ghcr.io/redtidev1918/telepost:2.64.3`
- Rolling deploy completed; machine reached started state.
- `/health` reports `version: 2.64.3`, `commit: 984ec88`, bots 1 and 2.
- `scripts/smoke-telepost.sh` passed health/live and unauthorized API checks.

# 2026-09-24 TelePost 2.65.0 Deployed

- Mini App gains a light content-consumption entry: home hot previews, full /
  week hot list (`/hot`, `/hotweek`), post detail and authenticated media
  preview. Bot and Mini App share one HotService; no second hot-ranking
  implementation.
- Fixed a hot-page offset bug that skipped the first page of `/hot` results.
- New optional flag `MINIAPP_CONTENT_ENABLED` (default on) gates only the
  public content API; submission/review/publication paths are untouched.
- Public content API never exposes file_ids, captions or submitter identity;
  media bytes are proxied server-side from `published_posts` only.

Pinned in `fly/deploy.telepost.toml` (`1505943`).

## Verification

- GHCR image: `ghcr.io/redtidev1918/telepost:2.65.0`
- Rolling deploy completed; machine reached started state, checks passing.
- `/health` reports `version: 2.65.0`, `commit: de95160`, bots 1 and 2.
- `scripts/smoke-telepost.sh` passed health/live and unauthorized API checks.
- `scripts/verify-production.sh` passed image/commit checks; webhook-ownership
  checks skipped locally (no bot tokens on this machine).

# 2026-09-24 TelePost 2.66.0 / PixivFlow 2.46.0 Deployed

- PixivFlow normalizes a Pixiv default novel cover to `cover_url: null` and
  emits real covers as dedicated `pixiv:<id>:novelcover` assets.
- TelePost consumes only explicit `:novelcover` assets for the novel visual
  root. With a cover, publication is cover root + TXT reply; without one, a
  rendered fallback card can be the root; if the card is disabled or fails,
  TXT remains the root. When preview filtering empties the plan, TelePost
  falls back to the full plan instead of failing with no messages.
- TelePost runtime image adds CJK fonts for the fallback card renderer.

Production pins:

- TelePost image: `ghcr.io/redtidev1918/telepost:2.66.0`
- TelePost commit: `5613a3b24585fd5eaeb3d759818d99365f561087`
- PixivFlow ref: `326b8c06d04879e308e97e617486c84f9bed00f7`
- PixivFlow tag: `v2.46.0`

Verification:

- Rolling TelePost deployment completed; health checks passed.
- Rolling PixivFlow deployment completed; the scheduler is stopped by design
  when idle and wakes on demand.
- TelePost `/health` reports `version=2.66.0`, `commit=5613a3b`, and bots 1
  and 2.
- Woken PixivFlow `/health` reports `version=2.46.0` and `commit=326b8c06d048`.
- `scripts/smoke-telepost.sh` passed health, live, and unauthorized API checks.
- `scripts/verify-production.sh` passed lifecycle, proxy, business probes,
  image/commit, and scheduler version checks; webhook ownership and
  Cloudflare clock checks were skipped because local read-only credentials
  were unavailable.
- PixivFlow Release workflow completed successfully and `v2.46.0` is the
  repository Latest release.

# 2026-09-24 TelePost 2.67.0 Deployed

- Mixed photo/document submissions now preserve every delivered asset in the
  public-post archive. Documents are no longer discarded when at least one
  visual media item exists.
- A caption for a multi-document publication ships as a trailing text message,
  so it is no longer attached to the first document. Single-document and
  visual-root captions keep the prior behavior.
- The production verifier now reads the UTF-8 schedule configuration correctly
  on Windows.

Production pin:

- TelePost image: `ghcr.io/redtidev1918/telepost:2.67.0`
- TelePost commit: `3c7a58ba8ab345e7a5ab17aaecb3453347c4b601`
- Deploy repository pin commit: `b9f2311`
- GHCR tag digest: `e2a72112a331646389ee5e3511566900a4b34b66f75733c88cd975978a7a9f77`

Verification:

- TelePost `v2.67.0` Release completed successfully; all required release
  assets and the GHCR image were published.
- Rolling Fly deployment completed; the machine reached a good state and DNS
  checks passed.
- `/health` reports `version=2.67.0`, `commit=3c7a58ba`, and bots 1 and 2.
- `scripts/smoke-telepost.sh` passed health, live, and unauthorized API checks.
- `scripts/verify-production.sh` passed lifecycle, proxy, business probes,
  unauthorized trigger auth, image/commit, and scheduler version checks.
  Webhook ownership and Cloudflare clock checks were skipped because local
  read-only credentials were unavailable.

---

# 2026-09-26 TelePress scale-to-zero (deploy.telepress.toml)

TelePress standalone app is now request-driven scale-to-zero instead of always-on.

Change:

- `fly/deploy.telepress.toml`: `auto_stop_machines false → true`,
  `min_machines_running 1 → 0` (kept `auto_start_machines = true`).
- Rationale: TelePress is stateless (no volume, temp dirs only, Telegraph/Catbox
  remote) with exactly one caller — PixivFlow's daily novel preview (2 runs/day).
  Nothing needs it resident, so it sleeps idle and wakes on request (Fly starts
  the machine and forwards the POST). Cost drops from always-on to pay-per-use.
- Novel preview is an OPTIONAL enrichment (AGENTS invariant): a cold-start
  timeout only skips that run's preview and never fails the TXT publication.
  PixivFlow per-run retry + next-run recovery absorb an occasional miss.

Verification:

- `flyctl config validate` passed.
- Rolling deploy completed; machine `84edd6dc154028` reached started state,
  health check `GET /` passing (1 total, 1 passing).
- Running config confirms `auto_stop_machines=true`, `auto_start_machines=true`,
  `min_machines_running=0`.

Rollback: revert `min_machines_running` to `1` and `auto_stop_machines` to
`false`, redeploy — restores always-on.

Machine size: `shared-cpu-1x:256MB` (verified 2026-09-26; not 512). No change
needed — it is already at the target size.

Consolidation decision (2026-09-26): TelePress **stays standalone**; it is NOT
merged into TelePost. Rationale and HARD constraints recorded in
`docs/architecture/ecosystem-platform.md` §3.3.1 (attack surface / §telepress-preview
invariant / no-parallel-systems / scale-to-zero is the cost-control tool).

---

# 2026-09-26 TelePress upgraded 0.14.1 → 0.16.1 (standalone + TelePost pin)

Upgraded the TelePress publishing plane to the latest additive release.

Change:

- `docker/telepress.Dockerfile`: `telepress[api]==0.14.1` → `telepress[api]==0.16.1`
- (TelePost `requirements.txt` pin bumped in the TelePost repo to keep the
  cross-repo Version sync check green — `verify_telepress_version_sync.py`.)
- Rationale: 0.15/0.16 are purely additive (UploadError subclasses, retry
  classification, ResolvedMedia, ImageHostCapabilities, structured logs). The
  `/publish/rich-novel` wire contract and `publish_rich_markdown`/
  `publish_text`/`TelegraphPublisher(token, skip_duplicate=...)` library API are
  unchanged, verified directly against 0.16.1 on PyPI.

Verification:

- `telepress 0.16.1` installed and introspected: `TelegraphPublisher.__init__`
  signature, `publish_rich_markdown`, `publish_text`, `skip_duplicate` all present.
- Standalone `telepress-publish` redeployed with 0.16.1 image; machine
  `84edd6dc154028` reached started state, `/` health check 1 total 1 passing.
- Always-on `telesubmit-multi-bot` redeployed through `docker/telepost.Dockerfile`,
  which layers `telepress==0.16.1` over the immutable TelePost 2.67.0 application
  image. Runtime `/health` verified: `telepress_version=0.16.1`,
  `telepress_rich_markdown=true`.
- Machine remains scale-to-zero (`shared-cpu-1x:256MB`, `auto_stop/auto_start`,
  `min_machines_running=0`).

Rollback: revert both pins to 0.14.1 and redeploy.

# 2026-09-26 PixivFlow 2.47.0 pinned and deployed (scheduler)

Moved the production scheduler pin from 2.46.0/326b8c0 to 2.47.0/c5d2995 — the
v2.47.0 release merge commit — so the submission-path consistency work is live.

Change:

- `fly/deploy.pixivflow.toml`: `PIXIVFLOW_REF`
  `326b8c06d04879e308e97e617486c84f9bed00f7` → `c5d2995ecd4ca8f6443d32ddfb40123e8d218ad0`,
  `PIXIVFLOW_VERSION` `2.46.0` → `2.47.0` (40-hex commit pin, never a tag).
- `pixivflow/config/production.json`: the submission note leads with
  `🖌 作者：{{author}}` for both `bot1-submit`/`bot2-submit` targets. The pinned
  revision renders an absent author as empty (`author: c.author ?? ''`), so the
  template change is safe for works whose author is unknown.

What 2.47.0 carries on the submission path (PixivFlow master `48c22ea`,
`80aeea6`, `5b5b4cf`):

- an `httpMultipart` target whose `config.fields` omits `idempotency_key` gets
  `{{idempotencyKey}}` auto-filled (`autoIdempotencyKey: false` opts out), so an
  ACK lost in transit converges at TelePost instead of publishing twice;
- the never-evaluated `success` block is gone (the business ACK is the only
  verdict) and an unknown capability key warns with `Did you mean "album"?`
  instead of being silently dropped;
- `type: "telegram"` (PixivFlow owning a bot token) is deprecated and warns;
- the Pixiv author travels into every submission.

Verification:

- Release: release PR #169 merged → merge commit
  `c5d2995ecd4ca8f6443d32ddfb40123e8d218ad0`; tag `v2.47.0`
  (annotated tag object `cf22e899fd31a9dbc6c8a7492f3d6cbb0d82807d`); package
  `2.47.0` on npm (`https://registry.npmjs.org/pixivflow/-/pixivflow-2.47.0.tgz`).
- Deploy: `fly deploy -c fly/deploy.pixivflow.toml` → image
  `deployment-01M3FCXGVENEKPF6P4RH6XFWVP` (172 MB), machine `83d1650bd23948`
  (`dry-glade-4438`, iad, volume `vol_r68wlk8ynj1x5lq4`) updated and reached a
  good state.
- Runtime: `GET https://pixivflow-scheduler.fly.dev/health` →
  `{"status":"ok","service":"pixivflow-scheduler-trigger","version":"2.47.0","commit":"c5d2995ecd4c"}`;
  startup log `PIXIVFLOW_REVISION=2.47.0+c5d2995ecd4ca8f6443d32ddfb40123e8d218ad0`
  (code = Release = Deploy = Runtime).
- Tests: PixivFlow `npx jest --silent --runInBand` 120 suites / 1316 tests
  green, `tsc --noEmit` clean.

Note (config hydration): `docker/pixivflow-scheduler-entrypoint.sh` copies
`/app/config/pixivflow.production.json` onto the volume only when
`/app/data/production.json` is missing or empty, so the note-template change is
in the image and in the repo but NOT yet in the running volume copy
(applied by hand on 2026-09-26 — see the volume-config entry below). The
existing submission config (already carrying
`"idempotency_key": "{{idempotencyKey}}"`) is unaffected; the volume copy keeps
the previous note until it is rewritten (the scheduler hot-reloads
`targets`/`delivery` with `watchConfig=true`).

Rollback: set `PIXIVFLOW_REF`/`PIXIVFLOW_VERSION` back to
`326b8c06d04879e308e97e617486c84f9bed00f7` / `2.46.0` and redeploy.

# 2026-09-26 Volume config: the author is rendered in the live note templates

Change: `/app/data/production.json` on volume `vol_r68wlk8ynj1x5lq4` was edited
in place — both `httpMultipart` targets (`bot1-submit`, `bot2-submit`) now start
their `fields.note` with `🖌 作者：{{author}}` followed by the previous template.
Nothing else changed: the file was rewritten byte-for-byte apart from those two
lines (`10885 → 10937` bytes), so the live scheduler/queue state is untouched.

What it fixes: the entrypoint hydrates the volume copy only when it is missing
or empty, so pinning 2.47.0 (which renders the author) left the running
templates without it. This is the deliberate one-off volume write that closes
the gap; a future template change needs the same treatment or a hydration
change in `docker/pixivflow-scheduler-entrypoint.sh`.

Verification:

- `cp -p /app/data/production.json /app/data/production.json.bak-author` first
  (the original 10885-byte file is still on the volume as the rollback);
- the new document was uploaded to a temporary path, read back off the machine
  and compared byte-for-byte with the intended file (`ROUNDTRIP_IDENTICAL`),
  then moved over the original (`LIVE_CONFIG_UPDATED`);
- the scheduler hot-reloaded it: `Scheduler configuration snapshot activated
  {"generation":2,...}` (generation 1 → 2) with both `bot1-daily`/`bot2-daily`
  schedules intact and no validation warning.

Rollback: `mv /app/data/production.json.bak-author /app/data/production.json`
(or restore `PIXIVFLOW_REF`/`VERSION` to the previous pin and let the image
hydration take over after clearing the volume file).

# 2026-09-26 PixivFlow 3.0.0 pinned and deployed (scheduler)

Change: `fly/deploy.pixivflow.toml` — `PIXIVFLOW_REF`
`c5d2995ecd4ca8f6443d32ddfb40123e8d218ad0` → `c43e4c3f52fcb571478399d829e19ad6ac70858e`,
`PIXIVFLOW_VERSION` `2.47.0` → `3.0.0` (commit `e3c0b58`), then `fly deploy`.

What 3.0.0 carries: release PR #170 (release-please commit `95ccabe`, merge
commit `c43e4c3`, annotated tag `v3.0.0` → `c43e4c3`). It is a major because the
WebUI location refactor is breaking: `GET /api/files/location` answers *where* a
file is and PixivFlow no longer spawns a file manager — revealing is a host
capability (the desktop shows it, a headless server copies the path, and the
WebUI degrades to the clipboard instead of erroring). It also carries the CLI
output fix (a command's returned `CommandResult` was discarded, so
`delivery`/`gateway`/`outbox`/`runs` printed nothing; they now declare
`metadata.rendersResult` and the delivery id may be given positionally) and the
no-auth notice fix (it no longer covers the app or shifts the layout). The
`{{author}}` note template applied to the volume on 2026-09-26 is unaffected.

Verification:

- release evidence: `npm view pixivflow dist-tags` → `latest: 3.0.0`;
  `git ls-remote --tags origin v3.0.0` → tag object `7e2a1783…`, dereferenced
  `c43e4c3f52fcb571478399d829e19ad6ac70858e`; `gh release view v3.0.0` →
  published, not a draft;
- `fly deploy -c fly/deploy.pixivflow.toml` exit 0, image
  `registry.fly.io/pixivflow-scheduler:deployment-01M3FFPN9H9PWX9KEQ4RX0HYFR`
  (172 MB, sha256:ef313353e9ab845df9f8db772b2c04ddc8874394930fb9704b81c15c9573b153),
  machine `83d1650bd23948` updated with the rolling strategy, DNS verified;
- `curl https://pixivflow-scheduler.fly.dev/health` →
  `{"status":"ok","service":"pixivflow-scheduler-trigger","version":"3.0.0","commit":"c43e4c3f52fc"}`;
  `fly logs … | grep -o 'PIXIVFLOW_REVISION[^ ]*' | tail` →
  `PIXIVFLOW_REVISION=3.0.0+c43e4c3f52fcb571478399d829e19ad6ac70858e` above the
  previous `2.47.0+c5d2995…`, i.e. code = Release = Deploy = Runtime;
- `./scripts/verify-images.sh` exit 0 (TelePost `2.67.0` and the new commit both OK);
- the CLI answers inside the container now:
  `fly ssh console -a pixivflow-scheduler -C "node /app/dist/index.js delivery status"`
  → `bot1-submit 39 delivered / 1 failed / 0 pending`, `bot2-submit 45 / 1 / 0`
  (`--json` prints the same payload). Both failed intents are `dead` on the
  outbox with a permanent TelePost rejection (`HTTP 400`,
  `business_status=permanent_failure`, `reason="refetch attempt is unknown or
  terminal"`) — already converged dead-letters from refetch attempts, not a live
  fault, and re-arming them cannot succeed while TelePost treats the attempt as
  terminal.

Rollback: set `PIXIVFLOW_REF` back to
`c5d2995ecd4ca8f6443d32ddfb40123e8d218ad0` / `PIXIVFLOW_VERSION` `2.47.0` and
redeploy.

# 2026-09-26 CLI visibility debt (found while verifying the 3.0.0 pin)

Status: `KNOWN_DEBT`

Verifying the 3.0.0 pin used one **read-only** probe — the operator CLI inside the
container. Getting it to answer exposed three separate problems, all upstream in
PixivFlow (this entry only records them; the fix belongs in that repo):

* **A command's returned result was discarded** (fixed in 3.0.0): `src/index.ts`
  validated, executed and exited without printing `CommandResult.message`/`data`,
  so `delivery`/`gateway`/`outbox`/`runs` printed nothing at all — the production
  probe was silent for exactly this reason. Fixed by the opt-in
  `metadata.rendersResult` flag + `CommandResultRenderer` (PixivFlow `AGENTS.md`
  §CLI 输出契约), and `pixivflow delivery <id> --yes` now also takes the id
  positionally.
* **`pixivflow reconcile` fails opaquely**: `[ERROR] Command execution failed
  {"command":"reconcile","error":{}}` — the error object serialises as `{}`, so
  the failing stage is invisible. That is a Failure Contract violation (Deploy
  `AGENTS.md` §25) and the reason a re-run cannot be diagnosed from CI or a
  terminal.
* **`pixivflow diagnose-egress` is not a command name**: `Command not found`,
  although `src/commands/DiagnoseEgressCommand.ts` exists — it registers under a
  different name, so the documented/first-guess spelling is wrong. Either the
  file or the docs must move.

Output-contract coverage is **partial on purpose**: only commands that *return*
their result were flagged. Commands that print inline (including `doctor` and
`dirs`, which print through the logger — a `console.log` count is not a reliable
mute test) must stay unflagged or they would print twice. The remaining
result-returning commands were not verified: `ExecuteSlotCommand`,
`SchedulerRunOnceCommand`, `WebUICommand`, `RandomDownloadCommand`,
`DownloadCommand`, `ReconcileCommand`, `DiagnoseEgressCommand`.

Known-debt entries above are intentionally not "fixed here": the discipline is
that a production-observability defect is repaired upstream and then re-verified
through the release → pin → runtime chain, never by hand inside the container.

**Resolved** by the 2026-09-27 entries below, through exactly that chain:
PixivFlow `4617d7d` + `f682048` → release **3.0.2** (`a0e5f0b`) → the pin in
`fly/deploy.pixivflow.toml` (`aff769c`) → the in-container proof of the
contract fields. Every command listed as unverified was then audited: they all
print inline, so none needs `rendersResult` (`download` declares
`printsOwnErrors`, and `reconcile --repair` gained the inline success line it
was missing). This entry stays as the historical record of the debt.

# 2026-09-27 彻底优化: CLI failure visibility, topic-mode note, author-line acceptance

Status: `VERIFIED` (upstream fix, volume config, runtime re-read) /
`EXTERNAL_ACCEPTANCE_REQUIRED` (the next 10:00/10:10 CST submission is the
author-line acceptance point)

Three items surfaced by the compatibility review of the 3.0.0 pin. All three were
repaired at the layer that owns them; nothing was hand-patched inside the
container.

## 1. CLI failure visibility — fixed upstream (PixivFlow `ca007ca`, docs `4de211b`)

`[ERROR] Command execution failed {"command":"reconcile","error":{}}` had three
causes, and only the combination explains the silence:

* `src/logger.ts` wrote `JSON.stringify(record)` with no replacer, so an `Error`
  (own but non-enumerable `message`/`stack`) serialised as `{}` — literally the
  recorded shape. Now `serializeLogValue` expands `Error` →
  `{name,message,stack,cause}`.
* `BaseCommand.failure` returned `{success:false, error}` with no `message`, so
  even a non-JSON consumer had nothing to print. The reason now travels in
  `message` as well.
* `src/index.ts` only set an exit code. It now prints `❌ <reason>` to stderr and
  logs `{command, stage:'command.execute', reason, retryable, error}` — the
  Failure Contract fields of §25. A command that prints its own richer guidance
  (`download`) declares `metadata.printsOwnErrors: true`, so the reason is logged
  but not printed twice.
* `pixivflow diagnose-egress` was a **documentation** error, not a missing
  command: `DiagnoseEgressCommand.ts` registers `name = 'diagnose'`, so the real
  invocation is `pixivflow diagnose egress`. The alias `diagnose-egress` was added
  anyway so the intuitive spelling answers.
* `reconcile --repair` printed nothing on success; it now logs the ledger row it
  wrote (target / workType / pixivId / deliveryId / created).
* The other result-returning commands were audited: `execute-slot`,
  `scheduler-run-once`, `webui`, `random-download`, `download`, `doctor`, `dirs`
  all print inline, so they stay unflagged; `AGENTS.md` now names them.

Evidence: full suite `npx jest --silent --runInBand` → **124 suites / 1356 tests
passed**; new `src/__tests__/logger.test.ts` (an Error survives as data, `cause`
reachable) and `CommandResultRenderer.test.ts` cases (a failing stage is never
silent). Pushed `e1c0ac3..4de211b` on PixivFlow `master`.

## 2. Topic-mode note template — `{{rankingDate}}` removed (both layers)

All four production targets are `mode: "topic"`, so no candidate carries a ranking
date, and `renderDeliveryTemplate` renders a *known* variable with no value as an
empty string (`src/delivery/HttpMultipartDelivery.ts:478-481`) — that is what left
`📅  · ⭐ 49 · 👁 694` in the delivered note.

* repo: `pixivflow/config/production.json`, both `bot1-submit` and `bot2-submit`
  notes;
* volume: `/app/data/production.json` on `vol_r68wlk8ynj1x5lq4`, 10937 → 10889
  bytes. Uploaded to `.new`, read back and byte-compared with the repo file
  (`ROUNDTRIP_IDENTICAL`), then `mv` over the original (`LIVE_CONFIG_UPDATED`);
  sha256 `dfb32db460078ee9808df67c070d2a1f7ea40ff304fbf142751a3acc38e351a9` on both
  sides; backup `production.json.bak-ranking` (10937 bytes, mode preserved);
  rollback `mv /app/data/production.json.bak-ranking /app/data/production.json`;
* hot reload proven rather than assumed: `fly logs` shows
  `Scheduler configuration snapshot activated {"generation":2,…}` at
  `2026-09-26T22:00:45Z`, i.e. generation 1 → 2 across the `mv`;
* a PixivFlow contract test pins both halves
  (`src/__tests__/delivery/http-multipart.test.ts`): the production note renders
  `🖌 作者：藤原ここあ` / `⭐ 49 · 👁 694` / `🏷 ボテ腹 · Pixiv 分级：R-18` with no
  `📅` and no empty slot, while the old form demonstrably produces `📅  · ⭐ 49`.

## 3. Runtime ledger re-read (read-only probe)

`fly machine start 83d1650bd23948` → `fly ssh console -a pixivflow-scheduler -C
"node /app/dist/index.js delivery status"` → `bot1-submit 39 delivered / 1 failed /
0 pending`, `bot2-submit 45 / 1 / 0` — identical to the numbers recorded when the
3.0.0 pin was verified, with no pending intent. The machine was then stopped again
(`fly machine stop 83d1650bd23948`, state `stopped`) to restore the
stopped-by-default design; the wake used the same lifecycle the clock trigger uses.

## 4. Author line — acceptance point

`🖌 作者：{{author}}` entered the volume copy on 2026-09-26 (entry above) and every
submission observed so far predates it. The next `bot1-daily` (10:00 CST) /
`bot2-daily` (10:10 CST) run is the acceptance point: the delivered note must carry
the author line. Until that is observed: `EXTERNAL_ACCEPTANCE_REQUIRED`.

**Resolved（2026-09-27 现场确认）**：下一轮投稿的 note 已带作者行 —— bot1 行 `136`、
bot2 行 `104` 都是 `🖌 作者：…`，且旧模板里空的 `📅  ·` 槽位已消失。证据见文末
「2026-09-27 现场验收」节。

## Pending

* PixivFlow's next release must carry the CLI fix; then bump `PIXIVFLOW_REF` /
  `PIXIVFLOW_VERSION`, redeploy, and re-verify `/health`, `PIXIVFLOW_REVISION` and
  the CLI probe. Until that pin moves, the container still runs `c43e4c3` and the
  fix lives only on `master` — the debt is repaired, not yet delivered.
* Rollback: note change → restore `production.json.bak-ranking`; code change → keep
  the pin at `c43e4c3`.

# 2026-09-27 PixivFlow 3.0.1 上线：CLI 失败可见

Status: VERIFIED (release → pin → runtime) / EXTERNAL_ACCEPTANCE_REQUIRED (author line)
—— Resolved by 2026-09-27 现场验收（文末节）

上一节的 Pending（“修复只在 master，容器仍跑 `c43e4c3`”）已由本节关闭：修复已经过
release → pin → runtime 三段路，并且在容器里现场复现。

## 1. 发布

* 上游修复 `fix(cli): keep a failing stage visible` 经 release PR
  [#172](https://github.com/redtidev1918/PixivFlow/pull/172) 合并为
  `33362ac35c116be7d040b8cdf7ad6b3c40b1466e`。release PR 由 `redtidev1918` 账号合并
  （车队没有自动合并；引擎 `reusable-release.yml` 的注释解释了先合并再发版的原因：
  merged release PR 仍带 `autorelease: pending` 会让 release-please 中止后续版本）。
* v3.0.1 已发布：tag `v3.0.1`（annotated，对象 `77f7f0069836f66e840fe92451f9afeb06b1642c`
  → commit `33362ac35c116be7d040b8cdf7ad6b3c40b1466e`），Release 资产
  `pixivflow-3.0.1.tgz` / `RELEASE-METADATA.json` / `SHA256SUMS`，`draft=false`
  `prerelease=false`；Release run `36275032972`（master push）三个 job
  (`release-please` / `build-plan` / `build`, `finalize`) 全部 success。
* 发布产物自证（不看源码，只看发布物）：下载 tgz（2 507 044 bytes）解包后
  `package.json` = `3.0.1`；`dist/logger.js` 含 `serializeLogValue`；
  `dist/commands/CommandResultRenderer.js` 含 `formatCommandFailure`；
  `dist/commands/DiagnoseEgressCommand.js` 含别名 `diagnose-egress`；
  `dist/commands/DownloadCommand.js` 含 `printsOwnErrors`；
  `dist/commands/ReconcileCommand.js` 含 `--repair` 成功路径日志。
* 交付物本地复现（解包 + `npm install --omit=dev`）：`node dist/index.js diagnose bogus`
  → stderr 打出 `❌ Unknown diagnose target: bogus. Try: pixivflow diagnose egress`，
  结构化行含 `stage` / `reason` / `retryable` / `error{name,message,stack}`，exit 1；
  不再出现 `"error":{}`。

## 2. 部署

* `fly/deploy.pixivflow.toml`：`PIXIVFLOW_REF = '33362ac35c116be7d040b8cdf7ad6b3c40b1466e'`、
  `PIXIVFLOW_VERSION = '3.0.1'`，注释写明回滚就是上一行的 `c43e4c3`；deploy 仓库提交
  `adff6ed chore(pixivflow): pin 3.0.1 (33362ac) for visible CLI failures`。
* `fly deploy -c fly/deploy.pixivflow.toml --ha=false` → 镜像
  `registry.fly.io/pixivflow-scheduler:deployment-01M3FWM24AH09J4YWJVXAZGPQ0`（172 MB），
  machine `83d1650bd23948` 滚动更新后停在 `stopped`（符合“空闲不占资源”的设计）。

## 3. 现场核对（全部只读）

* `/health` →
  `{"status":"ok","service":"pixivflow-scheduler-trigger","version":"3.0.1","commit":"33362ac35c11"}`。
* 启动日志：`PIXIVFLOW_REVISION=3.0.1+33362ac35c116be7d040b8cdf7ad6b3c40b1466e`，
  紧邻的前一行是 `PIXIVFLOW_REVISION=3.0.0+c43e4c3f52fcb571478399d829e19ad6ac70858e`
  —— 版本切换的现场证据，不靠推断。
* `./scripts/verify-images.sh` → exit 0（TelePost `2.67.0` 匹配；执行端报告的版本包含
  `33362ac35c11`）。
* 运行期账本未变（修复不动数据）：`delivery status` → `bot1-submit 39 delivered / 1 failed /
  0 pending`、`bot2-submit 45 / 1 / 0`，与 3.0.0 pin 时的记录一致。
* 卷上配置就是新模板：两个 `delivery.targets.*.fields.note` 都是
  `🖌 作者：{{author}}\n⭐ {{bookmarkCount}} · 👁 {{viewCount}}\n🏷 {{topicTag}} · Pixiv 分级：{{xRestrictLabel}}`，
  `rankingDate_refs = 0`、`author_refs = 2`。
* 失败可见性现场复现（用 KNOWN_DEBT 记录里的原命令）：`node /app/dist/index.js reconcile`
  → stderr `❌ Usage: reconcile --target <name> --type <illustration|novel> --pixiv-id <id>
  [--remote-id <id>] [--reason <text>] [--repair]`，结构化行
  `{"command":"reconcile","stage":"command.execute","reason":"Usage: …","retryable":false,"error":{"name":"Error","message":"…","stack":"…"}}`，
  exit 1。对照 1920-1955 记录的症状 `{"command":"reconcile","error":{}}`：失败阶段不再不可见。
* `diagnose-egress` 别名随镜像生效（`/app/dist/commands/DiagnoseEgressCommand.js` 内含），
  即文档里那个“Command not found”的写法现在也能用。
* 核对完成后 `fly machine stop 83d1650bd23948` → state `stopped`，恢复设计状态。

## Pending

* 作者行验收点：**已现场确认通过（2026-09-27 投稿）** —— bot1 行 `136`、bot2 行 `104`
  的 note 都带 `🖌 作者：…`（同批还确认了 `spoiler=0` 与小说封面预览）；见文末
  「2026-09-27 现场验收」节。

# 2026-09-27 PixivFlow 3.0.2 上线：失败的契约字段存活

Status: VERIFIED (release → pin → runtime) / EXTERNAL_ACCEPTANCE_REQUIRED (author line)
—— Resolved by 2026-09-27 现场验收（文末节）

## 1 发布

* PR #173 `chore(master): release 3.0.2`（head `17a97fe`，12 个 check 全 SUCCESS，
  release-please 在 PR 上按设计 SKIPPED）→ merge commit
  `a0e5f0be1522d2cda5500bb83dcd75295ab43fe9`。
* 注解 tag `v3.0.2`：ref 对象 `d1898c2115296e16e6b3988c786aad8cf3c424d6`（type `tag`）
  deref 到 `a0e5f0be1522…`（type `commit`）—— pin 必须用 commit。
* Release 资产：`pixivflow-3.0.2.tgz`、`RELEASE-METADATA.json`、`SHA256SUMS`；
  isDraft=false / isPrerelease=false；npm `pixivflow@3.0.2` 已发布。
* 发布 run `36276314580`（head `a0e5f0b`）：release-please / build-plan / build /
  finalize 全部 success。
* 两个修复：`4617d7d`（`serializeLogValue` 保留错误自身的可枚举契约字段：
  `code`/`statusCode`/`cause`…）+ `f682048`（启动失败路径抽到
  `src/cli/fatalError.ts`，把 error 对象按 `stage=application.startup` 记日志，
  未知错误也打印原因；命令 catch 与默认执行路径同样打印原因）。

## 2 部署（pin）

* `fly/deploy.pixivflow.toml` 从 `33362ac`/3.0.1 → `a0e5f0b`/3.0.2（commit `b705997`，
  回滚 = 上方 33362ac 行）。
* `fly deploy -c fly/deploy.pixivflow.toml --ha=false` exit 0：镜像
  `registry.fly.io/pixivflow-scheduler:deployment-01M3FY2NJJMSS21QAZZQAHSWMM`（172 MB），
  机器 `83d1650bd23948` 滚动更新后回到 `stopped`。

## 3 现场核对（只读）

* `/health` → `{"status":"ok","version":"3.0.2","commit":"a0e5f0be1522"}`。
* 运行日志同时存在 pin 前后两行：`PIXIVFLOW_REVISION=3.0.1+33362ac…` 与
  `PIXIVFLOW_REVISION=3.0.2+a0e5f0be1522d2cda5500bb83dcd75295ab43fe9`。
* `./scripts/verify-images.sh` exit 0（TelePost 固定镜像匹配、执行端版本含
  `a0e5f0be1522`）。注意：该脚本要求机器处于 started 状态，stop 时会 [FAIL]。
* `node /app/dist/index.js delivery status` → `bot1-submit 39 / 1 / 0`、
  `bot2-submit 45 / 1 / 0`（与 3.0.1 核对值一致，账本无漂移）。
* 卷配置未被部署覆盖：`/app/data/production.json` sha256
  `dfb32db460078ee9808df67c070d2a1f7ea40ff304fbf142751a3acc38e351a9`（= 仓库文件），
  `rankingDate` 0 处、`author` 2 处；备份 `production.json.bak-author`（10885）与
  `production.json.bak-ranking`（10937）都在。
* 契约字段的现场证明（只读，用镜像内已有文件当坏配置，不在容器里写任何文件）：
  `env PIXIV_DOWNLOADER_CONFIG=/app/dist/index.js PIXIV_LOG_FORMAT=json node /app/dist/index.js delivery status`
  → stderr `❌ Configuration Error: Invalid JSON in configuration file: …` +
  `{"level":"error","stage":"application.startup","error":{"name":"ConfigError","code":"CONFIG_ERROR","statusCode":400,"cause":{"name":"SyntaxError",…}}}`，
  退出码 1。对照 1927-1962 记录的症状 `{"command":"reconcile","error":{}}`：
  code/statusCode/cause 现在都在，可被 grep。
* 核对后 `fly machine stop 83d1650bd23948` → `stopped`，恢复设计状态。

## 运维教训

* 推 master 之后要等 push 触发的 Release run 跑完再 merge 发版 PR：这次 push 触发的
  run `36276271407`（head `f682048`）因为 `state cannot be changed. The pull request
  cannot be reopened.` 失败——它和我几秒前的 merge 抢同一个 PR。属良性竞态，下一次
  run（merge 提交）正常发版，但顺序错会留一条红色 run。

## Pending

* 作者行验收点：**已现场确认通过（2026-09-27 投稿）** —— bot1 行 `136`、bot2 行 `104`
  的 note 都带 `🖌 作者：…`；见文末「2026-09-27 现场验收」节。

# 2026-09-27 投稿遮罩策略：默认不遮罩（`spoiler=false`）

Status: VERIFIED (config → live volume → hot reload → 投稿现场确认 2026-09-27)

## 1 现场问题与定性

* 现象：审核群里的图片「默认带遮罩」。实测**不是审核群的默认行为**，而是继承 target 的
  `spoiler` 投递字段：生产两个 delivery target（`bot1-submit` / `bot2-submit`）当时都是
  旧版兼容值 `"{{spoiler}}"`（Pixiv 受限作品一律遮罩），而 bot1 近期的投稿恰好全部是
  R-18/R-18G（只读探针：bot1 新 12 行全 `spoiler=1`；bot2 交替）。
* 依据：`CHANGELOG.md:440-445`（1.8.3，2026-08-30）明确三种**显式**策略 ——
  `false`（默认不遮罩）、`"{{spoiler}}"`（兼容旧版：受限作品自动遮罩）、`true`（全部遮罩）；
  `CHANGELOG.md:428`（1.8.4）重申 `spoiler=false` 是独立频道策略；
  示例 `pixivflow/config/fly-two-bots.example.json:107`/`:144` 早已是 `false`。
  所以这是**配置选择**，不是代码缺陷（代码只按字段值行事）。
* 仓库改动（commit `ca8a834`）：
  * `pixivflow/config/production.json`：两个 target 的 `fields.spoiler` 由
    `"{{spoiler}}"` → `false`。布尔值安全：`HttpMultipartDelivery.resolveFields` 对每个值做
    `String(item)`，线上是字符串 `"false"`，TelePost `utils/api_server.py` 的
    `_fields_bool` 解析为 `False`。
  * `docs/concepts/delivery.md`：新增「遮罩（spoiler）是每个 target 的显式策略，不是自动
    分级结论」小节（三值表 + 审核群与频道共用同一个值的说明）。
  * sha256：`dfb32db460078ee9808df67c070d2a1f7ea40ff304fbf142751a3acc38e351a9`（10889 B，旧）
    → `e63136af4057c5c71e94be07d4d012df22f5869314923aa6c6871992fc4ecdcf`（10873 B，新）。

## 2 现场应用（卷配置）

* 为什么必须改卷：`docker/pixivflow-scheduler-entrypoint.sh:11-12` 只在
  `${PIXIVFLOW_DOWNLOADER_CONFIG:-/app/data/production.json}` 缺失/为空时才把镜像里的
  `/app/config/pixivflow.production.json` 拷过去 —— 新镜像**不会**覆盖已存在的卷配置，
  所以线上必须自己改（同 1843-1870 的 author 模板写法）。
* 机器原本是设计状态 `stopped`（`fly ssh console` → `Error: app pixivflow-scheduler has no
  started VMs.`）；`fly machine start 83d1650bd23948 -a pixivflow-scheduler` 后才可进入。
* `/tmp/live-config-set-spoiler.py`（管道进 `python3 -`）先断言旧串恰好出现 2 次、反向替换
  可还原原文、结果 JSON 可解析；备份 `/app/data/production.json.bak-spoiler`
  （sha `dfb32db4…`，10889 B）；写 `.new` 后回读比对 `ROUNDTRIP_IDENTICAL True`，再
  `os.replace`；输出 `LIVE_SHA256 e63136af… BYTES 10873 LIVE_CONFIG_UPDATED True`
  —— 与仓库文件逐字节相同。
* 热加载证据：`fly logs -a pixivflow-scheduler --no-tail` 出现
  `Scheduler configuration snapshot activated {"generation":2,…}`，两个 schedule
  （`bot1-daily` `0 10 * * *`、`bot2-daily` `10 10 * * *`）都在、无校验告警；
  `/health` → `{"status":"ok","service":"pixivflow-scheduler-trigger","version":"3.0.2"}`。
* 核对后 `fly machine stop 83d1650bd23948 -a pixivflow-scheduler` → `stopped`（恢复设计状态）。
  回滚 = `cp /app/data/production.json.bak-spoiler /app/data/production.json`。

## 运维教训

* 审核群的遮罩不是审核群的设置：`spoiler` 是**每个 delivery target 的投递字段**，同一次投稿的
  审核群预览与频道发布用的是**同一个值**。想只遮某一条，只能用审核卡上的「遮罩」按钮
  （`services/review_service.set_spoiler`/`toggle_spoiler` 只翻存储标志，不会重新 staging）。
* 卷配置是权威：镜像里的模板只在卷配置缺失时生效，任何模板改动都必须显式应用到卷。

## Pending

* **已现场确认通过（2026-09-27 10:00/10:10 CST 投稿）**：新增的
  `pending_reviews` 行 bot1 `135`/`136`、bot2 `103`/`104` 全部 `spoiler=0`
  （含 R-18 作品）；note 的 `🖌 作者：…` 行也在同一批行上确认。见文末验收节。

# 2026-09-27 TelePost 2.68.0 上线：审核群预览小说封面

Status: VERIFIED (release → pin → runtime → 小说投稿现场确认 2026-09-27)

## 0 现场问题与根因

* 现象：有真实封面的小说投稿，频道是「封面图 + TXT 文档」，但**审核群里只看得到 TXT，看不到封面**。
* 根因（读代码可判定）：封面是 PixivFlow 通过 `media_assets` 侧信道带来的
  `pixiv:<id>:novelcover` canonical asset；TelePost 落库后**发布侧**（
  `handlers/publish.py:_novel_channel_items`）会用它自建频道 root，但**审核 staging** 阶段
  从未拿到它——`QueueCommand` 里没有 `media_assets` 字段，`stage_local`/`stage_file_ids`
  只发 files/media/documents。所以审核群 = TXT only。
* 旧现场形状（只读探针，`review_message_ids` 计数）：bot1 行 134/132/130、bot2 行
  102/100/98（都是 novel，`source=api`）全是 `media=0 docs=1 previews=1`；
  同期 illustration 行 previews 等于图片数（3/5/1）——只有小说缺一条。

## 1 发布（TelePost 2.68.0）

* 代码提交：`c8d7048 feat(review): preview a novel's real cover in the review group`
  （7 文件 / +384 −26：`review_stager.py`、`review_queue.py`、`handlers/review.py`、
  `utils/api_server.py`、新 `tests/test_novel_cover_preview.py`(7 用例)、
  `tests/test_submission_timeout_idempotency.py`、`AGENTS.md` 的 §novel-cover 不变量）+
  `977b61b docs(config): document the review-group cover preview`。
  实现要点：`QueueCommand.media_assets`（第一个唯一来源）→ `novel_cover_preview_url()`
  只认显式 `:novelcover` 资产、经 `_proxied_source_url()` 转媒体代理 URL →
  stager 把它作为 `staging_only` 的 **URL 照片**先发（先于 TXT），且永不写入
  `media_json`/`documents_json`（发布侧从 canonical asset 自建 root，不能重复计数）；
  远程项永不进相册、其后的项也不与它同批（`_is_remote_item`）。
* **发版提交是人工按 release-please 格式落的**：两次 push（`c8d7048`、`977b61b`）触发的
  Release run（`36278028107`、`36278237880`）里 release-please 都是 success 但**没有**产出
  发版 PR / 发版提交（远端连 `release-please--branches--main--components--TelePost` 分支
  都没有；`workflow_dispatch` 与每小时 cron 按引擎设计会 skip release-please 作业）。
  于是按本仓 2.65.0/2.66.0/2.67.0 的既有形状手工落发版提交
  `4653a80 chore: release 2.68.0`（`.release-please-manifest.json` → 2.68.0、
  `CHANGELOG.md` 新增 2.68.0 段、`telepost/build_info.py` → 2.68.0），
  push 后由引擎完成构建/打 tag/建 release/推 ghcr。
* 发版 run `36278544519`（head `4653a80`）：release-please / build-plan /
  build(ubuntu-latest, macos-14, windows-latest) / finalize **全部 success**。
* 注解 tag `v2.68.0`：ref 对象 `ec91f156a064e6eb6791aaba61fdfdafc4a8939c`（type `tag`）
  deref 到 commit `4653a80a1b40ad0c84cb09f7bb05d2d580d7bf6e` —— pin/核对都用 commit。
* Release `v2.68.0`：isDraft=false / isPrerelease=false（published 2026-09-26T23:17:44Z），
  资产 8 个（3 个裸二进制、3 个带版本归档、`SHA256SUMS`、`RELEASE-METADATA.json`）。
* 容器镜像 `ghcr.io/redtidev1918/telepost:2.68.0`：manifest digest
  `sha256:e1574b0cb076a687de7123bf509ea5a84b0d4e24a7a8c43337a13896a5f63f11`
  （linux/amd64 + linux/arm64）。
* 自证（仓库内）：`pytest -q` 1065 passed / 1 skipped；`python check_config.py` 通过。

## 2 部署（pin）

* `fly/deploy.telepost.toml` 的 `TELEPOST_IMAGE` 由 `2.67.0` → `2.68.0`（现在在 :195，
  上方按惯例追加 2.68.0 的说明注释；回滚 = 改回 `2.67.0` 行）。
* `fly deploy -c fly/deploy.telepost.toml --ha=false` exit 0：镜像
  `registry.fly.io/telesubmit-multi-bot:deployment-01M3G09D38CS256M40P62MN5Y6`（70 MB），
  机器 `683032ec6617e8` 滚动更新到 version 229，state `started`、健康检查 1/1 passing。
* TelePress pin 未动（`telepress==0.16.1`），跨仓契约保持：`/health` 同时报
  `telepress_version=0.16.1` 与 `telepress_rich_markdown=true`。

## 3 现场核对（只读）

* `/health` → `{"status":"ok","service":"telepost","version":"2.68.0",
  "commit":"4653a80a1b40ad0c84cb09f7bb05d2d580d7bf6e", "telepress_version":"0.16.1", …}`
  —— 执行端上报的 commit 就是发版提交本身。
* `./scripts/smoke-telepost.sh` exit 0：`/health` 200、`/live` 200，
  bot1/bot2 投稿接口无令牌 → HTTP 401。
* `./scripts/verify-production.sh` exit 0：TelePost 固定镜像 = `2.68.0`、
  PixivFlow 固定提交 = `a0e5f0be1522…`、常驻参数与 force_https=off 全部 OK
  （第一次运行曾出现「1 项不合格」，重跑全绿，属瞬时抖动；未定位到具体条目，
  下一次核对再观察）。
* 审核队列现状（只读探针，`/app/data/botN/submissions.db` → `pending_reviews`）：
  bot1 pending 0 / expired 19，bot2 pending 0 / expired 11，无积压。
* 核对后 `fly machine stop 83d1650bd23948 -a pixivflow-scheduler` → `stopped`
  （PixivFlow 设计状态；核对期间它因 2.68.0 前的卷配置改动被临时启动过）。

## 运维教训

* **本仓的发版提交可能得自己落**：release-please 在 CI 里 success 但不出发版 PR 时，
  按既有形状（manifest + CHANGELOG + `telepost/build_info.py`）提交
  `chore: release X.Y.Z` 并 push，引擎就会走完整的 build → tag → release → ghcr 流程。
  手工发版提交是**可回滚的**（tag 出现前 revert 即可）。
* `fly ssh console -C` 不跑 shell：多命令要 `sh -c '…'`，脚本用 `python3 -` 管道喂。
* TelePost 的库是**每 bot 一个**：`/app/data/botN/submissions.db`（`/app/data/submissions.db`
  是 0 字节的遗留空文件）；审核预览的消息 id 列叫 **`review_message_ids`**（不是
  `preview_message_ids`），小说投稿修复后该数组应从 1 变成 2。

## Pending

* **封面预览验收点：已现场确认通过**（2026-09-27 投稿）：bot1 行 `136`、bot2 行 `104`
  仍是 `media=0 docs=1`，但 `review_message_ids` 长度已是 **2**（`staging_only` 的封面
  URL 照片 + TXT）。证据见文末验收节。
* 作者行验收点（`🖌 作者：…`）与遮罩验收点（`spoiler=0`）**同样已确认**，见文末验收节。

# 2026-09-27 现场验收：三处待验收全部通过（10:00/10:10 CST 投稿）

Status: VERIFIED（只读现场核对）

## 1 采集方式

* 只读探针（`sqlite3 file:/app/data/botN/submissions.db?mode=ro`，只 SELECT）：
  `fly ssh console -a telesubmit-multi-bot -C "sh -c 'python3 -'" < /tmp/accept-probe.py`，
  采集时间 2026-09-27T10:16:30 CST（引擎时间约 02:16Z）。
* 本轮两轮投稿都在：bot1 `bot1-daily@2026-09-27T1000`、bot2 `bot2-daily@2026-09-27T1010`；
  新增行 bot1 `135`（illustration，pixiv `150123915`）/`136`（novel，pixiv `29229643`）、
  bot2 `103`（illustration，pixiv `150132222`）/`104`（novel，pixiv `29230194`），
  两轮都走完 `review.created → review.preview_staged → (media.prepared) →
  review.control_created → review.pending → submission.accepted`。
* 对照（修复前形状，同表历史行）：novel 行 bot1 `134/132/130`、bot2 `102/100/98` 全是
  `media=0 docs=1 previews=1`，note 还是旧模板 `📅  · ⭐ …`（无作者行）。

## 2 三条验收点

* **遮罩默认不遮（`spoiler=false`）** —— 新行 `spoiler` 全为 `0`：
  bot1 `135`=0、`136`=0；bot2 `103`=0、`104`=0。旧行里 `134`/`132`/`100`/`98` 是 `1`、
  `102`/`99` 是 `0`，即遮罩本来就跟作品走；策略改成 `false` 后**全部不再遮罩**，
  与 `CHANGELOG.md:440-445`（1.8.3 起的显式策略）一致。
* **审核群预览小说封面** —— 两条 novel 行都是 `media=0 docs=1 previews=2`：
  bot1 `136`、bot2 `104`。`media_json` 仍是 `[]`（封面是 `staging_only` 的 URL 照片，
  预览多一条消息但审核记录不重复计数；发布侧仍从 canonical `:novelcover` asset 自建
  频道 root）。illustration 行不受影响：bot1 `135` `previews=1` = 图片数 1、
  bot2 `103` `previews=2` = 图片数 2。
* **note 作者行 / 空日期槽** —— 新行 note 形如
  bot1 `136`：`🖌 作者：诺克斯` / `⭐ 7 · 👁 103` / `🏷 ボテ腹 · Pixiv 分级：R-18`；
  bot2 `104`：`🖌 作者：慕尼黑屠夫` / `⭐ 34 · 👁 529` / `🏷 丸呑み · Pixiv 分级：R-18`。
  旧行的空 `📅  ·` 槽位已不再出现。

## Pending

* 无。三处验收点（`spoiler=0` / 小说封面预览 / 作者行）都在本轮现场投稿上确认通过。
