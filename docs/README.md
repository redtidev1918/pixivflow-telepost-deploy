# PixivFlow + TelePost Deploy 文档中心

**English mirror:** the deployment paths (choose an architecture → deploy → operate) are mirrored
under [`en/`](en/). Chinese is authoritative; pages outside the mirror set are Chinese-only.

本仓库把 [PixivFlow](https://github.com/redtidev1918/PixivFlow)（下载调度器）与
TelePost（Telegram 审核/发布 Bot）组合成一套可部署系统，以 Go `deploy` CLI、
Docker Compose 与 Fly.io 三种后端交付。

**核心业务模型只有一套，部署拓扑可以有多种合法实现。** 角色所有权、状态归属与生命周期语义
不随部署方式变化；变化的只是角色跑在哪里、谁能休眠、谁唤醒谁、谁持有凭据。
角色契约的权威描述是[角色与所有权](concepts/roles.md)。

## 三条阅读路径

| 你是谁 | 从这里开始 |
| --- | --- |
| **普通用户**：想跑起来 | [我该选哪种部署方式](getting-started/choose-architecture.md) → [快速开始](getting-started/quickstart.md) → 平台页 |
| **运维者**：已经在跑 | [监控与只读核对](operations/monitoring.md) → [故障排查](operations/troubleshooting.md) → [升级与回滚](operations/upgrades.md) |
| **Agent / 二次开发**：要改东西 | [AGENTS.md](https://github.com/redtidev1918/pixivflow-telepost-deploy/blob/main/AGENTS.md) → [部署契约](reference/deployment-contract.md) → [架构矩阵](https://github.com/redtidev1918/pixivflow-telepost-deploy/blob/main/docs/reference/architecture-matrix.json) → 具体页面 |

## 按任务找文档

| 你想做什么 | 路线 |
| --- | --- |
| 第一次部署，跑通第一个 bot | [选择部署方式](getting-started/choose-architecture.md) → [快速开始](getting-started/quickstart.md) → [Docker Compose](platforms/docker.md) |
| 只有一台 VPS | [`single-host`](architectures/single-host.md) → [Docker Compose](platforms/docker.md) 或 [VPS 与裸机](platforms/vps.md) |
| 在 Fly.io 上跑生产 | [`split-worker`](architectures/split-worker.md) → [Fly.io](platforms/flyio.md) → [Cloudflare 时钟](platforms/cloudflare.md) |
| 有两台设备（VPS + 家用机） | [`remote-worker`](architectures/remote-worker.md) → [VPS 与裸机](platforms/vps.md) |
| 无公网入站 | [Docker Compose](platforms/docker.md) 的 Polling 模式 |
| 有域名、要公网 HTTPS 入站 | [Docker Compose](platforms/docker.md) 的 Webhook 模式 |
| 国内服务器、需要代理 | [代理与出口](platforms/proxy.md) |
| 加第 2、3 个频道 | [多 Bot：加第 N 个频道](operations/multi-bot.md) |
| 内存不够 / OOM 调优 | [性能与内存调优](operations/performance.md) |
| 服务不正常 | [故障排查](operations/troubleshooting.md) → [监控与只读核对](operations/monitoring.md) |
| 备份或恢复 | [备份与恢复](operations/backup.md) → [持久状态与卷](concepts/state.md) |
| 升级或回滚 | [升级与回滚](operations/upgrades.md) |
| 换一种部署架构 | [架构迁移契约](architectures/migration.md) |
| 理解调度、槽位、幂等 | [调度与 occurrence](concepts/scheduling.md) → [投递与 outbox](concepts/delivery.md) |
| 理解谁能休眠、谁唤醒谁 | [生命周期](concepts/lifecycle.md) |
| 知道凭据放在哪、边界在哪 | [凭据契约](concepts/credentials.md) |
| 知道每个概念的权威来源 | [部署契约](reference/deployment-contract.md) |
| 下载 `deploy` 二进制 | [下载页](download.md)（英文版 [Download](en/download.md)） |
| 看多架构的后续计划 | [Roadmap：多架构实现计划](ROADMAP-MULTI-ARCH.md) |

## 部署架构

四个 preset，名称在全部文档与 [`architecture-matrix.json`](https://github.com/redtidev1918/pixivflow-telepost-deploy/blob/main/docs/reference/architecture-matrix.json)
中保持一致，由 `architecture_docs_test.go` 强制。

| Preset | 支持等级 | 文档 |
| --- | --- | --- |
| `single-host` | Stable | [单机一体化](architectures/single-host.md) |
| `single-machine-worker-sleep` | Experimental（不可部署） | [单机 + 执行进程休眠](architectures/single-machine-worker-sleep.md) |
| `split-worker` | Stable（当前生产） | [分离执行端](architectures/split-worker.md) |
| `remote-worker` | Beta | [远端执行端](architectures/remote-worker.md) |

架构选择入口：[总览](architectures/overview.md) 与 [我该选哪种部署方式](getting-started/choose-architecture.md)。

## 全部文档

**开始**

| 文档 | 内容 |
| --- | --- |
| [我该选哪种部署方式](getting-started/choose-architecture.md) | 情况对照表、决策树、常见误配、进程休眠与机器休眠的区别 |
| [快速开始](getting-started/quickstart.md) | 从零到第一个 bot：凭据、安装、配置、起服务、验证清单 |

**部署架构**（每页固定章节：适合谁 / 拓扑 / 资源要求 / 生命周期 / 状态位置 / 网络 /
优点 / 缺点 / 故障模型 / 成本模型 / 部署步骤 / 迁移路径）

| 文档 | 内容 |
| --- | --- |
| [总览](architectures/overview.md) | Preset 矩阵、支持等级、角色落点、功能开关、合法与非法组合、平台支持 |
| [single-host](architectures/single-host.md) | 一台机器跑全部角色；Compose 参考实现 |
| [single-machine-worker-sleep](architectures/single-machine-worker-sleep.md) | 一台机器，业务常驻、执行进程按需；**进程编排已实现，preset 仍不可部署** |
| [split-worker](architectures/split-worker.md) | 当前生产：两台机器、两个卷、外部时钟、执行端平时停止 |
| [remote-worker](architectures/remote-worker.md) | 跨机器跨网络；placement 组合（云-云 / 云-家 / 家-云） |
| [迁移契约](architectures/migration.md) | 哪些数据必须搬、哪些不需要、迁移顺序、迁移期禁忌 |

**概念**

| 文档 | 内容 |
| --- | --- |
| [角色与所有权](concepts/roles.md) | 六个逻辑角色、所有权划分、共置不合并所有权、改动路由 |
| [生命周期](concepts/lifecycle.md) | 三种生命周期、谁可以睡、为什么禁止平台 auto-stop 与健康检查 |
| [持久状态与卷](concepts/state.md) | 状态清单、卷是状态边界、哪些东西不是状态 |
| [调度与 occurrence](concepts/scheduling.md) | 时钟 provider、十条不变量、Slot 模型、触发 API |
| [投递与 outbox](concepts/delivery.md) | multipart 投稿 API、幂等键、outbox 重试、终态下游状态 |
| [凭据契约](concepts/credentials.md) | 凭据归属、四条处理不变量、随 preset 变化的边界 |
| [网络与出口](concepts/network.md) | 五种传输、webhook 与 polling、Pixiv 数据面与出口资格 |

**平台**

| 文档 | 内容 |
| --- | --- |
| [Docker Compose](platforms/docker.md) | `single-host` 操作说明；Polling / Webhook / 代理三种网络模式 |
| [Fly.io](platforms/flyio.md) | `split-worker` 操作说明；两份配置、生命周期规则、镜像固定、传输约束 |
| [VPS 与裸机](platforms/vps.md) | systemd 后端、512 MiB 注意、出口资格 |
| [Cloudflare 时钟平面](platforms/cloudflare.md) | 薄 Worker 做什么、绝不做什么、部署与验证 |
| [代理与出口](platforms/proxy.md) | 内置 Mihomo 或外部代理、构建期代理、出口资格不等于可达性 |

**运维**

| 文档 | 内容 |
| --- | --- |
| [监控与只读核对](operations/monitoring.md) | 只读脚本清单、`/health` 字段、stopped 是健康状态 |
| [备份与恢复](operations/backup.md) | 按 preset 的备份对象、SQLite 安全、恢复流程 |
| [升级与回滚](operations/upgrades.md) | 镜像固定规则、配置更新模型随 preset 不同、策略更新、回滚 |
| [故障排查](operations/troubleshooting.md) | 症状表、反模式、具体诊断 |
| [性能与内存调优](operations/performance.md) | 先测量、杠杆、资源档位、两条硬规则 |
| [多 Bot](operations/multi-bot.md) | 自动发现 `BOT{N}_TOKEN`、各 preset 加 bot、投递到新 Bot |

**参考**

| 文档 | 内容 |
| --- | --- |
| [部署契约](reference/deployment-contract.md) | 统一部署模型、single source of truth 表、Agent 与测试如何消费 |
| [环境变量与资源档位](reference/environment.md) | 档位表、命名规范、环境变量参考 |
| [架构矩阵](https://github.com/redtidev1918/pixivflow-telepost-deploy/blob/main/docs/reference/architecture-matrix.json) | 机器可读的 preset / 角色 / 组合 / 档位 / 不变量（GitHub 打开） |
| [Roadmap：多架构实现计划](ROADMAP-MULTI-ARCH.md) | Phase 1–5：契约 → manifest → worker-sleep → remote-worker → CLI |
| [事故：Pixiv 出口限流 2026-09-11](incidents/2026-09-11-pixiv-egress-rate-limit.md) | 控制面兼容不等于执行面兼容；出口资格必须单独取证 |

**English**

| Document | Content |
| --- | --- |
| [English index](en/README.md) | Translation policy, preset list, task router |
| [Choose an architecture](en/getting-started/choose-architecture.md) | English mirror |
| [Quickstart](en/getting-started/quickstart.md) | English mirror |
| [Architectures](en/architectures/overview.md) | English mirror |
| [Platforms](en/platforms/docker.md) | English mirror |
| [Deployment contract](en/reference/deployment-contract.md) | English mirror |

## 其他入口

- 项目主页：<https://github.com/redtidev1918/pixivflow-telepost-deploy>
- 发版记录：[Releases](https://github.com/redtidev1918/pixivflow-telepost-deploy/releases)
- 问题反馈：[Issues](https://github.com/redtidev1918/pixivflow-telepost-deploy/issues)
