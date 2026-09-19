# 多 Bot：加第 N 个频道

> **本页是「运行时增加或减少一个频道 Bot」的权威说明。** 它取代旧的 `MULTI-BOT.md`，
> 并加上 preset 维度：同一件事在四个 preset 下的操作不同。
> Bot 的模型与职责归属见 [roles.md](../concepts/roles.md) 的 `publisher` 一节。

`publisher` 的 supervisor 会**自动发现**所有 `BOT{N}_TOKEN`（N=1,2,3,…），
每个 Bot 各起一个独立进程，各自独立的 Token、频道、审核群、数据目录与 webhook 端口。
所以「加第 3 个 bot」**不需要改任何代码**，只需要加几个环境变量。

---

## 一个 Bot 需要的最小配置

| 环境变量 | 必填 | 说明 |
| --- | --- | --- |
| `BOT{N}_TOKEN` | 是 | 该 Bot 的 Token（`@BotFather` 创建，且是目标频道管理员） |
| `BOT{N}_CHANNEL_ID` | 是 | 目标频道（`@频道名` 或 `-100…`） |
| `BOT{N}_OWNER_ID` | 建议 | 所有者 Telegram 用户 ID（`/botconfig`、审核权限） |
| `BOT{N}_REVIEW_CHAT_ID` | 需要审核时 | 该 Bot 的审核群 ID |
| `BOT{N}_BOT_MODE` | 可选 | `MIXED`（默认） |
| `BOT{N}_API_REVIEW_REQUIRED` | 可选 | API 投稿是否先进审核（默认 `true`） |
| `BOT{N}_CHAT_REVIEW_REQUIRED` | 可选 | 聊天投稿是否先进审核（默认 `false`） |
| `BOT{N}_WEBHOOK_SECRET_TOKEN` | 可选 | 该 Bot 的 webhook secret |
| `TELEPOST_BOT{N}_SUBMIT_TOKEN` | `executor` 投递时需要 | 由该 Bot 内 `/gen_token` 生成 |

其余可按 `BOT{N}_<KEY>` 覆盖的键见 TelePost 仓库的 `run.py` 中 `OVERRIDABLE_KEYS`。

### 每个 Bot 自动获得

| 资源 | 值 |
| --- | --- |
| 独立数据目录 | `data/bot{N}/`（`DB_PATH`、`SEARCH_INDEX_DIR` 按 bot 隔离） |
| 独立 webhook 端口 | `8080+N`（仅回环可见）；公网路径 `/webhook/botN` |
| 独立投稿 Token | `TELEPOST_BOT{N}_SUBMIT_TOKEN` |
| 独立运行策略 | `data/bot{N}/runtime-policy.json` |

---

## 各 preset 怎么加

### `single-host` / `single-machine-worker-sleep`（Compose）

在 `.env` 追加：

```dotenv
BOT3_TOKEN=...
BOT3_CHANNEL_ID=...
BOT3_OWNER_ID=...
BOT3_REVIEW_CHAT_ID=
TELEPOST_BOT3_SUBMIT_TOKEN=...
```

```bash
docker compose up -d
```

supervisor 重启后自动起 3 个 Bot 子进程。

### `split-worker`（Fly）

用 secret 注入，不走 `[env]`（避免 Token 进 Git）：

```bash
fly secrets set -a <telepost-app> \
  BOT3_TOKEN=... BOT3_CHANNEL_ID=... BOT3_OWNER_ID=... \
  TELEPOST_BOT3_SUBMIT_TOKEN=...
fly deploy -c fly/deploy.telepost.toml --strategy rolling
```

只有 `publisher` 那一台机器需要重启。**不要**动 `executor` 的机器。

### `remote-worker`（systemd）

编辑 `service-host` 上的 `/opt/telepost/.env` 追加同样的 `BOT3_*` 行，然后：

```bash
sudo systemctl restart telepost
```

`executor-host` 不需要重启。

---

## 让 `executor` 投递给新 Bot

1. 在新 Bot 内执行 `/gen_token`，得到 `TELEPOST_BOT3_SUBMIT_TOKEN`。
2. 在 PixivFlow 配置里给 `delivery.targets` 加一个 `telepost-bot3`：

```json
{
  "delivery": {
    "targets": {
      "telepost-bot3": {
        "type": "httpMultipart",
        "url": "${TELEPOST_API_BASE_URL}/api/bot3/v1/submissions",
        "notificationUrl": "${TELEPOST_API_BASE_URL}/api/bot3/v1/notifications",
        "headers": { "Authorization": "Bearer ${TELEPOST_BOT3_SUBMIT_TOKEN}" },
        "fileField": "files",
        "fields": {
          "title": "{{title}}",
          "tags": ["Pixiv", "{{tag}}", "{{workTags}}"],
          "note": "Pixiv ID: {{pixivId}}",
          "target_id": "{{targetId}}",
          "anonymous": true,
          "idempotency_key": "{{idempotencyKey}}"
        },
        "success": { "statuses": [201], "jsonPath": "ok", "equals": true },
        "maxAttempts": 3,
        "retryDelayMs": 3000
      }
    }
  },
  "targets": [
    {
      "id": "bot3-illust",
      "type": "illustration",
      "mode": "ranking",
      "rankingMode": "day",
      "rankingDate": "YESTERDAY",
      "filterTag": "你的标签",
      "limit": 1,
      "storageMode": "cache",
      "delivery": { "target": "telepost-bot3" }
    }
  ]
}
```

3. 把新 target 加进某个 schedule 的 `targetIds`，或新建一个 schedule。

配置的生效方式**随 preset 不同**：`single-host` / `remote-worker` 下热重载（改文件即可）；
`split-worker` 下执行端配置运行副本在卷上
（`/app/data/production.json`，`watchConfig=true`），编辑即可热重载；镜像内置默认值变更仍需发布新
镜像。见 [upgrades.md](upgrades.md)。

---

## 上限与注意

| 限制 | 值 |
| --- | --- |
| 内存 | 每个 Bot 一个 Python 进程，约 60–100 MB，**线性增长** |
| `256m` 档 | 最多 1 个 Bot，且不跑 `executor` |
| `512m` 档 | 最多 2 个 Bot |
| `1g` 档 | 最多 3 个 |
| `2g` 档 | 最多 5 个 |
| Webhook 端口 | 父路由固定占 8080，子进程占 `8080+N`（仅回环）；Polling 模式无此分配 |

超过档位上限的正确做法是升档位，或把 `executor` 拆到另一台机器
（见 [remote-worker.md](../architectures/remote-worker.md)），**不是**减少重试或删 outbox。

### 临时下线一个 Bot

把对应的 `BOT{N}_TOKEN` 清空并重启 `publisher` 即可——空 Token 视为「不存在」，
supervisor 会跳过它。该 Bot 的数据目录与运行策略保留，重新填回 Token 即可恢复。

### 换频道 / 换审核群

处理旧审核群中的 pending 投稿 → 把 Bot 加到新频道并授予发帖权限 → 用 `/botconfig` 或策略脚本
更新 → 检查 `/health` 与一条新频道测试投稿。存在 pending 时切频道或审核群会被拒绝。
完整顺序见 [upgrades.md](upgrades.md)。
