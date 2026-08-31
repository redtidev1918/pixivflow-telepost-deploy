# 贡献指南

感谢你改进 PixivFlow + TelePost Deploy。这个仓库的目标是提供可移植、低内存、默认安全
的部署套件；功能实现分别位于上游
[PixivFlow](https://github.com/redtidev1918/PixivFlow) 与
[TelePost](https://github.com/redtidev1918/TelePost)。

## 在哪里提交修改

- Docker、Compose、Fly.io、代理、运维脚本和联合部署文档：本仓库。
- Pixiv 下载、主题发现、排序和调度逻辑：PixivFlow。
- Telegram 投稿、审核、频道发布和 Bot API：TelePost。

不确定时可先在本仓库创建 Issue，并说明问题发生在哪个组件。

## 开发流程

1. 从 `main` 创建短分支，不要提交 `.env`、运行时 `data/`、Bot Token、Pixiv Token、
   投稿 Token、审核群 ID 或代理订阅地址。
2. 修改示例时保持通用占位符；不要把个人频道、应用名、IP、地区或 tag 策略写成默认值。
3. 运行：

   ```bash
   ./scripts/validate.sh --examples
   docker compose --env-file .env.example config --quiet
   ```

4. 涉及镜像时，运行 `docker build -f docker/combined.Dockerfile .`。无法本机构建时，
   在 PR 中明确说明，交给 CI 验证。
5. 更新与用户行为相关的 README、对应 `docs/` 页面和 `CHANGELOG.md` 的
   `Unreleased` 段落。

## Pull Request 要求

- 一次 PR 聚焦一个问题，说明现状、修改和验证结果。
- 保持 Polling、Webhook、Fly.io 与普通 Compose 的配置兼容。
- 不修改持久化数据目录，不假设机器具有公网 IP、root SSH 或固定区域。
- 新增环境变量时同步 `.env.example`、Compose/Fly 模板和文档。
- 安全问题不要提交公开 Issue，按 [SECURITY.md](SECURITY.md) 私下报告。
