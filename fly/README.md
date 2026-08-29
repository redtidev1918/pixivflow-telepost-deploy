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

PixivFlow 配置原子热加载，不重启。TelePost 频道/审核策略通过 staged secrets 一次
部署，会重启 Machine，但不会重建/删除持久卷。
