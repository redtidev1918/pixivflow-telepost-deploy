# `split-worker` —— 分离执行端（当前生产）

| | |
| --- | --- |
| 支持等级 | **Stable** |
| 实现状态 | 已实现、已测试、**在生产运行** |
| 平台 | Fly.io（参考实现）；拓扑本身不绑定平台 |
| 一句话 | `executor` 与 `publisher` 各一台机器、各一个卷；`executor` 平时停止，由外部时钟经平台代理唤醒，账本空了自行退出。 |

机器可读定义见
[`architecture-matrix.json` 的 `presets.split-worker`](https://github.com/redtidev1918/pixivflow-telepost-deploy/blob/main/docs/reference/architecture-matrix.json)。

**这是 Fly.io 上推荐的部署拓扑，但不是唯一的部署拓扑。** 与它并列的还有
[`single-host`](single-host.md)、[`single-machine-worker-sleep`](single-machine-worker-sleep.md)
与 [`remote-worker`](remote-worker.md)。选择依据见
[choose-architecture.md](../getting-started/choose-architecture.md)。

---

## 适合谁

- 最在意 Fly.io 计算费用的人：不跑任务的时间不产生计算账单。
- 最在意可靠性的人：`executor` 崩溃或 OOM 不会打到用户可见的投稿链路。
- 希望凭据边界最干净的人：执行机器里没有任何 Telegram 凭据。
- 已经有多台设备或愿意接受三个组件（两个 Fly 应用 + 一个时钟）的人。

如果你只有一台机器、或者不想维护外部时钟，看 [`single-host`](single-host.md)。

---

## 拓扑

```text
PRIMARY    cron-job.org        在 occurrence 准点触发
        ─┐
         ├─► 同一个受认证的幂等 POST /internal/schedules/{scheduleId}/run
SECONDARY  ─┘   Cloudflare Cron（occurrence + 2 分钟）
        │
        ▼
Fly Proxy（自动唤醒已停止的机器）
        │
        ▼
Fly App: pixivflow-scheduler        独立机器 + 独立卷，平时 stopped
  executor  ── durable slot ledger = 唯一的执行权威
        │  既有 httpMultipart 投递 + 稳定幂等键
        ▼
Fly App: telesubmit-multi-bot        常驻
  publisher + telegram-ingress
        │  人工批准后
        ▼
Telegram 频道
```

### 时钟拓扑：PRIMARY / SECONDARY

`split-worker` 的生产运行**两个独立的外部时钟**，作用于**同一套** schedule set：

| | provider | 触发时刻（Asia/Shanghai） | 触发表达式（UTC） |
| --- | --- | --- | --- |
| **PRIMARY** | cron-job.org | occurrence 准点：`bot1-daily` 10:00 / 22:00，`bot2-daily` 10:10 / 22:10 | `bot1` `0 2,14 * * *`；`bot2` `10 2,14 * * *` |
| **SECONDARY** | Cloudflare Cron（`control-plane/`） | occurrence + 2 分钟 | `bot1` `2 2,14 * * *`；`bot2` `12 2,14 * * *` |

两处声明的机器可读来源是 `control-plane/src/cron-map.ts`（`SECONDARY_OFFSET_MINUTES = 2`）
与 `control-plane/wrangler.toml`；`control-plane/test/redundant-clock.test.ts` 会因为
「secondary ≠ primary + 文档化偏移」而失败。

- **执行权威只有一个：PixivFlow 的 durable slot ledger。** 两个时钟都不计算 occurrence、
  不持有状态、不生成 slot id、不调用 TelePost、不控制 Fly Machine。它们只发出一次幂等触发。
- **谁后到就在前一个创建的 slot 上收敛。** 重复触发是预期的、安全的：它得到的是同一个
  disposition，不会跑第二次。
- **`executor` 生命周期仍是 `wake-run-exit`**：唤醒 = 触发请求经平台代理；停机 = executor 自己的账本。
  这一点与时钟有几个**无关**。

> **PRIMARY / SECONDARY 是 operational provider assignment，不是新的 deployment preset。**
> preset 集合仍然只有四个。**provider ≠ architecture**：换时钟 provider 不改变角色所有权、
> 不改变拓扑形状、不需要改业务核心。选 provider 是运维决策，落在
> [部署契约](../reference/deployment-contract.md) 与 `control-plane/` 里，不落在 preset 定义里。

为什么偏移是 2 分钟、为什么必须为**正**、为什么 primary 不是 Cloudflare：见
[2026-09-13 漏跑事故](../incidents/2026-09-13-schedule-trigger-miss.md)。

| 平面 | 部署单元 | 自己拥有的状态 | 绝不拥有 |
| --- | --- | --- | --- |
| `clock` | PRIMARY `cron-job.org` + SECONDARY `control-plane/`（Worker `pixivflow-control-plane`） | cron → schedule id 映射、一个触发令牌 | occurrence、槽位、凭据、审核、发布、Telegram |
| `executor` | `fly/deploy.pixivflow.toml`（app `pixivflow-scheduler`） | 槽位账本、执行租约、下载缓存、投递 outbox、Pixiv 凭据 | **Telegram 令牌、频道、审核决定** |
| `publisher` + `telegram-ingress` | `fly/deploy.telepost.toml`（app `telesubmit-multi-bot`） | 用户会话、投稿幂等键、审核队列、发布记录、Telegram 令牌 | Pixiv 登录、下载、槽位调度 |

`fly/deploy.pixivflow.toml` 与 `fly/deploy.telepost.toml` 是本仓库**唯一的两份 Fly 拓扑来源**。
`control-plane/test/deployment-contract.test.ts` 会在出现第三份 Fly 配置、cron 与映射不一致、
或卷/停机参数被改动时失败。历史上正是「两份都像权威的配置」把混部拓扑带了回来。

---

## 资源要求

| 单元 | Fly 机器 | 说明 |
| --- | --- | --- |
| `clock-edge` | 0（Cloudflare Workers，SECONDARY） | 免费额度内；无数据库绑定、无状态 |
| `clock-primary` | 0（cron-job.org，PRIMARY） | 第二个独立 provider、独立故障域；只在控制台里配置，本仓库不注册它 |
| `worker-machine` | 1 × 512 MiB | 运行时内存由 `NODE_OPTIONS=--max-old-space-size=384` 与 `download.concurrency=1` 约束 |
| `service-machine` | 1 × 512 MiB | 双 Bot；`SEARCH_ENABLED=false`、`DB_CACHE_KB=1024` |

> 当前 `fly/deploy.pixivflow.toml` 与 `fly/deploy.telepost.toml` **没有声明 `[vm] memory_mb`**，
> 因此机器规格由 Fly 侧决定。文档与历史配置里的 512 MiB 是设计意图，不是配置文件里的硬约束；
> 核对真实规格请用 `fly machine list`。资源档位见
> [performance.md](../operations/performance.md)。

两个卷都不能共享：每个应用各自 `fly volumes create`，`--ha=false` 是必需的
（一台机器才能挂一个卷）。

---

## 生命周期

| 角色 | 生命周期 | 谁唤醒 | 谁决定停机 |
| --- | --- | --- | --- |
| `clock` | `always-on` | 不适用 | 不适用（无状态） |
| `executor` | `wake-run-exit` | 触发请求经 Fly Proxy 自动启动已停止的机器 | **`executor` 自己的账本**（`exitWhenIdle`） |
| `publisher` | `always-on` | 从不休眠 | 从不停止 |
| `telegram-ingress` | `always-on` | 从不休眠 | 从不停止 |

```text
stopped（省钱，健康 idle）
   │  时钟 POST /internal/schedules/<id>/run ─► Fly Proxy 启动机器
   │                                          ─► 落库即应答，下载在后台进行
   │                                          ─► 账本空了 → idleGraceMs → exit(0) → stopped
```

三个生命周期决定分散在三处，**三处都必需**：

1. **默认停止**：空闲的执行端不应计费、不应占内存。
2. **被时钟唤醒**：`auto_start_machines = true`，因此触发链路里不需要机器管理接口令牌，
   也不需要维护机器标识。
3. **自己退出**：`schedulerRuntime.exitWhenIdle = true`；`restart.policy = 'never'`
   是这个决定的另一半——有重启策略的机器会立刻回来，`stopped` 状态永远到不了。

参数：`idleGraceMs = 900000`（10 分钟，合并相邻调度，同时排空刚跑完的投递重试）、
`maxLifetimeMs = 10800000`（3 小时异常长跑兜底）。

**`publisher` 相反，它从不休眠。** 冷启动对用户是可见的（私聊投稿像坏了），
所以 `auto_stop_machines = false`、`min_machines_running = 1`，并保留长期健康检查。

### 三条禁止事项

| 禁止 | 原因 |
| --- | --- |
| 给 `executor` 配健康检查 | 探测本身就是请求。Fly 的代理会唤醒一台刚决定收工的机器，`stopped` 永远到不了。 |
| 用平台 auto-stop 停 `executor` | 触发端落库即应答，代理眼里连接早已空闲，而下载还在跑（实测 10–40 分钟）。按空闲推断停机会把批次拦腰砍断。 |
| 部署第二个 **PRIMARY** 时钟（或第二个调度器、第二个执行权威） | 触发端本身幂等，所以**延迟的重复触发无害**；危险的是第二套 schedule 定义或第二份执行状态——那才会在同一个 occurrence 上争抢同一个 Pixiv 凭据。PRIMARY + 延迟 SECONDARY 的冗余外部时钟经同一个 durable slot 收敛，**不在此列**。 |

---

## 状态位置

| 状态 | 位置 | 丢失后果 |
| --- | --- | --- |
| PixivFlow 槽位账本、slot item | `pixivflow_data` 卷 `/app/data` | 已选作品与 occurrence 记录丢失 |
| 下载缓存、元数据 | 同上 | 需要重新下载 |
| 投递 outbox | 同上 | 未投递作品永久丢失 |
| Pixiv 凭据、限流状态 | 同上（+ 平台 secret） | 需要重新授权 |
| TelePost 每 Bot SQLite | `data` 卷 `/app/data/bot{N}/` | 投稿幂等与审核队列丢失 |
| TelePost 运行策略覆盖 | `data/bot{N}/runtime-policy.json` | 回落到 `[env]` 部署默认值 |

**两个卷，一机一个。** 物理卷在这里天然分离；这是主机级隔离最强的形态。注意跨 preset 的不变量
是**状态命名空间不重叠（SI-7）**，不是「物理卷绝不共享」——共置 preset 共享物理卷但子目录互不相交。

> **路径规则（commit `71b4c7c`）：** 配置里 `PIXIV_DOWNLOADER_CONFIG` 必须是绝对路径
> （`/app/config/pixivflow.production.json`，随镜像发布），而配置里的**存储路径**必须保持
> `./data/...`。加载器会把落在配置目录之外的绝对路径改写回默认的 `/app/downloads`——
> 那在卷之外，机器一 stop 就没了。修复前 SQLite 只是因为默认名恰好也在 `./data/` 下才
> 侥幸留在卷里。

---

## 网络

| 链路 | 传输 | 必须保持 |
| --- | --- | --- |
| 时钟 → `executor` | `public-https`（Fly Proxy，`auto_start_machines=true`） | 触发携带 bearer 令牌；TLS 在 Fly 代理终止 |
| `executor` → `publisher` | `flycast`（`http://telesubmit-multi-bot.flycast`） | **URL 不带 `:8080`**；`force_https = false` |
| Telegram → `publisher` | 公网 HTTPS webhook | `telegram-ingress` 是唯一 webhook owner |
| `publisher` → 审核群 / 频道 | 公网 HTTPS | 由 TelePost 自己发起 |
| 出口 | 每台机器各自的出口 | 出口是可替换的、必须先取得资格的执行资源 |

两条测量出来的事实，不要「修正」它们：

- **Flycast 投递 URL 不能带 `:8080`**：Fly Proxy 在 80 端口监听并转发到内网 8080，
  带端口会 ECONNRESET（commit `b95269a`）。
- **`force_https = false` 不能删**：设为 `true` 会让 Flycast 私网 HTTP 投递被 301 跳 HTTPS，
  变成死路。公网的 Telegram webhook 与审核 API 仍走 HTTPS，不受影响。

`.internal`（6PN 直连、不经过 Proxy）曾被用作投递地址，它的问题是无法唤醒 stopped 机器，
因此在 commit `8698e2b` 换成了 `.flycast`。

---

## 优点

- **下载器不运行时几乎没有计算费用。** 成本主要由「`executor` 平时不运行」贡献。
- **故障隔离好。** `executor` 崩溃或 OOM 不会直接打到 Telegram 链路；
  用户投稿与审核按钮始终可用。
- **凭据边界最干净。** 执行机器镜像里**没有**任何 Telegram 令牌与频道 ID
  （`control-plane/test/webhook-ownership.test.ts` 静态保证），因此它无法直发频道、
  无法绕过审核、也无法把投稿机器人的 webhook 指到自己身上。
- **两个角色可以独立升级、独立扩容、独立回滚。**
- **`publisher` 常驻**，投稿秒回，没有冷启动的用户可见延迟。

---

## 缺点

- **组件更多。** 两个 Fly 应用 + 一个 Cloudflare Worker + 一个 cron-job.org 账号 + 两个卷。
- **多一个卷**，备份与恢复要覆盖两个位置。
- **需要外部唤醒触发器。** 生产有两个独立故障域的时钟（PRIMARY cron-job.org / SECONDARY Cloudflare），
  单个 provider 静默失火不再等于漏跑；两个都失效时仍不补跑历史。
- **部署与调试更复杂。** 「机器是 stopped 的」需要被理解为健康状态，而不是故障。
- **平台耦合较深。** 当前的两份配置是 Fly 专属的（Flycast、Fly Proxy 唤醒语义、
  `restart.policy` 命名）。

---

## 故障模型

| 故障 | 影响面 | 表现 | 恢复 |
| --- | --- | --- | --- |
| `executor` OOM / 崩溃 | 只有执行平面 | 批次中断，机器可能回到 stopped | 槽位账本使下次唤醒可续跑；`stopped` 不是故障 |
| `executor` 被误配健康检查或 auto-stop | 只有执行平面 | 批次被拦腰砍断，或 `stopped` 状态不可达 | 删掉检查与 auto-stop |
| `publisher` 崩溃 | 用户可见 | 私聊投稿像坏了 | `restart.policy = 'always'` 自动重启 |
| 时钟漏触发 | 该 occurrence 丢失 | 该次计划不执行 | **不补跑**（`catchUpMissedRuns=false`）；下一班正常 |
| 一个时钟静默失火 | 该 occurrence 仍会被跑 | provider 侧没有任何 fire 记录 | **另一个时钟在同一 occurrence 上补上**（+2 分钟）；两个都没 fire 才是漏跑，且**不补跑**（`catchUpMissedRuns=false`） |
| 第二个 **PRIMARY** 时钟（或第二个调度器）上线 | 两个平面抢同一个 Pixiv 凭据 | 限流与 penalty 升级 | 立刻下线第二个 primary，只保留一个执行权威 |
| 卷丢失 | 对应平面 | 账本/outbox 或审核队列消失 | 从卷快照恢复 |
| 出口被 Pixiv 限流 | 只有执行平面 | `rate limit cooldown`、penalty 升级 | 换出口并重新取证；见 [事故记录](../incidents/2026-09-11-pixiv-egress-rate-limit.md) |

故障域是 `separated`：`executor` 的故障不传播到 `publisher`，这是本 preset 相对
`single-host` 的核心收益。

---

## 成本模型

| 项目 | 说明 |
| --- | --- |
| `clock-edge` | Cloudflare Worker（SECONDARY），免费额度内 |
| `clock-primary` | cron-job.org（PRIMARY），在它自己的档位内；本仓库不注册它 |
| `worker-machine` | 只在被唤醒期间计费；平时 `stopped` |
| `service-machine` | 常驻计费——这是「投稿秒回」的价格 |
| 两个卷 | 按容量计费，与运行状态无关 |

省钱来自 `executor` 的 `stopped` 状态，**不是**来自进程退出。
`single-machine-worker-sleep` 省内存但不省账单，两者不可互换。

---

## 部署步骤

```bash
# 1) 改两份配置里的 app 名
#    fly/deploy.telepost.toml  → app
#    fly/deploy.pixivflow.toml → app
fly config validate -c fly/deploy.telepost.toml
fly config validate -c fly/deploy.pixivflow.toml

# 2) 业务端（常驻）
fly volumes create data -a <your-telepost-app> --size 1 --region iad
fly deploy -c fly/deploy.telepost.toml --ha=false
fly secrets set -a <your-telepost-app> \
  BOT1_TOKEN=... BOT1_CHANNEL_ID=... BOT1_OWNER_ID=... \
  BOT2_TOKEN=... BOT2_CHANNEL_ID=... BOT2_OWNER_ID=... \
  TELEPOST_BOT1_SUBMIT_TOKEN=... TELEPOST_BOT2_SUBMIT_TOKEN=...

# 3) 执行端（独立卷；卷名必须与 mounts.source 一致）
fly volumes create pixivflow_data -a <your-pixivflow-app> --size 1 --region iad
fly deploy -c fly/deploy.pixivflow.toml --ha=false
fly secrets set -a <your-pixivflow-app> \
  PIXIV_CLIENT_ID=... PIXIV_CLIENT_SECRET=... PIXIV_DEVICE_TOKEN=... PIXIV_REFRESH_TOKEN=... \
  TELEPOST_BOT1_SUBMIT_TOKEN=... TELEPOST_BOT2_SUBMIT_TOKEN=... \
  SCHEDULER_TRIGGER_TOKEN=...
# 执行端这里不该出现任何 Telegram 令牌。

# 4) 时钟：两个独立 provider，作用于同一套 schedule
#    4a) SECONDARY：Cloudflare Worker
cd control-plane && npx wrangler secret put SCHEDULER_TRIGGER_TOKEN && npx wrangler deploy

#    4b) PRIMARY：cron-job.org 控制台
#        本仓库不注册它，也不持有它的凭据 —— 独立故障域正是要两个时钟的原因。
#        建两个 cron job，URL 与 4a 是同一个端点，Authorization: Bearer <SCHEDULER_TRIGGER_TOKEN>
#
#          bot1-daily   0 2,14 * * *
#          bot2-daily  10 2,14 * * *
#
#        表达式以 `PRIMARY_CRONS`（control-plane/src/cron-map.ts 导出）为准：
#        operator runbook 与契约测试读同一份列表，而不是各自抄一遍。
#        两个时钟的部署是**两个独立的 operator 步骤**，完成情况分别记录。
```

部署后核对（全部只读、缺变量时输出 `SKIP`、不打印密钥）：

```bash
./scripts/verify-production.sh     # 三平面状态、停机参数、触发鉴权、webhook 归属
./scripts/verify-images.sh         # 线上镜像/提交号是否等于仓库固定的那个
./scripts/smoke-pixivflow.sh       # 执行端 stopped + 未授权触发被拒
./scripts/smoke-telepost.sh        # 探针与投稿接口鉴权
./scripts/verify-webhooks.sh       # 两个 bot 的 webhook 归属
```

细节见 [flyio.md](../platforms/flyio.md) 与 [cloudflare.md](../platforms/cloudflare.md)。

---

## 迁移路径

| 来源 | 目标 | 主要动作 |
| --- | --- | --- |
| `single-host` | 本 preset | 把两个角色的状态拆到两个卷；加外部时钟；确认投递地址改为 `.flycast` 且不带端口 |
| `single-machine-worker-sleep` | 本 preset | 把按需 spawn 改为独立机器 + 外部触发器；两个角色从同一卷拆成两个卷 |
| `remote-worker` | 本 preset | 换平台时保持「两个角色两台机器两个卷」的形状；重配私网传输 |

反向迁移同样成立。需要搬的数据、不需要搬的文件，见 [migration.md](migration.md)。

---

## 与其它 preset 的边界对照

| | `single-host` | `single-machine-worker-sleep` | `split-worker` | `remote-worker` |
| --- | --- | --- | --- | --- |
| 机器数 | 1 | 1 | 3（executor / publish / publisher） | 2（可跨平台） |
| `executor` 是否可停 | 否（常驻容器） | 是（进程） | 是（机器） | 视平台 |
| 省内存 | 否 | **是** | 部分 | 部分 |
| 省计算账单 | 否 | **否** | **是** | 是 |
| 主机级凭据隔离（`hostCredentialIsolation`） | 否 | 否 | **是** | **是** |
| executor 持有 Telegram 凭据（SI-1） | **否** | **否** | **否** | **否** |
| 需要外部时钟 | 否 | 可选 | 需要，生产用两个（PRIMARY `cron-job.org` + SECONDARY `cloudflare`；`external` 是 provider 取值） | 可选 |
