# 性能与内存调优

本套件在不同内存规格的机器上有不同的最佳配置。以下指南帮助你在部署前
评估资源需求，并根据实际内存调整配置。

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

| 资源项 | 建议值 |
|--------|--------|
| 内存 | 512 MiB 可用 |
| Bot 数量 | 最多 2 个 |
| 搜索 | **必须关闭**（`SEARCH_ENABLED=false`） |
| 分词器 | `simple`（`jieba` 会额外占用 ~100 MB） |
| SQLite 缓存 | `DB_CACHE_KB=1024` |
| PixivFlow 下载并发 | **`download.concurrency=1`** |
| PixivFlow V8 堆 | `NODE_OPTIONS=--max-old-space-size=128` |
| PixivFlow SQLite 缓存 | `PIXIV_DB_CACHE_KB=4096` |
| V8 内存分配器 | `MALLOC_ARENA_MAX=2` |
| Cron 计划 | **两个计划至少错开 15~20 分钟** |
| 并发计划 | 不允许同时运行多个计划 |
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
  }
}
```

两个 Cron 计划至少错开 15-20 分钟，避免同时触发下载导致 OOM：

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

返回的 `process_rss` 和 `system_available_mb` 字段反映实际内存压力。
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