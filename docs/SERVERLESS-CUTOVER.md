# 无服务器控制平面：迁移与上线手册

> 状态：**已上线**。Cloudflare Worker + D1 自 2026-09-10 起承担本部署的生产控制平面，bot1/bot2
> 的 webhook 均已归 Worker（`getWebhookInfo` 实测，`EXPECT_OWNER=worker` 闸门 exit 0）。Fly 生产
> （`telesubmit-multi-bot`，TelePost 2.17.2 / PixivFlow，+ watchdog）**仍在运行且未改动**，作为回滚材料
> 保留到 §8 停机。
> 本文记录目标架构、上线前置条件、上线步骤、回滚，以及**两个已证实的硬约束**。文中"现在 / 迁移期"
> 的叙述保留为历史；**当前事实以 §2 为准**。

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
Cloudflare Worker   pixivflow-control-plane.redtidev1918.workers.dev   EXECUTION_MODE=live
                    时钟：cron */10（唯一时钟）· /api/status 的 clock.state=ok
D1                  pixivflow-control                1fa00cbc-6dcc-4a89-ba8f-30cf79cc286b (APAC)
                    migrations 0001–0010 已全部应用到远端 · open executions=0
GitHub              redtidev1918/pixivflow-telepost-deploy · workflow pixivflow-batch.yml
                    ref main · PIXIVFLOW_REF=master
调度                 bot1 10:00 / 18:00 · bot2 10:10 / 18:10  (Asia/Shanghai)
凭据 alias           pixiv-main（D1 内可读，43 字符）
webhook 归属         bot1 -> Worker · bot2 -> Worker（TelePost 已不持有）
Fly 生产            telesubmit-multi-bot · machine 683032ec6617e8 · started · /ready 200
                    volume vol_4y5e58mylle1nnjr 保留；**未改动，等待 §8 停机**
```

> 生产周期状态：首个真实周期尚未跑完（判据见 §9）。在 §9 全部满足之前**不动 Fly**。
> 真实 occurrence 不接受任何人工构造的"验收"：它必须由 cron 发放、由 GitHub job 执行、
> 由人在审核群真实点击按钮。

免费层：仅 Workers Free + D1 Free。未使用 R2 / Containers / Queues / Durable Objects。

## 3. 上线前置条件

### 3.1 凭据（当前缺口）

| 名称 | 用途 | 状态 |
| --- | --- | --- |
| `CALLBACK_SECRET` | runner → 控制平面 的 bearer | 已生成并部署 |
| `TELEGRAM_WEBHOOK_SECRET` | Telegram → Worker 的 fail-closed 校验 | 已生成并部署 |
| `GITHUB_DISPATCH_TOKEN` | Worker 触发 workflow | 已配置（临时迁移用 PAT） |
| `TELEGRAM_BOT1_TOKEN` / `TELEGRAM_BOT2_TOKEN` | runner 上传媒体、Worker 发布 | 已配置（GitHub secret + Worker secret 两处） |
| 独立 Pixiv shadow 凭据 | shadow 实跑 | **已作废**：不引入独立凭据，直接用生产凭据（`credential_key=pixiv-main`）验证真实路径 |

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

**实测**（`getWebhookInfo`）：bot1/bot2 的 webhook **均已归 Worker**。上段"现在 / 迁移期"的叙述是
迁移前的状态记录，已不适用于当前部署；`scripts/cutover-preflight.sh` 以 `EXPECT_OWNER=worker` 断言这一点。

回滚路径未失效，且是同一个命令：把 webhook 指回 `https://telesubmit-multi-bot.fly.dev/webhook/<bot>`
即可恢复 TelePost（见 §6）。Worker 那条路由始终 fail-closed。

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

  **实测（2026-09-10，真实 GitHub runner）**：一次全新 runner 无缓存 refresh 了 **2 次**，两次都成功，且 `Received updated refresh token` 出现 **0 次** —— 即这两次 Pixiv 返回了**同一个** refresh token。

  ⚠️ **但这只是 2 次观测，不能推广成"Pixiv 永不轮换"**。`PixivAuth` 专门处理 `data.refresh_token` 差异，就该继续把"服务端未来可能返回新 refresh token"当作合法情况。因此不存在"因为不会轮换所以安全"这种论证；安全来自下面 §4.2.1 的不变式。

**当前无法安全复用**：

- 本地 `~/.pixivflow/config/standalone.config.json` 里存的**就是** Fly 生产 refresh token（已比对一致）。任何本地 PixivFlow 运行都会把它从 unified storage 解析进内存。
- 唯一可以避免刷新的路径是使用缓存中的 access token。实测本机缓存已过期：`expiresAt = 2026-08-29 21:07:46`（写入 169 字节 JSON，`bearer`）。

### 4.2.1 credential identity：稳定 alias，而不是字段名

```text
credential_key = pixiv-main        ← 永久稳定的逻辑 alias，永不改变
provider       = pixiv
secret         = refresh token     ← 可无限轮换，alias 不变
```

- `credential_key` 表示**哪一个账号/外部资源**，不表示"里面存的是什么"。旧名 `pixiv-refresh-token` 把实现细节写进了 identity；第二个账号一来就会变成 `pixiv-refresh-token-1/-2`，而 admission、GitHub concurrency、轮换写回、远程登录、状态查询全都要围绕这个 key 工作。
- 多账号命名：`pixiv-main` / `pixiv-alt` / `pixiv-backup` / `pixiv-r18`。
- **不为了改 key 重写已完成的 slot / execution / review 历史**：只有 `runner_credentials` 把 credential 作为当前语义持久化。`event_log` 里 4 条历史提及**故意保留** —— 审计日志记录的是当时发生了什么，改掉它是销毁证据而不是整理。
- 迁移方式为**无损**：0007 复制新 alias（先验证新 key 能读到真实 token）→ 切换所有引用 → 确认无代码依赖旧名 → 0008 才删除旧行。复制不会丢凭据，中途失败的改名会。
- **一个反例教训**：workflow 曾把轮换检测的 glob 参数化成 `.{credential_key}`，那会让 alias 与 **PixivFlow 自己的 token 文件名**（`.pixiv-refresh-token`）耦合 —— 改个账号名就会静默停掉轮换检测。现在 glob 用库自己的固定文件名，alias 只管账号身份。

### 4.2.2 轮换不变式：先持久化，才允许成功

共享一套凭据意味着"拿到新 token 就地丢掉"是单向门：runner 随 job 销毁，丢掉的 token 谁也拿不回来，账号访问一起失去。所以 cutover 前必须锁死：

```
runner 收到 rotated refresh token
        ↓
必须安全持久化（D1 是这套架构里唯一的耐久存储）
        ↓
不写进 Actions log（值被 mask，只打印摘要与状态）
        ↓
不能只留在 ephemeral runner（artifact 仅作最后兜底）
        ↓
在确认已 durable 保存之前，不得认为 execution 完整成功
```

实现：

| 位置 | 机制 |
| --- | --- |
| D1 `runner_credentials` | 每个 alias 一行（现为 `pixiv-main`）；值以 AES-GCM 加密存储（`v1:` 前缀 + 每次写入新 IV，`CREDENTIAL_MASTER_KEY`）；记录 `previous_hash`（被替换值的摘要，**不是** token 历史）与 `rotations` 计数 |
| `PUT /control/credentials/:name` | 写入；拒绝空/过短/仍是 `${...}` 占位符的值；轮换时写 `runner_credential_rotated` 审计事件（只含 name/计数/前一次时间） |
| `GET /control/credentials/:name` | **只返回元数据**，绝不含明文 |
| `POST /control/credentials/:name/read` | 唯一能读到明文的方式（显式 POST，避免被缓存/进 URL/进日志） |
| workflow `Resolve the Pixiv credential` | 每次运行**从控制平面取**当前值 ⇒ 上一轮写回的新 token 立刻被下一轮使用；token 不再需要长期存放在 GitHub secret 里 |
| workflow `Persist a rotated credential` | 在 **report 之前**执行：检测任何位置出现的非占位符差异值 → 重试 PUT；失败则**拒绝上报** |

失败即"不上报"的意义：未上报的 execution 停在非终态，由 reconciliation 从 GitHub 侧收敛成 `failed`，**不可能被当成一次完整成功**。

**实测（真实 Cloudflare + D1）**：空库 `stored:false` / `read` 404；占位符被拒 400；写入真实值 `changed:false, rotations:0`；PUT 一个不同值 → `changed:true, rotations:1`、`previousHash=722c05473f2ad7d2`（＝被替换值的摘要）、明文不在元数据里；`read` 返回 43 字符原值；无授权 GET/POST 均 401。

**已加入的安全原语**（`PIXIV_AUTH_READONLY`）：

- 跳过启动探针，禁止调用 token endpoint，缓存无有效 access token 时**响亮失败**而不是静默轮换
- 已在进程级验证：设该变量后启动探针被跳过，运行以只读错误结束，从未请求 `oauth.secure.pixiv.net`
- 配套：`--mode shadow` 现在真的生效了（`withDeliveryMode()` 在非 live 模式下剥离所有 delivery target）

**结论**：shadow 实跑需要**一套独立的 Pixiv shadow 凭据**。这是唯一的人工 blocker。

## 5. 上线步骤（迁移计划与执行记录）

**每一步之前先跑门禁**（只读，绝不改 webhook）：

```bash
# 切换前（或回滚后确认已退回）：正式 bot 必须仍归 TelePost，模式必须是 shadow
TELEGRAM_BOT1_TOKEN=... TELEGRAM_BOT2_TOKEN=... scripts/cutover-preflight.sh
# 或直接从 Fly 机器读 token：scripts/cutover-preflight.sh --from-fly

# 切换后（当前生产）：正式 bot 必须归 Worker，模式必须是 live
EXPECT_OWNER=worker scripts/cutover-preflight.sh
```

它检查：Worker `/api/status` 是否作答、**执行模式是否与阶段相符**（`EXPECT_OWNER=worker` 要求 `live`，
否则要求 `shadow`；`EXPECT_MODE` 可覆盖）、**时钟是否还在走**（`clock.state`）、**是否存在 `uncertain`
审核**（有则逐条列出 id，必须人工对着频道确认）、provider 是否配置、凭据 alias 是否可读、以及每个 bot
的 webhook 归属与积压。任一项不满足即非零退出 —— 包括在**正确的**控制面上因为**过时的期望**而失败，
所以模式那道闸门是按阶段推导的，不是硬编码的。

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

   **Telegram 审核链路：已在真实 Telegram 上验证（2026-09-10）**

用正式 bot1（`@xgdPost_bot`，审核群管理员）对**真实审核群** `西瓜肚审核群` 跑通了 Worker 侧的完整审核域。发布目标刻意指向操作者私聊，**`@xgdShare` 正式频道全程未被触碰**。

| 验证项 | 结果 |
| --- | --- |
| 真实媒体 + 内联键盘进正式审核群 | ✅ `message_id 454` |
| claim → **真实 `copyMessage`** | ✅ `published_message_id 15270`（真实 Telegram 消息，事后可删除验证） |
| 记录 `decided_by` | ✅ `owner` |
| **重放** approve | ✅ `decided:false, published:true`，D1 未变，**无第二次副本** |
| reject | ✅ `rejected`，无副本，键盘被清除 |
| 异地 chat 回调 | ✅ 403 `chat mismatch` |
| bot2 webhook 打 bot1 review | ✅ 403 `bot mismatch` |
| 非 callback 更新 | ✅ 被忽略而非报错 |

测试痕迹已全部清除（群内 2 条消息、私聊副本、D1 合成行），群恢复原状。

**已验证：Telegram 真的把按键投递到了 Worker。** 上段的"仍未验证"是 cutover **之前**的状态记录。切换 webhook 之后，对**正式 bot1 与 bot2** 各在各自审核群**真实点击**了一次按钮（不是构造的回调），两次都经由
`https://pixivflow-control-plane.redtidev1918.workers.dev/telegram/webhook/<bot>` 进入 Worker：

| 验证项 | 结果 |
| --- | --- |
| 真实按键 -> Worker | ✅ bot1、bot2 的审核群内真实点击，均落到 Worker 路由 |
| approve -> 发布 | ✅ `published`，且恰好 **1 次 `copyMessages`** |
| 审核卡处理 | ✅ 就地 `editMessageText` 更新为已发布链接，**未被复制进频道** |
| 重放同一回调 | ✅ `decided:false`，`published_message_id` 未变，无第二个副本 |
| 跨 bot 回调 | ✅ 403 |

`review_callback_received` 审计事件记录每次按键的到达时间与结果，用来区分"用户没点"与"按键没送到"。
该审计是**先于结论**加上的：早期有两次点击被记成 `reject`（用户以为按的是 approve），所以先证明
"按键确实到了、值是什么"，再把 `approve` 当作已确认的事实，而不是反过来解释。

**媒体布局（已实测，且与最初设计不同）**：`sendMediaGroup` 无法承载 group 级 `reply_markup`，
而 caption 属于**媒体项本身**（`InputMediaDocument.caption`）。最终形状是
`[文件1 + 文件2 + 文件3] → 正文（组内最后一项的 caption）→ 审核控制卡`，
**不存在单独的正文文本气泡**。发布走 `copyMessages`，相册与正文一起过去，控制卡永不发布。
（早期 README 曾断言 `sendMediaGroup` 不能携带 caption —— 那是错的，只有 group 级键盘不行。）

**串行验收已通过（判据见下）**

| run | slot | slot | exec | attempts | duration | GitHub run | 429 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| bot1 A | `bot1-daily@2026-09-11T0453` | success | success | 1 | 3.3m | 34529602811 | 0 |
| bot2 A | `bot2-daily@2026-09-11T0457` | success | success | 1 | 4.3m | 34530038290 | 0 |
| bot1 B | `bot1-daily@2026-09-11T0503` | success | success | 1 | 3.0m | 34530554720 | 0 |
| bot2 B | `bot2-daily@2026-09-11T0507` | success | success | 1 | 3.3m | 34530978516 | 0 |

门禁全过：4/4 terminal、4/4 exec success、每条 **attempt 1**、每 slot ≤1 execution、**0 production delivery**、**0 uncertain**、**0 duplicate**、**0 rate-limit hit**。bot2 = 4.3m / 3.3m（历史量级 3.5–6.4m），**<10min 通过**。

串行下 0 次 429，反证此前 30 分钟阻塞纯属同一账号并发限流。四条串行意味着任何时刻只有一个 execution 持有凭据。

**凭据取舍（已裁定）**：不引入独立 shadow 凭据，直接用生产 token 验证真实路径。因此"真正的选题 →
下载 → 上传送审"由 §9 的**首个真实生产周期**覆盖，而不是由一次单独的 shadow 运行覆盖 —— 它必须由
cron 发放、由 GitHub job 执行、由人在审核群真实点击，不接受人工构造的验收。
3. 故障注入：job 超时、上报丢失、重复 dispatch、D1 写失败、runner 崩溃 —— 每次都要证明恰好一个 terminal 状态，且没有第二次执行

   **已在真实基础设施上验证**（无需凭据）：

   | 层 | 机制 | 实测证据 |
   | --- | --- | --- |
   | 1 | D1 唯一键 `(schedule_id, occurrence_at)`、`(slot_id, attempt)` | 重复插入被拒；attempt 2 仍允许（重试可用） |
   | 2 | workflow `concurrency: pixivflow-<slot_id>`（`cancel-in-progress: false`） | 同槽连发两次：第二个 run 在 `pending` 排队约 3.5 分钟，待第一个完成才 `in_progress` |
   | 3 | 终态写入 once + 认领守卫 | 重放的上报返回 `applied:false`；该 slot 始终只有 1 条 execution、1 次 `slot_terminal`，`provider_run_id` 未被覆盖 |

   其他：丢 tick 恢复（删除 occurrence 后下一次 sweep 立即重建并正确判过期）、并发 sweep（3 次 ×2 阶段全部落库、0 重复 id）、approve/reject 并发竞态（5 轮各仅 1 个赢家，两种顺序都出现）、崩溃遗留 claim 的收敛（1 恢复为 published / 1 转 uncertain）。
4. 按 §4.1 的裁定完成审核域接线
5. 一个完整调度周期内双跑（Fly 生产 + 无服务器平面），比较两边的 slot 结果
6. 切换：Cloudflare cron 接管发放，Fly watchdog 先降为 observer，再停用
7. 按 §8 停机并做隔离验证，通过后才考虑删除 Fly 常驻

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

## 8. Fly 退役：停机与删除分开

**新系统独立跑完一个完整生产周期之前，Fly 不动。** 停机和删除是两件事，中间隔着一次观察：

```
新系统完整生产周期通过（见 §9 判据）
        ↓
停止 Fly machine（flyctl machine stop，可逆）
        ↓
隔离验证：停机后至少一次真实调度 occurrence 端到端跑通，
          且确认没有任何 webhook / scheduler / review 依赖 Fly
        ↓
保留旧 volume + SQLite 快照 + 配置作为回滚材料
        ↓
才删除 Fly machine
```

> **删除的前置是"停机后确实跑通过"，不是"再等一个完整周期"。** 停机本身可逆，所以不必用时间
> 换取信心；真正不可逆的是删除，因此删除前必须有一次**停机状态下**的真实运行作为证据 —— 如果
> 控制平面还偷偷依赖 Fly，那次 occurrence 就会失败。任何在此基础上加回"必须再等一个完整周期"
> 的说法都不是本文的要求。

```bash
# 1. 停（可逆）
flyctl machine stop 683032ec6617e8 -a telesubmit-multi-bot
# 2. 确认真的没人依赖它：
#    - bot1/bot2 的 getWebhookInfo 指向 Worker
#    - 停机后 Fly 日志无新请求（观察窗口至少覆盖一次调度 occurrence）
#    - 无 pending TelePost review
# 3. 确认无回滚需求后，才删机器
flyctl machine destroy 683032ec6617e8 -a telesubmit-multi-bot
```

> ⚠️ **机器可以删，volume / SQLite / secret 备份不要同时删。** 机器只是计算实例；真正不
> 可逆的是把旧状态一起清掉。永久删除状态数据需要单独确认。

## 9. 完整生产周期判据（跑完才停 Fly）

新系统独立承担 `10:00 / 10:10 / 18:00 / 18:10`，全部满足才算通过：

| 判据 | 要求 |
| --- | --- |
| occurrence | 4/4 正确创建（canonical id、时区正确） |
| 执行 | 4/4 正确执行，或按业务语义终结（`no_candidate` / `expired` 也是合法结果） |
| 审核 | 按钮**真实经过 Worker webhook**（不是构造的回调） |
| 发布 | 正常，且 0 意外重复 |
| duplicate / uncertain | 0 / 0 |
| stuck execution | 0（无长期 `running`） |
| account admission | 正常：同一时刻只有一个 execution 持有凭据 |
| Fly | 没有承担任何隐藏职责（无 webhook、无 scheduler、无 review） |

第一轮必须**由人在审核群真实点击按钮** —— 这是唯一能证明「Telegram 官方 webhook →
Worker」这一跳的方式。独立测试 bot 只能证明测试 bot 的 webhook，最终仍必须对正式
bot1/bot2 做一次真实 cutover，因此不为它引入临时基础设施。
