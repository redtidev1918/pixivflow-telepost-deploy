# PixivFlow + TelePost Deploy

[![Validate](https://github.com/redtidev1918/pixivflow-telepost-deploy/actions/workflows/validate.yml/badge.svg)](https://github.com/redtidev1918/pixivflow-telepost-deploy/actions/workflows/validate.yml)
[![Release](https://github.com/redtidev1918/pixivflow-telepost-deploy/actions/workflows/release.yml/badge.svg)](https://github.com/redtidev1918/pixivflow-telepost-deploy/actions/workflows/release.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

一个面向实际运行的 Pixiv 自动投稿部署套件：PixivFlow 负责按主题/榜单抓取作品，
TelePost 负责投稿审核与频道发布。同一份配置可用于海外 VPS、国内服务器、无公网
NAT 主机、Mac/Linux 本机和 Fly.io。默认（Compose）以两个独立容器运行：TelePost
多 Bot supervisor 与 PixivFlow 调度器各自拉取 ghcr 镜像、经 HTTP 通信，适合
512 MiB 小机器，不启动 WebUI；Fly 合一台可选走组合镜像（combined）。

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
- **远程热更新**：PixivFlow 配置原子热重载；TelePost 可由 OWNER 使用 `/botconfig`
  持久化策略并只重载当前 Bot，批量策略仍可通过脚本短重启应用。
- **不静默、不重复**：最终无候选会进审核群；PixivFlow 持久 outbox
  防止短暂故障漏通知，TelePost SQLite 幂等记录防止重启后重复通知。

## 许可证

[MIT](LICENSE)

本项目与 Pixiv、Telegram、Fly.io 无隶属或官方合作关系。部署者应只处理有权下载、保存和
发布的内容，并自行遵守平台条款、版权要求与所在地法律。项目不会替部署者决定频道内容
政策，也不提供规避平台限制或监管的保证。

## 网络模式

| 机器条件 | 启动方式 | TelePost 模式 |
|---|---|---|
| 无公网，Telegram/Pixiv 可直连 | `docker compose up -d` | AUTO 自动选择 Polling |
| 有域名且 80/443 可入站 | `docker compose --profile webhook up -d` | AUTO 选择 Webhook |
| 国内网络，需要代理 | `docker compose --profile proxy up -d` | Polling + Mihomo |
| Fly.io | `deploy`（推荐，见下）或 `fly deploy -c fly/deploy.fly-multi-bot.toml` | Webhook |
| Linux VPS（systemd，免 Docker） | `deploy --platform systemd` | Polling（源码直跑） |

Polling 与 Webhook 都提供相同的 `http://127.0.0.1:8080/api/botN/v1/*`，因此
PixivFlow 的投递配置无需随网络模式改变。Webhook 注册失败时 AUTO 会回退 Polling。

## 一键部署工具（deploy）

**Go 编译的单二进制**，Windows / macOS / Linux 直接运行，零运行时依赖
（无需 Python / sh / venv / pip），也不需要 clone 本仓库。

### 傻瓜式一键部署（全新机器）

只装 **Docker** + 一个二进制，三条命令即可跑起来：

```bash
deploy init mybot        # 1) 就地生成全新部署目录（内嵌 compose/.env/示例配置模板，向导式填 Bot 信息）
cd mybot
deploy doctor && deploy deploy   # 2) 自检 → 3) 一键部署（docker compose pull/up + 健康检查）
```

`init` 默认生成 Polling 模式的 `.env` 与双 Bot 示例配置，向导会继续询问部署
场景：**Webhook**（有域名，自动填 `WEBHOOK_*` 并提示 `--profile webhook`）、
**国内+Mihomo 代理**（填代理/订阅并提示 `--profile proxy`）或 **Fly.io**
（生成 `telesubmit.fly.toml` 并提示 secrets 与 `--platform fly` 部署）；
直接回车则保持 Polling。非交互（管道/CI）运行时全部静默、只生成占位配置。

没有 Docker 的 Linux VPS 用 systemd 后端（免 Docker、同机组合跑 TelePost +
PixivFlow，见下文 systemd 说明）；完整场景对照见 [docs/SCENARIOS.md](docs/SCENARIOS.md)。

### 获取

方式一：从 [Releases](https://github.com/redtidev1918/pixivflow-telepost-deploy/releases)
下载对应平台的 `deploy-<os>-<arch>`（linux/darwin/windows × amd64/arm64），
解压后改名 `deploy`，Linux/macOS 记得 `chmod +x`。

方式二：源码编译（本机有 Go 1.22+）：

```bash
go build -o deploy .
```

### 用法

二进制可在**任意目录**运行：当前目录不是仓库时，会沿目录树向上并回退到
可执行文件所在目录自动定位仓库配置（`telesubmit.fly.toml` / `docker-compose.yml`）。

```bash
./deploy init <dir>             # 全新部署：生成部署目录并引导填写 Bot 信息
./deploy doctor                 # 环境自检（依赖/配置/登录/网络）
./deploy tp latest              # 升级 TelePost 到最新并部署（也可指定如 2.10.33）
./deploy pf 2.10.27             # 升级 PixivFlow 到指定版本并部署
./deploy status                 # 状态 / 健康
./deploy logs 200               # 最近 200 行日志
./deploy version                # 显示工具与当前配置版本
```

平台自动检测（默认 `--platform auto`）：存在 `telesubmit.fly.toml` 且 flyctl 已登录 →
Fly.io；否则有 `docker-compose.yml` → Docker Compose；再否则 Linux 上有 systemctl →
systemd。也可 `--platform fly|compose|systemd` 显式指定。

- **Fly**：首次使用把模板复制为仓库根目录的 `telesubmit.fly.toml` 并按需修改
  （`cp fly/deploy.fly-multi-bot.toml ./telesubmit.fly.toml`）；之后改它的
  `[build.args]` 镜像版本 → `fly deploy --remote-only`，等健康检查通过后回报。
  默认常驻（always-on）。
- **Compose**：compose 后端拆成 `telepost` 与 `pixivflow` 两个独立 service，
  各自拉取 ghcr 镜像（`.env` 的 `TELEPOST_IMAGE` / `PIXIVFLOW_IMAGE`），共享
  `./data` 卷、经 HTTP 通信（投递基址 `TELEPOST_API_BASE_URL`，默认
  `http://telepost:8080`）。升级用 `./deploy tp <版本>` / `./deploy pf <版本>`
  （或直接改 `.env` 后 `docker compose up -d`）。
- **systemd**（Linux 裸机，免 Docker）：`deploy --platform systemd` 自动
  clone TelePost → 建 venv + `pip install` → 安装 Node + `npm i -g pixivflow`
  （组合单机省钱形态）→ 引导填写 `BOT1_TOKEN`/`BOT1_CHANNEL_ID` 及是否启用
  PixivFlow（写入 `/opt/telepost/.env`）→ 写 `/etc/systemd/system/telepost.service`
  → `systemctl enable --now telepost`。TelePost 的 supervisor 同机托管 bot 与
  PixivFlow 两个进程（复刻 Fly 上的省钱组合）。升级 `tp latest`（git pull + pip +
  restart）、`pf latest`（npm 重装 + restart）。
- 常用选项：`--dry-run`（只预览、不改配置）、`--verbose`（回显命令完整输出）、
  `--retries N`（部署失败重试）、`--no-color`。
- 每次运行写完整日志到 `/tmp/deploy-logs/`（Windows 在 `%TEMP%`），失败时终端会提示日志路径。

先自检再部署：

```bash
./deploy doctor
./deploy deploy          # 或 ./deploy tp latest
```

## 快速开始

需要 Docker 24+、Compose v2。`bootstrap.sh`/`validate.sh` 还需要 bash 与
python3（只用于本地生成与校验，运行时镜像内自带）。

Linux/macOS（含 Git-Bash 的 Windows）一键初始化：

```bash
git clone https://github.com/redtidev1918/pixivflow-telepost-deploy
cd pixivflow-telepost-deploy
./scripts/bootstrap.sh
```

Windows 用户可手动完成同样的事：复制 `.env.example` 为 `.env`、把
`pixivflow/config/fly-two-bots.example.json` 复制为 `data/pixivflow/config.json`。

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

预构建镜像从 GHCR 拉取（公开）：`TELEPOST_IMAGE`（TelePost）与
`PIXIVFLOW_IMAGE`（PixivFlow 精简调度镜像）由各自仓库发版构建，本仓库无需
本地构建镜像（`--profile webhook/proxy` 的 Caddy/Mihomo 除外）。国内构建机
可在 `.env` 设置 `BUILD_HTTP_PROXY` / `BUILD_HTTPS_PROXY`。
生产环境建议把 `.env` 的 `TELEPOST_IMAGE` 与 `PIXIVFLOW_IMAGE` 固定到明确
Release 标签；`latest` 适合首次体验，但会在重新拉取时升级。升级前先阅读
CHANGELOG 并备份持久卷。

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
  （JSON 模板换行写作 `\n`，不要写成会显示为字面量的 `\\n`）
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
`/health` 的 `storage.review_queue` 会返回各 Bot 的 pending/failed/expired/deleted 数量和最老
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
小说加 `languageFilter: "chinese" + languageCandidateLimit: 20 + strictLanguageFilter: true`。若昨天没有中文候选，可设置 `noMatchPolicy: { "lookbackDays": 3, "notify": true }`：最多逐日回看 3 天，仍为空时通知对应审核群，不会静默改投日文小说。
该通知与媒体投递共用 PixivFlow outbox 指数退避，TelePost 再以 SQLite
幂等键跨重启去重；所以网络闪断时不会静默丢失，恢复后也不会刷屏。
会按热度串行回填，直到找到 1 部可确认的中文小说。

## 远程变更

PixivFlow 会监听配置文件；有效的新 JSON 通过完整校验后原子替换调度表，无需重启：

```bash
# 本机部署
./scripts/update_pixivflow_config.sh ./my-config.json

# 从 Mac 更新远端 VPS
./scripts/push_pixivflow_config.sh user@server /opt/pixivflow-telepost ./my-config.json
```

TelePost OWNER 可直接在 Telegram 使用 `/botconfig` 修改当前 Bot 的频道、审核群、
API/聊天审核与频道署名策略；存在 pending 投稿时会拒绝切换频道或审核群。应用后只
重载当前 Bot，另一个 Bot、PixivFlow、数据库、缓存和 outbox 不受影响。

需要从 Mac 批量更新多个 Bot 时，仍可使用非敏感策略文件：

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

## 内存档位建议

Compose 解耦后 telepost 与 pixivflow 是**两个独立容器**，各自的
`mem_limit` 默认按整机 512 MiB 预算分配：**telepost 320m + pixivflow 192m**
（`.env` 的 `TELEPOST_MEMORY_LIMIT` / `PIXIVFLOW_MEMORY_LIMIT` 可调）。

| 档位 | 组合 | 做法 |
|---|---|---|
| **256 MiB** | 单 Bot、不跑 PixivFlow | 只启 telepost：`docker compose up -d telepost`，并设 `TELEPOST_MEMORY_LIMIT=256m` |
| **512 MiB**（默认） | 双 Bot + PixivFlow 组合 | 默认分配即可：telepost 320m + pixivflow 192m |
| **≥1 GiB** | 上述 + 更宽裕/WebUI | 调大 `TELEPOST_MEMORY_LIMIT=512m`、`PIXIVFLOW_MEMORY_LIMIT=384m`；WebUI 见下一节 |

512 档约束（`docs/PERFORMANCE.md`）：

- 最多两个 Bot，关闭搜索与 WebUI（`SEARCH_ENABLED=false`、`simple` 分词器）。
- `download.concurrency=1`；多个计划同一 Cron 时会排队串行执行，带宽较紧张时可再错开
  15–20 分钟降低连续峰值。
- 需要复用下载内容时用 `storageMode=cache` + `delivery.deleteAfterDelivery=false`，同时
  设置 `cacheRetentionDays=7` 与 `cacheMaxSizeMB=384`；outbox 独立保留，不参与缓存清理。
- 保留 Compose 的日志轮转、96 MiB Node heap（`NODE_OPTIONS`）与小 SQLite cache。
- 通过 `/health` 观察 `process_rss`、磁盘、cache 和 delivery outbox 指标。

完整说明见 [性能与容量](docs/PERFORMANCE.md)。

## 可选：PixivFlow WebUI 管理面板（需要 ≥1 GiB）

默认 512 MiB 档不带 WebUI（见上表：≥1 GiB 时先把 `TELEPOST_MEMORY_LIMIT` /
`PIXIVFLOW_MEMORY_LIMIT` 调大）。WebUI 在 PixivFlow 中是可选组件。需要管理面板时，
用一个能访问 kit `./data` 的 PixivFlow webui 后端，前端两种方式**二选一**（都
与 kit 的 telepost/pixivflow 容器共享 `./data`，同一 config → 同一个 SQLite 与
下载目录；kit 镜像零改动）：

### 方式 A：官方合体容器（一个容器 = API + 前端）

```bash
# 1) 准备一份含前端的 PixivFlow 镜像（官方源码仓库自带 webui-frontend 构建）
git clone https://github.com/redtidev1918/PixivFlow /tmp/PixivFlow
cd /tmp/PixivFlow && docker build -t pixivflow:webui .

# 2) 与 kit 共卷启动（把下面的 /path/to/kit 换成部署目录）
docker run -d --name pixivflow-webui --restart unless-stopped \
  -p 127.0.0.1:3000:3000 \
  -e PIXIV_DOWNLOADER_CONFIG=/app/data/pixivflow/config.json \
  -e PORT=3000 -e HOST=0.0.0.0 \
  -e STATIC_PATH=/app/webui-frontend/dist \
  -e WEBUI_USERNAME=${WEBUI_USERNAME:-} \
  -e WEBUI_PASSWORD=${WEBUI_PASSWORD:-} \
  -v /path/to/kit/data:/app/data \
  pixivflow:webui node dist/webui/index.js
```

访问 `http://127.0.0.1:3000`。

### 方式 B：独立前端容器（推荐：前端镜像已发布，前后端分开升级）

后端容器只跑 PixivFlow webui API（不设 `STATIC_PATH`；官方合体镜像同样适用）：

```bash
docker run -d --name pixivflow-webui-api --restart unless-stopped \
  -p 127.0.0.1:3000:3000 \
  -e PIXIV_DOWNLOADER_CONFIG=/app/data/pixivflow/config.json \
  -e PORT=3000 -e HOST=0.0.0.0 \
  -e WEBUI_USERNAME=${WEBUI_USERNAME:-} \
  -e WEBUI_PASSWORD=${WEBUI_PASSWORD:-} \
  -v /path/to/kit/data:/app/data \
  pixivflow:webui node dist/webui/index.js
```

前端容器直接用已发布的
[`pixivflow-webui`](https://github.com/redtidev1918/pixivflow-webui) 镜像
（nginx 托管 + `/api`、`/socket.io` 反代；ghcr.io/redtidev1918/pixivflow-webui，
amd64 + arm64）：

```bash
docker run -d --name pixivflow-webui-front --restart unless-stopped \
  --add-host host.docker.internal:host-gateway \
  -p 127.0.0.1:3001:80 \
  -e UPSTREAM_API=http://host.docker.internal:3000 \
  ghcr.io/redtidev1918/pixivflow-webui:latest
```

访问 `http://127.0.0.1:3001`。跨机部署时把 `UPSTREAM_API` 指向后端实际地址；
后端 Basic Auth 的 `Authorization` 会经反代原样透传。也可 clone
pixivflow-webui 后 `cp .env.example .env && docker compose up -d`（详见其 README）。

公网暴露前务必同时设置 `WEBUI_USERNAME` 与 `WEBUI_PASSWORD`（两者都非空才启用
Basic Auth）。

要点与限制：

- **内存**：webui 是又一个 Node 进程（约 150–300 MiB），只适合 ≥1 GiB 整机；
  512 MiB 档不要开。可给容器加 `--memory 512m` 兜底。
- **并发**：webui 与 pixivflow scheduler 共用同一个 SQLite / 下载目录（官方即按
  共享卷设计）；日常查看、改计划没问题，但不要在 webui 里与 scheduler 同时触发
  大规模下载/维护，避免 SQLite 锁竞争。
- **版本对齐**：webui 后端镜像的 PixivFlow 版本不要低于 kit 内嵌的版本（当前
  2.10.27），以免旧版本读不懂新 config 字段；config 用 `PIXIV_DOWNLOADER_CONFIG`
  显式指向 kit 那份即可（相对路径会以该 config 为基准解析，各进程一致）。
- **前端升级**：方式 B 的前端独立成镜像，换 tag 重启即可，无需重新构建后端。

## 目录

```text
deploy.go / go.mod                一键部署工具（Go 单二进制，v3.x）
docker-compose.yml                Compose：telepost + pixivflow 两服务 + 可选 Caddy/Mihomo
docker/combined.Dockerfile        Fly 合一台的 co-locate 层（TelePost + PixivFlow 单容器）
data/                             数据库、下载缓存、outbox、实际配置（不入库）
pixivflow/config/*.example.json   多计划安全模板
config/telepost-policy.example.json 非敏感频道/审核策略模板
scripts/                          初始化、校验、本机/SSH 原子更新
docs/                             架构、场景、性能、Webhook/代理等说明（auto-stop 省钱见 AUTOSTOP.md）
fly/                              Fly.io 512 MiB 配置与更新脚本
proxy/                            可选 Mihomo 镜像
.github/workflows/deploy-release.yml 打 deploy-v* 标签时产出各平台二进制并附到 Release
```

各平台 `deploy` 二进制见 [Releases](https://github.com/redtidev1918/pixivflow-telepost-deploy/releases)。

## 安全边界

- `.env`、`data/`、`proxy-data/` 和上传临时文件均被忽略。
- Bot Token、Pixiv Refresh Token、投稿 Token、代理订阅 URL 只能放 `.env` 或平台
  Secret，不得放 JSON 模板、Git 历史或聊天截图。
- 根 API 默认只绑定 `127.0.0.1`；Webhook 通过 Caddy 反代。
- 修改频道前先处理旧审核群中的 pending 投稿，并确认 Bot 已是新频道管理员。

公开仓库会在 CI 中检查常见 Token 格式与不应跟踪的运行时路径，Docker 构建上下文也通过
`.dockerignore` 排除本地 Secret 和数据。但自动检查不能替代 Token 轮换：一旦凭据曾进入
Issue、日志、截图或 Git 历史，应立即吊销。

## 参与项目

- 架构与组件边界：[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- 加第 N 个频道（多 bot）：[docs/MULTI-BOT.md](docs/MULTI-BOT.md)
- Fly 自动休眠省钱：见上文 Fly 段引用的 [docs/AUTOSTOP.md](docs/AUTOSTOP.md)
- 贡献代码：[CONTRIBUTING.md](CONTRIBUTING.md)
- 使用与排障：[SUPPORT.md](SUPPORT.md)
- 私下报告漏洞：[SECURITY.md](SECURITY.md)
- 社区行为准则：[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)

上游项目：[PixivFlow](https://github.com/redtidev1918/PixivFlow) ·
[TelePost](https://github.com/redtidev1918/TelePost)
