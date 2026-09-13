# 性能与内存调优

> **本页是「内存与并发怎么调」的权威说明。** 它取代旧的 `PERFORMANCE.md`，并把它重组成
> 两个独立维度：**资源档位正交于部署架构**。档位的机器可读定义见
> [architecture-matrix.json](https://github.com/redtidev1918/pixivflow-telepost-deploy/blob/main/docs/reference/architecture-matrix.json)
> 的 `resourceProfiles`；环境变量命名见 [environment.md](../reference/environment.md)。

**架构 = 服务如何分布；资源档位 = 每个运行单元给多少资源。** 两者自由搭配：

| 组合 | 是否合法 |
| --- | --- |
| `single-machine-worker-sleep` + `512m` | 合法 |
| `split-worker`，`publisher=256m` + `executor=512m` | 合法 |
| `single-host` + `1g` | 合法 |
| `search=enabled` 且同一单元跑 `executor`、预算 512 MiB | **非法**（矩阵 `combinationRules.invalid`） |
| 内置代理 + `256m` | **非法**（代理本身 50–100 MiB） |

---

## 先测量，别盲调

```bash
curl -s http://127.0.0.1:8080/health | python3 -m json.tool   # process_rss / system_available_mb / storage
docker stats --no-stream                                      # 各容器真实 RSS vs mem_limit
# 再定位是 python 还是 node 吃的：
docker exec telepost  ps aux --sort=-rss | head -5
docker exec pixivflow ps aux --sort=-rss | head -5
```

在 Fly 上用 `fly machine list` 看真实机器规格，用 `fly logs` 看运行时 RSS。

> 当前 `fly/deploy.pixivflow.toml` 与 `fly/deploy.telepost.toml` 没有声明 `[vm] memory_mb`，
> 历史文档里的 512 MiB 是设计意图，不是配置文件里的硬约束。核对真实规格用 `fly machine list`。

---

## 基线占用

| 组件 | 基线占用 | 说明 |
| --- | --- | --- |
| Python + TelePost 依赖 | 60–80 MB | python-telegram-bot、aiohttp、aiosqlite |
| Whoosh 搜索（`simple` 分词） | +10–20 MB | 不加载词典 |
| Whoosh 搜索（`jieba` 分词） | +~100 MB | 词典加载后显著增加 |
| SQLite 缓存 | `DB_CACHE_KB` 值 | 默认 1024 KiB |
| Node.js（PixivFlow） | 随任务量变化 | `--max-old-space-size=384` 时上限 384 MB |
| Node.js 运行时开销 | ~30 MB | V8、libuv 等 |
| 内置代理（Mihomo） | 50–100 MB | 取决于规则数量与并发连接 |

每多一个 Bot 就是多一个 Python 子进程，内存约线性增加 60–100 MB。

**拆分后的实测结论：** 双 Bot 的 `publisher` 在 256 MiB 上空闲约 170 MiB、峰值约
200–230 MiB。这正是 `256m` 档只能跑 `publisher`、不能同机跑 `executor` 的原因。

---

## 按影响排序的杠杆

### Python / `publisher` 侧

| 动作 | 可省 | 何时用 |
| --- | --- | --- |
| 关搜索（`SEARCH_ENABLED=false` + `simple` 分词） | ~100 MB | `512m` 及以下必关 |
| Bot 数 2 → 1 | ~60–100 MB | `256m` 档，或峰值在 python 侧 |
| `MALLOC_ARENA_MAX=2` | 防 glibc arena 膨胀 | 默认已加 |
| 缩短 pending 保留、调小相册批 | 减少积压缓冲与消息体 | 审核群积压时 |
| 不开 WebUI | ~150 MB+ | 默认即是 |

### Node / `executor` 侧

| 动作 | 可省 | 何时用 |
| --- | --- | --- |
| `NODE_OPTIONS=--max-old-space-size=96 --expose-gc` | 硬顶 V8 老生代堆 | `512m` 档默认；≥1 GiB 可提到 128–384 |
| `download.concurrency=1` | 同时只下一个作品 | `<=512m` 档 |
| 缓存有界（`cacheRetentionDays` / `cacheMaxSizeMB`） | 磁盘与内存不随缓存膨胀 | 长期运行 |
| 用精简 scheduler 镜像、不开 WebUI | ~150 MB+ | 默认即是 |

### 容器 / 编排

- 两个单元的 `mem_limit` 按整机预算分配：`publisher 320m` + `executor 192m` = 512。
  `TELEPOST_MEMORY_LIMIT` / `PIXIVFLOW_MEMORY_LIMIT` 可调。
- 日志轮转（`10m × 3`）、`pids_limit=256`、`NO_PROXY` 含容器名（内网流量不绕代理）。

---

## 档位

| 档位 | 整机预算 | 默认分配 | 限制 |
| --- | --- | --- | --- |
| `256m` | 256 MiB | `publisher: 256m` | 禁用 `executor`、`search`、内置代理；单 Bot |
| `512m`（默认自托管） | 512 MiB | `publisher: 320m` + `executor: 192m` | `bots<=2`、`search=disabled`、`download.concurrency=1`、无 WebUI |
| `1g` | 1024 MiB | `publisher: 512m` + `executor: 384m` | `bots<=3`、`download.concurrency<=2`；可开搜索与 WebUI |
| `2g` | 2048 MiB | `publisher: 768m` + `executor: 512m` | `bots<=5` |

### 256 MiB 档：只跑 `publisher`

```bash
docker compose up -d telepost
```

```dotenv
TELEPOST_MEMORY_LIMIT=256m
RUN_MODE=POLLING
SEARCH_ENABLED=false
SEARCH_ANALYZER=simple
DB_CACHE_KB=1024
```

`executor` 必须跑在另一台机器上，见 [remote-worker.md](../architectures/remote-worker.md)。

### 512 MiB 档：约束运行

| 资源项 | 值 |
| --- | --- |
| `bots` | 最多 2 |
| 搜索 | **必须关闭**（`SEARCH_ENABLED=false`、`SEARCH_ANALYZER=simple`） |
| SQLite 缓存 | `DB_CACHE_KB=1024` |
| `download.concurrency` | **1** |
| PixivFlow V8 堆 | `NODE_OPTIONS=--max-old-space-size=96 --expose-gc` |
| PixivFlow SQLite 缓存 | `PIXIV_DB_CACHE_KB=4096` |
| 内存分配器 | `MALLOC_ARENA_MAX=2` |
| 缓存 | `cacheRetentionDays=7`、`cacheMaxSizeMB=384` |
| WebUI | **不启动** |
| `jieba` 分词 | **不安装、不启用** |

PixivFlow 配置模板需要调整的部分：

```json
{
  "download": { "concurrency": 1, "requestDelay": 1000 },
  "storage": { "cacheRetentionDays": 7, "cacheMaxSizeMB": 384 }
}
```

多个计划即使同一时刻触发也会经全局串行队列逐个执行；要错开审核群消息可以配置不同 cron。

### 1 GiB / 2 GiB 档

搜索与 WebUI 在这个档位才成立。`download.concurrency` 可提到 2–3（1 GiB）或更高（2 GiB）。
`bot` 数上限分别是 3 和 5。

---

## 监控

```bash
curl -s https://<your-host>/health | python3 -m json.tool
```

返回的 `process_rss`、`system_available_mb`、`pixivflow_cache`、`delivery_outbox`、
`review_queue`、`volume` 分别反映内存、缓存、待投递、待审核积压与持久卷压力。
完整字段含义见 [monitoring.md](monitoring.md)。

---

## 按症状排查

| 症状 | 先查 | 应对 |
| --- | --- | --- |
| `process_rss` 逼近 `mem_limit` | `docker stats --no-stream` 看哪个单元 | python 峰值 → 砍 Bot / 关搜索；node 峰值 → 降 heap 或并发 |
| OOM Kill（exit 137） | `docker inspect` / `dmesg` | **先升档位**（512 → 1 GiB）；**不要**删 outbox 换表面稳定 |
| 审核积压涨内存 | `/health` 的 `review_queue` | 缩短 `PENDING_REVIEW_RETENTION_DAYS` / 手动清 pending |
| 下载缓存占满卷 | `/health` 的 `volume` 与 `delivery_outbox` | 检查 `cacheRetentionDays`/`cacheMaxSizeMB`；outbox 先看 manifest `kind` 再处理 |
| `executor` 用满内存 | `fly logs` 的 RSS | 降 `download.concurrency`、降 `--max-old-space-size` |

更完整的症状表（含网络、webhook、限流类）见 [troubleshooting.md](troubleshooting.md)。

---

## 两条硬规则

```text
✗ 不要用减少重试或删除 outbox 换取表面稳定
    → outbox 里的作品只在那里存在，删掉等于永久丢作品
✗ 不要删掉仍被 outbox 引用的缓存文件
    → 任何清理工具都必须先确认引用关系
```

内存不够的正确顺序：**降并发 → 砍 Bot / 关搜索 → 升档位**。
正确性永远优先于内存。
