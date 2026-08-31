# 获取帮助

先运行 `./scripts/validate.sh --examples`，并查看：

- [部署场景](docs/SCENARIOS.md)
- [Polling](docs/POLLING.md) / [Webhook](docs/WEBHOOK.md)
- [远程更新](docs/REMOTE_UPDATES.md)
- [性能与容量](docs/PERFORMANCE.md)
- [国内网络与 Mihomo](docs/MIHOMO.md)

仍无法解决时创建 Issue，并提供部署方式、仓库版本、相关命令、精简配置和错误日志。
请先删除 Bot/Pixiv/投稿 Token、Webhook Secret、代理订阅、真实频道/群 ID、域名、IP 与用户名。
不要上传整个 `.env`、数据库或持久卷。

PixivFlow 下载/排序问题和 TelePost Bot 行为问题可能会被转到对应上游仓库；这有助于让修复
进入真正负责该行为的项目，而不是在部署层做不可维护的补丁。
