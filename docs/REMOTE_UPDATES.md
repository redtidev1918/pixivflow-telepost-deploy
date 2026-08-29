# 从 Mac 远程更新策略

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

频道与审核群是在 Bot 子进程启动时读取的，不能无重启热改。策略 JSON 不包含 Bot
Token，可以安全地单独传输：

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
