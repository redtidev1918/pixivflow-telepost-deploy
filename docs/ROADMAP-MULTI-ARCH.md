# Roadmap：多架构部署实现计划

> **本文件是多架构演进的实施计划，不是已完成工作的说明。** Phase 1 交付契约、文档与守护
> 测试；Phase 2 交付部署清单（部署编译器的输入契约）；Phase 3 起才动运行时编排。
> 契约的机器可读权威是
> [`docs/reference/architecture-matrix.json`](https://github.com/redtidev1918/pixivflow-telepost-deploy/blob/main/docs/reference/architecture-matrix.json)。

本轮原则：

```text
先把「有哪些合法架构」定义清楚，再让部署代码实现它们。
```

---

## 现状（Phase 1 结束时的真实状态）

| Preset | 支持等级 | `implemented` | `tested` | `productionProven` | 说明 |
| --- | --- | --- | --- | --- | --- |
| `single-host` | Stable | 是 | 是（CI 覆盖 compose 模型与合体镜像构建） | 否 | 自托管路径 |
| `single-machine-worker-sleep` | Experimental | **否** | 否 | 否 | 只有设计与本文档 |
| `split-worker` | Stable | 是 | 是 | **是** | 当前生产 |
| `remote-worker` | Beta | 是 | 否 | 否 | 配置可行，无端到端证据 |

Phase 1 交付物：架构矩阵、四个 preset 文档、概念/平台/运维文档体系、迁移契约、
`AGENTS.md` 多拓扑契约、`architecture_docs_test.go` 一致性测试、docsify 旧路径别名。
**没有改动**：线上 split-worker 配置、两份 Fly 配置、`control-plane/`、四个只读脚本、
任何 secret、任何生产机器。

---

## Phase 1 —— 文档 / preset / 契约（本轮）

**状态：完成。**

| 交付物 | 位置 |
| --- | --- |
| 机器可读架构矩阵 | `docs/reference/architecture-matrix.json` |
| 部署契约（统一部署模型 + single source of truth 表） | `docs/reference/deployment-contract.md` |
| 架构总览与四个 preset 文档 | `docs/architectures/*.md` |
| 用户选择入口 | `docs/getting-started/choose-architecture.md` |
| 迁移契约 | `docs/architectures/migration.md` |
| Agent 契约 | `AGENTS.md` |
| 文档一致性测试 | `architecture_docs_test.go` |
| 文档信息架构重组与旧路径别名 | `docs/**` + `docs/index.html` |
| 英文镜像 | `README.en.md` + `docs/en/**` |
| 资源档位独立成维 | 矩阵 `resourceProfiles` + `docs/operations/performance.md` |

**验收标准（已满足）**：普通用户打开 README 30 秒知道项目做什么、1 分钟选架构、
3 分钟找到部署入口；Agent 读 `AGENTS.md` + 矩阵即可回答「这个修改属于哪个仓库、
谁拥有这个状态、当前 preset 是否允许机器休眠、谁持有 Telegram token、
scheduler 可不可以多实例、这个配置应该改在哪里」，不需要从十几个文档里猜。

---

## Phase 2 —— 统一 deployment manifest

**状态：完成。** 契约见 [部署清单](reference/deployment-manifest.md)。

**目标**：让一个文件成为「这是一套什么部署」的机器可读声明，程序能读它。

| 项 | 内容 |
| --- | --- |
| 输入 | 矩阵 `presets.*` 的形状（units、rolePlacement、allowed、defaults） |
| 新增 | `deploy manifest` 能从部署目录生成 / 校验一份 manifest（`.env`、compose、Fly 配置为其投影） |
| 命名 | `deployment.manifest.json`（或 `.yaml`，若引入解析依赖） |
| 校验 | manifest 的 preset ∈ 矩阵；开关组合 ∈ `combinationRules`；资源档位 ∈ `resourceProfiles` |
| 不做 | 不改变现有 `deploy.go` 的部署路径；不改变 `fly/*.toml` 与 compose 的角色 |

**验收标准（已满足）**：

- `deploy manifest` 从 `docker-compose.yml` 判定 `single-host`、从两份 Fly 配置判定
  `split-worker`，两者都通过校验；`remote-worker` 与 sleep preset 无法从产物判定，
  必须 `--preset` 显式声明。
- 非法组合校验失败并给出规则 id（例如 `wake-run-exit-without-external-clock`），退出码非 0。
- `deploy doctor` 打印当前目录的部署清单摘要（preset / 平台 / 生命周期 / 档位 / 开关）。
- 矩阵新增可校验契约：每条组合规则要么带机器可判定 `predicate`（11 条），
  要么显式声明由谁守护 `checkableBy`（3 条）；一致性测试强制二者必居其一。
- 副作用：机器校验立刻抓出一处真实不一致——`remote-worker` 的默认 `clock=internal`
  与「取第一个」推出的 `wake-run-exit` 自相矛盾，因此默认生命周期改为矩阵显式声明。

**明确不做**：不把 manifest 作为运行时依赖；业务代码不读它；不实现 sleep worker。

---

## Phase 3 —— `single-machine-worker-sleep` 实现

**状态：进行中（部分完成）。** supervisor 组件与它的测试已落地（`supervisor/`），包括设计文档要求的环境白名单守护测试。**尚未完成**：容器镜像、平台配置、可执行部署步骤与
端到端验证——所以矩阵里 preset 仍是 `implemented=false` / `support=experimental`。

**目标**：把「业务常驻 + 执行进程按需」从设计变成实现，并取得 `tested` 证据。

| 项 | 内容 |
| --- | --- |
| 交付 | 一个常驻 supervisor（TelePost 侧或独立小进程），按触发 spawn PixivFlow 子进程 |
| 退出 | `executor` 只经自己的账本退出（`exitWhenIdle`）；supervisor 不超时杀进程 |
| 健康检查 | **不配置**任何指向 `executor` 触发端口的探测；supervisor 必须区分「正常 `exit(0)`」与「被信号杀死」 |
| 平台 | 优先 Fly.io 1×512 MiB Machine（一台机器、一个卷）；compose 与 systemd 形态随后 |
| 约束 | `download.concurrency=1`；`publisher` 与 `executor` 的内存预算显式声明 |
| 明确禁止 | 机器级 stop / suspend / 平台 auto-stop（commit `a98c3a7` 删除的正是这个） |

**实现前必须回答的问题**：

1. supervisor 如何在机器重启后恢复「哪些触发还没跑」？
   ——答：不恢复。触发是幂等的、由时钟重发；`executor` 的账本决定 occurrence 归属。
2. `executor` 退出后谁持有触发端口？
   ——答：supervisor 反代到 `executor`，触发到来时先 spawn 再转发。
3. 两个 Bot 的 `publisher` 与按需 `executor` 在 512 MiB 下的真实峰值是多少？
   ——答：实现后测量，回填 `docs/operations/performance.md`。

**已完成（有测试守护）**：

- 执行侧容器镜像 `docker/worker-sleep.Dockerfile`（PixivFlow 运行时 + supervisor 二进制，
  无 HEALTHCHECK，CI 构建）；
- supervisor 常驻占住触发端口，鉴权契约与 `split-worker` 执行端一致，迁移时时钟侧不用改；
- 只有通过鉴权的 POST 才 spawn：GET 探测得到 404、错误令牌得到 401，都不会拉起进程；
- 同一时刻只有一个 executor（SI-4），退出后不重启，supervisor 不因空闲杀子进程；
- 能区分正常收工 / 被信号杀死 / supervisor 自己发起的停止三种结局；
- 环境白名单 deny-by-default，真实子进程继承验证，Telegram 凭据被拒付（SI-1）。

**已完成（续）**：

- compose 形态：`docker-compose.worker-sleep.yml` 覆盖层（不是第二份拓扑来源），由
  `scripts/validate.sh` 渲染合并模型并断言「健康检查已禁用、端口分工存在、业务侧未被改动」。

**未完成（因此 preset 仍不可部署）**：

- Fly 1×512 MiB 与 systemd 两种形态都没有配置。Fly 形态需要第三份 `fly/*.toml`，与
  `control-plane/test/deployment-contract.test.ts` 的「只有两份 Fly 配置」冲突；
  要推进就得先决定：是给该契约加一条「仅限矩阵已声明的 preset」的例外，
  还是让 sleep preset 只支持 compose/systemd；
- 端到端验证：`publisher` 常驻下的私聊投稿与 webhook 全程可用、账本空了之后进程退出、
  **触发后立刻探测确认探针没有把子进程拉回来**、机器全程未进入 `stopped`；
- 内存峰值实测（512 MiB 下两个角色的真实占用）。

**转正条件**：上述验收全部通过后，才把矩阵的 `status.implemented` 置为 `true`、
`support` 升为 `beta`。可执行清单与要记录的内存量见
[worker-sleep 端到端验收](operations/worker-sleep-acceptance.md)。**在那之前不要改这两个字段。**

**本轮未能执行端到端验收**：本机没有可用的容器运行时（docker daemon 未运行，
colima/podman/lima 均未安装），本地 `.env` 也只是占位值，因此既跑不了 compose 冒烟，
也拿不到真实 512 MiB 主机与 test bot。`scripts/smoke-worker-sleep-compose.sh` 与验收手册
已经写好，但**尚未运行过**——不把未执行的验证写成已通过。

---

## Phase 4 —— `remote-worker` 验证与转正

**目标**：把 `remote-worker` 从「配置可行」变成「端到端验证过」，`support` 升 `stable`。

| 项 | 内容 |
| --- | --- |
| 场景 | `cloud-to-cloud`（VPS A + VPS B）与 `cloud-to-home`（Fly/VPS + 家用机）各跑一轮 |
| 传输 | 私网叠加网（Tailscale/WireGuard）与公网 HTTPS + bearer 各一轮 |
| 出口资格 | 在 `executor-host` 上对三个 Pixiv 数据面分别取证（OAuth / App API / 媒体 CDN） |
| 故障注入 | 断叠加网后恢复，确认 outbox 自动排空、作品不丢 |
| 文档 | 把实测命令与数值回填 `docs/architectures/remote-worker.md` 与运维文档 |

**验收标准**：

- 两轮场景各完成至少一个完整 occurrence，`publisher` 全程可用。
- 断网恢复后 outbox 排空，`executor` 与 `publisher` 的状态一致。
- 出口取证结果写入文档，含「未确认」项（参照事故记录的写法）。
- 完成后矩阵 `presets.remote-worker.status` 的 `tested` 与 `productionProven` 更新，
  `support` 升为 `stable`。

---

## Phase 5 —— CLI 交互式部署

**目标**：`pixivflow-deploy init` 能按 preset 生成整套部署材料。

```text
$ pixivflow-deploy init

Where are you deploying?

1. One VPS / server            (single-host)
2. One low-memory machine      (single-machine-worker-sleep)
3. Fly.io split architecture   (split-worker)
4. Remote worker               (remote-worker)
```

然后按选择生成：

| 生成物 | 说明 |
| --- | --- |
| `.env` | 只含该 preset 需要的键，带占位符与注释 |
| compose / Fly 配置 | 按平台生成，符合两份 Fly 配置契约 |
| Cloudflare 配置 | 仅 `clock=cloudflare` 时生成 `control-plane` 部署指引 |
| resource profile | 按档位写入 `TELEPOST_MEMORY_LIMIT` / `PIXIVFLOW_MEMORY_LIMIT` |
| manifest | Phase 2 的 manifest 文件，声明 preset 与开关 |
| 迁移提示 | 若检测到已有部署目录，输出 [迁移契约](architectures/migration.md) 的对应路径 |

**约束**：

- 交互向导在非交互（管道/CI）时保持全静默，只生成占位配置（沿用现有 `deploy init` 行为）。
- 不在任何输出里打印或回显凭据。
- 每个选项都链接到对应 preset 文档，不允许出现「文档没写的选项」。
- 不生成尚未实现的 preset 的配置（Phase 3 完成前，选项 2 显示为「设计中的 preset」并拒绝生成）。

---

## 跨阶段的不变量（任何 Phase 都不许破坏）

| 不变量 | 为什么 |
| --- | --- |
| 当前线上 `split-worker` 保持可用 | 生产在跑；任何阶段都不做破坏性迁移 |
| 两份 Fly 配置仍是唯一 Fly 拓扑来源 | `control-plane/test/deployment-contract.test.ts` 守护 |
| `executor` 不持有 Telegram 凭据（`split-worker` / `remote-worker`） | webhook 归属与审核边界的根基 |
| 停机决策权归 `executor` 自己的账本 | 平台 auto-stop 与健康检查都会截断批次 |
| 每套 schedule 只有一个时钟 | 重复触发幂等，凭据争用不是 |
| 业务代码不感知部署平台 | 平台差异只属于部署层 |
| 每个概念只有一个权威来源 | 否则文档再次漂移 |
| 支持等级必须诚实 | `documented` / `implemented` / `tested` / `productionProven` 分开声明 |

---

## 不计划做的事

| 不做 | 原因 |
| --- | --- |
| Kubernetes / Helm | 没有用户场景；四个 preset 覆盖的是 1–2 台机器 |
| 自动在 preset 之间迁移的工具 | 迁移是低频人工操作，契约比工具更持久（见迁移契约的「实现状态」） |
| 第五个「混合云」preset | 它是 `remote-worker` 的 placement 选择；多一个 preset 就多一组要验证的组合 |
| 把 `review` 做成可关闭的开关 | 未经人工批准就发布超出产品契约 |
| 在业务代码里加平台判断 | 见 AGENTS.md 第 3 节 |
