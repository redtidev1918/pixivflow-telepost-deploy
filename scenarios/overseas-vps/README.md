# 海外 VPS 部署方案

## 适用场景

- 服务器位于海外
- 有公网 IP
- 可直接访问 Pixiv 和 Telegram API

## 配置要点

```ini
# 运行模式（有公网 HTTPS 推荐 Webhook）
RUN_MODE=AUTO
WEBHOOK_URL=https://你的域名

# 无需代理
# PROXY_ENABLED=false
```

## 启动

```bash
docker compose up -d telepost
# 或同时启动 PixivFlow
docker compose --profile pixivflow up -d
```
