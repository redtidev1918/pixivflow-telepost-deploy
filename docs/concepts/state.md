# 持久状态：谁持有、放在哪里、什么不算状态

> **本页是「什么是持久状态、谁拥有它、它落在哪个卷、什么绝不能被当作状态」的唯一权威描述。**
> 它是逻辑角色 `state`（`kind: capability`）的文字展开，与部署形态无关：切换 preset 只改变
> 状态的**落点**，不改变**归属**。机器可读的定义（`roles[]` 的 `state`、每个 preset 的
> `rolePlacement.state` 与 `stateLayout` 枚举）以
> [architecture-matrix.json](https://github.com/redtidev1918/pixivflow-telepost-deploy/blob/main/docs/reference/architecture-matrix.json)
> 为准。备份与恢复的可执行步骤见 [backup.md](../operations/backup.md)，本页不重复操作细节。

## 一句话定义

**只有「换一台机器、换一个卷之后业务必须重新读到的那部分」才是状态。**
判断方法：把容器文件系统整个丢掉、只保留卷，业务能否无歧义地继续？能，则卷里的是状态；
不能，则卷或状态清单缺了东西。反过来，容器文件系统里的任何东西都不在状态清单里——它随容器消失。

## 状态清单（按角色归属）

| 角色 | 状态内容 | 谁写它 | 丢了会怎样 |
| --- | --- | --- | --- |
| `executor` | 槽位账本（occurrence、slot、cell 与其状态） | PixivFlow | 无法判断哪个 occurrence 已经跑过；可能重复执行或永不补跑 |
| `executor` | 执行租约与限流/退避状态 | PixivFlow | 退出判定失准；唤醒后重复占用 Pixiv 配额 |
| `executor` | 投递 outbox（含每条记录的 `kind` 与引用文件） | PixivFlow | 已下载但未成功投递的作品失去重试依据 |
| `executor` | 下载缓存与元数据 | PixivFlow | 缓存可重建，但重建要重新访问 Pixiv，代价是配额与限流风险 |
| `executor` | 自托管路径的运行配置 `data/pixivflow/config.json` | 部署者 | 只能从仓库模板重建，本机 target / schedule 改动会丢 |
| `publisher` | 每 Bot SQLite（审核队列、投稿记录、幂等记录、审计） | TelePost | 用户投稿的处理状态丢失，pending 稿件无法再被审核 |
| `publisher` | 每 Bot 运行策略覆盖 `data/bot{N}/runtime-policy.json` | TelePost（OWNER 经 `/botconfig`） | 回到 `.env` 默认：频道、审核群、审核开关全部回退 |
| `publisher` | 每 Bot 搜索索引目录 | TelePost | 可重建；重建期间搜索不可用 |

`clock`、`telegram-ingress`、`network` 不持有状态：cron → scheduleId 映射是配置，webhook 归属是
平台侧状态，出口是可替换能力。它们的存在意义是「让状态的所有者能被触发／能把结果送出去」。

## 按 preset 的落点

同一份状态，在四个 preset 里落在不同位置。**归属不变，落点可变。**

| Preset | 布局 | `state` 实际路径 | 卷级隔离 |
| --- | --- | --- | --- |
| `single-host` | 一个卷，按角色分子目录 | `./data/bot{N}/`、`./data/pixivflow/` | **无**（`shared-volume`） |
| `single-machine-worker-sleep` | 一个卷，按角色分子目录 | 同上（Fly 上是卷 `data` → `/app/data`） | **无**（`shared-volume`） |
| `split-worker` | 两个卷，一机一个，从不共享 | 业务机 `/app/data/bot{N}/`；执行机 `/app/data`（卷 `pixivflow_data`） | 有（`own-volume`） |
| `remote-worker` | 每宿主一个卷 | 业务主机卷 `bot{N}/`；执行主机卷 `pixivflow/` | 有（`own-volume`） |

枚举值 `stateLayout` = `own-volume` \| `own-volume-subdirectory` \| `shared-volume` \| `none`，
定义在矩阵 `enums.stateLayout`。

## 不变量：卷是状态边界，绝不共享

`executor` 与 `publisher` **绝不共享同一个状态卷**。矩阵把 `shared-volume-between-roles` 列为
`invalid` 组合，理由是：

- 共用卷会让两个角色**一起可恢复、一起损坏**，故障隔离消失——这正是 `split-worker` 存在的意义。
- 一个角色写坏共享目录会直接破坏另一个角色的状态。
- 恢复顺序（先状态、后凭据、最后启动写者）在共享卷上无法按角色执行。

`single-host` 与 `single-machine-worker-sleep` 使用**一个卷**，这是它们的已知限制，而不是判据：
矩阵在 `combinationRules.supportedWithLimitations` 的 `co-located-roles` 里明确记录了它，
并说明「split-worker 的凭据边界在这些 preset 下不成立」。共置是物理事实，不是语义合并
（见 [roles.md](./roles.md)）。

## 绝不视为状态的东西

| 不要当状态 | 原因 |
| --- | --- |
| 容器文件系统、镜像层、`/app` 下的非卷路径 | 随容器消失；镜像按不可变引用重建 |
| 构建缓存（`node_modules`、npm/Docker 层缓存） | 从 `PIXIVFLOW_REF` / `TELEPOST_IMAGE` 完整重建 |
| 临时媒体（投稿进入审核群后即从运行机器删除的原始文件） | 契约就是不把原图堆在持久卷上；备份它等于把已放弃的副本重新引入 |
| `.env`、平台 secret、token、订阅 URL | 凭据不进状态，也不进备份；见 [credentials.md](./credentials.md) |
| 运行中环境变量、内存里的队列 | 重启即失；任何依赖它「重启后还在」的设计都是假象 |

矩阵里 `state` 角色的 `neverOwns` 列出后三类，本表只是把它落到判断上。

## 与备份的关系

状态是备份的**唯一**对象集。备份契约（备份什么、绝不备份什么、SQLite 在 WAL 活跃时如何安全快照、
恢复顺序）见 [backup.md](../operations/backup.md)。一句话原则：**卷快照是唯一手段；容器文件系统从
来不是备份的候选。**

## 促成这条契约的历史故障

状态一度被写进过「不属于它的地方」：早期控制面是一个 Cloudflare Worker，带 D1 影子账本与
一套 Worker 内实现的审核状态机。于是同一份「投稿该不该发」的答案在两个地方各存一份，两个
实现都「看起来在工作」。那次收敛（commit `0f90451`）删除了 Worker 里的全部业务状态，随后
commit `a98c3a7` 删除了与之配套的一次性执行平面。守护测试
`control-plane/test/no-business-state.test.ts` 存在的目的就是阻止「第二份状态」回来。

长期规则与拓扑无关：**每一份状态只有一个所有者，落点可以换，所有者不能多。**

## 相关页面

- 角色所有权：[roles.md](./roles.md)
- 谁能睡、谁唤醒：[lifecycle.md](./lifecycle.md)
- 登录凭据与触发令牌的归属：[credentials.md](./credentials.md)
- 投递 outbox 的语义：[delivery.md](./delivery.md)
- 备份与恢复步骤：[backup.md](../operations/backup.md)
- 资源档位与内存预算：[../operations/performance.md](../operations/performance.md)
