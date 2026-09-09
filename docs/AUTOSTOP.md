# Fly.io 自动休眠（auto-stop）成本优化

> **✅ 2026 起推荐做法见 [SCHEDULING.md](SCHEDULING.md)。** 省钱停机的正确模型是
> **external Slot 触发**：机器平时 stopped，外部时钟（Cloudflare Cron）在 10:00/18:00
> 发受认证的 `POST /internal/schedules/run` 把机器叫醒、同步跑完一个 Slot。冷启动不补跑、
> 重复触发幂等、重试不换作品。Fly 模板：`fly/deploy.fly-autosleep.toml`；时钟适配器：
> `scheduler/cloudflare/`。
>
> **本文下方的「持续 ping /health 等内部 cron 恰好到点」属于 Legacy 方案**：它依赖机器被
> 随便一个请求叫醒后，进程内 cron 自己发现到点——在新模型下不再推荐（机器醒了 cron 也可能
> 没到点，且 daemon 冷启动 catch-up 会把停机误判成故障补历史任务）。保留仅为解释原理。
>
> 常驻（always-on / internal cron）仍是最省心的模式，见 SCHEDULING.md 的决策树。

---

## 适用画像

**「大部分时间没人 + 每天几个间断高峰」** —— 这正是 auto-stop 的正确适用场景。

此前本套件 Fly 配置里 `auto_stop_machines = false`（常驻），理由是「投稿 bot 必须
秒回，auto_stop 的唤醒延迟不可接受」。这个判断是在**常驻**前提下做的。如果你的实际
流量已经变成「一天只有几次间断高峰、其余时间几乎没人」，画像变了，结论可以重估：
秒回不再是硬需求，冷启动那几秒换掉 70% 的账单是划算的。

反过来，如果你的机器**需要 7×24 秒回**（例如有人守着投稿、审核按钮频繁被点），
那就**不要**开 auto-stop——常驻一台反而更简单可靠。这个方案不是「省钱的万能药」，
只在「间断高峰」画像下成立。

---

## 关键机制（决定方案成不成立）

### 1. stop 与 suspend 都不计费；本项目选 suspend

- **`stop`**：释放 RAM、不计 CPU/RAM；唤醒是完整冷启动（秒级到十几秒）。
- **`suspend`**：Firecracker 快照（内存/寄存器/句柄）落持久存储；挂起期间同样
  **不计 CPU/RAM**（Fly 官方明确 `stopped` 与 `suspended` 都不收费），唤醒是
  快照恢复（**几百毫秒**），进程不重启、事件循环/连接状态保留。

两种状态都只保留持久卷（和已分配的静态 IP）。本项目 auto-stop profile 统一用
`auto_stop_machines = "suspend"`：账单收益与 stop 相同，而唤醒从「冷启动 5–15s」
降到亚秒级快照恢复，对 webhook 唤醒体验明显更好。

### 2. Fly proxy 会排队唤醒请求，请求不丢

机器停着时来流量，Fly 的 proxy **先把机器拉起、等它通过健康检查、再转发请求**。
结果是：请求**不丢**，只是响应延迟 ≈ 唤醒时长（suspend 快照恢复通常几百毫秒；
若选 stop 则是完整冷启动 **5–15 秒**）。

因此不会出现「Telegram 回调超时、消息永久丢失」的灾难——Telegram 的 webhook 会重试，
PixivFlow 的 outbox 也会重试。代价只是「第一次慢几秒」，不是「丢」。

### 3. 高峰期有两条自愈兜底

- **PixivFlow 定时投递**：机器睡着时到了 cron 时刻，PixivFlow 的投递请求会把机器
  唤醒；冷启动完成后，已有的 **delivery outbox + 重试机制**保证稿件最终送达
  （这套 outbox 本就是为「投递失败要重试」建的，天然兼容「冷启动延迟」）。
- **用户消息 / 审核按钮**：suspend 下每个安静空档的**第一条**消息只付亚秒级快照
  恢复（stop 下才是 ~10s 冷启动）；审核按钮同理——PTB 会话超时是 5 分钟，
  唤醒**不会**打断会话。

也就是说，冷启动的代价被「第一条消息」吸收掉，之后体验与常驻无差。

---

## 睡眠比例决定收益

收益完全由「一天里能睡多少比例」决定：

- 「几个间断高峰」画像 → 一天能睡 **70–80%**；
- 账单从 **~$3.9/月** 降到 **~$1–1.5/月**（512 MiB 档估算，未含持久卷/静态 IP）。

睡的比例越低，收益越薄；如果机器几乎一直有人用，auto-stop 只带来冷启动延迟而没有
收益。

---

## 推荐拓扑：PixivFlow 常驻 + TelePost 休眠

这是 Fly 上**真正适合本项目的低成本架构**（双 Bot 时合一台 256 放不下）。**生产已按
此拓扑部署**（PixivFlow 256 always-on + TelePost 512 auto-stop）。

```text
PixivFlow  256MB  always-on（min_machines_running=1，auto_stop=false）
    │  它是 system clock owner：scheduler/cron 必须 24/7 活着
    │
    │  投递走 Flycast：http://<telepost-app>.flycast（无端口，走 80 → proxy → 8080）
    │  （私网 + 经 Fly Proxy + 能 auto-start stopped 的 TelePost）
    ▼
TelePost   512MB  auto-suspend（min_machines_running=0，auto_stop="suspend"）
    │  双 Bot；event-driven：webhook/用户投稿/PixivFlow 投递都是入站，来请求就醒
    ▼
  idle → auto-suspend（不计 CPU/RAM），来请求 → Fly Proxy 亚秒级快照恢复
```

| 半边 | 大小 | 常驻/休眠 | 原因 |
|---|---|---|---|
| PixivFlow | 256 MB | **always-on** | 维护 scheduler/cron，必须到点触发 |
| TelePost | 512 MB | **auto-stop** | event-driven，入站请求（webhook/用户/PixivFlow）都能叫醒它 |

关键点（实测踩过的坑）：

- **投递 URL 用 Flycast，不用 `.internal`**：`.internal`（6PN）是机器直连、**不经过
  Fly Proxy**，无法唤醒 stopped 的 TelePost；`.flycast` 走 Fly Proxy、支持 auto-start。
  所以 `TELEPOST_API_BASE_URL = http://<telepost-app>.flycast`。
- **Flycast 不能带 `:8080`**：Fly Proxy 在 **80 端口**监听 Flycast 流量再转发到内网
  8080；带 `:8080` 会 `ECONNRESET`。
- **TelePost 拆机模板必须 `force_https = false`**：`force_https=true` 会让 Flycast
  私网 HTTP 被 301 跳 HTTPS 导致投递失败（webhook 仍走 HTTPS 直连，不受影响）。
- **TelePost 那台要先分配 Flycast 私网地址**：`fly ips allocate-v6 --private -a <app>`（一次）。
- **拆卷**：TelePost 与 PixivFlow 各自一份持久卷（不再共享 `/app/data`）。
- **拆部署**：`fly/deploy.telepost.toml`（512MB auto-stop）+ `fly/deploy.pixivflow.toml`
  （256MB always-on），或直接 `deploy split` 生成。

### 生产拆分后的已知状态

- 旧 TelePost 卷里还留着 PixivFlow 的 ~280MB 下载缓存 + 旧 DB（已不用，占空间，可清理）。
- 拆机时**没迁 PixivFlow 的 DB**（空库重下「昨日榜」，已发布的被 TelePost 7 天软去重
  跳过，不会刷屏）。
- 「TelePost 睡下 → 被投递唤醒」的完整闭环要等下一次 10:00/18:00 定时任务自然触发
  才能最终确认（Flycast 直连已验证 200 OK，auto-start 是 proxy 层标准行为）。

---

## 配置

在对应的 `fly.toml` 里：

```toml
[http_service]
  auto_stop_machines = "suspend" # 无流量快照挂起：不计 CPU/RAM，恢复亚秒级
  auto_start_machines = true     # 来流量时 proxy 自动快照恢复
  min_machines_running = 0       # 允许完全挂起（0 台常驻）
```

> `auto_stop_machines` 取值：`"suspend"`（Firecracker 快照，恢复几百毫秒）或
> `"stop"`（释放 RAM，恢复是完整冷启动）。**两种状态都不计 CPU/RAM**（2025-08
> 起官方文档明确 suspended 同样免费）；本项目默认 `"suspend"`，因为免费且唤醒快。
> 健康检查打 `/ready`（冷启动未就绪时 503，proxy 会等它就绪再转发），不要 ping
> `/health` 之外的业务接口。

配合 **Webhook 模式**（`RUN_MODE=WEBHOOK`）使用：webhook 请求本身就是唤醒信号，
Polling 模式没有入站请求可触发 proxy 唤醒，不适合 auto-stop。

## 外部闹钟：PixivFlow 的 cron 不会自己醒

**这是单机 auto-stop 最容易漏掉的坑**：PixivFlow 的调度 cron 活在进程里，机器一睡，
cron 也跟着死——到 10:00 没有任何东西会叫醒它，定时投递就永远错过。而且投递走
`127.0.0.1` 环回、不经 Fly proxy，**不会重置 auto-stop 计时**，所以闹钟必须**持续
ping 到投递窗口结束**，不能只 ping 一次。

**实测 idle timeout ≈ 300s（5 分钟）**（2026-09 实测唤醒后无流量 → `stopped` 约
379s）：ping 间隔必须 < 300s，机器才会在投递窗口内持续在线；只 ping 一次（如 09:58）
会在 ~10:03 睡回，正好打断 10:00 点火的投递。

### 闹钟怎么选（按「零外部依赖」从强到弱）

| 方案 | 外部依赖 | 精度 | 月费 |
|---|---|---|---|
| **easycron**（免费 HTTP cron 服务） | 有（第三方，非 GitHub） | ✅ 精确 | ~$1-1.5 |
| **Fly `--schedule daily`**（平台原生） | 无 | ❌ 粗（每天档，漂移） | ~$1-1.5 |
| **拆机 + PixivFlow 常驻** | 无 | ✅ 精确 | ~$2.5 |

### 方案 1：easycron（推荐，精确、非 GitHub）

[easycron](https://www.easycron.com) 免费版即可。建 **2 个 HTTP GET 任务**，时区选
`Asia/Shanghai`，URL 填 `https://<your-app>.fly.dev/live`（路由进程存活即 200，ping 的目的只是保活/唤醒，
不需要等 bot 就绪；请求经 proxy 即会唤醒挂起的机器）：

```
任务 1：cron  */5 9-10 * * *    # 每天 09:00–10:59 每 5 分钟 ping 一次
任务 2：cron  */5 17-18 * * *   # 每天 17:00–18:59 每 5 分钟 ping 一次
```

- 09:00 第一次 ping 就把机器叫醒 → PixivFlow 10:00/10:10 正常点火；
- 每 5 分钟一 ping（< 300s idle timeout）让机器醒到投递窗口结束，之后自然睡回；
- 万一某次 ping 漏了 → PixivFlow 的漏跑补跑（catch-up）在下一次唤醒时补跑。

### 方案 2：Fly 原生 `--schedule daily`（容错版，零第三方）

Fly 能给机器设「每天启动」的调度（`fly machine update --schedule daily`），这是
平台自带、不依赖任何第三方。但**只有「每小时/每天/每周/每月」粗粒度档**，没有
cron 精度，也**不能「持续保持机器醒」**——机器每天被启动一次、约 5 分钟无流量又
睡回，很可能错过 10:00 的 cron，只能靠 catch-up 在下次唤醒时补跑。适合「错过就
错过、下次补」的容错场景，不适合要求准时投递。

### 方案 3：拆机 + PixivFlow 常驻（零依赖、精确，但贵一点）

把 PixivFlow 拆到自己机器且**不 auto-stop**（它要常驻才能跑 cron，$1.94/月），
TelePost 那半 auto-stop（webhook/用户消息/投递请求都能叫醒它）。零外部依赖、精确，
但比方案 1 贵约 $1/月。见拓扑 A。

---

## 决策清单

- [ ] 流量确属「间断高峰」画像（大部分时间没人）？
- [ ] 能接受第一条消息的唤醒延迟（suspend 亚秒级；stop 5–15s 冷启动）？
- [ ] `RUN_MODE=WEBHOOK`（webhook 是唤醒信号）？
- [ ] `auto_stop_machines="suspend"` + `min_machines_running=0`？
- [ ] 已配外部闹钟（easycron / Fly `--schedule daily` / PixivFlow 拆机常驻，三选一，
  覆盖 PixivFlow 投递窗口）？
- [ ] 拆两台时，PixivFlow 投递 URL 已切 Fly 私网、卷已拆？

满足前五条再上 auto-stop；否则保持常驻更稳妥（默认就是常驻，这是最可靠的选择）。