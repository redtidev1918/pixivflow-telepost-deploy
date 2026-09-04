# Fly.io 512 MiB 部署

本配置复用仓库根目录的联合 Dockerfile，运行 TelePost 2.10、PixivFlow 2.10 和最多
两个 Bot，不启动 WebUI。真实凭据全部放 Fly Secrets。

```bash
# 在仓库根目录执行；先修改 toml 中 app、WEBHOOK_URL 与 volume source
fly config validate -c fly/deploy.fly-multi-bot.toml
fly secrets set -a your-app-name \
  BOT1_TOKEN=... BOT1_CHANNEL_ID=... BOT1_OWNER_ID=... \
  BOT2_TOKEN=... BOT2_CHANNEL_ID=... BOT2_OWNER_ID=... \
  PIXIV_REFRESH_TOKEN=... \
  TELEPOST_BOT1_SUBMIT_TOKEN=... TELEPOST_BOT2_SUBMIT_TOKEN=...
fly deploy -c fly/deploy.fly-multi-bot.toml --now
```

首次部署前创建持久卷；更新已有应用前先创建 volume snapshot。部署后检查：

```bash
curl https://your-app.fly.dev/health
curl -H "Authorization: Bearer $TELEPOST_BOT1_SUBMIT_TOKEN" \
  https://your-app.fly.dev/api/bot1/v1/health
```

更新任务：

```bash
./fly/scripts/update_pixivflow_config.sh your-app-name ./pixivflow.json
./fly/scripts/update_telepost_policy.sh your-app-name ./telepost-policy.json --dry-run
./fly/scripts/update_telepost_policy.sh your-app-name ./telepost-policy.json
```

PixivFlow 配置原子热加载，不重启。日常修改单个 TelePost Bot 可由 OWNER 在 Telegram
使用 `/botconfig`，只重载对应 Bot；上面的批量策略脚本通过 staged secrets 一次部署，
会重启 Machine，但不会重建/删除持久卷。

## 自动休眠（auto-stop）省账单

流量是「大部分时间没人 + 每天几个间断高峰」时，可开 `auto_stop_machines=true` 让
机器无流量停机、释放 RAM 停止计费，来流量由 proxy 自动唤醒（首条消息付 5–15s 冷启动）。
前提是 Webhook 模式（webhook 是唤醒信号）。完整机制、睡眠比例→账单换算、以及
「双 Bot 拆一台 256 + PixivFlow 拆自己机器」的拓扑与改动面，见
[docs/AUTOSTOP.md](../docs/AUTOSTOP.md)。
