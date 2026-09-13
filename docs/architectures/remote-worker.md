# `remote-worker` —— 远端执行端

| | |
| --- | --- |
| 支持等级 | **Beta** |
| 实现状态 | 已实现（compose 双主机拆分、`TELEPOST_API_BASE_URL`、跨主机 Fly 配置）、未经端到端测试 |
| 平台 | Docker Compose、systemd、Fly.io（可混用） |
| 一句话 | `executor` 与 `publisher` 不在同一台机器、也可以不在同一平台；两者经私网叠加网或公网 HTTPS 通信。 |

机器可读定义见
[`architecture-matrix.json` 的 `presets.remote-worker`](https://github.com/redtidev1918/pixivflow-telepost-deploy/blob/main/docs/reference/architecture-matrix.json)。

「混合云 / 家庭节点」**不是**第五个 preset，它是本 preset 的 placement 选择。
原因见本文末节：多一个 preset 就多一组需要验证的组合，而它的角色归属、
状态归属和生命周期都没有变化。

---

## 适合谁

- 已经有多台设备的人：一台 VPS + 一台家用服务器。
- 国内 VPS 跑业务端、海外执行节点跑 `executor`（或反过来）的人。
- 需要为 Pixiv 出口做特殊处理的人：执行节点放在出口已取得资格的机器上。
- 想让执行端跑在已有硬件上、只按需开机器的人。

如果你只有一台机器，看 [`single-host`](single-host.md)。
如果你只要 Fly.io 上的参考实现，看 [`split-worker`](split-worker.md)。

---

## 拓扑

```text
service-host（云或家庭）                 executor-host（云或家庭，独立于 service-host）
┌────────────────────────┐              ┌────────────────────────┐
│ publisher              │◄─────────────│ executor               │
│ telegram-ingress       │  submit API  │ clock                  │
│ 常驻                   │  私网叠加网   │ wake-run-exit 或常驻    │
│ 独立卷                  │  或公网 HTTPS │ 独立卷                  │
└────────────────────────┘              └────────────────────────┘
```

`clock` 可以放在三处之一：service-host 上的 `internal`、Cloudflare Worker 的 `cloudflare`、
或任意能发带 bearer 的 POST 的 `external` 定时器（cron-job.org、EasyCron、自己的 VPS cron）。

### placement 组合

| id | 例子 | 典型动机 |
| --- | --- | --- |
| `cloud-to-cloud` | VPS A 跑 TelePost，VPS B 跑 PixivFlow | 隔离资源与故障域，仍留在云上 |
| `cloud-to-home` | Fly / VPS 跑 TelePost，家用服务器跑 PixivFlow | 执行跑在已有硬件上，国内家庭宽带出口 |
| `home-to-cloud` | 家用服务器跑 TelePost，云 VPS 跑 PixivFlow | 业务数据留在家里，执行用干净出口 |

三种都是同一个 preset，差别只在 `units[].placement` 与传输方式。

---

## 资源要求

| 单元 | 要求 |
| --- | --- |
| `service-host` | 按 `publisher` 需求定档：`256m` 档单 Bot；双 Bot 约 170–230 MiB 空闲、200–230 MiB 峰值 |
| `executor-host` | ≥512 MiB；运行时受 `--max-old-space-size` 与 `download.concurrency` 约束 |
| 网络 | 私网叠加网，或公网 HTTPS；两端的出口各自独立 |
| 代理 | 按主机分别决定；`executor-host` 是唯一真正需要 Pixiv 出口资格的主机 |

两个主机的资源档位互相独立：`service-host` 用 `256m`、`executor-host` 用 `512m`
是合法组合（见矩阵 `resourceProfiles`）。

---

## 生命周期

| 角色 | 生命周期 | 谁唤醒 | 谁决定停机 |
| --- | --- | --- | --- |
| `clock` | `always-on` | 不适用 | 不适用 |
| `executor` | `wake-run-exit` 或 `always-on`（按平台能力） | 时钟；在 `wake-run-exit` 下是触发请求 | 在 `wake-run-exit` 下是 `executor` 自己的账本 |
| `publisher` | `always-on` | 从不休眠 | 从不停止 |
| `telegram-ingress` | `always-on` | 从不休眠 | 从不停止 |

`wake-run-exit` 只在平台支持「停止的机器被入站请求唤醒」时才可用。
Docker Compose 与裸机 systemd 都不支持，因此这两条路径上 `executor` 用 `always-on` +
`clock=internal`；要拿到 `wake-run-exit` 的省钱效果，用 Fly.io 承载 `executor-host`。

无论哪种组合，**`executor` 的停机判定永远读自己的账本**。宿主的 `docker stop`、
平台的空闲推断、监督进程的超时都不能替代它。

---

## 状态位置

| 状态 | 位置 | 说明 |
| --- | --- | --- |
| TelePost 每 Bot SQLite | `service-host` 的卷，`data/bot{N}/` | 投稿幂等、审核队列、发布记录 |
| TelePost 运行策略覆盖 | `data/bot{N}/runtime-policy.json` | OWNER 经 `/botconfig` 原子写入 |
| PixivFlow 槽位账本 | `executor-host` 的卷，`pixivflow.db` | occurrence、slot、slot item |
| 下载缓存与元数据 | `executor-host` 的卷 | 存储路径必须保持相对形式 |
| 投递 outbox | `executor-host` 的卷 | 跨重启保留，引用下载文件 |

**每个主机一个卷，永不共享。** 跨主机共享文件系统会把网络故障变成状态损坏，
本预设明确不支持。

---

## 网络

| 链路 | 推荐 | 说明 |
| --- | --- | --- |
| `executor` → `publisher` | 私网叠加网（Tailscale / WireGuard） | 不暴露公网端口；投递不出叠加网 |
| 备选 | 公网 HTTPS + 反向代理 | 必须启用 bearer 认证；不要裸暴露投稿端口 |
| Telegram → `publisher` | `webhook`（公网 HTTPS）或 `polling` | 两者暴露同一套 `api/botN/v1/*`，投递配置不随入站方式改变 |
| `executor` 出口 | 独立决定 | 出口资格必须单独取证 |

必须保持的配置：

```dotenv
# executor-host
TELEPOST_API_BASE_URL=https://<service-host>            # 或 http://<overlay-name>:8080
TELEPOST_BOT1_SUBMIT_TOKEN=...                          # 即使走私网也必须带
```

`NO_PROXY` / `no_proxy` 必须包含 `publisher` 的可达名字，否则投递会绕代理出公网，
既慢又会因为代理不可用而失败。

**私网不等于已认证。** 叠加网解决的是可达性，不是授权；投稿接口的 bearer 令牌在两个主机
分开时必须保持启用。这是本 preset 与 `single-host` 最重要的一条配置差异。

---

## 优点

- **出口可针对性选择。** `executor-host` 可以放在出口已取得 Pixiv 资格的机器上，
  与业务端解耦。这是本 preset 相对其它三个的核心收益。
- **可以复用已有硬件。** 执行端跑在已有服务器上，无需额外云资源。
- **业务数据与执行数据物理分离。** 审核队列与下载缓存不在同一台机器上。
- **平台不绑定。** 两个角色可以跑在不同平台上（例如 Fly 跑业务、家用服务器跑执行）。
- **故障域分离**，与 `split-worker` 同级。

---

## 缺点

- **跨网络边界。** 多一层叠加网或反向代理，多一类故障：DNS、证书、MTU、叠加网协调服务。
- **两个主机各自运维。** 备份、升级、监控都要覆盖两处。
- **延迟。** 投递要跨网络；家用出口的上行带宽可能成为瓶颈。
- **`executor-host` 的出口质量不可继承。** 业务端能用不代表执行端能用
  （见 [事故记录](../incidents/2026-09-11-pixiv-egress-rate-limit.md)）。
- **未经端到端测试。** 支持等级是 `beta`，不是 `stable`。
- **时钟选择变多。** `internal` 放在哪一侧、要不要外部时钟，是必须显式决定的事，
  配置错会得到「什么都没跑」而不是报错。

---

## 故障模型

| 故障 | 影响面 | 表现 | 恢复 |
| --- | --- | --- | --- |
| 叠加网断开 | `executor` → `publisher` 投递失败 | outbox 累积并按指数退避重试 | 恢复网络后自动排空；作品不丢 |
| `executor-host` 崩溃 | 只有执行平面 | 批次中断 | 账本使下次唤醒可续跑 |
| `service-host` 崩溃 | 用户可见 | 私聊投稿不可用 | 重启常驻服务 |
| 出口被 Pixiv 限流 | 只有执行平面 | `rate limit cooldown`、penalty 升级 | 换出口且重新取证 |
| 两个时钟同时生效 | 两个 execution 抢同一个 Pixiv 凭据 | 限流与 penalty 升级、重复触发 | 只保留一个时钟 |
| 投稿令牌缺失 | 投递全部 401 | outbox 快速累积 | 补 `TELEPOST_BOT{N}_SUBMIT_TOKEN` |
| 主机时钟漂移 | occurrence 计算偏移 | 计划在错误时间执行 | 两端启用 NTP；`clock=internal` 的漂移只影响自己 |

故障域是 `separated, across a network boundary`：隔离性最好，但也引入了一类
`split-worker` 没有的故障（网络边界本身）。

---

## 成本模型

| 项目 | 说明 |
| --- | --- |
| 两个宿主 | 各自计费 |
| 省钱来源 | 把 `executor` 放在便宜或已有的机器上；或在支持唤醒的平台上让它 `wake-run-exit` |
| 额外成本 | 叠加网服务（如果用了托管方案）、公网带宽、可能的反向代理主机 |

相对 `single-host`：多一台机器，换取出口自由与故障隔离。
相对 `split-worker`：不增加机器数，换取平台自由。

---

## 部署步骤

### 方案一：Docker Compose 拆两台

`docker-compose.yml` 的头部注释就是这个方案：默认「合一台」，要「拆两台」时
把 `pixivflow` service 部署到另一台主机。

```bash
# 在 service-host：只启动 publisher
docker compose up -d telepost

# 在 executor-host：部署 pixivflow，并把投递基址指向 service-host
TELEPOST_API_BASE_URL=https://<service-host>      # 或 http://<overlay-name>:8080
TELEPOST_BOT1_SUBMIT_TOKEN=...
PIXIV_REFRESH_TOKEN=...
```

### 方案二：Fly 执行端 + 任意业务端

`fly/deploy.pixivflow.toml` 里的投递地址与触发地址都是可替换的：
把 `TELEPOST_API_BASE_URL` 指向你自己的 business host，`PIXIVFLOW_TRIGGER_BASE_URL`
（在 `control-plane/wrangler.toml`）指向这个 Fly 应用。两份 Fly 配置不再是唯一拓扑来源，
本 preset 允许按需拆分。

### 方案三：systemd 两端

`deploy --platform systemd` 在 Linux 裸机上安装 TelePost supervisor，并可选择是否启用
同机 PixivFlow。禁用同机 PixivFlow、在第二台机器上独立运行执行端，即得到本 preset。

完整命令见 [docker.md](../platforms/docker.md)、[vps.md](../platforms/vps.md)、
[flyio.md](../platforms/flyio.md)。

### 部署后必查

1. 从 `executor-host` 能带令牌投递到 `service-host` 的投稿接口。
2. 未授权投递被拒（401），而不是被网络层挡住而看起来像成功。
3. `executor` 的出口在三份 Pixiv 数据面上各自可用：
   `oauth.secure.pixiv.net`、`app-api.pixiv.net`、`i.pximg.net`（带
   `Referer: https://app-api.pixiv.net/`）。
4. 只有一个时钟在触发这套 schedule。
5. 两个卷都能被各自的备份流程覆盖。

---

## 迁移路径

| 来源 | 目标 | 主要动作 |
| --- | --- | --- |
| `single-host` | 本 preset | 把 `executor` 的容器与它的状态目录搬到第二台主机；改 `TELEPOST_API_BASE_URL`；建立私网并保留 bearer 认证 |
| `split-worker` | 本 preset | 换平台或换主机；保持「两个角色两台机器两个卷」的形状；重配传输方式 |
| 本 preset | `single-host` | 两台机器合一台；`TELEPOST_API_BASE_URL` 改回 `http://telepost:8080`；确认回环投递不经代理 |
| 本 preset | `split-worker` | 收敛到 Fly 参考实现；加外部时钟；执行端改为 `wake-run-exit` |

数据清单见 [migration.md](migration.md)。

---

## 为什么没有第五个「混合云」preset

「Cloudflare = 时钟 + Fly = TelePost + 家用服务器 = PixivFlow」这种组合看起来像新架构，
但它改变的只有 `units[].placement`：角色没变、状态归属没变、生命周期没变、凭据边界没变。
把它做成第五个 preset 会得到：

```text
4 个 preset × N 个 placement 组合 → 需要验证的组合数量成倍增长
```

本仓库的选择是：

```text
少量经过验证的 Preset  +  有限 Feature switches  +  显式的 placement 组合
```

所以「混合云 / 家庭节点」被表达为 `remote-worker` + 一张 placement 表，
而不是一个新的 preset。这也是 [overview.md](overview.md) 里
「不要制造任意组合」那条规则的直接应用。
