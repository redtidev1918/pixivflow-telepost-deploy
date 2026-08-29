# Polling 模式指南

Polling 模式下，TelePost 主动轮询 Telegram 服务器获取更新，无需公网 IP、
无需域名、无需 HTTPS 证书。适用场景：

- 家庭服务器 / NAS（无公网 IP）
- NAT 内网机器
- 国内服务器（无公网 IP）
- 本地开发测试

---

## 工作原理

```
TelePost ────(long polling)───→ Telegram Bot API
    │
    │  HTTP API (localhost only)
    │  /api/bot1/v1/submissions
    │  /api/bot2/v1/submissions
    │
    └──←── PixivFlow ────→ Pixiv
```

- TelePost 通过长轮询（Long Polling）从 Telegram 获取更新
- 同时在本机暴露 HTTP API，供 PixivFlow 投递
- 两种更新获取方式的服务端 API 完全一致

---

## 配置

```ini
# 方式一：显式指定
RUN_MODE=POLLING

# 方式二：自动选择（不设置 WEBHOOK_URL 时自动回退 Polling）
RUN_MODE=AUTO
```

---

## 与 PixivFlow 集成

Polling 模式下，TelePost 的路由进程始终运行在 `8080` 端口，
PixivFlow 的投递目标配置：

```json
{
  "delivery": {
    "targets": {
      "telepost-bot1": {
        "type": "httpMultipart",
        "url": "http://telepost:8080/api/bot1/v1/submissions",
        "headers": {
          "Authorization": "Bearer ${TELEPOST_BOT1_SUBMIT_TOKEN}"
        }
      }
    }
  }
}
```

> 注意：Docker Compose 部署时使用容器名 `telepost` 作为主机名；
> 单机部署（非 Docker）时使用 `127.0.0.1`。

---

## 验证

```bash
# 健康检查
curl http://localhost:8080/health

# 多 bot API 健康检查
curl http://localhost:8080/api/bot1/v1/health

# 查看日志确认模式
docker compose logs telepost | grep -i "polling"
# 应看到: "Polling HTTP server started: http://0.0.0.0:8081"
```

---

## 注意事项

- Polling 模式没有 Webhook 的实时推送优势，但可靠性更高（不受网络波动影响）
- 对于投稿机器人，秒级延迟差异对用户体验影响极小
- 同一机器上 Polling 和 Webhook 模式均可使用完全相同的 PixivFlow 投递配置
