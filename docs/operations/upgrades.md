# 升级与回滚

本页是**镜像固定、配置更新、策略更新与回滚**的唯一权威说明。它是 `docs/REMOTE_UPDATES.md` 的
继任者：原文的每一条操作经验都在本页，只是按「镜像 / 配置 / 策略 / 回滚」重新组织。
预设的支持级别与不变量以
[architecture-matrix.json](https://github.com/redtidev1918/pixivflow-telepost-deploy/blob/main/docs/reference/architecture-matrix.json)
为准；只读核对脚本见 [monitoring.md](monitoring.md)。

## 镜像固定规则

生产镜像只从两种引用构建：

- TelePost：发布 tag，固定为 `TELEPOST_IMAGE`（`fly/deploy.telepost.toml`、
  `docker-compose` 的 `.env`）。
- PixivFlow：**40 位提交号**，固定为 `PIXIVFLOW_REF`（`fly/deploy.pixivflow.toml` 的
  `[build.args]`）。

**绝不用分支名，也绝不用浮动 tag。** 分支名的失败形态很具体：`docker/pixivflow-scheduler.Dockerfile`
的 `pixivflow-src` 阶段执行 `git fetch --depth 1 origin "${PIXIVFLOW_REF}"`，用分支名时这一层永远
命中缓存，于是镜像一直跑旧代码，而部署输出、配置文件和 tag 都在说它是新的。「部署成功」与
「跑的是新代码」从此脱钩。`Dockerfile` 里 `ARG PIXIVFLOW_REF` 刻意不给默认值——默认值会邀请
人填分支名。`scripts/verify-images.sh` 另外直接拒绝任何含 `latest` / `master` / `main` 的固定值。

### tag 固定陷阱

镜像的运行时 `PIXIVFLOW_REVISION` 是构建时写死的环境变量：

```dockerfile
ENV PIXIVFLOW_REVISION=${PIXIVFLOW_VERSION}+${PIXIVFLOW_REF}
```

写进去的是 build-arg 的**字面量**，不是解析后的提交。实测把 `PIXIVFLOW_REF` 固定成
`v2.19.0` 时，执行端自报 `2.19.0+v2.19.0`——「线上跑的到底是哪个提交」永远无法证明，而
`scripts/verify-images.sh` 只能失败。校验器**不能**靠把 tag 解析成提交号来「兼容」：镜像里
根本没有那个提交，核对通过只会是假象。所以 `verify-images.sh` 对非 40 位提交号的
`PIXIVFLOW_REF` 直接 `FAIL`（commit `f09d9af`）。

早先的实现正是靠 `git ls-remote origin` 解析 tag，而 `origin` 指向本仓库，那里从来没有
PixivFlow 的 tag，于是每次都退化成 `SKIP`——一项看起来在做、其实没做的核对（commit `fe62cfe`）。

核对线上跑的确实是这个提交：

```bash
./scripts/verify-images.sh
fly logs -a pixivflow-scheduler --no-tail | grep -o 'PIXIVFLOW_REVISION[^ ]*' | tail -1
```

## 配置更新模型随预设不同

| 预设 / 平台 | 配置位置 | `watchConfig` | 改配置等于做什么 |
|---|---|---|---|
| `split-worker`（Fly 生产执行端） | 卷上 `/app/data/production.json`（镜像内置版本化默认值由入口点首次启动收集到卷） | `true` | 直接编辑卷上的运行副本即可热重载 `schedules`/`targets`/`delivery`/`download`；`pixiv`/`network`/`storage` 仍要重启 |
| `single-host`、`remote-worker`（Compose / systemd 自托管） | 卷上的 `data/pixivflow/config.json` | `true` | 直接原子替换该文件即可热重载。校验通过后一次替换 Cron、targets 与 delivery；无效配置保留旧快照 |
| 全部预设的 TelePost | 环境变量 + 每 Bot 的 `runtime-policy.json` | — | 环境变量改动需要重启单元；`/botconfig` 写入的策略原子保存并只重载该 Bot（见下） |

两条必须记住的差异：

- `split-worker` 的运行副本在卷上（`/app/data/production.json`），改镜像内置默认值仍需要发布新镜像；
  编辑卷上运行副本则可热重载，无需重建。
- 即使 `watchConfig=true`，改动配置的 `pixiv`、`network` 或 `storage` 段仍需要手工重启执行单元：
  监听器只热替换 `schedules`、`targets`、`delivery` 与 `download`。

真实 Pixiv 与投稿 Token 用 `${TELEPOST_BOTN_SUBMIT_TOKEN}` 这类占位符写在 JSON 里，由远端
`.env` 注入。凭据值不写进配置文件，也不出现在任何输出里，规则见 [凭据契约](../concepts/credentials.md)。

## 安全的远程配置更新序列

先本地校验，再上传到临时名，再在远端校验，最后原子 `mv` 就位。任何一步失败都不会让服务读到
半份配置：

```bash
python3 -m json.tool ./my-config.json >/dev/null
scp ./my-config.json user@server:/opt/pixivflow-telepost/data/pixivflow/config.json.upload
ssh user@server 'cd /opt/pixivflow-telepost \
  && python3 -m json.tool data/pixivflow/config.json.upload >/dev/null \
  && mv data/pixivflow/config.json.upload data/pixivflow/config.json'
```

不要 `scp` 直接覆盖目标文件：执行单元可能在写入中途读到只写了一半的 JSON，而「校验后一次替换」
的前提是它读到的是一份完整文件。

## TelePost 策略更新

OWNER 在 Telegram 发送 `/botconfig` 打开当前 Bot 的运行配置面板，修改频道、审核群、
API/聊天审核与频道署名策略。策略**原子**保存在 `data/bot{N}/runtime-policy.json`，应用后只重载
当前 Bot：另一个 Bot、PixivFlow、数据库、缓存与 outbox 都不受影响。

**存在 pending 投稿时，切换频道或审核群会被拒绝**，面板强制执行这一检查。被拒绝时按顺序处理：

1. 处理旧审核群的 pending 投稿（批准或拒绝，或等 `PENDING_REVIEW_RETENTION_DAYS` 过期）。
2. 把 Bot 加到新频道，并授予发帖（管理员）权限。
3. 再应用策略。
4. 核对 `/health` 与一次新频道的测试投稿。

从 Mac 一次更新多个 Bot 时，策略 JSON 不含 Bot Token，可以单独传输：

```bash
cp config/telepost-policy.example.json ./telepost-policy.json
./scripts/push_telepost_policy.sh user@server /opt/pixivflow-telepost ./telepost-policy.json
```

远端脚本原子更新 `.env` 并只重建 `stack` 容器；持久卷 `./data` 不会被删除。想把多个策略变更
集中到一次重启，可先在服务器运行 `./scripts/apply_telepost_policy.sh policy.json --no-restart`，
完成后再执行：

```bash
docker compose up -d --no-deps --force-recreate stack
```

策略文件的结构约束由 `scripts/apply_telepost_policy.sh` 校验：根对象只能含 `bots`，键只能是
`channelId` / `reviewChatId` / `apiReviewRequired` / `chatReviewRequired`，未知键直接报错退出。

## `deploy` CLI 的升级命令

`deploy` 按平台把固定值写到正确的权威位置，然后部署。`--platform` 取
`fly|compose|systemd`（默认 `auto` 自动检测）。

| 目标 | 命令 | 写哪里 |
|---|---|---|
| TelePost / Fly | `./deploy tp latest --platform fly` | `fly/deploy.telepost.toml` 的 `TELEPOST_IMAGE` |
| TelePost / Compose | `./deploy tp <版本> --platform compose` | Compose 的 `.env` 的 `TELEPOST_IMAGE` |
| TelePost / systemd | `sudo ./deploy tp latest --platform systemd` | `git pull` + `pip` + `systemctl restart telepost` |
| PixivFlow / Fly | `./deploy pf <40 位提交号> --platform fly` | `fly/deploy.pixivflow.toml` 的 `PIXIVFLOW_REF`（并顺带更新 `PIXIVFLOW_VERSION`，仅当参数是 `x.y.z` 形态的发布 tag） |
| PixivFlow / Compose | `./deploy pf <版本> --platform compose` | `.env` 的 `PIXIVFLOW_IMAGE` |
| PixivFlow / systemd | `sudo ./deploy pf latest --platform systemd` | `npm install -g pixivflow@latest` + 重启 |

`pf` 在 Fly 上的当前值取的是 `PIXIVFLOW_REF`，不是显示版本——只改显示版本会让「部署成功」与
「跑的是新代码」再次脱钩。先用 `--dry-run` 看它打算写什么：

```bash
./deploy pf f331cd4bb164f327f07254d5541edff111ccd426 --platform fly --dry-run
./deploy version --plane all          # 工具版本 + 各平面固定值与配置来源
```

## 回滚

| 对象 | 能否回滚 | 怎么做 / 为什么不能 |
|---|---|---|
| 镜像 | 能 | 把 `TELEPOST_IMAGE` / `PIXIVFLOW_REF` 改回上一个不可变引用并重新部署。`PIXIVFLOW_REF` 必须是 40 位提交号 |
| 执行端配置（Compose / systemd） | 能 | 把上一份 `data/pixivflow/config.json` 原子替换回去 |
| 执行端配置（`split-worker`） | 能 | 与镜像同一次回滚：配置烘在镜像里，改回引用即回到旧配置 |
| TelePost 运行策略 | 能 | `/botconfig` 重新应用，或把 `data/bot{N}/runtime-policy.json` 换成上一份并重启该 Bot |
| 已发布的内容 | **不能** | 频道里已经发出的消息是既成事实。回滚镜像不会撤回它；需要人工删除频道消息 |
| 已经消费的 occurrence | **不能** | 槽位账本已把它记为终态。回滚代码不会让它重跑，也不该重跑——重复投递不是「恢复」 |
| 已经过期的 pending 投稿 | **不能** | `expired` 终态已落库，审核群原消息按 48 小时窗口删除。只能重新触发一次计划产生新投稿 |

已发布与已消费这两项与 [生命周期](../concepts/lifecycle.md) 的「错过一次唤醒就是错过一次运行，
永不回填」是同一条规则的两种表现。

回滚后立刻核对：

```bash
./scripts/verify-production.sh      # 含镜像固定值、镜像自报版本、触发鉴权
./scripts/smoke-telepost.sh
```

## 升级清单

1. 读 CHANGELOG，确认新版本是否改变配置 schema 或环境变量语义。
2. 本地录下当前固定值：`./deploy version --plane all`。
3. 在 `split-worker` 上改配置默认值：改 `pixivflow/config/production.json`，与镜像引用一起提交
   （线上运行副本在卷 `/app/data/production.json`，`watchConfig=true` 可热重载）。
4. 自证：`go test ./...`、`(cd control-plane && npm ci && npm test)`、
   `./scripts/validate.sh --examples`。
5. 升级：`./deploy tp <版本|latest> --platform <fly|compose|systemd>`（先加 `--dry-run`）。
6. 核对镜像与提交号：`./scripts/verify-images.sh`。
7. 触发一次计划，确认链路端到端跑通：`/health` 的 `storage.review_queue` 出现 pending，
   执行端按自己的账本自行退出。
8. 跑只读生产核对：`./scripts/verify-production.sh`。

**`latest` 只适合第一次看效果，下一次 `pull` 就会把版本换掉。** 它在首次试运行时省事，代价是
「同一份配置在不同日子产生不同代码」。任何你要保留的部署都必须把引用换成不可变值：TelePost 用
发布 tag，PixivFlow 用 40 位提交号。
