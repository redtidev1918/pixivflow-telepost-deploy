# pixivflow-telepost-deploy Agent 入口

先确认任务范围、git status、当前分支与远端；修改使用独立 worktree，不覆盖未知改动。

## 隐私与安全
Live topics, required/preferred tags, aliases, and topic-revealing target names are
private operational configuration. Public code, templates, fixtures, documentation,
pull requests and release notes must use neutral fictional examples. Keep real
configuration on private volumes or gitignored `*.private.json` files; never export
it into this repository. After a privacy history rewrite, migrate local patches to
a fresh clone rather than pushing old history back to any remote branch or tag.
Do not alter identifiers or standard vocabulary inside third-party runtimes to
redact business settings. Keep vendored libraries pinned and integrity-checked;
audit actual operational attribution rather than treating any word match as data.

## 默认读取规则

- 普通开发：本文件、涉及目录的 AGENTS.md、相关源码与测试；按下表读取细则中对应标题段落（先 `rg -n '^#' docs/agent-guide.md` 定位，再按行读取）。不得因按需读取而省略适用约束。
- 接续旧任务：先读 `.agent/STATUS.md`（若存在），再检索该任务的 TASKS/HANDOFF/DECISIONS/LESSONS；不默认加载全部历史。
- 跨仓接口或职责变更：读取 Deploy AGENTS.md、CONTRACT.md 与相关架构章节；只扫描涉及仓库。
- 生产变更或事故：另读 Deploy `docs/operations/current-state.md`、相关运维/交付计划；历史按日期、PR、故障检索，不默认读全量记录。
- 领域、安全、发布和 CI 门禁不因文档拆分而放宽。保留标签、数据与审计历史；不打印凭据；不盲重试不确定的外部写入。
- 复用现有领域服务和 ReleaseGraph，不新建平行状态库或发布引擎。非平凡新增能力先调查已有实现。
- 文档与证据冲突时核对运行事实并修正文档。报告分别说明本地验证、CI、提交/PR、发行、部署、运行验收；不把测试通过当作生产通过。

## 按任务加载细则

完整规则保存在 [Agent 细则](docs/agent-guide.md)，以下标题均为检索入口。修改对应领域前必须读取该段及其引用的相关约束。

- 1. Mission
- 2. Mandatory Reading
- 3. Documentation Is Agent Memory
- 4. Documentation Drift Is A Defect
- 5. Stable vs Dynamic Memory
- 6. Documentation State Labels
- 7. Community Before Custom
- 8. Community Research Requirements
- 9. Reuse Hierarchy
- 10. Adopt, Don't Fork By Default
- 11. Community Decision Record
- 12. Re-Evaluate Old Decisions
- 13. Truth Hierarchy
- 14. Preserve First
- 15. No Parallel Systems
- 16. Repository Ownership
- 17. Core Media Rule
- 18. Prefer Media References
- 19. Download Is A Capability
- 20. Telegram Media Priority
- 21. Bot-Specific file_id
- 22. TelePress Provider Rule
- 23. Candidate Investigation Rule
- 24. Empty Result Is A Result
- 25. Failure Contract
- 26. Recovery
- 27. Admission Policy
- 28. Notification != Review
- 29. Submission != Review
- 30. Mini App
- 31. Moderation
- 32. Admin DM
- 33. WebUI
- 34. Scheduling
- 35. No Backfill
- 36. Security
- 37. Documentation Synchronization
- 38. Documentation Quality
- 39. Normal Execution Workflow
- 40. Root Cause Before UX Patch
- 41. External Blockers
- 42. Production Mutations
- 43. Release Discipline
- 44. Runtime Version Consistency
- 45. Tests Are Not Production
- 46. New Debt
- 47. Current High-Level Roadmap
- 48. Final Completion Check
- 49. Final Reporting
- 50. Final Principle

生产摘要继续使用 `docs/operations/current-state.md`，避免制造第二个权威入口。历史归档不代表其中所有待办均已解决；操作前必须核对关联证据。
