# VPS / 裸机（systemd 或 Docker）

> **本页是「在没有 Fly、也不一定用 Docker 的 VPS/裸机上部署」的权威说明。** 一台 VPS 用
> Compose 时按 [docker.md](./docker.md)（即 [`single-host`](../architectures/single-host.md)）；
> 用 systemd 源码直跑时是同一个 `single-host` 语义，只是运行时不同。两台设备时见
> [remote-worker.md](../architectures/remote-worker.md)。

## 两条路线

| 路线 | 前提 | 命令 | 说明 |
| --- | --- | --- | --- |
| Docker Compose | 有 Docker 24+ | `docker compose up -d` | 推荐，见 [docker.md](./docker.md) |
| systemd（免 Docker） | Linux + systemd + python3/node | `./deploy --platform systemd` | 源码直跑，`deploy` 自动装依赖 |

## systemd 路线做什么

`deploy --platform systemd` 会：

1. clone TelePost → 建 venv + `pip install`；
2. 安装 Node + `npm i -g pixivflow`（**组合单机省钱形态**：同机托管两个进程）；
3. 引导填写 `BOT1_TOKEN` / `BOT1_CHANNEL_ID` 及是否启用 PixivFlow，写入 `/opt/telepost/.env`；
4. 写 `/etc/systemd/system/telepost.service`；
5. `systemctl enable --now telepost`。

TelePost 的 supervisor 在同机托管 Bot 与 PixivFlow 两个进程，复刻 Fly 上的省钱组合。
升级：`./deploy tp latest`（git pull + pip + restart）、`./deploy pf latest`（npm 重装 + restart）。

裸机下 `watchConfig = true`（同 Compose）：改 `data/pixivflow/config.json` 即热重载。

## 512 MiB VPS 注意

- 最多两个 Bot；关闭搜索与 WebUI。
- `download.concurrency=1`。
- 内置代理放不下（50–100 MiB）：优先外部代理；否则升到 1 GiB。见
  [network.md](../concepts/network.md) 与 [proxy.md](./proxy.md)。

## 出口资格（最常见坑）

**能登录 ≠ 出口合格。** 反复 `rate limit cooldown` 且 `penaltyLevel` 从 1 升到 2，是出口
资格问题。国内 VPS 跑 Pixiv 常需合格出口：可加代理，或把执行端放到海外节点
（[remote-worker.md](../architectures/remote-worker.md)）。证据与时间线见
[出口限流事故](../incidents/2026-09-11-pixiv-egress-rate-limit.md)。

## 国内机器本地构建镜像

若必须本地构建，在 `.env` 设 `BUILD_HTTP_PROXY` / `BUILD_HTTPS_PROXY` 指向宿主机可访问的
代理（运行中的 Compose 代理**不能**参与 build）。

## 相关页面

- 单机 preset：[single-host.md](../architectures/single-host.md)
- Docker 路线：[docker.md](./docker.md)
- 网络与出口：[network.md](../concepts/network.md)
- 环境变量：[environment.md](../reference/environment.md)
