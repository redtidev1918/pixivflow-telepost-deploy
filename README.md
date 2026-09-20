# PixivFlow + TelePost Deploy

**语言 / Language:** 中文 · [English](README.en.md)

[![Validate](https://github.com/redtidev1918/pixivflow-telepost-deploy/actions/workflows/validate.yml/badge.svg)](https://github.com/redtidev1918/pixivflow-telepost-deploy/actions/workflows/validate.yml)
[![Release](https://github.com/redtidev1918/pixivflow-telepost-deploy/actions/workflows/release.yml/badge.svg)](https://github.com/redtidev1918/pixivflow-telepost-deploy/actions/workflows/release.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Docs](https://img.shields.io/badge/Docs-文档站点-6366f1?style=flat-square)](https://redtidev1918.github.io/pixivflow-telepost-deploy/)

📖 完整文档：<https://redtidev1918.github.io/pixivflow-telepost-deploy/>

**PixivFlow + TelePost 的部署与运维套件。** 它把两个上游项目组合成一套可部署、可运维的系统：

| 组件 | 负责什么 | 不负责什么 |
| --- | --- | --- |
| [PixivFlow](https://github.com/redtidev1918/PixivFlow) | 按主题/榜单抓取作品、选品、下载、可靠投递 | 不碰 Telegram 频道 |
| [TelePost](https://github.com/redtidev1918/TelePost) | 接收投稿、人工审核、发布到频道 | 不做 Pixiv 登录与调度 |

**PixivFlow 和 TelePost 都可以独立使用**，各自都有自己的文档、安装方式与部署方式。
本仓库只在你希望把两者组合成一条完整工作流时才需要——它不重新实现任何一边的业务逻辑，
只负责部署、组合与长期运维。

## 这个仓库适合谁

- **适合**：想把「Pixiv 自动收集」与「Telegram 频道的人工审核 / 发布」串成一条长期运行的
  工作流，并且需要可复现的部署（Docker / VPS / Fly.io）、版本 pin、运维脚本与架构契约。
- **不需要**：只想下载和筛选 Pixiv 内容 —— 用
  [PixivFlow](https://github.com/redtidev1918/PixivFlow) 自己的安装与 Docker 文档即可；
  只想做一个 Telegram 投稿 / 审核机器人 —— 下一个
  [TelePost](https://github.com/redtidev1918/TelePost) Release 二进制即可；
  或者只是分别试用其中一个项目。

**业务模型只有一套，部署拓扑可以选择。** 同一份业务语义可以跑在一台 VPS 上、一台
512 MiB 机器上，或者拆成两台机器；变化的是角色跑在哪里、谁能休眠、谁唤醒谁、谁持有凭据，
不是审核流程或调度语义。

---

## 我该选哪种部署方式？

| 你的情况 | 推荐 |
| --- | --- |
| 我只有一台 VPS / NAS / 家用机 | `single-host` |
| 我只有一个 512 MiB 的 Fly Machine | `single-machine-worker-sleep`（**当前不可部署**：进程编排已实现，缺镜像与平台配置） |
| 我希望最省 Fly 费用 | `split-worker` |
| 我最在意可靠性 | `split-worker` |
| 我有 VPS + 家用服务器 | `remote-worker` |
| 我最在意 Pixiv 出口质量 | `remote-worker` |
| 我只想最快跑起来 | `single-host` |

```text
只有一台机器？
├─ 是
│  ├─ 内存 ≥ 1 GiB ─────────────────► single-host
│  ├─ 内存 = 512 MiB
│  │  ├─ 想省内存、能接受机器常驻计费 ─► single-machine-worker-sleep
│  │  └─ 想省账单 ─────────────────► split-worker
│  └─ 内存 = 256 MiB ──────────────► single-host，只跑业务端
└─ 否
   ├─ 用 Fly.io ────────────────────► split-worker
   └─ 已有多节点 ───────────────────► remote-worker
```

完整对照表、常见误配组合、以及「进程休眠 ≠ 机器休眠」这个最常见的混淆，
见[**我该选哪种部署方式？**](docs/getting-started/choose-architecture.md)。

---

## 快速开始（默认 `single-host`）

需要 Docker 24+ 与 Compose v2。

```bash
git clone https://github.com/redtidev1918/pixivflow-telepost-deploy
cd pixivflow-telepost-deploy
./scripts/bootstrap.sh                 # 生成 .env 与 data/pixivflow/config.json
# 编辑 .env：至少填 BOT1_TOKEN、BOT1_CHANNEL_ID、BOT1_OWNER_ID
# 编辑 data/pixivflow/config.json：换成你的 tag、调整 Cron、把要跑的计划改成 "enabled": true
./scripts/validate.sh
docker compose up -d
curl http://127.0.0.1:8080/health
```

不想 clone 仓库？`deploy` 是 Go 编译的单二进制（Windows / macOS / Linux，零运行时依赖），
三条命令部署到一台全新机器：

```bash
deploy init mybot                        # 向导式生成部署目录
cd mybot
deploy doctor && deploy deploy           # 自检 → 一键部署
```

二进制从 [Releases](https://github.com/redtidev1918/pixivflow-telepost-deploy/releases)
下载 `deploy-<os>-<arch>`。

**完整步骤、验证清单与其它 preset 的入口**：[快速开始](docs/getting-started/quickstart.md)。

---

## 组合起来能做什么

下面描述的是「两个上游项目组合部署之后」的完整能力。每一项的实现都在上游仓库里：
内容发现、选品、下载与投递属于
[PixivFlow](https://github.com/redtidev1918/PixivFlow)，投稿接收、人工审核与发布属于
[TelePost](https://github.com/redtidev1918/TelePost)；本仓库负责把它们部署起来并长期运维。

- **主题自动投稿**：按 Pixiv 主题（tag 空间推导）或日榜抓取「昨日最热门」，插画/小说各取
  Top N，按 Pixiv 官方 `illust_ai_type` 标记排除 AI 作品。
- **中文小说筛选**：`franc-min` 语言检测 + `strictLanguageFilter`，只投中文小说。
- **审核群 + 回复链**：多页图集按 ≤10 张打包成相册、相册间自动回复成链；审核通过后复用
  `file_id` 发布，不重复上传。**人工批准前任何作品都不会进频道。**
- **完整 caption 模板**：标题 / 简介 / 标签 / 原链接 / 剧透策略全部可模板化，
  标签净化成可点击的 hashtag。
- **多种网络模式**：Polling / Webhook / 可选代理，同一套 `api/botN/v1/*` 接口。
- **低内存友好**：512 MiB 可运行；小相册 + 失败自动降级逐张、逐页强制 GC。
- **不静默、不重复**：最终无候选也会通知审核群；持久 outbox 防漏投递，
  SQLite 幂等键防重启后重复。

---

## 支持哪些部署架构

| Preset | 支持等级 | 实现状态 | 一句话 |
| --- | --- | --- | --- |
| [`single-host`](docs/architectures/single-host.md) | Stable | 已实现，CI 覆盖 | 一台机器跑全部角色 |
| [`single-machine-worker-sleep`](docs/architectures/single-machine-worker-sleep.md) | Experimental | **进程编排已实现（`supervisor/`），preset 仍不可部署** | 一台机器，执行进程按需拉起、空闲即退出 |
| [`split-worker`](docs/architectures/split-worker.md) | Stable | 已实现、已测试、**当前生产** | 执行端与业务端各一台机器、各一个卷 |
| [`remote-worker`](docs/architectures/remote-worker.md) | Beta | 已实现，未经端到端测试 | 两个角色跨机器跨网络 |

每个 preset 的拓扑、资源要求、生命周期、状态位置、网络、优缺点、故障模型、成本模型、
部署步骤与迁移路径都写在它自己的页面里，章节顺序固定。

机器可读的权威定义（角色、preset、支持等级、功能开关、合法/非法组合、资源档位、安全不变量）：
[`docs/reference/architecture-matrix.json`](docs/reference/architecture-matrix.json)，
由 `architecture_docs_test.go` 在 CI 中强制与文档一致。

### 生产调度

```text
cron-job.org ─┐
              ├─► PixivFlow 触发端点 ─► 槽位账本（唯一的执行权威）
Cloudflare  ──┘
```

简单部署**用一个时钟就够了**。生产 `split-worker` 部署**建议用两个互相独立的外部时钟**：
PRIMARY（cron-job.org）在预定时刻触发，SECONDARY（Cloudflare Cron）在 2 分钟后再触发一次。
两者 POST 的是同一个带令牌的幂等触发，谁后到都在同一个槽位上收敛——**重复触发永远不会跑两次**。

好处都是运维上的：**不需要维护一台专用调度 VM**，**不依赖一台会到期、需要人工续费的机器**
（VPS / systemd timer 只用于开发、人工排障与紧急触发），两个 **low-maintenance**、
**provider-independent** 的时钟让「某一个 provider 静默失火」不等于「这次定时投稿消失」。
时钟只持有触发令牌，所以泄漏时只需要轮换它。

这是**生产 `split-worker` 的建议**，不是单机部署的要求：`single-host` 与本地/个人部署用一个时钟
即可，不需要为它申请两个 SaaS 账号。运维细节见
[调度运维手册](docs/operations/scheduling.md)。

---

## 三个概念，不要混淆

```text
逻辑架构（不变）    谁拥有哪个决策 —— 与部署方式无关
部署拓扑（可变）    角色跑在哪里、谁能休眠、谁唤醒谁
资源档位（可变）    每个运行单元分多少内存
```

- **`executor` 永远不拥有 Telegram 令牌、频道和审核决定。** 共置只是物理事实，
  所有权永不合并。见[角色契约](docs/concepts/roles.md)。
- **`publisher` 永不休眠**：冷启动的投稿机器人对用户就是「坏了」。
- **进程休眠 ≠ 机器休眠；省内存 ≠ 省计算账单。** 见[生命周期](docs/concepts/lifecycle.md)。

---

## 文档

文档站：<https://redtidev1918.github.io/pixivflow-telepost-deploy/>
（中文为权威版本，英文镜像覆盖「选择架构 → 部署 → 运维」路径上的页面。）

| 我想… | 看这里 |
| --- | --- |
| 决定用哪种部署方式 | [选择部署方式](docs/getting-started/choose-architecture.md) |
| 从零跑到第一个 bot | [快速开始](docs/getting-started/quickstart.md) |
| 理解角色与所有权 | [角色契约](docs/concepts/roles.md) |
| 理解休眠、唤醒、停机 | [生命周期](docs/concepts/lifecycle.md) |
| 理解定时与槽位幂等 | [调度契约](docs/concepts/scheduling.md) |
| 知道凭据放在哪、边界在哪 | [凭据契约](docs/concepts/credentials.md) |
| 部署到 Fly.io | [Fly.io](docs/platforms/flyio.md) |
| 部署到一台 VPS | [Docker](docs/platforms/docker.md) / [VPS 与裸机](docs/platforms/vps.md) |
| 内存不够 / OOM | [性能与内存](docs/operations/performance.md) |
| 排障 | [故障排查](docs/operations/troubleshooting.md) |
| 从一种架构迁到另一种 | [迁移契约](docs/architectures/migration.md) |
| 知道每个概念的权威来源 | [部署契约](docs/reference/deployment-contract.md) |
| 看多架构的后续计划 | [Roadmap](docs/ROADMAP-MULTI-ARCH.md) |

全部页面：[文档中心](docs/README.md)。

---

## 目录

```text
deploy.go / init.go / go.mod     一键部署工具（Go 单二进制，随 Release 附带）
deploy_test.go                   CLI 测试
architecture_docs_test.go        文档一致性测试（preset / 矩阵 / 链接 / 契约）
docker-compose.yml               compose 拓扑：telepost + pixivflow + 可选 Caddy / Mihomo
fly/deploy.telepost.toml         业务端唯一拓扑来源（常驻）
fly/deploy.pixivflow.toml        执行端唯一拓扑来源（平时停止、跑完退出）
control-plane/                   Cloudflare 薄时钟：cron → schedule id → 一次带令牌的 POST
docker/                          镜像定义（透传层、按提交号构建的调度镜像、单机合体镜像）
supervisor/                      single-machine-worker-sleep 的按需进程编排（Go）
pixivflow/config/*.example.json  多计划安全模板
config/                          非敏感频道/审核策略模板
scripts/                         初始化、校验、只读生产核对
docs/                            文档：架构、概念、平台、运维、参考
proxy/                           可选 Mihomo 镜像
data/                            数据库、下载缓存、outbox、实际配置（不入库）
```

---

## 安全边界

- `.env`、`data/`、`proxy-data/` 与上传临时文件均被忽略。
- Bot Token、Pixiv Refresh Token、投稿 Token、代理订阅 URL 只能放 `.env` 或平台 Secret，
  不得放 JSON 模板、Git 历史或聊天截图。
- `split-worker` 与 `remote-worker` 下，执行端**没有任何 Telegram 令牌与频道 ID**，
  因此它无法直发频道、无法绕过审核、也无法成为 webhook owner。
  `single-host` 与 `single-machine-worker-sleep` 下两个角色共处一台机器，这条边界**不成立**。
  `control-plane/test/webhook-ownership.test.ts` 静态守护前者。
- Telegram webhook 只有一个负责人：TelePost 启动时注册；本仓库的任何脚本都不注册它。
- 根 API 默认只绑定 `127.0.0.1`；Webhook 经反向代进入站。
- 一旦凭据曾进入 Issue、日志、截图或 Git 历史，应立即吊销——自动检查不能替代轮换。

完整规则：[凭据契约](docs/concepts/credentials.md)、[SECURITY.md](SECURITY.md)。

---

## 参与项目

- 贡献代码：[CONTRIBUTING.md](CONTRIBUTING.md)
  （改完请跑 `go test ./...`、`./scripts/validate.sh --examples`、`(cd control-plane && npm test)`）
- 使用与排障：[SUPPORT.md](SUPPORT.md)
- 私下报告漏洞：[SECURITY.md](SECURITY.md)
- 社区行为准则：[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)

## 相关项目

| 项目 | 是什么 | 与本仓库的关系 |
| --- | --- | --- |
| [PixivFlow](https://github.com/redtidev1918/PixivFlow) | Pixiv 下载、筛选与自动收集工具：批量下载、定时任务、可靠 HTTP 交付 | 本仓库部署的上游执行端。它可以完全独立使用，只跑它不需要本仓库 |
| [TelePost](https://github.com/redtidev1918/TelePost) | Telegram 频道投稿、审核与自动化发布平台：Chat、Mini App、多 Bot、HTTP API | 本仓库部署的上游业务端。它也可以完全独立使用（下一个 Release 二进制即可） |

## 许可证

[MIT](LICENSE)

本项目与 Pixiv、Telegram、Fly.io 无隶属或官方合作关系。部署者应只处理有权下载、保存和
发布的内容，并自行遵守平台条款、版权要求与所在地法律。项目不会替部署者决定频道内容政策，
也不提供规避平台限制或监管的保证。

## 致谢

这套部署方案建立在两个上游项目之上：[PixivFlow](https://github.com/redtidev1918/PixivFlow)
（抓取、选品、下载与投递）和 [TelePost](https://github.com/redtidev1918/TelePost)
（投稿、审核与频道发布）——它们各自都能独立使用，本仓库只负责把它们拼成可部署、可运维的系统。
运行平面依赖 [Docker Compose](https://docs.docker.com/compose/) 与
[Fly.io](https://fly.io)；定时触发与出口代理的取舍见文档站的平台章节。
