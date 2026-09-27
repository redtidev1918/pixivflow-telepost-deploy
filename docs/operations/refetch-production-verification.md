# 审核群「重抓」生产验证记录（2026-09-14）

本文件记录 split-worker「重抓」从故障到修复、部署与**真实业务链路生产验证**的完整
证据。只写**证据**与**处置**，不写任何凭据值。

## 部署（deploy order：先执行端，后业务端）

| 对象 | 版本 / pin | 状态 |
|---|---|---|
| PixivFlow 执行端 `pixivflow-scheduler` | v2.20.2（`cdaedd018e4dcd5aae9a4d18df0894abcfe1d7e2`） | Fly release v20；Machine 平时 `stopped`，按需 HTTPS 唤醒后自行 idle-exit |
| TelePost `telesubmit-multi-bot` | v2.23.1（`ghcr.io/redtidev1918/telepost:2.23.1`，commit `885de22`） | 常驻，health 通过（bot1/bot2） |
| 共享凭据 | `PIXIVFLOW_REFETCH_TOKEN`（两端同名） | 已写入两端 Fly secrets；值从未入库/入日志 |
| TelePost 侧 | `PIXIVFLOW_REFETCH_BASE_URL=https://pixivflow-scheduler.fly.dev` | 在 `fly/deploy.telepost.toml` env |

运行时核对（不是读 git）：PixivFlow 容器内 `/app/PIXIVFLOW_COMMIT =
cdaedd018e4dcd5aae9a4d18df0894abcfe1d7e2`；TelePost 容器内 `RELEASE_VERSION = "2.23.1"`、
`RELEASE_COMMIT = 885de227d033a9c9b5dce7b32f3ffa706de0112d`。

## 故障根因（2026-09-14 上午的生产现象）

用户侧现象：审核 #63/#75/#77/#78 多次出现「重抓仍在处理中」「重抓超时未完成」，持续
40–61 分钟后被超时提示终结。取证结论：

1. **运行时是 PixivFlow 2.20.0（`2229fb7`）**：投递模板把 `refetch_request_id` 渲染成
   字面量 `{{refetchRequestId}}` 而非请求 UUID。`deliveries` 账本与 TelePost `pending_reviews`
   共同证明：attempt `e3be2377`→slot→投递 pixiv `149515006`→TelePost 落库为**独立新审核
   #77**；attempt `16720a61`→投递→独立审核 **#78**；bot2 attempt `13866d8b`→投递→独立
   审核 **#65**。字面量 provenance 使 TelePost 无法 correlation 回原 attempt，旧稿未
   supersede，attempt 保持 admitted。
2. **终态回报死信**：attempt `09538fac` 的 manual slot 正常扫描并得出
   `no_alternative`，但 outbox 通知以
   `Delivery target does not configure notificationUrl: bot1-submit` 死信
   （2.20.0 通知按 `notificationUrl` 投递，而配置只声明 `refetchOutcomeUrl`），TelePost
   始终收不到终态。
3. 本地 stale watchdog（45 分钟）因此成了唯一收敛路径，产生「超时未完成」噪音。

## 修复内容（2.20.2 + 2.23.1）

- PixivFlow 2.20.2：refetch-outcome 通知改走 `refetchOutcomeUrl`（修死信）；
  `noteTerminalRefetchCell` 在投递终态/死信/slot abort 后从 durable cell 主动报告终态；
  新增 `GET /internal/targets/:targetId/refetch/:requestId`（refetch 专用令牌）供 TelePost
  watchdog 核对 durable slot；未解析的 `{{refetchRequestId}}` 在发 HTTP 前拒绝。
- TelePost 2.23.1：ingress 拒绝非 UUID provenance（`invalid_refetch_provenance` + audit）；
  替换稿为 commit-after-staging（预览+控制卡就绪后，新稿落库、旧稿 `superseded`、
  attempt `replaced` 同事务）；watchdog 只对未受理请求判超时，已受理 attempt 先查
  PixivFlow durable cell，不再凭本地时间判失败；每次 attempt 最多一次延迟进展提醒；
  Mini App 以 Telegram SDK launch params 为唯一规范 initData 来源。

## 历史 poisoned attempt 收敛（幂等，带 audit）

`stale_timeout` 是旧 watchdog 崩溃兜底码，且不再被新代码产生（封闭集合）。对
`state='failed' AND failure_code='stale_timeout'` 的 4 条历史 attempt，用 TelePost 仓库的
脚本 `reconcile_legacy_refetch_attempts.py`（位于其 scripts 目录；dry-run 默认、
`--apply` 才写，幂等）改写为
`legacy_refetch_correlation_broken` 并逐条写 `review.refetch_legacy_reconciled` audit：

```text
bot1: e3be2377(chain-75→#75 rejected)  16720a61(chain-77→#77 rejected)  09538fac(chain-78→#78 rejected)
bot2: 13866d8b(chain-63→#63 pending→superseded)
```

review 行与审核人决定一律未动（#75/#76/#77/#78 保持 rejected；#65 published 不变）。
重跑幂等（0 rows）。收敛后活跃 attempt = 0，任何 pending 稿均可再次重抓。

## 真实 Refetch 生产 E2E（2026-09-14 ~14:52 CST）

起点：`pixivflow-scheduler` Machine **stopped**；bot2 审核 #63 处于 `pending`
（pixiv `149631758`，`bot2-illust-marunomi`），审核群控制卡 control_message_id=372。

审核人（BOT2_OWNER_ID，ADMIN_IDS 自动含 owner）按「🔄 重抓」按钮的同一业务回调
`review_refetch:63` 触发（此后每一步都是真实生产系统：TelePost application service →
HTTPS → Fly 代理 → PixivFlow 执行端 → durable slot → 候选扫描 → 投递 → TelePost 关联 →
终态；回调更新经真实 Telegram Webhook 端点注入）。

```text
attempt request_id  6cc96212-03e5-474f-a2ff-a13a724caf8f  (UUID，非字面量)
TelePost state      admitted → replaced（finished_at 落库）
PixivFlow           stopped → STARTED（纯 HTTPS 自动唤醒，无人为 fly machine start）
PIXIVFLOW_COMMIT    cdaedd018e4dcd5aae9a4d18df0894abcfe1d7e2  （v2.20.2）
manual slot         bot2-daily@manual-6cc96212-03e5-474f-a2ff-a13a724caf8f → success
candidate           work #149632245
delivery            POST /api/bot2/v1/submissions → 201 pending_review reviewId=66
新审核 #66          status=pending  pixiv=149632245  chain=chain-63  generation=2
                    supersedes_review_id=63  refetch_request_id=6cc96212-…（精确 UUID）
旧审核 #63          pending → superseded（审核人决定未动）
group card          control_message_id=389, previews [385,386,387,388]
audit               review.refetch_requested / review.refetch_remote_accepted（+落库事件）
```

同一 review chain：新稿 #66 继承 `chain-63`，generation 为该链下一次 attempt 代数
（单调递增；两次尝试之间无中间稿时等于旧稿 +1）。校验：

- `refetch_request_id != "{{refetchRequestId}}"` 且为合法 UUID ✓
- 旧稿 superseded / 新稿同链 / attempt replaced / 无第二条 active attempt ✓
- 全程 ~2 分钟得到业务终态，没有等待 watchdog ✓

## 旧文档勘误

早前版本（2026-09-13/14 凌晨）的「完整闭合链」实为**传输层验证**：当时生产没有 pending
审核稿，只验证了「stopped + 真实令牌 → 404 未知 target → 自行 idle」，只能证明
auto-wake 与鉴权，不能证明「按钮 → 替换」。上一小节才是完整闭合链。判定标准统一为：
`HTTP 200 / Machine started / Slot exists / /app 200` 一律不算业务成功；Refetch 只有
`replaced / no_alternative / failed / obsolete` 才算终态。

## 处置边界

- 旧 `PIXIVFLOW_ENABLED` 仅保留为「同容器兼容模式」开关，拆分生产不使用。
- 凭据未入库、未入日志、未回显；`PIXIVFLOW_REFETCH_TOKEN` 只在两端 Fly secrets。
- 执行端 outbox 现存 2 条 `dead`：均为 2.20.0 时代 `notificationUrl` 死信（历史证据，
  不再重试）；2.20.2 起无新增死信，无永久 pending outbox。

## 2026-09-27 作业状态机改造后的验证基线

本小节是 TelePost `2.69.0`（`69849e2` + `266017d`）之后的验证基线。**只写实际运行过的命令与结果**，
未运行的写 `待执行`，无法复跑的写 `待确认`。

### 测试命令

| 命令 | 结果 | 状态 |
|---|---|---|
| `cd TelePost && pytest -q` | `1107 passed, 1 skipped` | **待确认** — 该数字出自提交 `69849e2` 的提交信息；本机两个 Python（系统 python3.9、`/opt/homebrew/bin/python3.12`）都没有 pytest，仓库内也没有 `.venv`/`uv`/`poetry`，本轮**未能复跑** |
| 四个重抓套件（`tests/test_refetch.py`、`tests/test_refetch_card_state.py`、`tests/test_refetch_replacement.py`、…） | `61 passed` | **待确认** — 提交信息未携带该数字，且仓库内只找到 3 个重抓测试文件（`tests/test_refetch.py` 32 个 `def test_`、`test_refetch_card_state.py` 12、`test_refetch_replacement.py` 9，共 53） |

上面两行的差异必须在下次有 pytest 的环境里消掉：要么复跑并写上真实输出，要么删掉引用。

**已消掉（2026-09-27，本机 `/tmp/tp-venv312` 复跑）**：全量 `1110 passed, 1 skipped, 20 warnings in 48.86s`
（exit 0）；四个重抓套件 `62 passed in 2.60s`（exit 0，含新增的连续重抓 A→B→C 回归测试
`test_chained_refetch_a_to_b_to_c_keeps_one_active_generation`）；`tests/test_doctor.py` `31 passed`。
此前「只找到 3 个重抓测试文件」是漏了 `tests/test_identity_provenance.py`（8 例），
`grep -c "def test_"` 也漏掉 parametrize 展开，故 53/61 都低估——以 `pytest` 输出为准（见
`docs/operations/current-state.md` §1）。

### 只读自检（doctor）

```console
python -m telepost.observability.cli doctor --bot 1 --bot 2 --json   # 或 --all-bots
python -m telepost.observability.cli doctor --now <epoch>             # 固定时间点复现
python -m telepost.observability.cli reviews inspect <review_id> --bot 1
```

退出码契约（`telepost/observability/doctor.py:9-13`、`:931-936`）：

* `0` = HEALTHY；`1` = 至少一项 CRIT；`2` = 无法验证（数据库缺失/不可读，或 `integrity_check` 不是 ok）。
  **2 优先于 1**：不知道比知道坏了更严重。
* 所有连接都是只读 URI `file:<abs>?mode=ro`（`doctor.py:125`、`cli.py:38`），只跑 PRAGMA/SELECT；
  缺表缺列降级为 `SKIP`，不写库、不打印 token。
* 8 项检查与阈值见 `docs/architecture/refetch-job-model.md` §9。

### 随下一次部署要做的只读核对

**2026-09-27 已全部执行完毕（证据见 `docs/operations/current-state.md` §4），结果如下：**

* `已执行` — `GET /health`：TelePost `2.70.1` / commit `f57d1617ef639eeccdbb749adb80f479c45a841b`（此前 2.70.0/`31d88fb` 也是同一路径）；
  PixivFlow `3.1.0` / commit `583a74c98ef7`。
  （后续：执行端已随 pin 推进到 PixivFlow `3.2.0` / commit `c195b909063c`——3.2.0 只增 `examples/onebot-adapter/` 与文档/测试，
  `examples/` 不进镜像，对运行中的 worker 与本文件的全部重抓结论**行为等价**，无需重跑本文件；见
  `docs/operations/current-state.md` 的「2026-09-27 PixivFlow 3.2.0」节 §3。）
* `已执行` — `./scripts/verify-images.sh` exit 0：pin 的 `telepost:2.70.1` 与线上上报一致，pin 的 `583a74c98ef7` 被执行端上报。
* `已执行` — 两个 bot 上 `doctor --all-bots`：`HEALTHY`，`16 OK / 0 WARN / 0 CRIT / 0 SKIP`，退出码 `0`
  （2.70.0 时同一命令报 `2 WARN`——那是 doctor 自身对账本历史行的误报，见 §1.2，已修）。
* `已执行` — 容器内只读确认：`/app/telepost/domain/refetch_state.py` 存在（9903 B）、
  `/app/handlers/review.py:92-105` 五个闸门默认值 2/10/20/12/30、`/app/telepost/observability/doctor.py` 含
  `最旧未确认记录` / `ledger_oldest_unresolved_age_seconds`；PixivFlow 侧 `selectWalkedTags` / `seedTier` / `allowSources` /
  `classifyNovelCover` / `coverDeliveryDecision` / `PIXIV_GENERATED_COVER_WIDTH` 均在 `dist` 内；
  Mini App bundle `/app/webapp/dist/assets/index-B8NVYagl.js` 含 `refetch-` 与 `搜索候选`。
* `待执行（仅剩业务面）` — 现场点一次重抓：任务 ID `refetch-<review>-<epoch秒>` + 中文阶段 + 已等待时长；等待中至少看到**一条重复**的进度提醒；
  一个真正停滞的阶段应以「重抓超时未完成」收口而不是无限 `SEARCHING`；小程序「审核详情」在重抓进行中按钮为禁用态。
* 判定标准沿用上一节：`HTTP 200 / Machine started / Slot exists / /app 200` **一律不算业务成功**；
  Refetch 只有走到终态（`REPLACED` / `NO_CANDIDATE` / `FAILED` / `TIMEOUT` / `CANCELLED`）才算收敛。
## 2026-09-28 协议化改造后的现场验收（已执行）

本轮不再给重抓加字段，而是把边界协议化：执行端只做「内容采集与处理引擎」，业务端只做「工作流编排」。
判据不变：**只有走到终态且带原因、且终态通知确实发出**才算收敛；「没消息」永远不算成功。

### 参与版本

| 服务 | 版本 | commit |
| --- | --- | --- |
| PixivFlow 执行端 | 3.4.0 | `5d231179a9b3` |
| TelePost 业务端 | 2.71.0 | `3f3d1151db556c667bb2556e94182a17cc7df9f8` |

### 本地前置证据（已完成）
* 离线验收 `python3 scripts/verify-protocol-v1.py` 退出 0，含边界纪律（`/internal/targets/` 只允许出现在唯一端口
  `telepost/application/pixivflow_jobs.py`）、生产者的 `ProtocolErrors.ts` 词表与 schema enum 一致、两仓 vendored 副本哈希一致。
* 业务端全量 pytest `1175 passed, 1 skipped`；执行端 `136 suites / 1512 tests passed` 且 `npx tsc --noEmit` 退出 0。

### 现场发现的执行端缺陷（由协议 v1.1 修复）

第一次现场验收时通用面**完全不可用**——两个真实缺陷，都不是验收脚本的问题：

1. `POST /jobs` 被 400 拒绝：`{"error":{"code":"invalid_params","message":"params.query must be a JSON object","retryable":false}}`。
   协议 v1 要求 `params.query`，而 2.71.0 的业务端只发 `params.target_id`（见
   `telepost/application/pixivflow_jobs.py:_protocol_submit`）。
2. 通用面无法指名目标：本部署有四个满足 `targetServesManualCandidateSearch` 的 target
   （`bot1-illust-botefuku` / `bot1-novel-botefuku` / `bot2-illust-marunomi` / `bot2-novel-marunomi`）、
   只有一个 Pixiv 账号 `default`，于是必然 `409 ambiguous_target`；协议 v1 没有任何目标选择器字段。

处置：先把业务端回滚到 `PIXIVFLOW_JOB_TRANSPORT=legacy`（旧 URL 通道不受影响，现场立即恢复），
然后发布协议 **v1.1**（`docs/architecture/workflow-protocol.md` §3.2：`params.target_id` 是**选择器**、
`params.query` 可选、`/capabilities` 声明 `target_selector`），执行端先升到 3.4.0，再把业务端切回协议通道。

### 部署后（只读核对）

1. ✅ `GET /capabilities` → `protocol_versions:["1"]`，`candidate_search` 的 `queued_timeout_ms=1800000` /
   `stall_timeout_ms=900000` / `default_deadline_ms=1800000` 全为正，`features` 为
   `["events","progress","cancel","idempotency","exclude","tag_expansion","target_selector"]` —— **含** `events`，
   事件面确实存在（本节早期版本写的「没有事件面」已过时）。
2. ✅ `python3 scripts/verify-protocol-v1.py --live --pixivflow-url https://pixivflow-scheduler.fly.dev
   --legacy-refetch-target bot1-illust-botefuku` 退出 0；实测判定行包含「旧 refetch 端点已转成 Job」
   「旧端点提交的作业在通用面上可见且 job_id 一致」「通用面提交的 Job 被旧入口解析回同一个 job_id
   （两个入口一个身份空间）」「同一 idempotency_key 重放返回同一 job_id」「同键不同参数 → 409
   `idempotency_conflict`」「未知 job_type → 400」「终态 cancelled（`cancelled_by_consumer`）」
   「/jobs 投影没有 refetch* 字段名」以及事件流的「可读 / 含终态事件 / 只含本 job / 时间升序 /
   ack 生效 / 重复 ack 幂等 / ack 不改变 Job 状态」。
   **`--legacy-refetch-target` 必须给 schedule target id**（`schedules[].targetIds` 的取值）；本文档早期版本
   写的 `bot1-submit` 是**投递目标名**，旧 shim 会返回 404（且两个入口的对照验证会直接失败）。
3. ✅ `telepost doctor --all-bots` → `HEALTHY`，`检查 18 项：18 OK / 0 WARN / 0 CRIT / 0 SKIP`，退出 0；
   `Refetch: running: 0 stuck: 0 failed(last24h): 0｜超预算 0｜轮询重试中 0｜终态缺原因（新代码路径）0`
   （legacy 历史行单独计数，不计入不变量）。
4. ✅ 业务端已切回协议通道（`PIXIVFLOW_JOB_TRANSPORT='protocol'`，见 `fly/deploy.telepost.toml`），
   旧入口只在对照验证里被显式调用；现场核对 `T=[protocol]`。

### 验收中修掉的**工具**缺陷（`scripts/verify-protocol-v1.py`）

这四个都会把产品缺陷误报成失败，或反过来掩盖真实失败：

1. 旧 shim 的 `requestId` 必须是真 UUID（`src/scheduler/ScheduleTriggerServer.ts:485` 的正则），脚本却拼了
   `-shim` / `-rev` 后缀 → HTTP 400 `requestId must be a UUID`。改为两个方向都用 `str(uuid.uuid4())`。
2. 旧 shim 失败时 `error` 是**字符串**，脚本按对象读 → `AttributeError: 'str' object has no attribute 'get'`。
   新增 `_error_code()` 容错提取。
3. `POST /jobs` 的成功体是 `{ job }` 包一层（§11.1），脚本直接在包装体上取 `job_id` → `None` → 接着去探测
   `GET /jobs/None` → 404，于是真缺陷（`target_id` 被接受）反而被这条假失败盖住。新增 `_job_of()` 统一解包
   （幂等重放判定同样改用它）。
4. 现场生产者的 `events_url` 是**相对路径** `/jobs/{job_id}/events`（样例 fixture 为可读性写成绝对 URL），
   脚本直接当 URL 用 → `ValueError: unknown url type`。脚本改为按服务基址解析；§2.2 的字段说明也改为
   「绝对 URL 或相对服务基址的路径，消费者必须按 base 解析，不得假定其中一种」。

### 现场重抓（业务面）

* ⚠️ **没有执行**「人工在审核群点一次重抓」的完整闭环：那需要真实审核群操作。本次用 `--live` 以业务端
  的**逐字节请求体**（`{protocol_version, job_type, idempotency_key, params:{target_id}}`）打执行端，
  验证的是同一个边界与同一个载荷，但不经过 Telegram 按钮与审核卡。
* ✅ 执行端**确实执行**手动作业（不是只入账）：`bot1-daily@manual-6a2af823-2ce9-4560-b297-ab0fea3a45b7`
  在 14:36:54 收口（`Scheduled download plan finished (took 255s)`），该 target `#150141037` **failed**，
  随后 `Refetch outcome enqueued for report {"disposition":"failed"}`。
* ✅ 手动作业被调度器**串行**执行：其余作业被 60 秒一次的 recovery sweep 以
  `reason:"scheduler_busy"` 跳过并留在 `pending`（`Recovered interrupted slots {"stale_slots_found":7,
  "reclaimed":1,"skipped":6}`）——同一时刻只跑一个计划是设计，不是卡死。
* ⚠️ 这些验收作业的 outcome 回到业务端时用的是验收方自己生成的 `refetch_request_id`，业务端按设计把
  **未知 attempt** 的替换稿拒绝为 HTTP 400 并记一条 `review.refetch_dropped_replacement`；本次未核对审计行。
* ⚠️ **事件推送通道在生产是关闭的**：`TELEPOST_API_BASE_URL` 未配置 → `consumer_callback_url()` 返回空 →
  Task 里不带 `callback_url`，事件只走「消费者补拉 + ack」这条**已实测可用**的路径（`GET /jobs/{id}/events`
  可读、有序、ack 幂等且不改状态）。要启用推送侧需要在业务端配置 `TELEPOST_API_BASE_URL`
  （例如 `https://telesubmit-multi-bot.fly.dev`），并先做一次「回调不可达」的回归。
* ⚠️ 「打断回调后仍必须恰好通知一次」的回归**未在本次现场执行**（它属于业务端 + 审核群动作，见
  上一节「现场重抓」的第 3 条）。

