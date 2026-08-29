# PixivFlow + TelePost 部署套件

**一套配置，随处部署。** 无论机器在国内还是国外、有无公网 IP、是 VPS 还是低配
云主机，都能用同一套配置启动 PixivFlow（Pixiv 下载调度器）和 TelePost
（Telegram 频道投稿机器人）。

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

---

## 适用场景

| 场景 | 网络 | 推荐模式 | 说明 |
|---|---|---|---|
| 🏠 家庭服务器 / 无公网 NAT | 无公网 IP | `POLLING` | TelePost 轮询 Telegram，PixivFlow 本地 HTTP 投递 |
| 🌐 海外 VPS | 有公网 HTTPS | `WEBHOOK` / `AUTO` | Telegram 推送，延迟最低，可自动选择 |
| 🏢 国内服务器 | 无公网 + GFW | `POLLING` + 可选代理 | 通过 Mihomo 代理访问 Pixiv 和 Telegram API |
| ☁️ Fly.io 等平台 | 公网 HTTPS | `WEBHOOK` + Fly | 512 MiB 双 Bot + PixivFlow 联合部署（需关闭搜索、并发 1、错开计划，见 [PERFORMANCE.md](docs/PERFORMANCE.md)） |
| 💻 本地开发/Mac | 任意 | `POLLING` | 本地开发测试，不依赖公网 |

> 核心：TelePost 的 `RUN_MODE=AUTO` 会自动检测公网 Webhook 地址是否可达，
> 可达则用 Webhook，否则回退 Polling——两种模式都暴露相同的 `/api/botN/v1/*`
> HTTP API，PixivFlow 无需任何配置变更即可投递。

---

## 快速开始

```bash
# 1. 克隆本仓库
git clone <本仓库URL> && cd pixivflow-telepost-deploy

# 2. 复制环境变量模板
cp .env.example .env

# 3. 编辑 .env，填入必要配置（至少 BOT1_TOKEN 和 CHANNEL_ID）
vim .env

# 4. 启动所有服务
docker compose up -d

# 5. 查看日志
docker compose logs -f
```

> 首次启动 TelePost 容器会自动从 GitHub Container Registry 拉取预构建镜像，
> 无需本地构建；如需自定义镜像（如包含 PixivFlow 联合运行），见 `fly/` 目录。

---

## 目录结构

```
pixivflow-telepost-deploy/
├── README.md               ← 本文件：套件总览
├── docker-compose.yml      ← 主编排：启动所有服务
├── .env.example            ← 环境变量模板（不含敏感值）
├── .gitignore              ← 排除 .env、data/、*.log
│
├── telepost/               ← TelePost 服务配置
│   ├── docker-compose.yml  ← 独立部署 TelePost
│   ├── config.ini.example  ← config.ini 模板
│   └── scripts/
│
├── pixivflow/              ← PixivFlow 服务配置
│   ├── docker-compose.yml  ← 独立部署 PixivFlow
│   ├── docker-env.example  ← PixivFlow 环境变量模板
│   └── config/
│       ├── standalone.example.json     ← 单 bot 配置示例
│       └── fly-two-bots.example.json   ← 双 bot 联合部署示例
│
├── proxy/                  ← Mihomo 代理（可选，国内服务器用）
│   ├── Dockerfile
│   ├── docker-entrypoint.sh
│   ├── config.example.yaml
│   └── .env.example
│
├── fly/                    ← Fly.io 联合部署
│   ├── Dockerfile          ← 多阶段构建（TelePost + PixivFlow 合体）
│   ├── deploy.toml         ← Fly 部署配置
│   ├── config/
│   └── scripts/            ← 远程策略热更新脚本
│
├── docs/
│   ├── SCENARIOS.md        ← 各场景详细部署指南
│   ├── POLLING.md          ← Polling 模式（无公网）
│   ├── WEBHOOK.md          ← Webhook 模式（有 HTTPS）
│   └── MIHOMO.md           ← Mihomo 代理配置
│
└── scenarios/              ← 按场景组织的快捷配置
    ├── cn-server/          ← 国内服务器完整配置
    ├── overseas-vps/       ← 海外 VPS 完整配置
    └── local-dev/          ← 本地开发完整配置
```

---

## 架构

```
┌─────────────────────────────────────────────────┐
│                  docker-compose                  │
│                                                   │
│  ┌──────────┐    HTTP /api/botN/v1/*    ┌──────┐ │
│  │ TelePost │◄───────────────────────────│PixivFlow│
│  │ (Python) │    submission API          │(Node) │ │
│  │  :8080   │───┬───────────────────────►│       │ │
│  └────┬─────┘   │                        └──────┘ │
│       │         │ POLLING/WEBHOOK                  │
│       │   ┌─────┴──────┐                           │
│       │   │ Telegram   │  Bot API                  │
│       │   │  servers   │                           │
│       │   └────────────┘                           │
│       │                                            │
│  ┌────┴──────┐  (可选，国内服务器)                  │
│  │  Mihomo   │  SOCKS5/HTTP 代理                    │
│  │  :7890    │                                      │
│  └───────────┘                                      │
└─────────────────────────────────────────────────┘
```

- **TelePost** 提供 Telegram Bot 接口（投稿/搜索/管理）和 HTTP API
- **PixivFlow** 定时下载 Pixiv 作品，通过 HTTP API 投递到 TelePost
- **Mihomo**（可选）为国内服务器提供代理访问
- 所有组件共享 Docker 网络，通过容器名通信

---

## 配置速览

复制 `.env.example` 为 `.env`，至少设置以下两项：

```bash
# 必需：Telegram Bot Token（从 @BotFather 获取）
BOT1_TOKEN=123456:ABCdef...

# 必需：频道 ID（机器人需为频道管理员）
BOT1_CHANNEL_ID=@your_channel

# 可选：Pixiv Refresh Token（启用 PixivFlow 时需要）
PIXIV_REFRESH_TOKEN=your_refresh_token...
```

其余配置项见 `.env.example` 内详细注释。

---

## 部署模式选择

### 无公网 IP → Polling（默认）

TelePost 自动轮询 Telegram 获取更新，无需配置任何域名或 HTTPS。

```bash
# 已在 .env 中默认设置，无需额外操作
RUN_MODE=POLLING
```

PixivFlow 通过 `http://telepost:8080/api/bot1/v1/submissions` 本地投递。

### 有公网 HTTPS → Webhook

TelePost 注册 Webhook 回调，Telegram 实时推送更新。

```bash
# .env 中设置
RUN_MODE=WEBHOOK
WEBHOOK_URL=https://your-domain.com
```

### 国内服务器 → 可选 Mihomo 代理

```bash
# .env 中启用代理
PROXY_ENABLED=true
# PixivFlow 通过代理访问 Pixiv
PIXIVFLOW_PROXY=http://proxy:7890
# TelePost 通过代理访问 Telegram API
TELEPOST_PROXY=http://proxy:7890
```

### Fly.io → 低成本托管

```bash
cd fly/
fly deploy -c deploy.your-app-name.toml --now
```

详见 [`fly/README.md`](fly/README.md)。性能调优见 [docs/PERFORMANCE.md](docs/PERFORMANCE.md)。

---

## 项目来源

本套件整合以下开源项目：

| 项目 | 仓库 | 说明 |
|---|---|---|
| [PixivFlow](https://github.com/redtidev1918/PixivFlow) | `redtidev1918/PixivFlow` | Pixiv 下载调度器，支持定时任务、自动投递到 TelePost |
| [TelePost](https://github.com/redtidev1918/TelePost) | `redtidev1918/TelePost` | Telegram 频道投稿机器人，支持媒体/文档投稿、搜索、多 bot |
| Mihomo (Clash.Meta) | `metacubex/mihomo` | 代理核心（可选），用于国内服务器访问外网 |

---

## 安全说明

- `.env`（含 Bot Token、Pixiv Refresh Token 等敏感信息）已被 `.gitignore` 排除，**永不入库**
- 运行时数据（数据库、下载文件、日志）写入 `data/` 目录，同样被 `.gitignore` 排除
- TelePost 的 HTTP API 使用 Bearer Token 鉴权，需通过 `/gen_token` 在 Telegram 内生成
- 所有敏感值应通过环境变量或 Docker Secrets 注入，不写入配置文件

---

## License

MIT