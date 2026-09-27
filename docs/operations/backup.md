# 备份与恢复

本页是**备份契约**的唯一权威说明：备份什么、绝不备份什么、SQLite 在 WAL 活跃时怎么安全
快照、恢复的顺序。持久状态的完整清单（谁写什么、写在哪里）见 [持久状态](../concepts/state.md)，
本页不重复其内容。预设的卷布局以
[architecture-matrix.json](https://github.com/redtidev1918/pixivflow-telepost-deploy/blob/main/docs/reference/architecture-matrix.json)
为准。

**现在的状态（明确写下来）：契约 + 一个手动导出脚本，仅此而已。** 有
`scripts/export-volume-backup.sh`（operator-run，见下文「导出脚本」）；没有 `deploy backup`
子命令，没有调度、没有 cron、没有自动快照，也没有任何把导出包送出 Fly 的机制。
导出包新不新，完全取决于人有没有敲那条命令。不要因为本页存在就以为有一个东西在自动跑。

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

## 导出脚本：`scripts/export-volume-backup.sh`

为什么存在：Fly 卷快照只保留 5 份（两个卷的 `snapshot_retention` 都是 5，约 5 天），
比静默损坏的发现周期短，而且 Fly 之外没有任何副本。这个脚本补上「一份离开 Fly 的拷贝 +
一份可复核的逐文件清单」。它**只读**生产：不写不删 `/app/data` 下的任何东西，不
start/stop 机器。

```bash
# 业务卷（机器常驻，直接跑）
./scripts/export-volume-backup.sh --plane telepost

# 执行卷（机器设计态是 stopped：脚本不会替你启动，会 exit 3）
fly machine start 83d1650bd23948 -a pixivflow-scheduler
./scripts/export-volume-backup.sh --plane pixivflow
fly machine stop  83d1650bd23948 -a pixivflow-scheduler

# 两卷各导一份（默认 --plane all）
./scripts/export-volume-backup.sh
```

怎么到卷上：容器没有 `sqlite3` CLI，脚本用 `fly ssh console -C "sh -s -- …"` 把一段远端
脚本喂进容器，在 `/tmp/vb-<plane>-<ts>/` 里搭中转目录、脱敏、算 sha256，再
`fly sftp get` 拉回本机；中转目录默认删掉（`--keep-remote` 保留，排错用）。

导出什么、拒绝什么：

| 类别 | 处理 |
|---|---|
| SQLite | 每个 `*.db` 连同它的 `-wal` / `-shm` 在**同一个 tar 动作**里拷走（`_meta/ATOMIC_TRIPLES.tsv` 记账）。运维手工留的 `submissions.db.bak-…` 这类副本同样按三件套处理 |
| 运行配置 JSON | 导出，但在**容器内**先脱敏（见下） |
| 凭据文件 | 文件名命中 token/secret/password/api_key/`.pem`/`.key`/`.env*` 的路径整条不导出，理由写进 `_meta/EXCLUDED.tsv` |
| 临时媒体（`api_uploads/`）、`lost+found/` | 不导出（契约就是不留） |
| `*.log` | 默认不导出（不是状态，且不保证不含凭据形状的字符串）；`--include-logs` 显式加入 |
| `downloads/` | 默认导出（可重建，但重建要重新访问 Pixiv）；`--exclude downloads` 可以只导不可重建的状态 |

**凭据处理是硬要求，不是选项。** 卷上的运行配置里有真的凭据：`production.json` 实测含
`.pixiv.clientSecret`、`.pixiv.deviceToken`、`.pixiv.refreshToken`、两个
`*.headers.Authorization` 与两个 `richNovelPreview.headers.Authorization`（共 7 个键）。
脚本在容器内按键名/值规则（Bearer 值、URL 里的凭据查询参数）把它们替换成
`<redacted-by-export-volume-backup>` 再打包，只把脱敏前的 sha256 记进
`_meta/SOURCE_SHA256.tsv`；声明是运行配置（`production.json` / `config.json` /
`runtime-policy.json`）却不是合法 JSON 时直接失败，不静默放过。没有命中的 JSON 保持
**字节不变**（不整份重新序列化）。

输出（本机，默认在仓库之外，免得 `git status` 变脏）：

```text
${VOLUME_BACKUP_ROOT:-$HOME/.local/share/pixivflow-volume-backups}/<UTC 时间戳>/<plane>/
├── volume-backup.tar.gz      打包后的整卷导出（--no-compress 时是 .tar）
├── manifest.json             schema pixivflow-volume-backup/1：卷（含 snapshot_retention）、
│                             机器白名单字段（绝不整份落盘 config.env）、源 revision/health、
│                             仓库 pin、三件套、integrity 探针、脱敏记录、排除记录、逐文件
│                             字节数与 sha256、汇总
├── verification.txt          人读的一页结论
├── data/                     解包后的导出树（就是恢复时要拷回去的东西）
└── _meta/                    ATOMIC_TRIPLES / EXCLUDED / ORPHANS / INTEGRITY / REDACTED /
                              SOURCE_SHA256 / files.tsv
```

判据与退出码：传输后比对 tar 包 sha256，然后**逐文件**复核字节数与 sha256（本地 == 远端），
任何一项不符就 exit 6。远端还会在 `/tmp` 的副本上跑 `PRAGMA integrity_check` 并记进
`_meta/INTEGRITY.tsv`；默认只 `[WARN]`，加 `--strict-integrity` 才 exit 7（理由：运维
手工留的 `*.bak-*` 副本若本身可疑，不该阻断整份备份）。退出码：0 成功、2 用法、
3 机器 stopped、4 本机前置、5 远端导出、6 传输/校验、7 源库 integrity 不 ok。

多久跑一次：**没有调度**。约定是人工执行——每次改生产配置/换版本之后立刻一次，以及
平时至少每周一次（Fly 快照 5 天就滚掉了）。脚本自己不清理旧导出目录，磁盘占用由人管。

诚实的边界（写下来免得以后误以为它比实际更强）：

* operator-run：没人敲命令就没有新拷贝；这一条是本脚本最大的弱点，不是小瑕疵。
* 目的地就是操作者本机（`$HOME/...`）：**没有异地副本**，本机坏了导出包也一起没。
* 三件套是「一个 tar 动作」的一致性拷贝，**不是**点时刻快照：live DB 在拷的瞬间仍可能被写。
  需要点时刻一致性时用卷快照（本页第一节的顺序）。
* 它只导出卷内容，不做恢复编排：恢复仍然按「恢复流程」人工执行。
* `_meta/SOURCE_SHA256.tsv` 记的是**脱敏前**的 sha256：拿它跟导出文件比，命中的那几个
  文件本来就会不同。

### 恢复演练（2026-09-28 CST，真实执行）

不是纸面推演：下面每条命令都在本机真跑过，数字是真实输出。

```bash
$ ./scripts/export-volume-backup.sh --plane telepost
[OK]   机器 683032ec6617e8 在跑，卷 vol_4y5e58mylle1nnjr 已挂载
[OK]   远端打包完成：292 个文件 / 165834144 B，tar 包 154620153 B
[OK]   传输校验通过（sha256 b2554b29329860aeeaecedba73012df566ea235762cf728eaba0ef3297ed5fee）
[INFO] files=292 bytes=165834144
[INFO] excluded=5 orphan_companions=0 redacted_keys=5
[INFO] sqlite_triples=11
[INFO] integrity bot1/submissions.db ok ok
...
[OK]   逐文件 sha256 校验通过（本地 == 远端）
```

执行端那一半（先 `fly machine start 83d1650bd23948 -a pixivflow-scheduler`，跑完
`fly machine stop` 回到设计态）：

```bash
$ ./scripts/export-volume-backup.sh --plane pixivflow
[OK]   远端打包完成：310 个文件 / 142902498 B，tar 包 137120364 B
[OK]   传输校验通过（sha256 db9db8027137360a4e82a274dcb21525ace419a11eea2c7dbb65b9a4bbb794d4）
[INFO] excluded=3 orphan_companions=0 redacted_keys=7
[INFO] sqlite_triples=1
[INFO] integrity pixivflow.db ok ok
[OK]   逐文件 sha256 校验通过（本地 == 远端）
```

把导出的三件套还原到一个**生产之外**的临时目录（不碰任何卷），再验它是不是可用的库：

```bash
$ scratch=$(mktemp -d "${TMPDIR:-/tmp}/vb-restore.XXXXXX")
$ exp=$HOME/.local/share/pixivflow-volume-backups/20260927T211744Z/telepost
$ for b in bot1 bot2; do mkdir -p "$scratch/$b"; cp -p "$exp/data/$b"/submissions.db* "$scratch/$b/"; done
$ /usr/bin/sqlite3 "$scratch/bot1/submissions.db" 'PRAGMA integrity_check;'
ok
$ /usr/bin/sqlite3 "$scratch/bot2/submissions.db" 'PRAGMA integrity_check;'
ok
$ /usr/bin/sqlite3 "$scratch/bot1/submissions.db" \
    "SELECT 'pending_reviews', COUNT(*) FROM pending_reviews
     UNION ALL SELECT 'refetch_attempts', COUNT(*) FROM refetch_attempts
     UNION ALL SELECT 'refetch_events',   COUNT(*) FROM refetch_events;"
pending_reviews|121
refetch_attempts|11
refetch_events|10
$ /usr/bin/sqlite3 "$scratch/bot2/submissions.db" "…同上…"
pending_reviews|94
refetch_attempts|3
refetch_events|0
$ /usr/bin/sqlite3 "$scratch/bot1/submissions.db" 'PRAGMA foreign_key_check;'   # 0 行
```

行级抽查不是只看计数：同一段只读查询分别跑**导出的副本**与**线上库**
（`fly ssh console -a telesubmit-multi-bot -C "python3 - /app/data/botN/submissions.db live:botN"`，
`mode=ro` URI，两个 Bot 各一次），比较首尾各两条 `pending_reviews` 的
`id / status / generation / created_at / 标题长度 / 标题 sha256`、`refetch_attempts` 前两行、
`refetch_events` 前两行，以及上述计数。**逐字段一致**（`diff` 无输出）。标题只记长度与
sha256 前缀，用户文本不进文档。

执行卷那一半也做了同等的开箱校验：把 `pixivflow.db` 三件套拷进另一个临时目录，
`PRAGMA integrity_check` → `ok`，`.tables` 里有 `schedule_slots` / `scheduler_executions` /
`outbox` / `deliveries` / `downloads` 等 18 张表。

演练证明了什么、没证明什么：

* 证明了：导出包里每个文件的字节数与 sha256 与源一致；导出的 SQLite 三件套能打开、
  `integrity_check` 通过、外键无悬空、业务表行数与行内容与线上一致。
* **没证明**：整卷恢复（重建卷、把 `data/` 拷回 `/app/data`）、`/ready` 门禁、
  Telegram webhook 归属、发布链路的端到端跑通。这些仍然要按「恢复流程」与「恢复之后必须
  复核的四件事」在生产上走一遍，那一次才算得上恢复验收（`EXTERNAL_ACCEPTANCE_REQUIRED`）。
* 演练用的是本机 `/usr/bin/sqlite3`（3.51.0），与容器内的 SQLite 版本不同；容器里没有
  `sqlite3` CLI，所以容器内只能用 python3 的 `sqlite3` 模块做等价校验。

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
   没有卷快照时，用导出包的 `data/` 树做同一件事：先**停写者**，再把 `data/` 下的内容拷回
   `/app/data`（三件套一起拷，别只拷 `.db`）；导出时被脱敏或被排除的文件要另外补——
   配置里的凭据按第 3 步重新注入，`api_uploads/` 与 `*.log` 本来就不属于备份对象。
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
