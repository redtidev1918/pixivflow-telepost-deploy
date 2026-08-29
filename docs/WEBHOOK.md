# Webhook 模式指南

Webhook 模式下，Telegram 服务器在有新消息时主动推送到你的服务器，
延迟最低，适合生产环境。

---

## 前提条件

- 公网可达的 HTTPS 域名
- 服务器 443 端口（或通过反向代理转发）

---

## 配置

```ini
# 方式一：显式指定 Webhook
RUN_MODE=WEBHOOK
WEBHOOK_URL=https://your-domain.com

# 方式二：自动选择（检测到公网可达的 WEBHOOK_URL 时使用 Webhook）
RUN_MODE=AUTO
WEBHOOK_URL=https://your-domain.com
```

---

## 多 bot Webhook

多 bot 模式下，TelePost 自动：

1. 路由进程监听 `8080` 端口
2. 为每个 bot 分配独立子进程（端口 `8081`、`8082`…）
3. 注册 Webhook 回调路径：`/webhook/bot1`、`/webhook/bot2`…
4. 路由转发：`/webhook/botN` → `127.0.0.1:8080+N`

```
                    ┌─────────────────┐
                    │  Telegram 服务器  │
                    └────────┬────────┘
                             │ HTTPS POST
                             ▼
                    ┌─────────────────┐
                    │  路由进程 :8080  │
                    └──┬─────┬────┬──┘
                       │     │    │
              ┌────────┘     │    └────────┐
              ▼              ▼              ▼
       ┌──────────┐  ┌──────────┐  ┌──────────┐
       │bot1:8081  │  │bot2:8082  │  │bot3:8083  │
       │/webhook/  │  │/webhook/  │  │/webhook/  │
       │bot1       │  │bot2       │  │bot3       │
       └──────────┘  └──────────┘  └──────────┘
```

---

## 与 PixivFlow 集成

Webhook 模式下，PixivFlow 的投递配置与 Polling 模式完全相同：

```json
{
  "url": "http://telepost:8080/api/bot1/v1/submissions"
}
```

因为 TelePost 的 API 路由在两种模式下都监听 `/api/botN/v1/*` 路径。

---

## Nginx 反向代理示例

如果不想直接暴露 `8080` 端口，可以用 Nginx 做反向代理和 SSL 终止：

```nginx
server {
    listen 443 ssl;
    server_name your-domain.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```
