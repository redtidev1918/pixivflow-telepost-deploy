# 无服务器控制平面：迁移与上线手册

> 状态：**未上线**。Fly 生产（`telesubmit-multi-bot`，TelePost 2.17.2 / PixivFlow，+ watchdog）保持原样运行。
> 本文记录目标架构、上线前置条件、上线步骤、回滚，以及**两个已证实的硬约束**。

## 1. 目标架构

| 角色 | 组件 | 职责 |
| --- | --- | --- |
| 时钟 + 账本 | Cloudflare Worker + D1 | 归类、对账、发放执行、审核状态、已处理作品去重 |
| 执行 | GitHub Actions（`pixivflow-batch.yml`） | 一次性批处理，跑完即销毁 |
| 执行引擎 | PixivFlow | 选题、去重、下载、上报 |
| Telegram 提交/审核域 | TelePost | 审核群展示、批准/驳回、发布到频道 |
| 生产编排 | `pixivflow-telepost-deploy` | 镜像、配置、部署、Workflow |

消除的失败模式（全部由结构消除，而非靠重试掩盖）：

- 机器休眠/唤醒依赖，600s/540s/任意 HTTP 中转超时
- HTTP 请求生命周期 == 任务生命周期
- 常驻调度守护进程
- 崩溃后残留的 lease（心跳在超时后仍续租）
- 一次 Cloudflare cron 丢失即丢整天
- GitHub 定时 cron 延迟
- 单进程故障丢失一次 occurrence
- 重复触发造成重复发布
- 256MB 常驻进程的取舍

关键不变量：

- `slot_id = schedule_id + 规范 occurrence 时间戳`，来自 schedule 的时间与时区，**永不**取 `Date.now()`
- `slot_occurrences(schedule_id, occurrence_at)`、`executions(slot_id, attempt)`、`processed_works(bot_id, work_type, pixiv_id)` 三个唯一约束是幂等的第 1 层；workflow `concurrency: pixivflow-<slot_id>`（`cancel-in-progress: false`）是第 2 层
- 不安全操作按 at-most-once 处理；能证明幂等处才重试；歧义一律进入显式 `uncertain`（终态，不自动重试）
- 无 heartbeat、无 lease 续期；GitHub 侧状态是唯一的存活权威
- 退出码即执行状态：`0` 成功 / `2` 部分 / `3` 失败 / `4` uncertain / `1` 进程错误
- GitHub 把 job 超时报告为 `cancelled`（不是 `timed_out`），且不执行任何上报步骤 —— 已实测

## 2. 现状（已实测，非推断）

```
Cloudflare Worker   pixivflow-control-plane.redtidev1918.workers.dev   EXECUTION_MODE=shadow
D1                  pixivflow-control                1fa00cbc-6dcc-4a89-ba8f-30cf79cc286b (APAC)
GitHub              redtidev1918/pixivflow-telepost-deploy · workflow pixivflow-batch.yml
                    ref feat/serverless-control-plane · PIXIVFLOW_REF=feat/execute-slot
Fly 生产            telesubmit-multi-bot · machine 683032ec6617e8 · 未改动
```

免费层：仅 Workers Free + D1 Free。未使用 R2 / Containers / Queues / Durable Objects。

## 3. 上线前置条件

### 3.1 凭据（当前缺口）

| 名称 | 用途 | 状态 |
| --- | --- | --- |
| `CALLBACK_SECRET` | runner → 控制平面 的 bearer | 已生成并部署 |
| `TELEGRAM_WEBHOOK_SECRET` | Telegram → Worker 的 fail-closed 校验 | 已生成并部署 |
| `GITHUB_DISPATCH_TOKEN` | Worker 触发 workflow | 已配置（临时迁移用 PAT） |
| `TELEGRAM_BOT1_TOKEN` / `TELEGRAM_BOT2_TOKEN` | runner 上传媒体、Worker 发布 | **待配置为 GitHub secret** |
| **独立 Pixiv shadow 凭据** | shadow 实跑 | **缺失 —— 见 §4.2** |

### 3.2 配置

`control-plane/config/pixivflow.production.json` 为版本化生产配置：审核群 / 频道 id 直接读自运行中的 Fly 机器，bot token 保持 `${ENV}` 占位符。已用 PixivFlow 真实校验器验证通过。

- bot1：审核群 `-1004318193445`，频道 `@xgdShare`
- bot2：审核群 `-1004303586404`，频道 `@voreShare`

`control-plane/test/production-config.test.ts` 断言每个 target 的 `delivery.target` 都能解析、token 必须是占位符、以及 shadow 配置不可能发布。

## 4. 两个硬约束

> 门禁脚本：`scripts/cutover-preflight.sh`（只读，见 §5）。

### 4.1 审核域归属：已裁定

**终态 = 控制平面接管本部署的 Telegram 审核域**；**迁移期 = 正式 bot 不动，shadow 用独立 bot**。

```
现在     正式 bot1/bot2 webhook -> TelePost/Fly
         shadow 测试 bot        -> Cloudflare Worker -> D1 -> 测试审核群
shadow 全部通过 -> 一次 cutover -> 正式 bot1/bot2 webhook -> Worker
                -> 观察完整周期 -> 关闭 Fly
```

- TelePost **项目本身保留**，继续作为独立产品演进；退役的只是"这套 PixivFlow 自动投稿部署不再需要常驻 TelePost daemon"。
- 不选"TelePost 保留审核域"作为终态：那会让生产继续依赖常驻服务，Fly 永远关不掉。
- Shadow bot 只用于迁移验证，**不进入最终架构**。生产代码里不存在"双 Telegram 后端"：bot 从环境变量发现（任意 `TELEGRAM_<ID>_TOKEN`），加一个 bot 是加一个 secret，不是改代码。

**审核语义不从零设计**：状态机、不变量、重复检测与恢复语义均提取自 TelePost 生产代码（`services/review_service.py`、`telepost/storage/sqlite/reviews.py`、`telepost/application/review_queue.py`、`telepost/domain/review.py`）。移植与有意偏离见 §4.1.1。

**实测**（`getWebhookInfo`）：截至本文，bot1/bot2 的 webhook 仍归 TelePost（`telesubmit-multi-bot.fly.dev/webhook/botN`）。**在 cutover 之前不得对 bot1/bot2 调用 `setWebhook` 指向 Worker**，否则会静默切断现网审核流程。Worker 那条路由保持 fail-closed。

#### 4.1.1 从 TelePost 移植了什么，以及有意偏离的部分

移植：状态机 `pending -> publishing -> published`（另有可重认领的 `failed`、终态 `rejected/expired/uncertain`）；**单条条件 UPDATE** 式的认领（`status IN ('pending','failed') OR (status='publishing' AND now-updated_at > stale)`）——这条 WHERE 就是双击 / Telegram 重放 / 重试 webhook 的全部 at-most-once 机制；终态写入带 `AND status='publishing'` 守卫，迟到写入者不能覆盖已被他人解决的记录；**先记录 message id，再做终态转换**的顺序不变量。

有意偏离（各一条，均有理由）：

| 偏离 | TelePost | 本实现 | 理由 |
| --- | --- | --- | --- |
| 僵尸认领 | 300s 后重认领并**重跑发布** | 有 message id（证明已发出）→ 自动判定 `published`；无证据 → `uncertain` | TelePost 自己的审计承认：发送成功但 ledger 未写入时，重认领会**二次发布**。有证据才自动恢复，其余交人。 |
| 回调来源 | 仅靠 per-bot webhook 路径 + 每 bot 独立 DB | 额外校验 `chat_id` 必须等于该 review 的 chat | 现在共用一个 D1，per-bot DB 的隐含隔离不复存在。实测越权回调返回 403。 |
| 作品级去重 | published 的 7 天窗口 | 一个作品**永远只有一个** review | 同一作品存在两个可审核稿，正是"同一媒体被批准两次"的成因；runner 侧已有永久去重历史，窗口只会多给一次重复发布的机会。 |
| 审核过期 | 默认**关闭**（`PENDING_REVIEW_RETENTION_DAYS=0`） | 30 天 | 过期是可见状态（`expired` + 事件），不会静默消失。若希望与现网完全一致，把 TTL 调大即可。 |

### 4.2 生产 Pixiv refresh token 不可并行复用

**证明（源码 + 实测）**：

- `src/auth/PixivAuth.ts` 在 `data.refresh_token !== credentials.refreshToken` 时把新 token 写入 4 处：SQLite `pixiv_refresh_token`、`.pixiv-refresh-token`、其 backup、以及**配置文件本身**。
- `src/utils/token-maintenance.ts` 在**每次启动**都向 token endpoint 发一次请求（`scheduler-runtime` 无条件 `start()`），并且**丢弃**返回的新 refresh token —— 这本身就是生产上的一个隐患：若 Pixiv 轮换，生产在每次启动时丢掉自己的新 token。
- 正在运行的守护进程**从不重新读取**磁盘上的 token（`credentials.refreshToken` 在构造时捕获，只在进程内更新），所以一旦被轮换，生产必须重启才能恢复。
- Pixiv 在 `grant_type=refresh_token` 时是否轮换旧 token，是客户端**无法证明**的服务端行为。

**当前无法安全复用**：

- 本地 `~/.pixivflow/config/standalone.config.json` 里存的**就是** Fly 生产 refresh token（已比对一致）。任何本地 PixivFlow 运行都会把它从 unified storage 解析进内存。
- 唯一可以避免刷新的路径是使用缓存中的 access token。实测本机缓存已过期：`expiresAt = 2026-08-29 21:07:46`（写入 169 字节 JSON，`bearer`）。

**已加入的安全原语**（`PIXIV_AUTH_READONLY`）：

- 跳过启动探针，禁止调用 token endpoint，缓存无有效 access token 时**响亮失败**而不是静默轮换
- 已在进程级验证：设该变量后启动探针被跳过，运行以只读错误结束，从未请求 `oauth.secure.pixiv.net`
- 配套：`--mode shadow` 现在真的生效了（`withDeliveryMode()` 在非 live 模式下剥离所有 delivery target）

**结论**：shadow 实跑需要**一套独立的 Pixiv shadow 凭据**。这是唯一的人工 blocker。

## 5. 上线步骤（凭据齐备后）

**每一步之前先跑门禁**（只读，绝不改 webhook）：

```bash
# 切换前：正式 bot 必须仍归 TelePost
TELEGRAM_BOT1_TOKEN=... TELEGRAM_BOT2_TOKEN=... scripts/cutover-preflight.sh
# 或直接从 Fly 机器读 token：scripts/cutover-preflight.sh --from-fly

# 切换后（含回滚后复原确认）：正式 bot 必须归 Worker
EXPECT_OWNER=worker scripts/cutover-preflight.sh
```

它检查：Worker 健康、`EXECUTION_MODE=shadow`、**时钟是否还在走**（`clock.state`）、**是否存在 `uncertain` 审核**（有则逐条列出 id，必须人工对着频道确认）、provider 是否配置、以及每个 bot 的 webhook 归属与积压。任一项不满足即非零退出。

1. 配 GitHub secrets：`TELEGRAM_BOT1_TOKEN`、`TELEGRAM_BOT2_TOKEN`、`CALLBACK_SECRET`、`CONTROL_PLANE_URL`
2. Shadow 实跑一次完整 occurrence（`--mode shadow`，`EXECUTION_MODE=shadow`）：验证选题、去重、下载、上报、`processed_works` 落库，且**不发布任何内容**

   **已完成的部分（真实基础设施，无 Pixiv 凭据）**：2026-09-10 用真实调度路径跑通了整条链路 —— Cloudflare sweep → `workflow_dispatch` → 真实 GitHub Actions run `34522570110` → sweep 认领该 run（写入 `provider_run_id`）→ runner 上报 items 与 result（HTTP 200）→ 控制平面落库

   ```
   dispatch_started -> dispatch_success -> github_run_started
   -> github_run_finished{partial} -> slot_terminal{partial}
   ```

   slot `bot1-daily@2026-09-10T2330` = `partial`，两个 item 均 `no_candidate`，`--exclude-work-ids` 生效。job 结论 `success`（exit 2 按设计保持绿色）。

   **同时证明生产 token 未被触碰**：本次 job 的 `PIXIV_*` 全部为空且 `PIXIV_AUTH_READONLY=true`；日志中
   `Read-only auth: skipping the boot-time refresh-token probe` 等守卫命中 18 次，而
   `Received updated refresh token` / `Refreshed Pixiv access token` / `Config file automatically updated` **均为 0 次**。

   **仍需独立 Pixiv shadow 凭据**：真正的选题→下载→上传送审只能等有了独立凭据（或一份未过期的 access token）才能验证。
3. 故障注入：job 超时、上报丢失、重复 dispatch、D1 写失败、runner 崩溃 —— 每次都要证明恰好一个 terminal 状态，且没有第二次执行
4. 按 §4.1 的裁定完成审核域接线
5. 一个完整调度周期内双跑（Fly 生产 + 无服务器平面），比较两边的 slot 结果
6. 切换：Cloudflare cron 接管发放，Fly watchdog 先降为 observer，再停用
7. 观察一个完整周期后，才考虑删除 Fly 常驻

## 6. 回滚

**Webhook 层可回滚**（Telegram 每个 bot 只能有一个 webhook，切换与回滚都是同一条命令）：

```bash
# 切到 Worker（cutover）
curl -sS "https://api.telegram.org/bot$TOKEN/setWebhook" \
  -d "url=$WORKER/telegram/webhook/$BOT" \
  -d "secret_token=$TELEGRAM_WEBHOOK_SECRET" \
  -d 'allowed_updates=["callback_query"]'
EXPECT_OWNER=worker scripts/cutover-preflight.sh      # 确认生效

# 回滚：把 webhook 还原给仍在运行的 TelePost
curl -sS "https://api.telegram.org/bot$TOKEN/setWebhook" \
  -d "url=$TELEPOST_WEBHOOK_BASE/$BOT"
TELEGRAM_BOT1_TOKEN=... scripts/cutover-preflight.sh   # 确认已复原
```

回滚只需这一条命令，因为 **Fly 生产在最终验收前不删除、不降级**：旧 TelePost 进程仍在监听原路径，webhook 一指回去就恢复接收更新。

- 其余部分：停止 Cloudflare cron 派发即可，不需要恢复数据。
- D1 中只有影子数据（合成 slot / review / `99999999` 作品），删除无影响。
- 任何时刻只要 `PIXIVFLOW_ENABLED` / watchdog 仍指向 Fly，生产就还在原路径上。
- 绝不可移动已发布的 tag；重建镜像走独立的 rebuild workflow。

## 7. 已知隐患（与迁移无关，但应单独修）

1. `token-maintenance.ts` 丢弃轮换后的 refresh token（§4.2）。生产每次启动都在丢自己的新 token。
2. 配置加载器会把 unified storage 里的 token 回写到传入的配置文件；CI 中若配置文件来自 checkout，会被就地改写（job 结束即丢弃，属可接受，但不要把它当成只读）。
3. 模块内存在两套配置校验器，规则重复。`telegram` 类型曾在其中一处缺失，导致该交付目标完全无法配置 —— 现已统一为 `collectTelegramDeliveryErrors`。
