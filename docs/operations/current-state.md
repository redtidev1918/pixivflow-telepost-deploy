# 当前生产状态

截至 2026-11-05 的运行验收更新（TelePost 2.84.13 发行与只读验收完成）。
业务主题、别名与 target 示例均匿名化；真实身份只从私有配置读取。

## 配置基线与运行证据

| 组件 | 仓库配置基线 | 运行证据边界 |
| --- | --- | --- |
| TelePost | `versions.json`: 2.84.13 | 11-05 只读验收：公网 `/health` = 2.84.13 / f58419b，bot1+bot2 `/ready` ok，botN health inbox pending 0 / dead_24h 0，smoke 4/4；未做机内 doctor |
| PixivFlow scheduler | `fly/deploy.pixivflow.toml`: 3.10.0 | 10-30 条目记录已部署；11-05 未复核 |
| TelePress（TelePost 内嵌） | `docker/telepost.Dockerfile`: 0.18.1 | 11-05 `/health` 实测进程内 telepress_version 0.18.1（rich markdown true） |

修改生产前读取实际 pin、镜像、runtime revision 与健康状态；发行、配置与运行版本分别验收。

## 活跃故障、阻断与待核验

- 小说在线阅读补偿：11-02 条目仍为 IN_PROGRESS；TelePress #83、TelePost #380、Deploy #298 的发行、部署及原帖补偿状态须重新核对。配置版本变新不证明补偿完成。
- 隐私清理：GitHub 内部缓存、旧 PR 引用及外部 fork/副本仍需外部验收，禁止宣称全部副本已消除。
- PixivFlow 3.10.0：10-30 记录的下一自然周期候选效果需外部验收。
- 历史 inbox 死信（bot1:8 / bot2:7）在 10-31 记录中仍属遗留问题；11-05 botN health 显示 inbox pending 0 / dead_24h 0，但历史死信计数口径未经机内 doctor 复核。
- 历史条目中的 Pending、KNOWN_DEBT、BLOCKED、人工验收并未因归档自动关闭。涉及相关领域时先检索归档并查后续证据；无法确认的保持 UNKNOWN，不推断通过。

## 回滚

11-05 交接记录的 TelePost 回滚基线为 2.84.12；这是历史记录，执行前核对当前部署、镜像与卷备份，并按 upgrades.md 的正式流程操作。禁止仅凭旧版本号执行回滚。

## 历史与更新规则

[完整历史与原始证据](../archive/production-state-2026-11-03.md) 保留所有原始日期、PR、提交、验收与待办，未删除内容。
按日期、PR、故障关键词检索相关段落；不要默认加载全文。旧链接的章节可在归档中按原标题定位。

本文件是唯一当前摘要，不新增平行 CURRENT.md。新证据更新本页的版本、活跃问题、阻断和回滚基线；已结束事件的详细过程放 docs/archive/，保留证据链接。归档不进入用户导航。
