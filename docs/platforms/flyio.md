# Fly.io（split-worker，推荐的生产拓扑）

> **本页是「在 Fly.io 上部署 `split-worker`」的权威操作说明。** 它是**当前生产**使用的拓扑，
> 也是**推荐**的 Fly 生产拓扑——但**不是唯一合法的生产拓扑**。单机 Fly 见
> [single-machine-worker-sleep.md](../architectures/single-machine-worker-sleep.md)，
> 不变量见 [lifecycle.md](../concepts/lifecycle.md) 与 [credentials.md](../concepts/credentials.md)。

## 适合谁

希望执行端**平时不产生计算费用**、故障隔离好、主机级凭据隔离干净，并接受组件更多、需要外部唤醒
时钟的人。

## 拓扑

```text
Cloudflare Cron（薄 Worker，无数据库）
      │  POST /internal/schedules/<id>/run  （Bearer SCHEDULER_TRIGGER_TOKEN）
      ▼
Fly Proxy  auto_start_machines = true ──► 唤醒停止的执行端机器
      │
      ▼
pixivflow-scheduler（独立机器 + 独立卷，平时 stopped，跑完 exit(0)）
      │ POST /publish/rich-novel（富媒体小说，Flycast 私网 + bearer）
      ▼
telepress-publish（常驻机器，无持久卷；Catbox 上传 + Telegraph 页面）
      │ POST /api/botN/v1/submissions（Flycast 私网 + bearer）
      ▼
telesubmit-multi-bot（常驻机器 + 独立卷，唯一持有 Telegram 令牌）
      │
      ▼
Telegram（审核群 → 人工批准 → 频道）
```

矩阵记录：`presets.split-worker` 的 `telepost.lifecycle = always-on`、
`pixivflow.lifecycle = wake-run-exit`、`clock.allowed = [cloudflare, external]`、
`transport = flycast`、`stateLayout = own-volume`，`status = stable`。

## 三份 Fly 配置，一个应用一份

| 文件 | 应用 | 生命周期 | 卷 |
| --- | --- | --- | --- |
| `fly/deploy.telepost.toml` | 业务端 | `always-on`（`auto_stop=false`, `min=1`, 长期 `/health` 检查） | `data` → `/app/data` |
| `fly/deploy.pixivflow.toml` | 执行端 | `wake-run-exit`（`auto_start=true`, `auto_stop=false`, `restart=never`，**无** checks） | `pixivflow_data` → `/app/data` |
| `fly/deploy.telepress.toml` | 富媒体发布端 | `always-on`（`auto_stop=false`, `min=1`, `/` 检查） | 无（Catbox/Telegraph 远端状态） |

首次使用把三份配置里的 `app` 改成自己的名字，然后：

```bash
fly deploy -c fly/deploy.telepost.toml  --ha=false
fly deploy -c fly/deploy.pixivflow.toml --ha=false
fly deploy -c fly/deploy.telepress.toml --ha=false
```

## 部署前必读的三条生命周期规则

执行端的生命周期由**三处**共同决定，缺一不可（`fly/deploy.pixivflow.toml` 头部注释）：

1. **默认停止**：空闲 worker 不该被计费或占用内存。
2. **被时钟唤醒**：Cloudflare Worker POST 一个带令牌的触发；Fly proxy 启动停止的机器再转发
   （`auto_start_machines = true`）。因此触发路径里**没有**机器管理 API 令牌或机器 id。
3. **账本空了自行退出**：`schedulerRuntime.exitWhenIdle` 使进程在无 pending/running 槽位、
   无未完成投递时 `exit(0)`。`restart.policy = "never"` 是另一半：若让平台重启，机器会立刻
   回来，「停止」状态永远无法到达。`never` 是 fly.toml 写法；Machines API 归一化为
   `restart.policy = "no"`，flyctl 拒绝在 toml 里写 `no`。

**执行端刻意不配置 `http_service.checks`**（`SI-5`）：探测会不断打到刚决定收工的机器上，
把它反复叫醒。

## 镜像固定

| 应用 | 固定方式 | 规则 |
| --- | --- | --- |
| 业务端 | `TELEPOST_IMAGE`（发布版本，如 `...telepost:2.35.0`） | **绝不用 `latest`** |
| 执行端 | `PIXIVFLOW_REF`（**40 位提交号**） | 绝不用分支名，也不用 tag |
| 富媒体发布端 | TelePress 镜像/版本（见 `docker/telepress.Dockerfile`） | 发布流水线固定；不依赖 `latest` |

`PIXIVFLOW_REF` 必须是 40 位提交号：镜像运行时会回显 build-arg 字面量
（`PIXIVFLOW_REVISION=${PIXIVFLOW_VERSION}+${PIXIVFLOW_REF}`），钉 tag 会让「正在跑哪个提交」
无法回答。`scripts/verify-images.sh` 会直接拒绝非提交号的 `PIXIVFLOW_REF`。改 `PIXIVFLOW_REF`
即可把未发布提交部署到执行端（`docker/pixivflow-scheduler.Dockerfile` 按该提交号克隆编译）。

路径规则（`fly/deploy.pixivflow.toml`）：`PIXIV_DOWNLOADER_CONFIG` 用**绝对**路径（烘焙进镜像，
不依赖工作目录）；配置文件里的 `storage` 路径用**相对**路径（`./data/...`）——PixivFlow 的
加载器会「自动修正」配置目录之外的绝对路径，替换成默认的 `/app/downloads`（卷旁边的**临时**
路径）。

## Secrets

```bash
# 执行端：Pixiv 凭据 + 触发令牌 + 投稿令牌（无任何 Telegram 令牌，SI-1）
fly secrets set -a pixivflow-scheduler \
  PIXIV_REFRESH_TOKEN=... SCHEDULER_TRIGGER_TOKEN=... \
  TELEPOST_BOT1_SUBMIT_TOKEN=...

# 业务端：Telegram 令牌 + 投稿令牌（执行端用它鉴权）
fly secrets set -a telesubmit-multi-bot \
  BOT1_TOKEN=... BOT1_CHANNEL_ID=... BOT1_OWNER_ID=... \
  TELEPOST_BOT1_SUBMIT_TOKEN=...

# 富媒体发布端：Telegraph 账号 + 供 PixivFlow 调用 /publish/rich-novel 的密钥
fly secrets set -a telepress-publish \
  TELEGRAPH_ACCESS_TOKEN=... \
  TELEPRESS_API_KEY=...

# 执行端配置里把 richNovelPreview.headers 用同一个 TELEPRESS_API_KEY
```

Fly secret 在机器停止时不可见（`inactive`），这是正常现象——唤醒不是通过 secret，而是通过
带令牌的触发请求。

## 传输的两条硬约束

1. **`force_https = false` 不能删**：明文 Flycast 投递（WireGuard 保护的 6PN）若被
   Fly proxy 301 到 HTTPS，执行端不跟这条路，投递变死路。对公网，Telegram webhook 与审核 API
   仍走 HTTPS。执行端到 TelePress 的 `http://telepress-publish.flycast` 与到
   TelePost 的 `http://telesubmit-multi-bot.flycast` 都是同一语义。
2. **执行端 `TELEPOST_API_BASE_URL = http://telesubmit-multi-bot.flycast`**：这是执行端唯一
   够得到业务端的方式，且**不带** Telegram 令牌与频道 id（`SI-1`）。
   富媒体小说的 TelePress 目标同理走 `http://telepress-publish.flycast/publish/rich-novel`。

## 时钟

`control-plane/` 的薄 Worker 是生产主时钟：cron（UTC）→ schedule id → 一次带令牌 POST，
无 D1/queue/KV 绑定。部署与 secret 见 [cloudflare.md](./cloudflare.md)。也可以改用任何
`external` cron（见 [scheduling.md](../concepts/scheduling.md)）。

## 验证

```bash
./scripts/verify-images.sh        # 线上镜像 == 固定提交号/版本
./scripts/verify-webhooks.sh      # webhook 归属只有 TelePost（SI-2）
fly status -a telesubmit-multi-bot
fly status -a pixivflow-scheduler  # 空闲时应为 stopped：健康状态，不是故障
fly status -a telepress-publish    # 常驻；实际无需手动停机
```

## 成本模型

省钱来自**执行端默认停止**，不是来自业务端休眠（业务端必须常驻，冷启动对用户可见）。见
[lifecycle.md](../concepts/lifecycle.md) 与
[single-machine-worker-sleep.md](../architectures/single-machine-worker-sleep.md) 的
「进程休眠 ≠ 机器休眠」说明。

## 相关页面

- Preset 说明：[split-worker.md](../architectures/split-worker.md)
- 生命周期不变量：[lifecycle.md](../concepts/lifecycle.md)
- 凭据边界：[credentials.md](../concepts/credentials.md)
- 时钟平面：[cloudflare.md](./cloudflare.md)
- 迁移：[migration.md](../architectures/migration.md)
