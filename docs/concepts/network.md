# 网络与出口：角色之间怎么连、Pixiv 怎么出去

> **本页是「角色之间的传输路径、Pixiv/Telegram 的出口、代理如何介入」的唯一权威描述。**
> 它是逻辑角色 `network`（`kind: capability`）的展开。矩阵 `authority` 未单列本页，但它的
> `roles[]` 中 `network` 一行的 `owns` / `neverOwns` / `failureDomain` 与
> `enums.transport`、`enums.networkMode`、`platformSupport` 都由本页解释。代理的具体配置见
> [proxy.md](../platforms/proxy.md)。

## 核心原则

**出口是可替换能力，永远不是第二个调度器。** `network` 不拥有任何业务状态，它的故障域是
「出口不合格时表现为 Pixiv 限流，而不是传输错误」。矩阵把 `network` 的 `neverOwns` 写成
「business state」。

## 角色之间的传输（随 preset 变化）

矩阵 `enums.transport` 定义了合法取值，每个 preset 在此表中选择：

| Preset | 传输 | 具体路径 | 是否加密 | 是否认证 |
| --- | --- | --- | --- | --- |
| `single-host` | `container-network` | `http://telepost:8080` | 明文（Docker 内网） | 投稿接口 bearer |
| `single-machine-worker-sleep` | `loopback-http` | `http://127.0.0.1:8080` | 明文（回环） | 投稿接口 bearer |
| `split-worker` | `flycast` | `http://telesubmit-multi-bot.flycast` | 明文（Fly 私网） | 投稿接口 bearer |
| `remote-worker` | `private-overlay` 或 `public-https` | Tailscale / WireGuard 或公网 HTTPS | 由部署者决定 | **投稿接口 bearer 强制** |

两条与拓扑无关的规则：

1. **投稿接口的 bearer 是强制的**，即使走私网 overlay。`remote-worker` 的不变量明确写着这一点：
   overlay 只解决可达性，不替代认证。
2. **内部投递不绕代理。** `NO_PROXY` / `no_proxy` 必须包含内部地址（Compose 为 `127.0.0.1`、
   `localhost`、`telepost`、`pixivflow`、`proxy`），否则执行端到业务端的请求会绕公网或代理。

一条 Fly 专属陷阱：业务端 `force_https = false` 不能删，否则 Fly proxy 把明文 Flycast 投递
重定向成 HTTPS，而执行端不跟这条路（见 [delivery.md](./delivery.md)）。

## Telegram 入站（feature switch）

| 取值 | 需要什么 | 适用 |
| --- | --- | --- |
| `polling` | 无公网入口；根 API 默认只绑定 `127.0.0.1:8080` | 家庭/NAT、受限网络、想省事的人 |
| `webhook` | 公网 HTTPS 入口（域名 + 证书，或隧道/反向代理） | 有域名且 80/443 可入站 |

两种模式提供**同一套** `api/botN/v1/*` 接口，因此执行端的投递配置不随入站模式改变。
矩阵把 `webhook-without-public-ingress` 列为 `supportedWithLimitations`：需要隧道或反向代理，
否则改用 polling。`AUTO` 模式在 webhook 注册失败时回退 polling。

**webhook 归属永远只有一个：TelePost。** 这是 `SI-2`，任何 preset 都不例外。见
[credentials.md](./credentials.md)。

## 出口：Pixiv 数据面与资格

PixivFlow 依赖**三个彼此独立的 Pixiv 数据面**，必须分别取得资格：

| 数据面 | 主机 | 说明 |
| --- | --- | --- |
| OAuth | `oauth.secure.pixiv.net` | 登录与刷新令牌 |
| App API | `app-api.pixiv.net` | 榜单、主题、作品元数据 |
| 媒体 CDN | `i.pximg.net` | 图片请求需携带 `Referer: https://app-api.pixiv.net/` |

**能鉴权只证明可达，不证明适用。** 代理只解决可达性，不会让出口变得合格；一个出口能登录
不代表它不会被 App API 限流。反复 `rate limit cooldown` 且 `penaltyLevel` 从 1 升到 2，
是**出口资格**问题，不是代码问题——每个出口都要做各自的 A/B 探测。完整证据与时间线见
[事故记录 2026-09-11 — Pixiv 出口限流](../incidents/2026-09-11-pixiv-egress-rate-limit.md)。

出口资格是**按宿主**的属性：`single-host` 只有一套出口，`split-worker` 与 `remote-worker`
的执行主机各有自己的出口。换出口不影响 `SI-4`：同一 Pixiv 凭据最多一个在生产执行。

## 代理（feature switch `network`）

| 取值 | 含义 |
| --- | --- |
| `direct` | 直连 Pixiv 与 Telegram |
| `proxy` | 经内置或外部 HTTP 代理 |

- **内置 Mihomo**：`--profile proxy`，`SUB_URL` 注入订阅，端口 7890 / 9090 只绑定宿主机回环。
  配置见 [proxy.md](../platforms/proxy.md)。
- **外部代理**：已有稳定、合规代理时，直接设 `HTTP_PROXY_URL` / `EGRESS_ALL_PROXY`，不用内置单元。
- **构建期代理**：国内机器本地构建镜像时，`BUILD_HTTP_PROXY` / `BUILD_HTTPS_PROXY` 指向宿主机
  可访问的代理（运行中的 Compose 代理不能参与 build）。

矩阵把 `bundled-proxy-on-256m` 列为 `invalid`：代理本身就要 50–100 MiB。512 MiB 整机也**不建议**
同时跑规则量很大的 Mihomo——代理频繁 OOM、Pixiv 下载超时或 Telegram 请求失败时，应改用外部
代理或升到 1 GiB。

## 出口与部署的映射

| Preset | 出口所在 | 常见做法 |
| --- | --- | --- |
| `single-host` | 宿主 | 国内宿主 + 外部代理，或 `--profile proxy` |
| `single-machine-worker-sleep` | 机器 | 512 MiB 上优先用外部代理，避免与执行进程争内存 |
| `split-worker` | 每台机器各自 | 执行机出口决定 Pixiv 资格；业务机出口决定 Telegram 可达性 |
| `remote-worker` | 每主机各自 | 典型用途：国内 VPS 跑业务、海外节点跑执行，为 Pixiv 取得合格出口 |

`remote-worker` 的 `placementModes`（`cloud-to-cloud`、`cloud-to-home`、`home-to-cloud`）本质上
就是「把出口放在哪台机器」的选择，见 [remote-worker.md](../architectures/remote-worker.md)。

## 相关页面

- 谁拥有什么、绝不拥有什么：[roles.md](./roles.md)
- 投递协议与幂等：[delivery.md](./delivery.md)
- 代理容器配置：[proxy.md](../platforms/proxy.md)
- 出口限流事故：[incidents/2026-09-11-pixiv-egress-rate-limit.md](../incidents/2026-09-11-pixiv-egress-rate-limit.md)
- 各平台网络细节：[docker.md](../platforms/docker.md)、[vps.md](../platforms/vps.md)、[flyio.md](../platforms/flyio.md)
