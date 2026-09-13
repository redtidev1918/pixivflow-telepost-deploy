# 代理（内置 Mihomo / 外部代理）

> **本页是「国内网络如何为 Pixiv/Telegram 取得出口」的权威说明。** 它取代旧的 `MIHOMO.md`。
> 出口与传输的原理见 [network.md](../concepts/network.md)。

## 先判断：是否真的需要代理

能直连 Pixiv 三数据面（`oauth.secure.pixiv.net`、`app-api.pixiv.net`、`i.pximg.net`）时不需要
代理。**能鉴权不等于出口合格**：反复限流是出口资格问题，代理只解决可达性与出口选择。

## 两种做法

| 做法 | 适用 | 配置 |
| --- | --- | --- |
| 外部代理（推荐） | 已有稳定合规代理 | 设 `HTTP_PROXY_URL` 与 `EGRESS_ALL_PROXY` |
| 内置 Mihomo | 想用订阅 | `SUB_URL` + `--profile proxy` |

### 外部代理

```dotenv
HTTP_PROXY_URL=http://your-proxy:8080
EGRESS_ALL_PROXY=http://your-proxy:8080
```

### 内置 Mihomo

```dotenv
SUB_URL=https://your-subscription-url
HTTP_PROXY_URL=http://proxy:7890
EGRESS_ALL_PROXY=http://proxy:7890
```

```bash
docker compose --profile proxy up -d
```

`proxy` 服务 build `./proxy` 镜像，端口 7890（混合）/9090（控制）**只绑定宿主机回环**，
配置卷 `./proxy-data`，`mem_limit` 默认 `128m`（`PROXY_MEMORY_LIMIT`）。

## 内存现实

Mihomo 占 **50–100 MiB**。整机只有 512 MiB 时：

- **优先外部代理**，或升到 1 GiB；
- 矩阵把 `bundled-proxy-on-256m` 列为 `invalid`：代理本身就要 50–100 MiB。
- 规则量很大的 Mihomo 与执行进程同时跑会互相抢内存，表现为代理 OOM / 下载超时 / Telegram
  请求失败——此时换外部代理或升内存，**不要**靠删缓存/outbox 换表面低占用。

## NO_PROXY 不可省

Compose 已设 `NO_PROXY` / `no_proxy` 含 `127.0.0.1,localhost,telepost,pixivflow,proxy`。
删掉会让执行端到业务端的内部投递绕公网或代理，投递失败。见
[delivery.md](../concepts/delivery.md)。

## 构建期代理

国内机器本地构建镜像时，`BUILD_HTTP_PROXY` / `BUILD_HTTPS_PROXY` 指向宿主机可访问的代理。
**运行中的 Compose 代理不参与 build。**

## 相关页面

- 网络与出口：[network.md](../concepts/network.md)
- Docker 部署：[docker.md](./docker.md)
- 出口限流事故：[incidents/2026-09-11-pixiv-egress-rate-limit.md](../incidents/2026-09-11-pixiv-egress-rate-limit.md)
