# 多 Bot：加第 N 个频道

TelePost 的 supervisor（`run.py`）会**自动发现**所有 `BOT{N}_TOKEN`（N=1,2,3,…），
每个 Bot 各起一个独立进程，各自独立的 Token、频道、审核群、数据目录与 webhook 端口。
所以「加第 3 个 bot」**不需要改任何代码**，只需要加几个环境变量。

---

## 一个 Bot 需要的最小配置

| 环境变量 | 必填 | 说明 |
|---|---|---|
| `BOT{N}_TOKEN` | ✅ | 该 Bot 的 Token（`@BotFather` 创建，且是目标频道管理员） |
| `BOT{N}_CHANNEL_ID` | ✅ | 目标频道（`@频道名` 或 `-100…` 数字 ID） |
| `BOT{N}_OWNER_ID` | 建议 | 所有者 Telegram 用户 ID（`/botconfig`、审核等权限） |
| `BOT{N}_REVIEW_CHAT_ID` | 审核时 | 该 Bot 的审核群 ID（需要审核时填） |
| `BOT{N}_BOT_MODE` | 可选 | `MIXED`（默认）/ 其它模式 |
| `BOT{N}_API_REVIEW_REQUIRED` | 可选 | 是否 API 投稿先审（默认 `true`） |
| `BOT{N}_WEBHOOK_SECRET_TOKEN` | 可选 | 该 Bot 的 webhook secret |

其余可用 `BOT{N}_<KEY>` 覆盖的键见 `TelePost/run.py` 的 `OVERRIDABLE_KEYS`。

每个 Bot 自动获得：
- 独立数据目录 `data/bot{N}/`（`DB_PATH`、`SEARCH_INDEX_DIR` 默认按 bot 隔离）；
- 独立 webhook 端口 `8080+N`、路径 `/webhook/botN`（多 bot webhook 模式由父路由 8080 转发）；
- 独立投稿 Token `TELEPOST_BOT{N}_SUBMIT_TOKEN`（PixivFlow 投递给该 bot 时用，由对应
  Bot 内 `/gen_token` 生成）。

---

## 各后端怎么加

### Docker Compose

在 `.env` 追加（或直接在 `docker-compose.yml` 的 `telepost` 服务 `environment` 里加）：

```bash
BOT3_TOKEN=...
BOT3_CHANNEL_ID=...
BOT3_OWNER_ID=...
BOT3_REVIEW_CHAT_ID=
TELEPOST_BOT3_SUBMIT_TOKEN=...
```

然后 `docker compose up -d`。supervisor 重启后自动起 3 个 bot 子进程。

### Fly.io

用 secrets 注入（不走 `[env]`，避免 Token 进 git）：

```bash
fly secrets set -a your-app \
  BOT3_TOKEN=... BOT3_CHANNEL_ID=... BOT3_OWNER_ID=... \
  TELEPOST_BOT3_SUBMIT_TOKEN=...
fly deploy --strategy rolling   # 重启以让 supervisor 读到新 secret
```

### systemd（Linux 裸机）

编辑 `/opt/telepost/.env` 追加同样的 `BOT3_*` 行，然后
`sudo systemctl restart telepost`。

---

## 让 PixivFlow 投递给新 Bot

1. 在新 Bot 内执行 `/gen_token`，得到 `TELEPOST_BOT3_SUBMIT_TOKEN`。
2. 在 PixivFlow 的 `config.json` 里，给 `delivery.targets` 加一个 `telepost-bot3` 项：

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
          "idempotency_key": "pixiv:bot3:{{type}}:{{pixivId}}"
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

把新 target 加进某个 schedule 的 `targetIds`，或新建一个 schedule。PixivFlow 配置
原子热重载，无需重启。

---

## 上限与注意

- 每个 Bot = 一个 Python 子进程，内存随 Bot 数线性增加。512 MiB 档建议 ≤2 个；
  更多 Bot 需要升内存（≥1 GiB），或拆多机（见 [AUTOSTOP.md](AUTOSTOP.md) 的拓扑 A）。
- 多 bot webhook 模式下，父路由固定占 8080，Bot 子进程占 `8080+N`（仅本机回环可见）；
  Polling 模式无此端口分配，但 PixivFlow 仍可经 `127.0.0.1:8080/api/botN/v1/*` 投递。
- `BOT{N}_TOKEN` 为空即视为「不存在」，supervisor 会跳过它——所以临时下线某频道，
  把对应 `BOT{N}_TOKEN` 清空并重启即可。
