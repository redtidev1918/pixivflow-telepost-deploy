# 我该选哪种部署方式？

> **本页回答一个问题：你该用哪个 preset。** 15 秒能看完的表在下面，30 秒能跑完的决策树在再下面。
> preset 的技术细节在 [architectures/](../architectures/overview.md)；本页只做选择。

---

## 先看你的情况

| 你的情况 | 推荐 preset | 为什么 |
| --- | --- | --- |
| 我只有一台 VPS / NAS / 家用机 | [`single-host`](../architectures/single-host.md) | 组件最少，一条命令跑起来，不需要外部时钟 |
| 我只有一个 512 MiB 的 Fly Machine | [`single-machine-worker-sleep`](../architectures/single-machine-worker-sleep.md) | 一台机器塞下两个角色，空闲时执行进程不存在。**当前仅设计，未实现** |
| 我希望最省 Fly 费用 | [`split-worker`](../architectures/split-worker.md) | 执行端平时 `stopped`，不跑任务就不产生计算费用 |
| 我最在意可靠性 | [`split-worker`](../architectures/split-worker.md) | 执行端崩溃或 OOM 不传播到用户可见的投稿链路 |
| 我有 VPS + 家用服务器 | [`remote-worker`](../architectures/remote-worker.md) | 两个角色各在一台机器上，经私网或公网 HTTPS 通信 |
| 我最在意 Pixiv 出口质量 | [`remote-worker`](../architectures/remote-worker.md) | 可以把执行端单独放在出口已取得资格的机器上 |
| 我只想最快跑起来 | [`single-host`](../architectures/single-host.md) | 不需要 Fly、不需要 Cloudflare、不需要域名 |
| 我不想让执行端碰到 Telegram 凭据 | [`split-worker`](../architectures/split-worker.md) 或 [`remote-worker`](../architectures/remote-worker.md) | 只有这两个 preset 的凭据边界成立 |

---

## 决策树

```text
只有一台机器？
├─ 是
│  ├─ 内存 ≥ 1 GiB ─────────────────► single-host
│  ├─ 内存 = 512 MiB
│  │  ├─ 想省内存、能接受机器常驻计费 ─► single-machine-worker-sleep（当前未实现）
│  │  └─ 想省账单 ─────────────────► split-worker（用 Fly 承载执行端）
│  └─ 内存 = 256 MiB ──────────────► single-host，只跑 publisher（executor 放别处）
└─ 否
   ├─ 用 Fly.io ────────────────────► split-worker
   ├─ 已有多节点（VPS + 家用机等） ──► remote-worker
   └─ 只想要执行端在别处 ──────────► remote-worker
```

**五个问题的追问版本**，答案不明确时按顺序问自己：

1. 你有几台能长期开机的机器？1 台 → 共置；2 台及以上 → 分离。
2. 执行端能不能停下来？能 → `split-worker`（省账单）或 `single-machine-worker-sleep`（省内存）。
3. 你愿不愿意维护一个外部时钟（Cloudflare Worker 或任意 HTTP cron）？
   不愿意 → 用 `clock=internal`，那就是 `single-host` 或 `remote-worker` 的常驻形态。
4. 你有没有公网 HTTPS 入口？没有 → `telegramIngress=polling`，不需要域名和证书。
5. 你的 Pixiv 出口在这个机器上取得资格了吗？没有 → 把执行端换到别的机器，见
   [事故记录](../incidents/2026-09-11-pixiv-egress-rate-limit.md)。

---

## 你不必先想清楚的事

| 担心 | 事实 |
| --- | --- |
| 「选错了要重来」 | 四个 preset 共享同一套业务语义和同一套状态格式，迁移是搬状态。见 [migration.md](../architectures/migration.md) |
| 「资源档位要跟着架构一起选」 | 不用。架构和资源档位是两个独立维度，可自由搭配 |
| 「512 MiB 是不是只能单 Bot」 | 不是。`256m` 档单 Bot、`512m` 档双 Bot，见 [performance.md](../operations/performance.md) |
| 「国内网络是不是用不了」 | Compose 与 systemd 都支持 `network=proxy`，见 [proxy.md](../platforms/proxy.md) |
| 「要记住一堆 Fly 概念」 | 只有 `split-worker` 需要。`single-host` 只需要 Docker |

---

## 选完之后的下一步

| 你选了 | 现在做 |
| --- | --- |
| `single-host` | [quickstart.md](quickstart.md) → [docker.md](../platforms/docker.md) |
| `split-worker` | [split-worker.md](../architectures/split-worker.md) → [flyio.md](../platforms/flyio.md) → [cloudflare.md](../platforms/cloudflare.md) |
| `remote-worker` | [remote-worker.md](../architectures/remote-worker.md) → [vps.md](../platforms/vps.md) |
| `single-machine-worker-sleep` | 先读 [该 preset 的状态字段](https://github.com/redtidev1918/pixivflow-telepost-deploy/blob/main/docs/reference/architecture-matrix.json)：**尚无实现** |

---

## 一个常被混淆的取舍

```text
进程休眠  ≠  机器休眠
省内存    ≠  省计算账单
```

- `single-machine-worker-sleep` 让**执行进程**消失 → 省内存，机器仍计费。
- `split-worker` 让**执行机器**进入 `stopped` → 省计算账单。

两者不可互换。如果你看到「让执行端休眠能省钱」这种说法，它指的是后者，不是前者。
细节见 [lifecycle.md](../concepts/lifecycle.md)。
