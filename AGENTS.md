# AGENTS.md —— 本仓库是「部署黏合层」

这份文件写给任何进入本仓库的智能体或工程师。先读 `docs/ARCHITECTURE.md`，它是职责契约的
唯一权威描述；本文件只回答「什么该做、什么绝对不该做」。

## 一句话

本仓库把 PixivFlow（执行）与 TelePost（投稿/审核/发布）组合成一个可部署的生产系统，
外加一个只负责「何时唤醒」的 Cloudflare 薄时钟。**它不拥有任何业务状态。**

## 目录职责

| 路径 | 是什么 | 不是什么 |
| --- | --- | --- |
| `control-plane/` | cron → schedule 标识映射 + 一次带令牌的 POST | 不是第二个调度器，不是审核/发布服务 |
| `fly/deploy.pixivflow.toml` | 执行端的唯一拓扑来源 | 不包含 Telegram 配置 |
| `fly/deploy.telepost.toml` | 业务端的唯一拓扑来源 | 不包含 Pixiv/调度配置 |
| `pixivflow/config/production.json` | 执行端随镜像发布的运行配置 | 不是可热改的运行中状态 |
| `docker/` | 按提交号固定或按发布版本透传的镜像定义 | 不是业务代码 |
| `scripts/` | 只读运维与验收脚本 | 不写业务状态、不注册 webhook |
| `docs/` | 契约、拓扑与运维说明 | 过时章节必须改，不要留「另一种说法」 |

## 绝对不要做

1. **不要在这里再实现一遍业务**：occurrence 计算、槽位状态机、执行租约、凭据下发、
   审核 FSM、发布逻辑，都属于 PixivFlow 或 TelePost。历史上这里曾有一套 D1 影子账本
   与审核实现，其代价是投稿机器人的 webhook 被指到 Worker 上，所有用户投稿被「签收后丢弃」。
   `control-plane/test/no-business-state.test.ts` 会阻止它回来。
2. **不要注册或删除 Telegram webhook**，不要在这里写任何 Telegram 调用。
   `control-plane/test/webhook-ownership.test.ts` 会失败。
3. **不要给 PixivFlow 配置健康检查**：探测请求会唤醒刚刚收工的机器，破坏「平时 stopped」。
4. **不要用平台 auto-stop 让 PixivFlow 停机**：代理看到的是「连接已空闲」，而下载还在跑。
   停机必须由执行端自己的账本决定（`exitWhenIdle`）。
5. **不要用分支名或浮动 tag 构建生产镜像**：用 40 位提交号或发布 tag
   （`PIXIVFLOW_REF` / `TELEPOST_IMAGE`），否则镜像层缓存会让镜像一直跑旧代码。
6. **不要新增第三份 Fly 配置**：`control-plane/test/deployment-contract.test.ts` 会失败。
7. **不要删掉 `force_https = false`**：Flycast 私网投递会被 301 打断。
8. **不要在日志、脚本输出或报告里打印任何密钥**。只输出「已配置 / 缺失 / 就绪」。

## 改完请自证

```bash
go test ./...                                  # 部署工具
(cd control-plane && npm ci && npm test)       # 时钟的守护测试
./scripts/validate.sh --examples               # 配置/脚本/公开仓库卫生
./scripts/verify-production.sh                 # 只读生产校验（需要 fly 与网络）
```

## 已知待办（本仓库范围）

- `docker-compose.yml` + `docker/combined.Dockerfile` 是单机自托管路径，仍是「一个容器内所有角色」；
  是否需要按同样的边界拆分尚未决定，暂按 `docs/ARCHITECTURE.md` 末节说明。
- `deploy.go` 的 `split` / `source` 子命令属于拆分前的源码构建路径，已被
  `docker/pixivflow-scheduler.Dockerfile`（按提交号构建）取代，待删除。
  （它们会重新生成 `fly/*-split.toml`，与「只有两份 Fly 配置」的契约冲突，删除前不要运行。）
- PixivFlow 生命周期提交合入并发布后，把 `PIXIVFLOW_REF` 从提交号改为发布 tag。
- 描述旧的无服务器控制面（Worker + D1 账本、GitHub Actions 执行平面、Fly 合一台）的
  文档与门禁脚本已删除：`docs/SERVERLESS-CUTOVER.md`、`docs/en/SERVERLESS-*.md`、
  `scripts/cutover-preflight.sh`、`scripts/prod-acceptance*.{sh,js}`。
  请勿重新引入——三平面对应三仓库，契约见 `docs/ARCHITECTURE.md`。
- PixivFlow 与 TelePost 各自新增了 `AGENTS.md` 职责契约（分别在各自仓库根目录）；
  改动跨仓库边界时先读那两份。
