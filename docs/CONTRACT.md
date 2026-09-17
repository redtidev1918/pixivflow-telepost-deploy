# PixivFlow ↔ TelePost 跨仓库契约（Authority Schema）

> 本文档是本 HTTP 边界的 **单一权威来源（single source of truth）**。
> PixivFlow（TypeScript，执行平面）与 TelePost（Python，业务平面）之间经由 HTTP 通信。
> **任何新增/修改这些 payload 形状的变更（含 RFC 1 富媒体、RFC 2 管理员可见性新增字段）必须先更新本文档，再改两边代码。**

当前版本内容来自两侧真实代码现状核对：
- ├ PixivFlow（`src/delivery/HttpMultipartDelivery.ts`、`src/delivery/types.ts`、`src/delivery/DeliveryAck.ts`、`src/notification/NotificationPolicy.ts`）
- └ TelePost（`utils/api_server.py`、`telepost/storage/sqlite/refetch.py`）

不相干于语言绑定的 SDK：两边语言不同，不生成跨语言代码；文档先于实现，CI 不引入新依赖。

---

## 目录

1. 投稿 multipart 请求（PixivFlow → TelePost）
2. 投稿响应（TelePost → PixivFlow）
3. Refetch 终态 outcome（PixivFlow → TelePost）
4. Schedule outcome（PixivFlow → TelePost）
5. 变更纪律（review checklist）

---

## 1. 投稿 multipart 请求（`POST /api/v1/submissions`）

### 固定文件字段

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `files` | 可重复 multipart file part | 是 | 投稿媒体（一个作品的文件集）。TelePost 校验至少 1 个、最多 `MAX_FILES`。 |
| `previews` | 可重复 multipart file part | 否 | 每文件对应的轻量预览；**必须与 `files` 一一对应，或整体省略**，否则 TelePost 返回 `invalid_previews`。 |

PixivFlow 默认 multipart 字段名即 `files` / `previews`（可经 operator 配置 `fileField` / `previewFileField` 修改）。

### 其余字段：可配置，非固定契约

`files`/`previews` 之外的所有 form part 对 TelePost 而言都是普通文本字段（`tags`、`title`、`note`、`link`、`spoiler`、`anonymous`、`idempotency_key`、`target_id`、`work_type`、`pixiv_id`、`source_label`、`refetch_request_id` 等）。这些字段的内容完全取决于 PixivFlow 侧 operator 配置的模板，**不属于本契约固定的 schema**。

本契约只固定：字段如何被归并（媒体 vs 文本字段）、改名/新增字段的时序（先改本文档再改代码）。

---

## 2. 投稿响应（TelePost → PixivFlow）

```jsonc
{
  "ok": true,   // 业务成功标志：accepted / idempotent_replay / duplicate_existing
  "data": {
    "status": "published | pending_review | pending | failed | rejected | invalid | expired | ...",
    "review_id": 123,          // 审核/记录 id（string 化后即下游稳定 id）
    "reused": false,           // true = 复用已有记录（重放或历史去重）
    "business_status": "accepted | idempotent_replay | duplicate_existing | retryable_failure | permanent_failure",
    // 复用路径（reused=true 时出现）：
    "reuse_reason": "idempotent_replay | duplicate_existing | historical | historical_duplicate",
    "matched_idempotency_key": "pixivflow:<...>",
    // 媒体记录 id 的另一种存在形态（review_id 缺失时取用）：
    "message_id": 456
  }
}
```

### PixivFlow 读取规则（`DeliveryAck`）

- HTTP 429 / 408 / ≥500 → `retryable_failure`
- 其他非 2xx → `permanent_failure`
- 2xx 且有 `data.status ∈ {failed, rejected, invalid, expired}` → `remote_failed`（**终态失败，不重试**）
- `data.reused == true`：
  - `reuse_reason ∈ {duplicate_existing, historical, historical_duplicate}` → `duplicate_existing`（历史去重，新记录未创建）
  - 否则 → `idempotent_replay`（同一 idempotency_key 的重放，视为成功收敛）
- `reused == false` → `accepted`
- 无 `data` 的裸 2xx → `accepted`（at-most-once 兼容模式）

> 注意：HTTP 200 不代表业务成功；`data.status` 本身携带终态失败语义。

---

## 3. Refetch 终态 outcome（PixivFlow → TelePost，`refetchOutcomeUrl`）

```jsonc
{
  "request_id": "uuid",                  // 必填，遥测/槽位身份
  "disposition": "no_alternative" | "failed",   // 必填
  "reason": "业务说明（可选）",
  "work_id": "artwork-id",              // 可选；no_alternative 且原候选为 duplicate 时携带
  "scanned": 3,                          // 可选；扫描尝试数
  "skipped": {                          // 注意：嵌套对象，不是扁平字段
    "total": 1,
    "duplicate": 0,
    "invalid": 1,
    "unavailable": 0
  }
}
```

- `skipped` 的四个计数均由 PixivFlow `scanCounts()` 产生：`duplicate / invalid / unavailable / total`。
- TelePost `refetch_outcome` 把 `skipped` 展开为 `skipped_duplicate / skipped_invalid / skipped_unavailable` 后交给 `RefetchRepository.apply_outcome()`；`skipped` 缺失时按全 0 处理。
- 校验：`request_id` 必填；`disposition` 只能为 `no_alternative` 或 `failed`；未知 `request_id` → 404 `unknown_attempt`；源审核已被处理 → `obsolete`（不覆盖审核决定）。
- 幂等：同一终态 verdict 重放返回 `replayed: true`，不重复通知。

---

## 4. Schedule outcome（PixivFlow → TelePost，`scheduleOutcomeUrl`）

```jsonc
{
  "schedule_id": "bot1-daily",
  "slot_id": "bot1-daily@2026-09-17T1000",   // 必填；TelePost 以 slot_id 幂等去重
  "status": "success" | "partial" | "failed", // 必填，三选一
  "recovery": {                               // 可选；手动恢复模式
    "mode": "normal" | "relaxed",
    "requestId": "uuid"                      // 注意：发送端字段名是 camelCase requestId
  },
  "targets": [
    {
      "target_id": "bot1-illust",
      "work_type": "illustration | novel",
      "status": "submitted | no_candidate | duplicate | failed | delivery_pending | ...",
      "work_id": "29118637|null",
      "error": "原始错误（请求级可观测性，非用户安全文案）| null",
      "terminal_reason_code": "download_failed|null",   // §terminal-reason 归一化
      "reason": "面向用户的业务原因 | null",
      "stage": "acquisition | download | delivery | execution | configuration | null",
      "retryable": true | false | null,
      "operator_hint": "运维提示 | null"
    }
  ]
}
```

- TelePost 校验：`schedule_id` / `slot_id` 必填；`status ∈ {success, partial, failed}`；`targets` 必须为数组；`recovery` 若出现必须为对象。
- TelePost 以 `slot_id` 为幂等键，重复送达→ `replayed: true`，不重复发群摘要。
- `targets[].stage / retryable / operator_hint`（RFC 2 富化字段）在 TelePost 侧用于渲染**运维提示/失败原因**；不认识的新字段应透传，不阻止处理。
- `recovery.requestId` 是发送端实际字段名（camelCase），写入本文档以便两边核对，**不要按惯例改写成 `request_id`**。

---

## 5. 变更纪律（review checklist）

任何改动这两个方向的 payload 形状（包括 RFC 1 新增富媒体相关字段、RFC 2 新增通知相关字段）：

1. **先**在此文档新增/修改对应小节与示例；
2. **再**同步修改 PixivFlow 发送端与 TelePost 接收端；
3. PR 描述里引用本文档相关小节；
4. 保持"发送端字段名 = 文档字段名 = 接收端读取字段名"三处一致；不一致即为契约 drift，需要显式说明并更新文档。

---
*本文档是权威 schema，不替代各层实现。与实现不一致时，以本文档为准并修正实现（除非「已在文中标注的兼容降级路径」，如 §2 的裸 2xx）。*
