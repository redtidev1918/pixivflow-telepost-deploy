# 调度契约：谁决定「什么时候跑」、occurrence 属于谁

> **本页是「定时投稿怎么触发、机器能不能停、重试会不会重复」的唯一权威描述。**
> 它是逻辑角色 `clock` 与 `executor` 结合部的展开：时钟只决定**何时唤醒**，执行端拥有
> **occurrence、槽位与幂等**。矩阵的 `SI-4`（同一 Pixiv 凭据最多一个活跃执行）与
> `combinationRules` 的 `second-clock`（非法）由本页守护。角色所有权见 [roles.md](./roles.md)，
> 生命周期见 [lifecycle.md](./lifecycle.md)。PixivFlow 配置字段语义以其 `CONFIG.md` 为准。

## 三句话契约

1. **时钟只决定「何时唤醒」**：把 cron 表达式映射为 schedule 标识，发一个带触发令牌的 POST，
   然后结束。它**不计算 occurrence、不换算时区、不生成槽位标识、不写任何业务表**。
2. **执行端拥有 occurrence 与槽位**：`<scheduleId>@<计划时刻>` 由执行端用自己的 cron + timezone
   解析得出；时钟不参与。
3. **重复触发是幂等的，凭据争用不是**：所以触发可以重复，时钟只能有一个。

## 时钟 provider（feature switch）

| 取值 | 谁 | 适用 | 说明 |
| --- | --- | --- | --- |
| `internal` | 执行端进程内 cron | `single-host`、`single-machine-worker-sleep`、`remote-worker` | 常驻进程到点即跑；`exitWhenIdle` 不生效 |
| `cloudflare` | `control-plane/` 薄 Worker | `split-worker`（生产）、`remote-worker` | cron → scheduleId → 一次带令牌 POST；无数据库绑定 |
| `external` | 任何能发带 Bearer 的 POST 的 cron | `split-worker`、`remote-worker` | cron-job.org / EasyCron / 自建 cron 都可以 |

矩阵 `enums.clockProvider` 是这张表的来源。**provider 可替换不需要改业务核心**：执行端只认
「受认证的 HTTP 触发」。

### 关键约束：`wake-run-exit` 必须有外部时钟

矩阵把 `wake-run-exit-without-external-clock` 列为 `invalid`：

```
executor lifecycle = wake-run-exit 且 clock = internal
→ 停止的进程无法触发自己的 cron，没有任何东西会唤醒它。
```

因此 `split-worker` 的执行端只能配 `cloudflare` 或 `external`；`internal` 只属于常驻执行端。
矩阵同时把它列在 `supportedWithLimitations` 里，因为这是最常见的误配，排查时应优先检查。

## 不变量（改调度代码时必须守住）

1. **daemon 启动 ≠ 定时触发。** 冷启动（机器被唤醒）绝不自动跑或补定时任务。
2. **外部触发幂等。** 同一 occurrence 被重复 POST（时钟重试、网络重试）只产生一个 Slot / 一组 item。
3. **一个 item 最多锁定一个作品。** `UNIQUE(slot_id, target_id)`：某次 occurrence 里同一 target
   永远只有一篇。
4. **自动重试绝不更换已选作品。** 选中 pixivId 后，下载失败、HTTP 响应丢失、进程重启、outbox
   重放都继续处理同一个作品；「换一篇」只能是显式人工操作。
5. **outbox 只做投递重试，不重跑选品。** manifest 固化了 pixivId 和文件，重试只重发。
6. **Slot 重试不重跑已成功的 cell。** resume 只补 pending / failed 的 cell。
7. **external 模式绝不回补历史 Slot。** 停机三天后被叫醒，过期的早/晚班记为 `expired`，不补
   （`catchUpMissedRuns = false`）。**catch-up 是应用级容错，wake-up 是平台级重启，两者不是一回事。**
8. **Telegram 活动不能触发 Pixiv 定时投稿。** `telegram-ingress` 的 `neverOwns` 明确包含
   「schedule triggering」。
9. **业务端作品级幂等是最后一道防线**（按 pixivId 去重），槽位账本是上游业务级防线，两层都要。
   幂等键语义见 [delivery.md](./delivery.md)。
10. **执行端 stopped 是健康状态**，不是故障：唤醒由触发请求完成，停机由执行端自己的账本完成。

## `schedulerRuntime` 字段

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

| 字段 | 含义 | 生产值（`split-worker`） |
| --- | --- | --- |
| `mode` | `internal` 进程内 cron；`external` 只在受认证触发时跑 | `external` |
| `catchUpMissedRuns` | 启动时是否补跑漏掉的时间点 | `false`（绝不回补） |
| `watchConfig` | 是否运行中热重载配置 | `false`（配置随镜像发布） |
| `trigger.port` | 触发 HTTP 服务端口 | `8090`（`internal_port` 与之匹配） |
| `trigger.graceMinutes` | 超过预定时间多久仍允许 resume | `720`（12 小时） |
| `exitWhenIdle` | 空闲即退出（仅 external 生效） | `true` |
| `idleGraceMs` | 空闲判定成立后等多久再退出（合并窗口） | `900000`（10 分钟） |
| `maxLifetimeMs` | 异常长跑的硬上限兜底 | `10800000`（3 小时） |

`watchConfig` 随预设不同：`split-worker` 是 `false`（改配置 = 重建镜像），自托管路径（
`single-host` / `remote-worker` 的 Compose / systemd）是 `true`（原子替换热重载）。详见
[upgrades.md](../operations/upgrades.md)。

## Slot 模型

一个 Slot = 一个 schedule 的一次 canonical occurrence（`<scheduleId>@<计划时刻>`，如
`bot1-daily@2026-09-08T1000`），不是「早班/晚班」固定行。每个该 schedule 的 target 在 occurrence
里占一个 item（成员在首次物化时按当时 config 快照冻结；任意数量 target，不写死 bot 数）。

| 表 | 关键列 |
| --- | --- |
| `schedule_slots` | `id(=<scheduleId>@<occurrenceStamp>)`、`schedule_id`、`occurrence_at`、`occurrence_date/label`、`timezone`、`target_ids`（成员快照 JSON）、`status`、`trigger_source`、`last_error` |
| `schedule_slot_items` | `slot_id`、`target_id`、`work_id`、`work_type`、`status`、`attempt_count`、`last_error`；**`UNIQUE(slot_id, target_id)`** |

- Slot 状态：`pending → running → success | partial | failed`（过期不补）。
- Cell 状态：`pending → selected → submitted`，或终态 `no_candidate | failed`。
- 某个 cell 没有合格候选 → `no_candidate`；只要有 cell 没成功，Slot 就是 `partial`，并在日志
  汇总里明确列出（不用去审核群数消息）。

数据库改动全自动迁移（`CREATE TABLE IF NOT EXISTS`），**不需要删库**；旧的 downloads、scheduler
历史、outbox、业务端审核库全部保留。升级前不回补历史 Slot。

## External 触发 API

执行端进程内置一个最小 HTTP 触发服务（external 模式总是启用；internal 模式可经
`schedulerRuntime.trigger.enabled=true` 额外开放作手动运维）。按 **schedule id** 触发：

```
POST /internal/schedules/{scheduleId}/run
Authorization: Bearer <SCHEDULER_TRIGGER_TOKEN>
Content-Type: application/json

{ "label": "今日早班" }      # 可选；仅人类可读来源标签，不参与身份/日期
```

| 行为 | 规则 |
| --- | --- |
| 鉴权 | 未配置 token 时 fail-closed（503）；token 错/缺失返回 401；token 不进日志/响应 |
| 按 schedule id | 未知 id 返回 404；不存在「一次 POST 跑全部 schedule」 |
| 方法 | **只注册 `POST`**。用 `GET` 探测会得到 404 而不是 401，把「鉴权生效」永久掩盖（commit `90fc4cb`） |
| 语义 | accept-then-background：落库即应答；下载在后台跑，10–40 分钟不会挂在 HTTP 连接上 |
| 幂等 | in-process singleflight + DB `UNIQUE` 收敛到同一 occurrence；已完成返回 `already_completed` |
| 不信任客户端日期 | 请求体不接受日期；未到点 425、过期 410；公开端点无法回填历史 |

与拓扑的关系：执行端是独立机器时，触发地址经平台代理（`auto_start_machines = true`）落在
`https://pixivflow-scheduler.fly.dev`，**不需要机器管理接口令牌，也不需要维护机器标识**——
唤醒就是「请求把停止的机器叫起来」。见 [flyio.md](../platforms/flyio.md)。

## 外部时钟：dumb clock

**cron → schedule id 的映射是数据驱动的**，可支持任意数量、任意 cron 的 schedule，不在代码里
写 morning/evening。

- **Cloudflare Worker（生产主时钟）**：`control-plane/`。Cron 用 UTC（北京 10:00/18:00 =
  UTC 02:00/10:00）。Worker 只做三件事：映射 cron → schedule id、带令牌 POST、记录结果。
  它**不计算 occurrence、不换算时区、不生成槽位标识、不写业务表、没有数据库绑定**。
  Secret：`SCHEDULER_TRIGGER_TOKEN`；`[vars]`：`PIXIVFLOW_TRIGGER_BASE_URL`。
  见 [cloudflare.md](../platforms/cloudflare.md)。
- **external**：任何能发带 Bearer 的 POST 的东西都行；替换时钟不需要改 PixivFlow Core。
- **绝不部署第二个时钟或看门狗。** 矩阵把 `second-clock` 列为 `invalid`：触发端本身幂等，
  重复触发只会得到同一个处置结果；而多个唤醒源会在同一 occurrence 上抢同一个 Pixiv 凭据。
  `SI-4` 要求「同一 Pixiv 凭据最多一个在跑的生产执行」。

## 执行端生命周期

```
stopped（省钱，健康 idle）
   │  时钟 POST /internal/schedules/<id>/run ─► 平台代理自动启动机器
   │                                          ─► 落库即应答，下载在后台进行
   │                                          ─► 账本空了 → idleGraceMs → exit(0) → stopped
```

- 空闲判定只读本进程的权威状态：**无进行中的槽位执行、无被当前租约持有的运行、无进行中下载、
  无处理中的投递项、无立即待处理的投递项**——全部为 0 才算空闲。
- 满足后等待 `idleGraceMs` 再 `exit(0)`。这是**合并窗口而不是超时**：10:00 与 10:10 两个
  schedule 由同一次唤醒服务，刚跑完的投递重试也能在同一窗口排空，不必付第二次冷启动。
- `maxLifetimeMs` 是异常长跑的硬上限兜底：退出前先持久化既有序列与状态、输出明确日志，
  状态不删除，下次唤醒可续跑。正常任务永不依赖它退出。
- `restart.policy = "never"`：进程退出是一次运行的预期终点，平台不得重新拉起。flyctl 只接受
  `never`（写 `no` 会被拒绝），线上 Machine 配置显示为 `no`，两者是同一件事。
- **不配置健康检查**：探测本身就是请求，会把刚刚决定收工的机器重新叫醒。

业务端相反，它**从不休眠**（`auto_stop_machines = false`、`min_machines_running = 1` 加长期
健康检查）——冷启动对用户可见。逐 preset 的生命周期表见 [lifecycle.md](./lifecycle.md)。

## 迁移与候选 fallback

- 升级不删库、不回补历史 Slot；数据库自动迁移。
- 候选是一个按热度排序的池：重复/已发布/不合格/下载失败的候选会被跳过，继续试下一个；
  池耗尽才 `no_candidate`。一旦某个候选成功并锁定 work_id，后续重试就锁定它。
- 没有任何候选时可设 `noMatchPolicy` 逐日回看并在仍为空时通知审核群；该通知与媒体投递共用
  outbox 指数退避，业务端再以 SQLite 幂等键跨重启去重（见 [delivery.md](./delivery.md)）。

## 相关页面

- 角色所有权与「绝不拥有什么」：[roles.md](./roles.md)
- 谁能睡、谁唤醒、谁决定停机：[lifecycle.md](./lifecycle.md)
- 投递与幂等键：[delivery.md](./delivery.md)
- 时钟平面怎么部署：[cloudflare.md](../platforms/cloudflare.md)
- 停机 / 唤醒参数的线上核对：[monitoring.md](../operations/monitoring.md)
