# 生命周期：谁可以睡、谁唤醒谁、谁决定停止

> **本页是「哪个角色可以停止、什么请求把它唤醒、什么状态决定它退出」的唯一权威描述。**
> 枚举、preset 与安全不变量以
> [architecture-matrix.json](https://github.com/redtidev1918/pixivflow-telepost-deploy/blob/main/docs/reference/architecture-matrix.json)
> 为准（docsify 无法渲染 JSON，因此用绝对链接）：`enums.lifecycle`、
> `presets.*.units[].machineSleep`、`presets.split-worker.invariants`、`SI-5`。
> 角色所有权见 [roles.md](./roles.md)，状态存放见 [state.md](./state.md)。

## 生命周期枚举

| 枚举值 | 精确含义 | 谁适用 | 前置条件 |
| --- | --- | --- | --- |
| `always-on` | 进程常驻。平台不得停止它，也不得因空闲推断停止。中断只来自重启或故障 | `clock`、`publisher`、`telegram-ingress`、`state`、`network`，以及常驻形态的 `executor` | 无 |
| `wake-run-exit` | 平时**机器**处于 `stopped`。一个受认证的触发请求经由平台代理启动机器，进程跑完后**由自己的账本**决定退出，机器回到 `stopped` | `split-worker` 的 `executor`；`remote-worker` 在平台支持时 | 时钟必须是 `cloudflare` 或 `external`（见下） |
| `spawn-on-demand` | **机器**常驻，`executor` 只作为子进程在有活时存在，空闲即退出。标记进程不标记机器 | `single-machine-worker-sleep` 的 `executor` | 有一个常驻监督者（`publisher` 单元）负责按需拉起子进程 |

`wake-run-exit` 与 `spawn-on-demand` 都让执行端「闲时不在跑」，但它们操作的是**不同的层级**。
把二者混为一谈会产生矩阵 `invalid` 组合里的
`wake-run-exit-without-external-clock`：执行端进程若平时不在，它自己的 in-process cron
永远不会触发，也就没有任何东西会唤醒它。

## 谁可以睡，谁永远不可以

| 角色 | 可以睡 | 理由 |
| --- | --- | --- |
| `executor` | 可以 | 它是事件驱动的：有触发才有活；闲时不持有任何用户可见的交互 |
| `publisher` | **不可以** | 冷启动期间用户看到的是一个坏掉的投稿按钮；没有任何成本模型值得让可见按钮等机器启动 |
| `telegram-ingress` | **不可以** | 它与 `publisher` 同属业务端进程树；webhook 无响应等于 Telegram 重投与用户丢稿 |
| `clock` | 不可以 | 它就是唤醒别人的那一侧；睡着的时钟不能唤醒任何人 |
| `state` / `network` | 不适用 | 它们是能力，不是进程；但持有它们的卷与出口必须持续可用 |

业务端在 Fly 上的对应配置是 `auto_stop_machines = false`、`min_machines_running = 1`
加一条长期健康检查（`fly/deploy.telepost.toml`）。执行端相反：`auto_stop_machines = false`、
`min_machines_running = 0`、`auto_start_machines = true`、`restart.policy = "never"`。

## wake-run-exit 的机制

**唤醒由触发请求完成，不需要任何机器管理接口。** 触发 POST 到达平台代理时，代理先启动
已停止的机器再转发请求（`auto_start_machines = true`），因此触发链路里没有机器 id，
也没有机器管理令牌。这也是矩阵 `enums.clockProvider` 允许 `cloudflare`/`external`
承载 `wake-run-exit` 的原因。

**退出由执行端自己的账本决定**（`schedulerRuntime.exitWhenIdle = true`）。空闲判定只读本
进程的权威状态，全部为 0 才算空闲：

| 判据 | 含义 |
| --- | --- |
| 无进行中的槽位执行 | 没有 `running` 状态的 slot |
| 无被当前租约持有的运行 | 没有仍在被本进程持有的执行 |
| 无进行中下载 | 没有未完成的媒体传输 |
| 无处理中的投递项 | outbox 里没有被领取的条目 |
| 无立即待处理的投递项 | outbox 里没有到点该发的条目 |

满足后等待 `idleGraceMs`（生产 900000 ms = 10 分钟）再 `exit(0)`。
`maxLifetimeMs`（生产 10800000 ms = 3 小时）是异常长跑的硬上限兜底：退出前先持久化既有
序列与状态、输出明确日志，状态不删除，下次唤醒可续跑。正常任务永不依赖它退出。

`idleGraceMs` 是**合并窗口而不是超时**：10:00 与 10:10 两个 schedule 由同一次唤醒服务，
刚跑完的投递重试也能在同一窗口内排空，不必付第二次冷启动。这条判定**只读执行端自己的状态**，
因此矩阵 `SI-5` 成立：停止决定属于执行端的账本，不属于任何平台探针。

## 两个必须分开的前提

> **进程休眠 ≠ 机器休眠。**

机器的计费与状态由平台负责，进程的存活由监督者负责。`wake-run-exit` 让**机器**停止并因此
不再计费；`spawn-on-demand` 只让**子进程**退出，机器仍在运行、仍在计费。矩阵把这条差异写成
`costDisclaimer`：`进程休眠 ≠ 机器休眠；省内存 ≠ 省计算账单。`

> **省内存 ≠ 省计算账单。**

`sleep(0)` 或子进程退出回收的是 RSS；只要机器还在运行，计算账单照付。
`single-machine-worker-sleep` 的 `costModel` 明确写着「机器常驻计费；休眠只省内存，
不省计算账单」。真实的省钱来自 `split-worker` 里「执行端平时不运行」。

## 平台 auto-stop 是被禁止的

**执行端必须显式配置 `auto_stop_machines = false`。** 原因不是偏好，而是一次被删掉的拓扑：

- commit `9f3fc53` 引入了机器级自动休眠拓扑（一份已删除的合体 autosleep 配置，
  开启机器级 `auto_stop_machines`）。
- commit `a98c3a7` 以「删除一次性执行平面与混部拓扑」为由删除了它，理由写得很具体：
  触发端在 occurrence 落库后**立即应答**是刻意的（10–40 分钟的运行活不过代理超时），
  代理看到的「连接已空闲」并不代表任务结束。依据一个空闲 HTTP 连接推断停机，就会把批次
  拦腰砍断。

因此有一条与拓扑无关的规则：**没有一个 preset 使用平台 auto-stop。** 执行端是否可以停，
只由它自己的账本回答。`single-machine-worker-sleep` 是那次错误设计的**进程级**修正：
它把「不在跑的时候不占内存」重新实现在子进程层，机器本身**永不停机**，也**绝不**使用
平台 stop / suspend / auto-stop。

同理，执行端**不配置健康检查**：探测本身就是一次请求，会经由同一个代理把刚刚决定收工的
机器重新叫醒，形成一个永远停不下来的循环。`fly/deploy.pixivflow.toml` 里刻意没有
`[[http_service.checks]]` 块。

## `restart.policy = "never"` 是另一半

能到达 `stopped` 的前提是「进程退出不会被平台重新拉起」。如果平台在进程退出后重新启动它，
机器会立刻回到 `started`，`stopped` 这一状态**永远无法到达**——省钱的机制与自我终止的设计
同时失效。

| 项 | 值 | 说明 |
| --- | --- | --- |
| `fly/deploy.pixivflow.toml` 写法 | `policy = 'never'` | flyctl 只接受 `never`；写 `no` 会被拒绝 |
| 平台运行期规范化 | `restart.policy = "no"` | Machines API 把 `never` 显示为 `no`，两者是同一件事 |
| 验收脚本 | 接受两种拼写 | `scripts/verify-production.sh` 按 `fly machine list --json` 判定，避免把「源写 never、平台显示 no」报成冲突 |
| 业务端 | `policy = 'always'` | 常驻服务被重新拉起是期望行为 |

## catch-up 与 wake-up 不是一回事

| 概念 | 层级 | 解决什么 | 本部署的策略 |
| --- | --- | --- | --- |
| catch-up | 应用级容错 | 重启、崩溃、宿主机维护之后补上漏跑的**时间点** | **关闭**：`catchUpMissedRuns = false` |
| wake-up | 平台级重启 | 让已停止的基础设施重新启动 | 启用：由触发请求经平台代理完成 |

两者被明确分开，且本部署**不回补**：迁移或长时间停机期间错过的时间点不会补跑，
补跑等于把昨天的内容当成今天的推给用户。过期槽位按 `trigger.graceMinutes`（生产 720）
判定为 `expired`，不补发。详见 [scheduling.md](./scheduling.md) 第 7 条不变量。

## 每个 preset 的生命周期

| preset | 机器是否可停 | 进程形态 | 唤醒者 | 停止决定者 | 执行端健康检查 | 执行端 restart policy | 省钱来自 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `single-host` | 否 | 全部常驻（各自容器） | 不适用 | 容器 restart policy | 有（compose healthcheck） | compose `restart: unless-stopped` | 无停机省钱机制，按宿主计费 |
| `single-machine-worker-sleep` | **否** | `executor` 子进程 `spawn-on-demand`，其余常驻 | 常驻监督者按需拉起子进程 | 执行端自己的账本（`exitWhenIdle`） | 有（探的是常驻监督者，不探子进程） | 监督机器常驻 | 只省内存，不省计算账单 |
| `split-worker` | **是**（仅执行端机器） | `executor` `wake-run-exit`；业务端常驻 | 触发请求经平台代理 | 执行端自己的账本（`exitWhenIdle`） | **无**（刻意不配置） | `never`（映射为平台 `no`） | 执行端平时不运行 |
| `remote-worker` | 平台相关 | `wake-run-exit` 或 `always-on`，由该宿主平台决定 | 该部署选定的时钟 provider | 使用 `wake-run-exit` 时由账本决定 | 由宿主平台决定 | 由宿主平台决定 | 把执行端放在便宜或已有的机器上 |

## Fly 上的三个决定在三处，缺一不可

在 Fly 上「平时 stopped」不是一个开关，而是三个互相独立、都必须存在的设置：

| 设置 | 位置 | 缺了会怎样 |
| --- | --- | --- |
| `auto_stop_machines = false` | `[http_service]` | 平台按「空闲」推断停机，把正在下载的批次砍断 |
| `auto_start_machines = true` | `[http_service]` | 触发请求打到 `stopped` 机器上直接失败，没有任何东西会被唤醒 |
| `restart.policy = "never"` | `[[restart]]` | 进程退出后平台立刻重新拉起，`stopped` 永远到不了 |

三者都写在 `fly/deploy.pixivflow.toml` 里，并由
`control-plane/test/deployment-contract.test.ts` 与 `scripts/verify-production.sh` 核对。
具体命令与线上核对方式见 `../platforms/flyio.md`。
