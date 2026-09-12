# 事故 2026-09-11 — GitHub-hosted runner 出口上的 Pixiv 限流饥饿

> 本文是从旧「无服务器」时期的事故记录中保留下来的**事实**部分。当时的控制面描述
> （Cloudflare Worker + D1 业务状态机、GitHub Actions 作为执行平面）已被当前拓扑取代，
> 见 [架构与信任边界](/ARCHITECTURE.md)：Cloudflare 只是薄时钟，PixivFlow 是唯一的
> Pixiv 执行与可靠性平面。事故本身与结论不受拓扑变更影响。

## 背景

当时 Pixiv 执行平面刚从 Fly 常驻进程迁移到 GitHub-hosted runner，Cloudflare 侧仍是唯一的
时钟与账本。**控制面能连通，不代表执行面合格**——这就是本次事故暴露的问题。

## 症状

- 同样的 Pixiv 工作量，历史上在 Fly 上几分钟内完成。
- 在 GitHub-hosted runner 上，PixivFlow 能完成鉴权、能解析主题，但接近生产规模的负载会反复
  进入 `Pixiv rate limit cooldown`，`penaltyLevel` 从 1 爬到 2，并且在批次自身的 1800000 ms
  看门狗取消它之前，始终产不出一次待审核。

## 证据

真实 GitHub Actions 运行 `34558034050`（`pixivflow-batch`，`main`，2026-09-11 03:20Z，
conclusion `failure`）。时间线节选（非完整日志）：

```text
03:20:44  PixivFlow runtime starting
03:20:45  refresh Pixiv access token success
03:21:10  TopicResolver refresh: resolvedTags=12, sampled=100
03:23:26  rate limit cooldown  penaltyLevel=1
03:26:12  rate limit cooldown  penaltyLevel=1
03:27:18  rate limit cooldown  penaltyLevel=2
03:31:25  rate limit cooldown  penaltyLevel=1
03:32:28  rate limit cooldown  penaltyLevel=2
03:37:40  rate limit cooldown  penaltyLevel=1
03:41:21  rate limit cooldown  penaltyLevel=1
03:44:04  rate limit cooldown  penaltyLevel=1
03:45:05  rate limit cooldown  penaltyLevel=2
03:50:44  batch watchdog 1800000 ms -> download cancelled
```

## 解读

**这证明了可达性，而不是适用性。** GitHub-hosted runner 能到达 Pixiv OAuth 与 App API；
同样的端点在生产级负载下出现严重的限流饥饿。

| 级别 | 结论 |
| --- | --- |
| 已确认 | GitHub-hosted runner 能到达 Pixiv OAuth / App API；生产级负载反复触发持续 429 与 penalty 升级，并死在 30 分钟看门狗上 |
| 高置信 | GitHub-hosted runner 的共享数据中心出口 / IP 信誉受到更严格的 Pixiv 限流；与历史上 Fly 上「几分钟完成」的基线差距支持这一判断 |
| 未确认 | Pixiv **并非**无条件封禁 GitHub IP、Cloudflare Worker 或 `i.pximg.net`；Fly **并非**永久的合格出口；普通 VPS **不保证**不被限流——每个出口都需要各自的 A/B 探测 |

## 未知项

- 限流是否基于 ASN / IP 信誉——未知。
- Cloudflare Worker 作为数据面是否表现相同——未知。
- GitHub 出口上 `i.pximg.net` 媒体下载是否被限流——未知。
- VPS / self-hosted runner 是否稳定——需要 A/B 探测。

## 架构后果

**控制面兼容不等于执行面兼容。**

PixivFlow 依赖几个彼此独立的 Pixiv 数据面，必须分别取得资格：

| 数据面 | 端点 |
| --- | --- |
| OAuth | `oauth.secure.pixiv.net` |
| App API | `app-api.pixiv.net` |
| 媒体 CDN | `i.pximg.net`（请求携带 `Referer: https://app-api.pixiv.net/`） |

当前拓扑下（见 [架构与信任边界](/ARCHITECTURE.md)）：Cloudflare 只作为薄时钟，PixivFlow 是
唯一的 Pixiv 执行与可靠性平面，TelePost 是唯一的 Telegram webhook / 审核 / 发布平面。
执行出口是**可替换的、需先取得资格的资源**；GitHub-hosted runner 仍然实现着，也仍然适合 CI、
影子与轻量测试，但**当前不作为 Pixiv 数据面的生产出口**。

不论出口是谁，凭据准入不变量不变：`pixiv-main` 最多只有一个在跑的生产执行。**出口是执行资源，
永远不是第二个调度器。**

## 后续

TODO：一条 `pixivflow diagnose egress` 探针（OAuth / App API / 媒体 / 受控突发），用同一份凭据、
同样的请求形状、User-Agent 与 Referer，对 GitHub / Cloudflare / Fly / VPS / self-hosted runner 做
A/B 对比——参照 DeviantDrop 的 `scripts/detect-da.mjs`，它为另一个平台划出了同一条界线：
**Telegram / 控制逻辑与第三方数据面出口不是同一件事。**
