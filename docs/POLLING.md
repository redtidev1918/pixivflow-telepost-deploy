# Polling：无公网部署

`.env` 保持 `RUN_MODE=AUTO`、`WEBHOOK_URL=` 即可。TelePost 主动访问 Telegram，
不需要入站端口、域名或证书；根 API 默认只监听宿主机 `127.0.0.1:8080`。

```bash
docker compose up -d
curl http://127.0.0.1:8080/health
curl -H "Authorization: Bearer $TELEPOST_BOT1_SUBMIT_TOKEN" \
  http://127.0.0.1:8080/api/bot1/v1/health
```

PixivFlow 与 TelePost 在同一容器内，投递地址始终是
`http://127.0.0.1:8080/api/botN/v1/submissions`。这条内部请求不经过代理，也不消耗
公网流量。外部机器若要投稿，应通过 SSH 隧道而不是公开 8080：

```bash
ssh -L 18080:127.0.0.1:8080 user@server
```
