# Fly 部署：两个应用

本目录只有两份拓扑来源，各自对应一个 Fly 应用。完整契约见
[../docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md)。

| 文件 | 应用 | 角色 | 关键参数 |
| --- | --- | --- | --- |
| `deploy.telepost.toml` | `telesubmit-multi-bot` | 常驻：webhook / 投稿 API / 审核 / 发布 | `auto_stop_machines=false`、`min_machines_running=1`、`force_https=false`（Flycast 投递）、长期健康检查 |
| `deploy.pixivflow.toml` | `pixivflow-scheduler` | 执行端：平时停止、被触发唤醒、跑完自行退出 | `auto_start_machines=true`、`auto_stop_machines=false`、`min_machines_running=0`、`restart.policy=never`（线上 Machine 配置显示为 `no`）、**无健康检查** |

## 部署

```bash
# 先把两份配置里的 app 改成自己的名字
fly config validate -c fly/deploy.telepost.toml
fly config validate -c fly/deploy.pixivflow.toml

# 业务端（常驻）
fly volumes create data -a <your-telepost-app> --size 1 --region iad
fly deploy -c fly/deploy.telepost.toml --ha=false

# 执行端（独立卷；卷名必须与 deploy.pixivflow.toml 的 mounts.source 一致）
fly volumes create pixivflow_data -a <your-pixivflow-app> --size 1 --region iad
fly deploy -c fly/deploy.pixivflow.toml --ha=false
```

`--ha=false` 是必需的：每个应用只有一台机器，而卷只能挂在一台机器上。

## Secrets

```bash
# 业务端
fly secrets set -a <your-telepost-app> \
  BOT1_TOKEN=... BOT1_CHANNEL_ID=... BOT1_OWNER_ID=... \
  BOT2_TOKEN=... BOT2_CHANNEL_ID=... BOT2_OWNER_ID=... \
  TELEPOST_BOT1_SUBMIT_TOKEN=... TELEPOST_BOT2_SUBMIT_TOKEN=...

# 执行端：只有 Pixiv 凭据 + 投稿令牌 + 触发令牌。这里不该出现任何 Telegram 令牌。
fly secrets set -a <your-pixivflow-app> \
  PIXIV_CLIENT_ID=... PIXIV_CLIENT_SECRET=... PIXIV_DEVICE_TOKEN=... PIXIV_REFRESH_TOKEN=... \
  TELEPOST_BOT1_SUBMIT_TOKEN=... TELEPOST_BOT2_SUBMIT_TOKEN=... \
  SCHEDULER_TRIGGER_TOKEN=...
```

Cloudflare 时钟需要相同的触发令牌：

```bash
cd control-plane && npx wrangler secret put SCHEDULER_TRIGGER_TOKEN
```

`wrangler.toml` 里的 `PIXIVFLOW_TRIGGER_BASE_URL` 指向执行端应用地址；cron 表达式与
`src/cron-map.ts` 的键必须一致（`npm test` 会核对）。

## 为什么执行端没有健康检查

探测本身就是请求，而请求会唤醒已停止的机器。一个刚决定收工的执行端会被自己的健康检查
无限叫醒，于是既回不到 stopped，也永远在计费。停机由执行端自己的账本决定
（`schedulerRuntime.exitWhenIdle`），不是由平台探测推断。

同理，**不要**给执行端加 `auto_stop_machines`：代理看到的是「HTTP 连接已空闲」，
而下载还在后台跑（实测 10–40 分钟），按空闲停机会把批次拦腰砍断。

## 更新配置

- PixivFlow 的运行配置随镜像发布（`pixivflow/config/production.json`，`watchConfig=false`）：
  改配置 = 改提交/版本 + 重新部署执行端。
- TelePost 的部署默认值来自 `[env]`；OWNER 可在 Telegram 用 `/botconfig` 覆盖单个 Bot，
  只重载对应 Bot。
- 批量策略：`../scripts/apply_telepost_policy.sh`（会重启机器，不动卷）。

## 部署后核对

```bash
../scripts/verify-production.sh     # 只读：参数、状态、触发鉴权、webhook 归属
../scripts/verify-images.sh         # 只读：线上镜像/提交号是否等于仓库固定的那个
```
