# PixivFlow + TelePost Deploy

一个面向实际运行的私有部署套件：同一份配置可用于海外 VPS、国内服务器、无公网
NAT 主机、Mac/Linux 本机和 Fly.io。默认镜像把一个 PixivFlow 调度器与 TelePost
多 Bot supervisor 放在同一容器，适合 512 MiB 小机器，不启动 WebUI。

## 网络模式

| 机器条件 | 启动方式 | TelePost 模式 |
|---|---|---|
| 无公网，Telegram/Pixiv 可直连 | `docker compose up -d` | AUTO 自动选择 Polling |
| 有域名且 80/443 可入站 | `docker compose --profile webhook up -d` | AUTO 选择 Webhook |
| 国内网络，需要代理 | `docker compose --profile proxy up -d` | Polling + Mihomo |
| Fly.io | `fly deploy -c fly/deploy.fly-multi-bot.toml` | Webhook |

Polling 与 Webhook 都提供相同的 `http://127.0.0.1:8080/api/botN/v1/*`，因此
PixivFlow 的投递配置无需随网络模式改变。Webhook 注册失败时 AUTO 会回退 Polling。

## 快速开始

需要 Docker 24+、Compose v2、Python 3（只用于本地校验）。

```bash
gh repo clone redtidev1918/pixivflow-telepost-deploy
cd pixivflow-telepost-deploy
./scripts/bootstrap.sh
```

编辑 `.env`，至少填写 `BOT1_TOKEN`、`BOT1_CHANNEL_ID`、`BOT1_OWNER_ID`。启用
PixivFlow 时再填写 `PIXIV_REFRESH_TOKEN` 和 Bot 内 `/gen_token` 生成的
`TELEPOST_BOT1_SUBMIT_TOKEN`。编辑 `data/pixivflow/config.json`，替换 tag、Cron，
并把需要的计划改成 `"enabled": true`。

```bash
./scripts/validate.sh
docker compose up -d
docker compose ps
curl http://127.0.0.1:8080/health
```

若 GHCR 镜像仍为私有，部署机先登录：

```bash
echo "$GHCR_READ_TOKEN" | docker login ghcr.io -u redtidev1918 --password-stdin
```

拉取不可用时可以在仓库内构建：`docker compose build stack`。国内构建机可在
`.env` 设置 `BUILD_HTTP_PROXY` / `BUILD_HTTPS_PROXY`。

## 两个 Bot 与审核策略

每个 Bot 使用自己的 Token、频道、审核群和 API 投稿 Token。默认示例是“仅 API
投稿进审核群，普通聊天投稿不审核”：

```dotenv
BOT1_API_REVIEW_REQUIRED=true
BOT1_CHAT_REVIEW_REQUIRED=false
BOT1_REVIEW_CHAT_ID=-100xxxxxxxxxx
```

Bot 2 使用对应的 `BOT2_*`。PixivFlow 模板中的两个 delivery target 固定投递到
`/api/bot1/v1/submissions` 与 `/api/bot2/v1/submissions`。

## 远程变更

PixivFlow 会监听配置文件；有效的新 JSON 通过完整校验后原子替换调度表，无需重启：

```bash
# 本机部署
./scripts/update_pixivflow_config.sh ./my-config.json

# 从 Mac 更新远端 VPS
./scripts/push_pixivflow_config.sh user@server /opt/pixivflow-telepost ./my-config.json
```

TelePost 的频道/审核策略由启动环境读取，改变后必须短暂重启 Bot 进程，但数据库、
缓存和 outbox 都保留：

```bash
cp config/telepost-policy.example.json ./telepost-policy.json
./scripts/apply_telepost_policy.sh ./telepost-policy.json
./scripts/push_telepost_policy.sh user@server /opt/pixivflow-telepost ./telepost-policy.json
```

详见 [远程更新](docs/REMOTE_UPDATES.md)。

## 公网 Webhook

域名 A/AAAA 记录指向服务器，放通 TCP 80/443 与 UDP 443，然后设置：

```dotenv
RUN_MODE=AUTO
WEBHOOK_DOMAIN=bot.example.com
WEBHOOK_URL=https://bot.example.com
```

执行 `docker compose --profile webhook up -d`。Caddy 自动申请证书；TelePost 为
每个 Bot 注册独立的 `/webhook/botN` 路径。不要把 8080 直接暴露到公网。

## 国内网络

如已有稳定外部代理，直接设置 `HTTP_PROXY_URL` 与 `EGRESS_ALL_PROXY`。使用仓库内
Mihomo 时设置 `SUB_URL`，并将两项代理地址设为 `http://proxy:7890`，再执行：

```bash
docker compose --profile proxy up -d
```

Mihomo 通常还会占用 50–100 MiB。整机只有 512 MiB 时优先使用外部代理，或升级到
1 GiB；不要靠删除失败缓存/outbox 换取表面上的低占用。详见
[国内网络](docs/MIHOMO.md)。

## 512 MiB 建议

- 最多两个 Bot，关闭搜索与 WebUI。
- `download.concurrency=1`，两个计划至少错开 15–20 分钟。
- `storageMode=cache` 配合 `delivery.deleteAfterDelivery=true`；成功后删除缓存，失败时
  保留并进入 outbox 重试。
- 保留 Compose 的日志轮转、128 MiB Node heap 与小 SQLite cache。
- 通过 `/health` 观察 `process_rss`、磁盘、cache 和 delivery outbox 指标。

完整说明见 [性能与容量](docs/PERFORMANCE.md)。

## 目录

```text
docker-compose.yml                 主编排：联合容器 + 可选 Caddy/Mihomo
docker/combined.Dockerfile         TelePost 2.9 + PixivFlow 2.9 轻量运行时
data/                              数据库、下载缓存、outbox、实际配置（不入库）
pixivflow/config/*.example.json    多计划安全模板
config/telepost-policy.example.json 非敏感频道/审核策略模板
scripts/                           初始化、校验、本机/SSH 原子更新
fly/                               Fly.io 512 MiB 配置与更新脚本
proxy/                             可选 Mihomo 镜像
```

## 安全边界

- `.env`、`data/`、`proxy-data/` 和上传临时文件均被忽略。
- Bot Token、Pixiv Refresh Token、投稿 Token、代理订阅 URL 只能放 `.env` 或平台
  Secret，不得放 JSON 模板、Git 历史或聊天截图。
- 根 API 默认只绑定 `127.0.0.1`；Webhook 通过 Caddy 反代。
- 修改频道前先处理旧审核群中的 pending 投稿，并确认 Bot 已是新频道管理员。

上游项目：[PixivFlow](https://github.com/redtidev1918/PixivFlow) ·
[TelePost](https://github.com/redtidev1918/TelePost)
