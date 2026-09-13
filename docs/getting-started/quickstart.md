# 快速开始

> **本页是「从零到第一个 bot 发出一条待审核投稿」的最短路径。** 默认走
> [`single-host`](../architectures/single-host.md)（Compose）。
> 其它 preset 的部署入口见文末。命令与配置项的完整说明见
> [docker.md](../platforms/docker.md) 与 [environment.md](../reference/environment.md)。

---

## 0. 先决定两件事

| 问题 | 影响 |
| --- | --- |
| 有没有公网域名可以做 HTTPS 入站？ | 有 → `telegramIngress=webhook`；没有 → `polling`（默认，不需要域名和证书） |
| 机器内存多大？ | 256 MiB → 单 Bot、不跑 `executor`；512 MiB → 双 Bot + `executor`；≥1 GiB → 可开搜索与 WebUI |

不确定选哪个 preset，用 [choose-architecture.md](choose-architecture.md) 的两张表。

---

## 1. 准备凭据

| 凭据 | 从哪来 | 放哪 |
| --- | --- | --- |
| `BOT1_TOKEN` | `@BotFather` 创建机器人 | `.env` 或平台 secret |
| `BOT1_CHANNEL_ID` | 目标频道（`@频道名` 或 `-100…`） | 同上 |
| `BOT1_OWNER_ID` | 你自己的 Telegram 用户 ID | 同上 |
| `BOT1_REVIEW_CHAT_ID` | 审核群 ID（需要审核时填） | 同上 |
| `PIXIV_REFRESH_TOKEN` | Pixiv 授权流程 | 同上 |
| `TELEPOST_BOT1_SUBMIT_TOKEN` | 机器人内 `/gen_token` 生成 | 同上 |

机器人必须先成为目标频道的管理员，否则发布失败。

**凭据只能放 `.env` 或平台 secret。** 不要写进 JSON 模板、不要提交进 Git、
不要贴进聊天截图。完整规则见 [credentials.md](../concepts/credentials.md)。

---

## 2. 安装

### 路线 A：一个二进制（不需要 clone 仓库）

```bash
deploy init mybot          # 就地生成 .env / compose / 示例配置，向导式填 Bot 信息
cd mybot
deploy doctor              # 环境自检：依赖、配置、登录、网络
deploy deploy              # docker compose pull/up + 健康检查
```

`deploy init` 的向导会问部署场景：**Webhook**（有域名）、**国内 + Mihomo 代理**、
**Fly.io**；直接回车保持 Polling。非交互（管道/CI）时全部静默，只生成占位配置。

二进制从 [Releases](https://github.com/redtidev1918/pixivflow-telepost-deploy/releases)
下载 `deploy-<os>-<arch>`，解压改名 `deploy`，Linux/macOS 记得 `chmod +x`。
本机有 Go 1.22+ 时也可以 `go build -o deploy .`。

### 路线 B：克隆仓库

```bash
git clone https://github.com/redtidev1918/pixivflow-telepost-deploy
cd pixivflow-telepost-deploy
./scripts/bootstrap.sh     # 生成 .env 与 data/pixivflow/config.json
```

Windows 手动做同样的事：复制 `.env.example` 为 `.env`，把
`pixivflow/config/fly-two-bots.example.json` 复制为 `data/pixivflow/config.json`。

---

## 3. 填配置

编辑 `.env`，至少填 `BOT1_TOKEN`、`BOT1_CHANNEL_ID`、`BOT1_OWNER_ID`。
启用 `executor` 时再填 `PIXIV_REFRESH_TOKEN` 与 `TELEPOST_BOT1_SUBMIT_TOKEN`。

编辑 `data/pixivflow/config.json`（参考 `pixivflow/config/fly-two-bots.example.json`）：

1. 把示例主题 `ミク` / `アークナイツ` 换成你要的 tag；
2. 调整 `schedules` 里的 cron；
3. 把要执行的计划改成 `"enabled": true`。

`delivery.targets` 里的两个目标是 `/api/bot1/v1/submissions` 与 `/api/bot2/v1/submissions`，
`TELEPOST_API_BASE_URL` 决定它们打到哪台机器。

---

## 4. 起服务

```bash
./scripts/validate.sh              # 配置 / 脚本 / 公开仓库卫生
docker compose up -d
docker compose ps
curl http://127.0.0.1:8080/health
```

需要公网 HTTPS 入站时：

```dotenv
RUN_MODE=AUTO
WEBHOOK_DOMAIN=bot.example.com
WEBHOOK_URL=https://bot.example.com
```

```bash
docker compose --profile webhook up -d
```

Caddy 自动申请证书，每个 Bot 用独立的 `/webhook/botN` 路径。
`RUN_MODE=AUTO` 在 webhook 注册失败时回退 Polling。
**不要把 8080 直接暴露到公网。**

国内网络需要代理时：

```dotenv
SUB_URL=https://example.invalid/subscription
HTTP_PROXY_URL=http://proxy:7890
EGRESS_ALL_PROXY=http://proxy:7890
```

```bash
docker compose --profile proxy up -d
```

---

## 5. 验证

| 检查 | 命令 | 期望 |
| --- | --- | --- |
| 服务在跑 | `docker compose ps` | 两个 service 都是 `Up`（healthy） |
| 健康端点 | `curl http://127.0.0.1:8080/health` | 200，含 `process_rss`、`storage.review_queue` |
| 投稿 API 鉴权 | 带令牌请求 `/api/bot1/v1/health` | 200；不带令牌 401 |
| Telegram 入站 | 私聊机器人发一条消息 | 机器人有回应 |
| 审核链路 | 在机器人内用 `/gen_token` 生成投稿令牌，手动触发一次下载 | 审核群出现待审核投稿 |
| webhook 归属（webhook 模式） | `./scripts/verify-webhooks.sh` | 两个 bot 的 webhook 都指向本机 |

手动单次触发（不等待 Cron，在运行 `executor` 的机器上执行）：

```bash
pixivflow download --config /app/data/pixivflow/config.json
```

---

## 6. 之后做什么

| 想做的事 | 看哪里 |
| --- | --- |
| 加第 N 个频道 | [multi-bot.md](../operations/multi-bot.md) |
| 内存不够 / OOM | [performance.md](../operations/performance.md)、[troubleshooting.md](../operations/troubleshooting.md) |
| 备份与恢复 | [backup.md](../operations/backup.md) |
| 升级 | [upgrades.md](../operations/upgrades.md) |
| 日常巡检 | [monitoring.md](../operations/monitoring.md) |
| 改架构（拆机器 / 上 Fly） | [migration.md](../architectures/migration.md) |

---

## 其它 preset 的入口

| Preset | 入口 |
| --- | --- |
| `single-host`（本页） | [docker.md](../platforms/docker.md) |
| `split-worker` | [flyio.md](../platforms/flyio.md) → [cloudflare.md](../platforms/cloudflare.md) |
| `remote-worker` | [remote-worker.md](../architectures/remote-worker.md) → [vps.md](../platforms/vps.md) |
| `single-machine-worker-sleep` | **尚无实现**，见 [该 preset 的说明](../architectures/single-machine-worker-sleep.md) |
| 无 Docker 的 Linux VPS | [vps.md](../platforms/vps.md) 的 systemd 路线 |
