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
`state='failed' AND failure_code='stale_timeout'` 的 4 条历史 attempt，用
`scripts/reconcile_legacy_refetch_attempts.py` 改写为
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