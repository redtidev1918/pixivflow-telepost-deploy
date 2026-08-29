# 部署场景指南

本套件支持以下四种典型部署场景。选择适合你的场景，按步骤操作即可。

---

## 场景一：海外 VPS（有公网 IP，推荐 Webhook）

**特点**：公网可达，延迟低，Telegram 实时推送。

```bash
# 1. 克隆并配置
git clone <本仓库URL> && cd pixivflow-telepost-deploy
cp .env.example .env

# 2. 编辑 .env
vim .env
```

```ini
# 必需配置
BOT1_TOKEN=123456:ABCdef...
BOT1_CHANNEL_ID=@your_channel

# 运行模式：AUTO 自动检测公网地址后使用 Webhook
RUN_MODE=AUTO

# 如有 HTTPS 域名，指定 Webhook URL
WEBHOOK_URL=https://your-domain.com

# 可选：启用 PixivFlow
PIXIVFLOW_ENABLED=true
PIXIV_REFRESH_TOKEN=your_refresh_token...
```

```bash
# 3. 启动 TelePost（如有 Pixiv 需求则加 pixivflow）
docker compose up -d telepost        # 仅 TelePost
# 或
docker compose --profile all up -d   # 全部服务
```

---

## 场景二：无公网 IP 机器（NAT / 家庭服务器，Polling 模式）

**特点**：无公网 IP，无需域名，TelePost 轮询 Telegram。

TelePost 在 Polling 模式下仍提供完整的 HTTP API（`/api/botN/v1/*`），
PixivFlow 通过 Docker 网络内部地址 `http://telepost:8080` 投递，不受公网限制。

```bash
# 1. 克隆并配置
git clone <本仓库URL> && cd pixivflow-telepost-deploy
cp .env.example .env

# 2. 编辑 .env
vim .env
```

```ini
# 必需配置
BOT1_TOKEN=123456:ABCdef...
BOT1_CHANNEL_ID=@your_channel

# 运行模式：POLLING（无公网 IP 时使用）
RUN_MODE=POLLING
# 或 RUN_MODE=AUTO（自动检测，无 WEBHOOK_URL 时回退 Polling）

# 可选：启用 PixivFlow
PIXIVFLOW_ENABLED=true
PIXIV_REFRESH_TOKEN=your_refresh_token...
```

```bash
# 3. 启动
docker compose up -d

# 4. 查看日志确认模式
docker compose logs telepost | grep -i "polling"
```

---

## 场景三：国内服务器（需代理访问外网）

**特点**：服务器在中国大陆，需通过代理访问 Pixiv 和 Telegram API。

本套件包含可选的 Mihomo（Clash.Meta）代理容器，部署在同一 Docker 网络内，
TelePost 和 PixivFlow 通过代理访问外网。

```bash
# 1. 克隆并配置
git clone <本仓库URL> && cd pixivflow-telepost-deploy
cp .env.example .env

# 2. 编辑 .env
vim .env
```

```ini
# 必需配置
BOT1_TOKEN=123456:ABCdef...
BOT1_CHANNEL_ID=@your_channel

# 运行模式：POLLING（国内服务器通常无公网 IP）
RUN_MODE=POLLING

# 启用代理
PROXY_ENABLED=true
SUB_URL=https://your-airport.example/subscription?url=xxxxx

# 为各服务配置代理
PIXIVFLOW_PROXY=http://proxy:7890
TELEPOST_PROXY=http://proxy:7890

# 可选：启用 PixivFlow
PIXIVFLOW_ENABLED=true
PIXIV_REFRESH_TOKEN=your_refresh_token...
```

```bash
# 3. 启动全部服务（含代理）
docker compose --profile all up -d

# 4. 验证代理是否正常工作
docker compose logs proxy
```

> **提示**：国内服务器拉取 Docker 镜像可能较慢，建议配置 Docker 镜像加速器。
> 编辑 `/etc/docker/daemon.json`：
> ```json
> { "registry-mirrors": ["https://docker.mirrors.ustc.edu.cn"] }
> ```

---

## 场景四：Fly.io 低成本托管

**特点**：无需自有服务器，512 MiB 起，低成本托管。

详见 [`../fly/README.md`](../fly/README.md)。

---

## 场景五：本地开发测试

**特点**：Mac/Windows 本地运行，不依赖公网。

```bash
# 1. 克隆并配置
git clone <本仓库URL> && cd pixivflow-telepost-deploy
cp .env.example .env

# 2. 编辑 .env，只设置 Bot Token 和 Channel ID
vim .env

# 3. 启动 TelePost（默认 Polling 模式）
docker compose up -d telepost

# 4. 查看日志
docker compose logs -f telepost

# 5. 测试 API
curl http://localhost:8080/health
curl http://localhost:8080/api/bot1/v1/health
```

---

## 跨场景迁移

同一套 `.env` 配置在不同机器间迁移时，只需：

1. 在旧机器备份 `data/` 目录（数据库保留）
2. 在新机器克隆仓库、复制 `.env` 和 `data/`
3. 调整 `RUN_MODE` 和代理配置
4. 重新启动

TelePost 的 Polling 和 Webhook 模式共享同一套数据库和 API，切换模式无需数据迁移。