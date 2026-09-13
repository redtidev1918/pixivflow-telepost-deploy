# AGENTS.md —— 多拓扑部署仓库的 Agent 契约

这份文件写给任何进入本仓库的智能体或工程师。它回答四件事：

1. 什么业务契约在任何部署方式下都不变；
2. 本仓库支持哪几种部署 preset，各自的边界是什么；
3. 一个修改应该落在哪个仓库、哪个文件；
4. 每个概念的**唯一权威来源**在哪，不许再造第二种说法。

读取顺序：本文件 →
[`docs/reference/deployment-contract.md`](docs/reference/deployment-contract.md) →
[`docs/reference/architecture-matrix.json`](docs/reference/architecture-matrix.json) →
具体 preset 或概念页。

---

## 0. 仓库定位

本仓库是**部署黏合层**：它把 PixivFlow（执行）与 TelePost（投稿/审核/发布）组合成可部署的
系统，外加一个只负责「何时唤醒」的时钟平面。**它不拥有任何业务状态。**
occurrence 计算、槽位状态机、执行租约、凭据下发、审核 FSM、发布逻辑都属于 PixivFlow 或
TelePost。

---

## 1. 不可改变的业务契约（与部署方式无关）

无论选哪个 preset，下面的所有权都不变。

### PixivFlow（角色 `executor`）拥有

- Pixiv 查询、主题/榜单发现、排序
- 执行调度：occurrence、槽位账本、执行租约
- 候选选择、下载
- 投递 outbox 与投递重试

### TelePost（角色 `publisher` + `telegram-ingress`）拥有

- Telegram 入站（唯一的 webhook owner，或 polling 循环）
- 投稿接收与幂等
- 审核队列与审核状态机
- 发布到频道
- **全部 Telegram 凭据**

### 时钟（角色 `clock`）拥有

- cron 表达式 → schedule id 的映射
- 一次带令牌的触发 POST

它**绝不**拥有：occurrence 计算、时区换算、槽位标识生成、任何业务表、
除触发令牌之外的任何凭据。

### 派生规则

- **共置只是物理事实，所有权永不合并。** `single-host` 把两个角色放进同一台机器，
  但 `executor` 不因此获得审核或发布权，`publisher` 不因此获得 Pixiv 登录或槽位调度权。
- **`executor` 在任何 preset 下都不拥有、不接收 Telegram 令牌、频道 ID、owner id 或
  webhook secret（SI-1，全局）。** 共置改变的是主机级隔离（`hostCredentialIsolation=false`）：
  同机进程理论上能读到业务端的 secret，但这不构成 executor 持有它的许可。
  `single-machine-worker-sleep` 下 supervisor 必须用环境白名单 spawn executor 子进程。
- **状态命名空间绝不重叠（SI-7）。** 允许共享物理卷 + 互不相交的角色子目录
  （`./data/pixivflow/**` vs `./data/botN/**`）；禁止两个角色写同一个数据库或命名空间。
- **发布必须经人工审核。** `review.enabled=false` 是非法组合，不是可配置项。
- **每个 Pixiv 凭据最多一个活跃生产执行。** 出口是可替换的、需先取得资格的执行资源，
  它永远不是第二个调度器，也不拥有任何状态。

---

## 2. 支持的 preset 与各自边界

机器可读定义与支持等级：`docs/reference/architecture-matrix.json` 的 `presets`。

| Preset | 支持等级 | 实现状态 | 机器数 | `executor` 生命周期 | Telegram 凭据边界 | 关键契约 |
| --- | --- | --- | --- | --- | --- | --- |
| `single-host` | Stable | 已实现，CI 覆盖 | 1 | `always-on` | host=false | 一个 `./data` 物理卷、互不相交的角色子目录；pixivflow 容器只收 `BOT*_SUBMIT_TOKEN`；容器网络投递 |
| `single-machine-worker-sleep` | Experimental | **未实现**（supervisor 已实现） | 1 | `spawn-on-demand` | host=false | 机器永不停机；只有 `executor` 进程退出；supervisor 用环境白名单 spawn，Telegram secret 不继承；停机决策权归 `executor` 账本 |
| `split-worker` | Stable | 已实现、已测试、**当前生产** | 2 + 时钟 | `wake-run-exit` | host=true | 两份 Fly 配置 + 两个卷；执行端无健康检查、无平台 auto-stop、`restart.policy=never` |
| `remote-worker` | Beta | 已实现，未经端到端测试 | 2（可跨平台） | `wake-run-exit` 或 `always-on` | host=true | 私网叠加网或公网 HTTPS；bearer 认证在私网上也必须开启 |

「host」列是 `hostCredentialIsolation`（主机级凭据隔离）。**另一列不存在但恒成立**：
`executorHoldsTelegramCredentials` 在四个 preset 下全部为 `false`——见第 1 节与 SI-1。

### Preset 专属契约速查

```text
single-host:
  one host, shared failure domain, shared ./data volume
  健康检查可用（没有会被探测唤醒的 stopped 状态）

single-machine-worker-sleep:
  publisher 永久常驻；executor 是常驻 supervisor 的子进程
  process sleep != machine sleep；RAM saving != compute billing saving
  本 preset 是被删除的机器级 auto-stop 拓扑在「进程层」的修正，
  重新引入机器级 stop/suspend 就是重新引入那个缺陷

split-worker:
  separate machines, separate volumes
  executor 机器可以停止；唤醒 = 触发请求经平台代理；停机 = executor 自己的账本
  hostCredentialIsolation=true：执行镜像里没有任何 Telegram 令牌

remote-worker:
  executor 是远端可替换执行资源
  同一 production schedule 最多一个 active executor
  私网不等于已认证

所有 preset 共同:
  executorHoldsTelegramCredentials = false（SI-1，全局）
  状态命名空间互不重叠；共享物理卷只允许配互不相交的角色子目录（SI-7）
```

### 合法与非法组合

完整表在矩阵的 `combinationRules`。最常见的四条：

| 组合 | 结论 |
| --- | --- |
| 执行端 `wake-run-exit` + `clock=internal` | **非法**：停止的进程无法触发自己的 cron |
| `review.enabled=false` | **非法**：未经人工批准就发布 |
| 两个角色写同一个状态命名空间（即使共享物理卷） | **非法**：共享卷 + 互不相交的角色子目录合法；命名空间重叠才非法（SI-7） |
| 同一套 schedule 有两个时钟 | **非法**：重复触发幂等，凭据争用不是 |

---

## 3. 修改路由：改哪里

| 你要改的 | 落在 | 不要落在 |
| --- | --- | --- |
| Pixiv 下载、主题发现、排序、调度语义 | **PixivFlow** 仓库 | 本仓库 |
| Telegram 投稿、审核、发布、Bot API | **TelePost** 仓库 | 本仓库 |
| 部署编排、拓扑、平台配置、运维脚本 | **本仓库** | 业务仓库 |
| 角色所有权、状态归属、生命周期语义 | 本仓库 `docs/concepts/` + 矩阵 | 业务代码 |
| preset 定义、支持等级、组合规则 | `docs/reference/architecture-matrix.json` + `docs/architectures/` | README、`fly/*.toml` 注释、compose 注释 |

**禁止为了某个 preset 在业务代码里塞平台判断。** 不要写：

```text
if FLY_IO:        ...
if VPS:           ...
if SINGLE_HOST:   ...
```

业务核心不知道部署平台。平台差异只允许出现在本仓库的部署配置、文档与本文件的契约里。
如果业务代码确实需要一个环境输入，它必须表达为业务语义
（例如 `schedulerRuntime.mode`、`exitWhenIdle`、`watchConfig`），而不是平台名。

---

## 4. Single source of truth

每个概念只能有一个权威来源。出现第二种说法时，以权威来源为准并删除另一个。

| 概念 | 唯一权威来源 | 不允许再声明的地方 |
| --- | --- | --- |
| 角色 / 所有权 | `docs/concepts/roles.md` + 矩阵 `roles` | README、preset 页 |
| Preset 定义与支持等级 | `docs/reference/architecture-matrix.json` | README、`fly/*.toml` 注释、compose 注释、preset 页正文 |
| 生命周期语义 | `docs/concepts/lifecycle.md` | preset 页正文 |
| 状态归属 | `docs/concepts/state.md` | preset 页正文 |
| 调度 / occurrence / 槽位 | `docs/concepts/scheduling.md` | `SCHEDULING.md`（已删除）或任何新文件 |
| 凭据归属与处理 | `docs/concepts/credentials.md` | 任何脚本、任何新文档 |
| Fly 拓扑 | `fly/deploy.pixivflow.toml` + `fly/deploy.telepost.toml`（仅两份） | 第三份 `fly/*.toml` |
| Compose 拓扑 | `docker-compose.yml` | 另一份 compose 变体 |
| 时钟平面 | `control-plane/` | 第二个 Worker、第二份 cron 映射 |
| 部署清单（部署编译器的输入） | `docs/reference/deployment-manifest.md` + 矩阵 `manifest` | 业务代码读取清单、由清单推导平台分支 |
| 部署契约本身 | `docs/reference/deployment-contract.md` | README 里的「另一种说法」 |

`architecture_docs_test.go` 强制：preset 名在矩阵、`docs/architectures/overview.md` 与本文件
三处一致；`stable` preset 必有文档；文档引用的配置文件存在；枚举取值合法；
「唯一生产拓扑」只能有一处声明；`split-worker` 安全契约未被破坏。

---

## 5. 本仓库的文件职责

| 路径 | 是什么 | 不是什么 |
| --- | --- | --- |
| `control-plane/` | cron → schedule id 映射 + 一次带令牌的 POST | 不是第二个调度器，不是审核/发布服务 |
| `fly/deploy.pixivflow.toml` | 执行端（`split-worker`）唯一拓扑来源 | 不包含 Telegram 配置 |
| `fly/deploy.telepost.toml` | 业务端唯一拓扑来源 | 不包含 Pixiv/调度配置 |
| `pixivflow/config/production.json` | 执行端随镜像发布的运行配置 | 不是可热改的运行中状态 |
| `docker/` | 按提交号固定或按发布版本透传的镜像定义 | 不是业务代码 |
| `supervisor/` | `single-machine-worker-sleep` 的常驻进程编排：鉴权后按需 spawn executor，退出后不重启 | 不是业务逻辑：它不知道 schedule 是什么，也不做空闲判定 |
| `scripts/` | 只读运维与验收脚本 | 不写业务状态、不注册 webhook |
| `docs/reference/architecture-matrix.json` | preset / 角色 / 组合 / 档位 / 不变量 / manifest 契约的机器可读权威 | 不是可执行配置 |
| `manifest.go` + `deployment.manifest.json` | 部署清单：读取/推断并对照矩阵校验「这是一套什么部署」 | **不是运行时依赖**：业务代码永不读它 |
| `docs/` | 契约、拓扑与运维说明 | 过时章节必须改，不留「另一种说法」 |

---

## 6. 绝对不要做

1. **不要在这里再实现一遍业务**（occurrence、槽位状态机、租约、凭据下发、审核 FSM、发布）。
   历史上这里曾有一套 D1 影子账本与审核实现，代价是投稿机器人的 webhook 被指到 Worker 上，
   所有用户投稿被「签收后丢弃」——`control-plane/test/no-business-state.test.ts` 会阻止它回来。
2. **不要注册或删除 Telegram webhook**，不要在这里写任何 Telegram 调用。
   `control-plane/test/webhook-ownership.test.ts` 会失败。
3. **不要给 `executor` 配健康检查**：探测请求会唤醒刚刚收工的机器/进程，
   破坏 `stopped` 或「进程已退出」的预期状态。
4. **不要用平台 auto-stop 让 `executor` 停机**：代理看到的是「连接已空闲」，而下载还在跑。
   停机必须由执行端自己的账本决定（`exitWhenIdle`）。
   这条对 `single-machine-worker-sleep` 同样成立，只是对象从机器变成进程。
5. **不要用分支名或浮动 tag 构建生产镜像**：用 40 位提交号或发布 tag
   （`PIXIVFLOW_REF` / `TELEPOST_IMAGE`），否则镜像层缓存会让镜像一直跑旧代码。
6. **不要新增第三份 Fly 配置**：`control-plane/test/deployment-contract.test.ts` 会失败。
7. **不要删掉 `force_https = false`**：Flycast 私网投递会被 301 打断。
   同理 Flycast 投递 URL 不能带 `:8080`。
8. **不要在日志、脚本输出或报告里打印任何密钥**。只输出「已配置 / 缺失 / 就绪」。
9. **不要让业务代码感知部署平台**（见第 3 节）。
10. **不要把尚未实现的 preset 写成可用**。`single-machine-worker-sleep` 当前
    `implemented=false`（supervisor 组件已实现，但缺镜像与平台配置）；改它的文档必须同步改矩阵
    的 `status` 字段。
11. **不要在 `supervisor/` 里实现空闲判定**：停机决策权只属于 executor 自己的账本。禁止写
    「空闲 N 秒就杀掉子进程」这类定时器——它会把下载中的批次截断，而这是本 preset 唯一的致命误配。
12. **不要放宽环境白名单**：传给 executor 子进程的环境是 deny-by-default 白名单
    （`PIXIV_*` / `SCHEDULER_*` / `*_SUBMIT_TOKEN` + 通用运行变量）。`supervisor/child.go` 对
    Telegram 凭据名有第二道拒付检查，改白名单必须同时改测试。

---

## 7. 改完请自证

```bash
go test ./...                                  # 部署工具 + 文档一致性测试
(cd control-plane && npm ci && npm test)       # 时钟的守护测试
./scripts/validate.sh --examples               # 配置/脚本/公开仓库卫生
deploy manifest                                # 当前目录的部署清单：推断 + 对照矩阵校验
deploy manifest --check                        # 有 deployment.manifest.json 时只校验（CI 可用）
./scripts/verify-production.sh                 # 只读生产校验（需要 fly 与网络）
```

改了预设契约（矩阵的 preset / 组合规则 / 档位 / 开关）时必须同步 `manifest.go` 能消费的形状，
并保证 `go test ./...` 里的清单测试通过：它强制内嵌矩阵与仓库里的矩阵逐字节一致、
每条组合规则要么机器可判定要么声明由谁守护。

---

## 8. 已知待办（本仓库范围）

- 部署清单（Phase 2）已完成：`deploy manifest` 是部署编译器的输入。下一步是 Phase 3 的
  `single-machine-worker-sleep` 运行时实现——**必须先有清单，再写编排**，否则会重新出现
  「文档一套 preset、脚本一套 if/else、CLI 第三套判断」。
- `single-machine-worker-sleep` 的 supervisor 组件已实现并有测试（`supervisor/`），但 preset
  **仍不可部署**：缺容器镜像、平台配置与端到端验证。剩下的事见
  [`docs/ROADMAP-MULTI-ARCH.md`](docs/ROADMAP-MULTI-ARCH.md) 的 Phase 3；
  全部验收通过前，矩阵的 `status.implemented` 与 `support` 不许改。
- compose 的默认内存限额（320m + 256m = 576 MiB）与矩阵 `512m` 档（320 + 192）不一致；
  `deploy manifest` 会显式报告该偏差而不抹平。修哪一边需要单独决定，见
  [`docs/reference/deployment-manifest.md`](docs/reference/deployment-manifest.md)。
- `remote-worker` 的端到端验证缺失；`support: beta` 反映的就是这件事。
- 迁移契约已写、迁移工具未实现（`docs/architectures/migration.md` 的「实现状态」一节）。
- PixivFlow 生命周期提交合入并发布后，把 `PIXIVFLOW_REF` 从提交号改为发布 tag。
- `deploy.go` 的 `split` / `source` 子命令已删除（终局决定 = DELETE），请勿重新引入。
- 描述旧的无服务器控制面（Worker + D1 账本、GitHub Actions 执行平面、Fly 合一台）的
  文档与门禁脚本已删除，请勿重新引入。
- TelePost 仓库根目录有它自己的 `AGENTS.md` 职责契约，改动跨仓库边界时先读它；
  PixivFlow 目前没有 `AGENTS.md`，其边界以本仓库 `docs/concepts/roles.md` 为准。
