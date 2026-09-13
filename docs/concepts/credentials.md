# 凭据契约：谁持有、边界在哪、永不泄漏

> **本页是「哪个角色持有哪个凭据、凭据边界在哪些 preset 成立、凭据处理有哪些强制不变量」的
> 唯一权威描述。** 矩阵 `authority.credentialContract` 指向本页；`securityInvariants` 的
> `SI-1`…`SI-6` 在这里展开。凭据**值**永远不写进文档、日志、脚本输出或备份——本页只写占位名。

## 凭据归属表

| 凭据（占位名） | 拥有者 | 用途 | 见于 |
| --- | --- | --- | --- |
| `BOT*_TOKEN` | `publisher` / `telegram-ingress` | Telegram Bot API、webhook 注册 | TelePost |
| `BOT*_CHANNEL_ID` | `publisher` | 发布目标频道 | TelePost |
| `BOT*_OWNER_ID` | `publisher` | OWNER 权限（`/botconfig`、审核） | TelePost |
| `BOT*_WEBHOOK_SECRET_TOKEN` | `telegram-ingress` | webhook secret 校验 | TelePost |
| `TELEPOST_BOT*_SUBMIT_TOKEN` | 业务端签发、执行端持有 | 执行端向投稿接口鉴权 | TelePost 签发 / PixivFlow 使用 |
| `PIXIV_CLIENT_ID` / `PIXIV_CLIENT_SECRET` / `PIXIV_DEVICE_TOKEN` / `PIXIV_REFRESH_TOKEN` | `executor` | Pixiv 登录与刷新 | PixivFlow |
| `SCHEDULER_TRIGGER_TOKEN` | `clock` 持有、`executor` 校验 | 触发端点鉴权 | control-plane / PixivFlow |
| `SUB_URL` | `network`（仅内置代理时） | 代理订阅 | proxy 单元 |

## 安全不变量（矩阵 `securityInvariants`）

| ID | 陈述 | 适用范围 | 守护 |
| --- | --- | --- | --- |
| `SI-1` | 执行端在**任何 preset** 下都不拥有、不接收任何 Telegram bot token / channel id / owner id / webhook secret；TelePost 永远是 Telegram 凭据的唯一拥有者 | 全部 preset | `webhook-ownership.test.ts`、`fly/deploy.pixivflow.toml`、`docker-compose.yml`（pixivflow 仅得 `BOT*_SUBMIT_TOKEN`）、`architecture_docs_test.go` |
| `SI-2` | TelePost 是唯一 Telegram webhook owner；本仓库不注册、不删除 webhook | 全部 preset | `webhook-ownership.test.ts`、`scripts/verify-webhooks.sh` |
| `SI-3` | 没有人工审核决定，任何组件都不得发布到频道 | 全部 preset | `no-business-state.test.ts`、本页 |
| `SI-4` | 同一 Pixiv 凭据最多存在一个活跃的生产执行 | 全部 preset | [scheduling.md](./scheduling.md)、本页 |
| `SI-5` | 执行端的停机决定只属于它自己的账本，绝不属于平台探针 | `split-worker`、`single-machine-worker-sleep`、`remote-worker`（`wake-run-exit`） | `fly/deploy.pixivflow.toml`、[lifecycle.md](./lifecycle.md) |
| `SI-6` | 业务代码不得按部署平台分支 | 全部 preset | `AGENTS.md` |
| `SI-7` | 不同角色的状态命名空间绝不重叠；共享物理卷只允许配互不相交的角色子目录 | 全部 preset | `docker-compose.yml` 挂载、[state.md](./state.md)、`architecture_docs_test.go` |

`SI-1` 的关键不是「执行端目前恰好没带」，而是**结构上没有**：执行端配置里不存在
任何 `BOT*_TOKEN` / `BOT*_CHANNEL_ID` / `BOT*_WEBHOOK_SECRET_TOKEN` 键，投递只走投稿接口。
持有 Telegram 凭据会让执行端成为 webhook owner 候选，并能绕过审核发布。这条对所有 preset 成立。

## 逻辑所有权不变；主机级隔离随 preset 变化

要区分两个独立的字段：

| 字段 | 含义 | 取值 |
| --- | --- | --- |
| `executorHoldsTelegramCredentials` | executor 单元/进程是否**接收** Telegram 凭据（逻辑所有权，SI-1） | 四个 preset 全部为 `false` |
| `hostCredentialIsolation` | executor 与 publisher 是否身处**不同主机/不同 secret 域**（部署事实） | 共置 preset 为 `false`；`split-worker` / `remote-worker` 为 `true` |

| Preset | executor 持有 Telegram 凭据 | 主机级凭据隔离 | 结构保证 |
| --- | --- | --- | --- |
| `single-host` | **否** | **不成立**（同主机、同一份 `.env`） | compose 只给 pixivflow 传 `BOT*_SUBMIT_TOKEN`；但同机进程理论上能读到共享环境 |
| `single-machine-worker-sleep` | **否** | **不成立**（同一台机器与文件系统） | supervisor 必须用**环境白名单** spawn executor：只传 Pixiv/调度凭据，绝不继承 `BOT*_TOKEN` / `BOT*_CHANNEL_ID` / `BOT*_WEBHOOK_SECRET_TOKEN` |
| `split-worker` | **否** | 成立 | 两机两 secret 域，执行端镜像无 Telegram 键 |
| `remote-worker` | **否** | 成立 | 凭据分离在两个宿主，投稿接口是唯一入口 |

共置的限制记在矩阵 `combinationRules.supportedWithLimitations.co-located-hosts`：缺的是主机级
隔离，不是逻辑所有权；「同机理论上能读到」不构成「executor 可以持有」的许可。

> **共置不会让角色合并。** 即使 `single-host` 把两个角色放进同一台机器，执行端仍不得把审核
> 逻辑拿进来「顺手做掉」；它跨进程调用的是同一个投稿接口，只是地址从 Flycast 变成容器网络
> 地址。见 [roles.md](./roles.md)。

`SI-4` 与拓扑无关：无论几台机器，**同一 Pixiv 凭据最多一个活跃生产执行**。矩阵把
`second-clock` 列为 `invalid`，因为「重复触发是幂等的，凭据争用不是」。本套件**没有**跨平面的
分布式锁、租约或围栏令牌，这是刻意的终局决定——不变量是「只有一个执行平面」，而不是
「多个平面用锁协调」。理由见 [roles.md](./roles.md)。

## 凭据处理不变量（来自一次 SEV-1）

以下规则来自一次真实事件：Pixiv refresh token 以明文进入了**公开仓库**的 Actions artifact。
它们不是建议，任何违反它们的 workflow / 脚本都不应合入。

### I-1 凭据永不成为 Actions artifact

> **A credential must never become an Actions artifact.**

- ❌ 不上传任何含凭据的**文件**为 artifact；
- ❌ 不把凭据写进 artifact 的**文件名 / 路径 / 环境清单**；
- ❌ 不把凭据塞进 job summary、annotation、comment 或 release notes；
- ❌ 不把凭据作为 `outputs` 在 job 之间传递；
- ❌ 不把凭据写入仓库内文件（即使随后 `.gitignore`）。

需要告知操作员「某个动作已完成」时，只输出不可逆指纹或结果状态：

```
允许：sha256[:16] 指纹、布尔状态、时间戳、资源名
禁止：任何能还原或重放凭据的内容
```

artifact 过期（HTTP 410）**不能消除已经发生的历史暴露**。

### I-2 凭据持久化失败一律 FAIL CLOSED

> **Credential persistence failure must fail closed.**

无法把凭据安全送达目标 secret store 时，**必须让流程失败**，而不是退化为「写盘等人工下载」：

```
✅ 正确：目标 secret store 写入失败 → 非零退出 → 流程红 → 人工介入
❌ 错误：写入失败 → 凭据落盘 / 上传 artifact / 打进日志 → 让操作员自己取
```

### I-3 凭据只经 env / stdin 传递，绝不进入 argv

进程命令行（`argv`）对同机任何用户可见（`ps`），并会进入 shell history 与进程审计日志。

```bash
❌ 禁止：curl "https://api.telegram.org/bot${token}/getWebhookInfo"

✅ 正确：env 或 stdin 传入，URL 在进程内拼接
   TG_WEBHOOK_CHECK_TOKEN="$token" python3 scripts/tg_webhook_check.py \
     --label BOT1 --expected-host <host> --env TG_WEBHOOK_CHECK_TOKEN
```

实现见 `scripts/verify-webhooks.sh`（旧版曾把 token 放进 `curl` argv，已修复）与
`scripts/tg_webhook_check.py`（token 只从 `--env <NAME>` 或 `--stdin` 读取）。

### I-4 日志不得包含凭据

Telegram Bot API 的 token 位于**请求 URL 路径**中，因此 HTTP 客户端请求日志必须保持禁用或
脱敏（见 `TelePost/utils/logging_config.py` 中 `httpx` / `httpcore` 的降噪与对应回归测试）。

## 检测与回归

| 机制 | 位置 | 作用 |
| --- | --- | --- |
| 全历史 + 增量 secret 扫描 | `.github/workflows/gitleaks.yml`、`.gitleaks.toml` | 阻断新的凭据泄漏 |
| 公开仓库内容门禁 | `scripts/check_public_repo.py`（由 `validate.yml` 强制执行） | 拒绝把敏感内容合入公开面 |
| 执行端无 Telegram 凭据 | `control-plane/test/webhook-ownership.test.ts` | `SI-1` 静态守护 |
| 无第二份业务状态 | `control-plane/test/no-business-state.test.ts` | `SI-3` 静态守护 |
| webhook 归属只读核对 | `scripts/verify-webhooks.sh` | `SI-2` 运行时核对 |
| 日志回归 | `TelePost/tests/test_webhook_secret_logging.py`、`test_bot_token_logging.py` | webhook secret / Bot token 不进入日志 |

## 补充凭据

凭据**不进备份**。卷快照只包含业务状态；token、订阅 URL 按各自平台的 secret 机制重新下发
（Fly secrets、`.env`、systemd `EnvironmentFile`）。见 [backup.md](../operations/backup.md)
的「绝不备份的东西」。

## Review 检查清单

提交任何涉及凭据的 workflow / 脚本前，逐项确认：

```
[ ] 该 workflow 是否产生任何含凭据的 artifact / 文件 / 日志？        → 必须为否
[ ] 凭据是否只经 secret store 注入（env），而非 argv 或落盘？        → 必须为是
[ ] 失败路径是否 FAIL CLOSED（非零退出），而不是降级为落盘？          → 必须为是
[ ] 输出给操作员的内容是否只有指纹 / 状态，而非凭据本身？            → 必须为是
[ ] 新增的测试夹具是否使用明显合成的假凭据？                         → 必须为是
[ ] gitleaks 增量门禁是否对该改动生效？                             → 必须为是
```

## 相关页面

- 角色所有权：[roles.md](./roles.md)
- 投稿接口与幂等键：[delivery.md](./delivery.md)
- 触发令牌与时钟：[scheduling.md](./scheduling.md)
- 传输、出口与代理：[network.md](./network.md)
- 备份绝不包含什么：[backup.md](../operations/backup.md)
