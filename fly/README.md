# Fly.io 联合部署（低成本托管档）

在 512 MiB Fly Machine 上运行一套 PixivFlow 调度器和两个 TelePost Bot。
无需自有服务器，适合不想维护 VPS 的场景。

- 来源仓库：`redtidev1918/TelePost`
- 来源提交：`f22bd15e7885b86c2a659e9653ea630a0da78eb0`
- 来源版本：`v2.8.0`
- 快照日期：`2026-08-29`

本目录保存 512 MiB Fly Machine 上运行一套 PixivFlow 调度器和两个 TelePost Bot
的部署配置。所有实际凭据仍应放在 Fly Secrets；不要向本仓库提交 `.env`、真实
`telepost-policy.json`、线上 `pixivflow.json` 或 `/app/data` 的任何内容。

## 文件

- `Dockerfile`：Python wheels 与 PixivFlow 分阶段构建；联合运行档选择
  `runtime-pixivflow`，生产层不含编译器、npm 和测试依赖。
- `requirements.txt` / `requirements-dev.txt`：生产和测试依赖拆分。
- `deploy.fly-multi-bot.toml`：Fly 双 Bot + PixivFlow 512 MiB 配置。
- `config/fly-telepost-policy.example.json`：无真实聊天 ID 的策略模板。
- `scripts/update_pixivflow_config.sh`：原子上传并热加载 PixivFlow 任务。
- `scripts/update_telepost_policy.sh`：校验并一次部署多 Bot 频道/审核策略。

## 构建和部署

Dockerfile 必须放在完整 TelePost 源码上下文中使用：

```bash
git clone https://github.com/redtidev1918/TelePost.git
cd TelePost
git checkout v2.8.0

# 快照目录设为本仓库中的 fly 目录
cp ../pixivflow-telepost-deploy/fly/Dockerfile ./Dockerfile
cp ../pixivflow-telepost-deploy/fly/requirements.txt ./requirements.txt
cp ../pixivflow-telepost-deploy/fly/requirements-dev.txt ./requirements-dev.txt
cp ../pixivflow-telepost-deploy/fly/deploy.fly-multi-bot.toml ./deploy.fly-multi-bot.toml

fly config validate -c deploy.fly-multi-bot.toml
fly deploy -a your-app-name -c deploy.fly-multi-bot.toml --now
```

部署前应先确认目标 Machine/volume，并创建持久卷快照；部署后检查根健康端点、
两个 `/api/botN/v1/health` 端点以及两个 SQLite 数据库的 `PRAGMA quick_check`。

## 从 Mac 更新策略

PixivFlow 的 tag、Cron、target 和投递 Bot 可以零重启热加载：

```bash
fly ssh sftp get -a your-app-name \
  -c deploy.fly-multi-bot.toml \
  /app/data/pixivflow/config.json ./pixivflow.json

python3 -m json.tool ./pixivflow.json >/dev/null
./scripts/update_pixivflow_config.sh your-app-name ./pixivflow.json
```

TelePost 的频道、审核群与审核来源策略通过 Fly Secrets 一次部署，会重启 Machine
一次但不会重建镜像或清除持久卷：

```bash
cp config/fly-telepost-policy.example.json ./telepost-policy.json
./scripts/update_telepost_policy.sh your-app-name ./telepost-policy.json --dry-run
./scripts/update_telepost_policy.sh your-app-name ./telepost-policy.json
```

频道切换前先处理完旧审核群的 pending 投稿。Bot token、投稿 token 和 Pixiv token
不得写进策略 JSON。