# 故障排查

本页是**症状 → 首查 → 处置 → 反模式**的唯一权威说明。每条给出要看的精确命令或配置键。
生命周期（为什么「执行端停着」是契约）见 [生命周期](../concepts/lifecycle.md)，投递链路见
[投递](../concepts/delivery.md)，调度与 occurrence 见 [调度](../concepts/scheduling.md)。
预设的不变量以
[architecture-matrix.json](https://github.com/redtidev1918/pixivflow-telepost-deploy/blob/main/docs/reference/architecture-matrix.json)
为准。

## 症状表

| 症状 | 首查（精确命令 / 配置键） | 处置 | 反模式 |
|---|---|---|---|
| `/health` 的 `process_rss` 逼近 `mem_limit` | `docker stats --no-stream`；`docker exec telepost ps aux --sort=-rss \| head -5`；`docker exec pixivflow ps aux --sort=-rss \| head -5` | python 峰值 → 砍 Bot 数（`BOT{N}_TOKEN` 清空）或关搜索（`SEARCH_ENABLED=false`）；node 峰值 → 降 `NODE_OPTIONS=--max-old-space-size=96` 或 `download.concurrency=1` | 提高 `mem_limit` 而不定位；或直接重启掩盖增长 |
| OOM Kill（exit 137） | `docker inspect <container> --format '{{.State.OOMKilled}} {{.State.ExitCode}}'`；`dmesg -T \| grep -i oom`；Fly 上 `fly machine list -a <app> --json` 看 machine 的 `events` | **先按档位升内存**（512 MiB → 1 GiB），并核对下表的 `resourceProfiles` 约束 | 删 outbox、减重试换取表面稳定 |
| 审核积压涨内存 | `/health` 的 `storage.review_queue`（pending 计数 + 最老 pending 年龄） | 缩短 `PENDING_REVIEW_RETENTION_DAYS`、把 `PENDING_REVIEW_CLEANUP_BATCH_SIZE` 调大，或人工清 pending | 把「没人审核」当成内存问题去调内存参数 |
| 下载缓存占满卷 | `/health` 的 `storage.pixivflow_cache` 与 `storage.volume`；`storage.cacheRetentionDays`、`storage.cacheMaxSizeMB` | 设定有界缓存（512 MiB 档：`7` 天 / `384` MiB） | 把 outbox 一起清掉 |
| outbox 计数持续上升 | `/health` 的 `storage.delivery_outbox`，再读 outbox 清单里的 `kind` | 按 `kind` 区分：媒体投递失败 vs 无候选通知。前者查网络与鉴权，后者往往是检索条件没命中 | 一见 outbox 数字变大就删缓存；或删掉 outbox |
| 投稿接口返回 5xx | `./scripts/smoke-telepost.sh`；`/ready` 是否 200 | `/ready` 非 200 说明子 Bot 还没起来；等 `ROUTER_CHILD_READY_TIMEOUT`（默认 120s）或看启动日志 | 只看 `/health` 200 就断定业务可用 |
| 用户投稿像石沉大海 | `./scripts/verify-webhooks.sh`（需要 `BOT*_TOKEN`） | webhook 归属错了就改回 TelePost；`NO_WEBHOOK` 说明根本没注册 | 用轮询另起一套 ingress，形成两个 webhook 负责人 |
| Telegram 入站不稳定/无公网 | `RUN_MODE`（`WEBHOOK` / `POLLING` / `AUTO`）、`WEBHOOK_URL` | 无法稳定提供 HTTPS 入站时用 `RUN_MODE=POLLING`：两种模式提供同一套 `api/botN/v1/*` | 在 TelePost 之外注册 webhook（含反向代理里手写 setWebhook） |
| Pixiv 反复 `rate limit cooldown`，`penaltyLevel` 从 1 升到 2 | 执行端日志里的 `Pixiv rate limit cooldown` 与 `batch watchdog`；出口资格见下 | 换一个合格出口，按 [事故记录](../incidents/2026-09-11-pixiv-egress-rate-limit.md) 做 A/B 探测 | 认定「能鉴权就说明出口合格」 |
| 升级后行为没变 | `./scripts/verify-images.sh`；`fly logs -a pixivflow-scheduler --no-tail \| grep PIXIVFLOW_REVISION` | 见 [upgrades.md](upgrades.md)：分支引用或 tag 固定会让镜像自报错误来源 | 相信「部署成功」的输出 |
| 明码投递被 301 打断 | `fly config show -a telesubmit-multi-bot`；`deploy.telepost.toml` 的 `force_https` | 必须 `force_https = false`，否则 Flycast 私网投递变成死路。运行期用明文探测判定 | 用改客户端跟随重定向的方式绕过 |
| 执行端跑完又被拉起 | `fly machine list -a pixivflow-scheduler --json` 的 `restart.policy` | 必须是 `no`（Machines API 拼写）/ `never`（`fly.toml` 拼写） | 用平台 auto-stop 代替执行端自己的账本 |
| 时钟没触发 | `python3 scripts/cf-clock-readonly.py <worker>`（退出码 2 = 缺凭据） | 对不上就改 `control-plane/src/cron-map.ts` + `control-plane/wrangler.toml` | 再加一个时钟或看门狗 |
| 审核群“重抓”提示未配置或请求未受理 | TelePost 的 `PIXIVFLOW_REFETCH_BASE_URL` / `PIXIVFLOW_REFETCH_TOKEN`、PixivFlow 的同名 Token、执行端 `manual-` Slot 日志 | 两端配相同的专用 Secret；确认原审核稿有 `target_id`，再核对 HTTP 202 与后续 Slot 终态 | 打开旧的 `PIXIVFLOW_ENABLED`；把“机器已唤醒”当作重抓成功 |
| 审核群刷“重抓仍在处理中 / 重抓超时未完成” | TelePost `refetch_attempts`（`state`/`failure_code`）、PixivFlow `schedule_slots`（`manual-` 前缀）+ `outbox`、TelePost `reviews.refetch_request_id` | 以业务终态为准：attempt 必须落到 `replaced / no_alternative / failed / obsolete` 之一。已受理 attempt 先查 PixivFlow durable cell（`GET /internal/targets/:id/refetch/:requestId`）；`failure_code='legacy_refetch_correlation_broken'` 是 2.20.0 字面量 bug 的历史终态（见 [refetch-production-verification.md](refetch-production-verification.md)），不是当前失败 | 把「还在投递/远端未知」的 attempt 凭本地时间判失败；把字面量 `{{refetchRequestId}}` 当合法 UUID 放行 |

## 反模式（直说）

1. **绝不删 outbox 来降低表观内存。** outbox 是重试依据，不是缓存。它独立保留，不参与
   `cacheRetentionDays` / `cacheMaxSizeMB` 的清理。删了它，已经下载但投递失败的作品就永久失去
   重试依据。
2. **绝不给 executor 加健康检查。** 一个探测就是一次请求，会把刚刚决定收工的执行端重新唤醒，
   直接破坏「平时 stopped」这个省钱机制。`verify-production.sh` 第 2 段会把存在 `checks` 的执行端
   判为不合格。
3. **绝不启用平台 auto-stop。** 平台看到的是「HTTP 连接已空闲」，而一次 10–40 分钟的下载还在跑；
   历史上一个机器级休眠变体因此把批次砍成两半（commit `a98c3a7` 已删除该变体）。停机只能由
   执行端自己的账本 (`exitWhenIdle`) 决定。
4. **绝不部署第二个 PRIMARY 时钟、第二个调度器或第二份执行状态。** 危险的是「两个执行权威」，
   不是「两个触发器」：一个生产计划集恰好一个 **PRIMARY** 时钟。
   生产**刻意**跑两个外部时钟（PRIMARY cron-job.org 准点 / SECONDARY Cloudflare +2 分钟），
   两者只 POST 同一个幂等端点，谁后到都在前一个创建的 slot 上收敛。
   **不要把 SECONDARY 当作清理对象关掉** —— 关掉它就是把单时钟的单点故障装回去，
   而 2026-09-13 的事故正是这么发生的。见 [调度运维手册](./scheduling.md)。
5. **绝不在 TelePost 之外注册 Telegram webhook。** 历史上 webhook 曾被指到 Cloudflare Worker 上，
   Worker 对每条 update 回 `200 {ok:true}`，Telegram 报告一切健康，用户投稿却被静默丢弃。
   归属只由 TelePost 拥有，`control-plane/test/webhook-ownership.test.ts` 静态守护，
   `scripts/verify-webhooks.sh` 用真实 API 只读核对。
6. **发生 OOM 就升资源档位，不要去掉重试。** 去掉 `maxAttempts` / `retries` 是把「不稳定」换成
   「静默丢件」，而 OOM 的根因（并发、Bot 数、搜索词典）一条都没解决。先按 `resourceProfiles`
   升档，再按 [performance.md](performance.md) 收窄杠杆。

## 具体诊断

### OOM kill（exit 137）

```bash
docker inspect telepost --format '{{.State.OOMKilled}} {{.State.ExitCode}}'
dmesg -T | grep -i -e oom -e killed
fly machine list -a pixivflow-scheduler --json | python3 -m json.tool
```

exit 137 = 128 + SIGKILL。先确认是 OOM 而不是别的原因（宿主内存、`pids_limit=256`）。
确认后按档位升内存：512 MiB → 1 GiB，或把单元拆到另一台机器。同时收窄同一档位里的杠杆
（Bot 数、`download.concurrency`、`NODE_OPTIONS`）。**不要**删 outbox 或减重试。

### 审核积压导致的增长

`/health` 的 `storage.review_queue` 给出每 Bot 的 pending/failed/expired/deleted 计数与最老
pending 年龄，且不含标题、标签或投稿人。pending 长期堆积说明审核侧没人处理：要么处理它，
要么让 `PENDING_REVIEW_RETENTION_DAYS`（默认 1 天）把它标成 `expired` 并删除审核群消息。
保留期不要设成 2 天以上：Telegram Bot API 只保证删除 48 小时内发送的消息。

### `process_rss` 逼近上限：先分清 python 还是 node

```bash
docker stats --no-stream
docker exec telepost ps aux --sort=-rss | head -5
docker exec pixivflow ps aux --sort=-rss | head -5
```

- 一个 `python` 进程几十 MB × N 个 Bot → Bot 数问题。`BOT{N}_TOKEN` 清空即下线该 Bot。
- 单个 python 进程突然大一百 MB → 搜索词典（`SEARCH_ANALYZER=jieba`）。改回 `simple` 或
  `SEARCH_ENABLED=false`。
- `node` 进程持高 → V8 堆。看 `NODE_OPTIONS`（Compose 默认 `--max-old-space-size=96 --expose-gc`，
  Fly 执行端为 `--max-old-space-size=384`），并确认 `download.concurrency=1`。

### 下载缓存撑满卷

```bash
curl -s http://127.0.0.1:8080/health | python3 -m json.tool | grep -A5 pixivflow_cache
```

对照 `storage.cacheRetentionDays` 与 `storage.cacheMaxSizeMB`。同时读 `storage.volume` 判断剩下的
空间够不够下一批。缓存有界（示例：7 天 / 384 MiB）就不会随运行时长膨胀。

### outbox 增长：先读 `kind`

outbox 计数同时包含媒体投递和「无候选」通知，两者含义完全不同：媒体投递失败是链路问题，
通知则是检索条件没命中（例如昨天没有中文小说候选）。处理方式不同，所以先读清单里的 `kind`
再动手。outbox 有指数退避重试，网络闪断不会静默丢件，恢复后也不会刷屏。

### webhook 被错误的组件注册

```bash
./scripts/verify-webhooks.sh          # 需要 BOT1_TOKEN / BOT2_TOKEN
```

`HOST_MISMATCH` 表示 webhook 指向了非 TelePost 的主机（默认期望
`telesubmit-multi-bot.fly.dev`，可用 `TELEPOST_HOST` 覆盖）。`NO_WEBHOOK` 表示没有任何注册，
用户投稿不会被接收。两种都要改回由 TelePost 注册；脚本只读，不会替你注册或删除。

### 触发端点返回 401 / 404 / 425 / 410

| 返回 | 含义 | 处置 |
|---|---|---|
| 401 / 403 | 端点要求凭据，且你的请求没带（或带错） | 这是**正确**行为。`verify-production.sh` 第 3 段与 `smoke-pixivflow.sh` 的匿名核对期望的就是它 |
| 404 | 路径或 `schedule_id` 与运行配置不一致 | 从权威配置读 schedule id，不要用脚本里的常量。路径错时 404 会伪装成一次「通过」的核对 |
| 425 / 410 | 触发器对「太早 / 已过期」的 occurrence 的答案 | 检查时钟的 cron 与 schedule 映射是否漂移；`python3 scripts/cf-clock-readonly.py <worker>` 核对 Worker 实际挂的 cron |

匿名核对必须用 `POST`：触发端点只注册了 `POST`，用 `GET` 会得到 `404` 而不是 `401`，
从而把「鉴权生效」永久掩盖（commit `90fc4cb`）。

### 投递失败：`ECONNRESET` 或私网上的 301

- `ECONNRESET`：投递走的是 `TELEPOST_API_BASE_URL`（Fly 上为
  `http://telesubmit-multi-bot.flycast`）。先确认业务端 `/ready` 是 200、业务端机器在运行。
- 301：`force_https = false` 被改成了 `true`，Fly proxy 把明文投递重定向到 HTTPS，而执行端
  不跟这条路。核对 `fly config show -a telesubmit-multi-bot`，并用明文 HTTP 探测确认运行期行为
  （源配置里缺这个键时不能推断值，见 [monitoring.md](monitoring.md)）。
- 远端业务层失败但传输层 2xx：这种「远端失败被当成端到端成功」的语义问题已在
  PixivFlow `f331cd4`（v2.19.4）修正。核对执行端自报的提交号，确认是这个提交或更新的。

### Pixiv 限流冷却与 penalty 升级：出口不合格

执行端日志出现反复 `rate limit cooldown` 且 `penaltyLevel` 从 1 爬到 2、最后被批次自己的
1800000 ms 看门狗取消，是**出口资格**问题，不是代码问题：

```bash
fly logs -a pixivflow-scheduler --no-tail | grep -e 'rate limit' -e 'penaltyLevel' -e 'watchdog'
```

PixivFlow 依赖三个彼此独立的 Pixiv 数据面，必须分别取得资格：OAuth
`oauth.secure.pixiv.net`、App API `app-api.pixiv.net`、媒体 CDN `i.pximg.net`（请求携带
`Referer: https://app-api.pixiv.net/`）。**能鉴权只证明可达，不证明适用。** 代理只解决可
达性，不会让出口变得合格——完整证据、时间线与「每个出口都要各自的 A/B 探测」这一结论见
[事故 2026-09-11 — Pixiv 出口限流](../incidents/2026-09-11-pixiv-egress-rate-limit.md)。
换出口不影响凭据准入不变量：`pixiv-main` 最多只有一个在跑的生产执行。

## 提交 Issue 之前

```bash
./scripts/validate.sh --examples
./scripts/verify-production.sh
./deploy doctor --plane all
./deploy logs 100 --platform <fly|compose|systemd>
```

提供部署方式、仓库版本、相关命令、精简配置与错误日志。先删除 Bot/Pixiv/投稿 Token、Webhook
Secret、代理订阅、真实频道/群 ID、域名、IP 与用户名。不要上传整个 `.env`、数据库或持久卷。
PixivFlow 的下载/排序问题与 TelePost 的 Bot 行为问题可能会被转到对应上游仓库——这能让修复进入
真正负责该行为的项目，而不是在部署层做不可维护的补丁。
