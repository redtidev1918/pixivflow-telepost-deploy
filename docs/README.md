# PixivFlow + TelePost Deploy 文档中心

> **English:** This is the deployment kit that wires [PixivFlow](https://github.com/redtidev1918/PixivFlow)
> (download scheduler) together with TelePost (Telegram review/publish bot), shipped as
> a Go `deploy` CLI plus Docker Compose and Fly.io backends. New here? Follow
> [SCENARIOS](SCENARIOS.md) → pick [Polling](POLLING.md) or [Webhook](WEBHOOK.md).

这是 PixivFlow + TelePost 的部署套件：`deploy` CLI（Go 单二进制）+ Docker Compose +
Fly.io，把 PixivFlow 的定时下载和 TelePost 的 Telegram 审核/发布串起来。按你的目标选一条路线:

## 🧭 按任务找文档

| 你想做什么 | 路线 |
| --- | --- |
| 第一次部署,跑通第一个 bot | [部署场景速查](SCENARIOS.md) → [Polling：无公网部署](POLLING.md) |
| 有域名、要公网 HTTPS 入站 | [Webhook：公网 HTTPS 部署](WEBHOOK.md) |
| 国内服务器、需要代理 | [国内网络与 Mihomo](MIHOMO.md) |
| 加第 2、3 个频道 | [多 Bot：加第 N 个频道](MULTI-BOT.md) |
| 想省钱、开自动休眠 | [Fly.io 自动休眠（auto-stop）](AUTOSTOP.md) |
| 内存不够 / OOM 调优 | [性能与内存调优](PERFORMANCE.md) |
| 从 Mac 远程更新配置或代码 | [从 Mac 远程更新策略](REMOTE_UPDATES.md) |
| 了解架构、二次开发 | [架构与信任边界](ARCHITECTURE.md) |

## 📚 全部文档

### 开始部署

| 文档 | 内容 |
| --- | --- |
| [SCENARIOS](SCENARIOS.md) | 两条路径（Compose / deploy CLI）、Docker Compose 四场景、无 Docker 的 systemd 后端、Fly.io |
| [POLLING](POLLING.md) | 无公网部署：RUN_MODE=AUTO、Webhook_URL 留空、内部投递地址 |
| [WEBHOOK](WEBHOOK.md) | 公网 HTTPS 部署：Caddy 自动证书、多 Bot 路径、反代与安全建议 |

### 场景

| 文档 | 内容 |
| --- | --- |
| [MIHOMO](MIHOMO.md) | 国内网络：内置 Mihomo 容器、代理环境变量、构建期代理 |
| [MULTI-BOT](MULTI-BOT.md) | 多 Bot：自动发现 BOT{N}_TOKEN、各后端加 bot、让 PixivFlow 投递给新 bot |
| [REMOTE_UPDATES](REMOTE_UPDATES.md) | 从 Mac 远程更新：PixivFlow 源码热修复、配置热重载、TelePost 策略短重启 |

### 运维

| 文档 | 内容 |
| --- | --- |
| [AUTOSTOP](AUTOSTOP.md) | Fly auto-stop 成本优化：stop vs suspend、外部闹钟、推荐拓扑与决策清单 |
| [PERFORMANCE](PERFORMANCE.md) | 内存调优：先测量、按影响排序的杠杆、256/512/1 GiB 三档与监控 |

### 进阶

| 文档 | 内容 |
| --- | --- |
| [ARCHITECTURE](ARCHITECTURE.md) | Core Runtime vs 平台优化、进程模型、持久化与失败语义、信任边界 |

## 🔗 其他入口

- 项目主页:<https://github.com/redtidev1918/pixivflow-telepost-deploy>
- 发版记录:[Releases](https://github.com/redtidev1918/pixivflow-telepost-deploy/releases)
- 问题反馈:[Issues](https://github.com/redtidev1918/pixivflow-telepost-deploy/issues)

---

## 相关文档

- [SCENARIOS](SCENARIOS.md) — 还没跑起来?从这里开始
- [POLLING](POLLING.md) — 无公网环境?默认就是它
- [AUTOSTOP](AUTOSTOP.md) — 想省钱?先读适用画像
