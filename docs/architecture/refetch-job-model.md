# 重抓作业模型（Refetch Job Model）

Status: IMPLEMENTED_NOT_VERIFIED（TelePost 2.69.0 已发布并固定 pin；现场点击验收为 `EXTERNAL_ACCEPTANCE_REQUIRED`）
Scope: `redtidev1918/TelePost` @ `69849e2`（2.69.0，release 提交 `fa9323d`）+ `266017d`（doctor）
Authority: 本文件是重抓作业的权威架构参考；所有结论都带 `文件:行号` 或提交 SHA
Related: `docs/CONTRACT.md` §3（跨仓库终态契约）、`docs/architecture/ecosystem-platform.md` §28.1（所有权）、`docs/architecture/refetch-tag-cover-architecture-audit.md`（审计与改造方案）、`docs/operations/refetch-production-verification.md`

---

# 1. 为什么需要「作业」这个模型

2.69.0 之前，一次重抓的状态是**一个自由字符串**，由 5 处代码写入，其中 2 处绕过仓储
（`docs/architecture/refetch-tag-cover-architecture-audit.md:45` 的写入点清单：
`storage/sqlite/reviews.py:224-228`、`application/review_queue.py:617-621`）。由此产生四个后果：

* **没有迁移表**：非法迁移（终态回流、跳级）在代码里根本不存在校验，只能在运行期靠观察发现。
* **没有逐次时间线**：终态原因只落在 `audit_events`（`database/db_manager.py`），无法按 attempt 切片，回答不了「它到底卡在哪一步」。
* **进度不可见**：提醒只发一次（`if last: continue`），一次等待超过提醒阈值就再无任何输出；`admitted` 且远端持续返回 ACTIVE/空串时控制流会永久 `continue`。
* **本地时钟被当成远端事实**：本地 stale 直接判死，晚到的合法替换稿会被自己的看门狗丢掉。

作业模型的答案不是「多加日志」，而是：**一个词表、一张迁移表、一个写入口、一张时间线**。

---

# 2. 规范状态机

单一权威：`telepost/domain/refetch_state.py`（254 行，`69849e2` 新增）。

```text
REQUESTED ──→ SEARCHING ──→ FILTERING ──→ CANDIDATE_FOUND ──→ REPLACED
     └────────────┴──────────────┴───────────────┘
                  ↘ FAILED / TIMEOUT / NO_CANDIDATE / CANCELLED
                    （终态，无出边）
```

* 规范状态常量：`refetch_state.py:41-49`；`ACTIVE_STATES` `:51`；`TERMINAL_STATES` `:52-54`；`ALL_STATES` `:55`。
* 迁移表 `ALLOWED`：`refetch_state.py:90-111`。规则可以一句话概括（`:86-89` 注释）：**每个活动状态都可以走到每个终态**（作业在任何时刻都可能失败、超时、找不到候选或变得没有意义），活动状态之间只能沿流水线**向前**推进；**终态没有出边**——「no downgrade, no resurrection」。
* 因此：`SEARCHING → REQUESTED` 被拒；`REPLACED/FAILED/TIMEOUT/NO_CANDIDATE/CANCELLED` 之后的任何迁移都被拒；**重试 = 新建一代**（新 attempt、新 `request_id`），不是把终态改回活动态。
* 同一状态重复写入是幂等的（`refetch_state.py:208-220` `can_transition` 中 `if source == target: return True`），所以「轮询」与「状态迁移」是两件事。
* 中文标签 `STATE_LABELS`：`refetch_state.py:114-124`（卡片与 doctor 共用同一套词）。
* 违规抛 `IllegalRefetchTransition(ValueError)`：`refetch_state.py:156-164`。
* 活动/终态集合只定义一次，需要拼 SQL 的地方用 `sql_state_list()`（`:234-240`）与 `legacy_aliases()`（`:243-254`）——后者把「旧词表拼写也算活动态」这件事收口，避免查询只信规范列值而漏掉历史行。

---

# 3. 旧词表映射（legacy ↔ canonical）

数据库里存在 2.68.x 及更早写入的行，Mini App 与 OpenAPI 消费者也在用旧词。2.69.0 **不改线协议**，
而是在投影层做双向映射（`refetch_state.py:59-84`）：

| 规范状态 | 旧词表 | 说明 |
| --- | --- | --- |
| `REQUESTED` | `requested` | 同名 |
| `SEARCHING` | `admitted` | PixivFlow 已接受（202）、durable slot 已存在 |
| `FILTERING` | `admitted` | 新增阶段，旧消费者看到 `admitted` |
| `CANDIDATE_FOUND` | `admitted` | 新增阶段，旧消费者看到 `admitted` |
| `REPLACED` | `replaced` | 同名 |
| `NO_CANDIDATE` | `no_alternative` | |
| `FAILED` | `failed` | 同名 |
| `TIMEOUT` | `failed` | **新增状态**：超时对旧消费者折叠成失败 |
| `CANCELLED` | `obsolete` | |

* `_FROM_LEGACY`：`refetch_state.py:64-71`；`_TO_LEGACY`：`:74-84`；`normalize()` `:167-179`（空值 → `REQUESTED`，未知值原样返回）；`to_legacy()` `:186-189`。
* 启动迁移会把库里遗留的字符串就地归一化（`database/db_manager.py:335-343`，
  `admitted→searching`、`no_alternative→no_candidate`、`obsolete→cancelled`，幂等），
  注释明确要求与 `refetch_state.py::_FROM_LEGACY` 保持一致（`database/db_manager.py:333-334`）。
* 旧词表不双写：读取方统一经 `from_legacy()`/`normalize()` 兼容（见 §0 与审计文档 §5 的「不保留双写」）。

---

# 4. 唯一写入口（single write path）

**规则：任何 attempt 状态迁移都必须经过 `RefetchRepository.apply_transition_on()`。**

```
telepost/storage/sqlite/refetch.py:200-279
    async def apply_transition_on(self, conn, request_id, to_state, *,
                                  reason="", actor="", remote_state="",
                                  extra=None, event=True) -> Tuple[bool, str]
```

它同时完成五件事：

1. 读当前行并按 §2 校验迁移；非法迁移只记 warning 并**原样返回 `(False, current)`**——不写、不记事件（`refetch.py:219-228`）。
2. 计算「是否真的动了」：`moved = target != current`（`:231`）。
3. 决定写哪些列（`:243-264`）：`updated_at` 总是写；`failure_code` **只在 `FAILED`/`TIMEOUT`** 写（`:248-250`）；`finished_at`/`terminal_reason` 只在**终态且真的移动**时写（`:254-258`）；`last_remote_state` 只在远端状态发生变化时写（`:251-253`）；`state` 只在 moved 时写。
4. **无变化即无写入**（`:232-242`）：远端状态与上次相同、`extra` 全部与行内现有值相同、状态也没动 ⇒ 直接 `return False, current`。理由写在代码注释里：否则每次轮询都会刷新 `updated_at`，一个停滞的阶段就会对看门狗隐形。
5. 只有 `moved and event` 才追加一行 `refetch_events`（`:272-278`）。

仓储内的调用点（全部集中在 `telepost/storage/sqlite/refetch.py`）：共享包装 `_transition` `:287`、
`mark_cancelled_on` `:340`、`finalize_replacement` 的 obsolete/replaced 两条路径 `:487`/`:500`、
`apply_outcome` 的两条路径 `:558`/`:566`。

**「five historical write sites, two bypassing the repository」是改造前的审计事实**
（`docs/architecture/refetch-tag-cover-architecture-audit.md:45`：5 处写入点，
`storage/sqlite/reviews.py:224-228` 与 `application/review_queue.py:617-621` 绕过仓储）。
这两处在 2.69.0 已改为走仓储：`telepost/storage/sqlite/reviews.py:222-229` 与
`telepost/application/review_queue.py:612-621` 都调用 `mark_cancelled_on()`，并留下
`# No bypass write: the attempt state machine owns this transition` 的注释。

改造后仍存在**非仓储**的 `UPDATE refetch_attempts`，但它们不参与运行时状态迁移：

| 位置 | 性质 |
| --- | --- |
| `database/db_manager.py:328-332` | 启动迁移：回填 `updated_at`（`COALESCE(updated_at, finished_at, started_at, created_at)`） |
| `database/db_manager.py:335-343` | 启动迁移：旧状态字符串就地归一化 |
| `TelePost/scripts/reconcile_legacy_refetch_attempts.py:133` | 运维脚本（在 **TelePost** 仓库，不属于本仓库）：历史 poisoned attempt 的一次性对账（dry-run 默认、`--apply` 才写，带 audit） |

`RefetchRepository.bump_progress_notified()`（`refetch.py:382-396`，写 `:391`）只写
`last_progress_notified_at`/`notify_count`，注释明确说明它**故意不碰 `updated_at`**——提醒的次数
不能冒充阶段的进展。

---

# 5. 持久化时间线：`refetch_events`

* 建表：`database/db_manager.py:364-377`；列 `id / request_id / review_id / review_chain_id /
  from_state / to_state / reason / actor / remote_state / created_at`（`:366-375`）；
  索引 `idx_refetch_events_request(request_id, created_at ASC)`（`:378-381`）。
* 写入：`RefetchRepository._record_event()`（`telepost/storage/sqlite/refetch.py:184-198`），
  与状态变更**同一连接、同一事务**（`refetch.py:12-13` 的模块 docstring 明确要求）。
  `from_state`/`to_state` 写入前都过 `fsm.normalize()`（`:195`），`reason` 截断到 400 字符（`:196`）。
* 读取：`list_events(request_id, *, limit=50)`（`refetch.py:114-121`，`ORDER BY created_at ASC, id ASC`），
  经 API 投影为 `events[]`（`telepost/application/refetch.py:265-277`）。
* 为什么必须有这张表：`audit_events` 是**审核**的审计流，不是**作业**的时间线，无法按 attempt 切片。
  有了它，「它什么时候进入哪个阶段、为什么结束」才是可查询事实，而不是推断。

---

# 6. 候选生命周期：`refetch_seen_candidates`

改造前它只是一个「这条链见过哪些作品」的平面集合（`UNIQUE(review_chain_id, candidate_id)`），
没有 attempt、原因与时间，所以「谁被拒绝、为什么、何时、被谁替换」无法回答。

* 建表 + 列：`database/db_manager.py:390-405`，新增列由幂等 ALTER 补齐（`:406-418`）：
  `request_id`、`outcome`、`reason`、`decided_at`（REAL，可空）、`replaced_by`。
* 写入：`insert_seen()`（`refetch.py:442-455`，`INSERT OR IGNORE`）记录「谁提出这个候选」；
  `_record_candidate_outcome()`（`refetch.py:419-437`）记录「它后来怎么了、被谁替换」。
* 读取：`get_refetch_state()` 把它投影为 `lineage[]`（`telepost/application/refetch.py:243-262`：
  `generation / candidate_id / source / request_id / outcome / reason / decided_at / replaced_by`）。
* 语义要点：链与代（`review_chain_id` / `generation` / `supersedes_review_id`）是既有机制，
  2.69.0 补的是**因果**，不是链本身。
* 连续重抓（A→B→C）由 `test_chained_refetch_a_to_b_to_c_keeps_one_active_generation`
  （`tests/test_refetch_replacement.py`）固化：第二次重抓的源是上一轮的替换结果，断言
  同一条链、代数 `0/1/2`、只有最新一代 `pending`（其余 `superseded`）、
  `111 --replaced_by--> 222 --replaced_by--> 333`、两次 attempt 各自终态 `replaced` 且
  `result_review_id` 指向自己的结果代。

---

# 7. 远端 cell → 阶段投影

PixivFlow 是执行方，持有 durable slot cell 状态，并通过
`GET /internal/targets/{target}/refetch/{request_id}` 上报（TelePost 侧读取见
`handlers/review.py:891-905`，返回 `result.get("state")`）。

| PixivFlow cell 状态 | TelePost 阶段 | 它证明了什么 |
| --- | --- | --- |
| `pending` | `SEARCHING` | slot 已存在，还没选出任何作品 |
| `selected` | `FILTERING` | 选出了一个作品，正在过滤（已看过/重复/无效） |
| `artifact_ready` | `CANDIDATE_FOUND` | 已经有可用候选，正在准备替换稿 |
| `delivery_pending` | `CANDIDATE_FOUND` | 同上，进入投递准备 |
| `submitted` / `no_candidate` / `duplicate` / `failed` | **不是阶段，是结果** | 由调用方按终态处理，不映射成进度 |

* 映射表 `REMOTE_CELL_STAGES`：`refetch_state.py:143-148`；函数 `stage_for_remote_state()` `:151-153`（不认识的远端状态返回 `''`）。
* **核心规则：TelePost 不得发明它观测不到的进度**（`refetch_state.py:127-142` 注释）。
  远端读不出来（空/未知/传输失败）时，只允许记「不可用」并走下一条闸门，不允许假装在搜索。
  调用侧：`handlers/review.py:609-620`（`remote_state="unavailable"`）、`:665-671`（`fsm.stage_for_remote_state()` → `repo.advance_stage()`）。

---

# 8. 看门狗：四道闸门

驱动者：`monitor_refetch_progress(bot, *, now=None)`（`handlers/review.py:489-714`），
由维护循环周期调用；五个旋钮全为 0 时整体关闭（`:515-518`）。

| 闸门 | 环境变量 | 默认值 | 触发后的终态 |
| --- | --- | --- | --- |
| REMIND（周期提醒，可重复） | `REFETCH_PROGRESS_REMIND_MINUTES` | 2 | 无（只提醒 + 刷卡片）`review.py:698-713` |
| STAGE（阶段停滞 / 远端不可读） | `REFETCH_STAGE_TIMEOUT_MINUTES` | 10 | `timeout(stalled_no_progress)`；远端读不出来时为 `timeout(remote_state_unknown)` `:672-685` |
| STALE（未被接受的 `requested`） | `REFETCH_STALE_TIMEOUT_MINUTES` | 20 | `timeout(admission_timeout)` `:578-586` |
| WAKE（幂等唤醒，不是终态） | `REFETCH_WAKE_MINUTES` | 12 | 用**同一个 request UUID** 重提，PixivFlow 恢复既有 manual slot `:587-603`、`:645-663` |
| HARD（绝对上限） | `REFETCH_HARD_TIMEOUT_MINUTES` | 30 | `timeout(stalled_after_hard_timeout)` `:687-696` |

旋钮定义：`handlers/review.py:88-108`（都被 `max(0, int(...))` 夹住，可用 0 关闭单项）。
`REFETCH_TIMEOUT_SECONDS = 120`（`:109`）与进程内幂等护栏 `_wake_pinged`（`:111-113`）是相邻的既有机制。

要点：

* **提醒是重复的，不是一次性的**。判据是 `current_time - last_progress_notified_at >= remind_seconds`
  （`:701-703`），发完立刻 `bump_progress_notified()`（`:704`）再去刷新卡片（`:712-713`）。
* **admission 分支必须 `continue`**（`:586`）。改造前这个分支会往下掉进硬超时分支，用
  `stalled_after_hard_timeout` 覆盖 `failure_code`——同一个终态被写了两次原因。
* **终态原因**：`source_review_resolved` → `CANCELLED`（源审核已结束，`:559-572`）；
  其余四条 → `TIMEOUT`。因为 `apply_transition_on` 只在 `FAILED`/`TIMEOUT` 写 `failure_code`
  （`refetch.py:248-250`），`CANCELLED` 只有 `terminal_reason`，没有 `failure_code`——这是刻意的：
  「为什么结束」与「为什么失败」不是同一个问题。
* **任何分支都必须走向终态**：不可能出现「永远 SEARCHING」，也不可能出现没有群通知的终态
  （每条终态路径都 `_notify()` + `refresh_refetch_card()`，`_terminate` 闭包 `:547-553`）。

---

# 9. 只读健康自检：`telepost doctor`

```
python -m telepost.observability.cli doctor [--bot N]... [--all-bots] [--json] [--now EPOCH]
```

实现：`telepost/observability/doctor.py`（989 行，`266017d`）+ `telepost/observability/cli.py:100-144`。
**只读**是硬约束：每个连接都是 `sqlite3.connect(f"file:{abspath}?mode=ro", uri=True)`
（`doctor.py:125`、`cli.py:38`），只跑 PRAGMA/SELECT；缺表缺列一律 `SKIP` 而不是报错
（例如 `doctor.py:305`、`:310`）。**从不打印 token。**

八项检查，顺序即 `CHECK_CODES`（`doctor.py:52-61`，调用顺序 `:882-895`）：

| # | 检查 | 关注点 |
| --- | --- | --- |
| 1 | `db_integrity` | `PRAGMA integrity_check`：不 ok 即「无法验证」 |
| 2 | `refetch_stuck` | 活动 attempt 的最长年龄：> 15 分钟 WARN，> 30 分钟 CRIT（`doctor.py:66-68`、`:368-371`） |
| 3 | `refetch_active_invariant` | 同一 `review_chain_id` 最多一个活动 attempt（与部分唯一索引同义） |
| 4 | `review_queue_orphans` | `status='pending'` 却没有控制消息的审核：> 15 分钟 WARN，> 1 小时 CRIT（`:71-72`） |
| 5 | `review_queue_publishing` | 卡在 `publishing` 的行：默认 > 300 秒 WARN（`_PUBLISHING_STALE_DEFAULT = 300.0` `:89`；实际阈值来自 `services.review_service.PUBLISHING_STALE_SECONDS` 或同名环境变量，下限 60 秒，`:193-218`） |
| 6 | `review_queue_counts` | 队列计数 + 最老的 pending 稿：> 7 天 WARN（`OLDEST_PENDING_WARN_SECONDS`，`:75`） |
| 7 | `delivery_outbox` | 未确认投递的 ledger 行（`partial`/`uncertain`/`failed`/`error`）：最老的一条 > 30 分钟 WARN（`FAILED_LEDGER_STATUSES` `:78`、`DELIVERY_WARN_SECONDS` `:80`） |
| 8 | `audit_events_recent` | 有活动重抓却 > 2 小时没有新的 refetch 审计事件 → WARN（`AUDIT_REFETCH_STALE_SECONDS` `:86`）；24 小时窗口内的审计事件计数为信息项（`AUDIT_RECENT_SECONDS` `:83`） |

退出码（`doctor.py:9-13`、`:931-936`）：**2 = 无法验证**（数据库缺失/不可读，或
`integrity_check` 不是 ok）> **1 = 至少一项 CRIT** > **0 = HEALTHY**。也就是说「2 优先于 1」
是刻意的：不知道比知道坏了更严重。`reviews inspect` 使用同一套 0/1/2 约定（`cli.py:55`、`:97`）。

---

# 10. API / Mini App 投影

* 任务 ID：`refetch-<source_review_id>-<epoch秒>`。
  构造点 `telepost/application/refetch.py:289-297`（`refetch_task_id()`）与
  `handlers/review.py:538`；看门狗通知里也带同一 ID（`:569`、`:584`、`:602`、`:641`、`:660`、`:682`、`:693`、`:709`）。
* 卡片：`telepost/telegram/review_keyboard.py:116-138`（`refetch_pending_text()`：
  `当前阶段：{stage_label}` `:127`、`已等待约 {minutes} 分钟，仍在查找…` `:129`、`任务ID：{task_id}` `:131`）；
  键盘 `refetch_pending_keyboard()` `:141-148`（重抓中只保留 `🔄 重抓/换一张` 与可选
  `🔗 查看原链接`）；恢复正常卡 `control_card_from_row()` `:151`。
* HTTP：`GET /api/v1/reviews/{id}/refetch`（`utils/api_server.py:2308-2326`，路由 `:2533`，
  只读）返回 `{"ok": true, "data": {...}}`；数据由 `get_refetch_state()` 组装
  （`telepost/application/refetch.py:224-286`）：`review_id / review_chain_id / generation /
  supersedes_review_id / attempt / events[] / lineage[]`。
* **终态仍可查询**：`get_refetch_state()` 先 `find_active_by_chain()`（`:237`），没有再回退
  `find_latest_by_chain()`（`:242`，`refetch.py:104-112`）——终态结果不会变成「这里什么都没有」。
* Mini App 投影：`_attempt_dict()`（`telepost/application/refetch.py:300-346`）给出
  `task_id`（`:316`）与 `progress = {task_id, stage, label, elapsed_seconds, notify_count,
  last_remote_state, terminal_reason}`（`:337-345`）。

---

# 11. 排障：一次卡住的重抓怎么查

```console
# 1. 全 bot 只读自检（退出码 0/1/2，见 §9）
python -m telepost.observability.cli doctor --all-bots

# 2. 单 bot 的机器可读报告（含 refetch_stuck 的 warn_seconds/crit_seconds 细节）
python -m telepost.observability.cli doctor --bot 1 --json

# 3. 一条审核的完整现场：行 + audit_events + delivery_ledger
python -m telepost.observability.cli reviews inspect <review_id> --bot 1
```

判读顺序：

1. `refetch_stuck` 报出最长年龄的活动 attempt ⇒ 先看它的 `last_remote_state` 是否为空：
   为空通常是**远端不可达**（WAKE 分支），不为空则是**阶段停滞**（STAGE 分支）。
2. `refetch_active_invariant` 报错 ⇒ 有人绕过了唯一写入口（见 §4 的禁止事项）。
3. 要回答「它什么时候进入哪个阶段」直接读时间线：`refetch_events` 按 `request_id` 升序
   （`refetch.py:114-121`，API 侧为 `events[]`）。
4. 要回答「上一个候选被谁换掉」读 `refetch_seen_candidates` 的
   `outcome/reason/decided_at/replaced_by`（API 侧为 `lineage[]`，§6）。
5. 看门狗的所有终态都会往审核群发一条带任务 ID 的通知；**群里没有通知就等于没有终态**。

---

# 12. 禁止事项

* **禁止绕过仓储**：不得直接 `UPDATE refetch_attempts` 改 `state`。状态迁移只能经
  `RefetchRepository.apply_transition_on()`，否则迁移表、时间线、`updated_at` 三者同时失真。
  唯一的例外是启动迁移与一次性对账脚本（§4 表格），且它们不得成为运行时路径。
* **禁止把迁移原因当 `failure_code` 写**：`failure_code` 只属于 `FAILED`/`TIMEOUT`
  （`refetch.py:245-250`）；其他终态的原因进 `terminal_reason` 与 `refetch_events.reason`。
* **禁止把本地时钟当成远端事实**：`admitted` 之后不得仅凭本地时间判死；先读 PixivFlow 的
  durable cell（`handlers/review.py:608-620`），本地时钟只允许作为**绝对上限**与**未被接受**的判据。
* **禁止让已被接受的作业沉默**：任何活动 attempt 必须在有限时间内走向终态并通知
  （REMIND 反复播报 → STAGE/STALE/HARD 收口），不得出现无限 `SEARCHING`，也不得出现没有通知的终态。
* **禁止发明观测不到的进度**：远端状态不认识就显示「不可用」，绝不从 `REQUESTED` 假装推进。
* **禁止复活终态**：重试 = 新建一代（新的 attempt / `request_id`），不是改回活动态。
