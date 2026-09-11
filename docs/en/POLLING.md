# Polling: deployment without public ingress

**Language / 语言:** [中文](/POLLING.md) · English

Keep `RUN_MODE=AUTO` and `WEBHOOK_URL=` in `.env`. TelePost reaches out to Telegram, so no
inbound port, domain or certificate is needed; the root API listens only on the host's
`127.0.0.1:8080` by default.

```bash
docker compose up -d
curl http://127.0.0.1:8080/health
curl -H "Authorization: Bearer $TELEPOST_BOT1_SUBMIT_TOKEN" \
  http://127.0.0.1:8080/api/bot1/v1/health
```

PixivFlow and TelePost run in the same container, so the delivery address is always
`http://127.0.0.1:8080/api/botN/v1/submissions`. That internal request bypasses the proxy and
consumes no public bandwidth. If an external machine needs to submit, use an SSH tunnel rather
than exposing 8080:

```bash
ssh -L 18080:127.0.0.1:8080 user@server
```
