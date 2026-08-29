# 国内网络与 Mihomo

优先使用你已有的稳定、合规代理；此仓库只提供可选运行容器，不提供节点或订阅。

内置 Mihomo 配置：

```dotenv
SUB_URL=https://example.invalid/subscription
HTTP_PROXY_URL=http://proxy:7890
EGRESS_ALL_PROXY=http://proxy:7890
```

```bash
docker compose --profile proxy up -d
docker compose logs -f proxy stack
```

7890 与 9090 只绑定宿主机回环地址。`NO_PROXY` 已包含 `127.0.0.1`、`stack`、
`proxy`，PixivFlow 到 TelePost 的投稿不会绕公网或代理。

国内机器首次本地构建镜像时，运行中的 Compose 代理尚不能参与 build。可先启动
Mihomo，再把 `.env` 中 `BUILD_HTTP_PROXY` / `BUILD_HTTPS_PROXY` 指向宿主机可访问
的代理地址；或者在可联网机器/CI 构建并推送镜像后只执行 `docker compose pull`。

512 MiB 整机不建议同时运行规则量很大的 Mihomo。代理频繁 OOM、Pixiv 下载超时
或 Telegram 请求失败时，应改用外部代理或升到 1 GiB。
