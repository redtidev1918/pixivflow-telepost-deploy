# Changelog

## [1.1.0] - 2026-08-29

- 将原有单一代理仓库重构并重命名为 PixivFlow + TelePost 跨网络部署套件。
- 新增 TelePost 2.9 + PixivFlow 2.7 联合低内存镜像，支持 amd64/arm64。
- 同一 Compose 支持无公网 Polling、公网 Caddy Webhook 和可选 Mihomo 代理。
- 新增 PixivFlow 原子热更新与 TelePost 多 Bot 频道/审核策略远程更新脚本。
- 新增配置、Compose、脚本和联合镜像的 CI 校验与 tag 发布工作流。
