# Cloudflare 时钟的废弃 secret 清理

> **本页只记录清单与计划，不记录「已经做了」。** 生产 secret 的撤销与轮换是**独立的
> operator 操作**，不属于任何代码提交；在真正执行并把时间戳写回本页之前，
> 下表的第二列永远读作「当前状态」，不是「已清理」。

## 为什么现在需要这一页

`split-worker` 收敛为「薄时钟 + 两个业务平面」之前，`control-plane/` 曾经是一个控制面：
它有自己的 D1 影子账本、Fly Machines provider、GitHub dispatch provider、凭据下发与
Telegram 路由。那次收敛（`90a350f`，2026-09-12）删除了全部这些代码，
**但 Worker 上的 secret 绑定没有跟着删**。

结果就是：一个只做「cron → schedule id → 一次带令牌的 POST」的 Worker，
身上还挂着一批它再也用不到的凭据。每一个都是不必要的暴露面。

## 生产实测：代码引用 vs 已部署绑定

**已部署**取自 `wrangler secret list --name pixivflow-control-plane`（2026-09-13，只列出
**名字**，从未读取或打印任何值）：

```text
CALLBACK_SECRET            CREDENTIAL_MASTER_KEY      DISPATCH_PAUSED
FLY_API_TOKEN              FLY_EXECUTOR_SECRET        GITHUB_DISPATCH_TOKEN
SCHEDULER_TRIGGER_TOKEN    TELEGRAM_BOT1_TOKEN        TELEGRAM_BOT2_TOKEN
TELEGRAM_WEBHOOK_SECRET
```

**代码引用**：当前 Worker 的整个 env 面只有三个名字
（`control-plane/src/index.ts` 的 `Env`：`PIXIVFLOW_TRIGGER_BASE_URL`、
`SCHEDULER_TRIGGER_TOKEN`、`DISPATCH_FETCH`），其中只有一个 secret —— 见
`control-plane/wrangler.toml` 的注释与 `control-plane/src/dispatch.ts` 的 fail-closed 分支。

因此：**10 个已部署绑定里，9 个在当前代码中零引用，1 个在用。**

| Secret | 当前代码引用 | 最后被引用的提交 | 建议动作 | 理由 | 撤销影响 |
| --- | --- | --- | --- | --- | --- |
| `SCHEDULER_TRIGGER_TOKEN` | **在用** | —（现行） | **保留** | 两个时钟与人工补触发都用它；scheduler-only 凭据 | 撤销 = 两个时钟全部 401 |
| `DISPATCH_PAUSED` | 无 | `90a350f` 2026-09-12 | **撤销** | 它从来只是个 `[vars]` 开关，不是 secret | 无 |
| `FLY_API_TOKEN` | 无 | `90a350f` 2026-09-12 | **轮换 + 撤销** | Fly provider 已删除，新架构不需要 Fly 控制权 | 无（代码侧）；轮换是防范性的 |
| `GITHUB_DISPATCH_TOKEN` | 无 | `90a350f` 2026-09-12 | **撤销**，并在 GitHub 侧**吊销 PAT** | GitHub dispatch provider 与对应 workflow 已删除 | 无；但删 Worker 绑定**不会**吊销 PAT |
| `CALLBACK_SECRET` | 无 | `90a350f` 2026-09-12 | **撤销** | 接收它的路由（`routes/control.ts`、`routes/telegram.ts`）已删除 | 无 |
| `CREDENTIAL_MASTER_KEY` | 无 | `90a350f` 2026-09-12 | **撤销，但必须先确认旧 D1 已不存在** | 它是旧 D1 里凭据密文的 AES-GCM 密钥 | **可能是数据销毁**：旧 D1 中残留密文将永久无法解密 |
| `FLY_EXECUTOR_SECRET` | 无（仅 CHANGELOG 散文字样） | `6371bf8`（散文）／代码为 `90a350f` | **撤销** | `fly/executor/bootstrap.sh` 已删除 | 无 |
| `TELEGRAM_BOT1_TOKEN` | 无 | `90a350f` 2026-09-12 | **撤销 + 轮换** | 曾是已部署的 Worker secret，且其值曾进入公开提交 | 无（代码侧）；**吊销 bot token 会让 TelePost 掉线**，见下 |
| `TELEGRAM_BOT2_TOKEN` | 无 | `90a350f` 2026-09-12 | **撤销 + 轮换** | 同上 | 同上 |
| `TELEGRAM_WEBHOOK_SECRET` | 无 | `90a350f` 2026-09-12 | **撤销** | 旧 `/telegram/webhook` 路由已删除，接收方不存在 | 无 |

## 两个必须说清楚的边界

### 1. 删 Worker 绑定 ≠ 吊销凭据

`wrangler secret delete` 只移除 Worker 上的绑定。它**不会**让那个 Telegram bot token
失效，也**不会**让那个 GitHub PAT 失效。真正的撤销发生在**签发方**：

- Telegram：BotFather 的 `/revoke`；
- GitHub：Settings → Developer settings → Personal access tokens → revoke；
- Fly：`fly tokens list` / `fly tokens revoke`。

### 2. `TELEGRAM_*` 的轮换顺序不能反

TelePost 现在是 Telegram 凭据的**唯一**所有者（SI-1）。因此：

```text
BotFather 吊销旧 token
        ↓
立刻更新 TelePost 的 BOT1_TOKEN / BOT2_TOKEN（fly secrets set）
        ↓
验证 scripts/verify-webhooks.sh
```

**先吊销再更新 = 投稿机器人掉线。** 这两步之间的窗口要尽量短，并且必须在同一个操作里做完。
顺序反过来（先更新 TelePost 再吊销）会短暂留下两个有效 token，那是可接受的权衡方向。

### 3. PR 与 issue 不是执行通道

本页的清单是**代码侧取证**的产物。执行必须是一条独立、明确、被记录的生产操作，
不能夹在任何一次功能提交里。

## 轮换/撤销序列（**未执行**）

以下内容**没有任何一条被执行过**。本文档的取证只用了 `wrangler secret list`（只读，只列名字）
与只读的 git 历史检索；没有运行过 `wrangler secret delete` / `put`，也没有读取过任何 secret 值。

```bash
# 0) 先建立真实清单（需要认证）
wrangler whoami
wrangler secret list --name pixivflow-control-plane
#    与上面的表比对；如果不一致，本页的计划必须重做。

# 1) 顺序约束：确认没有部署在进行中。
#    `wrangler deploy` 会按 wrangler.toml 整体重写绑定集合，
#    与 secret 删除并发可能产生竞态。
gh run list --limit 5

# 2) 先在签发方撤销（见上：删绑定不等于吊销）
#    Telegram: BotFather /revoke → 立刻更新 TelePost 的 Fly secrets
#    GitHub:   吊销 PAT
#    Fly:      fly tokens list / fly tokens revoke <id>

# 3) 删除 Worker 上确凿无用的绑定
wrangler secret delete DISPATCH_PAUSED          --name pixivflow-control-plane
wrangler secret delete FLY_EXECUTOR_SECRET      --name pixivflow-control-plane
wrangler secret delete GITHUB_DISPATCH_TOKEN    --name pixivflow-control-plane
wrangler secret delete CALLBACK_SECRET          --name pixivflow-control-plane
wrangler secret delete TELEGRAM_WEBHOOK_SECRET  --name pixivflow-control-plane
wrangler secret delete TELEGRAM_BOT1_TOKEN      --name pixivflow-control-plane
wrangler secret delete TELEGRAM_BOT2_TOKEN      --name pixivflow-control-plane
wrangler secret delete FLY_API_TOKEN            --name pixivflow-control-plane

# 4) CREDENTIAL_MASTER_KEY —— 唯一一条可能销毁数据的删除，先证明旧 D1 不在了
wrangler d1 list        # 若仍存在且仍有行：停下。
wrangler secret delete CREDENTIAL_MASTER_KEY --name pixivflow-control-plane

# 5) 复核
wrangler secret list --name pixivflow-control-plane    # 只剩 SCHEDULER_TRIGGER_TOKEN
curl -sS https://pixivflow-control-plane.redtidev1918.workers.dev/health
#    期望 ok=true / tokenConfigured=true；触发链路不读任何被删的名字。
```

值**绝不**作为命令行参数传入（`ps` 可见、且进 shell history）；用 `wrangler secret put`
的交互式输入。

## 独立的 hardening 项：随机公网请求会唤醒执行端

与上面的 secret 清理**无关**，但同样属于「不必要的暴露面」：

```text
fly/deploy.pixivflow.toml
  auto_start_machines = true
  auto_stop_machines  = false
  min_machines_running = 0
```

`pixivflow-scheduler.fly.dev` 是公网可达的，且**没有任何健康检查**（刻意如此）。
因此**任何**公网 HTTP 请求 —— 包括一次端口扫描 —— 都会让平台冷启动执行端 Machine，
而平台**不会**把它停回去（停机权只属于 PixivFlow 自己的账本）。

本页记录这不是为了现在改它：这三个值被
`control-plane/test/deployment-contract.test.ts` 与 `architecture_docs_test.go` 双重守护，
改动属于部署拓扑决策，不属于调度可观测性工作。它是一条**独立**的后续项，
不要用它阻塞冗余时钟的落地。

现场证据（2026-09-13）：为验证 `scripts/trigger-schedule.sh --dry-run` 的连通性对
`https://pixivflow-scheduler.fly.dev/health` 发过一次 GET，执行端 Machine 随即被冷启动 ——
一次无凭据的只读请求就够了。
