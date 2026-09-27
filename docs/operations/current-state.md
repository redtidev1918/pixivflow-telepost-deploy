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

* 遮罩要分清「两个界面」：`spoiler` 是**每个 delivery target 的投递字段**，它决定的是**频道发布**
  是否加遮罩；**审核群预览自 2026-09-28 起恒不遮罩**（不再继承投稿者的值 —— Telegram 无法对已发消息
  反向解除遮罩，审核员必须看见被审媒体），见文末「2026-09-28 内容链路稳定化」§4。想只遮某一条，
  仍然用审核卡上的「遮罩」按钮，它是在**发布前**改写存储标志
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

# 2026-09-27 四个现场 Bug 修复上线：重抓可感知（2.68.1）+ 主题 Tag 联想 / Pixiv 生成封面（3.0.3）

Status: VERIFIED (release → pin → runtime) / EXTERNAL_ACCEPTANCE_REQUIRED（下一轮投稿的现场形状）

## 0 现场问题与根因

* **重抓点击后没有可见反馈（bug 1）**：点 `🔄 重抓/换一张` 后，源审核卡的消息与键盘
  原样不动，唯一反馈是群里多一条 `🔄 审核 #135 已提交重抓…`。现场时间线（只读探针，
  `refetch_attempts` 行 9 / `audit_events` 877-880）：`t+0` 点重抓 →
  `review.refetch_requested`；`t+5s` `review.refetch_remote_accepted`（PixivFlow 收单）；
  `t+106s` 操作者按了 `拒绝`（`review.rejected`）；`t+139s` 结果才到
  （`submission.received`，actor `service:api_token:2`）。按设计
  `finalize_replacement()`/`apply_outcome()` 只在源审核仍为 `pending` 时落结果，
  于是这次尝试被正确判为 `obsolete` 并丢弃——从外面看就像「重抓卡住了」。
* **卡片一直停在「正常可操作」形态（bug 3）**：即使结果还没回来，卡片也不该继续显示
  发布/拒绝；而且重抓失败/无替代时没有任何「当前候选恢复可审核」的归还路径。
  另外进度提醒默认 5 分钟，长于这次尝试 139 s 的寿命，`last_progress_notified_at`
  始终为 NULL——等待期间一条提示都没有。

## 1 修复（TelePost `60616f8` → 2.68.1）

* `handlers/review.py`：新增 `refresh_refetch_card(bot, review_id, *, minutes=None)`——
  读取审核行，要求 `status == 'pending'` 且有 `control_message_id`，有活动尝试就把卡片
  **就地**改成「重抓中」形态（隐藏 发布/拒绝/遮罩，保留 重抓 与 查看原链接），否则用
  `control_card_from_row(row)` 重建正常卡；纯展示、不抛异常、不碰审核状态。
  `monitor_refetch_progress` 的每个终态（硬超时、watchdog 取消、远端终态、stalled、
  进度提醒）都调用它；`REFETCH_PROGRESS_REMIND_MINUTES` 默认 5 → **2**。
* `telepost/telegram/review_keyboard.py`：`refetch_pending_text` /
  `refetch_pending_keyboard` / `control_card_from_row`。
* `utils/api_server.py`：`_refresh_refetch_card(target_review_id)`——没有替换稿就结束的
  尝试也能从 HTTP 面把卡片交还。
* **源审核绝不提前判 rejected**（AGENTS.md §refetch-card）：`finalize_replacement()` /
  `apply_outcome()` 只在源为 `pending` 时落结果，提前驳回会把自己的替换稿变 `obsolete`。
* 测试 `tests/test_refetch_card_state.py`（316 行）+ 既有 `test_novel_cover_preview.py`
  → `19 passed`。

## 2 修复（PixivFlow `182694d` + `3775a8d` → 3.0.3）

* **bug 2 主题 Tag 联想**：`mode:"topic"` 只有两条召回通道（Pixiv 自动补全 + 种子作品
  共现打分），而解析出的每个 Tag 都**各自当天单独检索**，排序又是纯热度——所以
  `西瓜肚` 目标会被空间里同级的高权重相关 Tag（`丸吞`）用自己当天的热门作品占满
  slot。新增 `topicDiscovery.relatedTags`：`always`（默认，历史行为）/`
  when_seed_insufficient`（先搜主题 Tag，填不满才扩展，且带主题 Tag 的作品排在热度
  之前）/`never`；`TopicSelection.searchedTags` 与 `[TopicRecall] mode=… seedAccepted=…
  relatedTags=…` 日志可确认实际搜过哪些 Tag。默认值保持 `always` 是硬约束：
  `src/__tests__/topic/TopicFeature.test.ts:247-278`「RANKING IS POPULARITY-ONLY」钉住了
  历史排序语义。
* **bug 4 Pixiv 生成封面**：Pixiv 现在会给没有上传封面的小说**渲染**一张设计封面
  （标题排版、每本一个 hash、同一个 CDN 路径），`novel-cover-master-default` 不再出现，
  URL 形状无法与作者真封面区分；5 张生产封面下载后逐张目视分类，3 张生成设计封面的
  画布**恰好都是 640x900**（约 1.08 MB），作者真封面是 512x512 / 800x1200。
  因此：`src/utils/imageDimensions.ts`（只读 JPEG/PNG/GIF 头拿尺寸，PixivFlow 不带
  图像解码器）+ `isPixivDesignCoverImage()`（精确 640x900）+
  `NovelDownloader.resolveCoverUrl()`——命中则 `cover_url: null` 且不发 `:novelcover`
  asset；探测失败（fail open）原本一律保留封面，2026-09-28 起改为策略
  `download.novelCover.probeFailed`（默认 `skip`）——见文末「2026-09-28 内容链路稳定化」§2。
  两个消费端（TelePost 审核群预览与频道 root）因此同时被修好。

## 3 发布与部署（pin）

* TelePost：push run 又一次 release-please success 但 build/finalize skipped（既有失败
  模式）→ 手工发版提交 `8cb6e95 chore: release 2.68.1`，Release run `36295738676`
  success，tag `v2.68.1`（ref `cc8aa543…` → `8cb6e951f913a645c647ebbcb62d156fb0134d7e`）。
* PixivFlow：push（`182694d`+`3775a8d`）触发 PR **#174**，merge 提交
  `b01a93d49e63454dec0033301231f38db250a2bb`，Release run `36295701548` success，
  npm `pixivflow@3.0.3` 已发布，tag `v3.0.3`（ref `14163e903b2daa9a7f3421d5ea0911c26da35e60`）。
* `fly/deploy.telepost.toml` `TELEPOST_IMAGE` → `ghcr.io/redtidev1918/telepost:2.68.1`
  （回滚 = 上方 2.68.0 行 / 4653a80）；`fly/deploy.pixivflow.toml` →
  `PIXIVFLOW_REF=b01a93d49e63454dec0033301231f38db250a2bb` / `PIXIVFLOW_VERSION=3.0.3`
  （回滚 = 上方 a0e5f0be 行）。`./scripts/validate.sh` 仅剩两个本地文件类 FAIL
  （`.env` / `data/pixivflow/config.json` 未 bootstrap，与本次改动无关）。
* **fly 不能走代理**：带 `HTTPS_PROXY` 时 `fly deploy` 报
  `Error: Get "https://api.machines.dev/v1/apps/telesubmit-multi-bot": EOF`；改用
  `env -u HTTPS_PROXY -u HTTP_PROXY -u ALL_PROXY fly deploy …` 成功（git/npm 仍要走代理）。
* TelePost deploy exit 0：镜像
  `registry.fly.io/telesubmit-multi-bot:deployment-01M3GMGEFY3HAPGMCPRJX6XG8X`，
  机器 `683032ec6617e8` 版本 229 → **230**，checks 1/1。
* PixivFlow deploy exit 0：镜像
  `registry.fly.io/pixivflow-scheduler:deployment-01M3GMPKS2WFX6E03E7A5NPVW7`
  （digest `sha256:fc1f37b2131f5f7b9111dae20e3b455003df14bcf1a57e796c04a51c8111bcec`），
  机器 `83d1650bd23948` 滚动更新后回到 `stopped`（设计状态），release v59。

## 4 现场核对（只读）

* TelePost `/health` → `"version": "2.68.1"`，
  `"commit": "8cb6e951f913a645c647ebbcb62d156fb0134d7e"`，
  `telepress_version 0.16.1`，卷 159.8/973.7 MB，`review_queue.pending 0`。
* PixivFlow（临时 `fly machine start` 后）`/health` →
  `{"status":"ok","service":"pixivflow-scheduler-trigger","version":"3.0.3","commit":"b01a93d49e63"}`；
  日志同时有 `PIXIVFLOW_REVISION=3.0.2+a0e5f0be…`（04:38:20Z）与
  `PIXIVFLOW_REVISION=3.0.3+b01a93d49e63454dec0033301231f38db250a2bb`（05:18:28Z）。
* `./scripts/verify-images.sh` exit 0：仓库固定 TelePost 镜像匹配线上 2.68.1、仓库固定
  PixivFlow 提交匹配执行端上报的 `b01a93d49e63`。（该脚本要求机器 started。）
* 修复真的在运行容器里（只读 grep）：PixivFlow
  `/app/dist/topic/TopicPipeline.js` `relatedTags`×5、
  `/app/dist/download/novelCover.js` `isPixivDesignCoverImage`×3、
  `/app/dist/utils/imageDimensions.js` `readImageDimensions`×2；TelePost
  `/app/handlers/review.py` `refresh_refetch_card`×8 且
  `REFETCH_PROGRESS_REMIND_MINUTES = max(0, int(os.getenv("REFETCH_PROGRESS_REMIND_MINUTES", "2")))`
  （83-85 行）、`/app/telepost/telegram/review_keyboard.py`
  `refetch_pending_keyboard`×1。（容器内 import 探针无意义：`config.settings` 缺 bot
  token 会直接 `ValueError`。）
* 核对后 `fly machine stop 83d1650bd23948 -a pixivflow-scheduler` → `stopped`。

## 运维教训

* **`fly` 走代理会 EOF**：`api.machines.dev` 在带 `HTTPS_PROXY` 时返回
  `Get "…": EOF`，与被代理无关的 `git`/`npm` 不同——`fly` 一律 `env -u HTTPS_PROXY
  -u HTTP_PROXY -u ALL_PROXY` 执行。
* **Pixiv 生成设计封面 = 640x900 画布**：`novel-cover-master-default` 占位图已经不再是
  这套设计封面的特征；要区分只能用画布尺寸（作者真封面各有各的尺寸）。探测必须
  fail open，否则一次网络抖动就会让真封面消失。（该口径 2026-09-28 起被策略取代：
  `download.novelCover.probeFailed`，默认 `skip`——见文末「2026-09-28 内容链路稳定化」§2。）
* **「重抓」的可见反馈属于契约，不属于 UI 打磨**：现场时间线证明，等待 2 分钟内没有
  任何卡片变化时操作者一定会先做别的判断（这里是拒绝），而拒绝会让正在路上的替换稿
  按设计作废——反馈缺失会把正常竞态放大成「功能坏了」。

## Pending

* **外部验收（下一轮投稿）**：① 点重抓后审核卡立刻变成「重抓中」形态，且 2 分钟内有
  带已等待时长的进度提醒；② 小说投稿里 Pixiv 生成设计封面不再作为封面发出（审核行
  仍应是 `media=0 docs=1`，`review_message_ids` 长度只有 1——封面预览那条不再出现），
  而作者真封面仍为 2；③ 主题目标的 `[TopicRecall]` 日志与 `searchedTags` 能证明主题 Tag
  先被搜（默认 `always` 行为不变，改配置的目标才走 seed-first）。
* 本节的未验收项已顺延到下方 2026-09-27 架构级改造节的 `## Pending`。

# 2026-09-27 架构级改造 P0/P1：重抓作业状态机 + Tag provenance + 封面内容类型

Status: VERIFIED（release → pin → 部署 → 运行时取证全部完成，见 §4）
遗留：EXTERNAL_ACCEPTANCE_REQUIRED（下一轮真实投稿的现场形状：重复提醒 / 停滞收口 / 小程序禁用态）

## 0 现场问题与根因映射

审计（`docs/architecture/refetch-tag-cover-architecture-audit.md` §1–§3）把四个现场现象映射为四层缺失的模型，
本轮把其中两层（P0 重抓作业、P1 Tag 关系）落地：

* **重抓点击后长时间无反馈、超时无结论** ⇒ 状态是自由字符串：5 处写入、2 处绕过仓储，没有迁移表、没有逐次时间线、提醒只发一次
  （`refetch-tag-cover-architecture-audit.md:45`、§3 R1）。→ TelePost 2.69.0。
* **Tag 联想跑偏（相关热门 Tag 顶掉原始 Tag）** ⇒ 只有「相关度」没有「关系类型与权重」（§3 R2）。→ PixivFlow 3.1.0。
* **卡片上「拒绝」与「重抓」语义纠缠、答不出「上一个候选被谁换掉」** ⇒ 以记录为中心而不是以会话为中心（§3 R3）。
  本轮补的是候选因果（`refetch_seen_candidates` 的 `outcome/reason/decided_at/replaced_by`），**独立会话读模型仍未做**。
* **默认封面被当成封面投递** ⇒ 媒体资产没有内容类型维度（§3 R4）。→ PixivFlow 3.1.0（第二批；第一批是 3.0.3 的 `182694d`）。

## 1 TelePost 2.69.0（69849e2 + 266017d）

* 发布：`fa9323d chore: release 2.69.0`（只动 `.release-please-manifest.json` / `CHANGELOG.md` / `telepost/build_info.py`）；
  功能提交 `69849e2 feat(refetch): unify the refetch lifecycle and make progress observable`（11 个文件，+1197/-280）
  与 `266017d feat(observability): add a read-only telepost doctor self-check`。
* **单一状态机**：新增 `telepost/domain/refetch_state.py`（254 行）。9 个规范状态 `:41-49`；
  `ALLOWED` 迁移表 `:90-111`（每个活动态可到任一终态、活动态只能向前、终态无出边）；`assert_transition`/`can_transition`/
  `IllegalRefetchTransition` `:156-231`；旧词表映射 `:59-84`（`admitted→searching`、`no_alternative→no_candidate`、
  `obsolete→cancelled`、`TIMEOUT→failed`）；中文阶段标签 `:114-124`。
* **唯一写入口**：`apply_transition_on`（`telepost/storage/sqlite/refetch.py:200-279`）校验迁移、写 `updated_at`/`finished_at`/
  `terminal_reason`、追加 `refetch_events`；`failure_code` **只**在 `FAILED`/`TIMEOUT` 写（`:248-250`）；
  「什么都没变就不写」（`:241-242`），否则停滞阶段会被刷新成看起来在动。两个历史绕过点已收口：
  `telepost/storage/sqlite/reviews.py:222-229`、`telepost/application/review_queue.py:612-621`
  （注释 `# No bypass write: the attempt state machine owns this transition`）。
* **持久化**：`refetch_attempts` 增 `last_remote_state`/`notify_count`（`database/db_manager.py:302-303`）；
  启动迁移就地归一化旧状态字符串并**重建**部分唯一索引
  `WHERE state IN ('requested','searching','filtering','candidate_found')`（`:333-353`）；
  新表 `refetch_events`（`:364-377`）；`refetch_seen_candidates` 增 `request_id`/`outcome`/`reason`/`decided_at`/`replaced_by`（`:406-418`）。
* **看门狗四道闸门**（`handlers/review.py:489-714`）：周期提醒 `REFETCH_PROGRESS_REMIND_MINUTES`（默认 2，`:88-90`）；
  阶段停滞/远端不可读 `REFETCH_STAGE_TIMEOUT_MINUTES`（10）→ `timeout(stalled_no_progress)` /
  `timeout(remote_state_unknown)`；未被受理 `REFETCH_STALE_TIMEOUT_MINUTES`（20）→ `timeout(admission_timeout)`
  （该分支 `:586` 的 `continue` 正是修掉「原因被硬超时分支覆盖」的关键）；绝对上限 `REFETCH_HARD_TIMEOUT_MINUTES`（30）→
  `timeout(stalled_after_hard_timeout)`；幂等唤醒 `REFETCH_WAKE_MINUTES`（12）复用同一 request UUID。
* **用户可见面**：任务 ID `refetch-<source_review_id>-<epoch秒>`（`telepost/application/refetch.py:289-297`、
  `handlers/review.py:538`）；卡片阶段文案 `当前阶段` / `已等待约 N 分钟` / `任务ID`（`telepost/telegram/review_keyboard.py:116-138`）；
  `GET /api/v1/reviews/{id}/refetch`（`utils/api_server.py:2308-2326`，路由 `:2533`）在无活动 attempt 时回退
  `find_latest_by_chain`（`application/refetch.py:242`），所以**终态仍可查询**。
* **doctor**：`python -m telepost.observability.cli doctor [--bot N|--all-bots|--json|--now T]`；每个连接都是只读 URI
  `file:<abs>?mode=ro`（`doctor.py:125`、`cli.py:38`），只跑 PRAGMA/SELECT，缺表缺列 → `SKIP`；8 项检查（`doctor.py:52-61`）；
  退出码 **2 = 无法验证 > 1 = 有 CRIT > 0 = HEALTHY**（`doctor.py:931-936`）；`refetch_stuck` 15 分钟 WARN / 30 分钟 CRIT（`:66-68`）。
* **验证（本机复跑，2026-09-27，`/tmp/tp-venv312/bin/python -m pytest`）**：
  `pytest -q -p no:cacheprovider --no-cov` → `1110 passed, 1 skipped, 20 warnings in 48.86s`（exit 0）；
  四个重抓套件 `tests/test_refetch.py tests/test_refetch_card_state.py tests/test_refetch_replacement.py
  tests/test_identity_provenance.py` → `62 passed in 2.60s`（exit 0；早期基线连续复跑 5 次均 61 passed，
  中途出现过一次无法复现的单例失败——同一次全量 run 全绿，暂按环境级偶发记录，未定位到具体用例）；
  `tests/test_doctor.py` → `31 passed`。
  第 62 例是 2026-09-27 补的**连续重抓 A→B→C 回归测试**
  `test_chained_refetch_a_to_b_to_c_keeps_one_active_generation`（`tests/test_refetch_replacement.py`）：
  第二次重抓的源是上一轮的替换结果，固化「同一条链 + 代数 0/1/2 + 只有最新一代 ACTIVE +
  `111→222→333` 的 `replaced_by` 因果 + 两次 attempt 各自 `replaced`」。
  上一版文档按 `grep -c "def test_"` 记的 53 与 28 是漏数了 `test_identity_provenance.py` 的 8 例与
  `test_doctor.py` 里 parametrize 展开的 1 例。
  该测试提交（`c3944ca`，合并 `017bb1e`）位于生产镜像 2.70.1 之后，只含测试与 `AGENTS.md`，
  不改变运行时行为，因此**不需要发版**：生产 pin 仍是 TelePost 2.70.1 / `f57d161`。

## 1.1 TelePost 2.70.0（3e1950c，Mini App 投影）

* 功能提交 `3e1950c feat(miniapp): show the refetch task id, stage and elapsed wait`（5 个文件，+458/-9），
  发布提交 `ba349a7 chore: release 2.70.0`（合并 `5bf6d8c docs: refresh download page (v2.69.0)` 后为 `31d88fb`）。
* 小程序「审核详情」页渲染与审核卡同一份作业投影：`任务ID`（`attempt.progress.task_id` / `task_id`）、
  阶段标签（`attempt.label`，回退到规范态→旧态标签表）、`已等待 X 分 Y 秒`（`attempt.progress.elapsed_seconds`，
  `formatElapsed()`）、失败/终止原因；`webapp/src/pages/ReviewDetail/ReviewDetailPage.tsx`。
* **修掉一个真实可点性缺陷**：旧禁用条件只认 `requested`/`admitted`，而服务端在规范态
  `searching`/`filtering`/`candidate_found` 时的 wire `state` 仍是 `admitted`（`to_legacy`），
  因此进行中的重抓在小程序里**看起来仍可点击**；现在按 `ACTIVE_REFETCH_STATES`（含 5 个活动态）禁用。
* 契约：`api/openapi.yaml` 的 `GET /reviews/{review_id}/refetch` 补上 `canonical_state`/`stage`/`label`/
  `task_id`/`terminal_reason`/`last_remote_state`/`notify_count`/`finished_at`/`progress` 与 `events`，
  `state` 保持旧词表并写明映射（wire 兼容不变）；`webapp/src/api/generated/schema.d.ts` 重新生成
  （顺带补回此前漂移未生成的 `/posts/hot`）。
* **验证**：`webapp` 内 `npm run typecheck` exit 0；`npx eslint src` 0 error（2 条既有
  `react-refresh/only-export-components` warning，均在未改动文件）；`npx vitest run` → `11 files / 50 tests passed`；
  `npm run build`（含 `generate:api`）exit 0；远端 `Mini App CI` run `36298324905` 三个 job 全 success。

## 1.2 TelePost 2.70.1（95ddc64，doctor 恒定误报修正）

* 现场核对时发现：`doctor` 的 `delivery_outbox` 检查对整张 `delivery_ledger` 取 `MIN(created_at)` 判年龄，
  但该表是「**已确认发布**」的幂等账本（`telepost/storage/sqlite/ledger.py:1-5`），历史行只会越来越老 ⇒ 两个 bot 恒定报
  `WARN delivery_ledger 最旧记录已 24108.1 分钟`（bot2 23545.9）——恒定的噪声告警会掩盖真实积压，属实现缺陷而非现场问题。
* 修正（`telepost/observability/doctor.py` `_check_delivery_outbox`）：年龄只统计**未确认**行
  （`FAILED_LEDGER_STATUSES = ('partial','uncertain','failed','error')`，`:78`），新增且恒定输出
  `details.ledger_oldest_unresolved_age_seconds`，消息文案改为「最旧未确认记录已 N 分钟」；
  `delivery_outbox` 队列表保持整表年龄（那里一行就代表待处理工作）。`docs/CONFIGURATION.md:310` 同步说明。
* 测试：`tests/test_doctor.py` 31 passed（新增 `test_published_ledger_history_never_warns_on_age`、
  `test_stale_unresolved_ledger_row_is_warn`）；`tests/test_doctor.py tests/test_observability.py
  tests/test_observability_lifecycle.py` → 45 passed。
* 发布：`95ddc64 fix(observability): stop the doctor from warning about settled ledger history` +
  手工发布提交 `f57d161`（release 2.70.1），Release run `36299841574` success。
* 现场复验：容器内 `doctor --all-bots` → `HEALTHY / 16 OK / 0 WARN`，`DOCTOR_EXIT=0`。

## 2 PixivFlow 3.1.0（661964c + d23fed2）

* 发布：`583a74c chore(master): release 3.1.0 (#175)`（只动 `.release-please-manifest.json` / `CHANGELOG.md` / `package.json` / `package-lock.json`）；
  功能提交 `d23fed2 feat(topic): carry provenance and weight through tag expansion`（12 文件，+1080/-40）
  与 `661964c feat(novel): classify the cover content type and gate delivery by policy`（10 文件，+354/-33）。
* **Tag provenance**：`TagSource = 'seed'|'cooccurrence'|'autocomplete'|'cooccurrence+autocomplete'`（`src/topic/types.ts:21`），
  `ResolvedTag` 增可选 `source`/`weight`（`:35`/`:37`）；seed 的 score/weight = 1（`src/topic/TopicResolver.ts:118-121`）；
  autocomplete-only 权重 `AUTOCOMPLETE_ONLY_SCORE = 0.27`（`src/topic/TopicTagScorer.ts:54`）；cooccurrence 的 `weight` 就是 `score`
  （`:124`、`:131`）。
* **新配置全部可选、默认 = 旧行为**（默认值是「字段缺失」，不是字面量）：`topicDiscovery.seedTier`（默认 `'off'`；`:219` 只在 `'on'`
  时把带 seed Tag 的作品排在热度之前）、`topicDiscovery.tagRelations.{allowSources,allow,deny}`（deny 优先 `:104-109`；
  seed 不会被 allow/allowSources 丢掉 `:80-81`/`:117-118`）、`topicDiscovery.matchTranslatedNames`（默认 `false`，`:209`）。
* **关系过滤发生在任何检索之前**（`src/topic/TopicPipeline.ts:210`；唯一检索调用在 `:226`）；`selection.resolvedTagCount`
  改为统计被走到的 Tag（`:290`）；译名经 alias map 保证同一 Tag 对一篇作品只计一次（`:128-141`、`:413`、`:418-419`）。
* **诊断**：`topic resolve` 输出 `name/translated/source/weight/score/seed/searched`（`src/commands/TopicCommand.ts:92`）；
  `topic test` 输出 `searchedTags=`（`:143`）。
* **封面内容类型**：`src/domain/media/NovelCoverPolicy.ts`（84 行）`classifyNovelCover()` → `custom` / `pixiv_generated`（恰好 640x900）/
  `unknown`（`:35`、`:43-44`、`:66-73`）；`coverDeliveryDecision()`（`:77-84`）：`pixiv_generated` **无条件** `skip`，
  `unknown` 由 `download.novelCover.unknown` 决定（默认 `skip`，`:56`）；探测失败记 `probe_failed` 并**保留**封面
  （`src/download/NovelDownloader.ts:465`）。尺寸只读头部字节（`src/utils/imageDimensions.ts`，97 行，3.0.3 的 `182694d`），失败即返回 `undefined`。
* **默认行为被测试钉住**：`src/__tests__/topic/TopicRecall.test.ts:86-95`（默认仍是全空间检索 + 热度排序）、
  `src/__tests__/topic/TopicFeature.test.ts:247-280`（`RANKING IS POPULARITY-ONLY`）。
* **验证（本机复跑，2026-09-27；本地工作树 HEAD `d23fed2`，比发布提交 `583a74c` 落后 1 个提交）**：
  `node_modules/.bin/jest --silent` → `Test Suites: 129 passed, 129 total` /
  `Tests: 1424 passed, 1424 total` / `Snapshots: 0 total`；`node_modules/.bin/tsc --noEmit` → exit 0（无输出）。
  该仓库没有本地 ESLint。

## 3 文档

* 本仓库新增 `docs/architecture/refetch-job-model.md`（重抓作业的权威参考：状态机 / 唯一写入口 / 时间线 / 候选因果 /
  远端 cell 投影 / 四道闸门 / doctor / 排障 / 禁止事项），并注册进 `docs/_sidebar.md`「架构设计」组。
* `docs/architecture/refetch-tag-cover-architecture-audit.md`：`Status` 改为 P0/P1 IMPLEMENTED；新增 `## 0 实施结果（2026-09-27）`
  对照表与「仍未完成」清单；§2/§3 中已被推翻的句子就地标注「改造前事实」（不删除历史证据）。
* `docs/architecture/ecosystem-platform.md` 新增 §28.1（重抓作业所有权与投影）；`docs/CONTRACT.md` 新增 §3.1
  （远端 cell → 阶段词汇表，并声明 wire 契约未变）；`docs/operations/refetch-production-verification.md` 追加 2.69.0 验证基线。
* PixivFlow：新增 `docs/TAG_RANKING.md`（141 行：分值语义 / 来源分类 / 排名规则 / 配置 / 诊断），注册进 `docs/README.md:44`
  与 `docs/_sidebar.md:9`；`docs/CONFIG.md` 增补 `seedTier` / `tagRelations` / `matchTranslatedNames` 与封面策略小节；
  `CHANGELOG.md` 的 3.1.0 段落恰好列出两条 feature。

## 4 现场核对（只读）

Status: VERIFIED（2026-09-27，release → pin → 部署 → 运行时取证全部完成）

* **pin（已提交，见本节末 commit）**：`fly/deploy.telepost.toml` `TELEPOST_IMAGE` = `ghcr.io/redtidev1918/telepost:2.70.1`；
  `fly/deploy.pixivflow.toml` `PIXIVFLOW_REF` = `583a74c98ef708223d100abbd9b255b26976218e` / `PIXIVFLOW_VERSION` = `3.1.0`。
* **release**：PixivFlow 3.1.0（release PR #175 squash 合并 → `583a74c`，tag `v3.1.0`，Release run `36297971345` success）；
  TelePost 2.70.1（release-please 仍不产出发布提交 → 手工发布提交链 `ba349a7`(2.70.0) → `95ddc64`+`f57d161`(2.70.1)，
  Release run `36299841574` success，镜像 `telepost:2.70.1`）。
* **部署**（均须 `env -u HTTPS_PROXY -u HTTP_PROXY -u ALL_PROXY`，fly 走代理会 `EOF`）：
  `fly deploy -c fly/deploy.pixivflow.toml --ha=false` → 镜像 `deployment-01M3GQ97EJ35QRT0KT05VR14A7`
  （digest `sha256:e7c6c75a7ccd6a86bcbf8b9f42c9f62b2966c27edef376102099a6b5b43929fa`），机器 `83d1650bd23948` 部署后回到 `stopped`（设计态）；
  `fly deploy -c fly/deploy.telepost.toml --ha=false --strategy rolling` → 镜像 `deployment-01M3GR35TE1WFX4W1B542E7MV1`，
  机器 `683032ec6617e8` 1/1 checks passing。
* **`/health`**：PixivFlow `{"status":"ok","version":"3.1.0","commit":"583a74c98ef7"}`；
  TelePost `"version": "2.70.1"`, `"commit": "f57d1617ef639eeccdbb749adb80f479c45a841b"`, `build_date 2026-09-27T06:26:24Z`,
  `telepress_version 0.16.1`, volume `159.8/973.7 MB`, `review_queue pending 0`。
* **`./scripts/verify-images.sh` exit 0**：`[OK] 仓库固定的 TelePost 镜像：ghcr.io/redtidev1918/telepost:2.70.1`、
  `[OK] 仓库固定的 PixivFlow 提交：583a74c98ef708223d100abbd9b255b26976218e`、`[OK] TelePost 线上镜像匹配 2.70.1`、
  `[OK] 执行端报告的版本包含 583a74c98ef7`。
* **`python -m telepost.observability.cli doctor --all-bots`（容器内）**：`HEALTHY`，`检查 16 项：16 OK / 0 WARN / 0 CRIT / 0 SKIP`，
  `DOCTOR_EXIT=0`；两库 `PRAGMA integrity_check = ok`、无活跃重抓、无孤儿审核、无卡 publishing。
* **运行时取证（只读 grep，证明代码真的在容器里）**：
  PixivFlow `/app/dist/topic/TopicPipeline.js` `selectWalkedTags` ×3 / `seedTier` ×4 / `allowSources`；`/app/dist/config/validation.js` `Unknown tag source`；
  `/app/dist/domain/media/NovelCoverPolicy.js` `classifyNovelCover` / `coverDeliveryDecision` / `PIXIV_GENERATED_COVER_WIDTH`，`/app/dist/download/NovelDownloader.js` 引用 `classifyNovelCover`；
  TelePost `/app/handlers/review.py:92-105` 五道闸门默认值 2/10/20/12/30，`/app/telepost/domain/refetch_state.py` 存在（9903 B），
  `/app/telepost/observability/doctor.py` 含 `最旧未确认记录` + `ledger_oldest_unresolved_age_seconds`，
  Mini App `/app/webapp/dist/assets/index-B8NVYagl.js` 含 `refetch-` 与 `搜索候选`。
* **现场发现并当场修掉的缺陷（2.70.1）**：doctor 的 `delivery_outbox` 检查对**整张** `delivery_ledger` 取 `MIN(created_at)`，
  而该表是「已确认发布」的幂等账本（行只会越来越老），于是两个 bot 恒定报
  `delivery_ledger 最旧记录已 24108.1 分钟` / `23545.9 分钟`——恒定噪声会掩盖真实积压。
  修正为只看未确认行（`partial`/`uncertain`/`failed`/`error`），并在消息里写明「未确认」（提交 `95ddc64`，发布 2.70.1）。
  注意：本仓库 `docs/architecture/refetch-job-model.md:219` 描述的就是修正后的语义，即**文档是对的、代码是错的**。

## Pending

* **顺延（上一轮 2.68.1 / 3.0.3 的外部验收，仍未现场确认）**：① 点重抓后审核卡立刻变成「重抓中」形态，
  且 2 分钟内有带已等待时长的进度提醒；② 小说投稿里 Pixiv 生成设计封面不再作为封面发出，而作者真封面仍为 2；
  ③ 主题目标的 `[TopicRecall]` 日志与 `searchedTags` 能证明主题 Tag 先被搜。
* **本轮外部验收（必须在真实投稿上做，本机/只读检查无法替代）**：① 真实点一次重抓，卡片/群消息必须带
  `任务ID refetch-<review>-<epoch秒>` 与已等待时长，且进度提醒**重复**出现（默认每 2 分钟一次，不是只发一次）；
  ② 让一个阶段真正停滞，必须以「重抓超时未完成」收口（`failure_code = stalled_no_progress`）而不是无限 `SEARCHING`；
  ③ 小程序「审核详情」在重抓进行中显示任务ID/阶段/已等待，且「重抓」按钮为禁用态。
* **本轮只读项已清零**：`/health`、`verify-images.sh`、`doctor --all-bots`、运行时 grep 均已现场通过（见 §4）。
* **后续观察**：`delivery_ledger` 目前没有任何未确认行（两库皆 0），所以 2.70.1 之后 `delivery_outbox` 常绿是**真实结论**，
  不是被规避；一旦出现 `partial`/`failed` 行且超 30 分钟，doctor 应立刻 WARN——这是下一轮现场投稿要顺带看的信号。
* 本节之后，2026-09-27 又落地了 PixivFlow 3.2.0（QQ 场景的可运行 OneBot v11 适配器示例），见下方的
  「2026-09-27 PixivFlow 3.2.0」节；本节的三条外部验收仍未现场确认，继续顺延。

# 2026-09-27 PixivFlow 3.2.0：QQ 场景的可运行 OneBot v11 适配器示例

Status: VERIFIED（release → pin → 部署 → 运行时取证全部完成，见 §3）
遗留：EXTERNAL_ACCEPTANCE_REQUIRED（真实 QQ 群投递必须接真实 NapCat 与真实群，本机只能以假 OneBot API 证明映射；见 §4）

## 0 为什么做这一片（缺口与边界）

* **缺口是「没有可运行实例」，不是「缺文档」**：投递运行时路线图 P5 写的是「文档与示例补齐」，
  但 `examples/` 下只有 `gateway/`（契约参考实现，只把投递打印出来），
  `docs/GATEWAY.md` §5.3 描述的三路由「最小转换进程」一直是**文字**，
  `docs/architecture/delivery-runtime.md` 的平台表里 OneBot 一行也只写了「由网关承担」。
  结论：契约通不通有证明（`gateway-reference-e2e.test.ts`），**平台映射写对没有没有任何证明**。
* **边界不变（重要）**：`examples/onebot-adapter/` 是**网关侧示例代码**（与 `examples/gateway/` 同级）：
  `examples/` 不进 `dist/`、不进 Docker 镜像（`docker/pixivflow-scheduler.Dockerfile` 只复制 `src`/`scripts`
  与可选的 `webui-frontend/dist`）、PixivFlow 从不加载它。它**不实现 QQ 协议、不实现 OneBot 协议、
  不做扫码登录、不持有会话**，QQ 会话仍属于 NapCat（扫码在 NapCat 自己的面板）。
  因此路线图的 `P3c`（PixivFlow 内置 `onebot` connector type）依旧**不实现**，
  `delivery.targets.<name>.type` 依旧是 `httpMultipart` / `telegram` / `webhook` 三种。

## 1 交付内容

* **`examples/onebot-adapter/server.mjs`（零依赖 ESM，612 行）**：契约统一消息 → OneBot v11 消息段，
  OneBot `retcode` → 契约 ACK 状态词。三条路由：`POST /deliver`、`GET /pairing`（→ `get_login_info`）、
  `GET /health`（→ `get_status`，`online !== false && good === true`）。`--selftest` 用进程内假 OneBot 跑完整映射。
* **ACK 映射（「状态词优先」）**：`retcode 0` → `200 {"status":"accepted","id":<message_id>}`；
  `status:"async"` 或 `retcode 1` → `200 {"status":"pending"}`（**绝不**当成功）；
  确定性请求错误码（100/102/103/104/105/1400/1404）→ `200 {"status":"failed"}`（终态，进死信）；
  超时/不可达/HTTP ≥500/非 JSON → `502`，仅 `{reason}`**不带状态词** ⇒ 可重试而不误判死信；
  鉴权失败/404/429 → 原样 4xx/429，同样不带状态词。去重按 `idempotencyKey` 落在 JSONL 状态文件上，
  重放返回 `200 {"status":"duplicate_existing","id":…}`。
* **消息段**：`message.text` 只消费一次；`image`/`video` → 对应段（`image.file` 支持 `file://<绝对路径>` 与
  `base64://`）；`album` → 多段；`file` **不是**消息段 → 先 `upload_group_file`/`upload_private_file`
  再补一条「📎 附件：<name>」提示；无法传输的媒体退化为一行「[跳过无法传输的 … 片段]」文本。
* **`examples/onebot-adapter/README.md`（139 行，中文）**：它是什么/不是什么、`--selftest`、完整环境变量表、
  三路由、段翻译表、ACK 映射表（含「为什么不带状态词」）、PixivFlow 侧 `delivery.targets.qq-main` 配置样例、
  四层验收（`--selftest` → jest 用例 → NapCat 面板 → 真实投稿 + `pixivflow delivery status`）。
* **`src/__tests__/delivery/onebot-adapter-e2e.test.ts`（350 行 / 7 用例）**：像 `gateway-reference-e2e.test.ts`
  一样**另起进程**拉起适配器，并用**真实投递运行时**驱动它打到一个假 OneBot API：
  `DeliveryService → outbox → OutboxWorker → DeliveryDispatcher → WebhookDelivery → HTTP`。
  用例覆盖：真实投递 `delivered` 且段里 `group_id` 是**数字**、重放去重、`async` → 账本仍 `pending`、
  `retcode 102` → 账本 `failed` 且无可执行 outbox 行、未鉴权 → 裸 401、`schemaVersion: 2` → 400、
  `/pairing` + `/health` 在假 OneBot 停掉时同端口恢复。
  写这个用例时抓到两个真问题：目标必须配 `token`，否则适配器按设计回裸 401（投递卡 pending）；
  以及 `group_id` 曾被当成字符串发（`parseTarget` 因此补了 `idValue`，数字型 id 发数字）。
* **打包与文档**：`package.json` `files` 增 `examples/onebot-adapter/`（npm 包里带示例）；
  `docs/GATEWAY.md` §5.3 指向可运行实例、§8 增 `--selftest` 与 jest 命令；
  `docs/GATEWAY_CONTRACT.md` 「相关文档」与「这份契约是怎么被证明的」表增平台映射一行；
  `examples/gateway/README.md` 增互补说明；`docs/architecture/delivery-runtime.md` 路线图增 `P8` 行
  并在 `P3c` 段落说明「示例进仓库 ≠ 反向推翻决定」。

## 2 版本与 pin

* 功能提交 `0d60160 feat(gateway): ship a runnable OneBot v11 delivery adapter example`（7 文件，+1121/−0），
  合并远端 docs 刷新后为 `c0ca14d`，推送 `b5021bf..c0ca14d`。
* 发布：release PR **#176 `chore(master): release 3.2.0`** squash 合并 → `c195b909063ca63fa7de88a745c9b933b41e4133`，
  tag `v3.2.0`。随后补的文档提交 `3feb01c`（合并为 `0466ce0`）是 `docs:` 类型，**不产生新版本**。
* **pin（已提交，见本节末 commit）**：`fly/deploy.pixivflow.toml`
  `PIXIVFLOW_REF = 'c195b909063ca63fa7de88a745c9b933b41e4133'` / `PIXIVFLOW_VERSION = '3.2.0'`，
  回滚 = 上一行 `583a74c98ef708223d100abbd9b255b26976218e`（3.1.0）；
  `fly/deploy.telepost.toml` 本轮**不动**（`TELEPOST_IMAGE = 'ghcr.io/redtidev1918/telepost:2.70.1'`，
  TelePost 本轮无代码变更）。

## 3 现场核对（只读）

Status: VERIFIED（2026-09-27，release → pin → 部署 → 运行时取证全部完成）

* **静态门**：`npx tsc --noEmit` → `TSC_EXIT=0`。该仓库没有可用的 ESLint（无本地 eslint、无 `lint` 脚本，
  `npx eslint@10` 拒绝旧的 `.eslintrc.js`），`tsc` 是唯一静态门。
* **全量测试**：`npx jest --silent` → `JEST_EXIT=0`，**130 suites / 1431 tests passed**
  （改动前 129 / 1424 ⇒ +1 suite / +7 tests，全部来自新的适配器 e2e 用例）。
* **`--selftest`**：`node examples/onebot-adapter/server.mjs --selftest` → `SELFTEST_EXIT=0`，
  报告 `first=accepted(id=42)`、`second=duplicate_existing(id=42)`、未鉴权 401、
  `pairing={status:'connected',account:'10001'}`、`health={onebot:{online:true,good:true,retcode:0}}`、
  `onebotCalls=[send_group_msg,upload_group_file,send_group_msg,get_login_info,get_status]`。
* **npm 包**：`pixivflow@3.2.0` 已发布；下载 tarball 核对，`examples/onebot-adapter/README.md`
  与 `examples/onebot-adapter/server.mjs` **确实在包里**（`package.json` `files` 生效）。
* **部署**（须 `env -u HTTPS_PROXY -u HTTP_PROXY -u ALL_PROXY`）：
  `fly deploy -c fly/deploy.pixivflow.toml --ha=false` → 镜像 `deployment-01M3GTGBSZ2Y3Z231P7WARDE2W`（172 MB），
  机器 `83d1650bd23948` 更新后回到 `stopped`（设计态）；为了取证临时 `fly machine start`，取证后再次停机。
* **`/health`**：PixivFlow `{"status":"ok","service":"pixivflow-scheduler-trigger","version":"3.2.0","commit":"c195b909063c"}`；
  TelePost 仍是 `"version": "2.70.1"`, `"commit": "f57d1617ef639eeccdbb749adb80f479c45a841b"`。
* **`./scripts/verify-images.sh` exit 0**：`[OK] 仓库固定的 TelePost 镜像：ghcr.io/redtidev1918/telepost:2.70.1`、
  `[OK] 仓库固定的 PixivFlow 提交：c195b909063ca63fa7de88a745c9b933b41e4133`、
  `[OK] TelePost 线上镜像匹配 2.70.1`、`[OK] 执行端报告的版本包含 c195b909063c`。
* **`python -m telepost.observability.cli doctor --all-bots`（容器内）**：`HEALTHY`，
  `检查 16 项：16 OK / 0 WARN / 0 CRIT / 0 SKIP；数据库 2 个`（TelePost 本轮未改，属回归确认）。
* **本轮镜像里没有适配器，这是刻意的**：`docker/pixivflow-scheduler.Dockerfile` 只复制 `src`/`scripts`
  与可选的 `webui-frontend/dist`，`examples/` 不进镜像（它进的是 npm 包与仓库）。
  因此 3.2.0 对**运行中的 worker** 是**行为等价**于 3.1.0 的发布（新增文件都在 `examples/` 与文档/测试里），
  本轮部署的价值是把 pin 推进到已发布提交并保持可追溯，而不是改变运行时行为。

## 4 外部验收（必须在真实 QQ 现场做）

* 接真实 NapCat（+ 真实 QQ 群）跑一次：PixivFlow 侧配 `delivery.targets.qq-main`（`type:"webhook"`，
  `url` 指向适配器 `/deliver`，`token` **必须配**否则按设计裸 401、投递卡 pending），
  真实投稿应看到：群里先收到正文，再收到图片，`file` 类附件走两段式上传 + 「📎 附件」提示。
* ACK 语义现场确认：QQ 侧风控/限速导致的失败必须落成**可重试**（裸 5xx/429，账本 `pending` 且 `hasActionableDelivery=true`），
  只有确定性请求错误（如 `retcode 102`）才允许进死信；这条是「no status word」设计的现场判据。
* NapCat 掉线/重启：`GET /pairing` 与 `/health` 必须如实变 `unreachable`/503，恢复后同进程回到 `connected`。

## Pending

* 本轮只读项已清零（§3 全部现场通过）。
* 外部验收（上一节，需真实 QQ 现场）。
* 顺延未清的仍是上一节的三条真实投稿外部验收（重复提醒 / 停滞收口 / 小程序禁用态）。



## 2026-09-28 Workflow Protocol v1：把边界从「隐式约定」改成「显式协议」（✅ 已收口；遗留 D/E 见 §6.6）

Status: DONE（协议 v1/v1.1 SSOT、两端实现、PixivFlow 3.4.1 + TelePost 2.71.1 均已发版并部署，现场复验见 §5/§6；§6.6 的 D/E 为 OPEN）

### 0 为什么是边界问题

「审核重抓永久静默」的只读取证（本文件上一节 + `docs/architecture/refetch-silent-failure-cure.md` §9）确认：
30 天里用户感知到的约 560 次「点了重抓没反应」**不是单点 bug**，而是两侧边界模糊 ——

* TelePost 知道 PixivFlow 的槽位词表（`slot_name='审核群重抓'`）、`slotId`、`manual_request_id`，
  并且用 PixivFlow 的内部状态字符串驱动自己的状态机；
* PixivFlow 知道 TelePost 的审核流程（`refetchOutcomeUrl` 回报 `no_alternative`/`failed`，投稿负载塞 `refetch_request_id`）；
* 两侧靠隐式约定通信，于是**任何一侧单独改动都不会被另一侧理解**，状态就开始错乱：一次实际提交可能既不产生结果、
  也不产生失败、也不产生超时，调用方无法判断 job 是否还存在。

因此目标不是「修 refetch」，而是抽出一套稳定的 Workflow Protocol：TelePost 只做内容工作流编排
（Telegram/审核/队列/发布/用户交互/权限），PixivFlow 只做内容采集与处理引擎（搜索/tag 分析/下载/元数据/媒体处理/候选生成），
两者之间只有 **Task / Job / Event / Result / Asset** 五种对象。规范与机器可校验资产见
`docs/architecture/workflow-protocol.md`、`docs/protocol/README.md`。

### 1 协议资产（SSOT + 可校验，已落地）

| 资产 | 位置 | 校验方式 |
| --- | --- | --- |
| 规范（决定性文字） | `docs/architecture/workflow-protocol.md`（§2 对象 / §3 HTTP 面 / §4 状态机与预算 / §5+§5.1 错误码与映射 / §6 job_type 目录 / §7 事件 / §8 反耦合清单 / §11 阶段 B/C 文件级映射） | 人工评审 |
| Schema | `docs/protocol/v1/protocol.schema.json`（JSON Schema 2020-12，入口是 `$defs`） | `scripts/verify-protocol-v1.py` |
| 错误词表映射 | `docs/protocol/v1/error-mapping.json`（16 个封闭协议码 + `retryable` 缺省 + 生产者内部 19 个原因码 → 协议码） | 同上，含 `TargetOutcome.ts` union 覆盖率 |
| 示例报文 | `docs/protocol/v1/fixtures/*.json`（11 个：task / job queued·running·succeeded / job failed / job cancelled / event succeeded·expired / capabilities / **jobpage** / **eventpage**） | 同上，逐个用对应 `$defs` 入口校验 |
| 同步机制 | `scripts/sync-protocol.sh`（写入两仓 `protocol/v1/` + `SOURCES.sha256`）；`--check` 只校验 | 两仓契约测试再校验一次哈希 |
| 验收工具 | `scripts/verify-protocol-v1.py`（离线：schema/fixtures/params/词表/哈希/反耦合；`--live`：capabilities → POST /jobs → 幂等重放 → 轮询 → cancel → **事件流对账**） | 退出码 0/1/2；`--live` 已用 mock 双向验证（MODE=ok 通过 / MODE=noevents 必失败） |

实测（2026-09-28）：`./scripts/verify-protocol-v1.py` 在 `python3`（内置子集校验器）与
`/tmp/tp-venv312/bin/python`（真实 `jsonschema` 4.26.0，额外做 meta-schema 校验）两条路径下均 exit 0 ——
`错误词表与 schema enum 完全一致（16 个码）`、`TargetOutcome.ts: 19 个内部原因码全部映射到协议码`、
`TelePost/PixivFlow vendored 副本与 SSOT 一致（9 文件 + manifest）`、反耦合断言通过。
`--live` 已用 `MODE=ok/stuck/refetch/badcapabilities` 四个 mock 服务端到端演练过（含「泄漏 `refetch_request_id`」与
「capabilities 缺 candidate_search」两类失败被正确判失败）。

**错误词表的关键决定**：协议 `Error.code` 保持**封闭**，生产者内部 `TerminalReasonCode` **不进协议**，
而是在 job facade 处映射（`error-mapping.json` 是机器可读的那份映射）。理由：把内部词表复制进共享协议，
等于把刚拆掉的耦合以「共享枚举」的形式长回来；映射腐烂由验收脚本的 union 覆盖率检查兜住。
调用方若拿到 payload 自带 `retryable` 则以 payload 为准，否则用映射表缺省；旧 `/refetch/status` 继续返回内部码用于诊断。

### 2 生产端（PixivFlow）已落地：先让投影可信

「协议建立在不可信的投影上没有意义」，所以先修 liveness（round A）：

* `job_id` 级别的**真实活性投影**：`src/scheduler/JobProjection.ts` 输出
  `createdAt/startedAt/updatedAt/heartbeatAt/leaseExpiresAt/leaseActive/claimed/attemptCount/terminalReasonCode/terminalReasonMessage/manualRequestId/idempotencyKey/correlationId`
  （时间戳统一 epoch ms；SQLite 的无时区 `CURRENT_TIMESTAMP` 通过 `src/scheduler/ledger-time.ts` 转换，避免 8 小时错位）。
* **不再有无限 RUNNING**：`src/scheduler/StallSweep.ts` 每 60 s 扫一次（下限 60 s / 单批 100 行），
  先恢复被中断的 slot 再终结超预算的 slot；新增 `queued_too_long`（`schedulerRuntime.queuedTimeoutMs`，默认 30 min）
  与 `stalled_no_heartbeat`（`stallTimeoutMs`，默认 15 min），交付侧新增 `delivery_abandoned`。
  配置项非法只告警并回落默认（non-fatal）。
* 文档同步：`docs/CONFIG.md`（两个新预算 + 扫掠语义）、`docs/SLOT_OUTCOME.md`（「不再有无限 RUNNING」章节 + 用户文案）。

实测：`npx jest --silent` → 134 suites / 1470 tests 全绿（基线 130/1431，+4 suites/+39 tests 全为新用例）；
`npx tsc --noEmit` → exit 0。

### 3 消费端（TelePost）已落地：协议资产 + 端口收口（实现仍在进行）

* 新增两个 fixture 并同步两仓（TelePost `5228ebb`、PixivFlow `0e984ab`）：`job.cancelled.candidate_search.json`
  （终态取消带 `error.code=cancelled_by_consumer`、`retryable=false`）与 `capabilities.pixivflow.json`
  （`protocol_versions` + `candidate_search` 声明，预算取自配置：queued 30 min / stall 15 min / 心跳 30 s /
  deadline 90 min）——把 B 阶段最可能做错的「取消」与「能力发现」两面在实现之前先写成可校验报文。
* 新增 `$defs/JobPage` / `$defs/EventPage` 两个信封（`GET /jobs?...` 与 `GET /jobs/{id}/events`），
  分页只能用不透明游标（`next_cursor` / `next_after`），禁止暴露生产者表 id；`--live` 会在终态后拉事件流，
  空事件流 / 缺终态事件 / 混入其它 job / 时间乱序 都判 FAIL ——「没收到回调」不再是唯一的对账依据。
* 可选的对象字段（`Job.error/result/progress`、`Event.payload.*`）同时接受「缺失」与「显式 null」，
  避免把合法生产者判失败（PixivFlow 的子集校验器忽略 `anyOf`，真实 jsonschema 路径强制执行）。
* 新增**确认面** `POST /jobs/{job_id}/events/ack`（`$defs/AckRequest`/`$defs/AckResult` + fixture）：
  明确「推送 2xx」与「补拉后 ack」是同一义务的两条路，`ack_through` 单调幂等、未知游标按 no-op、
  **ack 绝不改状态**；`--live` 新增 ack 往返检查（`unacked` 归零 + 重复 ack 幂等 + 状态不变）与
  **幂等键冲突探测**（同键不同参数必须 409 `idempotency_conflict`），两者都做了正反双向验证
  （`MODE=noack` 会从生产者侧失败）。mock 生产者随仓入库（`scripts/mock-protocol-server.py`，
  `MODE=ok/noevents/noack/stuck/refetch`），`protocol/README.md` §3.1 写明复现命令与「先 pkill 再起 mock」的坑。
* round B 给 `TerminalReasonCode` 加 `cancelled_by_consumer` 后，union 覆盖率检查立刻变红（预期），
  SSOT 已补 `cancelled_by_consumer -> cancelled_by_consumer` 并同步两仓，检查恢复绿。
* `protocol/v1/` vendored 副本 + `tests/test_protocol_contract.py`（8 passed）：schema 合法性、fixture 回放、
  `$ref` 解析、`SOURCES.sha256` 哈希一致、未知字段仍被接受（只增不改）、schema 不含业务词（按**词元**匹配，
  `preview` 不会被 `review` 误伤）、封闭错误词表可映射。
* 远程访问正在收口为**唯一可替换端口** `telepost/application/pixivflow_jobs.py`（`submit` / `get`），
  心跳与状态机只依赖该端口、不再自己拼 HTTP 路径；切到 `POST /jobs` 时只动这一个文件。
  **已提交**（TelePost `6f2617f`）。

### 3.1 本轮钉掉的两个坑（协议侧决策，均已写入 `docs/architecture/workflow-protocol.md`）

* **取消语义与落地顺序**：生产者 `TerminalReasonCode` 现有 19 个成员里没有任何取消语义，直接写
  `terminal_reason_code='cancelled_by_consumer'` 会绕过 `OPERATIONAL_REASON_POLICY` 的类型约束并把未映射内部码交给消费者。
  规定顺序：① 生产者补内部 `cancelled_by_consumer`（retryable=false，**不计入** alertable/`business_status=failed`，
  否则每次用户取消都误告警）→ ② SSOT 补 `error-mapping.json` 映射并同步副本 → ③ union 覆盖率检查重新变绿。
* **事件与 Ack/对账复用既有 outbox，不造第二套投递**：`delivery_events`（单调 `id`）+ 唯一写入点 `recordEvent` +
  `noteRefetchOutcome` 已经具备至少一次 + 幂等键（`refetch-outcome:<slotId>:<targetId>`）去重；协议侧只需补
  `$defs/Event` 投影、按 slot + `after=<event_id>` 的游标读取、消费者 `(job_id,last_event_id)` 游标/ack 与未确认计数。
  已记明真实陷阱：目标 `type !== 'httpMultipart'` 时 `noteRefetchOutcome` 直接 return（`NotificationPolicy.ts:276`），
  必须表达为能力声明；回调失败不得改终态，消费者也不得靠「没收到回调」判定失败（这正是「重抓静默」的根因）。

### 3.2 第 9 轮：两侧落地（2026-09-28）

* **TelePost `6f2617f fix(refetch): redesign refetch as persistent job workflow`**（13 文件，+2809/-313，已推送）：
  attempt 即 job（`heartbeat_at`/`heartbeat_count`/`remote_heartbeat_at`/`remote_state_at`/`next_poll_at`/`poll_failures`/
  `terminal_notified_at` 六列 + 只回填 `notify_count>0` 终态行的选择性 backfill）；`record_poll` 只写心跳与退避、
  **绝不**写 `state`/`updated_at`；30 秒 `poll_refetch_jobs` 循环 + 300 秒 `force=True` 复用同一函数；
  `recover_refetch_jobs` 在 `/ready` 之前跑一次；终态通知恰好一次（发送失败落到 `submitter_notifications`，
  `kind='refetch_terminal'`，键 `refetch:<request_id>:terminal`）；`doctor` 新增
  `Refetch: running: N stuck: N failed(last24h): N`（stuck = ACTIVE 且本地心跳超 20 分钟 → CRIT/exit 1；历史行单独计为 legacy，维持 exit 0）；
  预算修正 `REFETCH_HARD_TIMEOUT_MINUTES=90`；`refetch.py` 的兜底提交器改为**委托端口**（不再是第二套 HTTP 客户端）。
* **并发单写修复（同一提交内，经复核接受）**：`apply_transition_on` 的 UPDATE 加了 `WHERE request_id=? AND state=?` 的 CAS，
  `rowcount==0` 时打日志并放弃本次写入——WAL + 每请求新连接下，两个并发迁移曾基于同一旧快照各自通过合法性检查，
  写出 `state='searching'` 却带着旧 `failure_code`/`finished_at` 的半应用行，把看门狗已终结的 attempt「复活」。
  事件行只在 CAS 胜出时写。
* **PixivFlow `21d8982 feat(protocol): introduce the PixivFlow↔TelePost workflow protocol`** +
  `dea50bb test(protocol): validate the produced jobs against the vendored schema`（已推送，HEAD `fc41c03`）：
  既有 trigger server 上的 `GET /capabilities`、`POST /jobs`、`GET /jobs/{id}`、`GET /jobs?idempotency_key=`、`POST /jobs/{id}/cancel`；
  一个核心 `ManualJobAdmission.admit()` + 两个薄适配器（通用 / legacy shim），身份 `job_id=slotId`、`idempotency_key=manual_request_id`
  并加**受保护的部分唯一索引**（历史重复键则降级为普通索引 + 大声告警）；同键不同参数 → 409 `idempotency_conflict`；
  内部原因码 → 协议码是穷尽 `Record`（不映射无法编译）；取消走一个事务 + `stopCancelledWork` 死信在途投递，且不计 alertable。
* **诚实声明**：`/capabilities.features` 不声明 `events`（v1 没有事件端点/ack/callback 投递）；已知未实现项汇总在
  `docs/architecture/workflow-protocol.md` §13——能力声明宁可缺失，也不假装支持。
* **`outcome_version` 1 → 2**（`business_status` 增加 `cancelled`）：全生态检索确认**无任何消费者读取该字段**后才升。
* **边界门收紧**：`telepost/application/refetch.py` 从白名单移出（3 → 2 条），`check_boundary_discipline()` 复跑仍 exit 0。
* **身份空间等价可机验**：`verify-protocol-v1.py --live --legacy-refetch-target <target>` 双向校验「旧端点 ↔ `/jobs` 同一个 `job_id`」，
  负例 `MODE=nolegacy` / `MODE=drifting` 实测会红。
* 独立复核（非子代理自报）：TelePost 目标套件 108 passed / 全量 1139 passed, 1 skipped；PixivFlow `135 suites / 1486 tests` 全过且 `tsc --noEmit` 0；离线验收两条校验路径均 exit 0。

### 3.4 第 12-17 轮：C/D 进入实现（2026-09-28，git 跟踪）

* **C 阶段（消费侧切换）** 由子代理 `33f85071-6b64-42bd-b5aa-587df1ae3833` 实现：已改 `telepost/application/pixivflow_jobs.py`（+476/-23）
  与 `tests/test_refetch.py`；`git status` 证明改动**只**落在端口文件与测试，仓库内除既有白名单（`recovery.py` v2 范围、
  `refetch_state.py` 注释）外无任何新增 `/internal/targets/` 引用——边界纪律保持。
* **D 阶段（事件）** 由子代理 `ba23a275-373e-4e8c-a940-ea3f31b74cae` 实现：已改 `src/storage/DatabaseMigration.ts` 与
  `src/storage/repositories/OutboxRepository.ts`——ack 游标正按 §11.1 落在既有 `delivery_events`/outbox 上（不造第二套队列），
  迁移即真实持久化（否则 `unacked` 就是假的）。
* 两代理仍 `[running]`（写作时文件集已稳定若干轮，符合「写码 → 跑全量校验 → 修到绿」的收尾节奏）；尚未向我回报，未提交。
* 部署侧已无可加的接缝：`--live` 的事件/ack/对账直到「ack 后 unacked 归零 + 重复 ack 幂等」全部由
  `scripts/verify-protocol-v1.py` 编写完成，且 `mock-protocol-server.py` 已实现 events/ack 可先于 D 落地整条验收。

### 3.3 第 10-11 轮：让门自己会跑，把悬空决策钉死（2026-09-28）

* **协议门接进 CI**：`scripts/validate.sh` 现在跑 `python3 scripts/verify-protocol-v1.py`，而 `.github/workflows/validate.yml` 跑
  `./scripts/validate.sh --examples`——本地与 CI 是同一条路径，协议门不再依赖「记得才跑」。实测 `./scripts/validate.sh --examples`
  退出 0、末行 `Validation passed`，其中 `[OK] workflow protocol v1 offline acceptance`；缺某个检出时脚本自身 SKIP，从不假装通过。
  `docs/protocol/README.md` §3.2 记录这条路径（提交 `f434a0f`）。
* **发布机制查清（回答了「发版 2.71.0 / 3.3.0」）**：两仓都由 release-please 管版本（TelePost `telepost/build_info.py:11 RELEASE_VERSION="2.70.1"`，
  PixivFlow `package.json`/`.release-please-manifest.json` 3.2.0；`src/version.ts` 为生成文件、头部写明禁止手改）——**版本号由提交类型驱动**，
  两条必需的 `feat:` 提交已推（`6f2617f`、`21d8982`），因此 minor 升版交给工具，不手改文件。
* **升级顺序与现场验收写成步骤**（`docs/operations/upgrades.md`「升级到协议 v1」+ `refetch-production-verification.md` 2026-09-28 段）：
  **先 PixivFlow 3.3.0、后 TelePost 2.71.0**（新生产者只是**新增** `/jobs` 并把旧端点降级为同一 admission 核心的 shim，先升它不改变任何行为；
  先升消费者会指向尚不存在的 `/jobs`）；回滚开关 `PIXIVFLOW_JOB_TRANSPORT=legacy`；两次发布的 schema 变更都是只增，因此旧镜像可容忍。
  现场必做的回归是**「打断回调目标后触发重抓」**：作业仍须达到带原因的终态、终态通知恰好一次或落到 `submitter_notifications`，
  绝不回到永久静默（诊断顺序：`GET /jobs/{job_id}` → 生产者账本原因 → 待补发通知 → doctor）。
* **两条悬空决策钉进 SSOT**（提交 `afc0db3`）：(a) `callback_url` 由**消费者**在 Task 上给出，事件必须投到消费者**专为协议事件存在**的入口
  （TelePost 侧 `POST /api/bot<N>/v1/jobs/events`，body 为裸 `$defs/Event`，`event_id` 唯一索引去重），**禁止**复用旧业务回调
  `/api/bot<N>/v1/refetch/outcomes`——复用等于把业务负载塞回边界；未给 `callback_url` 时事件仍须能通过 `GET /jobs/{job_id}/events` 对账。
  (b) §7.3 原先宣称 `GET /jobs` 支持 `status` 过滤，与 v1 实现不符（只支持 `idempotency_key`），已改成指向 §13 未实现清单——**文档不得比实现更乐观**。
* **阶段表按事实更新**（§10）：A 已完成、B 已完成、C/D 进行中、E 已绿并接进 CI；§11.1 补 `events`/`ack`/`callback_url` 三行的文件级落点
  （ack 需要一份持久游标迁移，`unacked` 才是真的未确认数；回调复用既有 outbox 去重/重试）。
* **1000 次压力测试当场复核**（不是子代理自报）：`/tmp/tp-venv312/bin/python -m pytest -q --no-cov tests/test_refetch_job_lifecycle.py`
  → `17 passed in 11.92s`；`test_thousand_attempts_all_reach_a_reported_terminal_state`（`tests/test_refetch_job_lifecycle.py:500`）
  在单一有界注入时钟上跑 1000 次 attempt（断言 `elapsed < 30`，无 sleep），四种不变量齐备（无 ACTIVE 残留、每个终态行有非空 `terminal_reason`、
  `refetch_events` 时间线非空、`finished_at - created_at <= 90*60+60`），并断言恰好一次通知、失败发送落到 outbox、以及故障组合真的跑过
  （`set(codes) == {remote_failed, no_alternative, queued_too_long, stalled_no_progress}`）；另 16 个场景覆盖替换 E2E、远端搜索失败、
  无候选、排队超时、停摆无进展、活心跳保护慢搜索、硬超时、看门狗无心跳、从未轮询行、二次点击、回调重投复用、重启恢复×2、通知重试、远端不可读、未知远端状态。
* **子代理两次失败留痕（工程教训）**：阶段 C、D 的首次委派（`bfb6fa74…`、`d8ccca93…`）在基础设施层失败、结束消息为空，
  `git status --porcelain` 证明**两个仓都没留下任何改动**（TelePost 全净，PixivFlow 只有另一会话的 `config/.current-config` 与 `src/version.ts`）——
  重派前先查仓库状态而不是重跑已完成的活；第二次委派 `33f85071…`（C）/`ba23a275…`（D）已启动。

### 4 仍未完成

* **C 阶段（消费侧切换，已完成 ✅）**：`33f85071…` 落地并已测（**a57a7bb** `feat(protocol): switch TelePost refetch…`）。
  端口 `pixivflow_jobs.py`（889 行）切到 `POST /jobs`（`job_type=candidate_search`）+ `GET /jobs?idempotency_key=` +
  `GET /jobs/{id}`，`GET /capabilities` 先协商、失败即 loud 不回退；终态只由协议 `status` 推导（不再读 `labels.terminal`）；
  `PIXIVFLOW_JOB_TRANSPORT`（默认 `protocol`，`legacy`=字节一致的旧路回滚）只在一处读取；修了快照解码器只认 legacy
  camelCase 时间戳、会给活任务误判停摆的 bug（`_pick` 双拼写）。离线 gate exit 0（“内部路径只出现在端口模块 4 处”）；
  全量 `1164 passed, 1 skipped`（基线 1139，增量恰为 +25、零回归）。旧入口已无人调用。cancelled/expired→`failed`、
  recovery `/recover` 留 v2，均为文档化边界。
* **D 阶段（事件）已完成 ✅**：`GET /jobs/{job_id}/events` + `…/events/ack` + `callback_url` 投递（§11.1：复用 `delivery_events` + outbox，
  不造第二套队列）、`labels` 持久化、`GET /jobs` 的 `correlation_id`/`status`/游标过滤、逐 Job 强制 `deadline_ms`。
  只有上述真正可用后，`/capabilities.features` 才允许声明 `events`。
* *** **发版前文案与 README 打磨（用户明确要求，2026-09-28 记入）**：施工阶段不碰用户可见文案；一旦 E 落地、功能收口，
  把「推送、发版、部署」之前的最后一步定为**重写/优化两个仓的 README 与用户可见文案**（协议行为、能力声明、升级说明、
  排障——尤其是「重抓不再永久静默」这件事要以人能读懂的方式写出来），再推送、发版并现场验收。
* **D 阶段已落地并推送**（`c0c6765` `feat(protocol): add job events, ack and callback delivery`，master `fc41c03..c0c6765`）：网关离线 exit 0（内部路径仅端口模块），独立复核 45 测试 + tsc exit 0。D 如实声明三点遗留：`job.progress` 暂不产真实流、`labels` 不回声、`ack_through` 宽松。
* **E 阶段（消费侧事件入口）已完成 ✅**：TelePost 新增 `POST /api/bot<N>/v1/jobs/events`（裸 `$defs/Event`、`event_id` 唯一去重）
  与「按 `unacked=1` 补拉 → ack 回写」的对账循环。回调基址问题在此解决：新增显式配置键 `TELEPOST_API_BASE_URL`（compose 默认
  `http://telepost:8080`，deploy 侧已在 telepost service 注入），`consumer_callback_url()` 拼接 `{base}/api/bot{N}/v1/jobs/events`；
  端口仅在 base 可解析时向 Task 写 `callback_url`，未配置则不写（不臆造旧业务回调地址）。
  落地提交 `0b1b73a` `feat(protocol): consume job events via ingress endpoint and reconcile loop`（a57a7bb..0b1b73a），
  full suite 1175 通过 /1 跳过、`_apply_remote_terminal` 统一终态缝、网关离线 exit 0。
* 发版（TelePost 2.71.0 / PixivFlow 3.3.0，由 release-please 按 `feat:` 提交驱动）、部署与现场验收（含「重抓不再静默」的真实故障复现）。
* **发版已完成 ✅**：PixivFlow **3.4.0**（release-please PR #178，merge `5d231179a9b36ba5199d0c7c5fbf14013d43fb36`，
  GitHub Release 已是 `Latest`）；TelePost **2.71.0**（release-please 在本仓会以
  `There are untagged, merged release PRs outstanding - aborting` 中止，故 2.71.0 由人工按 release-please 形状落
  `3f3d115 chore: release 2.71.0`：`.release-please-manifest.json` + `telepost/build_info.py` 的 `RELEASE_VERSION` + `CHANGELOG.md`，
  两个 release 工作流均 success）。

### 5 协议 v1.1（显式目标选择器）与现场验收（2026-09-28 已执行 ✅）

* **第一次现场验收就打穿了协议 v1 的两个真实缺陷**（不是脚本问题）：
  (a) TelePost 2.71.0 在通用面发 `params:{target_id}`，而协议 v1 要求 `params.query`
  → `HTTP 400 invalid_params "params.query must be a JSON object"`；
  (b) 通用面只能从配置解析目标，本部署有四个满足 `targetServesManualCandidateSearch` 的 target
  （`bot1-illust-botefuku` / `bot1-novel-botefuku` / `bot2-illust-marunomi` / `bot2-novel-marunomi`）
  而只有一个 Pixiv 账号 `default` → 必然 `HTTP 409 ambiguous_target`。
  **现场先回滚**：`PIXIVFLOW_JOB_TRANSPORT='legacy'`（旧 URL 通道不受影响，提交 `f7504e8`），审核群重抓立即恢复。
* **协议 v1.1（只增）**：`params.target_id` 成为对 `schedules[].targetIds` 的**选择器**
  （404 `unknown_target` / 409 `ambiguous_target`，绝不覆盖投递接线与计划身份），`params.query` 变为可选
  （缺省即该 target 自身的检索配置，与旧 refetch 语义等价），`/capabilities.features` 声明 `target_selector`。
  SSOT 落地：`docs/protocol/v1/protocol.schema.json`、新 fixture `task.candidate_search.target_only.json`、
  `docs/architecture/workflow-protocol.md` §3.2 + §11.1 + §2.2（`events_url` 绝对或相对）、
  `scripts/verify-protocol-v1.py`（`--legacy-refetch-target` 的值同时写进 `params.target_id`）。
  生产者侧：`CandidateSearchParams.ts`（`target_id?`，`query?` 改为可选，`tags` 为空即不覆盖目标自身的检索配置）、
  `JobFacade.ts`（`parseTargetSelector`：非空字符串且 ≤200）、`ManualJobAdmission.ts`
  （`resolveTarget` 把 `targetId` 与 `targetSelector` 当同一类选择器，未知/歧义逻辑共用）、`ManualJobService.ts`。
  回归测试用**生产形状**的 `makeMultiTargetConfig()`（2 计划 / 4 target）与 TelePost 的逐字节请求体，断言 202、
  `targetIds == ['bot2-novel-marunomi']`、选择器不进 `paramsJson`、无提示仍 409 且列出四个 id、未知选择器 404、
  未接线 target 500、畸形选择器 400、旧 shim 与 `/jobs` 同一个 `job_id`。PixivFlow `136 suites / 1512 tests` + `tsc` 0；
  业务端全量 `1175 passed, 1 skipped`。
  提交：deploy `f7bdf3f fix(protocol): name the target explicitly in the generic job face`、
  PixivFlow `aecd4cf feat(protocol): let candidate_search name its target`（`feat:` → 3.4.0 次版本）、
  TelePost `ed8fed9 chore(protocol): re-vendor protocol v1.1 (target selector)`（只换 vendored 资产，零运行时改动）。
* **部署顺序（先执行端）**：PixivFlow 3.4.0 pin `5d231179a9b36ba5199d0c7c5fbf14013d43fb36`（提交 `6023801`）
  先上，`/health` 报 `"version":"3.4.0","commit":"5d231179a9b3"`；再把业务端切回协议通道
  （`fly/deploy.telepost.toml` 的 `PIXIVFLOW_JOB_TRANSPORT='protocol'`，提交 `472c198`），现场核对 `T=[protocol]`、`/health` 2.71.0。
* **`--live` 现场验收全绿（退出 0）**：capabilities（含 `target_selector` 与 `events`、预算三项为正）、
  旧 shim → `/jobs` 同一 `job_id`（两个入口一个身份空间，双向）、`POST /jobs` 202、同键重放同一 job、
  异参 409 `idempotency_conflict`、未知 job_type 400、cancel → `cancelled`/`cancelled_by_consumer`、
  `/jobs` 投影无 `refetch*` 字段名、事件流可读/含终态事件/只含本 job/时间升序/ack 生效/重复 ack 幂等/ack 不改状态。
  `doctor --all-bots` = `HEALTHY`，`18 OK / 0 WARN / 0 CRIT`，`Refetch: running: 0 stuck: 0 failed(last24h): 0`。
* **顺手修掉的四个「工具」缺陷**（每一个都会把真缺陷误报成失败，或反过来掩盖真失败）：旧 shim 的 `requestId`
  必须是真 UUID（生产者正则强制）；旧 shim 失败时 `error` 是**字符串**不是对象；`POST /jobs` 的成功体是 `{ job }` 包一层
  （脚本直接在包装体取 `job_id` → `None` → 去探测 `GET /jobs/None` → 404 假失败，把真成功盖住）；
  生产者 `events_url` 是**相对服务基址**的路径（样例 fixture 写成绝对 URL）。
* **现场观测到真实的跨服务投递**：验收作业 `bot1-daily@manual-6a2af823-2ce9-4560-b297-ab0fea3a45b7` 在生产跑完 255 秒
  （`Scheduled download plan finished`，target `#150141037` failed）并 `Refetch outcome enqueued`；
  业务端 bot1 审计确有对应行 `review.refetch_dropped_replacement`（`error_class=refetch_attempt_unknown`、
  `target_id=bot1-illust-botefuku`、`detail.request_id=6a2af823-…`）——即**生产者 → 消费者的投递路径是通的**，
  且「丢弃必留痕」生效（未知 attempt 的替换稿被显式拒绝并记审计，而不是静默消失）。
  验收期间创建的 9 个手动作业已全部收敛或取消（4 个 cancel → `cancelled`，其余终态），
  生产者账本没有留下悬挂的 `pending`。
* **仍未做（诚实声明）**：(a) **没有人工在审核群点一次重抓**——那需要真实审核群操作；本次用 TelePost 的逐字节请求体
  直接打执行端，验的是同一个边界、同一个载荷，但不经过 Telegram 按钮与审核卡。(b) **事件推送通道在生产是关闭的**：
  `TELEPOST_API_BASE_URL` 未配置 → Task 不带 `callback_url`，事件只走已实测可用的「补拉 + ack」路径；
  要启用推送需在业务端配置该键（例如 `https://telesubmit-multi-bot.fly.dev`）并先做一次「回调不可达」回归。
  (c)「打断回调目标后重抓仍恰好通知一次」的回归**未在现场执行**。

### 6 三处现场缺陷（A/B/C）的修复、发版、部署与现场复验（2026-09-28 已执行 ✅）

v1.1 现场验收之后，业务面又暴露三处**真缺陷**（都在执行端/边界，不是脚本问题）。三处全部修复、发版、部署并现场复验。

#### 6.1 A：消费者取消不能打断在跑的计划，且会把该计划卡住

* **现象**：审核群重抓后取消，执行端进程仍在跑（取消只写账本，不碰运行时）；同一计划的下一次准入被判
  `reason:"scheduler_busy"`，作业长时间停在 `queued`（现场 14:38:56 取消 → 14:50:30 仍在跑）。
* **根因**：`cancelConsumerJob()` 只做一次数据库事务（cell 记 `failed` + 终态原因 `cancelled_by_consumer`、
  取消可执行的 outbox、释放租约），**从不通知运行时**；`SchedulerConfig.requestCancel` 全仓唯一调用点是
  `Scheduler.ts:293` 的**超时**分支。
* **修复**（PixivFlow `b59a434 fix(scheduler): let a consumer cancel interrupt the in-flight run`）：`CancelOrigin` 增
  `'consumer'`，`SchedulerCommand` 的 `onCancel` 接到 `runtime.cancelSlot(...)`；取消仍**先写账本**再打断运行；
  `shouldTerminaliseAbortedSlot()` 对 `consumer` 返回 false（取消的终态由账本给出，不让 abort 路径再写一次）；
  `DownloadManager.cancel()` 每次都 abort 在飞请求，`isCancelled` 传进 pipeline 让后续候选立刻停手。
  重复释放租约是 owner-guarded 的 `UPDATE … WHERE lease_owner = @owner`，天然幂等。

#### 6.2 B：`failure_code` 列会写进上游原始文本（HTML/多行）

* **现象**：上游 502/503 的整页 HTML 被当作原因写进 `failure_code`（CODE 列）。
* **两条泄漏路径**：(1) 端口 `_error_code()` 在旧通道把 `error` 字符串**原样**返回（旧 shim 的
  `{"status":"error","error":"requestId must be a UUID"}` 正是这个形状）；(2) 重抓结果入口把上游 `reason` 直接落库。
* **修复（收口到唯一咽喉）**：`telepost/domain/refetch_state.py` 新增 `sanitize_terminal_reason()`（去标签、折叠空白、
  单行、≤200）与 `normalize_failure_code()`（`^[a-z][a-z0-9_]{0,63}$` 之外一律落 `remote_failure`），
  `apply_transition_on()` 统一过一遍；`_error_code()` 用同一正则做纵深防御。生产端按协议码传递：
  `NotificationPolicy.noteRefetchOutcome` 用 `terminalReasonFor(outcome)` + `protocolErrorCodeForTerminalReason()`
  投影出 `reasonCode`（闭集）+ 有界人读 `reason`，`HttpMultipartDelivery` 在 outcome 专用 JSON 体里带 `reason_code`
  （目标 `fields` 映射不参与 outcome，故**无需改生产配置**）。

#### 6.3 C：`/api/v1/refetch/outcomes` 绕过共享通知缝，终态通知会重复

* **现象**：该入口自己 `send_message`，不认领 `terminal_notified_at` 时钟，重投会再通知一次；措辞也与轮询/对账缝不一致。
* **修复**：抽出共享缝 `handlers/review.py:919 apply_refetch_outcome_and_notify(...)`（先 `apply_outcome`，已在终态即返回
  `changed=False` 且**不通知**；否则经 `_refetch_terminal_notify` 认领时钟并附 `任务ID：…`），入口、恢复扫描、
  轮询/对账三条路都走它；措辞收口到 `_refetch_outcome_text()` 一处。

#### 6.4 发版、pin 与部署（顺序：先执行端）

* PixivFlow `b59a434` + `4584f46 fix(delivery): ship a normalized reason code in refetch outcomes` → release-please PR **#179**
  → **v3.4.1** merge `d2e9c9e338bd0e24762ef678bf1fe296c7f7adb9`（GitHub Release `Latest`）。
* TelePost `d8b23a5 fix(refetch): keep the terminal reason code-shaped and claim the one-shot notify`（+450/−90，新增
  `tests/test_refetch_reason_normalization.py` 6 例）→ release-please 仍以 `There are untagged, merged release PRs
  outstanding - aborting` 中止，故 **v2.71.1** 由人工按 release-please 形状落 `ff286e7 chore: release 2.71.1`
  （manifest + `RELEASE_VERSION` + CHANGELOG；tag 与 Release 由 Release 工作流产出）。该工作流第一次跑挂在**既有**的性能
  压力测试（`test_thousand_attempts_all_reach_a_reported_terminal_state`：`stress run took 67.9s (target < 30s)`），
  `gh run rerun --failed` 后通过。
* pin：deploy `97613e9 chore(deploy): pin PixivFlow 3.4.1 and TelePost 2.71.1`
  （`PIXIVFLOW_REF=d2e9c9e…` / `PIXIVFLOW_VERSION=3.4.1`、`TELEPOST_IMAGE=…:2.71.1`）。
* 部署：PixivFlow 先上（`/health` `"version":"3.4.1","commit":"d2e9c9e338bd"`），TelePost 后上
  （`/health` `"version":"2.71.1","commit":"ff286e73b3ca…"`，两个 bot `review_queue.pending 0`）。
* 本地闸门：PixivFlow `136 suites / 1514 tests` + `tsc` 0；TelePost 全量 `1181 passed, 1 skipped`。

#### 6.5 现场复验结果（真实生产，2026-09-28）

* **B + C 已现场证明 ✅**（在容器内用生产 bot1 进程 + 一次性 `tp_` 服务令牌，走真实 `POST /api/v1/refetch/outcomes`）：
  以 220 字符多行 nginx 502 HTML 作 `reason`、`reason_code="remote_error"` 投一次 → `failure_code = "remote_error"`
  （code 形状）、`terminal_reason` 单行/无标记/≤200 且**不含**原始 HTML、时钟**恰好认领一次**（`terminal_notified_at`）；
  **同一请求体重投** → `{"attempt_state":"failed","replayed":true}`，时钟与状态都不变（**不重复通知**）；
  **换一个判决重投** → 终态 attempt 直接拒绝（`拒绝非法的重抓状态迁移: … 'failed' → 'searching'`）；
  审计行 `review.refetch_failed` 同时带 `reason_code` 与原始 `reason`。
* **A 已现场证明 ✅**（两半在不同运行里各自证明）：(1) 对在跑作业 `POST /jobs/{id}/cancel`，日志
  `.474Z Download cancellation requested` → `.484Z Scheduled job was cancelled`，**约 10ms 内**真打断；
  (2) 取消后**立刻**对**同一个 target/计划**再发一个 `POST /jobs` → `HTTP 202` 准入成功（**这正是原症状的回归测试**，
  准入没被卡住），且被取消作业的终态是 `cancelled`（1 秒收敛，对比计划的 1800 秒超时）。
* **`--live` 协议验收**：除最后一项「作业在 240s 内进入终态」外**全部通过**（capabilities/协议版本、旧 shim 与
  `/jobs` 同一 `job_id`、202、同键重放、异参 409、未知 job_type 400、20 个内部原因码全部映射）。
  该项失败是**工具预算**问题：同一计划 `bot1-daily` 上被连发两个手动作业，计划串行执行，前一个跑了 117 秒
  （上游 Pixiv 当时持续返回 502/503），240 秒预算被前一个吃掉。

#### 6.6 复验中新发现、**尚未修复**的两处（OPEN）

* **D：消费者取消的判决会被随后的「按目标失败」写入覆盖。** 现场：`POST /jobs/{id}/cancel` 返回 `status=cancelled` +
  `error.code=cancelled_by_consumer`；10 秒后 `GET /jobs/{id}` 变成 `status=failed` + `error.code=internal_error`
  （`updated_at` 都没变），而事件流里 `job.cancelled` 的**内嵌快照**已经写着 `failed/internal_error`。机制：取消写账本后
  运行被 abort，落到正常的「按目标结果」收尾，`SlotCoordinator` 无条件 `setCellTerminalReason(...)` 又写了一遍
  （`shouldTerminaliseAbortedSlot` 只管 abort 路径，管不到这里）；并且**为一个被取消的作业发出了 `disposition: failed`
  的 refetch outcome**。业务面影响有限（TelePost 把 `cancelled`/`expired` 一并折成 `failed`，用户仍看到「重抓失败」），
  但协议自洽性被破坏（同一作业两个终态、`internal_error` 归因错误、多一条业务结果信号）。
  **未修原因**：修它需要先定一个跨仓设计问题——「操作员取消」是否要成为消费者可见的独立结果（要改 TelePost 的投影与文案），
  不是执行端单方面能定的。
* **E：通用面提交的作业只在下一次计划 tick 时才被准入。** 现场日志
  `Cannot recover slot: its schedule could not be admitted {"reason":"scheduler_busy"}`，随后由
  `Starting scheduled Pixiv download job (execution #549/#550)` 这类**周期触发**才把它 `Slot resumed`。
  作业是耐久的（有 `deadline_at`，最终会被 `queued_timeout_ms=1800000` 收口），生产路径（TelePost 心跳重触发）
  下不明显；但一个**没有消费者再触发**的第三方 `POST /jobs` 可能长时间停在 `queued`。属既有行为（3.4.0 相同），
  记为观测，不是本轮回归。

#### 6.7 诚实边界

* 本次仍未**人工在审核群点一次重抓**（Telegram 按钮/审核卡）；复验走的是与生产逐字节相同的载荷与真实处理器。
* 上游 Pixiv 在整个复验窗口持续对生产下载器返回 502/503，因此**没有**走到「成功终态 + 替换稿入库」那一段
  （该段在 3.4.0 验收时以 `review.refetch_dropped_replacement` 观测过投递通路是通的）。
* 事件推送通道在生产仍关闭（`TELEPOST_API_BASE_URL` 未配置），只走「补拉 + ack」。
* 复验产生的业务端测试数据已清理（3 条 `pending_reviews` + 2 条 `refetch_attempts` 删除、服务令牌已吊销），
  执行端作业均已终态。

# 2026-09-28 内容链路稳定化：四个长期问题的收口

Status:

* #2 主题 Tag 联想（生产配置）—— `VERIFIED`（仓库改好 + 两层校验通过 + **卷上运行副本已就地应用**：
  sha256 回读一致、调度器热重载到 generation 2；见 §1。本仓库 PR #169 已合并到 `main`
  （squash `39b0c56`）——**仓库改好 ≠ 线上生效**，线上生效靠的就是 §1 那次就地应用）
* #4 封面探测失败策略 —— `VERIFIED`（PR redtidev1918/PixivFlow#181 已合并到 `master`（squash `efb6762`）；
  release PR #180 合并（merge `4db0bf2`）→ tag `v3.4.2` + Release `v3.4.2`(Latest) + npm `pixivflow@3.4.2`
  + ghcr `pixivflow:3.4.2`；执行端已换到该 pin，运行期核对（启动行 / `/health` / `verify-images.sh`）通过——
  见文末「2026-09-28 发布 3.4.2 / 2.71.2」§1）
* #1 重抓卡死 / #3 卡片不更新 —— `VERIFIED`（生产库只读取证 + 运行镜像代码 + release 时间线三者互证：
  历史真问题，当前 2.71.1 已修）
* 遮罩 (b)「默认不糊 + 遮罩由审核员发布前决定」—— `VERIFIED`
  （PR #242（squash `05c7128`）与 #243（squash `ed10c1a`）已进 `main`，2.71.2 已发布并部署：
  审核群预览改为**恒不遮罩**，频道发布仍取存储行值——见文末「2026-09-28 发布 3.4.2 / 2.71.2」§2）

## 1 #2 主题 Tag 联想：生产 target 显式开 `relatedTags: when_seed_insufficient`

* 背景见上方「2026-09-27 四个现场 Bug 修复上线」§2：3.0.3 引入 `topicDiscovery.relatedTags`，
  三种取值 `always`（默认 = 历史行为）/ `when_seed_insufficient` / `never`。**代码默认保持 `always`
  是硬约束**（`src/__tests__/topic/TopicFeature.test.ts:247-278` 钉住纯热度排序语义），所以
  「`西瓜肚` 目标被同级高权重相关 Tag（`丸吞`）占满 slot」在代码侧修不了，只能由**生产配置**显式选择。
  生产事实：`bot1-*` 的主题是 `ボテ腹`、`bot2-*` 的主题是 `丸呑み`，四个 target 原先都只写了
  `topicDiscovery.includeR18`，即全部落在默认 `always` 平铺召回上。
* 本轮改动（本仓库）：`pixivflow/config/production.json` 四个 target
  （`bot1-illust-botefuku` / `bot1-novel-botefuku` / `bot2-illust-marunomi` / `bot2-novel-marunomi`）
  的 `topicDiscovery` 各加一行 `"relatedTags": "when_seed_insufficient"`（`:165`/`:211`/`:250`/`:296`）。
  语义 = **先只搜主题 Tag，填不满 `limit` 才扩展相关 Tag**，且带主题 Tag 的作品排在热度之前
  （`src/topic/TopicPipeline.ts:154`/`:219`/`:257`/`:278`；日志
  `[TopicRecall] mode=… seedAccepted=… relatedTags=…` 可确认实际搜过哪些 Tag）。
* 校验：`./scripts/validate.sh` → `[OK] pixivflow/config/production.json JSON`（仅剩 `.env` /
  `data/pixivflow/config.json` 两个未 bootstrap 的既有 FAIL，与本改动无关）；PixivFlow 自己的
  `node dist/index.js config validate pixivflow/config/production.json` → `✓ JSON format is valid` /
  `✓ Download targets configured`（唯一 warning 是本机没配 refresh token，预期）。
* sha256：`e63136af4057c5c71e94be07d4d012df22f5869314923aa6c6871992fc4ecdcf`（10873 B，旧 = 上方 spoiler
  那次修完的同一份字节）→ `b09f8512dad5672a078f5ea41099c52083e0b447709d4e66df825d19877b33a2`（11101 B，新，
  净增 4 行）。
* **卷是权威，本轮已就地应用（`VERIFIED`）**：`docker/pixivflow-scheduler-entrypoint.sh` 只在卷配置缺失/
  为空时才把镜像默认值拷过去（同上文 2229-2234），所以「仓库改好」≠「线上生效」——线上生效必须改卷。
  本轮执行（2026-09-27T19:4xZ）：`fly machine start 83d1650bd23948` → `fly sftp put` 把工作树文件传为
  `/app/data/production.json.new` → 容器内 Node 断言式校验（递归深比较，只允许
  `/targets/<n>/topicDiscovery/relatedTags` 这一处差异，`DIFF_COUNT 4` / `ALL_DIFFS_ALLOWED true`）
  → 备份 `/app/data/production.json.bak-relatedtags`（10873 B）→ `os.replace` 原子替换 → 回读
  `b09f8512dad5672a078f5ea41099c52083e0b447709d4e66df825d19877b33a2`（11101 B，与仓库工作树一致）
  → 运行中的调度器日志出现 `Scheduler configuration snapshot activated {"generation":2,…}`
  （启动时是 generation 1）即热重载已生效 → `fly machine stop` 并清理 `.new` 与 `/tmp/apply-config.js`。
  两个可复用的操作要点：(1) **不能用 `JSON.stringify(parsed) === text` 当门** —— 这份文件不是
  `JSON.stringify(j, null, 2)` 的规范输出，工作树与 HEAD 都会判 false；门必须是「逐条列出差异且全部落在
  白名单内」。(2) 机器起来后日志是
  `External scheduler mode: internal cron disabled, awaiting authenticated schedule triggers`，
  即起机器本身不会触发下载（cron 是 `0 10 * * *` / `10 10 * * *`，Asia/Shanghai）。
* **纠错（此前判断有误，已就地改写）**：前文记的「要动卷必须先 resume app」不成立。`pixivflow-scheduler`
  的 app 状态仍是 **suspended**（以 `fly apps list --json` 的 `Status` 字段为准；`fly apps list` 表格里的
  suspended/deployed 列与它不一致，只是展示差异），但机器 `83d1650bd23948` 照旧能 `fly machine start`。
  更关键的是 **`auto_start_machines = true` 让外部时钟能把机器唤醒**：`GET
  https://pixivflow-scheduler.fly.dev/health` → 200
  `{"status":"ok","service":"pixivflow-scheduler-trigger","version":"3.4.1","commit":"d2e9c9e338bd"}`，
  机器随该请求由 `stopped` 变 `started`（`control-plane/wrangler.toml:34` 的
  `PIXIVFLOW_TRIGGER_BASE_URL` 正是这个域名；`GET /` → 404）。∴ **app 挂起不是流水线的总开关**：
  三级时钟（cron-job.org 主 / Cloudflare Worker `pixivflow-control-plane` +2min 次 / GitHub
  `schedule-watchdog.yml` `35 2 * * *` 兜底）仍能在 10:00 CST 拉起机器并执行当日投稿。
* 次生通道（诚实边界）：`candidate_inventory` 待发池是用**同一次 topic 扫描**里未投递的作品填充的
  （`src/download/handlers/IllustrationTargetHandler.ts:290` / `NovelTargetHandler.ts:288`，
  `src/download/inventory.ts:38 recordInventoryCandidates`），`always` 时代记下的 `丸吞` 行在
  `maxAgeDays: 30` 内仍可能被 `tryInventoryFallback`（`IllustrationTargetHandler.ts:345-350` / `:382-431`）
  补位发出。改配置只让**新增**扫描不再收这类行；要立刻清干净需在卷上处理
  `candidate_inventory` 里对应 `topic`/`target_id` 的 `pending` 行（同样需要起机器）。

## 2 #4 Pixiv 生成封面：`probe_failed` 由「一律保留」改为策略化（默认 `skip`）

* 现场定性：3.0.3 `182694d` 已用「精确 640x900 画布」把 Pixiv 生成设计封面判成 `pixiv_generated` 并
  **无条件跳过**（见上文 2437-2445），但**探测失败（网络 / 认证 / 限流）走的是 fail-open**：
  `src/download/NovelDownloader.ts:461-469` 的 catch 直接 `return normalized`，原样保留封面 ——
  于是生成封面照样进审核群与频道，是这条修复的残余泄漏。
* 改动（PixivFlow，PR #181，squash 合并为 `efb6762`；**已合并、未发布**）：
  `src/domain/media/NovelCoverPolicy.ts` 新增 `probeFailed: 'skip' | 'keep'` 与
  `export type NovelCoverOutcome = NovelCoverType | 'probe_failed'`；`coverDeliveryDecision()` 把
  `probe_failed` 当策略处理（`classifyNovelCover` 仍只返回三种分类，签名未动）；
  `DEFAULT_NOVEL_COVER_POLICY = { unknownCover: 'skip', probeFailed: 'skip' }`。
  `NovelDownloader.ts:461-494` 的 catch 内问策略：默认 `skip` → 记 `coverType: 'probe_failed'` +
  `policy` 的 warn 后 `return null`；`keep` → 保留旧行为（warn 文案标明 `novelCover.probeFailed=keep`）。
  配置面 `src/config/types.ts:990-1003`、`src/config/validation.ts:733-741`、
  `src/download/DownloadManager.ts:167`（键缺失即 `skip`）。文档 `docs/ARCHITECTURE.md` /
  `docs/CONFIG.md` 里「探测失败一律保留封面」的旧口径已一并改掉。
* 影响面：`textResponse.coverUrl` 全仓只有一个读者（`NovelDownloader.ts:247`），它的取值同时喂
  `novelCoverAsset()` 与 manifest `cover_url`，所以返回 `null` 会让 `:novelcover` asset 与
  `cover_url` 一起消失。
* 验证：`npx jest src/__tests__/download src/__tests__/domain src/__tests__/config --silent` →
  24 suites / 271 tests；全量 `npx jest --silent --runInBand` → **137 suites / 1524 tests 全通过**；
  `npx tsc --noEmit` exit 0；新增 `src/__tests__/config/novelCover.test.ts` 与
  `DownloadManager.test.ts:471-498` 的接线覆盖，`NovelDownloader.test.ts:429` 的旧 fail-open 测试
  已翻面为「默认不保留」，并新增 `probeFailed: 'keep'` 用例。
* 取舍（可回滚）：默认 `skip` = 宁可这一本没封面，也不把生成封面发出去；若更看重
  「真封面不能被瞬时故障吃掉」，把 `download.novelCover.probeFailed` 设为 `keep` 即恢复旧行为。
  仍可能发出生成封面的只剩：显式 opt-in（`probeFailed: keep` / `unknownCover: keep` 配上读不出头的格式），
  以及 Pixiv 换成非 640x900 画布导致分类器漏判（那会落 `custom`）。

## 3 #1 重抓卡死 + #3 卡片不更新：真机取证 =「历史上真的存在，2.71.1 已修」

* 取证对象是**生产库**（`telesubmit-multi-bot` 卷上 bot1 的 `submissions.db`，只读探针，未写任何一行）。
* 现场那条就是用户报的 #135：`refetch_attempts` id 9 = `chain-135`，`state='cancelled'`，
  `failure_code=''`、`terminal_reason=''`、`notify_count=0`、`last_progress_notified_at` 与
  `terminal_notified_at` **都是 NULL** —— attempt 建了、跑了 ≈140 秒（`created 1790481174.57` →
  `finished 1790481318.92`）、然后**一声不响**地终止。`refetch_events` 里 chain-135 **一行都没有**；
  `submitter_notifications` 只有 `manager_accepted`，没有任何 `refetch_terminal` 行（连排队都没排）。
* 时间线（`audit_events`；注意该表列名是 `ts`，没有 `created_at`）：09-27 02:05:30 审核 135 创建
  （actor `service:api_token:2`，pixiv_id `150123915`，slot `bot1-daily@2026-09-27T1000`）→
  03:52:54 `review.refetch_requested`（actor `telegram_user:5073758941`，request `c78dd065-…`）→
  03:52:59 `review.refetch_remote_accepted` → **03:54:40 `review.rejected`（同一用户自己驳回）** →
  03:55:18 attempt 静默 `cancelled`。审核 136 于 04:15:39 被同一用户驳回。
* 决定性对照：TelePost 的 tag 时间线 与 `git log -S'_refetch_terminal_notify'` —— 后者只命中
  `6f2617f`（2026-09-27 08:06Z，"fix(refetch): redesign refetch as persistent job workflow"），
  且 `git tag --contains 6f2617f` 只有 **v2.71.0 / v2.71.1**；单一咽喉 `source_review_resolved`
  出自 `69849e2`（05:41Z）。**#135 发生在 03:52–03:55Z，早于 v2.68.1（05:02Z）与 v2.71.0（11:11Z）**，
  当时线上 ≤ v2.68.0：既没有「点击就刷新卡片」（`60616f8`，首个带它的版本是 2.68.1），
  也**根本不存在**终态通知函数。attempt 9 的 `terminal_reason` 为空，同样符合 2.69.0 之前的代码
  （写 `terminal_reason` 的状态机出自 `69849e2`）。
* ⇒ 结论：**#1/#3 是真问题，但不是当前线上问题**；#135 那行是修复前版本留下的历史行。当前运行镜像
  `2.71.1`（`_release_version.py`：`RELEASE_VERSION 2.71.1` / `RELEASE_COMMIT ff286e73…`；
  pin `fly/deploy.telepost.toml:247`）里：
  * `handlers/review.py:1179-1199 _terminate()` —— CANCELLED / FAILED / TIMEOUT 三条终态在
    `moved` 后都会调 `_refetch_terminal_notify(...)`；`:1201-1209` 的取消分支文案正是
    「🔄 审核 #N 的重抓已取消：该审核已被处理（驳回/通过/过期），不会产生替换稿，当前稿件保持不变。」
  * `telepost/storage/sqlite/refetch.py:200-279 apply_transition_on()` 是**唯一写入者**
    （CAS 在它读到的 state 上 + `fsm.assert_transition` 拒绝非法迁移）；
    `:675-722 apply_outcome()` 在源审核非 `pending` 时收敛到 CANCELLED / `source_review_resolved`；
    `:609-673 commit_replacement()` 只在 supersede 的 CAS 恰好命中 1 行时才落 REPLACED。
  * `handlers/review.py:923-962 apply_refetch_outcome_and_notify()` 是轮询、事件对账、重启补扫、
    `POST /api/v1/refetch/outcomes` 四条入口**共用**的唯一终态咽喉（`changed == False` 时不发），
    `:965-981 _refetch_outcome_text()` 是唯一文案映射（`no_alternative` / `obsolete` / `failed` / 兜底）。
* 线上医生同证：`python3 -m telepost.observability.cli doctor --all-bots` → **HEALTHY 18/18**，
  两个 bot `refetch_stuck` 无活跃 attempt、`终态通知待补发 0`；24 小时内只有 2 次重抓失败，
  且都是上游 Pixiv 502（`notify_count 3` / `1`，`terminal_notified_at` 都已写）。
* 附带取证（回应「#1 的**成功**终态从未真机走通」）：**成功终态在 2026-09-17 真机走过一次**。
  `refetch_attempts` id 8（`chain-110`）：`state='replaced'`、`result_candidate_id 149732000`、
  `created 1789610816.63`（09-17 02:06:56）→ `finished 1789610923.21`（02:08:43）；源审核 110
  （pixiv_id 149727403）被置 `superseded`；替换稿作为 **review 112**
  （`supersedes_review_id=110`、`generation=1`、pixiv_id `149732000`、`refetch_request_id c255e1c3-…`）
  进入审核群，并于 02:10:42 被**人工驳回** —— 「重抓成功 → 替换稿入库 → 人审替换稿」三段都真实发生过
  （旧代码路径）。该行 `notify_count=0` / `terminal_notified_at NULL` 属旧代码，不是 2.71.1 行为。
  2.71.1 上的一次成功终态见 `refetch_events` chain-138（`requested` → `replaced`，actor `service:refetch`），
  由验收循环驱动，同样落了替换稿行（`replaced_by 150168228`）。
* 诚实边界：本次**没有人在审核群里真点一次**重抓按钮（当时那几条投稿已过期），结论建立在
  「生产库只读取证 + 运行镜像里的代码 + tag/release 时间线」三者互证上，而不是点击复现。

## 4 遮罩 (b)：审核群预览恒不遮罩，遮罩是发布前的审核决定

* 现场口径偏差：2026-09-27 那次修的是**默认值**（生产 target `fields.spoiler: false`，见上文
  「2026-09-27 投稿遮罩策略：默认不遮罩」），但**初始值仍沿用投稿者** —— TelePost 把
  `command.spoiler` 直接透传给审核群预览的 staging（`telepost/application/review_queue.py:402` /
  `:408`，原为 `spoiler=command.spoiler`）。于是投稿者在私聊按过「🔞 剧透」、或 API 调用方传
  `spoiler: true` 时，**审核群看到的预览就已经被遮罩**；而 Telegram 无法对已发送的消息反向解除遮罩，
  审核员恰好看不到自己要审的内容。
* 改动（PR redtidev1918/TelePost#242，squash 合并为 `05c7128`，落在 `fix/incident-140-data-class` 之上、
  该分支本身仍未进 `main`）：`review_queue.py` 两处 staging
  调用改为 `spoiler=False`，并加注释说明「遮罩是审核员发布前的频道决策，不是可继承的投稿设置」；
  `pending_reviews.spoiler` 仍写 `command.spoiler`（`:548`），存储语义不变。
* 结果语义（两个界面从此分开）：
  * **审核群预览**：恒不加遮罩 —— 审核员必须看见被审媒体，且遮罩不可事后补/撤。
  * **频道发布**：仍由存储行决定 —— `services/review_service.py:833`
    `current_spoiler = bool(row["spoiler"]) if spoiler is None else bool(spoiler)`；
    审核员可在发布前用审核卡「🔇 遮罩」按钮改写该行（`handlers/review.py:1586 toggle_review_spoiler`
    → `services/review_service.py:716 toggle_spoiler`，只翻存储标志、不重新 staging）。
* 测试（TelePost，本机）：新增
  `tests/test_review.py::test_review_group_preview_never_inherits_submitter_mask`，断言三件事 ——
  媒体组每项 `has_spoiler is False` 且不降级为「单条遮罩发送」、存储行仍 `spoiler=1`、
  未改写时发布取 `spoiler=True`。全量 `.venv/bin/python -m pytest -q --maxfail=0 --no-cov`：
  修复前 **1178 passed / 2 skipped**（64.55s）→ 修复后 **1179 passed / 2 skipped**（61.42s），
  +1 = 新用例。
* 诚实边界：这是**代码级**收口，PR 已合并，但**未发布 / 未上线**；线上当前仍把投稿者的值透传给审核群预览。
  设计上保留的残余：投稿者声明 `spoiler: true` 而审核员直接点通过、不碰遮罩按钮时，频道发布仍会遮罩 ——
  「遮罩由审核员发布前决定」体现在审核员**能够**在发布前改写，而不是系统强制改写。
* 随之失效的旧口径（已在上文就地改正）：`docs/CONTRACT.md:56` 与
  `docs/concepts/delivery.md:50` 曾写「同一份 `spoiler` 值同时决定审核群预览与频道发布的遮罩」。

## 5 新发现（阻断级，不在本轮四项范围内）：手动重抓的投递因 `refetch_request_id` 不是 UUID 被永久拒绝

Status: FAIL（线上可复现；未修复）

* 现场证据（`/app/data/pixiv-downloader.log`，只读取证）：execution #556 槽位
  `bot1-daily@manual-1e22b55cb33e47289f30c62e8ee1e11f`（`trigger: "manual"`，
  `occurrence_at 2026-09-27T16:16:17.870Z`，16:25:15 结束）终态 `status:"failed"` /
  `business_status:"failed"` / `alertable:true` / `duration_ms 0`，`error` =
  `permanent delivery failure: delivery endpoint HTTP 400:
  {"ok":false,"error":{"code":"invalid_refetch_provenance","message":"refetch_request_id 必须是 UUID"}}`。
  同一条终态里 `candidate_report {fetched:182, selected:16, rejected:166, reasons:[ai_filtered 147,
  metadata_filtered 11, duplicate 8]}` —— 即**候选已经选出来了，替换件却永远投不出去**；用户侧看到的现象
  就是卡片一直不更新（与 #1/#3 的表面症状同源，但这是另一条互不相干的原因）。
* 根因（跨仓契约错配）：协议定义 `idempotency_key` 是**不透明字符串**
  （`telepost/application/pixivflow_jobs.py:8`），而 PixivFlow 把它原样写进投递字段
  `refetch_request_id`：`src/download/handlers/deliveryContext.ts:34`
  `refetchRequestId: slotContext?.manualRequestId ?? ''` ← `src/scheduler/ManualJobAdmission.ts:409`
  `manualRequestId: key`（`key` = `request.idempotencyKey`，`:128` 用它派生槽位
  `${plan.id}@manual-${key.toLowerCase()}`）→ 字段名/占位符见 `ManualJobAdmission.ts:42-43`
  → `src/delivery/HttpMultipartDelivery.ts:478`。而 TelePost 的投稿端点要求该字段是**规范带连字符的
  小写 UUID**：`utils/api_server.py:706-715 _invalid_refetch_request_id`（`str(uuid.UUID(value)) == value`，
  空值除外），违反即 400 `invalid_refetch_provenance`（`:1569-1572` 与 `:1748-1750` 两处，
  由 `TelePost/tests/test_refetch.py:729`、`:739` 钉住）。该校验不是洁癖：存下的值之后必须能匹配重抓
  attempt 自己的 `request_id`，否则 `commit_replacement` 找不到源 review，替换件无法 supersede。
* 旁证：TelePost 自己生成的 key 也过不了自己的校验 —— `telepost/application/refetch.py:158`
  `key = callback_key or f"api:{review_id}:{uuid.uuid4().hex}"`（带前缀 + 无连字符 hex）。
* 线上旁证（只读查询 `bot1/submissions.db`）：`refetch_attempts` 最近 6 条的 `request_id` **全部是带连字符
  的规范 UUID**（`b36c3a6c-3282-4182-b7d5-6d89f87d8b5e` / `e0f1edb9-c26f-4928-bc70-73aaf1827cf3` /
  `c78dd065-60aa-4e7a-bba5-38275019217c` / `c255e1c3-…` / `ad4c7df1-…` / `b7e886d1-…`，callback_key 形如
  `cb:137:accta59bdbf417694997bcb3`），而 TelePost 的两处提交点正是把这个 `request_id` 当 `idempotency_key`
  送出去（`telepost/application/refetch.py:433`、`handlers/review.py:1637` —— `client.submit("refetch",
  request_id, …)`，端口签名见 `telepost/application/pixivflow_jobs.py:343-353`）。
  ∴ **审核卡「重抓」按钮这条现代路径尚未被证明会失败**；16:16 那条裸 hex 槽位不与任何一个 attempt id 对应。
* 身份空间分叉（根因的形状）：同一个身份，PixivFlow **两条相邻路由的校验强度不同** ——
  `POST /internal/targets/:targetId/refetch` 直接把它当不透明串透传
  （`src/scheduler/ManualRefetchAdapter.ts:24-31` `idempotencyKey: requestId`，`ManualJobAdmission` 不校验形状），
  而紧挨着的 `POST /internal/targets/:targetId/recover` 用严格正则要求 UUID，否则 400
  `requestId must be a UUID`（`src/scheduler/ScheduleTriggerServer.ts:533`）。
* 尚未定位（诚实边界）：那条裸 32 位 hex（`1e22b55cb33e47289f30c62e8ee1e11f`，既无 `api:<review_id>:`
  前缀也无连字符）的**上游生成者仍未坐实**；已排除 TelePost 的 job port（它送的是虚线 UUID，见上一条），
  剩余候选是 legacy `/refetch` 路由那个未校验的 `requestId`，或某个操作方/客户端自带的键。
* 影响（按已证明的范围）：**任何**手动准入只要键不是规范 UUID，它的投递就会被永久拒绝（400 不可重试），
  且失败发生在候选产出**之后** —— 现场已有一条（#556）。正常 cron occurrence 不走 manual 准入、不带该字段，
  不受影响。
* 修复方向（两处都很便宜，推荐同时做）：(1) PixivFlow 的 refetch 提交路由按 `recover` 路由已有的方式校验/
  规范化 `requestId`，形状不对就**在准入时** 400 说清楚，而不是落一个注定在投递端失败的键；(2) 投递模板在键不是
  规范 UUID 时**省略** `refetch_request_id` —— 手工触发的一次日常运行本来就没有可关联的重抓，空值才是真话，
  这样投递能正常完成。TelePost 侧那条校验保持不动：它是「存储值必须能匹配自身 attempt UUID」的不变量。

---

# 2026-09-28 发布 3.4.2 / 2.71.2 并把两个平面换到新 pin

Status: `VERIFIED`（发布产物、pin 文件、部署结果与运行期自报四者互证；证据逐条见下）

## 1 PixivFlow 3.4.2（执行端）

* 触发链：PR #180 `chore(master): release 3.4.2` 合并（**merge commit** `4db0bf21a7853e478f699d68f3458acda8270900`，
  2026-09-27T20:19:10Z）→ push `master` 触发 Release run `36347586000`：`release-please` / `build-plan` /
  `build (ubuntu)` / `finalize` 全部 success。
* 产物：tag `v3.4.2`（annotated 对象 `61c8bda39e668f6b0aed1d66b7196ff1fb407010`）指向
  `4db0bf21a7853e478f699d68f3458acda8270900`；GitHub Release `v3.4.2` 于 2026-09-27T20:31:21Z 发布（Latest，
  正文由流水线生成，post-release 的 deploy-docs / refresh-download-page 均 success）；
  npm `pixivflow@3.4.2`（`dist-tags.latest = 3.4.2`）；ghcr `pixivflow:3.4.2`（匿名 manifest 200）。
* 内容（`d2e9c9e..4db0bf2`）：`efb6762`（#181 封面探测失败 → 策略 `download.novelCover.probeFailed`，默认 `skip`）
  + `80e2b02`（consumer cancel 的终态不再被覆盖：`SlotCoordinator.applyOutcome` 把 `CANCELLED_BY_CONSUMER`
  当终态、`NotificationPolicy.noteRefetchOutcome` 不再发 `disposition:failed`，含 finding-D 回归测试）
  + `0c07a11` 发版提交 + `4db0bf2` 合并提交。
* pin：`fly/deploy.pixivflow.toml` 的 `PIXIVFLOW_REF = '4db0bf21a7853e478f699d68f3458acda8270900'`、
  `PIXIVFLOW_VERSION = '3.4.2'`。**两行必须同时改**：镜像里的 `PIXIVFLOW_REVISION=${PIXIVFLOW_VERSION}+${PIXIVFLOW_REF}`
  是 build-arg 字面量，而 `./deploy pf <40位提交>` 只写 `PIXIVFLOW_REF`（只有参数是 x.y.z tag 时才顺带写 VERSION）。
* 部署与运行期核对：`./deploy deploy --platform fly --plane pixivflow` → 机器 `83d1650bd23948` 换到镜像
  `registry.fly.io/pixivflow-scheduler:deployment-01M3J90G5HSBMZY2ER9P51DQB2`（上一版
  `deployment-01M3HSAJE4VQZ2B2PZZ8N7MTE5`），收尾处于期望的 `stopped`；唤醒后启动行
  `PIXIVFLOW_REVISION=3.4.2+4db0bf21a7853e478f699d68f3458acda8270900`，
  `GET /health` → `{"status":"ok","service":"pixivflow-scheduler-trigger","version":"3.4.2","commit":"4db0bf21a785"}`，
  `scripts/verify-images.sh` 的执行端项 `[OK]`。该次启动的 `Scheduler configuration snapshot activated`
  报 `generation: 1`（新进程从 1 起算；9-27 那次 `generation: 2` 是卷上配置编辑后的热重载，两者不是一回事）。

## 2 TelePost 2.71.2（业务端）

* **为什么这次又得手工落版本提交**：push `main` 触发的 Release run `36347783067` 里 `release_please` 成功，
  但 `build` 与 `finalize` 都是 **skipped** —— releasegraph 的 provider 预对账报 `TAG_CONFLICT`
  （`v2.71.1` tag 指向 `ff286e73…`，期望 `d22a82ae071fc0498d4114a30f044b77ea3ebe1f`；`v2.64.0` 同样）
  且 `Repair: unsafe`，release-please 自身则以 `There are untagged, merged release PRs outstanding - aborting`
  中止（#240 仍挂 `autorelease: pending`）。按本文件「运维教训：本仓的发版提交可能得自己落」的先例
  手工落 `7dae61f chore: release 2.71.2`（`.release-please-manifest.json` + `CHANGELOG.md` +
  `telepost/build_info.py`，3 files +17/−2；**tag 出现前 revert 即可回滚**）。
* 触发 run `36348134912`：`release-please` / `build-plan` / windows+ubuntu+macos `build` / `finalize` 全部 success；
  tag `v2.71.2`（对象 `1170bab8ffaf6ddb8628b4f4f4d6cb27a2a06369`）→
  `7dae61fbaa8ab02b983424b11da2bd7699093b61`；GitHub Release `v2.71.2` 于 2026-09-27T20:37:03Z 发布（Latest）；
  ghcr `telepost:2.71.2`（匿名 manifest 200）。
* pin 与部署：`TELEPOST_IMAGE = 'ghcr.io/redtidev1918/telepost:2.71.2'`；
  `./deploy deploy --platform fly --plane telepost` → 机器 `683032ec6617e8` 换到 Fly release 237
  `registry.fly.io/telesubmit-multi-bot:deployment-01M3J9G18GJ58H4C0X4Q9GCXD1`（上一版 release 236 =
  `deployment-01M3HSFJTS9WBQY27MVJ8V3DG3`），smoke 与部署后健康检查通过；
  `GET https://telesubmit-multi-bot.fly.dev/health` → `version 2.71.2`、
  `commit 7dae61fbaa8ab02b983424b11da2bd7699093b61`。
* 全量校验：`scripts/verify-images.sh` 四项 `[OK]`；`scripts/verify-production.sh` **退出码 0**（7 节里
  只有缺凭据的 Telegram webhook 归属与 Cloudflare 时钟 `SKIP`，其余 `[OK]`，含「未授权的触发被拒（HTTP 401）」
  与「执行端机器 restart.policy = no」）。

## 3 本轮新查清的两件事（写下来免得下次再踩）

* **发布后只剩最新一个 GitHub Release 对象**：两个代码仓的 `.release-policy.yml` 都设 `retention.stable = 1`
  + `pruneStable = true`，而 `reusable-release.yml:505` 的步骤名就是「Publish, set Latest, audit, then prune
  Release objects」⇒ 发 2.71.2 之后 `v2.71.1` 的 Release 对象已被删除（`gh release view v2.71.1` → 404；
  tag 与 ghcr 镜像仍在）。**写回滚锚点时别声称「旧 Release 还在」。**
* **`fly apps suspend` 不是流水线开关**（本轮复述，此处留档）：app 级 `suspended` 拦不住
  `auto_start_machines`，外部时钟（cron-job.org / Cloudflare Worker / schedule-watchdog）照样能唤醒机器；
  `fly apps list` 的 STATUS 列与 `fly apps list --json` 的 `Status` 字段不一致，以 `--json` 为准。
  （补记：本轮部署之后 `pixivflow-scheduler` 的 app 级 `suspended` 标记已不存在——`fly apps list --json`
  现在报 `deployed`，而机器仍是按设计处于 `stopped`；标记消失的具体原因未坐实，但这恰好再次说明它不是开关。）

## 4 仍然未决（不在本轮范围）

* TelePost 的 `v2.71.1` / `v2.64.0` `TAG_CONFLICT` **未对账** ⇒ 下一次发版仍需手工落版本提交；对账要人决策
  （releasegraph 源码写死 “Tag conflicts are permanent: never move/force an existing tag.”，其 `AGENTS.md`
  也写 “`TAG_CONFLICT` → stop and ask a human.”）。
* §5 的 `invalid_refetch_provenance`（手动准入的键不是规范 UUID 时投递被永久拒绝）**已于 2026-09-28 修复**
  （PixivFlow 3.4.3，见本页末尾「A1」一节；§5 本身保留为现场取证记录）。
* #2 的行为层验证窗口是下一次真实运行（每日 10:00 / 10:10 CST）。

# 2026-09-28 A1 provenance 契约修复（PixivFlow 3.4.3）与 A2 候选池跨频道清理

Status:
* A1 手动重抓投递的 provenance 契约错配：VERIFIED（§1）
* A2 存量清理（跨频道行置 `expired`）：VERIFIED（§2）
* A2 预防（`tagRelations.deny` 卷上生效）：VERIFIED（§3）
* B1 备份导出脚本 + 一次恢复演练：IN_PROGRESS（并行进行，完成后追加）

## 1 A1：一段不可用的 provenance 不得让一次合法投递失败

* 缺陷与现场证据见本页 `## 5`（execution #556，`bot1-daily@manual-1e22b55cb33e47289f30c62e8ee1e11f`，
  `HTTP 400 invalid_refetch_provenance`，`duration_ms 0`，候选已选出却永远投不出去）。
* 修复形状（PixivFlow，PR #182 → squash `fee6df8`）：新增
  `src/delivery/refetchProvenance.ts` 的 `canonicalRefetchRequestId(value)` —— 去掉连字符后必须匹配
  `/^[0-9a-f]{32}$/`（等价于 Python `uuid.UUID()` 的宽容度：允许无连字符、大写、花括号、`urn:uuid:`
  前缀、首尾空白）才输出唯一的 `8-4-4-4-12` 形式，否则返回空串。两个边界收口：
  `src/download/handlers/deliveryContext.ts`（Slot 上下文 → 投递字段）与
  `src/delivery/HttpMultipartDelivery.ts` 的 `buildTemplateVariables`（模板变量，最后一层）。
  规范化失败时 warn 一次并投空串（下游把空串当「定时执行」）；仅改写拼写时 info。
  **`manual-` Slot 的身份仍用调用方原拼写**（`ManualJobAdmission.ts:128/409`），幂等语义不变。
* 取舍理由：可还原的拼写差异按同一 UUID 还原（保住「投稿与重抓请求的关联」），不可还原的值丢弃——
  宁可少一条 provenance，不可让一次真实替换失败。`docs/CONFIG.md` 的投递模板变量一节已写明该规则。
* 验证证据：`npx jest src/__tests__/delivery src/__tests__/protocol --silent` → 33 suites / 524 tests；
  全量 `npx jest --silent --runInBand` → 138 suites / 1532 tests；`npx tsc --noEmit` → exit 0；
  新测试 `src/__tests__/delivery/refetchProvenance.test.ts`（8 例）。CI（PR #182）全绿。
* 发布与部署：tag `v3.4.3` → 提交 `74ffa4d29ec29810358a43545676c71134e068ce`；Release run
  `36350876894`；npm `pixivflow@3.4.3` 已发布；ghcr `pixivflow:3.4.3` 匿名 manifest 200；
  Release `v3.4.3` 已置 Latest（2026-09-27T21:25:25Z，旧的 `v3.4.2` Release 对象按策略被 prune，
  tag 与镜像仍在）。执行端 pin 见 `fly/deploy.pixivflow.toml`（`PIXIVFLOW_REF=74ffa4d2…`、
  `PIXIVFLOW_VERSION=3.4.3`，同文件 pin 历史里写了回滚锚点）。
* 诚实边界：这修的是「合法替换因 provenance 措辞被整次拒绝」。它不改变「现代审核卡路径送出的就是规范
  UUID」（线上 6 条 attempt 的 `request_id` 全是虚线 UUID）这一事实，也不覆盖「值非空却不是 UUID」
  以外的失败面。

## 2 A2：候选池的存量跨频道行

* 池的生命周期长于填它的那次运行：`always` 时代每个解析出的 tag 都是检索 channel，于是
  `recordInventoryCandidates` 把**另一个 bot 的题材**也存成了备用件；`claimNext` 按
  `ORDER BY first_seen_date ASC, seen_count ASC` 取件（`CandidateInventoryRepository.ts`），
  于是这些行排在 fallback 队列最前面。已交付的证据：bot1 已投稿的 28 行里有 3 行带 丸呑 系 tag。
* 判据修正（重要）：第一版判据是「快照里没有字面种子 tag」→ 干跑出 140 行（bot1 77 + bot2 63）。
  逐条读快照后**否掉了这个判据**：bot1 池里没有字面 `ボテ腹` 的行多为正宗内容——
  复合 tag `储精罐/一肚子精液/腹胀/腹部隆起/ボテ腹`（子串含种子）、`怀孕/西瓜肚`、`妊婦/pregnant`、
  `膨腹/belly inflation`；bot2 池里被判 off-topic 的几乎就是整个 vore 供给
  （`VORE | 丸吞み`、`VORE | 丸吞 | 捕食`、`丸吞み | vore`、`吞食 | VORE`），按字面清会把 bot2 清空。
  最终判据：**带另一个 bot 的题材标记、且完全不带本池自身题材标记**的行才清理（混合作品两边都留）。
* 执行证据（`/app/data/pixivflow.db`，`node:sqlite` 只读干跑 + 单事务 apply）：
  `COUNTS {"pending":362,"keep":342,"cull":20,...}` → `APPLIED changed=20 planned=20`；
  `PENDING_AFTER` = bot1-illust 82 / bot1-novel 51（70→51）/ bot2-illust 159 / bot2-novel 50（51→50）。
  被置 `expired` 的 20 个 pixiv_id（bot1-novel 19 条、bot2-novel 1 条）：
  `29159030 29158982 29158763 29159656 29158590 29167028 29176318 29177452 29178214 29184796
  29193831 29204203 29202536 29203645 29204702 29212551 29216355 29219628 29230194 29138260`。
  置的是 `status='expired'`（`evictExpired` 自己写的状态），行与快照保留，逆操作是一句 SQL：
  `UPDATE candidate_inventory SET status='pending' WHERE pixiv_id IN (<上列>)`。
* 撤回的代码守卫：先做过一版 `src/download/inventory.ts` 的 `carriesSeedTag`（字面相等），
  在证据面前不成立——bot2 的主题写法本身就包含 `丸吞`/`丸吞み`/`vore`，字面判据会把正宗内容挡在池外；
  而且「一个作品是否属于本主题」是 `TopicPipeline` 的职责，不应在库存层用字符串复刻。该改动已 drop
  （未提交、未发布），本项以配置侧预防（§3）替代。
* 诚实边界：清理只针对**跨频道**混入。仍有 140 行「不带字面种子 tag 但不是跨频道」留在池里
  （含巨型娘/スカトロ/足控 这类 `always` 时代关联空间碎屑），它们是目标当时契约内的邻接，会各自按
  `expires_at` 在 2026-10-26/27 前自动过期，属 KNOWN_DEBT。

## 3 A2 预防：`tagRelations.deny` 关掉跨频道的检索 channel

* 语义（`src/topic/TopicPipeline.ts:75-118 selectWalkedTags`）：`deny` 永远胜出；`allow`/`allowSources`
  不能删种子 tag，只有 `deny` 能（`seedDenied` 时退化为「只走种子」）。
* 配置（`pixivflow/config/production.json`，四个 target 都在 `relatedTags: when_seed_insufficient` 之上叠加）：
  bot1 两个 target `deny: ["丸吞","丸呑み","丸呑","vore"]`；bot2 两个 target
  `deny: ["ボテ腹","ポテ腹","妊娠","怀孕","西瓜肚","pregnant"]`。
* 两层校验：`bash scripts/validate.sh` → `[OK] pixivflow/config/production.json JSON` +
  Workflow Protocol v1 `[OK]`（另有两条 FAIL 是未 bootstrap 检出目录的既有项）；PixivFlow
  `node dist/index.js config validate <path>` → `✓ JSON format is valid`、`✓ Download targets configured`
  （1 warning：本机没有 refresh token）。
* 卷上应用（deep-diff 闸门，不用 round-trip identity 判等）：`LIVE b09f8512…`(11101 B) →
  `NEW b1afd374…`(11653 B)，`DIFF_COUNT 4 UNEXPECTED 0`（四条都是
  `/targets/<n>/topicDiscovery/tagRelations`），备份 `/app/data/production.json.bak-tagrelations`，
  `APPLIED b1afd374…` / `READBACK_IDENTICAL true`，热重载证据
  `Scheduler configuration snapshot activated {"generation":2,…}`（21:14:35Z）；随后机器停回 designed
  `stopped`。
* 诚实边界：`deny` 只删**检索 channel**，不改 tag 空间与相关性打分，因此「同时带本池主题与另一题材」
  的混合作品仍可能经其它 channel 进入候选——这是选择 `when_seed_insufficient`（要供应、容忍邻接）
  而非 `never`（纯净、可能空窗）的既定代价，也是本轮把 bot1/bot2 都留在 `when_seed_insufficient`
  的原因：bot1 在 2026-09-26/27 都真实走到 `No matching illustration found yet; checking fallback day`
  的回看分支，`never` 会把这类日子变成空窗。

## 4 本轮未做

* B1（备份导出脚本 + 一次真实恢复演练）**已完成**，见本页下一节。
* 其余未决与上一节相同：TelePost 的 `TAG_CONFLICT` 未对账（下次发版仍需人工落版本提交）、
  #2 的行为层验证窗口是下一次每日运行。

# 2026-09-28 卷备份导出脚本 + 一次真实恢复演练（B1）

Status:
* 卷备份导出脚本 + 恢复演练：IMPLEMENTED_NOT_VERIFIED（脚本两卷实跑成功、恢复演练真实通过；完整生产恢复未演练）
* 完整生产恢复演练：EXTERNAL_ACCEPTANCE_REQUIRED

* **缺口**：两个卷的 `snapshot_retention` 都是 5（约 5 天），比静默损坏的发现周期短；Fly 之外没有
  任何副本；此前既没有备份脚本、没有 `deploy backup` 子命令，也没有调度。
* **新增**：`scripts/export-volume-backup.sh`（operator-run；只读生产：不写不删 `/app/data`，
  不 start/stop 机器，机器 stopped 时 exit 3）。经 `fly ssh console -C "sh -s -- …"` 在容器
  `/tmp/vb-<plane>-<ts>/` 搭中转树；每个 SQLite `*.db` 与其 `-wal`/`-shm` 在**同一个 tar 动作**里
  原子拷走（`_meta/ATOMIC_TRIPLES.tsv` 记账）；运行配置 JSON 在**容器内**按键名/值规则脱敏后才打包
  （只把脱敏前 sha256 记进 `_meta/SOURCE_SHA256.tsv`，未命中的 JSON 字节不变）；`fly sftp get` 拉回
  本机后逐文件复核 size+sha256。输出默认在仓库之外：
  `$HOME/.local/share/pixivflow-volume-backups/<UTC ts>/<plane>/{volume-backup.tar.gz,manifest.json,verification.txt,data/,_meta/}`；
  `manifest.json` 只取机器字段白名单，**绝不整份落盘 `config.env`**。排除项全部带理由写进
  `_meta/EXCLUDED.tsv`。退出码 0/2/3/4/5/6/7（7 只在显式 `--strict-integrity`）。
* **实证**：
  - `--plane telepost` exit 0：292 文件 / 165834144 B，tar 154620153 B，sha256
    `b2554b29329860aeeaecedba73012df566ea235762cf728eaba0ef3297ed5fee`；11 个三件套 integrity 全 ok；
    excluded=5（两个 `-refresh-token*` + 3 个日志）；redacted=5（`pixivflow/config.json` 的 3 个 pixiv
    凭据 + 两条 `headers.Authorization`）；orphan_companions=0。
  - `--plane pixivflow` exit 0（先 `fly machine start 83d1650bd23948`，跑完已 stop 回设计态并复查）：
    310 文件 / 142902498 B，tar 137120364 B，sha256
    `db9db8027137360a4e82a274dcb21525ace419a11eea2c7dbb65b9a4bbb794d4`；`pixivflow.db` 三件套
    integrity ok；excluded=3；redacted=7（`production.json`，含此前未枚举到的两条
    `richNovelPreview.headers.Authorization`）。
  - 恢复演练（本机临时目录，未触碰任何生产路径）：bot1/bot2 三件套还原后 `PRAGMA integrity_check`
    均 ok、`foreign_key_check` 0 行；计数 bot1 `pending_reviews 121 / refetch_attempts 11 /
    refetch_events 10`，bot2 `94 / 3 / 0`；同一段只读查询跑还原副本与线上库（`file:…?mode=ro`）
    逐字段无差异；`pixivflow.db` 还原后 integrity ok、18 张表（含 schedule_slots /
    scheduler_executions / outbox / deliveries）。
  - 保真度：181 个 JSON 里只有被脱敏的 `config.json` 字节变化，其余逐字节相同；导出树 79 个 JSON 的
    残留凭据扫描只剩 2 处误报（`refetch_request_id`，20 字符请求 id）。
  - 复跑（修掉 CI 报的 ShellCheck 之后）：`--plane telepost` exit 0，288 文件 / 165768608 B，tar sha256
    `f2780ac98268371d47407c4b7c8469560ef2f628cfe15c4cf6f7a75de1b5886e`（与首跑不同的原因只是线上库
    在两次之间又变了），`orphan_companions=0`、11 个三件套 integrity 全 ok（含各 `*.bak-*` /
    `*.v4backup-*` 副本）。
  - 本机没有 `shellcheck`（`validate.sh` 会静默跳过它），首次 CI 因此报了 `SC2317`：脚本里的
    `warn()` 从未被调用。修法是把它用在真实异常上——导出树里出现孤儿 `-wal`/`-shm`
    （找不到主库）时警告并指向 `_meta/ORPHANS.tsv`。**教训**：本仓的 shell 静态检查只有 CI 会跑，
    新脚本必须等一次 CI 才算验证过。
* **剩余边界**：operator-run、**无调度**（没人跑就没有新拷贝）；目的地是操作者本机、**无异地副本**；
  三件套是「同一 tar 动作」不是点时刻快照；脚本不清理旧导出、无保留策略。完整生产恢复
  （重建卷 → 拷贝回 `/app/data` → `/ready` 门禁 → Telegram webhook 归属 → 发布链端到端）**未演练**。
* **顺带发现（未调查，另案）**：两个 Bot 的 `submissions` 表都是 0 行，而 `pending_reviews` 分别
  121/94；telepost 卷根目录另有 0 字节 `submissions.db`（Sep 14）与 legacy `pixivflow/` 树
  （含真凭据的 `config.json` 与 `.pixiv-refresh-token*`）——后者是历史残留，值得单独评估是否清理。

