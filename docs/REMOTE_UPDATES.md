# 从 Mac 远程更新策略

## PixivFlow 源码热修复

配置热重载不需要重建镜像。只有修改 PixivFlow 程序代码时，才从干净且已提交的
源码工作区执行：

```bash
./deploy --platform fly --config fly/pixivflow-split.toml source ../PixivFlow
```

不要用 `docker/combined.Dockerfile` 部署未发布代码；它明确只安装固定的 npm Release。
`source` 会剥离 Fly 配置的构建段，传入当前 Git SHA，并在部署后校验镜像与运行进程，
因此旧 npm 包或 `[build].image` 都不能伪装成成功的源码部署。

## PixivFlow：真正热重载

先保存一份不含真实密钥的策略 JSON。真实 Pixiv 与投稿 Token 通过远端 `.env`
注入，JSON 中只保留 `${TELEPOST_BOTN_SUBMIT_TOKEN}` 占位符。

```bash
python3 -m json.tool ./my-config.json >/dev/null
./scripts/push_pixivflow_config.sh \
  user@server /opt/pixivflow-telepost ./my-config.json
```

脚本上传为 `config.json.upload`，远端再次校验后用 `mv` 原子替换。PixivFlow 文件
监听器会校验整份配置，再一次替换 Cron、targets 和 delivery；无效配置保留旧快照。
修改 `pixiv`、`network` 或 `storage` 时应手工重启容器。

## TelePost：策略更新后短重启

OWNER 可在 Telegram 发送 `/botconfig` 打开当前 Bot 的运行配置面板，修改频道、审核群、
API/聊天审核和频道署名策略。策略原子保存在 `data/botN/runtime-policy.json`，应用后只
重载当前 Bot；另一个 Bot 和 PixivFlow 不受影响。切频道或审核群前必须先处理 pending，
面板也会强制检查。

需要从 Mac 一次更新多个 Bot 时，策略 JSON 不包含 Bot Token，可以安全地单独传输：

```bash
cp config/telepost-policy.example.json ./telepost-policy.json
./scripts/push_telepost_policy.sh \
  user@server /opt/pixivflow-telepost ./telepost-policy.json
```

远端脚本原子更新 `.env`，只重建 `stack` 容器；持久卷 `./data` 不会删除。切频道前：

1. 处理旧审核群的 pending 投稿。
2. 把 Bot 加到新频道并授予发帖权限。
3. 运行策略更新脚本。
4. 检查 `/health` 和新频道测试投稿。

若想把多个策略变更集中到一次重启，可在服务器运行
`apply_telepost_policy.sh policy.json --no-restart`，完成后再执行
`docker compose up -d --no-deps --force-recreate stack`。
