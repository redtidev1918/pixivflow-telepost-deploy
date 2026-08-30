# Changelog

## [Unreleased]

## [1.6.1] - 2026-08-30

- PixivFlow 升级到 **2.10.7**：新增 `excludeAI`，在 Topic 热度排名前排除
  Pixiv 明确标记的 AI 插画；中文小说按热度串行检测并回填，`strictLanguageFilter`
  可拒绝正文过短等无法确认语言的候选。
- Fly/Compose 双 Bot 示例改为北京时间每天 10:00：ボテ腹→bot1、丸呑み→bot2；
  每路各投稿昨日最热非 AI 插画 1 部和严格中文小说 1 部，继续包含 R-18/R-18G，
  API 投稿仍进入 TelePost 审核队列。
- `PIXIVFLOW_VERSION` 在 Dockerfile、Compose、Fly 与环境模板中统一固定为 2.10.7；
  TelePost 保持 2.10.7。

## [1.6.0] - 2026-08-30

- TelePost 升级到 **2.10.7**：审核群多页图片按每批最多 10 张组成相册，后续相册、小说
  文档与审核按钮回复上一批；GIF 保持单发。上传限流重试会重新打开本地文件，异常返回会
  回滚整单；Pixiv 标签按 Unicode 规则清洗，`R-18/R-18G` 稳定显示为可点击标签。
- PixivFlow 升级到 **2.10.6**：正确解包小说正文，不再把 API 响应对象写成
  `[object Object]`；空正文不会写库、落盘或进入审核群。
- Compose/Fly 模板与 `.env.example` 新增 `REVIEW_PREVIEW_THREAD` 及既有
  `REVIEW_PREVIEW_INTERVAL_SECONDS` / `REVIEW_PREVIEW_TIMEOUT_SECONDS` 的显式默认值。
- 自动投稿简介模板优化为 `Pixiv 每日热榜自动投稿 / 主题：{{topicTag}} · 作品ID：{{pixivId}}
  / 来源：Pixiv 昨日榜 · 经 TelePost 审核发布`（与链接字段不重复），示例配置与线上配置同步。
- 示例配置改为「昨日最热门 + 主题相关 tag + 含 R-18」的 topic 模板（ボテ腹→bot1、
  丸呑み→bot2，每天 20:00 各 1 插画 + 1 小说），完整投稿模板：
  标题 `{{title}}`、标签 `Pixiv + {{topicTag}} + {{workTags}}`、链接 `{{link}}`、
  剧透 `{{spoiler}}`（R-18 自动遮罩）、`idempotency_key` 按 bot/类型/作品ID 去重。
- 文档补充自动投稿标题/简介/标签/链接/剧透设计、审核群相册回复链（`REVIEW_PREVIEW_THREAD`），
  以及 PixivFlow「multipart 表单 HTTP 投稿」链路与第三方复用通用性说明。

## [1.4.0] - 2026-08-30

- 联合镜像内置 PixivFlow 升级到 **2.10.5**：新增投稿模板变量 `{{link}}`（Pixiv 永久链接）、`{{topicTag}}`（topic 标签兜底）、`{{spoiler}}`（R-18 自动开剧透），投稿标题/简介/标签/链接/剧透可全模板化。
- `PIXIVFLOW_VERSION` 统一升至 2.10.5；`TELEPOST_IMAGE` 保持 2.10.5。

## [1.3.9] - 2026-08-30

- TelePost 升级到 **2.10.5**，大型多页作品进入审核群时使用可配置的 120 秒单页上传超时，避免 24 页投稿在默认短超时下返回 502。
- PixivFlow 保持 **2.10.4**；继续复用审核阶段生成的 Telegram `file_id`，批准多图作品时不重复上传媒体。

## [1.3.8] - 2026-08-30

- PixivFlow 升级到 **2.10.4**：Topic 计划会把主题写入 `{{tag}}`，并新增 `{{topic}}`、`{{workTags}}`；双 Bot 模板默认投稿来源、计划主题与作品自身标签。
- TelePost 升级到 **2.10.4**：修复 `RetryAfter` 重试协程复用，多页预览稳定节流，标签有序去重，累计上传限制为 500MB。
- `TELEPOST_IMAGE` 与 `PIXIVFLOW_VERSION` 统一升至 2.10.4；实际 Fly 配置不再落后于通用模板。

## [1.3.7] - 2026-08-29

- 联合镜像 TelePost 升级到 **2.10.3**（审核队列预览发送增加节流与 `RetryAfter` 退避，多页图集入审核队列不再触发 Telegram flood 502）。
- `TELEPOST_IMAGE` 统一升至 2.10.3；`PIXIVFLOW_VERSION` 保持 2.10.3。

## [1.3.6] - 2026-08-29

- 联合镜像 TelePost 升级到 **2.10.2**（投稿入站文件数上限 10→50：多页插画/图集整本可投，发布侧自动按每组 ≤10 拆成多个 Telegram media group）。
- `TELEPOST_IMAGE` 统一升至 2.10.2；`PIXIVFLOW_VERSION` 保持 2.10.3。

## [1.3.5] - 2026-08-29

- 联合镜像 TelePost 升级到 **2.10.1**（修复 2.10.0 引入的父路由崩溃：`web.AppKey` 在守护线程上下文抛 `UnboundLocalError` 导致 8080 路由不可用；改用字符串 key 后 `/health` 与投稿 API 恢复）。
- `TELEPOST_IMAGE` 统一升至 2.10.1；`PIXIVFLOW_VERSION` 保持 2.10.3。

## [1.3.4] - 2026-08-29

- 联合镜像 TelePost 升级到 **2.10.0**（修复投稿路由 1 MiB body 限制：aiohttp `client_max_size` 默认 1 MiB 导致 >1 MiB 的插画投稿 413；新版路由与子 API 均支持 10 × 50 MiB 并流式转发，插画/视频等大文件可正常投稿）。
- `TELEPOST_IMAGE` 统一升至 2.10.0；`PIXIVFLOW_VERSION` 保持 2.10.3。

## [1.3.3] - 2026-08-29

- 联合镜像内置 PixivFlow 升级到 **2.10.3**：`topicDiscovery.includeR18` 支持 NSFW 主题（R-18 作品纳入采样与采集；插画搜索默认被 Pixiv `filter=for_ios` 过滤，开启后移除）。
- `PIXIVFLOW_VERSION` 统一升至 2.10.3。

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
