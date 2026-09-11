# 调度模式与 Fly 生命周期（Slot 模型）

> 这是「定时投稿怎么触发、机器能不能停机、重试会不会重复」的单一事实源。
> 生产拓扑与三仓库职责边界以 [架构与信任边界](ARCHITECTURE.md) 为唯一权威；本文件只展开调度细节。
> 配置项默认值以 [PixivFlow CONFIG.md](https://github.com/redtidev1918/PixivFlow) 为准。

## 一句话

- **VPS / Docker / systemd / 想省心的 Fly**：用 **internal** 调度（进程常驻，内部 cron 到点跑）。
- **生产 Fly（低流量、想省钱）**：用 **external** 调度——PixivFlow 机器平时 stopped，
  Cloudflare 薄时钟在 10:00/18:00（UTC 02:00/10:00）发一个**受认证的 HTTP 请求**把机器唤醒；
  触发端在 occurrence 落库后立即应答，下载在后台跑，跑完后由 PixivFlow 自己的账本决定退出。

## 不变量（改调度代码时必须守住）

1. **daemon 启动 ≠ 定时触发**。冷启动（机器被唤醒）绝不自动跑/补定时任务。
2. **外部触发幂等**。同一 occurrence 被重复 POST（时钟重试、网络重试）只产生一个 Slot/一组 item。
3. **一个 item 最多锁定一个作品**。`UNIQUE(slot_id, target_id)`：某次 occurrence 里同一 target 永远只有一篇。
4. **自动重试绝不更换已选作品**。选中 pixivId 后，下载失败、HTTP 响应丢失、进程重启、outbox
   重放都继续处理同一个作品；「换一篇」只能是显式人工操作。
5. **outbox 只做投递重试，不重跑选品**。outbox manifest 固化了 pixivId 和文件，重试只重发。
6. **Slot 重试不重跑已成功的 cell**。resume 只补 pending/failed 的 cell。
7. **external 模式绝不回补历史 Slot**。停机三天后被叫醒，过期的早/晚班记为 expired，不补
   （`catchUpMissedRuns = false`）。**catch-up 是应用级容错，wake-up 是平台级重启，两者不是一回事。**
8. **Telegram 活动不能触发 Pixiv 定时投稿**。
9. **TelePost 作品级幂等是最后一道防线**（按 pixivId 去重），Slot 账本是上游业务级防线，两层都要。
10. **执行端 stopped 是健康状态**，不是故障：唤醒由触发请求完成，停机由执行端自己的账本完成。

## Deployment mode 决策树

```
你用 Fly.io 吗？
├─ 否
│   ├─ 有 Docker → Docker Compose（internal cron，单机所有角色）
│   └─ 不想 Docker → systemd / 裸机（internal cron）
└─ 是
    └─ 生产拓扑 = 两个独立 App（PixivFlow 平时 stopped + TelePost 常驻）
```

| 部分 | 机器 | 闲置成本 | 唤醒 | 停机 | 适用 |
|---|---|---|---|---|---|
| PixivFlow 执行端 | 1×512（独立卷） | 最低（停机） | Fly proxy：收到认证触发即启动 | 自身账本空了 → `exit(0)` | 生产定时投稿 |
| TelePost 业务端 | 1×512（独立卷） | 中（常驻） | 从不休眠 | 从不停止 | 用户投稿 / 审核 / 发布 |
| Docker Compose / systemd | 1 台 VPS | VPS 成本 | 不适用（常驻） | 不适用（常驻） | 自托管 |

**没有平台侧 auto-stop 这一档。** 触发端在 occurrence 落库后立即应答，代理眼里连接早已空闲，
而下载还在跑（实测 10–40 分钟）；按平台空闲推断停机就会把批次拦腰砍断。停机的唯一决策者是
PixivFlow 自己的账本（见下文「执行端生命周期」）。成本主要由「PixivFlow 平时不运行」贡献。

## Scheduler mode：internal vs external

在 PixivFlow 配置的 `schedulerRuntime`：

```json
"schedulerRuntime": {
  "mode": "external",
  "catchUpMissedRuns": false,
  "watchConfig": false,
  "trigger": { "port": 8090, "graceMinutes": 720 },
  "exitWhenIdle": true,
  "idleGraceMs": 900000,
  "maxLifetimeMs": 10800000
}
```

- `mode: "internal"`（默认）：进程内注册 cron，到点触发；启动时可选 catch-up
  （`catchUpMissedRuns`；VPS/常驻部署漏跑自愈用）。此模式下 `exitWhenIdle` 不生效。
- `mode: "external"`：**不注册 cron、启动不 catch-up**。只在收到受认证的 HTTP 触发时跑。
- `trigger.graceMinutes`：Slot 预定时间后多长时间内仍允许 resume（生产为 720，覆盖跨时区的
  重试与人工排障窗口）；超过即 expired，不回补。
- `exitWhenIdle` / `idleGraceMs` / `maxLifetimeMs`：仅 external 模式下的生命周期参数，见下文。

## Slot 模型

一个 Slot = 一个 schedule 的一次 canonical occurrence（`<scheduleId>@<计划时刻>`，如
`bot1-daily@2026-09-08T1000`），不是「早班/晚班」固定行。每个该 schedule 的 target 在 occurrence
里占一个 item（成员在首次物化时按当时 config 快照冻结；任意数量 target，不写死 bot 数）。

- `schedule_slots`：`id(=<scheduleId>@<occurrenceStamp>)`、`schedule_id`、`occurrence_at`、
  `occurrence_date/label`、`timezone`、`target_ids`（成员快照 JSON）、`status`、`trigger_source`、
  时间戳、`last_error`。
- `schedule_slot_items`：`slot_id`、`target_id`、`work_id`、`work_type`、`status`、`attempt_count`、
  `last_error`、时间戳；**`UNIQUE(slot_id, target_id)`**。

Slot 状态：`pending → running → success | partial | failed`（过期不补）。
Cell 状态：`pending → selected → submitted`，或终态 `no_candidate | failed`。
某个 cell 没有合格候选 → `no_candidate`；只要有 cell 没成功，Slot 就是 `partial`，并在日志汇总里
明确列出（不用去审核群数消息）。

## External 触发 API

PixivFlow scheduler 进程内置一个最小 HTTP 触发服务（external 模式总是启用；internal
模式可经 `schedulerRuntime.trigger.enabled=true` 额外开放作手动运维）。按 **schedule id**
触发，服务端用该 schedule 自己的 cron+timezone 解析 canonical occurrence：

```
POST /internal/schedules/{scheduleId}/run
Authorization: Bearer <SCHEDULER_TRIGGER_TOKEN>
Content-Type: application/json

{ "label": "今日早班" }      # 可选；仅人类可读来源标签，不参与身份/日期
```

- **必须认证**：未配置 token 时端点 fail-closed（503）；token 错/缺失返回 401。token 不进日志/响应。
- **按 schedule id**：未知 id 返回 404；不存在「一次 POST 跑全部 schedule」，每个 schedule 独立触发。
- **受理后立即返回（accept-then-background）**：落库即应答，处置语义为
  已受理 / 运行中 / 已完成 / 拒绝。下载在后台进行——10–40 分钟的长任务不会挂在 HTTP 连接上，
  连接超时也不会被误判成一次失败。
- **幂等**：重复/并发调用经 in-process singleflight + DB `UNIQUE` 收敛到同一 occurrence，
  已完成返回 `already_completed`，不重复投稿。因此重复触发（时钟重试、看门狗）是安全的。
- **不信任客户端日期**：请求体不接受日期；只接受当前 grace 窗口内的触发。未到点 425、过期 410，
  公开端点无法回填历史。
- 与生产拓扑的关系：**执行端是独立 App**，触发地址经 Fly proxy（`auto_start_machines = true`）
  落在 `https://pixivflow-scheduler.fly.dev`，不需要机器管理接口令牌，也不需要维护机器标识。

## 外部时钟（dumb clock，可替换）

核心业务不绑定任何 provider，只认「受认证的 HTTP 触发」。**cron → schedule id 的映射是数据驱动的**，
可支持任意数量/任意 cron 的 schedule，不在代码里写 morning/evening。

- **Cloudflare Worker（生产主时钟）**：`control-plane/`。Cron 用 UTC（北京 10:00/18:00 =
  UTC 02:00/10:00）。Worker 只做三件事：把触发的 cron 映射到 schedule id → 带 `SCHEDULER_TRIGGER_TOKEN`
  POST `/internal/schedules/<id>/run` → 记录结果。它**不计算 occurrence、不换算时区、不生成槽位标识、
  不写业务表、没有数据库绑定**；历史上那套影子账本/审核状态机已经删除。
  Secret：`SCHEDULER_TRIGGER_TOKEN`；`[vars]`：`PIXIVFLOW_TRIGGER_BASE_URL`。
- 也可以用 cron-job.org / EasyCron / 自己 VPS 的 cron：任何能发带 Bearer 的 POST 的东西都行；
  替换时钟**不需要**改 PixivFlow Core。
- **不要部署第二个时钟或看门狗**。触发端本身幂等，重复触发只会得到同一个处置结果；而多个
  唤醒源会在同一 occurrence 上抢同一个 Pixiv 凭据。时钟只有一个负责人。

## 执行端生命周期

```
stopped（省钱，健康 idle）
   │  Cloudflare 时钟 POST /internal/schedules/<id>/run ─► Fly proxy 自动启动机器
   │                                                     ─► 落库即应答，下载在后台进行
   │                                                     ─► 账本空了 → idleGraceMs → exit(0) → stopped
```

- 触发请求一到，Fly proxy 先启动已停止的机器再转发（`auto_start_machines = true`）。
- 空闲判定只读本进程的权威状态：**无进行中的槽位执行、无被当前租约持有的运行、无进行中下载、
  无处理中的投递项、无立即待处理的投递项**——全部为 0 才算空闲。
- 满足后等待 `idleGraceMs`（生产 10 分钟）再 `exit(0)`。这是**合并窗口**而不是超时：
  10:00 与 10:10 两个 schedule 由同一次唤醒服务，刚跑完的投递重试也能在同一窗口内排空，
  不必付第二次冷启动。
- `maxLifetimeMs`（生产 3 小时）是**异常长跑的硬上限兜底**：触发时先持久化既有序列与状态、
  输出明确日志再退出，状态不删除，下次唤醒可续跑。正常任务永不依赖它退出。
- `restart policy = "no"`：进程退出就是一次运行的预期终点，平台不得重新拉起它。
- **不配置健康检查**：探测本身就是请求，会把刚刚决定收工的机器重新叫醒，形成停不下来的循环。

TelePost 相反，它**从不休眠**：`auto_stop_machines = false`、`min_machines_running = 1`，
并保留长期健康检查——冷启动对用户是可见的（私聊投稿像是坏了）。

## 迁移与候选 fallback

- 数据库改动全自动迁移（`CREATE TABLE IF NOT EXISTS`），**不需要删库**；旧的 downloads、
  scheduler 历史、outbox、TelePost 审核库全部保留。升级前不回补历史 Slot。
- 候选是一个按热度排序的池：重复/已发布/不合格/下载失败的候选会被跳过，继续试下一个；
  池耗尽才 `no_candidate`。一旦某个候选成功并锁定 work_id，后续重试就锁定它。
