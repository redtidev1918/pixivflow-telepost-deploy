# PixivFlow Ecosystem Media Decoupling Delivery Plan

Status: ACTIVE
Scope: PixivFlow / TelePress / TelePost / Deploy
Goal: 从 Pixiv 图片反代问题逐步演进到完整媒体解耦架构
代码级迁移顺序见 [media-code-evolution-plan.md](../development/media-code-evolution-plan.md)。

---

# 1. 目标

当前历史链路：

```text
Pixiv
→ PixivFlow 解析
→ PixivFlow 下载
→ 本地文件
→ TelePress / TelePost
→ 再次上传
→ Telegram / Telegraph / Catbox
```

最终目标：

```text
Pixiv
→ PixivFlow Work + MediaAsset
→ TelePost / TelePress / Archive 按需消费
```

核心原则：

```text
MediaAsset != Local File
解析媒体 != 必须下载媒体
```

含义：

- 媒体来源由 PixivFlow 解析和记录。
- 是否下载由消费者决定。
- 公开预览（Telegraph）优先使用远程 URL，不复制到 Catbox。
- 本地 TXT/ZIP/Image 仍作为归档能力保留。

---

# 2. 阶段顺序

任何阶段完成前先确认代码事实，不跨阶段一次性重构。

```text
Phase 0  基线确认
Phase 1  Pixiv Media Proxy
Phase 2  TelePress ProxyProvider
Phase 3  PixivFlow Source Manifest
Phase 4  Rich Novel 生产 E2E
Phase 5  正式 MediaAsset 模型
Phase 6  Lazy Materialization
Phase 7  TelePost Telegram 媒体优化
Phase 8  TelePress Preview Platform
Phase 9  删除强制下载依赖
Phase 10 清理旧架构与最终验收
```

---

# 3. Phase 0 — 基线确认

每次开始前必须重新确认，不依赖旧聊天记录：

- 各仓 HEAD、release、Deploy pin、Fly runtime 版本
- 当前 Rich Novel contract
- TelePress `/publish/rich-novel`
- 当前 image host 配置
- 当前 Catbox failure
- PixivFlow Novel metadata / Markdown sidecar / ZIP artifact 行为

特别确认 PixivFlow metadata 是否仍包含：

```text
asset.url
asset.localPath
asset.kind
asset.sourceId
asset.status
```

这是后续 manifest 的来源。

Gate：只有准确知道当前代码和生产实际路径后才能进入 Phase 1。

---

# 4. Phase 1 — Pixiv Media Proxy

目标：Pixiv 图片已经有远程源 URL，不要为了 Telegraph 阅读再复制到 Catbox。

实现位置：`control-plane/pixiv-media-proxy/`

公开接口：

```text
GET /pixiv/<pximg path>
HEAD /pixiv/<pximg path>
```

固定约束：

```text
固定上游 https://i.pximg.net
GET/HEAD only
不接受任意 host
不接受用户自定义 headers
不保存 Pixiv credentials
不允许 path escape
只返回 image response
```

响应只保留必要 headers：

```text
Content-Type
Content-Length
ETag
Last-Modified
Accept-Ranges
Content-Range
```

缓存：Cloudflare edge cache（public + s-maxage + stale-while-revalidate），不引入 R2 / DB / 独立 VPS。

状态：IMPLEMENTED + VERIFIED（worker 已部署、/health=200、TelePress 生产 E2E 返回 status=proxied）。

Gate：

```text
Worker /health → 200
已知 Pixiv 图片 → proxy URL → 200 → Content-Type image/*
任意 URL → 无法被代理
```

---

# 5. Phase 2 — TelePress ProxyProvider

目标：TelePress 不再认为图片必须上传图床。

实现：

- 保留现有 ImageUploader。
- 新增 `TELEPRESS_PIXIV_PROXY_BASE`：匹配 `https://i.pximg.net/...` 的图片改写为 `<base>/pixiv/...`，不匹配或未配置则继续原图床上传。
- `/publish/rich-novel` 支持可选 `manifest`：
  ```json
  [{"local": "images/001.jpg", "source": "https://i.pximg.net/..."}]
  ```
- proxy 成功返回 `status=proxied`，失败可继续走 upload fallback。

状态：IMPLEMENTED + VERIFIED（release v0.11.0、deploy、runtime 验证通过）。

---

# 6. Phase 3 — PixivFlow Source Manifest

目标：PixivFlow 交付 media 事实，TelePress 自行决定 proxy/upload。

实现：

- 复用 Novel metadata 中已有 `url + localPath`。
- 自动生成 manifest 随 multipart 发送给 TelePress。
- V1 仍同时上传图片文件，保证 fallback 不破坏现有 ZIP/下载能力。

状态：IMPLEMENTED + VERIFIED（PixivFlow v2.38.0 release、deploy、相关测试通过）。

---

# 7. Phase 4 — Rich Novel 生产 E2E

目标：证明完整链路可用：

```text
Pixiv 原始媒体 URL → Worker → TelePress → Telegraph → Telegram
```

当前证据：

- TelePress 生产容器内真实 POST `/publish/rich-novel`（manifest + 图片）返回 200。
- 生成 Telegraph 页面 `https://telegra.ph/px-e2e-09-19`，assets 中
  `status=proxied`，remote URL 指向 worker。
- 真实带图 Pixiv 小说的图片有效性仍需 live Pixiv novel + 凭据外部验收。

状态：`EXTERNAL_ACCEPTANCE_REQUIRED`（不声明已闭环）。

Gate（必须全部通过才能进入 MediaAsset 阶段）：

```text
Pixiv 原始媒体 URL → Worker → TelePress → Telegraph → Telegram 真实链路可用
```

在该 Gate 通过前，禁止删除 PixivFlow 图片下载路径。

---

# 8. Phase 5 — 正式 MediaAsset 模型

目标：把 `manifest` 提升为正式领域模型，而不是接口临时字段。

- `MediaAsset` 成为 PixivFlow 的领域实体：描述媒体来源、变体、缓存状态。
- Artifact 与 DeliveryVariant 分离。
- 不删除现有 ZIP/下载能力，先新增模型并接入既有流程。

禁止：

- 创建第二套状态源。
- 一次性重构所有消费者。

---

# 9. Phase 6 — Lazy Materialization

目标：解析媒体不等于下载媒体。

- PixivFlow 解析后记录 MediaAsset 引用。
- 按需触发下载/归档。
- 当前 V1 保留下载路径，后续逐步切换为按需消费。

---

# 10. Phase 7/8 — TelePost / TelePress 媒体消费

TelePost：

- 支持 file_id、copyMessages、proxy URL、DeliveryVariant、local fallback。
- 首次上传后 file_id 复用，避免重复上传。

TelePress Preview Platform：

- 至少一个公共 Preview renderer（Telegraph / Web Reader）。
- 不依赖 Catbox 作为唯一路径。

---

# 11. Phase 9/10 — 删除强制下载依赖与最终验收

- 删除“展示媒体必须先下载”的历史假设。
- 完整回归矩阵覆盖 illustration（single/multi/large/R18）、novel（text/uploadedimage/pixivimage/partial failure/multi inline）、Telegram（file_id 复用/copyMessages/URL/local fallback）、TelePress（proxy/unavailable/upload fallback/Telegraph/Web Reader）。
- 生产 chaos 测试：proxy down、Catbox down、Telegraph down、服务重启、Telegram timeout、ACK loss、duplicate 等，明确每种情况的重试方、是否重复、是否丢数据、operator 看到什么。

---

# 12. Final Definition Of Done

只有全部满足才算真正完工：

- PixivFlow：Work / MediaAsset / Artifact / DeliveryVariant 正式存在，解析媒体不要求下载。
- TelePress：不依赖 Catbox，支持 remote MediaAsset → ProxyProvider，有公共 Preview renderer。
- TelePost：支持 file_id / copyMessages / proxy URL / DeliveryVariant / local fallback。
- Archive：需要原文件时可 materialize TXT/ZIP/image。
- Failure：任何阶段失败都能回答 stage / code / reason / retryable / operator_hint / correlation。
- Production：验证首次发布、重复发布、Rich Novel、multi-image、large image、provider failure、service restart。
- Documentation：未来 Agent 只读仓库文档就能回答“媒体是谁解析的、谁决定下载、谁负责 Telegram、谁负责 Preview、何时 materialize、Proxy 为什么存在、Catbox 是什么角色、旧路径何时 fallback”。

---

# 13. 发布批次

建议按批次推进，不做巨大 PR：

```text
Batch 1  Pixiv proxy Worker            → DONE
Batch 2  TelePress manifest + ProxyProvider → DONE
Batch 3  PixivFlow manifest producer   → DONE
Batch 4  Production Rich Novel E2E     → EXTERNAL_ACCEPTANCE_REQUIRED
Batch 5  MediaAsset canonical model    → PLANNED
Batch 6  Lazy materialization          → PLANNED
Batch 7  TelePost Telegram media cache → PLANNED
Batch 8  copyMessages / URL / variant delivery → PLANNED
Batch 9  TelePress Web Reader          → PLANNED
Batch 10 Remove mandatory-download assumptions → PLANNED
Batch 11 Cross-repo cleanup + full acceptance → PLANNED
```

每个 Batch 都要走：

```text
code → tests → docs → PR → CI → merge → release → deploy → runtime verify → production verify → current-state update
```

---

# 14. Production 验收纪律

- 外部依赖阻塞不得导致整批停止。
- 不为了全绿破坏生产不变量。
- 不创建第二套状态源。
- 完成状态必须用代码、测试、release、deploy、runtime evidence 证明。
- 未通过 Gate 前不提前删除下载路径。
