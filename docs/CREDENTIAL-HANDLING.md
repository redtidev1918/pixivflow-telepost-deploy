# 凭据处理不变量（Credential Handling Invariants）

本文件把 SEV-1 事件（Pixiv refresh token 以明文进入公开仓库的 Actions artifact）中得到的
教训固化为**强制规则**。这些规则不是建议，任何违反它们的 workflow / 脚本都不应合入。

> 本文件不含任何凭据值。引用缺陷时只使用 workflow 名、artifact 名等元数据。

---

## 1. 背景（已移除的缺陷设计）

历史 workflow `pixivflow-batch.yml` 中存在一步「Persist a rotated credential」：

```
把轮换后的凭据写入 rotated-token.txt
  → 再以 artifact 名 rotated-credential 上传
  → 供操作员下载
```

后果：该 artifact 位于**公开仓库**，在可下载窗口内对全网可读；artifact 过期（HTTP 410）
**不能消除已经发生的历史暴露**。

该步骤已删除，且 workflow 已从仓库移除。

---

## 2. 不变量 I-1：凭据永不成为 Actions artifact

> **A credential must never become an Actions artifact.**

包括但不限于：

- ❌ 不上传任何含凭据的**文件**为 artifact；
- ❌ 不把凭据写入 artifact 的**文件名 / 路径 / 环境清单**；
- ❌ 不把凭据塞进 `job summary`、annotation、comment 或 release notes；
- ❌ 不把凭据作为 `outputs` 在 job 之间传递；
- ❌ 不把凭据写入仓库内文件（即使随后 `.gitignore`）。

需要把「某个动作已完成」告知操作员时，**只输出不可逆指纹或结果状态**：

```
允许：sha256[:16] 指纹、布尔状态、时间戳、资源名
禁止：任何能还原或重放凭据的内容
```

---

## 3. 不变量 I-2：凭据持久化失败一律 FAIL CLOSED

> **Credential persistence failure must fail closed.**

当无法把凭据安全送至目标位置（secret store）时，**必须让流程失败**，而不是退化为
「写盘等待人工下载」：

```
✅ 正确：目标 secret store 写入失败 → 非零退出 → 流程红 → 人工介入
❌ 错误：写入失败 → 把凭据落盘 / 上传 artifact / 打进日志 → 让操作员自己取
```

理由：CI 的可下载产物是**公开面**（公开仓库尤其如此）；任何「为了让人取到」而落盘的
凭据，都等价于一次泄漏。

---

## 4. 不变量 I-3：凭据只经 env / stdin 传递，绝不进入 argv

进程命令行（`argv`）对同机任何用户可见（`ps`），并会进入 shell history 与进程审计日志。

```bash
❌ 禁止：curl "https://api.telegram.org/bot${token}/getWebhookInfo"

✅ 正确：env 或 stdin 传入，URL 在进程内拼接
   TG_WEBHOOK_CHECK_TOKEN="$token" python3 scripts/tg_webhook_check.py \
     --label BOT1 --expected-host <host> --env TG_WEBHOOK_CHECK_TOKEN
```

本仓库的实现见：

- `scripts/verify-webhooks.sh` —— 旧版曾把 token 放进 `curl` argv（已修复）
- `scripts/tg_webhook_check.py` —— token 只从 `--env <NAME>`（继承环境）或 `--stdin` 读取

---

## 5. 不变量 I-4：日志不得包含凭据

Telegram Bot API 的 token 位于**请求 URL 路径**中，因此 HTTP 客户端请求日志必须保持
禁用或脱敏（见 `TelePost/utils/logging_config.py` 中 `httpx` / `httpcore` 的降噪，
以及对应的回归测试）。

---

## 6. 检测与回归

| 机制 | 位置 | 作用 |
| --- | --- | --- |
| 全历史 + 增量 secret 扫描 | `.github/workflows/gitleaks.yml`、`.gitleaks.toml` | 阻断新的凭据泄漏 |
| 公开仓库内容门禁 | `scripts/check_public_repo.py`（由 `validate.yml` 强制执行） | 拒绝把敏感内容合入公开面 |
| 日志回归 | `TelePost/tests/test_webhook_secret_logging.py` | webhook secret 不进入日志 |
| 日志回归 | `TelePost/tests/test_bot_token_logging.py` | Bot token 的 URL 不进入 stdout/stderr/日志文件 |
| argv 回归 | `scripts/tg_webhook_check.py` 的设计约束 | token 不经 argv |

---

## 7. 检查清单（Review 用）

提交任何涉及凭据的 workflow / 脚本前，逐项确认：

```
[ ] 该 workflow 是否产生任何含凭据的 artifact / 文件 / 日志？        → 必须为否
[ ] 凭据是否只经 secret store 注入（env），而非 argv 或落盘？        → 必须为是
[ ] 失败路径是否 FAIL CLOSED（非零退出），而不是降级为落盘？          → 必须为是
[ ] 输出给操作员的内容是否只有指纹 / 状态，而非凭据本身？            → 必须为是
[ ] 新增的测试夹具是否使用**明显合成**的假凭据？                      → 必须为是
[ ] gitleaks 增量门禁是否对该改动生效？                              → 必须为是
```
