# Changelog

## [1.3.2] - 2026-08-29

- 联合镜像内置 PixivFlow 升级到 **2.10.2**：Topic 排名改为纯热度（metadata 只做门槛）；autocomplete 独立召回低置信 Tag；better-sqlite3 升 v12（修复 Node 22/24 退出崩溃）。
- `PIXIVFLOW_VERSION` 统一升至 2.10.2。

## [1.3.1] - 2026-08-29

- 联合镜像内置 PixivFlow 升级到 **2.10.1**：修复相对 `databasePath` 且进程工作目录与数据卷不一致时（容器 CLI）`topic-cache/` 可能写到非数据卷目录的问题；现在 Topic 缓存始终落在 SQLite 同级目录（持久卷 `/app/data/pixivflow/topic-cache/`）。
- `PIXIVFLOW_VERSION` 统一升至 2.10.1。

## [1.3.0] - 2026-08-29

- 联合镜像内置 PixivFlow 升级到 **2.10.0**：新增语义主题下载 `mode: "topic"`（只给一个 Topic，自动推导相关 Tag、按天采集、本地热度 Top N；零 AI、低内存，插画/小说 Tag 空间独立并缓存到数据卷 `topic-cache/`，容器重建不丢）。
- `PIXIVFLOW_VERSION` 统一升至 2.10.0（Fly build arg、Compose build arg、Dockerfile 默认值、`.env.example` 同步）；TelePost 镜像仍为 2.9.0。
- Topic 缓存放数据卷，升级/重建容器后自动复用，刷新失败自动降级到旧缓存或仅用种子词，不中断调度。

## [1.2.0] - 2026-08-29

- 联合镜像内置 PixivFlow 升级到 **2.9.0**（新增 `tags discover/apply` 相关 Tag 发现与人工确认热更新工作流；配置热重载链路不变）。
- `PIXIVFLOW_VERSION` 统一升至 2.9.0（Fly build arg、Compose build arg、Dockerfile 默认值、`.env.example` 同步）。
- 文档中 PixivFlow 版本说明由 2.7 更新为 2.9。

## [1.1.0] - 2026-08-29

- 将原有单一代理仓库重构并重命名为 PixivFlow + TelePost 跨网络部署套件。
- 新增 TelePost 2.9 + PixivFlow 2.7 联合低内存镜像，支持 amd64/arm64。
- 同一 Compose 支持无公网 Polling、公网 Caddy Webhook 和可选 Mihomo 代理。
- 新增 PixivFlow 原子热更新与 TelePost 多 Bot 频道/审核策略远程更新脚本。
- 新增配置、Compose、脚本和联合镜像的 CI 校验与 tag 发布工作流。
