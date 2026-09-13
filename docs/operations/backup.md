# 备份与恢复

本页是**备份契约**的唯一权威说明：备份什么、绝不备份什么、SQLite 在 WAL 活跃时怎么安全
快照、恢复的顺序。持久状态的完整清单（谁写什么、写在哪里）见 [持久状态](../concepts/state.md)，
本页不重复其内容。预设的卷布局以
[architecture-matrix.json](https://github.com/redtidev1918/pixivflow-telepost-deploy/blob/main/docs/reference/architecture-matrix.json)
为准。

**非目标（明确写下来）：本阶段只定义契约，仓库里还没有迁移或备份工具。** 没有
专用的备份脚本，没有 `deploy backup` 子命令，也没有自动快照。下面全部是人工可执行的
步骤与其判据。不要因为本页存在就以为有一个工具在跑。

## 按预设划分的备份对象

备份对象按 `state` 角色的实际持有者组织，而不是按目录名。

| 预设 | `state` 布局 | 必须备份 | 实际路径 |
|---|---|---|---|
| `single-host` | 共享卷，按角色分目录 | TelePost 每 Bot 目录 + PixivFlow 目录 | `./data/bot{N}/`、`./data/pixivflow/`（Compose 把 `./data` 挂到 `/app/data`） |
| `single-machine-worker-sleep` | 同一个卷，按角色分目录 | 同上 | `./data/bot{N}/`、`./data/pixivflow/`（Fly 上是卷 `data` 挂到 `/app/data`） |
| `split-worker` | 各单元自带卷 | 业务卷的 `bot{N}/`；执行卷的 `pixivflow/`。两卷分别备份，不合并 | 业务机 `/app/data/botN/`（卷 `data`）；执行机 `/app/data`（卷 `pixivflow_data`） |
| `remote-worker` | 每宿主一个卷 | 同 `split-worker`，按宿主分别取 | 服务宿主卷 `bot{N}/`；执行宿主卷 `pixivflow/` |

### level-1 明细：`state` 角色持有的卷内容

| 所在卷 | 内容 | 丢了会怎样 |
|---|---|---|
| PixivFlow 卷 | `pixivflow.db`（槽位账本、执行租约、投递 outbox、幂等记录） | 账本丢失 = 无法判断哪个 occurrence 已经跑过；可能重复执行或永远不补跑 |
| PixivFlow 卷 | `downloads/`（下载缓存） | 缓存可重建，但重建要重新访问 Pixiv，代价是配额与限流风险 |
| PixivFlow 卷 | outbox 清单（投递记录与其 `kind`） | 已下载但未成功投递的作品失去重试依据 |
| PixivFlow 卷 | `config.json`（Compose/systemd 自托管路径的运行配置） | 只能从仓库模板重建，本机 target/schedule 改动会丢 |
| TelePost 卷 | 每 Bot 目录 `data/bot{N}/` 下的 SQLite（审核状态机、投稿记录、幂等记录） | 用户投稿的处理状态丢失，pending 稿件无法再被审核 |
| TelePost 卷 | 每 Bot 目录下的 `runtime-policy.json`（`/botconfig` 写入的运行策略覆盖） | 回到环境变量默认值：频道、审核群、审核开关全部回退 |
| TelePost 卷 | 每 Bot 目录下的搜索索引目录 | 可重建，重建期间搜索不可用 |

同一份清单的角色归属、`state` 取值（`own-volume` / `own-volume-subdirectory`）与
「卷从不在角色之间共享」这条不变量见 [持久状态](../concepts/state.md) 与
[部署契约](../reference/deployment-contract.md)。

## 绝不备份的东西

| 不要备份 | 原因 |
|---|---|
| 容器文件系统（镜像层、`/app` 下的非卷路径） | 镜像本身按不可变引用重建；容器文件系统随容器消失，它从来不是状态 |
| 临时媒体（上传后进入审核群即从运行机器删除的原始投稿文件） | 契约就是「不把原图堆在持久卷上」；备份它等于把已经放弃的副本重新引入 |
| 构建缓存（`node_modules`、npm/Docker 层缓存） | 可从 `PIXIVFLOW_REF` / `TELEPOST_IMAGE` 完整重建 |
| `.env`、平台 secret（token、订阅 URL） | 凭据不进备份。按 [凭据契约](../concepts/credentials.md) 走各自平台的 secret 机制重新下发 |

`state` 角色在 [architecture-matrix.json](https://github.com/redtidev1918/pixivflow-telepost-deploy/blob/main/docs/reference/architecture-matrix.json)
里的 `neverOwns` 已经列出后三项，本表只是把它落到操作上。

## SQLite 安全

`pixivflow.db` 与每 Bot 的 SQLite 都可能在 WAL 模式下被写。规则只有两条：

1. **优先在卷级别做快照**（Fly 卷快照、宿主 LVM/ZFS/btrfs 快照、`docker run --volumes-from`
   的整卷 `tar`），让 SQLite 看到的是一次一致的文件视图。
2. **没有卷快照能力时，必须把 `-wal` 与 `-shm` 和主文件一起拷走。** 只拷 `pixivflow.db`
   会得到一个缺了最新提交的数据库，甚至是一个需要 WAL 才能打开的半份状态。

```bash
# 错：单独拷一个正在被写的数据库文件
cp data/pixivflow/pixivflow.db /backup/

# 对：三件套一起，且在同一个原子动作里
tar -C data/pixivflow -cf /backup/pixivflow-$(date +%Y%m%dT%H%M%S).tar \
    pixivflow.db pixivflow.db-wal pixivflow.db-shm 2>/dev/null || \
tar -C data/pixivflow -cf /backup/pixivflow-$(date +%Y%m%dT%H%M%S).tar pixivflow.db
```

没有 `-wal`/`-shm` 文件时说明当前没有未落盘的 WAL，上一条命令的 `||` 分支就是正常路径。
拷完之后校验一次可打开：

```bash
sqlite3 /backup/pixivflow.db 'PRAGMA integrity_check;'      # 期望 ok
```

## 清理工具不得删除仍被引用的文件

缓存清理与 outbox 是两个独立的生命周期：`cacheRetentionDays` / `cacheMaxSizeMB` 管下载缓存，
outbox **独立保留**，不参与缓存清理。因此：

- 任何按时间或容量清理下载缓存的动作，都必须先确认该文件没有被 outbox 中未完成的投递记录引用。
- 删除 outbox 记录不是「清理」，是丢弃重试依据。看到 outbox 计数上升先读清单里的 `kind`，
  再判断那是媒体投递还是无候选通知，见 [troubleshooting.md](troubleshooting.md)。
- 反向也成立：不要为了降低下载缓存占用而清空 outbox，也不要为了清空 outbox 而删缓存。

## 恢复流程

顺序不是风格问题，是依赖问题：状态先回来，凭据后下发，最后才启动会写状态的进程。

1. **停写者。** 停止执行端（`fly machine stop`、`docker compose stop pixivflow` 或
   `sudo systemctl stop` 对应的执行单元），并确认它是 stopped 而不是靠探测保持空闲。
   业务端可以保持运行，但恢复期间不要让人提交新投稿。
2. **恢复状态。** 把卷快照还原到原路径：PixivFlow 卷的 `pixivflow.db`（含 `-wal`/`-shm`，
   如果有）、`downloads/`、outbox 与 `config.json`；业务端卷的 `data/bot{N}/`。
   还原后用 `sqlite3 ... 'PRAGMA integrity_check;'` 校验，再对 `pixivflow.db` 与每 Bot 的
   SQLite 各校验一次。
3. **下发凭据。** 按平台重新注入（Fly secrets、`docker-compose` 的 `.env`、systemd 的
   `EnvironmentFile`）。只注入，不回显：任何输出都不得包含凭据值。
4. **先启动 publisher，再启动 executor。** 先起 TelePost，等 `/ready` 返回 200（不是只有
   `/health` 200）——`/ready` 才对子 Bot 完成初始化做门禁。再起执行端；如果它是
   `wake-run-exit` 拓扑，不要手动常驻，让它由时钟唤醒。
5. **核对。** 触发一次计划跑通一条完整链路：`/health` 的 `storage.review_queue` 出现一条
   pending，审核群收到消息；然后执行端按自己的账本自行退出。

Fly 卷快照（只读操作，用于取证或还原前确认）：

```bash
fly volumes list -a pixivflow-scheduler
fly volumes snapshots list <volume-id>
```

## 恢复之后必须复核的四件事

| 检查 | 期望 |
|---|---|
| 执行端是否回到 `stopped` | 是。恢复期间手动启动过也一样，账本空了就退出 |
| 执行端 `restart.policy` | `no`（Fly 的 Machines API 拼写）/ `never`（`fly.toml` 拼写），两者是同一件事 |
| 业务端 `/ready` 与 `storage.review_queue` | `/ready` 返回 200；pending 计数与快照一致，不凭空增多或消失 |
| Telegram webhook 归属 | 仍指向 TelePost，用 `scripts/verify-webhooks.sh`（需要 `BOT*_TOKEN`） |

看 [monitoring.md](monitoring.md) 的只读脚本一节：

```bash
./scripts/verify-production.sh
./scripts/smoke-telepost.sh
```

`SKIP` 不等于已验证：需要凭据的那几段必须真的跑过一次，才算备份/恢复完成。
