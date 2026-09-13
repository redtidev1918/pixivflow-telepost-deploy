# 审核群「重抓」生产验证记录（2026-09-14）

本文件记录 split-worker「重抓」修复的生产部署与验证证据。只写**证据**与**处置**，
不写任何凭据值。

## 部署（deploy order：先执行端，后业务端）

| 对象 | 版本 / pin | 状态 |
|---|---|---|
| PixivFlow 执行端 `pixivflow-scheduler` | v2.20.0（`2229fb7`，含 durable manual refetch） | 已部署，Machine 平时 `stopped`，按需唤醒后自行 idle-exit |
| TelePost `telesubmit-multi-bot` | v2.18.0（`ghcr.io/redtidev1918/telepost:2.18.0`） | 已部署，常驻，health 通过 |
| 共享凭据 | `PIXIVFLOW_REFETCH_TOKEN`（两端同名） | 已写入两端 Fly secrets；值从未入库/入日志 |
| TelePost 侧 | `PIXIVFLOW_REFETCH_BASE_URL=https://pixivflow-scheduler.fly.dev` | 在 `fly/deploy.telepost.toml` env |

## 生产证据

### 1. 数据库迁移（TelePost 两个 bot 的持久卷）

上线后 `init_db` 幂等迁移已生效，只读核对：

```text
tables:        ['refetch_attempts', 'refetch_seen_candidates']
lineage cols:  ['review_chain_id', 'generation', 'supersedes_review_id', 'refetch_request_id']
one-active index: True          # 数据层一链一活跃 attempt
```

存量 pending_reviews 的 `review_chain_id` / seen-history 已 bootstrap，未清空任何原队列。

### 2. 执行端 stopped → HTTPS 自动唤醒（真实令牌、零副作用）

E2E 前执行端 Machine 处于 `stopped`。以真实 `PIXIVFLOW_REFETCH_TOKEN` 对
`POST /internal/targets/nonexistent-target-xyz/refetch` 发起请求（不存在的 target 只做
验证，不创建 Slot、不产生下载）：

```text
HTTP 404 in 8.6s  {"status":"error","error":"unknown target"}
```

执行端日志（v2.20.0）同窗口证据：

```text
20:44:24.217Z External scheduler mode: internal cron disabled, awaiting authenticated schedule triggers
20:44:24.508Z Manual refetch rejected {"targetId":"nonexistent-target-xyz","status":404,"error":"unknown target"}
20:44:25.747Z schedule.trigger_unauthorized {"path":"/internal/targets/.../refetch","http_status":401}
20:44:39.232Z External worker idle; starting exit grace window {"activeSlots":0,"pendingOutbox":0}
```

即：Fly 代理把 HTTPS 请求变成唤醒 → v2.20.0 启动 → 真实令牌通过专用端点鉴权 →
目标校验拒绝 → 空闲后执行端自行退出。令牌分离成立（错误令牌 401，专用端点不认调度令牌）。

> 证明「stopped 可被 Bot 的重抓链路唤醒」这一原 bug 的修复面：第三方调度能唤醒早已成立；
> 现在**Bot 的重抓请求**走同一 HTTPS→Fly 代理→auto_start 链路，且被服务端以专用令牌验证。

### 3. 完整闭合链（按钮 → 状态机 → 唤醒 → Slot → 扫描 → 终态）

生产当前没有处于 `pending` 的审核稿（最近一批已全部决出），因此**审核群里此刻没有「重抓」
按钮可以按**；真实按钮点击是唯一的人类动作（需要有 Telegram 管理身份的审核人执行）。
闭环的每一环均由确定性测试覆盖：

- PixivFlow：76 suites / 765 tests（含 manual-slot 持久化、requestId 幂等、
  no_alternative/failed 终态经 durable outbox 回报、idle 账本对 manual Slot 的识别）。
- TelePost：624 passed / 1 skipped（含按钮状态机、同 callback 重投收敛、新一代 generation、
  一链一活跃 attempt、approve/reject 竞态 → obsolete、替换 commit-after-success、
  outcomes 端点幂等/鉴权、API 透传）。
- 部署仓库：`go test ./...`、`./scripts/validate.sh --examples`、control-plane 62 tests 全绿。

### 4. 下一个真实窗口如何自验（操作者/审核人）

1. 等一次定时投稿进入审核群（10:00 / 22:00 Asia/Shanghai）。
2. 审核群对任一待审核稿点「🔄 重抓/换一张」。
3. 期望：提示「已提交重抓」→ 群里出现受理/结果消息；执行端日志出现
   `Manual refetch` 受理行与终态；TelePost `refetch_attempts` 行收敛到
   `replaced` / `no_alternative` / `failed`；`PixivFlow 未启用，无法重抓` 不再出现。

## 处置边界

- 旧 `PIXIVFLOW_ENABLED` 仅保留为「同容器兼容模式」开关，拆分生产不使用；
  refetch 路由不读它（`docs/CONFIGURATION.md` 已写明）。
- 凭据未入库、未入日志、未回显；`PIXIVFLOW_REFETCH_TOKEN` 只在两端 Fly secrets 中。