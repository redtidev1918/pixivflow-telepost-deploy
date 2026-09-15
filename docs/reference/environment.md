# 环境变量与资源档位

> **本页是「环境变量命名、目录命名、资源档位」的唯一权威说明。** 它是部署契约里
> `ResourceProfile` 维度的展开，与 `platform` 维度正交：**架构 = 服务如何分布，资源档位 =
> 每个运行单元给多少资源**，两者可以自由搭配（只要满足矩阵的 `combinationRules`）。
> 机器可读的档位定义见
> [architecture-matrix.json](https://github.com/redtidev1918/pixivflow-telepost-deploy/blob/main/docs/reference/architecture-matrix.json)
> 的 `resourceProfiles`。调优杠杆与症状排查见 [performance.md](../operations/performance.md)。

## 资源档位是独立维度

不要把 `256M` / `512M` / `1G` 写死成架构名称。合法搭配示例：

| 组合 | 含义 |
| --- | --- |
| `single-machine-worker-sleep` + `512m` | 一台 512 MiB 机器，业务常驻、执行进程按需 |
| `split-worker`，`publisher=256m` + `executor=512m` | 业务机很小，执行机给足 |
| `single-host` + `1g` | 一台 1 GiB 机器，双 Bot + 执行端 + 搜索 |

矩阵 `resourceProfiles.note` 明确写着：**任何 preset 都可以和任何满足组合规则的档位搭配。**

## 档位表（矩阵 `resourceProfiles`）

| 档位 | 整机预算 | 默认分配 | 限制 | 适用 |
| --- | --- | --- | --- | --- |
| `256m` | 256 MiB | `publisher: 256m` | 禁用 `executor`、`search`、内置代理；单 Bot | 低配 VPS、NAT 机器、开发 |
| `512m`（默认自托管） | 512 MiB | `publisher: 320m` + `executor: 192m` | `bots<=2`、`search=disabled`、`download.concurrency=1`、无 WebUI | 512 MiB 容器 / VPS |
| `1g` | 1024 MiB | `publisher: 512m` + `executor: 384m` | `bots<=3`、`download.concurrency<=2` | 可开搜索与 WebUI |
| `2g` | 2048 MiB | `publisher: 768m` + `executor: 512m` | `bots<=5` | 更大并发与搜索余量 |

> 单跑执行端时，Fly 上 **512 MiB Machine** 是文档化的基准规格（`fly/deploy.pixivflow.toml`）。

两条非法搭配（矩阵 `combinationRules.invalid`）：`search=enabled` 且同一单元同时跑执行端且
预算 512 MiB；内置代理 + `256m`。

## 命名规范

### 环境变量

| 规则 | 示例 |
| --- | --- |
| Telegram / 业务端按 Bot 编号 | `BOT1_TOKEN`、`BOT2_CHANNEL_ID` |
| 投稿令牌由业务端签发、执行端持有 | `TELEPOST_BOT1_SUBMIT_TOKEN` |
| PixivFlow 配置路径统一前缀 | `PIXIV_DOWNLOADER_CONFIG`、`PIXIV_REFRESH_TOKEN`、`PIXIV_DB_CACHE_KB` |
| 触发端点 | `SCHEDULER_TRIGGER_TOKEN`、`SCHEDULER_TRIGGER_PORT` |
| 投递基址 | `TELEPOST_API_BASE_URL` |
| 资源限额（Compose） | `TELEPOST_MEMORY_LIMIT`、`PIXIVFLOW_MEMORY_LIMIT`、`PROXY_MEMORY_LIMIT` |

### 目录

| 路径 | 用途 | 是否状态 |
| --- | --- | --- |
| `data/bot{N}/` | 每 Bot SQLite、`runtime-policy.json`、搜索索引 | 是 |
| `data/pixivflow/` | `pixivflow.db`、下载缓存、outbox、自托管 `config.json` | 是 |
| `pixivflow/config/*.example.json` | 安全模板（不含凭据值） | 否 |
| `root/`（Compose）/ `/app`（镜像） | 数据挂载点基准 | 否 |
| `./data` → `/app/data` | Compose 与 Fly 的挂载点 | — |

**所有可变路径必须落在卷上，且用相对路径。** 矩阵的部署契约测试
`deployment-contract.test.ts` 会拒绝 `storage` 里的绝对路径——PixivFlow 的加载器会把
`/app/config` 之外的绝对路径重写回自己的默认值（默认下载目录是**临时的** `/app/downloads`）。

## 环境变量参考

### TelePost（业务端）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `TZ` | `Asia/Shanghai` | 时区 |
| `RUN_MODE` | `AUTO` | `WEBHOOK` / `POLLING` / `AUTO`（注册失败回退 polling） |
| `WEBHOOK_URL` | 空 | 公网 HTTPS 根地址；空即 polling |
| `WEBHOOK_DOMAIN` | — | Caddy 证书域名（`--profile webhook`） |
| `WEBHOOK_PORT` / `HEALTH_PORT` | `8080` | 根路由与健康端口 |
| `BOT{N}_TOKEN` | 空 | 第 N 个 Bot 的令牌；空 = 该 Bot 不存在 |
| `BOT{N}_CHANNEL_ID` | 空 | 发布频道 |
| `BOT{N}_OWNER_ID` | 空 | OWNER 权限 |
| `BOT{N}_BOT_MODE` | `MIXED` | Bot 模式 |
| `BOT{N}_API_REVIEW_REQUIRED` | `true` | API 投稿是否先审 |
| `BOT{N}_CHAT_REVIEW_REQUIRED` | `false` | 聊天投稿是否先审 |
| `BOT{N}_REVIEW_CHAT_ID` | 空 | 审核群 |
| `BOT{N}_WEBHOOK_SECRET_TOKEN` | 空 | webhook secret |
| `BOT{N}_CHANNEL_FOOTER_LINK` | 空 | 频道正式发布时在 caption 最下追加「点击投稿」链接（指向该 bot）；空 = 关闭。审核预览不带（TelePost ≥2.23.0） |
| `BOT{N}_CHANNEL_FOOTER_TEXT` | `点击投稿` | footer 链接文本 |
| `TELEPOST_BOT{N}_SUBMIT_TOKEN` | 空 | 执行端投递鉴权令牌 |
| `SEARCH_ENABLED` | `false` | 搜索索引 |
| `SEARCH_ANALYZER` | `simple` | `jieba` 会额外占约 100 MB |
| `DB_CACHE_KB` | `1024` | SQLite 缓存 |
| `MALLOC_ARENA_MAX` | `2` | 防 glibc arena 膨胀 |
| `PENDING_REVIEW_RETENTION_DAYS` | `1` | pending 保留；>2 会超出 Telegram 48h 删除窗口 |
| `PENDING_REVIEW_CLEANUP_BATCH_SIZE` | `20` | 每轮过期清理条数 |
| `MEDIA_GROUP_CAPACITY` | `10` | 频道发布的 media-group 容量 SSOT（Telegram 上限）。11 张 → root 10 + reply 1；21 → 10 + 10 + 1。缺省即可，仅当 Telegram 上限变化时调整（clamp 到 10） |
| `BOT{n}_MINIAPP_SUBMIT_CTA` | `false` | 频道 CTA 直达该 bot 的 Mini App 投稿页（`https://t.me/<bot>?startapp=submit`；startapp 只导航，身份仍由服务器校验 initData 决定）。未启用/链接缺失回退旧 bot 深链，绝不生成坏链接 |
| `NOVEL_PREVIEW_ENABLED` | `false` | TXT 小说通过 TelePress 发布到 Telegraph，频道 caption 增加「🔗 在线阅读」链接（2.31.0）。可选发布增强：TXT document 仍是权威下载产物；Telegraph 失败/超时绝不回滚发布；每个发布幂等一个 Telegraph 页。需配合 `TELEGRAPH_ACCESS_TOKEN` secret；未配置 token/库时特性休眠（不计失败） |
| `NOVEL_PREVIEW_TIMEOUT_SECONDS` | `15` | 读取 TXT + 发布 Telegraph 的严格超时上界；超时按 preview timeout 隔离，发布照常 |
| `NOVEL_PREVIEW_MAX_BYTES` | `4194304` | 预览可读入的最大 TXT 字节（默认 4 MiB）；超限不生成预览，不影响 document 发布 |
| `TELEGRAPH_ACCESS_TOKEN` | （无） | Telegraph 账户 access token，经 `fly secrets set` 注入，绝不写日志/仓库。可用匿名 Telegraph 账户创建；仅 `NOVEL_PREVIEW_ENABLED=true` 时读取 |
| `REVIEW_RETENTION_DAYS` | `30` | 审计记录保留 |
| `REVIEW_PREVIEW_THREAD` | `1` | 多页审核预览是否回复成链 |
| `BIND_ADDRESS` | `127.0.0.1` | 根 API 绑定地址 |

### PixivFlow（执行端）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PIXIV_DOWNLOADER_CONFIG` | `/app/data/pixivflow/config.json` | 运行配置路径 |
| `PIXIV_REFRESH_TOKEN` | 空 | Pixiv 刷新令牌 |
| `TELEPOST_API_BASE_URL` | `http://telepost:8080` | 投递基址 |
| `TELEPOST_BOT{N}_SUBMIT_TOKEN` | 空 | 与业务端同值 |
| `SCHEDULER_TRIGGER_TOKEN` | 空 | 触发端点令牌；未配置则端点 fail-closed |
| `SCHEDULER_TRIGGER_PORT` | `8090` | 触发端口 |
| `NODE_OPTIONS` | `--max-old-space-size=96 --expose-gc` | V8 堆上限 |
| `PIXIV_DB_CACHE_KB` | `4096` | PixivFlow SQLite 缓存 |
| `PIXIV_LOG_LEVEL` | `info` | 日志级别 |

随镜像发布的 `pixivflow/config/production.json`（非 env）中的资源治理配置：

- `pixiv.accountId = "default"`：Pixiv 凭据 profile 的稳定内部标识，是资源治理的
  Resource Identity（`pixiv-account:<accountId>`）；绝不使用 bot/schedule/target 名或凭据本身。
- `schedulerRuntime.resourceGovernance.pixivAccounts["default"].maxConcurrency = 1`：
  同一 Pixiv 账户的并发准入容量。bot1 + bot2 共享该账户 → 所有 Pixiv-consuming work
  （定时 / fallback / manual refetch / 手动恢复）共用同一个 capacity，第一版生产建议 1；
  排队等待是正常状态，不是失败。未来若真实数据证明安全可升为 2，无需改调度架构。

### 网络 / 代理

| 变量 | 说明 |
| --- | --- |
| `HTTP_PROXY_URL` / `HTTPS_PROXY` | 代理地址（`proxy` profile 时为 `http://proxy:7890`） |
| `EGRESS_ALL_PROXY` | `ALL_PROXY` |
| `SUB_URL` | 内置 Mihomo 订阅（仅 `proxy` profile） |
| `NO_PROXY` / `no_proxy` | 必须含内部地址，否则内部投递绕代理 |
| `BUILD_HTTP_PROXY` / `BUILD_HTTPS_PROXY` | 构建期代理 |

### Clock（`control-plane/`）

| 名称 | 位置 | 说明 |
| --- | --- | --- |
| `SCHEDULER_TRIGGER_TOKEN` | Worker secret | 与执行端同值 |
| `PIXIVFLOW_TRIGGER_BASE_URL` | `wrangler.toml` `[vars]` | 执行端公网 HTTPS 基址 |

## 与旧文档的关系

本页取代了 README 中散落的「内存档位建议」表格与 `.env.example` 的口头说明，并把旧 `PERFORMANCE.md` 的档位结论作为**档位维度**统一到
[performance.md](../operations/performance.md)。`.env.example` 仍是可复制的最小模板，但它不再是档位的权威来源。

## 相关页面

- 部署契约：[deployment-contract.md](./deployment-contract.md)
- 性能调优与杠杆：[performance.md](../operations/performance.md)
- 各平台部署：[platforms/docker.md](../platforms/docker.md)、[platforms/vps.md](../platforms/vps.md)、[platforms/flyio.md](../platforms/flyio.md)
- 持久状态与卷布局：[concepts/state.md](../concepts/state.md)
