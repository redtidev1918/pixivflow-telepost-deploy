# `single-host` —— 单机一体化

| | |
| --- | --- |
| 支持等级 | **Stable** |
| 实现状态 | 已实现（`docker-compose.yml`、`docker/combined.Dockerfile`）、CI 覆盖、未在生产验证 |
| 平台 | Docker Compose、systemd |
| 一句话 | 一台机器跑全部角色：TelePost 与 PixivFlow 各一个容器，共享一个 `./data` 目录，经容器网络通信。 |

机器可读定义见
[`architecture-matrix.json` 的 `presets.single-host`](https://github.com/redtidev1918/pixivflow-telepost-deploy/blob/main/docs/reference/architecture-matrix.json)。

---

## 适合谁

- 只有一台家用机、VPS、NAS 或轻量服务器的人。
- 不想理解分布式架构，希望一条命令跑起来的人。
- 愿意接受「两个角色共用一个故障域」换取最少组件的人。
- 已经在 Docker Compose 下运行、短期内不打算拆机器的人。

如果你只有一台 512 MiB 的机器并且想省 Fly 账单，这个 preset 不是答案，
见 [`single-machine-worker-sleep`](single-machine-worker-sleep.md) 与 [`split-worker`](split-worker.md)。

---

## 拓扑

```text
One Host
│
├─ telepost 容器      publisher + telegram-ingress   常驻
├─ pixivflow 容器     executor + clock(internal)     常驻
└─ ./data 卷          state                          按角色分子目录
        ├─ bot1/          每 Bot SQLite、runtime-policy.json
        ├─ bot2/
        └─ pixivflow/     pixivflow.db、下载缓存、outbox
```

可选单元：

```text
caddy 容器    --profile webhook   公网 HTTPS 入口（webhook 模式）
proxy 容器    --profile proxy     内置 Mihomo（国内网络）
```

`docker-compose.yml` 的注释写得很直白：默认是「合一台」，两个 service 落在同一台
Docker 主机。要拆两台时，把 pixivflow service 放到另一台主机、把
`TELEPOST_API_BASE_URL` 指向 telepost 的地址即可——那属于 [`remote-worker`](remote-worker.md)。

---

## 资源要求

| 档位 | 组合 | 做法 |
| --- | --- | --- |
| `256m` | 单 Bot、不跑 executor | `docker compose up -d telepost`，`TELEPOST_MEMORY_LIMIT=256m` |
| `512m`（默认） | 双 Bot + executor | `TELEPOST_MEMORY_LIMIT=320m` + `PIXIVFLOW_MEMORY_LIMIT=192m`（或 `256m`，见下） |
| `1g` | 上述 + 搜索 或 WebUI | 调大两个 `mem_limit`，`SEARCH_ENABLED=true` |

约束：`bots<=2`、`search=disabled`、`download.concurrency=1`、不启动 WebUI、
`NODE_OPTIONS=--max-old-space-size=96 --expose-gc`、`MALLOC_ARENA_MAX=2`、日志轮转。
完整档位与杠杆见 [performance.md](../operations/performance.md)。

> `.env.example` 的 `PIXIVFLOW_MEMORY_LIMIT=256m` 与 `docker-compose.yml` 的默认值 `192m`
> 不一致，两者之和分别对应 576m 与 512m 的整机预算。以 `docker-compose.yml` 的默认值为
> 512 MiB 档的基线；显式在 `.env` 里设置时按上面的表分配。

---

## 生命周期

| 角色 | 生命周期 | 谁唤醒 | 谁决定停机 |
| --- | --- | --- | --- |
| `publisher` | `always-on` | 不适用 | `restart: unless-stopped` |
| `telegram-ingress` | `always-on` | 不适用 | 同上 |
| `executor` | `always-on` | 不适用 | 同上 |
| `clock` | `always-on` | 不适用 | 不适用 |

两个容器都常驻，生命周期由宿主与容器重启策略决定。这里**没有**「谁负责唤醒」的问题，
也因此没有 `exitWhenIdle` 的用武之地：`internal` 模式下进程常驻，内部 cron 到点即跑。

健康检查在这里是安全的，与 `split-worker` 的执行端相反：容器不会被探测唤醒，
因为容器本来就没有停止。`docker-compose.yml` 里 telepost 用 `/ready` 作为依赖门禁，
pixivflow 在设置了 `SCHEDULER_TRIGGER_TOKEN` 时探测触发端口。

---

## 状态位置

| 状态 | 路径 | 丢失后果 |
| --- | --- | --- |
| TelePost 每 Bot SQLite | `./data/bot{N}/` | 投稿幂等与审核队列全部丢失 |
| TelePost 运行策略覆盖 | `./data/bot{N}/runtime-policy.json` | 回落到 `.env` 的部署默认值 |
| PixivFlow 槽位账本 | `./data/pixivflow/pixivflow.db` | 已选作品与 occurrence 记录丢失 |
| 下载缓存与元数据 | `./data/pixivflow/` 下的相对路径 | 需要重新下载 |
| 投递 outbox | 同上，由 manifest 引用文件 | 未投递的作品永久丢失 |

**一个卷，按角色分子目录，没有卷级隔离。** 任一容器写坏共享目录都会影响另一个角色。
完整清单与备份规则见 [state.md](../concepts/state.md) 与 [backup.md](../operations/backup.md)。

---

## 网络

| 项目 | 取值 |
| --- | --- |
| `executor` → `publisher` | `container-network`，`http://telepost:8080`（`TELEPOST_API_BASE_URL` 默认值） |
| `telegram-ingress` | `polling`：不需要入站端口，根 API 默认只绑定 `127.0.0.1:8080` |
| `telegram-ingress` | `webhook`：`--profile webhook` 起 Caddy，`WEBHOOK_DOMAIN` / `WEBHOOK_URL` 指向公网域名 |
| 出口 | `direct`，或 `--profile proxy` 使用内置 Mihomo（`http://proxy:7890`） |

`NO_PROXY` / `no_proxy` 已包含 `127.0.0.1`、`localhost`、`telepost`、`pixivflow`、`proxy`，
因此内部投递不会绕公网或代理。

---

## 优点

- **最容易部署。** 组件最少，没有外部时钟、没有平台专属配置。
- **本地网络通信。** 内部投递不出主机，不计公网流量，不涉及私网 overlay。
- **一个卷即可备份。**
- **平台无关。** 任何能跑 Docker Compose 的机器都可以；没有 Docker 时 systemd 后端同样成立。
- **健康检查可用。** 常驻角色不担心探测把自己叫醒。

---

## 缺点

- **单故障域。** 任一角色 OOM 或崩溃都与另一个角色共享机器、内存与启动脚本。
- **`executor` 与 `publisher` 争内存。** 512 MiB 档必须严格限制下载并发，否则一方被 OOM kill。
- **主机级凭据隔离不成立。** 两个角色共用一台机器、一份 `.env` 和一个卷；同机进程理论上能读到
  业务端的 secret。但 executor 单元在结构上仍不持有 Telegram 凭据：compose 只给 pixivflow 传
  `BOT*_SUBMIT_TOKEN`（SI-1 全局成立）。需要主机级隔离只能换 [`split-worker`](split-worker.md) 或 [`remote-worker`](remote-worker.md)。
- **没有省钱机制。** 机器常驻计费，空闲不省钱。

---

## 故障模型

| 故障 | 影响面 | 表现 | 恢复 |
| --- | --- | --- | --- |
| `executor` OOM | 同机全部角色受内存压力 | exit 137，批次被中断 | 升档或降并发；槽位账本使下次唤醒可续跑 |
| `publisher` 崩溃 | 用户投稿不可用 | 私聊投稿像坏了 | `restart: unless-stopped` 自动重启 |
| 卷损坏 | 两个角色一起丢状态 | 审核队列与 outbox 同时消失 | 从卷快照恢复 |
| 宿主重启 | 全部角色短暂不可用 | 容器依次重启 | 无需人工介入 |
| 出口被 Pixiv 限流 | 只有 `executor` 受影响 | `rate limit cooldown`、penalty 升级 | 换出口或换主机；见 [事故记录](../incidents/2026-09-11-pixiv-egress-rate-limit.md) |

故障域是 `single`。任何「一个角色坏了另一个还活着」的预期在这个 preset 下都不成立。

---

## 成本模型

宿主成本，常驻。没有按 idle 省钱的机制，也没有按执行次数计费的机制。
省钱手段只有两个：换更便宜的宿主，或迁移到 [`split-worker`](split-worker.md) 让执行端平时不运行。

---

## 部署步骤

```bash
git clone https://github.com/redtidev1918/pixivflow-telepost-deploy
cd pixivflow-telepost-deploy
./scripts/bootstrap.sh          # 生成 .env 与 data/pixivflow/config.json
# 编辑 .env：至少填 BOT1_TOKEN、BOT1_CHANNEL_ID、BOT1_OWNER_ID
# 编辑 data/pixivflow/config.json：替换示例主题、调整 Cron、把要跑的计划改成 "enabled": true
./scripts/validate.sh
docker compose up -d
docker compose ps
curl http://127.0.0.1:8080/health
```

不用仓库克隆、只要一个二进制时用 `deploy init`：

```bash
deploy init mybot && cd mybot
deploy doctor && deploy deploy
```

完整步骤见 [quickstart.md](../getting-started/quickstart.md) 与 [docker.md](../platforms/docker.md)。
无 Docker 的 Linux 机器见 [vps.md](../platforms/vps.md)。

---

## 迁移路径

| 目标 | 需要搬的状态 | 主要动作 |
| --- | --- | --- |
| `single-machine-worker-sleep` | 同一个 `./data` 目录 | 改成由常驻 supervisor 按需拉起 executor；当前**未实现**，先读该 preset 的状态字段 |
| `split-worker` | PixivFlow 与 TelePost 的状态分别搬到两个卷 | 三份 Fly 配置（pixivflow / telepost / telepress）、一个外部时钟；执行端重建时确认下载缓存的相对路径 |
| `remote-worker` | 只搬 executor 的状态目录 | 把 pixivflow service 移到第二台主机，改 `TELEPOST_API_BASE_URL`，加认证与私网 |

反向迁移同样成立。完整的数据清单与非迁移项见 [migration.md](migration.md)。
