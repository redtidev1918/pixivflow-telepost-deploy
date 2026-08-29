# Webhook：公网 HTTPS 部署

要求域名解析到服务器，并允许 80/443 入站。在 `.env` 设置域名和 HTTPS 根地址：

```dotenv
RUN_MODE=AUTO
WEBHOOK_DOMAIN=bot.example.com
WEBHOOK_URL=https://bot.example.com
```

```bash
docker compose --profile webhook up -d
docker compose logs -f caddy stack
curl https://bot.example.com/health
```

Caddy 自动签发和续期证书，反代到 `stack:8080`。TelePost 多 Bot 使用
`/webhook/bot1`、`/webhook/bot2` 等独立路径。`RUN_MODE=AUTO` 在 Webhook 注册失败
时回退 Polling；投稿 API 地址不变。

安全建议：保持 `BIND_ADDRESS=127.0.0.1`，不要另行公开 8080；只开放 Caddy 的
80/443。若已有 Nginx、Traefik 或 Cloudflare Tunnel，不启动 `webhook` profile，
把现有反代指向 `127.0.0.1:8080` 即可。
