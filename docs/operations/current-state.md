# 当前生产状态

截至 2026-11-22 的运行验收更新（PixivFlow 3.10.1 与 TelePost 2.84.15 已上线）。
业务主题、别名与 target 示例均匿名化；真实身份只从私有配置读取。

## 配置基线与运行证据

| 组件 | 仓库配置基线 | 运行证据边界 |
| --- | --- | --- |
| TelePost | `versions.json`: 2.84.15（[#315](https://github.com/redtidev1918/pixivflow-telepost-deploy/pull/315)） | 11-22 `/health` = 2.84.15 / `9591b5f52c8b`，双 Bot 就绪，inbox 无积压，HTTP 冒烟 4/4，机内 doctor 24/24 |
| PixivFlow scheduler | `fly/deploy.pixivflow.toml`: 3.10.1 | 11-22 `/health` = 3.10.1 / `c809d10e8339`，256 MiB，空闲自停已观测 |
| TelePress（TelePost 内嵌） | `docker/telepost.Dockerfile`: 0.18.1 | 11-05 `/health` 实测进程内 telepress_version 0.18.1（rich markdown true） |

修改生产前读取实际 pin、镜像、runtime revision 与健康状态；发行、配置与运行版本分别验收。

## 活跃故障、阻断与待核验

- **2026-11-22 超时告警与执行预算。** 当天生产两条路由只有终态汇总地址。
  通用超时告警没有目标，终态汇总则等待同班插画投递收敛。PixivFlow
  [#247](https://github.com/redtidev1918/PixivFlow/pull/247) 启用可选的无进展计时，
  超时时按班次入队告警，由独立通知发送路径出队。未完成执行记为 `execution_timeout`，
  已完成的稿件与可重试投递意图继续按原账本收敛。
- **PixivFlow 配置与只读验收 VERIFIED。** [#313](https://github.com/redtidev1918/pixivflow-telepost-deploy/pull/313)
  固定 3.10.1 / `c809d10e8339`，两班启用连续 15 分钟无进展和总执行 45 分钟上限。
  Fly 保持 256 MiB、10:00 / 11:00，热重载 generation 1 → 2。两个认证通知入口均
  对空文本返回预期的 HTTP 400，没有投递诊断消息。回滚使用旧镜像 3.10.0，
  并恢复 `/app/data/production.json.bak-schedule-budget-20261122`。
- TelePost [#395](https://github.com/redtidev1918/TelePost/pull/395) 区分待发送和已发送回执，
  待发送返回可重试的 HTTP 503。2.84.15 发行、PyPI、自动部署和只读验收 VERIFIED，
  回滚点为 2.84.14 / `9c8752ab`。真实告警与小说提交要等自然周期或实际故障验收。
  Pin 与发行产物已核对，PixivFlow 发布后
  的下载页刷新和独立文档调度失败，与当前 worker 的线上版本核验分开跟踪。
- **2026-11-22 任务错峰，配置回读 VERIFIED，首个自然周期待验收。** 11-01 至
  11-21 两班每天都在北京时间 10:00 受理并成功。11-22 仍在同一分钟受理，
  10:05 插画已入投递队列。10:05 → 10:06 可用内存约 62 → 19 MiB，
  10:07 起 CPU I/O 等待约 97%，只读系统盘持续约 16 MiB/s、99% busy，数据卷
  I/O 很低。同期无 CPU 配额限流、无 OOM kill。内存压力下反复读回文件页是候选
  机制，事发时没有进程级缺页证据。两班同次唤醒是已确认的配置问题。
- 小说在 PixivFlow 的 `pixiv_download` 阶段超出执行预算，未进入 TelePost 审核。
  插画意图保留在 outbox，13:00 worker 到达运行上限，14:57 再次唤醒后原意图
  获 HTTP 201，终态通知获 HTTP 200，TelePost 回读审核已发布。
- [#309](https://github.com/redtidev1918/pixivflow-telepost-deploy/pull/309) 合并（`30fee52`）。
  cron-job.org 下一次排程分别 10:00 / 11:00，Cloudflare 部署 `f12d6186` 下
  10:02 / 11:02（已从 Worker 回读），GitHub 主分支对应 10:35 / 11:35。
  Fly 3.10.0 保持 256 MiB，持久卷配置逐字节回读通过，热重载 generation 1 → 2。
  回滚点为 `/app/data/production.json.bak-stagger-20261122`；回滚卷后同时恢复主时钟、
  Cloudflare 旧配置及 GitHub watchdog。首个自然周期检查触发、可用内存、小说执行、
  投递受理和审核群通知。
- 小说在线阅读补偿：11-02 条目仍为 IN_PROGRESS；TelePress #83、TelePost #380、Deploy #298 的发行、部署及原帖补偿状态须重新核对。配置版本变新不证明补偿完成。
- 隐私清理：GitHub 内部缓存、旧 PR 引用及外部 fork/副本仍需外部验收，禁止宣称全部副本已消除。
- PixivFlow 3.10.0：10-30 记录的下一自然周期候选效果需外部验收。
- 历史 inbox 死信（bot1:8 / bot2:7）在 10-31 记录中仍属遗留问题；11-05 botN health 显示 inbox pending 0 / dead_24h 0，但历史死信计数口径未经机内 doctor 复核。
- 历史条目中的 Pending、KNOWN_DEBT、BLOCKED、人工验收并未因归档自动关闭。涉及相关领域时先检索归档并查后续证据；无法确认的保持 UNKNOWN，不推断通过。

## 回滚

11-05 交接记录的 TelePost 回滚基线为 2.84.13；这是历史记录，执行前核对当前部署、镜像与卷备份，并按 upgrades.md 的正式流程操作。禁止仅凭旧版本号执行回滚。

## 历史与更新规则

[完整历史与原始证据](../archive/production-state-2026-11-03.md) 保留所有原始日期、PR、提交、验收与待办，未删除内容。
按日期、PR、故障关键词检索相关段落；不要默认加载全文。旧链接的章节可在归档中按原标题定位。

本文件是唯一当前摘要，不新增平行 CURRENT.md。新证据更新本页的版本、活跃问题、阻断和回滚基线；已结束事件的详细过程放 docs/archive/，保留证据链接。归档不进入用户导航。
