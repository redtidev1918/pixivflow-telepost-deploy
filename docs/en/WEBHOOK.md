# Webhook: public HTTPS deployment

**Language / 语言:** [中文](/WEBHOOK.md) · English

Requires the domain to resolve to the server and 80/443 to be open for inbound traffic. Set the
domain and HTTPS root address in `.env`:

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

Caddy issues and renews certificates automatically and reverse-proxies to `stack:8080`.
Multi-bot TelePost uses separate paths such as `/webhook/bot1` and `/webhook/bot2`.
`RUN_MODE=AUTO` falls back to Polling when webhook registration fails; the submission API
address does not change.

Security advice: keep `BIND_ADDRESS=127.0.0.1` and never expose 8080 separately; open only
Caddy's 80/443. If you already run Nginx, Traefik or a Cloudflare Tunnel, do not start the
`webhook` profile — just point your existing reverse proxy at `127.0.0.1:8080`.
