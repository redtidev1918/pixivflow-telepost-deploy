# 事故 2026-09-27 — 重抓被静默取消：群里没有任何终态消息，审核卡点击后也不刷新

> 本页记录事实与决策，遵循 `docs/incidents/` 既有约定（同一结构：背景 / 症状 / 证据 / 解读 /
> 未知项 / 架构后果 / 后续，没有第二套 incident/ADR 约定）。**当前状态**见
> [operations/current-state.md](/operations/current-state.md) 的
> 「2026-09-28 内容链路稳定化」§3。

## 背景

生产是 `split-worker`：审核与投递在 TelePost（`telesubmit-multi-bot`，常驻），Pixiv 抓取在
PixivFlow（`pixivflow-scheduler`，平时 stopped）。操作员在审核群用「🔄 重抓」按钮要求换一张稿。

2026-09-26/27 期间 TelePost 的重抓刚换了实现：`69849e2`（09-27 05:41Z）统一重抓生命周期、
`6f2617f`（09-27 08:06Z）把重抓改成持久化作业流。

## 症状

* 点了重抓后群里**没有任何后续消息**：不说成功、不说失败；稿件保持原样。
* 审核卡看起来「没点上」：点击后卡片没有任何变化。
* 现场同一批的两条投稿（审核 #135 / #136）表现相同。

## 证据

只读取证，对象是 `telesubmit-multi-bot` 卷上 bot1 的 `submissions.db`（未写任何一行）。
注意 `audit_events` 的时间戳列名是 `ts`，没有 `created_at`。

* `refetch_attempts` id 9（`review_chain_id='chain-135'`，`source_review_id=135`，候选 `150123915`）：
  `state='cancelled'`、`failure_code=''`、`terminal_reason=''`、`notify_count=0`、
  `last_progress_notified_at` 与 `terminal_notified_at` **都是 NULL**；
  `created_at 1790481174.57` → `finished_at 1790481318.92`（跑了 ≈140 秒）。
* `refetch_events` 里 `chain-135` **一行都没有**；`submitter_notifications` 里只有
  `manager_accepted`，**没有** `refetch_terminal` 行 —— 终态通知连排队都没排。
* `audit_events` 时间线：`02:05:30` 审核 135 创建（actor `service:api_token:2`，slot
  `bot1-daily@2026-09-27T1000`）→ `03:52:54` `review.refetch_requested`
  （actor `telegram_user:5073758941`，request `c78dd065-…`）→ `03:52:59`
  `review.refetch_remote_accepted` → **`03:54:40` `review.rejected`（同一用户自己驳回）**
  → `03:55:18` attempt 静默 `cancelled`。审核 136 于 `04:15:39` 被同一用户驳回。
* 版本时间线（决定性的对照）：`git log -S'_refetch_terminal_notify' -- handlers/review.py`
  只命中 `6f2617f`（2026-09-27 08:06Z），且 `git tag --contains 6f2617f` 只有
  **v2.71.0 / v2.71.1**；`source_review_resolved` 出自 `69849e2`（05:41Z）。
  **本次事件发生在 03:52–03:55Z**，早于 v2.68.1（05:02Z，首个含点击刷新卡片的 `60616f8` 的版本）
  与 v2.71.0（11:11Z）。

## 解读

* 两个症状是同一个根因：**当时的线上版本既没有终态通知代码，也没有「点击后刷新卡片」的代码**。
  attempt 在源审核被驳回后按设计收敛为 `cancelled`，但那条收敛路径当时不产生任何用户可见结果，
  于是表现为「静默」；卡片同理，点击后没有任何重绘。
* 事件之后上线的 2.71.1 在结构上消除了这条静默路径：`apply_transition_on()` 是唯一写入者
  （CAS 在它读到的 state 上 + 合法迁移表拒绝非法迁移），
  `apply_refetch_outcome_and_notify()` 是轮询 / 事件对账 / 重启补扫 / HTTP 回传四条入口**共用**的
  唯一终态咽喉（`changed == False` 时不发），`terminal_notified_at` 一次性占用，
  `_refetch_outcome_text()` 是唯一文案映射（`no_alternative` / `obsolete` / `failed` / 兜底）。
* 教训（可复用）：**遇到现场数据行，先对齐 release 时间线再判断归属**。这条 attempt 的
  `terminal_reason` 为空、`refetch_events` 无行，本身就是「修复前版本」的指纹；只查 DB 不查 tag
  时间，很容易把历史行当成现行缺陷，从而误报「线上还在卡死」。

## 未知项

* **没有人在审核群里对着现代码路径真点一次重抓按钮**（事件发生时的投稿已过期）。所以
  「点击 → 卡片刷新 → 终态通知」这条完整人机路径没有被点击复现，结论是
  「生产库只读取证 + 运行镜像里的代码 + tag/release 时间线」三者互证。
* 成功终态（`replaced`）在生产真机走过：`refetch_attempts` id 8 / `chain-110`（2026-09-17），
  源审核 110 被 `superseded`、替换稿 review 112 入库并于 02:10:42 被人审驳回；但同样不是本轮点击复现。
* 取证窗口内上游 Pixiv 持续对生产下载器返回 502/503，24 小时内的两次重抓失败都是上游 502。

## 架构后果

* 重抓终态从「每个入口各自发消息」收敛为**单一咽喉**，从结构上杜绝「某条路径不发」。
* 执行端回传的终态原文（例如上游返回的 HTML 错误页）不再进入审核卡与小程序的展示列。
* 本页不引入新的约定；状态口径仍以 [operations/current-state.md](/operations/current-state.md) 为准。

## 后续

* 若要真正闭环这条人机路径，需要在一次真实投稿上由人工点一次重抓，并在群里确认终态消息与卡片
  更新（属人工验收，本轮未做）。
