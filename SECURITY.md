# 安全政策

## 支持范围

最新发布版本与 `main` 分支接受安全修复。旧版本可能获得高危问题的回移植，但不作保证；
部署者应优先升级到最新版本标签，并使用不可变的版本号而不是长期停留在 `latest`。

## 私下报告漏洞

请使用 GitHub 的
[Private vulnerability reporting](https://github.com/redtidev1918/pixivflow-telepost-deploy/security/advisories/new)
提交报告，不要创建公开 Issue。适合报告的内容包括：

- Token、Webhook Secret 或代理订阅泄漏；
- 未授权投稿、审核绕过或跨 Bot 数据访问；
- 容器逃逸、危险文件覆盖、命令注入；
- 发布镜像或 CI 供应链完整性问题。

报告请包含受影响版本、最小复现、影响范围和建议修复；所有凭据、频道/群 ID、域名与日志
中的个人信息都应脱敏。维护者通常会在 3 个工作日内确认，在 7 个工作日内给出初步分级。

如果真实 Token 已经出现在日志、Issue、截图或 Git 历史中，不要等待修复：立即在 Telegram、
TelePost、Pixiv 或代理供应商处吊销并重新生成。仅删除当前文件不能清除 Git 历史。

## 部署者安全清单

- Secret 只放 `.env`、Fly Secrets 或同等密钥服务；不要写进 JSON 模板和镜像层。
- 默认保持 `BIND_ADDRESS=127.0.0.1`；公网 Webhook 通过 TLS 反向代理暴露。
- 给 Bot 最小频道权限，投稿 Token 按 Bot 隔离，定期轮换。
- 更新前备份持久卷并检查 Release、镜像标签及构建来源证明。
