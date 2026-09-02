# Changelog

## [Unreleased]

## [1.8.19] - 2026-09-02

- TelePost 升级到 **2.10.25**：API 的 `title`/`note` 在 multipart 与 JSON 共用入口
  统一解析字面量换行，并清理零调用代码与多余的 `configparser` 依赖。
- 修复双 Bot 投稿简介模板中一处双重转义的 `\\n`，后续投稿会按真实换行显示；
  PixivFlow 保持 **2.10.24**。

## [1.8.18] - 2026-09-01

- TelePost 升级到 **2.10.24**：新增**仅 OWNER 可用的 Telegram 运行时面板**
  （`/botconfig` 面板 + 运行时策略），可修改当前 Bot 的投稿频道、审核群、API/聊天
  审核与频道署名策略；应用后只重载该 Bot，无需 SSH 进容器。PixivFlow 保持 2.10.24。

## [1.8.17] - 2026-09-01

- TelePost 升级到 **2.10.23**：`/health` 通过 cmdline 识别 Node.js 24，
  不再因进程名显示为 `MainThread` 而漏报 PixivFlow RSS；512 MiB 内存余量可完整观测。
- 保持 PixivFlow **2.10.24** 的超长小说文件名修复与下载硬失败审核群通知；
  Compose、Fly、环境模板和实际 Fly 配置同步到同一版本组合。

## [1.8.16] - 2026-09-01

- PixivFlow 升级到 **2.10.24**：下载**硬失败**现在也会通过交付目标
  `notificationUrl` 给审核群发"❌ 下载失败"通知（含目标与错误摘要，outbox
  幂等重试），不再只有"候选耗尽"才通知。TelePost 保持 2.10.22。

## [1.8.15] - 2026-09-01

- PixivFlow 升级到 **2.10.23**：修复超长中文小说标题导致缓存写入
  `ENAMETOOLONG`、整条目标硬失败且不触发"无匹配"通知的问题；对文件名按
  UTF-8 字节数截断（保留扩展名与 pixiv id 前缀）。TelePost 保持 2.10.22。

## [1.8.14] - 2026-09-01

- TelePost 升级到 **2.10.22**：修复 `/search`、`/hot` 多页结果翻页按钮
  （⬅️/➡️）点击不刷新内容的问题；同时做零行为变化的死代码清理。
- PixivFlow 升级到 **2.10.22**：删除未使用导入；投递模板文档补全
  `{{bookmarkCount}}`/`{{viewCount}}` 等变量。
- Compose、Fly、环境模板版本固定同步到 2.10.22；运行数据卷与热更新配置不变。

## [1.8.13] - 2026-09-01

- PixivFlow 与 TelePost 统一升级到 **2.10.21**；联合镜像改用 Node.js 24 LTS，
  停止继承已结束安全维护的 Node.js 20。
- PixivFlow 生产依赖审计由 7 项降为 0，并补齐 Node.js 22 默认 npm 的锁文件兼容；
  TelePost 联合构建默认值不再回退到 PixivFlow 2.8.0。
- Compose、Fly、环境模板和本机实际 Fly 构建参数同步固定到同一组版本；
  运行数据卷、热更新配置与现有低内存参数均不迁移、不重置。

## [1.8.12] - 2026-09-01

- PixivFlow 升级到 **2.10.19**：无候选通知纳入可跨重启恢复的
  delivery outbox，并升级当前 Node LTS 范围内可兼容的安全依赖。
- TelePost 升级到 **2.10.20**：审核群状态通知改用 SQLite 幂等键，
  Bot 重启后仍可去重；失败占位可释放重试，历史记录按保留期清理。
- 公开部署文档统一说明“PixivFlow 防漏 + TelePost 防重”的故障语义，
  Compose、Fly 和联合 Dockerfile 默认版本全部对齐。

## [1.8.11] - 2026-08-31

- TelePost 升级到 **2.10.19**：
  - 审核键盘新增 **🔇 遮罩开/关** 按钮，审核员可在发布前决定频道遮罩，
    初始值沿用投稿者设置；
  - Pixiv 自动投稿新增 **🔄 重抓/换一张** 按钮，后台触发一次
    `pixivflow scheduler run`，已下载作品自动跳过并选取下一张，新稿作为
    新审核记录进群（仅管理员，PixivFlow 未启用时不显示）。
- PixivFlow 升级到 **2.10.18**：投递模板新增 `{{bookmarkCount}}`（收藏）、
  `{{viewCount}}`（浏览）变量，大数字紧凑渲染（`1.2k`/`34.6w`），无数据时为空；
  示例简介加入 `⭐ 收藏 · 👁 浏览` 行作为热门依据。

## [1.8.10] - 2026-08-31

- PixivFlow 升级到 **2.10.17**：中文小说目标可通过
  `noMatchPolicy.lookbackDays` 有界逐日回退，命中后停止；主题和语言要求不被静默
  放宽，空结果 execution log 不再重复。
- TelePost 升级到 **2.10.18**：新增鉴权、幂等的审核群状态通知端点
  `/api/v1/notifications`。示例为两路小说任务启用最多回看 3 天并在最终无候选时
  通知各自审核群。

## [1.8.9] - 2026-08-31

- PixivFlow 升级到 **2.10.16**：`mode: "topic"` 插画先保留有界热度递补池，
  再批量剔除下载历史；同一发布日期第二次执行时，若 Top-1 已在早先计划投稿，
  会自动选择下一部未下载作品，不再空跑。
- 继续包含 TelePost **2.10.17** 的恒定时间 Webhook Secret 校验，以及
  **2.10.16** 的异步、时区感知维护任务修复。

## [1.8.8] - 2026-08-31

- TelePost 升级到 **2.10.17**（安全补丁）：Webhook Secret Token 校验改用恒定时间
  比较 `hmac.compare_digest`，消除可逐字节推断 token 的时序侧信道；错误/缺失/
  前缀相似的 token 仍一律 401。行为对外不变，仅强化 `/webhook/botN` 回调鉴权。

## [1.8.7] - 2026-08-31

- TelePost 升级到 **2.10.16**：修正 JobQueue 维护回调被错误 `await` 导致的
  `NoneType` 异常，并把日志清理和 PixivFlow 子进程等待移至工作线程，避免阻塞
  Telegram 更新处理。
- 03:00 日志清理与 04:00 PixivFlow 维护显式使用部署 `TZ`；双 Bot 模式仍只由
  主 Bot 注册全局维护任务，避免重复清理同一目录。

- 补齐公开仓库协作入口：贡献指南、安全政策、支持说明、行为准则、架构文档、结构化
  Issue 表单、PR 模板与 Dependabot 配置。
- 新增 `.dockerignore` 与公开仓库卫生检查，阻止 `.env`、运行时数据、真实 Fly 配置和
  常见 Token 格式进入 Git 跟踪或 Docker 构建上下文；示例校验不再临时创建 `.env`。
- CI 使用最小权限、并发去重、ShellCheck 和固定 commit 的第三方 Actions；Release 镜像
  生成 SBOM 与 provenance，GitHub Release 直接采用对应 CHANGELOG 章节。

## [1.8.6] - 2026-08-31

- TelePost 升级到 **2.10.15**：频道消息被删除时，关联审核记录状态同步为
  `deleted`（触发器 + 初始化回填），`published` 现在只表示"已批准且当前在线"；
  `/health` 的审核队列统计新增 `deleted` 终态计数，运维口径不再把已删稿
  误判为在线发布。

## [1.8.5] - 2026-08-31

- PixivFlow 升级到 **2.10.15**，投递保留原始 `x_restrict`，并暴露
  `{{xRestrict}}`、`{{xRestrictLabel}}`、`{{xRestrictTag}}` 三个模板变量。
- TelePost 投稿标签增加 `AllAges` / `R18` / `R18G` 精确分级，简介同时
  保留原始数值；`spoiler=false` 继续作为独立频道策略，不会因 NSFW
  等级自动加遮罩。

## [1.8.4] - 2026-08-31

- TelePost 升级到 **2.10.14**：待审核稿支持自动过期，过期时删除审核群媒体、文档与
  控制消息，并保留轻量 `expired` 审计记录供 30 天终态清理。
- 512 MiB 双 Bot 默认 `PENDING_REVIEW_RETENTION_DAYS=1`、每轮最多处理 20 条；选择
  1 天是为了落在 Telegram Bot API 的 48 小时消息删除窗口内。
- `/health` 新增 `storage.review_queue`，只暴露每个 Bot 的状态计数与最老 pending 年龄，
  不读取或返回投稿内容。

## [1.8.3] - 2026-08-30

- Fly 双 Bot 示例的投稿 `spoiler` 默认改为 `false`：收录 R-18/R-18G 不再等于必须
  使用 Telegram 遮罩，避免把所有 NSFW 一刀切隐藏。
- 文档明确每个 delivery target 的三种显式策略：`false`（默认不遮罩）、
  `"{{spoiler}}"`（兼容旧版，所有 Pixiv 受限作品自动遮罩）、`true`（全部遮罩）。

## [1.8.2] - 2026-08-30

- TelePost 升级到 **2.10.13**：多 Bot 模式下只由主 Bot 注册全局
  PixivFlow 日常维护，避免两个进程同时清理缓存、执行 SQLite VACUUM，降低磁盘争用与锁冲突。

## [1.8.1] - 2026-08-30

- PixivFlow 升级到 **2.10.13**：`maintain` 新增 `storage.cacheMaxSizeMB` 容量硬上限，
  按完整作品淘汰最旧缓存，避免多页插画被拆散清理。
- Fly 双 Bot 模板采用缓存保留 7 天 + 384 MiB 上限；1 GiB 卷为 SQLite、审核记录与
  delivery outbox 留出充足空间。文档同步为 96 MiB V8 堆与串行多计划模型。

## [1.8.0] - 2026-08-30

- **存储治理**（TelePost 2.10.12 + PixivFlow 2.10.12）：
  - 修复 `api_uploads` 会话目录泄漏：后台清扫器每小时删除超龄孤儿目录
    （`UPLOAD_SESSION_MAX_AGE_SECONDS`，默认 1h）；
  - 已决审核记录超期自动清理（`REVIEW_RETENTION_DAYS`，默认 30 天）；
  - 每天 04:00 自动执行 `pixivflow maintain`：缓存保留清理
    （`storage.cacheRetentionDays` 默认 14 天）+ 日志/备份清理 + SQLite VACUUM；
  - 示例与线上配置的插画 target 增加 `maxPageCount: 30` 页数上限，跳过超大作品。
- `TELEPOST_IMAGE` 升至 2.10.12，`PIXIVFLOW_VERSION` 升至 2.10.12。

## [1.7.3] - 2026-08-30

- `deleteAfterDelivery` 改为 **false**（示例与线上）：投递后保留缓存文件，
  同一天再次选中同一作品时直接复用缓存投递，不再重复下载——512 MiB 机器上
  首次下载 20+ 页大作品的内存峰值只出现一次，之后每日任务走缓存、零风险。
- 线上验证：投稿简介已显示 `📅 热门日期：{{rankingDate}}` 与
  `🕒 作品发布于：{{publishedDate}}`（PixivFlow 2.10.11）。

## [1.7.2] - 2026-08-30

- PixivFlow 升级到 **2.10.11**：投稿模板新增 `{{rankingDate}}`（JST 榜单日，自动解析
  TODAY/YESTERDAY）、`{{publishedDate}}`（作品 Pixiv 发布日期）与 `{{language}}`
  （小说检测语言）变量。
- 自动投稿简介模板加入榜单日期与发布日期：渠道观众可看到「这是哪一天的热门作品、
  什么时候发布的」。示例配置与线上配置同步更新。

## [1.7.1] - 2026-08-30

- PixivFlow 升级到 **2.10.10**：AI 判定增强——
  - `excludeAI: true` 现在同时按官方 `illust_ai_type === 2` 与作品 AI 标签
    （生成AI/AI生成/Generative AI/AI-generated，含翻译名）过滤，官方字段缺失的作品也能拦住；
  - 新增可选 `aiMetadataCheck: true`（插画 target）：下载后扫描首页文件头部 2 MiB，
    命中 AI 生成工具元数据（SD `parameters=` / NovelAI EXIF）则跳过投递，仍记为已下载。
- 示例配置与线上配置的插画 target 均开启 `aiMetadataCheck: true`；README 补充 AI 判定说明。

## [1.7.0] - 2026-08-30

- **开源发布**：仓库公开为通用部署套件（MIT 许可证）。
- 示例配置通用化：`fly-two-bots.example.json` / `standalone.example.json` 的主题
  替换为中性占位（ミク / アークナイツ），默认 `includeR18=false`（注释说明按需开启），
  移除个人化代理与测试残留；README 增加特性总览与许可证章节。

## [1.6.6] - 2026-08-30

- PixivFlow 升级到 **2.10.9**：多页作品逐页下载后强制 `global.gc()` 回收
  ArrayBuffer 外部内存（配合 `NODE_OPTIONS=--expose-gc`），下载进程 RSS 不再
  随页数累积，512 MiB 机器下载 20+ 页作品时不再打满内存导致健康检查失败。
- `NODE_OPTIONS` 统一为 `--max-old-space-size=96 --expose-gc`（Compose/Fly/env）。

## [1.6.5] - 2026-08-30

- TelePost 升级到 **2.10.11**（累计 2.10.10/2.10.11）：
  - 相册上传修复：本地文件 `InputFile` 启用 `attach` 模式，`attach://` 引用保留，
    审核群 5 张一组的小相册与组间回复链真正生效（此前每次静默降级逐张发送）；
  - 超大图片（>9.5 MiB）自动按文档发送，规避 Telegram 10 MiB 图片上限，
    大尺寸原图不再导致投稿进不了审核群；
  - 幂等键只对 pending/failed 生效，已拒绝/发布的记录不再阻断同 key 新投稿。
- `TELEPOST_IMAGE` 统一升至 2.10.11。

## [1.6.4] - 2026-08-30

- TelePost 升级到 **2.10.9**：幂等键语义修正——`idempotency_key` 只在审核处于
  `pending`/`failed` 时去重；已被拒绝/发布的旧记录不再阻断同一 key 的新投稿，
  定时任务次日再次选中同一作品时会创建全新审核记录（此前会静默复用旧结果，
  导致作品不进审核群）。`TELEPOST_IMAGE` 统一升至 2.10.9。

## [1.6.3] - 2026-08-30

- TelePost 升级到 **2.10.8**：审核群预览改为「小相册 + 自动降级」防 OOM——
  新增 `REVIEW_ALBUM_SIZE`（默认 5，合法 1–10）控制每条 media group 的媒体数；
  相册上传失败（超时/断连/限流）自动降级逐张发送，整份投稿不再失败，
  512 MiB 机型上传阶段 RSS 峰值被压在单张量级。`TELEPOST_IMAGE` 统一升至 2.10.8。
- Compose/Fly/`.env.example` 均新增 `REVIEW_ALBUM_SIZE=5` 默认值（无需手动配置）。

## [1.6.2] - 2026-08-30

- PixivFlow 升级到 **2.10.8**：小说正文优先使用 gallery-dl 验证过的
  `/webview/v2/novel` 数据，旧 App API 与 Web AJAX 作为回退；任何来源只有在正文
  非空时才视为成功，杜绝只有标题/元数据头的 `.txt` 进入审核群。
- `PIXIVFLOW_VERSION` 在 Dockerfile、Compose、Fly 与环境模板中统一固定为 2.10.8；
  TelePost 保持 2.10.7，其合法 hashtag、多图相册与审核回复链修复继续生效。

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
