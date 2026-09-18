# 部署契约（统一部署模型）

> **本页是「一套部署由哪些概念构成、每个概念的权威来源在哪」的唯一权威描述。**
> 它把 `docker-compose.yml`、`fly/*.toml`、`control-plane/`、`deploy.go`、README 与 docs 里
> 散落的部署逻辑收敛成**一个概念模型**。第一阶段不让程序读取它；它统一的是文档模型、
> 目录命名与 Agent 契约。机器可读的实例见
> [architecture-matrix.json](https://github.com/redtidev1918/pixivflow-telepost-deploy/blob/main/docs/reference/architecture-matrix.json)。

## 为什么需要它

同一件事曾经有三处说法：README 说一种拓扑，`fly.toml` 说一种，`docker-compose.yml` 又说一种。
契约的目标是让每个概念**只有一个权威来源**，并让「这是哪种部署」可以从一个 manifest 读出来，
而不是从十几个文档里猜。

## 八个概念

| 概念 | 回答的问题 | 权威来源 |
| --- | --- | --- |
| `DeploymentPreset` | 角色分别跑在哪里、哪些可以休眠 | [architectures/overview.md](../architectures/overview.md) + 矩阵 `presets` |
| `RuntimeRole` | 谁拥有哪个决策 | [concepts/roles.md](../concepts/roles.md) + 矩阵 `roles` |
| `LifecyclePolicy` | 谁可以睡、谁唤醒、谁决定停机 | [concepts/lifecycle.md](../concepts/lifecycle.md) + 矩阵 `enums.lifecycle` |
| `StateOwnership` | 每个角色的状态放在哪个卷 | [concepts/state.md](../concepts/state.md) + 矩阵 `enums.stateLayout` |
| `TriggerProvider` | 谁决定「什么时候跑」 | [concepts/scheduling.md](../concepts/scheduling.md) + 矩阵 `enums.clockProvider` |
| `NetworkTransport` | 角色之间走什么传输、出口是否经代理 | [concepts/network.md](../concepts/network.md) + 矩阵 `enums.transport` |
| `CredentialBoundary` | 谁持有哪个凭据、边界在哪些 preset 成立 | [concepts/credentials.md](../concepts/credentials.md) + 矩阵 `securityInvariants` |
| `ResourceProfile` | 每个运行单元分多少内存 | [reference/environment.md](./environment.md) + 矩阵 `resourceProfiles` |

这四个维度互相独立——这一条是整套设计的地基：

```text
逻辑架构（不变）        部署拓扑（可选）        资源档位（可选）      平台（可选）
谁拥有哪个决策     ×   角色跑在哪里、     ×   每个运行单元     ×   谁执行这个拓扑
                     谁能休眠、谁唤醒           分配多少内存
```

矩阵用 `dimensions[]` 显式记录：`logical-architecture` 的 `variesByDeployment` 为 `false`，
其余三个为 `true`。**任何「因为换了部署方式所以业务语义变了」的说法都与本契约冲突。**

## 外部时钟与触发凭据边界

生产 `split-worker` 用**冗余外部时钟**：两个 provider 作用于**同一套** schedule set，而执行权威只有一个。

```text
PRIMARY    cron-job.org       在 occurrence 准点触发
SECONDARY  Cloudflare Cron    occurrence + 2 分钟触发（control-plane/，SECONDARY_OFFSET_MINUTES = 2）
           │
           └─► 两者都 POST 同一个受认证的幂等端点：POST /internal/schedules/{scheduleId}/run
                     │
                     ▼
               PixivFlow durable slot ledger = 唯一的执行权威
```

**不变量（改时钟、改 cron、换 provider 时必须守住）：**

```text
External clocks are stateless trigger sources.
They MUST NOT derive occurrence IDs.
They MUST NOT own execution state.
Multiple external clocks MAY trigger the same schedule occurrence.
All duplicate triggers MUST converge through PixivFlow's durable slot identity.
```

```text
A wake-run-exit executor MUST NOT depend on itself for cron scheduling.
```

### Provider 映射

| | provider | 触发时刻 | 触发表达式（UTC） | 是执行权威吗 |
| --- | --- | --- | --- | --- |
| PRIMARY | cron-job.org | occurrence 准点 | `0 2 * * *`（`bot1-daily`）、`10 2 * * *`（`bot2-daily`） | 否 |
| SECONDARY | Cloudflare Cron（`control-plane/`） | occurrence + 2 分钟 | `2 2 * * *`（`bot1-daily`）、`12 2 * * *`（`bot2-daily`） | 否 |
| SSOT | PixivFlow durable slot ledger | — | — | **是，且是唯一一个** |

两个时钟 POST 的是**同一个**端点，谁后到就在前一个创建的 slot 上收敛。**冗余时钟 ≠ 第二个调度器**：
第二个调度器会带来第二套 schedule 定义或第二份执行状态，那仍然非法（矩阵 `second-clock`）。

`SECONDARY_OFFSET_MINUTES = 2`、两边的表达式，以及「secondary = primary + 文档化偏移」这条关系
由 `control-plane/src/cron-map.ts` 声明、由 `control-plane/test/redundant-clock.test.ts` 守护；
偏移必须为**正**（提前触发会解析到下一次 fire，即另一个 occurrence）。

### 第三方 provider 的凭据边界

时钟 provider 是**第三方**服务，它的凭据面必须被限制到最小：

- 它**只**持有 scheduler trigger credential：`SCHEDULER_TRIGGER_TOKEN`——用于对执行端触发端点发一次
  带 Bearer 的 POST。
- 它**绝不**持有：Fly API token、Telegram bot token 或 channel id、TelePost submit token、
  Pixiv 凭据、GitHub token、Cloudflare API token。

> **泄漏的后果被限制在一条上：只需要轮换 schedule trigger credential。**
> 不涉及 Telegram 凭据，不涉及 Pixiv 凭据，不涉及平台机器管理凭据。

审核群的人工重抓不属于时钟。TelePost 用独立的 `PIXIVFLOW_REFETCH_TOKEN` 调用 PixivFlow 的
`POST /internal/targets/{targetId}/refetch`；该令牌只用于手动目标执行，两个端点的令牌不得复用。
PixivFlow 以请求 UUID 创建独立的 durable manual Slot，返回 `202` 只表示已受理，
不表示下载或投递成功。定时 occurrence 的身份和终态不受这次人工执行影响。

审核群「重抓」的服务间不变量（split-worker 始终成立）：

```text
- TelePost 的 refetch 是远程服务间工作流：绝不 shell-out 或同容器拉起 PixivFlow。
- TelePost 绝不控制 Fly Machines；唤醒只经平台 auto_start_machines。
- 每次 refetch attempt 都是 durable 的；同一审核链同一时刻最多一个活跃 attempt。
- refetch 请求幂等按用户动作划分：同一次按钮点击的传输重试收敛到同一
  attempt / requestId；终态后的新点击创建新一代。
- no_alternative 是一次 attempt 的终态，不是审核链的永久穷尽。
- 当前候选与链内历史候选永不重新进入同一链（authoritative exclusion 在
  PixivFlow 的 durable 投递去重账本；TelePost 的 seen-history 是同一约束的证据面）。
- commit-after-success：新稿落库成功后才把旧稿标记 superseded；失败不改当前稿件。
- 迟到的异步结果只标记 attempt obsolete，绝不覆盖终态审核结论。
```

provider 控制台里的 URL 与 cron 表达式是**配置**，不是凭据。任何文档、脚本与日志只写凭据的
**名称**，永不写值（见 [凭据契约](../concepts/credentials.md)）。

## Manifest 形状

一份 preset 的部署清单长这样（示例为当前生产 `split-worker`）。这是**文档模型**，不是运行时
输入；具体值来自矩阵。

```yaml
preset: split-worker

roles:
  publisher:                     # 逻辑角色（永不改）
    placement: fly               # 部署事实（可变）
    lifecycle: always-on
    owns_state: [
      "/app/data/botN/",         # 每 Bot SQLite + runtime-policy.json
    ]
    credentials: [BOT*_TOKEN, BOT*_CHANNEL_ID, BOT*_OWNER_ID]
    telegram_credentials: true

  executor:
    placement: fly
    lifecycle: wake-run-exit
    owns_state: ["/app/data"]    # 槽位账本 + 下载缓存 + outbox
    credentials: [PIXIV_*, TELEPOST_BOT*_SUBMIT_TOKEN, SCHEDULER_TRIGGER_TOKEN]
    telegram_credentials: false  # SI-1

clock:
  provider: cloudflare           # cloudflare | external | internal
  placement: edge-serverless
  # 生产 split-worker 同时运行两个 provider，作用于同一套 schedule set：
  #   PRIMARY   cron-job.org      （external，occurrence 准点）
  #   SECONDARY cloudflare        （occurrence + 2 分钟）
  # 两者 POST 同一个幂等端点，任一都不是执行权威。

transport:
  executor_to_publisher: flycast # loopback-http | container-network | flycast | private-overlay | public-https

network:
  mode: direct                   # direct | proxy

state:
  layout: own-volume             # own-volume | own-volume-subdirectory | shared-volume | none
  volumes:
    - { owner: executor, mount: "/app/data" }
    - { owner: publisher, mount: "/app/data" }

resource_profile: 512m           # 见 enums / resourceProfiles
```

**各字段的合法取值**全部定义在矩阵的 `enums` 里（`supportLevel`、`roleKind`、`lifecycle`、
`clockProvider`、`telegramIngress`、`networkMode`、`transport`、`stateLayout`、`searchMode`、
`combinationVerdict`）。新增取值必须同时改矩阵、`architectures/overview.md` 与本页，并由
`architecture_docs_test.go` 校验一致。

## Preset 与 Feature switch 的关系

部署选择被有意设计成 **少量经过验证的 Preset + 有限 Feature switch**，而不是任意排列组合——
后者会导致组合爆炸（见 [overview.md](../architectures/overview.md) 的「合法组合」）。

| 维度 | 取值 | 默认 |
| --- | --- | --- |
| preset | `single-host` \| `single-machine-worker-sleep` \| `split-worker` \| `remote-worker` | 由用户选择 |
| `clock` | `internal` \| `cloudflare` \| `external` | `internal` |
| `telegramIngress` | `webhook` \| `polling` | `polling` |
| `network` | `direct` \| `proxy` | `direct` |
| `bots` | `1..N` | `2` |
| `search` | `enabled` \| `disabled` | `disabled` |
| `review` | `enabled`（固定） | `enabled` |

组合是否成立由矩阵 `combinationRules` 回答，分四档：`supported`、
`supported-with-limitations`、`experimental`、`invalid`。**用户不需要自己猜。**

`clock` 这一维度选的是 **provider 类别**，不是「时钟个数」：生产 `split-worker` 的取值仍然是
`cloudflare` 与 `external` 两个合法 provider，只是其中**两个**同时作用于同一套 schedule set
（PRIMARY cron-job.org / SECONDARY Cloudflare）。clock provider 的数量是 **operational 分配**，
不是 preset 属性——这也是「冗余时钟」不等于「新 preset」的原因。

## Single source of truth

| 概念 | 唯一权威 | 不允许再声明的地方 |
| --- | --- | --- |
| 架构 Preset 定义 | `architecture-matrix.json` + `architectures/*.md` | README、`fly/*.toml` 注释、compose 注释 |
| Preset 矩阵（支持等级） | `architecture-matrix.json` `presets.*.status` | 任何第二处 `唯一生产拓扑` 说法 |
| Fly 拓扑 | `fly/deploy.pixivflow.toml` + `fly/deploy.telepost.toml`（仅两份） | 第三份 `*.toml` |
| Compose 拓扑 | `docker-compose.yml`（preset 覆盖层 `docker-compose.worker-sleep.yml` 只换执行侧的运行方式，不是第二份来源） | 另起一份拓扑定义 |
| 调度契约 | [concepts/scheduling.md](../concepts/scheduling.md) | 段落式复述 |
| 凭据契约 | [concepts/credentials.md](../concepts/credentials.md) | 任何打印凭据的脚本 |
| 部署清单（部署编译器的输入） | [deployment-manifest.md](deployment-manifest.md) + 矩阵 `manifest` | 由清单推导出的平台分支 |
| 部署契约（本页） | 本文件 | README 里的「另一种说法」 |

**禁止出现两个文件同时声明「唯一生产拓扑」。** 生产拓扑是 `split-worker`（`Recommended
Fly.io production topology`），但它是「当前生产」，不是「唯一合法架构」。这句话本身就是
`docs-validation` 要防的漂移。

## Agent 与测试如何消费

- `deploy manifest` 把本页的部署模型编译成一份可校验声明：读矩阵判定 preset、平台、
  生命周期、档位与开关的合法性，非法组合直接以规则 id 报错（见
  [部署清单](deployment-manifest.md)）。它**只**是编译器的输入——没有任何业务代码读它。

- `architecture_docs_test.go` 校验：矩阵里的 preset 名在 `overview.md`、本页与各
  preset 文档中一致；标记为 `stable` 的 preset 必有对应文档；文档引用的配置文件存在；
  枚举取值合法；不存在「唯一生产拓扑」的第二处声明；`split-worker` 安全契约未被破坏。
- Agent 的读取顺序是：`AGENTS.md` → 本页 → 矩阵 → 具体 preset 文档。

## 与此前状态的关系

本契约不引入破坏性变更。`split-worker` 的线上配置、三份 Fly 配置
（`deploy.pixivflow.toml` / `deploy.telepost.toml` / `deploy.telepress.toml`）、`control-plane/`、四个
只读脚本与现有守护测试全部保持可用；本页只是给它们一个统一的名字与来源。

冗余外部时钟是**同一份拓扑的 operational 变更**，不是第五个 preset：preset 集合、角色所有权、
状态归属与生命周期语义都没有变。它的来源是
[2026-09-13 漏跑事故](../incidents/2026-09-13-schedule-trigger-miss.md)，运维姿势见
[调度运维手册](../operations/scheduling.md)。

## 相关页面

- Preset 索引：[architectures/overview.md](../architectures/overview.md)
- 角色契约：[concepts/roles.md](../concepts/roles.md)
- 环境变量与资源档位：[reference/environment.md](./environment.md)
- 平台：[platforms/docker.md](../platforms/docker.md)、[platforms/flyio.md](../platforms/flyio.md)、[platforms/vps.md](../platforms/vps.md)、[platforms/cloudflare.md](../platforms/cloudflare.md)
- 迁移契约：[architectures/migration.md](../architectures/migration.md)
- 调度运维手册：[operations/scheduling.md](../operations/scheduling.md)
- 漏跑事故与冗余时钟决策：[incidents/2026-09-13-schedule-trigger-miss.md](../incidents/2026-09-13-schedule-trigger-miss.md)
