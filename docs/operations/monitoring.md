# 监控与只读核对

本页是 `scripts/` 下只读运维脚本、`/health`、`/ready` 与「什么才算一个检查」的唯一权威说明。
角色划分与生命周期不在这里定义，见 [角色契约](../concepts/roles.md) 与 [生命周期](../concepts/lifecycle.md)；
预设的支持级别与不变量以
[architecture-matrix.json](https://github.com/redtidev1918/pixivflow-telepost-deploy/blob/main/docs/reference/architecture-matrix.json) 为准。

## 只读核对脚本

全部脚本都只读：不改配置、不注册或删除 webhook、不写业务状态。它们可以在生产上运行，
缺失变量时输出 `SKIP`（或 `[INFO]`）而不是失败，也永不打印任何密钥值。

| 脚本 | 它证明了什么 | 需要的凭据 | 缺凭据时的行为 |
|---|---|---|---|
| `scripts/verify-production.sh` | 7 段串行核对：两个 Fly 应用存在；部署中的停机/唤醒参数（读 `fly config show`，不读仓库文件）；执行端机器状态 + `restart.policy`；**一次不带凭据的**未授权触发；业务端 `/health` 与 `/live` 返回 200；调用第 5、6、7 段 | 无（全程匿名）。webhook 归属与 Cloudflare 时钟段各自需要凭据 | 缺 `BOT*_TOKEN` → 第 5 段 `SKIP`；缺 Cloudflare 只读凭据 → 第 7 段 `[INFO]` 跳过。退出码 0 = 通过（`SKIP` 不算失败），1 = 至少一项不合格 |
| `scripts/smoke-telepost.sh` | 业务端常驻且可达（`/health`、`/live` → 200），且 `bot1`/`bot2` 的投稿接口在无令牌时被拒（401/403）。它刻意不提交任何投稿，所以不会污染真实审核队列 | 无 | 不需要凭据，因此没有 `SKIP` 分支 |
| `scripts/smoke-pixivflow.sh` | 执行端机器存在且 `stopped` 是正常静止态；触发端点拒绝无凭据请求 | 无 | 非 401/403 且非 000/200 时打印 `SKIP`（例如 404 说明路径或 `schedule_id` 与运行配置漂移）。`schedule_id` 默认 `bot1-daily`，可用 `SCHEDULE_ID` 覆盖 |
| `scripts/verify-webhooks.sh` | 每个 Bot 的 Telegram webhook 仍指向 TelePost（`TELEPOST_HOST`，默认 `telesubmit-multi-bot.fly.dev`）。归属是运行时的外部状态，静态检查回答不了 | `BOT1_TOKEN`、`BOT2_TOKEN`（导出环境变量优先，其次仓库根 `.env`） | 缺 token 或 token 形态不像 Telegram bot token → 每个 Bot 各打一行 `SKIP`；两者都缺时整项 `SKIP` 并以退出码 0 结束。token 经继承环境变量交给 `scripts/tg_webhook_check.py`，从不进入 `argv`、不打印 |
| `scripts/verify-images.sh` | 线上跑的就是仓库固定的那个不可变引用：TelePost 读 `TELEPOST_IMAGE` tag 与 `fly image show` 比对；PixivFlow 从执行端启动日志读 `PIXIVFLOW_REVISION` 并与 `PIXIVFLOW_REF` 前 12 位比对 | 需要 `fly` 登录（只读调用） | 读不到镜像引用或最近日志 → `SKIP`。但 `PIXIVFLOW_REF` 不是 40 位提交号时是 `FAIL`，不是 `SKIP` |
| `scripts/cf-clock-readonly.py` | Cloudflare 时钟这个 Worker 实际挂了哪些 cron，并与 `control-plane/src/cron-map.ts` + `control-plane/wrangler.toml` 的期望值比对。由 `verify-production.sh` 第 7 段调用 | `CLOUDFLARE_API_TOKEN`（+ 可选 `CLOUDFLARE_ACCOUNT_ID`），或 `wrangler login` 留下的本地 OAuth 凭据 | 退出码 2 = 无法核对（缺凭据或凭据无权），调用方据此输出 `[INFO]` 跳过。退出码 1 = 真的不一致 |

配套的本地分类检查是 `./scripts/validate.sh --examples`：JSON/TOML 可解析、`[build].image`
被禁止（镜像一律走透传 Dockerfile）、公开仓库卫生。它不需要网络与凭据。

**一次不带凭据的核对会把停止的执行端唤醒。** `verify-production.sh` 第 3 段与
`smoke-pixivflow.sh` 都对触发端点发一次匿名 POST：这是刻意的核对成本，不是周期性探测。
执行端仍然不配任何健康检查，原因见下面「执行端是 stopped 才是健康」。

## `/health` 字段

`/health` 回答「这个进程活着吗、它的容量还剩多少」，它**不**回答「业务能跑吗」。业务能力由
`/ready` 回答：`/ready` 在子 Bot 完成 `initialize()` 与 `start()` 之前返回非 200，Compose 的
`depends_on: condition: service_healthy` 门禁读的就是它（`docker-compose.yml`，`HEALTH_PORT=8080`）。

| 字段 | 含义 | 读法 |
|---|---|---|
| `process_rss` | 本进程常驻内存 | 与所属单元的 `mem_limit` 比。逼近即为 OOM 前兆，见 [性能与容量](performance.md) |
| `system_available_mb` | 宿主可用内存 | 与 `process_rss` 相差很大时，说明吃内存的是另一个单元，用 `docker stats` 定位 |
| `storage.review_queue` | 每个 Bot 的 pending / failed / expired / deleted 计数，加最老一条 pending 的年龄 | 只暴露计数与年龄，**不含标题、标签或投稿人**。积压持续增长说明审核没人处理，不是内存问题 |
| `storage.delivery_outbox` | 投递 outbox 的未完成计数 | 计数同时包含媒体投递与「无候选」通知。诊断时看清单里的 `kind`，不要一见数字上升就删缓存 |
| `storage.volume` | 持久卷占用 | 与 `cacheMaxSizeMB` / `cacheRetentionDays` 一起判断是不是缓存撑满 |
| `storage.pixivflow_cache` | 下载缓存占用 | 缓存有界就不会随运行时长膨胀 |

生产执行端与业务端分别有自己的 `/health`：

```bash
curl -s http://127.0.0.1:8080/health | python3 -m json.tool     # TelePost（Compose）
curl https://your-app.fly.dev/health                            # TelePost（Fly）
curl -s http://127.0.0.1:8090/health                            # PixivFlow 触发器（SCHEDULER_TRIGGER_PORT）
```

## 每单元 RSS

`/health` 只报一个进程。整机预算被两个容器分掉时，先定位是谁在涨：

```bash
docker stats --no-stream                                            # 各容器真实 RSS vs mem_limit
docker exec telepost ps aux --sort=-rss | head -5                   # python 侧
docker exec pixivflow ps aux --sort=-rss | head -5                  # node 侧
```

Python 涨 → 砍 Bot 数或关搜索；Node 涨 → 降 `NODE_OPTIONS` 堆上限或把 `download.concurrency`
压到 1。判据与杠杆见 [性能与容量](performance.md)。

## 执行端是 stopped 才是健康

在 `split-worker` 与 `single-machine-worker-sleep` 下，「执行端停着」是**契约状态**，不是故障。
`smoke-pixivflow.sh` 输出机器状态与内存规格，并把 `stopped` 记为正常。正确的检查方式是读机器
状态，而不是 ping 它：

```bash
fly machine list -a pixivflow-scheduler --json | python3 -m json.tool
fly config show -a pixivflow-scheduler | python3 -m json.tool
```

`verify-production.sh` 第 2、3 段断言的就是这两件事的运行期取值：执行端
`auto_start_machines = true`、`auto_stop_machines = false`、`min_machines_running = 0`、
没有 `checks`、机器 `restart.policy` 规范化后为 `no`；业务端 `auto_stop_machines = false`、
`min_machines_running = 1`、有长期健康检查。断言写在**部署中的配置**上而不是仓库文件上：
仓库正确、线上跑着旧配置，正是要抓的情况。

`deploy.telepost.toml` 的 `force_https = false` 只能这样两半核对：`fly config show` 对未显式声明
的默认值可能根本不返回该键，所以「缺字段」不等于「值不对」；真正的判据是明文 HTTP 探测
`http://telesubmit-multi-bot.fly.dev/health` 返回 301/308 还是直接服务。

## `pixivflow_cache` 与下载缓存

| 项 | 检查方式 |
|---|---|
| 缓存是否无界 | `storage.cacheRetentionDays` 与 `storage.cacheMaxSizeMB`（`pixivflow/config/production.json`、`pixivflow/config/fly-two-bots.example.json`）。512 MiB 档用 `7` 与 `384` |
| 卷是否被缓存撑满 | `/health` 的 `storage.volume` 与 `storage.pixivflow_cache` 同时读 |
| outbox 是否真的堵住 | 读 outbox 清单里的 `kind` 再处理。outbox 独立保留，**不**参与缓存清理 |

## 一次「已鉴权」的证明：不带凭据地证明它要凭据

想证明触发端点确实要求凭据，唯一不需要凭据的做法是发一个**没有**凭据的请求并期望被拒。
`verify-production.sh` 就是这么做的，而且必须是 `POST`：

```bash
schedule_id=$(python3 -c 'import json;cfg=json.load(open("pixivflow/config/production.json"));print([s["id"] for s in cfg["schedules"] if s.get("enabled") is not False][0])')
curl -s -o /dev/null -w '%{http_code}\n' --max-time 20 -X POST \
  -H 'content-type: application/json' -d '{"label":"monitoring-unauthorized"}' \
  "https://pixivflow-scheduler.fly.dev/internal/schedules/${schedule_id}/run"
```

`401`/`403` = 端点确实要求凭据。`200`/`202` = 端点缺少鉴权，是 `FAIL`。`404` = 路径或
`schedule_id` 与运行配置不一致，也是 `FAIL`——它看起来像一次「检查」，其实什么也没检查。
**commit `90fc4cb` 修正的正是这一点**：触发端点只注册了 `POST`，用 `GET` 探测会得到 404 而不是
401，于是「鉴权生效」这条长期被一个方法用错的探针永久掩盖。同一提交还让 `schedule_id` 从权威
配置读，而不是用脚本里的常量——常量一旦和配置漂移，未授权核对会退化成 404。

## 「不会失败的检查不是检查」

commit `f09d9af` 与 `fe62cfe` 各修掉了一个「看起来在做、其实没做」的核对，它们给出的规则是：
**每一条监控结论都必须能说出它失败的形态。**

| 曾经的样子 | 缺陷 | 现在 |
|---|---|---|
| `verify-images.sh` 用 `git ls-remote origin` 把 tag 解析成提交号 | `origin` 指向本仓库，那里从来没有 PixivFlow 的 tag，于是每次都退化成 `SKIP` | 填了非 40 位提交号直接 `FAIL`。镜像里本来就没有那个提交，解析 tag 只会制造通过假象 |
| 触发核对用 `GET` | 端点只有 `POST`，得到 404；`404` 被当成「不是 200 就行」 | 显式 `POST`，且 `404` 单独判为 `FAIL`（commit `90fc4cb`） |
| `verify-webhooks.sh` 无条件 `set -a; . .env` | `.env` 覆盖了运维显式导出的真 token，于是「给了凭据」照样 `SKIP` | 显式导出的环境变量优先于 `.env`；`verify-production.sh` 另把「无法核对」（退出码 2）与「失败」分开，避免输出一行 `[FAIL]` 而整轮算通过 |

把这三条合起来就是本页的验收标准：

1. 每条断言都要有一个可观察的失败形态，不能只有 `SKIP`/`[INFO]` 路径。
2. 「无法核对」与「不合格」必须用不同输出与不同退出码区分。
3. 断言要写在**运行期**事实上（`fly config show`、机器 JSON、启动日志、真实 Telegram API），
   不写在仓库文件上。
4. 任何输出都不得包含 token、订阅 URL 或凭据的任何前缀后缀；只输出「已配置 / 缺失 / 就绪」。

## 一条能在两分钟内跑完的核对

```bash
./scripts/validate.sh --examples && ./scripts/smoke-telepost.sh
```
