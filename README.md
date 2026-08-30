# PixivFlow + TelePost Deploy

一个面向实际运行的 Pixiv 自动投稿部署套件：PixivFlow 负责按主题/榜单抓取作品，
TelePost 负责投稿审核与频道发布。同一份配置可用于海外 VPS、国内服务器、无公网
NAT 主机、Mac/Linux 本机和 Fly.io。默认镜像把 PixivFlow 调度器与 TelePost 多 Bot
supervisor 放在同一容器，适合 512 MiB 小机器，不启动 WebUI。

## 特性

- **主题自动投稿**：按 Pixiv 主题（tag 空间推导）或日榜抓取「昨日最热门」作品，
  插画/小说各取 Top N，自动排除 AI 生成作品（读 Pixiv 官方 `illust_ai_type` 标记）。
- **中文小说筛选**：`franc-min` 语言检测 + `strictLanguageFilter`，只投中文小说。
- **审核群 + 回复链**：API 投稿先进审核群，多页图集按 ≤10 张一组打包成 Telegram
  相册、相册间自动回复成链；审核通过后复用 `file_id` 发布到频道，不重复上传。
- **完整 caption 模板**：标题/简介/标签/原链接/剧透策略全部可模板化；NSFW 收录与
  Telegram 遮罩相互独立，默认不因 R-18 标签自动遮罩。标签会净化成可点击的 hashtag
  （`r-18 → #r18`）。
- **多网络模式**：Polling / Webhook / 可选 Mihomo 代理，同一套 `api/botN/v1/*` 接口。
- **低内存友好**：512 MiB 即可运行——小相册 + 失败自动降级逐张、逐页强制 GC、
  可调健康检查参数。
- **远程热更新**：PixivFlow 配置原子热重载；TelePost 策略短重启生效，数据保留。

## 许可证

[MIT](LICENSE)

## 网络模式

| 机器条件 | 启动方式 | TelePost 模式 |
|---|---|---|
| 无公网，Telegram/Pixiv 可直连 | `docker compose up -d` | AUTO 自动选择 Polling |
| 有域名且 80/443 可入站 | `docker compose --profile webhook up -d` | AUTO 选择 Webhook |
| 国内网络，需要代理 | `docker compose --profile proxy up -d` | Polling + Mihomo |
| Fly.io | `fly deploy -c fly/deploy.fly-multi-bot.toml` | Webhook |

Polling 与 Webhook 都提供相同的 `http://127.0.0.1:8080/api/botN/v1/*`，因此
PixivFlow 的投递配置无需随网络模式改变。Webhook 注册失败时 AUTO 会回退 Polling。

## 快速开始

需要 Docker 24+、Compose v2、Python 3（只用于本地校验）。

```bash
git clone https://github.com/redtidev1918/pixivflow-telepost-deploy
cd pixivflow-telepost-deploy
./scripts/bootstrap.sh
```

编辑 `.env`，至少填写 `BOT1_TOKEN`、`BOT1_CHANNEL_ID`、`BOT1_OWNER_ID`。启用
PixivFlow 时再填写 `PIXIV_REFRESH_TOKEN` 和 Bot 内 `/gen_token` 生成的
`TELEPOST_BOT1_SUBMIT_TOKEN`。编辑 `data/pixivflow/config.json`（参考
`pixivflow/config/fly-two-bots.example.json`），把示例主题 `ミク`/`アークナイツ`
替换成你需要的 tag、调整 Cron，并把要执行的计划改成 `"enabled": true`。

```bash
./scripts/validate.sh
docker compose up -d
docker compose ps
curl http://127.0.0.1:8080/health
```

预构建镜像从 GHCR 拉取（公开）；拉取不可用时可以在仓库内构建：
`docker compose build stack`。国内构建机可在 `.env` 设置
`BUILD_HTTP_PROXY` / `BUILD_HTTPS_PROXY`。

## 两个 Bot 与审核策略

每个 Bot 使用自己的 Token、频道、审核群和 API 投稿 Token。默认示例是“仅 API
投稿进审核群，普通聊天投稿不审核”：

```dotenv
BOT1_API_REVIEW_REQUIRED=true
BOT1_CHAT_REVIEW_REQUIRED=false
BOT1_REVIEW_CHAT_ID=-100xxxxxxxxxx
```

Bot 2 使用对应的 `BOT2_*`。PixivFlow 模板中的两个 delivery target 固定投递到
`/api/bot1/v1/submissions` 与 `/api/bot2/v1/submissions`。

## 自动投稿的标题/简介/标签/链接/剧透

PixivFlow 的 delivery 模板把投稿转成 TelePost 的 caption 字段，模板变量有
`{{title}}`、`{{pixivId}}`、`{{type}}`、`{{tag}}`、`{{topic}}`、
`{{workTags}}`、`{{link}}`（自动生成 Pixiv 作品/小说永久链接）、`{{topicTag}}`、
`{{xRestrict}}`、`{{xRestrictLabel}}`、`{{xRestrictTag}}` 与
`{{spoiler}}`（Pixiv `x_restrict > 0` 时为 `true`）。建议设计（已在示例配置中）：

- `title` → `{{title}}`，频道内渲染为「🔖 标题」
- `note` → 自动投稿来源、主题与作品 ID
  （`Pixiv 每日热榜自动投稿 / 主题：{{topicTag}} · 作品ID：{{pixivId}} / 来源…`），
  渲染为「📝 简介」；链接由 `link` 字段单独渲染，不重复占用简介
- `tags` → `["Pixiv", "{{topicTag}}", "{{xRestrictTag}}", "{{workTags}}"]`，
  来源主题 + `AllAges/R18/R18G` 精确分级 + 作品自身标签；
  数组字段默认按逗号拼接成 multipart 重复表单项，TelePost 按逗号/空格拆分为 `#标签`
  （去重、保序、小写化、去 `#` 后统一加 `#`，上限 30 个）
- `link` → `{{link}}`，渲染为「🔗 链接」；插画/小说永久链接由 PixivFlow 自动生成
- `note` 额外显示 `{{xRestrictLabel}}（x_restrict={{xRestrict}}）`，明确区分
  全年龄、R-18 和 R-18G
- `spoiler` → `false`：默认不自动加 Telegram 剧透遮罩。`includeR18: true` 只决定是否
  收录 NSFW，不再隐式决定展示方式
- `anonymous` → `true`，频道内不显示投稿人
- `idempotency_key` → `pixiv:botN:{{type}}:{{pixivId}}`：同一作品重复投递直接幂等返回，
  不会在审核群产生重复稿件

`spoiler` 是每个 delivery target 的显式策略，可按频道分别选择：

| 配置值 | 行为 |
|---|---|
| `false` | 默认；任何作品都不自动遮罩 |
| `"{{spoiler}}"` | 兼容旧行为；Pixiv `x_restrict > 0` 的作品自动遮罩 |
| `true` | 该 target 的所有媒体都遮罩 |

例如 Bot 1 可以保持 `false`，Bot 2 使用 `"{{spoiler}}"`。这里不会根据标题、tag
或成人分级作未经部署者确认的进一步推断；需要更细规则时应拆成不同 delivery target，
或由上游投稿时显式传入 `spoiler=true`。

### 投稿链路与通用性

PixivFlow 不依赖 TelePost 私有协议：它把作品文件与模板字段渲染成一次标准的
`multipart/form-data` HTTP 请求（`files` 文件字段 + `title/tags/note/link/spoiler/
anonymous/idempotency_key` 表单字段），`Authorization: Bearer <submit-token>` 鉴权。
TelePost 接收后写入审核队列并把媒体暂存到审核群、只保存 Telegram `file_id`。
因此：

- 任何能发 multipart HTTP 的程序/cron/CI 都能复用同一 API 投稿（TelePost 仓库自带
  API 说明与 token 由 Bot 内 `/gen_token` 签发）；PixivFlow 只是其中一个上游。
- 反过来 PixivFlow 的 `httpMultipart` delivery 也可指向任意兼容该表单约定的接收端，
  模板变量（`{{title}}/{{link}}/{{workTags}}/{{spoiler}}` 等）与接收方解耦。
- 小说投稿为 `.txt` 文档（document），插画为图片；审核群与频道都按媒体类型发送，
  发布到频道时自动按每组 ≤10 拆成多个 Telegram media group。

### 审核群相册与回复链

多页图集进入审核群时，TelePost 会按每批最多 10 张组成 Telegram 相册；下一相册、小说
`.txt` 文档和审核按钮回复上一批，在群内形成一份完整投稿。需要取消回复关系时设
`REVIEW_PREVIEW_THREAD=0`。上传保留限速与 `RetryAfter` 退避，批准后继续复用 Telegram
`file_id`，不会从 Fly 再次上传媒体。

待审核稿进入群后，原始上传文件会立即从运行机器删除；SQLite 只保存 Telegram
`file_id`、caption 和状态，因此积压基本不占内存，也不会把原图堆在 Fly 持久卷。默认
`PENDING_REVIEW_RETENTION_DAYS=1`：超过一天仍未审核的稿件会标记为 `expired`，并删除
对应的审核群相册、文档和按钮消息；每轮最多处理 20 条。轻量审计记录再按
`REVIEW_RETENTION_DAYS=30` 清理。

Telegram Bot API 只保证删除发送后 48 小时内的消息，因此需要自动清群时不要把待审核
保留期设为 2 天或更长。设 `0` 可永久保留 pending；此时需自行管理审核群历史消息。
`/health` 的 `storage.review_queue` 会返回各 Bot 的 pending/failed/expired 数量和最老
pending 年龄，不包含标题、标签或投稿人等内容。

### 单次手动测试（不等待 Cron）

```bash
# 在运行机器上执行一次，立即验证「昨日最热门 + 主题相关 tag + 含 R-18」链路：
pixivflow download --config /app/data/pixivflow/config.json
```

新增/修改 target 并保存后，PixivFlow 会热重载；配合
`mode: "topic" + topic + date: "YESTERDAY" + topicDiscovery.includeR18: true + limit: 1`
即得到「昨天最热门的主题相关 tag 1 部插画/小说（含 R-18）」并投递到对应 Bot 的审核群。
插画加 `excludeAI: true` 会排除 AI 作品，判定有两层：Pixiv 官方 `illust_ai_type === 2`
标记，以及作品标签中的 AI 标记（`生成AI` / `AI生成` / `Generative AI` / `AI-generated`
等，含翻译名——官方字段缺失或尚未标注的作品也能拦住，零成本）。可选再加
`aiMetadataCheck: true`：下载完成后扫描首页文件头部元数据（Stable Diffusion 的
`parameters=` PNG tEXt、NovelAI EXIF 等），命中则跳过投递（仍记为已下载，不重复拉取）。
小说加 `languageFilter: "chinese" + languageCandidateLimit: 20 + strictLanguageFilter: true`
会按热度串行回填，直到找到 1 部可确认的中文小说。

## 远程变更

PixivFlow 会监听配置文件；有效的新 JSON 通过完整校验后原子替换调度表，无需重启：

```bash
# 本机部署
./scripts/update_pixivflow_config.sh ./my-config.json

# 从 Mac 更新远端 VPS
./scripts/push_pixivflow_config.sh user@server /opt/pixivflow-telepost ./my-config.json
```

TelePost 的频道/审核策略由启动环境读取，改变后必须短暂重启 Bot 进程，但数据库、
缓存和 outbox 都保留：

```bash
cp config/telepost-policy.example.json ./telepost-policy.json
./scripts/apply_telepost_policy.sh ./telepost-policy.json
./scripts/push_telepost_policy.sh user@server /opt/pixivflow-telepost ./telepost-policy.json
```

详见 [远程更新](docs/REMOTE_UPDATES.md)。

## 公网 Webhook

域名 A/AAAA 记录指向服务器，放通 TCP 80/443 与 UDP 443，然后设置：

```dotenv
RUN_MODE=AUTO
WEBHOOK_DOMAIN=bot.example.com
WEBHOOK_URL=https://bot.example.com
```

执行 `docker compose --profile webhook up -d`。Caddy 自动申请证书；TelePost 为
每个 Bot 注册独立的 `/webhook/botN` 路径。不要把 8080 直接暴露到公网。

## 国内网络

如已有稳定外部代理，直接设置 `HTTP_PROXY_URL` 与 `EGRESS_ALL_PROXY`。使用仓库内
Mihomo 时设置 `SUB_URL`，并将两项代理地址设为 `http://proxy:7890`，再执行：

```bash
docker compose --profile proxy up -d
```

Mihomo 通常还会占用 50–100 MiB。整机只有 512 MiB 时优先使用外部代理，或升级到
1 GiB；不要靠删除失败缓存/outbox 换取表面上的低占用。详见
[国内网络](docs/MIHOMO.md)。

## 512 MiB 建议

- 最多两个 Bot，关闭搜索与 WebUI。
- `download.concurrency=1`，两个计划至少错开 15–20 分钟。
- 需要复用下载内容时用 `storageMode=cache` + `delivery.deleteAfterDelivery=false`，同时
  设置 `cacheRetentionDays=7` 与 `cacheMaxSizeMB=384`；outbox 独立保留，不参与缓存清理。
- 保留 Compose 的日志轮转、128 MiB Node heap 与小 SQLite cache。
- 通过 `/health` 观察 `process_rss`、磁盘、cache 和 delivery outbox 指标。

完整说明见 [性能与容量](docs/PERFORMANCE.md)。

## 目录

```text
docker-compose.yml                 主编排：联合容器 + 可选 Caddy/Mihomo
docker/combined.Dockerfile         TelePost 2.10 + PixivFlow 2.10 轻量运行时
data/                              数据库、下载缓存、outbox、实际配置（不入库）
pixivflow/config/*.example.json    多计划安全模板
config/telepost-policy.example.json 非敏感频道/审核策略模板
scripts/                           初始化、校验、本机/SSH 原子更新
fly/                               Fly.io 512 MiB 配置与更新脚本
proxy/                             可选 Mihomo 镜像
```

## 安全边界

- `.env`、`data/`、`proxy-data/` 和上传临时文件均被忽略。
- Bot Token、Pixiv Refresh Token、投稿 Token、代理订阅 URL 只能放 `.env` 或平台
  Secret，不得放 JSON 模板、Git 历史或聊天截图。
- 根 API 默认只绑定 `127.0.0.1`；Webhook 通过 Caddy 反代。
- 修改频道前先处理旧审核群中的 pending 投稿，并确认 Bot 已是新频道管理员。

上游项目：[PixivFlow](https://github.com/redtidev1918/PixivFlow) ·
[TelePost](https://github.com/redtidev1918/TelePost)
