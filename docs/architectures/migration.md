# 架构迁移契约

**本文件是 preset 之间迁移的权威描述。第一阶段只写契约，不实现迁移工具。**

迁移之所以可行，是因为四个 preset 共享同一套业务语义与同一套状态格式：
迁移是**搬状态**，不是改业务。任何需要改业务语义才能完成的「迁移」，实际上是换产品，
不在这份契约的范围内。

机器可读定义见
[`architecture-matrix.json`](https://github.com/redtidev1918/pixivflow-telepost-deploy/blob/main/docs/reference/architecture-matrix.json)
里每个 preset 的 `migration` 字段。

---

## 迁移路径

```text
single-host
    ↕
single-machine-worker-sleep          （未实现，先读该 preset 的状态字段）
    ↕
split-worker            ←→            remote-worker
```

所有边都是双向的。下表是每一对迁移的本质区别。

| 迁移 | 变化的维度 | 不变化的维度 |
| --- | --- | --- |
| `single-host` ↔ `single-machine-worker-sleep` | 进程编排（常驻容器 → 按需子进程） | 数据位置、卷数、平台 |
| `single-host` ↔ `remote-worker` | 主机数、传输方式 | 角色归属、状态格式 |
| `single-host` ↔ `split-worker` | 主机数、物理卷数、时钟提供方、主机级凭据隔离 | 角色归属、状态格式 |
| `single-machine-worker-sleep` ↔ `split-worker` | 机器数、卷数、谁负责唤醒与停机 | 角色归属、状态格式 |
| `split-worker` ↔ `remote-worker` | 平台与传输方式 | 主机数、卷数、生命周期 |

---

## 必须迁移的数据

数据清单按**拥有它的角色**分组。搬错归属会造成两个角色读写同一份状态。

| 数据 | 拥有者 | 当前位置 | 迁移要求 |
| --- | --- | --- | --- |
| 槽位账本 `pixivflow.db` | `executor` | 执行端卷 | 停机后整体搬运；搬完确认 `schedule_slots` 与 `schedule_slot_items` 行数一致 |
| 下载缓存与元数据 | `executor` | 执行端卷 | 可搬可弃；弃掉只会重下，不会丢作品 |
| 投递 outbox（含 manifest 与引用文件） | `executor` | 执行端卷 | **必须搬**。未投递作品只存在于 outbox；漏搬等于丢作品 |
| Pixiv 凭据材料与限流状态 | `executor` | 执行端卷 + 平台 secret | 凭据按平台 secret 逐项重设；限流状态随卷搬 |
| 每 Bot SQLite | `publisher` | 业务端卷 `data/bot{N}/` | **必须搬**。投稿幂等键与审核队列都在这里 |
| 运行策略覆盖 `runtime-policy.json` | `publisher` | 业务端卷 `data/bot{N}/` | 必须搬；不搬则回落到 `.env` 的部署默认值 |
| 已发布记录 | `publisher` | 与每 Bot SQLite 同库 | 随库搬；它是「同一作品不重复发布」的依据 |
| 触发令牌 | `clock` + `executor` | 两端 secret | 不是数据迁移，是重新对齐；两端必须一致，否则触发全部 401 |

### 迁移顺序

1. **停写**：停止 `executor`，确认没有非终态 slot、没有处理中的投递项。
2. **搬 `executor` 状态**：卷或目录整体复制。outbox 引用的文件必须与 manifest 一起过去。
3. **搬 `publisher` 状态**：每 Bot 目录整体复制（SQLite 连同 `-wal`/`-shm`）。
4. **重设凭据**：按新目标的 secret 存储逐项设置。永远不要为了让某一步通过而把凭据落盘。
5. **先起 `publisher`**：确认私聊投稿、审核按钮、发布链路可用，再起 `executor`。
6. **起 `executor`**：确认它读到了正确的账本，并能投递到 `publisher`。
7. **对齐时钟**：确认只有一个时钟在触发这套 schedule，且它与 `executor` 的触发令牌一致。
8. **删旧**：确认新拓扑跑完至少一个完整 occurrence 之后再拆除旧组件。

**先复制，后删除。** 这个顺序来自 commit `539befd` 的教训：一次复制不会丢凭据，
一次执行到一半的 rename 会。

---

## 不需要迁移的内容

| 项 | 原因 |
| --- | --- |
| 容器文件系统 | 不在卷上的内容本来就是临时的 |
| 临时媒体文件 | 投稿进审核群后原图即被删除，本地不保留 |
| 构建缓存 | 与运行状态无关；迁移后重新构建 |
| 镜像 | 新目标重新 `pull`/`build`，不做镜像搬运 |
| 日志 | 运维材料，不是状态 |
| `.env` 本身 | 按新目标的键名重写；旧文件可能含已失效的键 |

**判断标准：** 如果一个文件丢失后「重跑一次就能恢复」，它就不是状态。
如果丢失后「永远无法恢复」，它必须迁移。

---

## 迁移前后必须成立的检查

| 检查 | 为什么 |
| --- | --- |
| `executor` 里没有任何 Telegram 令牌或频道 ID | 迁移到 `split-worker`/`remote-worker` 时这是硬边界；迁回共置 preset 时这条检查不再适用，但不应因此把令牌留在执行端配置里 |
| `publisher` 是唯一的 Telegram webhook owner | 换主机、换域名都要重新注册 webhook，注册者只能是 `publisher` |
| 只有一个时钟 | 迁移期最容易出现「新旧时钟同时还在触发」 |
| `executor` 自己的账本是唯一停机决策者 | 换平台后不要顺手加上平台 auto-stop 或健康检查 |
| 配置里的存储路径仍是相对的 | 换主机后绝对路径会被改写回默认值，落到卷外 |
| 投递的鉴权仍然启用 | 从公网换成私网时最容易忘；私网不等于已认证 |

---

## 迁移期不要做的事

```text
✗ 让新旧两套同时跑完整的生产 schedule
    → 两个 execution 抢同一个 Pixiv 凭据，表现为限流与 penalty 升级
✗ 在新拓扑上补跑迁移期间错过的时间点
    → 本部署的策略是 catchUpMissedRuns = false；补跑等于把昨天的内容当成今天的推给用户
✗ 为了省内存删掉 outbox 或下载缓存
    → 表面稳定，实际丢作品。要省内存就升档位
✗ 在新平台加健康检查或 auto-stop「先跑通再说」
    → 两者都会破坏 lifecycle 契约，且症状是间歇性的
✗ 用平台 secret 之外的地方传凭据（文件、镜像、日志、artifact）
    → 见 credentials.md 的四条不变量
```

---

## 实现状态

| 能力 | 状态 |
| --- | --- |
| 迁移契约（本文件） | 完成 |
| 状态清单与归属 | 完成 |
| 逐 preset 的迁移步骤 | 完成 |
| 迁移工具 / 命令 | **未实现** |
| 迁移前的自动一致性检查 | **未实现**（现有 `scripts/validate.sh` 只做配置级校验） |

后续实现计划见 [ROADMAP-MULTI-ARCH.md](../ROADMAP-MULTI-ARCH.md)。
