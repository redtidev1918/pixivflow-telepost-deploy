# 审核重抓「点了没有结果」根治报告（refetch persistent job）

Status: IN_PROGRESS（根因 + 架构已定稿；测试结果与部署证据在完成后回填）
Scope: TelePost（审核面 + 状态机 + watchdog）与 PixivFlow（执行面 + 槽位/outbox 账本）
Related: `workflow-protocol.md`（**本报告的实施结果最终要收敛到的跨仓协议**）、`refetch-job-model.md`（现状模型）、`refetch-tag-cover-architecture-audit.md`（同批审计）

> 边界说明：本报告解决的是「Job 生命周期不可信」这一**前提问题**（没有可信的状态投影与心跳，任何协议都只是换名字）。跨边界接口本身按 `workflow-protocol.md` 收敛：重抓只是 `job_type=candidate_search` 的第一个用例，旧的 refetch 专用端点/字段将降级为兼容 shim，不再新增。

---

## 0 一句话结论

「重抓点了没有结果」不是单点 bug，而是**两层各自都"看起来正常"的设计叠加**：

1. TelePost 把重抓当成一次**远程调用 + 轮询**，没有把「还在进行」这件事变成**可观测、有预算、有终态通知**的一等任务；
2. PixivFlow 把重抓当成一次**普通槽位执行**，一旦槽位因为计划被停用、资源排队、租约过期、outbox 死信而停住，它**既不终态化也不上报**，而调用方拿到的状态投影里**没有任何时间戳**，因此无法判断「刚排队」还是「已经死了三天」。

结果是：受理成功（202）之后，任何一侧的停摆都会变成**永久静默**——用户既不得到新作品，也不得到失败原因，也无法判断任务是否还存在。

---

## 1 现场取证（只读，2026-09-27）

取证方式：`fly ssh console` 进入 `telesubmit-multi-bot` 与 `pixivflow-scheduler`，全部以 `sqlite3.connect('file:...?mode=ro', uri=True)` 只读查询。

### 1.1 TelePost 侧（`/app/data/bot1|bot2/submissions.db`）

| 指标 | bot1 | bot2 |
|---|---|---|
| `refetch_attempts` 总数 | 9 | 3 |
| 终态 | 9（failed 3 / cancelled 3 / replaced 2 / no_candidate 1） | 3（replaced 1 / failed 1 / cancelled 1） |
| 非终态（卡死嫌疑） | **0** | **0** |
| `notify_count = 0` 的行 | **9 / 9** | **3 / 3** |
| `terminal_reason` 非空的行 | **0** | **0** |
| `last_remote_state` 非空的行 | **0** | **0** |
| `refetch_events` 行数 | **0** | **0** |
| `audit_events` 中 `review.refetch_requested`（30 天） | 6 | 3 |

- 4 行 `failure_code='legacy_refetch_correlation_broken'`，由一次人工对账（`actor=operator:reconcile-legacy-refetch`，事件 `review.refetch_legacy_reconciled`）事后终态化。
- 最新一次事故（bot1 attempt id=9）：`request_id=c78dd065-…`、`chain-135`、`source_review=135`，`created=1790481174.57`，`started=1790481179.13`，`finished=1790481318.92`——**受理后 144 秒即被 cancelled**，`failure_code`、`terminal_reason` 均为空、`notify_count=0`。同链审核 135 的审计序列是：`review.created` →（1.79 h 后）`review.refetch_requested` / `review.refetch_remote_accepted` →**约 2 分钟后 `review.rejected`**（审核人放弃并手动拒绝）。
- 另有 4 行 `pending_reviews.refetch_request_id` 仍是未渲染的模板 `{{refetchRequestId}}`（id 75/76/77/78，gen=0），属于历史数据渲染缺陷，不影响新链路。

### 1.2 PixivFlow 侧（`/app/data/pixivflow.db`）

| 指标 | 值 |
|---|---|
| `schedule_slots` / `schedule_slot_items` | 58 / 102 |
| 槽位状态 | success 43 / failed 10 / partial 5；**pending、running 均为 0** |
| `trigger_source` | http 44 / manual 14；`slot_name='审核群重抓'` 11 |
| 人工重抓槽位（`manual_request_id<>''`） | 11（failed 6 / success 5；09-14 六次、09-15 三次、09-17 一次、09-27 一次） |
| 单元格状态 | submitted 84 / failed 10 / no_candidate 8；**无非终态单元格** |
| `outbox` | done 88 delivery + 51 notification；**dead 3 delivery + 3 notification** |
| `deliveries` | delivered 88 / failed 3；无非终态 |

死信原文（决定性的三条）：

| outbox id | 类型 | 尝试 | 错误 |
|---|---|---|---|
| `7e6a4c39…` | delivery | 1 | `permanent delivery failure: delivery endpoint HTTP 400: {"ok":false,"data":{"business_status":"permanent_failure","reason":"refetch attempt is obsolete"}}` |
| `6cfcf2a9…` | delivery | 12 | 同上，`reason":"refetch attempt is unknown or terminal"`（work 149713091） |
| `48dd24a8…` | delivery | 12 | 同上，`reason":"refetch attempt is unknown or terminal"`（work 149661816） |
| `332a78f7…` | notification | 5 | `notification endpoint returned HTTP 404`（`refetch-outcome:…manual-b0577058…`） |
| `f61ff7dd…` | notification | 1 | `Delivery target does not configure notificationUrl: bot1-submit` |
| `7b5ab057…` | notification | 8 | 同上（09-12 的槽位汇总） |

人工重抓槽位的真实耗时（说明「多久算正常」）：`e3be2377` 21 分钟、`09538fac` 20 分钟、`5b8e6060` 19 分钟、`1988b1dc` 20 分钟、`c78dd065` 2 分 59 秒；历史上有一次端到端排队约 **10 小时**（`b0577058`，18:42 受理 → 次日 04:47 执行）。

### 1.3 与「约 560 次」的口径差异（必须记录）

两库 30 天内可核对的重抓量是：**TelePost 9 次请求 / PixivFlow 11 个重抓槽位**，且**没有任何卡死行**。这与「约 560 次」相差两个数量级，说明「560」不是取自这两个账本。可能来源：(a) 审核群里「已提交重抓」消息的目视计数（会把重复点击、重发算进去）；(b) 另一套部署/另一段时期的统计；(c) 外部监控口径。**在拿到口径前，本报告以账本为准**；但下面这些失败模式在账本里都被证实存在，因此根治方案与「560 次」的真伪无关。

---

## 2 根因（R 系列）

### R1 终态永远不通知：`notify_count` 全为 0
重抓的终态只有两条路径会「通知到人」：正常替换（卡片换成新作品）或 `refetch/outcomes` 回调。生产上：
- `refetch/outcomes` 回调查询 **404**（当时部署的版本没有该路由）；修复点之一就是把 verdict 变成**持久义务**，不再依赖单次 HTTP 成功。
- 替换投递被 **HTTP 400** 永久拒绝（见 R2），PixivFlow 直接死信，用户**没有任何提示**。

### R2 迟到的替换被静默拒绝
`telepost/application/review_queue.py:598-660` `_reserve_replacement`：来源审核一旦不再是 `pending`（被通过/拒绝/过期），就走 `mark_cancelled_on(..., 'source_review_resolved')` 并 `raise ValueError("refetch attempt is cancelled or already terminal")`（:658）；attempt 未知/已终态则在 :615 `raise ValueError("refetch attempt is unknown or terminal")`。投递入口把这个 `ValueError` 映射成 **HTTP 400 permanent_failure**，PixivFlow 端 4xx 属不可重试 → 立即死信（`src/delivery/errorClass.ts` 的 `http 4dd` 规则）。**用户侧完全静默。**

### R3 PixivFlow 状态投影没有时间戳
`GET /internal/targets/{target}/refetch/{request_id}` 只返回 `{requestId, slotId, state, slotStatus}`（`src/scheduler/ScheduleTriggerServer.ts:327-340`、`src/commands/SchedulerCommand.ts:218-225`）。调用方**无法区分**「刚刚排队」与「计划被停用后永远 pending」，于是只能凭猜测定超时——这正是本次要修的核心契约缺口（RC8）。

### R4 「受理成功」不等于「开始执行」，且没有任何兜底
`202 accepted` 来源于 `Scheduler.runNow` 的 fire-and-forget 布尔值（`src/scheduler/Scheduler.ts:164-169`），而 `executeJob` 之后仍可能因为 `stopped` / `maxExecutions` / `maxConsecutiveFailures` / 资源排队被拒（`:179-182,197-215,233-239`）而不执行。兜底的 `recoverInterruptedSlots`（`src/scheduler/MultiScheduleManager.ts:172-241`，60 秒）在计划被停用或 Scheduler 已停时**静默 `skipped++`**，于是槽位永远 `pending`；同时 `countActiveSlots()` 还把它算作活跃（`SlotRepository.ts:552-557`），进程因此**永不休眠**。

### R5 没有按年龄的停摆清扫
`'expired'` 在 `SlotRepository.ts:3` 声明、在 `:196-206` 被读取，但**没有任何代码写它**（grep 证实）。没有任何查询会把「无活跃租约且超龄」的槽位/单元格终态化，于是停摆只能是永久的。

### R6 `finish()` 跳过两种非终态单元格
`src/scheduler/SlotCoordinator.ts:637-640` 直接 `continue` 掉 `delivery_pending` / `artifact_ready`。当对应 outbox 行已经 `dead`/`cancelled`（例如被接收方 400 拒绝后死信）时，单元格永远不终态、槽位永远 `running`：用户看不到结果，进程也永不进入 idle。

### R7 verdict 义务不持久
负向结论（无候选/失败）只作为一条 `kind='notification'` 的 outbox 行存在：`onDead` 对没有 `deliveryId` 的行提前 return（`src/commands/scheduler-runtime.ts:427-428`），而 `reconcileScheduleSummaries` 的查询明确排除人工槽位（`SlotRepository.ts:198` `WHERE s.manual_request_id IS NULL`）。**报告义务一旦死信就永久丢失，且没有任何对账**。

### R8 TelePost 侧的「有预算」不等于「有活性」
现行 watchdog（`handlers/review.py:489`）用「阶段内没有写库」当作停摆判据，默认 10 分钟阶段超时 / 20 分钟 stale / 30 分钟硬上限；但生产实测一次正常重抓要 2–20 分钟（且可能排队数小时）。**基于静默的预算会误杀正在正常工作的任务**，而真正的停摆（远端心跳已死）又无法识别——因为 R3 拿不到心跳。所以预算必须建立在**心跳与远端活跃度**上。

### R9 无人监督的生产盲区
`telepost doctor` 已经能查 `refetch_stuck` / `refetch_active_invariant`，但缺少「心跳停摆」「终态无原因」「24 小时失败率」这几个直接对应本故障的指标；PixivFlow 侧也没有把「重抓义务未上报」计入健康或 idle 门禁。

---

## 3 架构变化

### 3.1 重抓 = 一等持久任务（不再是一次调用 + 轮询）
- 任务身份：`refetch-<source_review_id>-<created_epoch>`，持久在 `refetch_attempts`，状态机为 SSOT（`telepost/domain/refetch_state.py`），**唯一写路径** `apply_transition_on`。
- 心跳：进程内 **30 秒**心跳任务（`refetch_heartbeat_job`）对每个非终态任务：读远端状态 → 写 `heartbeat_at`/`heartbeat_count` → 记录远端状态与远端心跳 → 按预算判定 →（需要时）刷新卡片。远端读失败也照写本地心跳并退避，绝不打断循环。
- 恢复：进程启动后第一次心跳即做一次恢复扫描（非终态且心跳过期的任务立即投一次远端读；远端已终态则直接落终态并记 `review.refetch_recovered_after_restart`），**不依赖任何内存变量**。

### 3.2 预算建立在活性上（允许长跑，禁止无声）

| 预算 | 默认 | 判据 | 终态 |
|---|---|---|---|
| 进度提醒 | 2 min | 非终态，**重复**提醒（不是只提醒一次） | —（卡片刷新 + 任务ID/阶段/已等待） |
| 排队预算 | 30 min | 远端一直 `pending`（从未被 claim） | TIMEOUT `queued_too_long` |
| 停摆预算 | 15 min | 远端**既无状态变化也无新心跳** | TIMEOUT `stalled_no_progress` |
| watchdog 心跳 | 20 min | 本地轮询心跳本身过期（我方 watch dog 坏了） | FAILED `watchdog_no_heartbeat` |
| 受理预算 | 20 min | `REQUESTED` 从未被远端受理 | TIMEOUT `admission_timeout` |
| 硬上限 | 90 min | 绝对上限，无论是否活跃 | TIMEOUT `stalled_after_hard_timeout` |

要点：**远端有新心跳或状态变化即重置停摆时钟**——这正是「正常但慢」与「已经死了」的分界线；任何终态都必须写 `failure_code` + `terminal_reason`，并**恰好一次**用户可见通知（含任务ID；失败/超时提示「可以再次重抓」）。

### 3.3 PixivFlow 执行面：让停摆可被终态化、让义务可被对账
- **状态投影补齐时间戳**（R3/RC8）：`createdAt/startedAt/updatedAt/heartbeatAt/leaseExpiresAt/leaseActive/claimed/attemptCount/terminalReasonCode/terminalReasonMessage`，只增不改。
- **按年龄的停摆清扫**（R5/RC3）：`pending` 且无活跃租约且超龄 → `failed` + `queued_too_long`；`running` 且租约过期且心跳过旧 → `failed` + `stalled_no_heartbeat`（有活跃租约/新鲜心跳的一律不动）。
- **`finish()` 收敛被遗弃的投递单元格**（R6/RC7）：单元格没有可执行的 outbox 行时终态化为 `delivery_abandoned`，避免进程永不休眠。
- **verdict 持久义务 + 对账**（R7/RC4）：负向结论记录为槽位上的持久义务，并由与 `getUnreportedTerminalSchedules` 对称的清扫（覆盖人工槽位）重发或升级；`onDead` 处理 notification 行。
- **统一活跃工作门禁**（阶段 4）：一个从账本读出的 `outstandingWork()`（槽位义务 + outbox + 无可用 outbox 的投递 + verdict 义务），idle 判定消费它，五个旧计数器退化为诊断输出；优雅退出先看门禁再做有界 drain。

### 3.4 用户可见语义（重抓 ≠ 删除审核）
重抓只表示「拒绝当前候选」：`ReviewSession` 保留 `current_candidate` 与 `candidate_history`（`refetch_seen_candidates` 的 `outcome/reason/replaced_by`），链上多代以 `review_chain_id + generation + supersedes_review_id` 关联，且**同一时刻只有一代活跃**。迟到的替换若因来源审核已结束而被丢弃，必须留下通知与审计（R2）。

---

## 4 数据库变化 / Migration

TelePost `refetch_attempts`（additive，`database/db_manager.py` 既有迁移列表，`PRAGMA table_info` 守卫，旧行可读）：

| 列 | 类型 | 用途 |
|---|---|---|
| `heartbeat_at` | REAL | 本地轮询心跳（活性时钟） |
| `heartbeat_count` | INTEGER DEFAULT 0 | 心跳次数（可观测性） |
| `remote_heartbeat_at` | REAL | 远端投影上报的进度时间 |
| `remote_state_at` | REAL | 远端状态最后一次变化时间 |
| `next_poll_at` | REAL | 下一次轮询到期时间（退避） |
| `poll_failures` | INTEGER DEFAULT 0 | 连续轮询失败次数（退避依据） |

PixivFlow：本轮不改表结构（停摆清扫与投影都基于既有 `schedule_slots.lease_until/heartbeat_at/created_at/started_at`、`schedule_slot_items.updated_at/terminal_reason_code`）；若 verdict 义务需要持久位，按 additive 迁移新增，默认值保持旧行为。

回滚：两仓均为**代码回滚 + 保留新列**（additive 迁移不删列，回滚旧镜像后新列被忽略），因此回滚不需要数据库操作。

---

## 5 状态机（TelePost 侧，SSOT `telepost/domain/refetch_state.py`）

```
REQUESTED ──受理──▶ SEARCHING ──▶ FILTERING ──▶ CANDIDATE_FOUND ──▶ REPLACED
    │                   │              │                │
    │                   └──────────────┴────────────────┴──▶ NO_CANDIDATE
    │                                   │
    └──▶ TIMEOUT ◀──(排队/停摆/硬上限/受理超时)      FAILED ◀──(远端失败/看门狗无心跳)
                 CANCELLED ◀──(来源审核已结束 / 人工取消)
```
- 合法迁移表在模块内以 `ALLOWED` 表达，非法迁移拒绝并由测试钉住；
- HTTP / Mini-App 边界仍以 `to_legacy()` 暴露旧词表（`requested/admitted/no_alternative/obsolete/failed`），**线上协议不变**；
- 终态必须携带 `failure_code` + `terminal_reason`，且可被 `task_id` 反查（`refetch_events` 时间线）。

---

## 6 监控（`telepost doctor`，只读）

新增/扩展指标：运行中重抓数、**心跳停摆数**、超预算运行数、24 小时失败数、终态但无 `terminal_reason` 的不变量违例；输出一行摘要（形如 `Refetch: running: N stuck: N failed(last24h): N`），退出码语义不变（2 > 1 > 0）。PixivFlow 侧把 verdict 义务/Sweep 结果纳入健康输出与 idle 门禁诊断。

---

## 7 测试结果

（完成后回填：两仓全量测试数、7 个场景用例、1000 次压力测试结论「0 永久卡死、终态必须有原因」、现场验收。）

---

## 8 部署注意事项

1. **顺序**：先 PixivFlow（提供时间戳投影与停摆清扫）后 TelePost（消费心跳），否则 TelePost 只能用本地心跳，停摆判据退化。
2. **迁移**：TelePost 起容器即自动补列；无破坏性 DDL。
3. **参数**：预算全部可用环境变量覆盖；默认值对齐生产实测（长跑允许、静默禁止）。
4. **回滚**：两仓均回滚镜像即可，新增列保留不影响旧版本。
5. **验收（EXTERNAL_ACCEPTANCE_REQUIRED）**：真实点一次重抓 → 30 秒内卡片出现任务ID/阶段/已等待；≥2 分钟后出现第二条提醒；若无候选，卡片出现失败原因与「可以再次重抓」；若远端停摆，`doctor` 的 `stuck` 与 `failed(last24h)` 计数发生变化。

## 9 只读代码审计补充（基线 017bb1e = 生产 v2.70.1）

以上 §1–§8 是「修什么」的依据；本节是后来一次**只读代码级审计**（不改任何文件）对**生产到底在跑什么**的核实，用来给验收下判据。基线是 017bb1e，且已用容器内 md5 确认生产 7 个关键文件与 017bb1e 完全一致（`handlers/review.py` `fee0f407…`、`telepost/storage/sqlite/refetch.py` `07e6b9ed…`、`telepost/application/refetch.py` `7e73f4ae…`、`telepost/domain/refetch_state.py` `f306d123…`、`utils/api_server.py` `55c59ce2…`、`main.py` `d0402430…`、`database/db_manager.py` `f0866788…`）。

### 9.1 决定性事实：加固后的收敛路径在生产**一次也没执行过**

- 生产 env（实测）：`REFETCH_PROGRESS_REMIND_MINUTES=5`、`REFETCH_STALE_TIMEOUT_MINUTES=45`、`REFETCH_WAKE_MINUTES=12`、`REFETCH_HARD_TIMEOUT_MINUTES=90`、**`REFETCH_STAGE_TIMEOUT_MINUTES` 未设置 → 走代码默认 10 分钟**；`PIXIVFLOW_REFETCH_BASE_URL=https://pixivflow-scheduler.fly.dev`。
- 时间线：定义 2.69.0 收敛逻辑的提交在 **2026-09-27 13:13 CST** 上线（镜像 v230）；而两库**最新**一条 attempt 是 **09-27 11:52 CST**。`refetch_events` 两库均 0 行（该表与写入也是 2.69.0 才加入），`notify_count=0`、`last_remote_state=''`、`terminal_reason=''` 对全部 12 行成立。
- 结论：**「阶段超时 / 硬上限 / 重复提醒 / 终态必通知 / 事件时间线」这些不变量，在生产是零执行的**。它们只被测试覆盖过。因此本报告的验收不能只看单测绿灯，必须以现场点击取证（§8.5）。
- 生产 durable 账本规模：`refetch_attempts` 全生命周期 **12 行**（bot1 9 / bot2 3），active 0；`audit_events` 里 `review.refetch_requested` **9 条**。

### 9.2 代码级根因（R 系列之外的补充，全部 file:line）

| 编号 | 机制 | 证据 |
|---|---|---|
| RA（游离任务） | 点击只写 DB，出站 HTTP 在一个**无人监督的 `asyncio.create_task`** 里；无引用、无 done-callback、无异常处理；`shutdown()` 不 cancel 不 join；`asyncio.to_thread` 不可取消 | `telepost/application/refetch.py:211`、`:167-177`（seam 解析在 try 之外）、`:194-209`；`main.py:589-627`。后果：进程在「已写 requested、未 POST」处退出 → attempt 永久停在 requested，无 failure_code、无通知 |
| RB（无启动对账） | 启动序列只调 `reconcile_incomplete_reviews`（审核行/控制卡修复），**全仓没有扫描非终态 attempt 的启动代码** | `main.py:428-440`（`:436-439` 是那唯一一次对账）；`handlers/review.py:789-796`；`main.py` 里 `refetch` 只出现 2 次（`:62` 导入、`:777` 调用） |
| RC（自锁陷阱） | partial UNIQUE `idx_refetch_one_active` + `create_attempt` 撞唯一键 → `already_running` → 文案「正在重抓，请稍候」 | `database/db_manager.py:348-357`；`telepost/storage/sqlite/refetch.py:159-169`；`telepost/application/refetch.py:146-151`。后果：一条卡死的 active 会让该链**此后每次点击都被拒**，而 job 早已死亡 |
| RD（通知全 best-effort） | 生命周期每一条用户可见通知都在 `except: logger.debug/warning` 里 | `handlers/review.py:541-546`（`_notify`）、`:998-1001`（`_notify_review_group`，即 §0 那条文本的发送点）、`:744/769/782`（卡片刷新，docstring 自称 never raises）；`telepost/application/refetch.py:185-193`、`:204-209`（受理/失败回调）；`utils/api_server.py:1495`、`:2460-2462`。后果：**DB 已终态而群里一个字都没有** |
| RE（唤醒预算只在内存、且先标记后提交） | `_wake_pinged` 进程内 set，永不清理；POST **之前**就 `add`；失败只 warning | `handlers/review.py:111-113`、`:587-606`、`:645-663`（`:655` 还是**同步**调用，见 RF）。后果：一次唤醒失败 → 本进程内不再重试，却已告诉用户「已自动恢复任务」 |
| RF（阻塞事件循环） | 看门狗里一处**同步**调用 `_submit_pixivflow_refetch`（同文件另一处正确用了 `to_thread`） | `handlers/review.py:655` vs `:591`；超时常量 `REFETCH_TIMEOUT_SECONDS=120`（`:109`）。后果：该 bot 进程所有 update 停摆最长 120 秒 |
| RG（预算基于本地沉默而非远端活性） | 远端读接口只取 `state` 字符串；空串≠unavailable，会走「阶段停滞」判定；生产 STAGE=10 分钟，而正常人工重抓实测 2–21 分钟 | `handlers/review.py:891-905`、`:664-696` |
| RH（看门狗自身脆弱） | 300 秒一轮、单轮只取 **≤50 行**、循环内**无逐行 try/except**；其上游 `cleanup_runtime_data` 的 7 个 await **无逐步 try/except**，前面任一步抛错则看门狗本轮被跳过 | `main.py:773-786`；`telepost/storage/sqlite/refetch.py:363-380`；`handlers/review.py:527-531` |
| RI（文档与代码三个答案） | `docs/CONFIGURATION.md:108-111` 写 HARD=90/STALE=45（是生产 env 值），代码默认是 30/20（`handlers/review.py:88-108`），同文件注释又写「30 分钟内必须自动终止」 | 三处并存 → 值班时无法据此判断 |

### 9.3 「约 560 次」的口径仍未闭合（写 redesign 验收指标前必须先定）

审计给出的可核实事实：那条文本（`handlers/review.py:993`）全仓**唯一**，且**只在成功新建 attempt 且远端 202 接受时**发出（重放在 `:1027-1031` 提前返回，不会再发）。因此 560 条文本 ⇔ 560 次成功新建 attempt，但生产全生命周期只有 12 行 attempt，且该文本 **2026-09-14** 才上线（`80ee189` #73），到最新 attempt 09-27 只有 13 天。因此：

- 可核实的替代解释：(i) 计数口径是「点击/消息行」而非 attempt（但 RC 自锁的结局是 toast「正在重抓，请稍候」，不是那条文本）；(ii) 计入 **#73 之前的 legacy 重抓**（`git show 80ee189^:handlers/review.py:403-481`：本地 subprocess 拉起 PixivFlow、`create_task`、**完全没有持久账本、没有任何超时**，文案也不同）——那个时代任何一次重抓都可以永久沉默且不可审计；(iii) 计数来自旧卷/旧库世代（卷上存在 `submissions.db.v4backup-20260912`、`submissions.db.bak-newlinefix-20260902`）；(iv) 计数来自日志或 PixivFlow 侧账本（PixivFlow 侧人工重抓槽位 11 个）。
- 处理方式：**不推翻用户观察到的现象，但把数字降级为「口径待定」**，并把 redesign 的成功指标改成可测的：`active/stuck` 计数、终态必通知率、`notify_count>0` 比例、`refetch_events` 覆盖率、`doctor` 的 `failed(last24h)`。审计可核实的故障规模是「12 次 attempt 里至少 3 次靠本地 stale 兜底收口、6 次 failed/legacy、加固路径生产零执行」。

### 9.4 测试缺口（必须由 redesign 补上，作为验收的一部分）

现无覆盖：(1) **进程重启恢复**（没有任何测试走启动路径扫描非终态 attempt）；(2) **关闭/取消**（in-flight 任务在 shutdown 时的落地或标记失败）；(3) 远端返回**空串/未知状态** → `timeout(remote_state_unknown)`；(4) 真实往返/冷启动/超时（现有全部是 stub）；(5) **通知发送失败路径**（被吞的 `_notify`/`_notify_review_group`/`on_remote_result`）；(6) `_wake_pinged` 重启后重新武装、唤醒失败后不再重试；(7) 看门狗 **50 行上限 / 毒药行中断整轮**；(8) `refetch_events` 内容（零覆盖）；(9) 端到端（按钮 → DB → HTTP → 回调 → 卡）。
已有覆盖：正常替换、远端失败、无候选、超时（反复提醒 + 硬超时）、重复点击、终态重放幂等、卡片即时应答、代际与链（含 A→B→C）。
