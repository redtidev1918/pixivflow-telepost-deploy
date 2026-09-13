# Cloudflare（时钟平面）

> **本页是「用 Cloudflare Worker 作为外部时钟」的权威说明。** 在 `split-worker` 下它是
> **SECONDARY** 外部时钟（`control-plane/`）：PRIMARY 是 cron-job.org，在 occurrence 准点触发，
> 本 Worker 在 occurrence +2 分钟触发。两者只 POST 同一个幂等端点，执行权威只有 PixivFlow 的
> durable slot ledger。**它不是执行权威，也不是唯一时钟。** 时钟的语义与不变量见
> [scheduling.md](../concepts/scheduling.md)，生产运维见
> [scheduling 运维手册](../operations/scheduling.md)：**Worker 只决定何时唤醒，不拥有任何状态。**

## 它做什么、绝不做什么

`control-plane/` 是一个**薄** Cloudflare Worker：

```text
cron（UTC）→ schedule id → 一次带 Bearer 的 POST → 完
```

| 做 | 绝不做 |
| --- | --- |
| 把 cron 表达式映射为 schedule id | 计算 occurrence / 槽位标识 |
| 带 `SCHEDULER_TRIGGER_TOKEN` 发 POST | 换算时区或信任客户端日期 |
| 记录触发结果 | 写任何业务表、持有数据库绑定 |

`wrangler.toml` 刻意**没有** `[[d1_databases]]`、queue、KV 或 service binding：任何需要记住
运行状态的东西都属于执行端的槽位账本。这条边界曾因「Worker 里又存了一份状态」引发过投稿
被静默丢弃的事故（见 [roles.md](../concepts/roles.md) 的历史故障一节）。

## 部署

```bash
cd control-plane
npx wrangler secret put SCHEDULER_TRIGGER_TOKEN   # 与执行端同值
npx wrangler deploy
```

`wrangler.toml` 的关键项：

```toml
[triggers]
crons = ["0 2,10 * * *", "10 2,10 * * *"]   # UTC

[vars]
PIXIVFLOW_TRIGGER_BASE_URL = "https://pixivflow-scheduler.fly.dev"
```

Cron 用 **UTC**；`src/cron-map.ts` 里同样的字符串是 schedule 映射表的键，每个都是
Asia/Shanghai 计划时间 **减 8 小时**（北京 10:00 / 18:00 → UTC 02:00 / 10:00）。
`deployment-contract.test.ts` 会在两张列表漂移时失败。

## 与执行端的契合

- POST 目标 `https://pixivflow-scheduler.fly.dev/internal/schedules/<id>/run`，被 Fly proxy
  `auto_start_machines = true` 唤醒停止的执行端机器——所以**不需要**机器管理 API 令牌或机器 id。
- 触发是「accept-then-background」：落库即应答，下载在后台跑，10–40 分钟不会挂在 HTTP 连接上。
- 端点**只注册 POST**：用 GET 探测会得到 404 而不是 401，把「鉴权生效」永久掩盖
  （见 [scheduling.md](../concepts/scheduling.md)）。

## 只用 Cloudflare 做时钟的边界

Cloudflare 在这个产品里**只是 clock provider 之一**，不是「生产架构的一部分」。它可以被任何
`external` cron 替换而不改业务核心。不要把调度状态、审核状态或任何业务数据搬回 Worker。

## 验证

```bash
npx wrangler tail           # 观察触发日志（不含凭据）
npx wrangler deployments list
```

若某天没有触发：先确认 cron 是 UTC、`PIXIVFLOW_TRIGGER_BASE_URL` 指向正确的执行端，
再确认 secret 与执行端的 `SCHEDULER_TRIGGER_TOKEN` 一致。

## 相关页面

- 调度契约：[scheduling.md](../concepts/scheduling.md)
- 执行端生命周期：[flyio.md](./flyio.md)、[lifecycle.md](../concepts/lifecycle.md)
- 凭据：[credentials.md](../concepts/credentials.md)
