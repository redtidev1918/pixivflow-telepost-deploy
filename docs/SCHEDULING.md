# 调度模式与 Fly 省钱部署（Slot 模型）

> 这是「定时投稿怎么触发、机器能不能停机、重试会不会重复」的单一事实源。
> 配置项默认值以 [PixivFlow CONFIG.md](https://github.com/redtidev1918/PixivFlow) 为准。

## 一句话

- **VPS / Docker / systemd / 想省心的 Fly**：用 **internal** 调度（进程常驻，内部 cron 到点跑）。
- **低流量 Fly 想省钱（1×512MB，平时停机）**：用 **external** 调度——机器平时 stopped，
  Telegram webhook 或外部时钟（Cloudflare Cron）在 10:00/18:00 发一个**受认证的 HTTP 请求**
  把机器叫醒并同步跑完一个 **Slot**；跑完空闲后 Fly 自动停机。

## 不变量（改调度代码时必须守住）

1. **daemon 启动 ≠ 定时触发**。冷启动（用户发 Telegram 消息叫醒机器）绝不自动跑/补定时任务。
2. **外部触发幂等**。同一个 Slot 被重复 POST（Cloudflare + GitHub watchdog + 网络重试）只产生一个 Slot。
3. **一个 cell 最多锁定一个作品**。`UNIQUE(slot_id, target_id)`：某天早班的 bot1 小说永远只有一篇。
4. **自动重试绝不更换已选作品**。选中 pixivId 后，下载失败、HTTP 响应丢失、进程重启、outbox
   重放都继续处理同一个作品；「换一篇」只能是显式人工操作。
5. **outbox 只做投递重试，不重跑选品**。outbox manifest 固化了 pixivId 和文件，重试只重发。
6. **Slot 重试不重跑已成功的 cell**。resume 只补 pending/failed 的 cell。
7. **external 模式绝不回补历史 Slot**。停机三天后被叫醒，过期的早/晚班记为 expired，不补。
8. **Telegram 活动不能触发 Pixiv 定时投稿**。
9. **TelePost 作品级幂等是最后一道防线**（按 pixivId 去重），Slot 账本是上游业务级防线，两层都要。
10. **autosleep 模式下 stopped 是健康状态**，不是故障。

## Deployment mode 决策树

```
你用 Fly.io 吗？
├─ 否
│   ├─ 有 Docker → Docker Compose（internal cron）
│   └─ 不想 Docker → systemd / 裸机（internal cron）
└─ 是
    ├─ 低流量 + 想省钱 + 能接受冷启动几秒 → Fly Autosleep（external 触发，1×512MB）
    ├─ 想最省心、不介意常驻成本        → Fly Always-on（internal cron，1×512MB）
    └─ 要服务隔离 / 512MB 实测不稳      → Fly Split（PixivFlow 256 常驻 + TelePost 512 休眠）
```

| 模式 | 机器 | 闲置成本 | 维护复杂度 | 冷启动 | 外部时钟 | 内部 cron | 适用 |
|---|---|---|---|---|---|---|---|
| Fly Autosleep | 1×512 | 最低（停机） | 中（配外部时钟） | 有 | 要 | 否 | 低流量个人 Bot |
| Fly Always-on | 1×512 | 中（常驻） | 最低 | 无 | 否 | 是 | 省心、要秒回 |
| Fly Split | 256 常驻 + 512 休眠 | 中 | 较高（两机/卷/Flycast） | 有 | 否 | 是（在 256 机） | 隔离 / 512 不够 |
| Docker Compose | 1 台 VPS | VPS 成本 | 低 | 无 | 否 | 是 | 普通 VPS |
| systemd | 1 台 VPS | VPS 成本 | 中 | 无 | 否 | 是 | 已有 Linux、不用 Docker |

成本主要来自：运行中的 Machine compute（停机即停计 RAM）、持久卷、专用 IPv4（若用）、出站流量。
估算：`月 compute ≈ 小时单价 × 每天活跃小时 × 30`。金额随 Fly 定价变化，请按当月账单核对。

## Scheduler mode：internal vs external

在 PixivFlow `config.json` 的 `schedulerRuntime`：

```json
"schedulerRuntime": {
  "mode": "external",
  "trigger": { "port": 8090, "graceMinutes": 90 },
  "watchConfig": true,
  "reloadDebounceMs": 500,
  "queueLimit": 2
}
```

- `mode: "internal"`（默认）：进程内注册 cron，到点触发；启动时可选 catch-up
  （`catchUpMissedRuns`，默认 true；VPS/always-on 部署窗口漏跑自愈用）。
- `mode: "external"`：**不注册 cron、启动不 catch-up**。只在收到受认证的 HTTP 触发时跑。
- `trigger.graceMinutes`：Slot 预定时间后多长时间内仍允许 resume（默认 90，覆盖 4-cell 串行耗时）；
  超过即 expired，不回补。

## Slot 模型

一个 Slot = 一个业务批次（`2026-09-08:morning` / `:evening`）。每个启用的 target 在 Slot 里
占一个 cell（当前生产 4 个：bot1/bot2 × 插图/小说；按 config 动态生成，不写死 bot 数）。

- `schedule_slots`：`id(=date:name)`、`slot_date`、`slot_name`、`schedule_id`、`status`、时间戳、`last_error`。
- `schedule_slot_items`：`slot_id`、`target_id`、`work_id`、`work_type`、`status`、`attempt_count`、
  `last_error`、时间戳；**`UNIQUE(slot_id, target_id)`**。

Slot 状态：`pending → running → success | partial | failed`（过期不补）。
Cell 状态：`pending → selected → submitted`，或终态 `no_candidate | failed`。
某个 cell 没有合格候选 → `no_candidate`；只要有 cell 没成功，Slot 就是 `partial`，并在日志汇总里
明确列出（不用去审核群数消息）。

## External 触发 API

PixivFlow scheduler 进程内置一个最小 HTTP 服务（external 模式才启用）：

```
POST /internal/schedules/run
Authorization: Bearer <SCHEDULER_TRIGGER_TOKEN>
Content-Type: application/json

{ "slot": "morning" }     # 或 "evening"；省略则按当前时间推断
```

- **必须认证**：未配置 token 时端点 fail-closed（503）；token 错返回 401。
- **同步执行**：请求保持打开直到整个 Slot 跑完——这个 HTTP 连接本身就是「保活租约」，
  防止 Fly 在任务中途认为空闲而停机。
- **幂等**：重复调用命中同一 Slot 行，已完成返回 `already_completed`，不重复投稿。
- **不信任客户端日期**：只接受当前时间窗口（grace）内的 morning/evening。
- 合一台部署时，TelePost 的 8080 路由把公网 `/internal/*` 反代到容器内 PixivFlow 的 8090
  （`PIXIVFLOW_TRIGGER_PORT`，默认 8090），所以外部时钟只需要打公网 Fly 域名。

## 外部时钟（dumb clock）

核心业务不绑定任何 provider，只认「受认证的 HTTP 触发」。官方提供两个适配器模板：

- **Cloudflare Worker（推荐主时钟）**：`scheduler/cloudflare/`。Cron 用 UTC，
  北京 10:00/18:00 = UTC 02:00/10:00。Worker 只 POST Slot，不碰 Pixiv、不存状态。
  Secret：`SCHEDULE_TRIGGER_URL`、`SCHEDULE_TRIGGER_TOKEN`。
- **GitHub Actions（可选看门狗）**：`scheduler/github/slot-watchdog.yml`，北京 10:10/18:10
  再 POST 一次同一 Slot。成功则 `already_completed`，失败则 resume。不是主时钟。
- 也可以用 cron-job.org / EasyCron / 自己 VPS 的 cron：任何能发带 Bearer 的 POST 的东西都行。

## Fly Autosleep 生命周期

```
stopped（省钱，健康）
   │  Telegram webhook ─────────────► auto-start ─► TelePost 处理投稿 ─► idle ─► stop
   │  Cloudflare POST /internal/run ─► auto-start ─► PixivFlow 跑 Slot（同步）─► idle ─► stop
```

- 冷启动那几秒由 Fly Proxy 排队吸收：Telegram webhook 会重试，PixivFlow outbox 也会重试，请求不丢。
- Telegram 叫醒机器只处理 Telegram，**不会**顺带跑定时投稿（不变量 1、8）。
- 不再用「持续 ping /health 等内部 cron 恰好到点」这种方式（见下文 Legacy）。

## 迁移与候选 fallback

- 数据库改动全自动迁移（`CREATE TABLE IF NOT EXISTS`），**不需要删库**；旧的 downloads、
  scheduler 历史、outbox、TelePost 审核库全部保留。升级前不回补历史 Slot。
- 候选是一个按热度排序的池：重复/已发布/不合格/下载失败的候选会被跳过，继续试下一个；
  池耗尽才 `no_candidate`。一旦某个候选成功并锁定 work_id，后续重试就锁定它。
