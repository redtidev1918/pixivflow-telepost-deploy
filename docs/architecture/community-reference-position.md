# Media Architecture Community Reference Position

Status: ACTIVE
Scope: PixivFlow / TelePost / TelePress / Deploy
Type: Community research / ADR-style record

---

# 1. 为什么存在本文

媒体解耦架构（`Work / MediaAsset / Artifact / DeliveryVariant`）由成熟模式组合而来。

底层技术不是新发明：

```text
解析与下载分离   → gallery-dl / yt-dlp
source/derivative → Immich
Pixiv 图片反代     → Pixiv.Cat / pximg proxy
Preview Gateway   → FxEmbed / FxTwitter
file_id 缓存复用  → Telegram media bots
```

组合层（Candidate/Slot/Recovery/Telegram 业务/公开预览/运营控制面）没有发现成熟开源项目可直接替代。

原则：底层尽量不创新，边界与组合方式创新。

---

# 2. 参考映射

| 设计方向 | 社区成熟度 | 最值得参考项目 |
| --- | --- | --- |
| Pixiv 内容解析与媒体描述 | 很成熟 | gallery-dl、yt-dlp |
| 解析和实际下载分离 | 很成熟 | yt-dlp |
| MediaAsset 与派生文件分离 | 很成熟 | Immich |
| Pixiv 图片反代 | 很成熟 | Pixiv.Cat、pximg proxy |
| Preview Gateway / 链接增强 | 很成熟 | FxEmbed / FxTwitter |
| Telegram `file_id` 缓存重用 | 成熟模式 | 多种 Telegram media bot |
| Lazy Materialization | 成熟架构思想 | 媒体管理/CDN/数据管线常见 |
| Candidate Inventory + Topic Supply | Pixiv 场景少见 | 推荐系统、feed ingestion |
| Slot Ledger + Recovery + Candidate + Delivery 整体 | 较少见 | 无一一对应项目 |
| PixivFlow + TelePost + TelePress 三平面组合 | 比较有辨识度 | 未找到成熟等价物 |

---

# 3. 学习要点

## yt-dlp

extractor 成功提取时，核心结果是媒体 ID、URL/formats 和 metadata 的 info dict，metadata 允许缺失；下载与后处理发生在后续阶段。

对应我们的链路：

```text
Pixiv
→ resolveWork()
→ Work + MediaAsset[]
→ consumer decides
→ materialize() 可选
```

## gallery-dl

以各网站 extractor 为核心：extractor 负责理解网站结构并定位媒体，再通过消息机制交给下载引擎。

PixivFlow 借鉴 source/extractor 架构，而不是直接复制下载器。

## Immich

明确区分 original asset 与 generated content（缩略图/转码），派生内容可重新生成。

对应模型：

```text
MediaAsset
   ↓
Artifact
   ├─ original
   ├─ telegram-photo
   ├─ preview
   └─ zip
```

## Pixiv.Cat / pximg proxy

反代属于成熟基础设施：

```text
i.pximg.net
→ Cloudflare Worker
→ Referer rewrite
→ edge cache
```

不需要自己“创新”。

## FxEmbed

把上游内容规范化后再呈现为平台友好的公开网页/媒体链接（gallery、Telegram Instant View 等）。

TelePress 的目标是把这个思想泛化：

```text
Source content
→ normalize
→ media resolution
→ platform-friendly public representation
```

## Telegram media bots

`file_id` / 消息复用是成熟做法：保存 file_id 缓存，重复 URL 直接重发，不重新下载上传。

TelePost 在此之上还要叠加 Review/Publication/Delivery/Audit/fallback。

---

# 4. 本项目真正的差异化

```text
PixivFlow
Parsing / Execution
         │
 Work + MediaAsset
         │
  ┌──────┴──────┐
  │             │
TelePost      TelePress
Telegram      Public Preview
  │             │
 file_id      proxy/render
  │             │
Telegram      Public Web

+
Candidate Inventory
Slot Ledger
Recovery
Operational Result
Admin / Review / Moderation
```

组合了内容供应、自动执行、媒体解析、按需物化、Telegram 业务、公开预览、失败恢复、运营控制面。单项都很成熟，但整体组合具有较强的辨识度。

---

# 5. 定位建议

如果追求社区价值，合理定位不是“高级 Pixiv 下载器”，而是：

> 一个 descriptor-first、lazy-materialization 的 Pixiv 内容解析与自动化执行平台。

这与当前代码演进路线一致（file-first → MediaAsset-first）。

---

# 6. External References

- yt-dlp: <https://github.com/yt-dlp/yt-dlp>
- gallery-dl extractor wiki: <https://github.com/mikf/gallery-dl/wiki/Developing-Extractors>
- Immich: <https://github.com/immich-app/immich>
- Pixiv.Cat: <https://github.com/pixiv-cat>
- pximg proxy (lrhtony/pixiv): <https://github.com/lrhtony/pixiv>
- FxEmbed: <https://github.com/FxEmbed/FxEmbed>
- tg-media-bot: <https://github.com/antlis/tg-media-bot>
