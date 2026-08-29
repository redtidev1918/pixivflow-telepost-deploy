# 部署场景速查

| 场景 | `.env` 关键项 | 命令 |
|---|---|---|
| 家庭/NAT/无公网 | `RUN_MODE=AUTO`, `WEBHOOK_URL=` | `docker compose up -d` |
| 海外 VPS + 域名 | 设置 `WEBHOOK_DOMAIN`、`WEBHOOK_URL` | `docker compose --profile webhook up -d` |
| 国内服务器 + 外部代理 | 设置 `HTTP_PROXY_URL`、`EGRESS_ALL_PROXY` | `docker compose up -d` |
| 国内服务器 + 内置 Mihomo | 再设置 `SUB_URL` | `docker compose --profile proxy up -d` |
| Fly.io | 平台 Secrets + Fly 配置 | `fly deploy -c fly/deploy.fly-multi-bot.toml` |

无论选择哪一行，先运行 `./scripts/bootstrap.sh`、编辑配置，再运行
`./scripts/validate.sh`。有公网不代表必须用 Webhook；无法稳定提供 HTTPS 入站时，
Polling 更简单可靠。
