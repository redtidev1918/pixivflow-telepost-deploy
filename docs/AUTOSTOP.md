# Fly.io 自动休眠（auto-stop）成本优化

> 本文说明如何在 Fly.io 上用 `auto_stop_machines` 让机器在无流量时停机，
> 把「常驻一台 512 MiB」的账单压到「按需唤醒」的额度。结论对流量画像高度敏感：
> 先读「适用画像」，确认你的流量确实匹配，再动手。

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

### 1. 用 stop，不是 suspend

- **`stop`** 释放 RAM、**停止计费**——睡多久省多久，这是省钱的来源。
- **`suspend`**（暂停）保留内存、**照样计费**——不省钱，只是启动快一点。

Fly 的 `auto_stop_machines` 走的是 **stop** 语义：机器停了就不再按 RAM 计费，
只保留持久卷（和分配的静态 IP，若有）。所以选它才有账单收益。

### 2. Fly proxy 会排队唤醒请求，请求不丢

机器停着时来流量，Fly 的 proxy **先把机器拉起、等它通过健康检查、再转发请求**。
结果是：请求**不丢**，只是响应延迟 ≈ 冷启动时长（**5–15 秒**）。

因此不会出现「Telegram 回调超时、消息永久丢失」的灾难——Telegram 的 webhook 会重试，
PixivFlow 的 outbox 也会重试。代价只是「第一次慢几秒」，不是「丢」。

### 3. 高峰期有两条自愈兜底

- **PixivFlow 定时投递**：机器睡着时到了 cron 时刻，PixivFlow 的投递请求会把机器
  唤醒；冷启动完成后，已有的 **delivery outbox + 重试机制**保证稿件最终送达
  （这套 outbox 本就是为「投递失败要重试」建的，天然兼容「冷启动延迟」）。
- **用户消息 / 审核按钮**：每个安静空档的**第一条**消息付一次 ~10s 冷启动，之后
  恢复正常；审核按钮同理——PTB 会话超时是 5 分钟，10s 唤醒**不会**打断会话。

也就是说，冷启动的代价被「第一条消息」吸收掉，之后体验与常驻无差。

---

## 睡眠比例决定收益

收益完全由「一天里能睡多少比例」决定：

- 「几个间断高峰」画像 → 一天能睡 **70–80%**；
- 账单从 **~$3.9/月** 降到 **~$1–1.5/月**（512 MiB 档估算，未含持久卷/静态 IP）。

睡的比例越低，收益越薄；如果机器几乎一直有人用，auto-stop 只带来冷启动延迟而没有
收益。

---

## 拓扑：256 MiB 拆分

把「常驻一台 512 MiB」进一步压到「两台 256 MiB + 按需唤醒」，可行性与改动面如下：

| 拓扑 | 256 MiB 可行性 | 改动面 |
|---|---|---|
| **A**：双 Bot 单独一台 256 机器；PixivFlow 拆到自己机器（Fly 私网投递） | ✅ idle ~170 MiB，峰值约 200–230 MiB，可行 | 中：投递 URL 从 `127.0.0.1:8080` 改 Fly 私网域名、拆持久卷、部署套件拆两份 |

拆开后的关键点：

- **投递 URL**：PixivFlow 不再走同容器 `127.0.0.1:8080`，而是走 Fly 私网
  `http://<telepost-app>.internal:8080`（Fly 6PN 私网），`TELEPOST_API_BASE_URL`
  一键切。
- **拆卷**：TelePost 与 PixivFlow 各自一份持久卷（不再共享 `/app/data`）。
- **拆部署**：`fly/deploy.telepost.toml` + `fly/deploy.pixivflow.toml` 两个独立
  app（本仓库已提供模板），各自 `auto_stop_machines = true`。

---

## 配置

在对应的 `fly.toml` 里：

```toml
[http_service]
  auto_stop_machines = "stop"   # 无流量时 stop：释放 RAM、停止计费（睡多久省多久）
  auto_start_machines = true    # 来流量时 proxy 自动拉起
  min_machines_running = 0      # 允许完全停机（0 台常驻）
```

> `auto_stop_machines` 取值：`"stop"`（释放 RAM、停止计费）或 `"suspend"`
> （保留内存、继续计费，只快一点唤醒）。**省钱必须用 `"stop"`**；`true` 等价于
> `"stop"`。这是整个方案成立的前提。

配合 **Webhook 模式**（`RUN_MODE=WEBHOOK`）使用：webhook 请求本身就是唤醒信号，
Polling 模式没有入站请求可触发 proxy 唤醒，不适合 auto-stop。

## 外部闹钟：PixivFlow 的 cron 不会自己醒

**这是单机 auto-stop 最容易漏掉的坑**：PixivFlow 的调度 cron 活在进程里，机器一睡，
cron 也跟着死——到 10:00 没有任何东西会叫醒它，定时投递就永远错过。

所以单机 auto-stop 必须配一个**外部闹钟**：用一个免费的 GitHub Actions `schedule`
在投递前几分钟 ping `/health` 唤醒机器，并**循环 ping 约 30 分钟**覆盖投递窗口
（投递走 `127.0.0.1` 环回、不经 proxy，不会重置 auto-stop 计时，必须靠外部 ping
续命）。

本仓库已提供 `.github/workflows/wakeup.yml`：

```yaml
on:
  schedule:
    - cron: "58 1,9 * * *"   # UTC = 09:58 / 17:58 CST，比 10:00/18:00 投递提前 2 分钟
jobs:
  keep-awake:
    runs-on: ubuntu-latest
    steps:
      - run: |
          for i in $(seq 1 30); do
            curl -sf --max-time 60 https://<your-app>.fly.dev/health || true
            sleep 60
          done
```

- 09:58 被 ping 醒 → 10:00 前就绪 → PixivFlow 正常点火；
- 循环 ping 让机器醒到投递窗口结束，之后无流量自然睡回；
- 万一 GitHub Actions 抖动晚到几分钟 → PixivFlow 的漏跑补跑（catch-up）会在下一次
  唤醒时补跑错过的计划。

> 若拆成两台（拓扑 A），PixivFlow 机器同样需要外部闹钟（它仍是"主动外呼方"，
> 没有入站能自然唤醒它）；TelePost 机器由「webhook 入站」唤醒。

---

## 决策清单

- [ ] 流量确属「间断高峰」画像（大部分时间没人）？
- [ ] 能接受第一条消息 ~5–15s 冷启动？
- [ ] `RUN_MODE=WEBHOOK`（webhook 是唤醒信号）？
- [ ] `auto_stop_machines="stop"` + `min_machines_running=0`？
- [ ] 已配外部闹钟（GitHub Actions 定时 ping，覆盖 PixivFlow 投递窗口）？
- [ ] 拆两台时，PixivFlow 投递 URL 已切 Fly 私网、卷已拆？

满足前五条再上 auto-stop；否则保持常驻更稳妥。
