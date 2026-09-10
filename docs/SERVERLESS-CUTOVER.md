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

### 4.1 一个 bot 只能有一个 webhook —— 审核域归属尚未裁定

**实测**（`getWebhookInfo`）：

```
bot1 -> https://telesubmit-multi-bot.fly.dev/webhook/bot1   (allowed_updates 含 callback_query)
bot2 -> https://telesubmit-multi-bot.fly.dev/webhook/bot2   (allowed_updates 含 callback_query)
```

TelePost 现在**独占**这两个 bot 的 webhook，并且已经实现了完整的审核域：媒体暂存、行内键盘、批准 → 发布到频道、驳回、过期、崩溃恢复（`publishing` 僵尸回收）、重复检测、幂等键（`handlers/review.py`）。

Telegram 不支持一个 bot 挂两个 webhook。因此：

- **在裁定之前，绝不可对 bot1/bot2 调用 `setWebhook` 指向 Worker** —— 那会在无人察觉的情况下切断 Fly 上正在使用的审核流程。
- 控制平面的 `/telegram/webhook/<botId>` 保持 fail-closed 且不接收任何更新；这条路由存在但不生效。

三个可选方向（需要拍板）：

1. **TelePost 保留审核域**（与目标架构表述一致）。控制平面不再处理 Telegram 回调与发布，只通过 TelePost 的回调/查询获知 `submitted / decided / published`。需要 TelePost 增加「按引用提交」（传 message ids 而非文件）与「决策通知控制平面」两个端点。
2. **控制平面接管审核域**，cutover 时把 webhook 切到 Worker，TelePost 的审核流程退役。影响面大，且会退役一套已被生产验证的实现。
3. 保留 TelePost 的批准/发布，仅去掉媒体中转：runner 直传审核群，再把引用交给 TelePost。

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

1. 配 GitHub secrets：`TELEGRAM_BOT1_TOKEN`、`TELEGRAM_BOT2_TOKEN`、`CALLBACK_SECRET`、`CONTROL_PLANE_URL`
2. Shadow 实跑一次完整 occurrence（`--mode shadow`，`EXECUTION_MODE=shadow`）：验证选题、去重、下载、上报、`processed_works` 落库，且**不发布任何内容**
3. 故障注入：job 超时、上报丢失、重复 dispatch、D1 写失败、runner 崩溃 —— 每次都要证明恰好一个 terminal 状态，且没有第二次执行
4. 按 §4.1 的裁定完成审核域接线
5. 一个完整调度周期内双跑（Fly 生产 + 无服务器平面），比较两边的 slot 结果
6. 切换：Cloudflare cron 接管发放，Fly watchdog 先降为 observer，再停用
7. 观察一个完整周期后，才考虑删除 Fly 常驻

## 6. 回滚

- Fly 生产**全程不动**，因此回滚 = 停止 Cloudflare cron 派发。不需要恢复数据。
- D1 中只有影子数据（合成 slot / review / `99999999` 作品），删除无影响。
- 任何时刻只要 `PIXIVFLOW_ENABLED` / watchdog 仍指向 Fly，生产就还在原路径上。
- 绝不可移动已发布的 tag；重建镜像走独立的 rebuild workflow。

## 7. 已知隐患（与迁移无关，但应单独修）

1. `token-maintenance.ts` 丢弃轮换后的 refresh token（§4.2）。生产每次启动都在丢自己的新 token。
2. 配置加载器会把 unified storage 里的 token 回写到传入的配置文件；CI 中若配置文件来自 checkout，会被就地改写（job 结束即丢弃，属可接受，但不要把它当成只读）。
3. 模块内存在两套配置校验器，规则重复。`telegram` 类型曾在其中一处缺失，导致该交付目标完全无法配置 —— 现已统一为 `collectTelegramDeliveryErrors`。
