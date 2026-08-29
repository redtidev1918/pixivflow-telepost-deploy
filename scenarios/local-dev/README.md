# 本地开发部署方案

## 适用场景

- Mac 或 Windows 本地开发
- 无公网 IP
- 快速测试 TelePost + PixivFlow 集成

## 配置要点

```ini
# 运行模式（无公网自动回退 Polling）
RUN_MODE=AUTO

# 无需 Webhook 地址
# WEBHOOK_URL=
```

## 启动

```bash
docker compose up -d telepost
docker compose logs -f telepost
```

## 测试 API

```bash
# 健康检查
curl http://localhost:8080/health

# 多 bot API
curl http://localhost:8080/api/bot1/v1/health
```
