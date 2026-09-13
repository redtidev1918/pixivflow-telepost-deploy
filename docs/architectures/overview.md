# 部署架构总览（Preset 矩阵）

**本文件是人读的架构索引。机器读的那份是
[`docs/reference/architecture-matrix.json`](https://github.com/redtidev1918/pixivflow-telepost-deploy/blob/main/docs/reference/architecture-matrix.json)，
两者由 `architecture_docs_test.go` 强制一致。**

一句话前提：**核心业务模型只有一套，部署拓扑可以有多种合法实现。**

```text
逻辑架构（不变）        部署拓扑（可选）        资源档位（可选）      平台（可选）
谁拥有哪个决策     ×   角色跑在哪里、     ×   每个运行单元     ×   谁执行这个拓扑
                     谁能休眠、谁唤醒           分配多少内存
```

四个维度互相独立。`docs/concepts/roles.md` 定义第一维，本文件与四个 preset 页定义第二维，
`docs/operations/performance.md` 与 `docs/reference/environment.md` 定义第三维，
`docs/platforms/` 定义第四维。

---

## 支持的 preset

| Preset | 支持等级 | 实现状态 | 一句话 | 文档 |
| --- | --- | --- | --- | --- |
| `single-host` | Stable | 已实现、CI 覆盖、未在生产验证 | 一台机器跑全部角色，两个容器共享一个 data 目录 | [single-host.md](single-host.md) |
| `single-machine-worker-sleep` | Experimental | **组件已实现，preset 不可部署** | 一台机器：业务常驻，执行进程按需拉起、空闲即退出 | [single-machine-worker-sleep.md](single-machine-worker-sleep.md) |
| `split-worker` | Stable | 已实现、已测试、**当前生产** | 执行端与业务端各自一台机器、各自一个卷 | [split-worker.md](split-worker.md) |
| `remote-worker` | Beta | 已实现、未经端到端测试 | 两个角色跨机器跨网络通信 | [remote-worker.md](remote-worker.md) |

支持等级与实现状态是两个不同的东西，永远不要合并成一个词：

| 支持等级 | 含义 |
| --- | --- |
| `stable` | 契约冻结；可以依赖它的行为。矩阵强制要求 `stable` 必须 `implemented` 且 `tested`。 |
| `beta` | 已实现，接口可能调整，缺少端到端验证证据。 |
| `experimental` | 设计存在，实现可能不存在。使用前先读矩阵里的 `status`。 |
| `deprecated` | 保留说明与迁移路径，不再修复。当前没有 preset 处于该等级。 |

| 实现状态字段 | 含义 |
| --- | --- |
| `documented` | 有可执行的文档，不含未定义行为。 |
| `implemented` | 本仓库里存在真实配置或代码路径。 |
| `tested` | CI 或脚本会验证它，且该验证**能失败**。 |
| `productionProven` | 有真实生产流量跑过。 |

---

## 角色跑在哪里

角色 id 与 `docs/concepts/roles.md` 一致：`clock`、`executor`、`publisher`、`telegram-ingress`、`state`、`network`。

| Preset | `clock` | `executor` | `publisher` | `telegram-ingress` | 状态布局 | executor 持有 Telegram 凭据（SI-1） | 主机级凭据隔离 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `single-host` | 机器内 `internal` | 同机容器，常驻 | 同机容器，常驻 | 同机，webhook 或 polling | 共享卷，角色子目录互不相交 | **否** | **否** |
| `single-machine-worker-sleep` | 机器内 `internal` | 同机子进程，按需 | 同机，常驻 | 同机，webhook 或 polling | 共享卷，角色子目录互不相交 | **否** | **否** |
| `split-worker` | Cloudflare（`cloudflare`） | 独立机器，`wake-run-exit` | 独立机器，常驻 | 业务机上，webhook 或 polling | 两个卷，一机一个 | **否** | **是** |
| `remote-worker` | `internal` / `cloudflare` / `external` | 独立主机，`wake-run-exit` 或常驻 | 独立主机，常驻 | 业务机上，webhook 或 polling | 每个主机一个卷 | **否** | **是** |

**共置是物理事实，不是语义合并。** 即使 `single-host` 把两个角色放进同一台机器，
`executor` 也不因此获得审核或发布权，`publisher` 也不因此获得 Pixiv 登录或槽位调度权。
见 [roles.md](../concepts/roles.md)。

---

## 功能开关

架构 preset 决定骨架，功能开关决定细节。开关不能改变角色归属。

| 开关 | 取值 | 默认 | 说明 |
| --- | --- | --- | --- |
| `clock` | `internal` \| `cloudflare` \| `external` | `internal` | 谁决定「什么时候跑」 |
| `telegramIngress` | `webhook` \| `polling` | `polling` | 谁决定 Telegram 怎么进来 |
| `network` | `direct` \| `proxy` | `direct` | 出口是否经代理 |
| `bots` | `1..N` | `2` | 每个 Bot 一个受监督进程 |
| `search` | `enabled` \| `disabled` | `disabled` | 搜索索引与分词词典 |
| `review` | `enabled`（固定） | `enabled` | 人工审核是产品契约，不是开关 |

`review` 只有合法取值一个。`review.enabled=false` 是**非法组合**，不是可选项——见下节。

---

## 合法组合

不是所有组合都成立。本仓库只承认矩阵中列出的组合，用户不需要自己猜。

### SUPPORTED

| 条件 | 为什么成立 |
| --- | --- |
| `clock=internal` 且执行端常驻或按需 | 拥有时钟的进程是常驻的，cron 到点一定有一个活着的执行端 |
| `clock=cloudflare\|external` 且执行端 `wake-run-exit` | 触发请求就是启动机器的人，停机由执行端自己的账本决定 |
| 使用独立代理单元 | 代理有自己的内存预算，不与其他角色争抢 |

### SUPPORTED_WITH_LIMITATIONS

| 条件 | 限制 |
| --- | --- |
| `telegramIngress=webhook` 但没有公网 HTTPS 入口 | 需要隧道或反向代理；否则改用 polling |
| `bots>=3` 且某个单元预算 512 MiB | 每个 Bot 一个进程，内存线性增长，不升级档位会 OOM |
| `single-host` / `single-machine-worker-sleep` | 主机级凭据隔离不成立（同机共享环境）；executor 单元仍不接收 Telegram 凭据（SI-1 全局成立） |
### EXPERIMENTAL

| 条件 | 说明 |
| --- | --- |
| `single-machine-worker-sleep` 的任何组合 | 该 preset 有设计、无实现 |

### INVALID

| 条件 | 为什么非法 |
| --- | --- |
| 执行端 `wake-run-exit` + `clock=internal` | 停止的进程无法触发自己的 cron，没有任何东西会唤醒它 |
| `review.enabled=false` | 未经人工批准就发布，超出产品契约 |
| 两个角色写同一个状态命名空间（即使共用物理卷） | 共享物理卷 + 互不相交的角色子目录合法；命名空间重叠才非法（SI-7） |
| `search=enabled` 且同一单元同时跑执行端、预算 512 MiB | 分词词典加下载器超出预算 |
| 内置代理 + `256m` 档 | 代理本身就要 50–100 MiB |
| 同一套 schedule 有两个时钟在触发 | 重复触发是幂等的，凭据争用不是 |
| 任何 preset 下 executor 持有 Telegram 令牌/频道 ID/webhook secret | 它就会成为 webhook owner 候选，并能绕过审核发布（SI-1 全局成立） |

---

## 平台支持

| 平台 | 支持的 preset | 文档 |
| --- | --- | --- |
| Docker Compose | `single-host`、`single-machine-worker-sleep`、`remote-worker` | [docker.md](../platforms/docker.md) |
| Fly.io | `single-machine-worker-sleep`、`split-worker`、`remote-worker` | [flyio.md](../platforms/flyio.md) |
| systemd（Linux 裸机） | `single-host`、`single-machine-worker-sleep`、`remote-worker` | [vps.md](../platforms/vps.md) |
| Cloudflare Workers | `split-worker`、`remote-worker` 的时钟平面 | [cloudflare.md](../platforms/cloudflare.md) |

`split-worker` 的参考实现是 Fly.io，但「分离执行端」这个拓扑本身不绑定平台；
平台支持表列的是**本仓库已经写好的配置**，不是拓扑的能力上限。

---

## 互不相同的两个省钱维度

```text
进程休眠 ≠ 机器休眠
省内存   ≠ 省计算账单
```

这两句话决定了 `single-machine-worker-sleep` 与已删除的机器级 auto-stop 拓扑完全不是一回事。
`executor` 进程退出只释放内存；机器仍在计费。要让计算账单下降，必须让**机器**进入
`stopped`，那属于 `split-worker`，并且必须由外部时钟唤醒、由执行端自己的账本决定停机。
见 [lifecycle.md](../concepts/lifecycle.md)。

---

## 迁移

四个 preset 之间可以互相迁移，数据需求写在 [migration.md](migration.md)。
所有 preset 共享同一套业务语义与同一套状态格式，所以迁移是搬状态，不是改业务。
