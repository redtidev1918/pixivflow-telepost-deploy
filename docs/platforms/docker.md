# Docker / Docker Compose（单机一体化）

> **本页是「用 Compose 在一台机器上跑整套服务」的权威操作说明**，对应 preset
> [`single-host`](../architectures/single-host.md)。它同时吸收并取代旧的 `SCENARIOS.md`、
> `POLLING.md` 与 `WEBHOOK.md`。Compose 描述的是**单宿主拓扑**；要拆两台见
> [remote-worker.md](../architectures/remote-worker.md)，要 Fly 见 [flyio.md](./flyio.md)。

## 适合谁

一台 VPS / NAS / 家用机 / 本机，希望用最少组件把整套服务跑起来。

## 需要什么

- Docker 24+ 与 Compose v2
- Linux/macOS（或 Git-Bash）
- 512 MiB 起步；256 MiB 只能单 Bot 且不跑执行端

## 拓扑

`docker-compose.yml` 定义两个独立 service + 两个可选 profile：

```text
One Host
├─ telepost        （业务端：常驻，唯一持有 Telegram 令牌）
├─ pixivflow       （执行端：同机，容器网络投递）
├─ caddy           （可选 profile webhook：公网 HTTPS）
└─ proxy           （可选 profile proxy：内置 Mihomo）
        ↑ 共享 ./data 卷与 app 网络
```

矩阵记 `single-host` 的 `stateLayout = shared-volume`、`state = own + own`（同机两角色各占
子目录，但同一卷）：这是**已记录的限制**，不是错误。见 [state.md](../concepts/state.md)。

## 最快开始

```bash
git clone https://github.com/redtidev1918/pixivflow-telepost-deploy
cd pixivflow-telepost-deploy
./scripts/bootstrap.sh          # 生成 .env 与 data/pixivflow/config.json
# 编辑 .env：至少填 BOT1_TOKEN / BOT1_CHANNEL_ID / BOT1_OWNER_ID
./scripts/validate.sh
docker compose up -d
docker compose ps
curl http://127.0.0.1:8080/health
```

Windows 手动等价：复制 `.env.example` → `.env`，复制
`pixivflow/config/fly-two-bots.example.json` → `data/pixivflow/config.json`。

## 三种网络模式

| 机器条件 | 启动方式 | TelePost 模式 |
| --- | --- | --- |
| 无公网，Telegram/Pixiv 可直连 | `docker compose up -d` | AUTO 选 Polling |
| 有域名且 80/443 可入站 | `docker compose --profile webhook up -d` | AUTO 选 Webhook |
| 国内网络需代理 | `docker compose --profile proxy up -d` | Polling + Mihomo |

Polling 与 Webhook 提供**同一套** `http://127.0.0.1:8080/api/botN/v1/*`，所以执行端的投递
配置不随入站模式改变。Webhook 注册失败时 AUTO 回退 Polling。入站模式的选择与不变量见
[network.md](../concepts/network.md)。

### Polling（无公网入口）

默认 `RUN_MODE=AUTO` 且 `WEBHOOK_URL` 为空 → 长轮询。根 API 只绑定 `127.0.0.1:8080`
（`BIND_ADDRESS`），**不要**把 8080 暴露到公网。

### Webhook（公网 HTTPS）

域名 A/AAAA 指向服务器，放通 TCP 80/443 与 UDP 443，然后：

```dotenv
RUN_MODE=AUTO
WEBHOOK_DOMAIN=bot.example.com
WEBHOOK_URL=https://bot.example.com
```

```bash
docker compose --profile webhook up -d
```

Caddy 自动申请证书；TelePost 为每个 Bot 注册独立的 `/webhook/botN` 路径。**webhook 归属永远
只有 TelePost 一个**（`SI-2`）。核对：

```bash
BOT1_TOKEN=... ./scripts/verify-webhooks.sh
```

## 手动执行一次（不等 Cron）

```bash
# 在运行机器上验证「昨日最热门 + 主题相关 tag」链路：
docker compose exec pixivflow pixivflow download --config /app/data/pixivflow/config.json
```

## 远程变更 / 升级

Compose 部署下 `watchConfig = true`：PixivFlow 监听 `data/pixivflow/config.json`，校验通过后
原子替换调度表，无需重启；TelePost OWNER 可用 `/botconfig` 改当前 Bot 策略。升级：

```bash
./deploy tp latest     # TelePost
./deploy pf 2.10.31    # PixivFlow 到指定版本
# 或改 .env 后 docker compose up -d
```

生产建议把 `TELEPOST_IMAGE` / `PIXIVFLOW_IMAGE` 固定到明确 Release 标签，不要用 `latest`。
细节见 [upgrades.md](../operations/upgrades.md)。

## 资源与限制

Compose 按整机 512 MiB 预算默认分配：**telepost 320m + pixivflow 192m**（`mem_limit` 可调）。
约束（见 [environment.md](../reference/environment.md)）：

- 最多两个 Bot，关闭搜索与 WebUI（`SEARCH_ENABLED=false`、`simple` 分词器）。
- `download.concurrency=1`；同一 Cron 的多个计划串行排队，紧张时错开 15–20 分钟。
- 复用下载内容用 `storageMode=cache` + `delivery.deleteAfterDelivery=false`，
  并设 `cacheRetentionDays=7` / `cacheMaxSizeMB=384`；outbox 独立保留。
- 保留日志轮转、96 MiB Node heap、小 SQLite cache。

**不要靠删除失败缓存/outbox 换取表面低占用**（见 [troubleshooting.md](../operations/troubleshooting.md)）。

## 与生产拓扑的区别

Compose 是**单机一体化**：单故障域、共享卷、执行端与业务端同机。当前 Fly 生产是
[`split-worker`](../architectures/split-worker.md)（两机两卷，凭据边界成立）。两者业务语义
完全相同，只是部署事实不同——这是本套件从「固定生产拓扑」升级为「部署矩阵」的核心。迁移
路径见 [migration.md](../architectures/migration.md)。

## 相关页面

- 单机 preset：[single-host.md](../architectures/single-host.md)
- 网络与出口：[network.md](../concepts/network.md)
- 代理容器：[proxy.md](./proxy.md)
- 环境变量与档位：[environment.md](../reference/environment.md)
