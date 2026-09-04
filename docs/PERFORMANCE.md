# 性能与内存调优

本套件在不同内存规格的机器上有不同的最佳配置。以下指南帮助你在部署前
评估资源需求，并根据实际内存调整配置。

---

## 内存优化速查

### 先测量，别盲调

```bash
curl -s http://127.0.0.1:8080/health | python3 -m json.tool   # process_rss / system_available_mb / storage
docker stats --no-stream                                      # 各容器真实 RSS vs mem_limit
# 再定位是 python 还是 node 吃的：
docker exec telepost  ps aux --sort=-rss | head -5
docker exec pixivflow ps aux --sort=-rss | head -5
```

### 按影响排序的杠杆

**Python / TelePost 侧**

| 动作 | 可省 | 何时用 |
|---|---|---|
| 关搜索（`SEARCH_ENABLED=false` + `simple` 分词） | ~100 MB（jieba 词典 + 索引） | ≤512 档必关 |
| Bot 数量 2 → 1 | ~60–100 MB（每个 bot 一个 python 进程） | 256 档 / 峰值在 python |
| `MALLOC_ARENA_MAX=2`（telepost 容器） | 防 glibc arena 膨胀 | 默认已加 |
| 缩短 pending 保留、调小相册批 | 减少积压缓冲与消息体 | 审核群积压时 |

**Node / PixivFlow 侧**

| 动作 | 可省 | 何时用 |
|---|---|---|
| `NODE_OPTIONS=--max-old-space-size=96 --expose-gc` | 硬顶 V8 老生代堆 | 512 档默认；≥1 GiB 可提到 128 |
| `download.concurrency=1` | 同时只下一个作品 | ≤512 档 |
| 缓存有界（`cacheRetentionDays` / `cacheMaxSizeMB`） | 磁盘与内存不随缓存膨胀 | 长期运行 |
| 用精简 scheduler 镜像、不开 WebUI | ~150 MB+（前端/Chromium） | 默认即是 |

**容器 / 编排**

- 两容器 `mem_limit` 按整机预算分配：telepost `320m` + pixivflow `192m` = 512
  （`TELEPOST_MEMORY_LIMIT` / `PIXIVFLOW_MEMORY_LIMIT` 可调；256 档只跑 telepost）。
- 日志轮转（`10m × 3`）、`pids_limit=256`、`NO_PROXY` 含容器名（流量不绕代理）。

### 按症状排查

| 症状 | 先查 | 应对 |
|---|---|---|
| `/health` 的 `process_rss` 逼近 mem_limit | `docker stats` 看哪个容器 | python 峰值 → 砍 Bot/关搜索；node 峰值 → 降 heap 或并发 |
| OOM Kill（exit 137） | `docker inspect` / `dmesg` | 先按档位升内存（512→1 GiB）；**不要**删 outbox 换表面稳定 |
| 审核积压涨内存 | `/health` 的 `review_queue` | 缩短 `PENDING_REVIEW_RETENTION_DAYS` / 手动清 pending |
| 下载缓存占满卷 | `delivery_outbox` + `volume` | 检查 `cacheRetentionDays`/`cacheMaxSizeMB`，outbox 看 `kind` 再处理 |

详细档位配置见下文的 256 MB / 512 MB / 1 GiB 三节与 `.env.example`。

---

## 256 MB 档：单 Bot

**适用场景**：低配 VPS、NAT 机器、开发测试

| 资源项 | 建议值 |
|--------|--------|
| 内存 | 256 MB 可用 |
| Bot 数量 | 1 个 |
| 搜索 | 关闭（`SEARCH_ENABLED=false`） |
| 分词器 | `simple` |
| SQLite 缓存 | `DB_CACHE_KB=1024` |
| PixivFlow | 不启用（内存不足） |

### 配置

```bash
# .env
BOT1_TOKEN=...
BOT1_CHANNEL_ID=...
RUN_MODE=POLLING
SEARCH_ENABLED=false
SEARCH_ANALYZER=simple
DB_CACHE_KB=1024
PIXIVFLOW_ENABLED=false
```

---

## 512 MB 档：约束运行

**适用场景**：512 MiB 容器、低配 VPS、Fly.io 等受限环境

**这是需严格约束资源的运行档**，必须遵守以下限制：

> Compose 解耦后 telepost 与 pixivflow 是两个独立容器：整机 512 预算默认分配
> telepost `320m` + pixivflow `192m`（`.env` 的 `TELEPOST_MEMORY_LIMIT` /
> `PIXIVFLOW_MEMORY_LIMIT`，合计 ≤512m）。256 档（单 Bot 不跑 PixivFlow）只启
> telepost：`docker compose up -d telepost` 并把其限制调为 256m。

| 资源项 | 建议值 |
|--------|--------|
| 内存 | 512 MiB 可用 |
| Bot 数量 | 最多 2 个 |
| 搜索 | **必须关闭**（`SEARCH_ENABLED=false`） |
| 分词器 | `simple`（`jieba` 会额外占用 ~100 MB） |
| SQLite 缓存 | `DB_CACHE_KB=1024` |
| PixivFlow 下载并发 | **`download.concurrency=1`** |
| PixivFlow V8 堆 | `NODE_OPTIONS=--max-old-space-size=96 --expose-gc` |
| PixivFlow SQLite 缓存 | `PIXIV_DB_CACHE_KB=4096` |
| V8 内存分配器 | `MALLOC_ARENA_MAX=2` |
| Cron 计划 | 可同一时刻触发；调度器会串行排队 |
| 并发计划 | 内置串行 admission，不会重叠执行 |
| 下载缓存 | 保留 7 天，容量硬上限 384 MiB |
| WebUI | **不启动** |
| `jieba` 分词 | **不安装、不启用** |

### 配置

```bash
# .env
BOT1_TOKEN=...
BOT1_CHANNEL_ID=...
BOT1_OWNER_ID=...
BOT2_TOKEN=...
BOT2_CHANNEL_ID=...
BOT2_OWNER_ID=...
RUN_MODE=WEBHOOK
WEBHOOK_URL=https://your-app.fly.dev
SEARCH_ENABLED=false
SEARCH_ANALYZER=simple
DB_CACHE_KB=1024
PIXIVFLOW_ENABLED=true
PIXIV_REFRESH_TOKEN=...
PIXIV_DB_CACHE_KB=4096
PIXIV_LOG_LEVEL=info
```

PixivFlow 配置模板中需要调整：

```json
{
  "download": {
    "concurrency": 1,
    "requestDelay": 1000
  },
  "storage": {
    "cacheRetentionDays": 7,
    "cacheMaxSizeMB": 384
  }
}
```

多计划即使同一时刻触发也会通过全局串行队列逐个执行；如希望错开审核群消息，仍可
配置不同 Cron：

```json
{
  "schedules": [
    {
      "id": "bot1-daily",
      "cron": "10 5 * * *",
      "targetIds": ["bot1-illust", "bot1-novel"]
    },
    {
      "id": "bot2-daily",
      "cron": "30 5 * * *",
      "targetIds": ["bot2-illust", "bot2-novel"]
    }
  ]
}
```

### 监控

部署后通过 `/health` 端点监控内存使用：

```bash
curl https://your-app.fly.dev/health
```

返回的 `process_rss`、`system_available_mb`、`pixivflow_cache`、`delivery_outbox`、
`review_queue` 与 `volume` 字段分别反映内存、待审核积压和持久卷压力。512 MiB 档默认
让 pending 保留 1 天、每轮最多过期 20 条；原始投稿文件进入审核群后即从本机删除。
`delivery_outbox` 计数同时包含媒体投递和不携媒体的无候选通知；诊断时应查看
清单内的 `kind`，不要一见 outbox 数增加就删除缓存。
如果出现 OOM，应先将 Machine 升级至 1 GiB，**不要**用减少重试或删除 outbox
换取表面稳定。

---

## 1 GiB 档：宽松运行

**适用场景**：高配 VPS、充裕内存环境

| 资源项 | 建议值 |
|--------|--------|
| 内存 | 1 GiB 以上 |
| Bot 数量 | 2~3 个 |
| 搜索 | 可启用（`SEARCH_ENABLED=true`） |
| 分词器 | 可启用 `jieba` |
| PixivFlow 下载并发 | 可调至 2~3 |
| WebUI | 可启用 |

---

## 资源参考

| 组件 | 基线占用 | 说明 |
|------|---------|------|
| Python + TelePost 依赖 | 60-80 MB | 含 python-telegram-bot、aiohttp、aiosqlite |
| Whoosh 搜索（simple 分词） | +10-20 MB | 默认不加载词典 |
| Whoosh 搜索（jieba 分词） | +~100 MB | 词典加载后显著增加 |
| SQLite 缓存 | `DB_CACHE_KB` 值 | 默认 1024 KiB = 1 MB |
| Node.js (PixivFlow) | 随任务量变化 | V8 堆限制 `--max-old-space-size=128` 时约 128 MB |
| Node.js 额外开销 | ~30 MB | V8、libuv 等运行时开销 |
| Mihomo 代理 | 50-100 MB | 取决于规则数量和并发连接 |

> 实际内存占用受下载并发数、搜索索引大小、Bot 消息量等因素影响，
> 上表为基准估算值，建议在部署后进行实际监控调优。
