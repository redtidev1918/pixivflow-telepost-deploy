# 部署清单：`deployment.manifest.json`

> **本页是部署清单契约的唯一权威描述。** 机器可读形式是
> [`architecture-matrix.json`](https://github.com/redtidev1918/pixivflow-telepost-deploy/blob/main/docs/reference/architecture-matrix.json)
> 的 `manifest` 段；`deploy manifest` 在构建时把矩阵嵌进二进制，所以随 Release 分发的
> 二进制自带它所遵守的契约。统一部署模型见[部署契约](deployment-contract.md)。

## 一句话

清单声明**「这是一套什么部署」**：preset、平台、executor 生命周期、资源档位，以及少数几个
允许的功能开关。它是**部署编译器的输入**，不是运行时依赖。

## 为什么需要它

没有它，同一套 preset 知识会分叉成三份：文档里一套、部署脚本里一套 `if/else`、CLI 里第三套
判断——三者迟早互相矛盾，而且没人知道哪份是对的。清单把这份知识压成**一个可校验的声明**，
合法性由架构矩阵判定，而不是由谁记得住。

## 它不是什么

| 不是 | 原因 |
| --- | --- |
| 不是运行时依赖 | 没有业务代码读它。删掉清单，系统照常运行 |
| 不是平台分支的来源 | 不允许由它推导出 `if FLY_IO`。平台差异只属于部署层 |
| 不是凭据载体 | 清单里**绝不**出现 token、频道 ID、订阅 URL。它只写拓扑，不写秘密 |
| 不是第二份支持等级表 | 支持等级的唯一来源是矩阵 `presets.*.status` |

## 字段

| 字段 | 必填 | 取值来源 | 省略时的默认 |
| --- | --- | --- | --- |
| `manifestVersion` | **是** | 矩阵 `manifest.manifestVersion` | 矩阵版本 |
| `preset` | **是** | 矩阵 `presets` | 无（无法默认） |
| `platform` | 否 | `platformSupport`（只取 `role=host` 的平台） | 该 preset 的第一个宿主平台 |
| `executorLifecycle` | 否 | `enums.lifecycle`（且必须是该 preset 允许的取值） | `presets.*.defaults.executorLifecycle` |
| `resourceProfile` | 否 | `resourceProfiles.profiles` | `presets.*.defaults.resourceProfile` |
| `switches.clock` | 否 | `enums.clockProvider` | `presets.*.defaults.clock` |
| `switches.telegramIngress` | 否 | `enums.telegramIngress` | `presets.*.defaults.telegramIngress` |
| `switches.network` | 否 | `enums.networkMode` | `presets.*.defaults.network` |
| `switches.bots` | 否 | 整数 ≥ 1 | `presets.*.defaults.bots` |
| `switches.search` | 否 | `enums.searchMode` | `presets.*.defaults.search` |
| `switches.review` | 否 | 固定 `enabled` | `presets.*.defaults.review` |

`executorLifecycle` 的默认值是一条**显式声明**，而不是从 `rolePlacement.executor.lifecycle` 的
`"a | b"` 里取第一个：`remote-worker` 允许两种生命周期，而它的默认 `clock=internal` 只与
`always-on` 自洽。取第一个会得到一个矩阵自己判为非法的组合。

### 派生字段（不写进清单）

这些由矩阵推出，写进清单只会制造第二份真相：

| 派生字段 | 来源 |
| --- | --- |
| `profileBudgetMiB` | 所选档位的 `totalBudgetMiB` |
| `hostCredentialIsolation` | preset 的 `credentialBoundary.hostCredentialIsolation` |
| `executorHoldsTelegramCredentials` | 恒为 `false`（SI-1，对所有 preset 成立） |

## 校验什么

`deploy manifest` 每次都做完整校验，任何一条不通过都会打印**规则 id 与理由**并以退出码 1 结束：

1. `preset` 在矩阵里；
2. `platform` 是该 preset 的**宿主**平台（`cloudflare` 是时钟平面，不在其中）；
3. `executorLifecycle` 是该 preset 允许的取值之一；
4. `resourceProfile` 在矩阵档位里；
5. 开关取值合法、`bots >= 1`；
6. `manifestVersion` 与本二进制支持的版本一致；
7. 全部**机器可判定**的组合规则求值。

规则分两类，矩阵必须对每条规则说明它属于哪一类，否则一致性测试会失败：

| 类别 | 数量 | 例子 |
| --- | --- | --- |
| 清单可判定（`predicate`） | 11 | `wake-run-exit` + `clock=internal` => 非法；`bots>=3` + 512 MiB => 已知限制 |
| 配置层面（`checkableBy`） | 3 | 状态命名空间重叠（看 compose 挂载）、两个时钟、executor 持有 Telegram 凭据 |

第二类清单**证明不了**——它们描述的是配置文件而不是声明，所以矩阵显式写出由谁守护
（架构文档测试 / `control-plane` 测试），而不是假装清单能验。

## 用法

```bash
deploy manifest                 # 读取或推断，打印摘要并校验（不会写文件）
deploy manifest --write         # 把推断结果写入 deployment.manifest.json
deploy manifest --check         # 只校验已有清单；非法组合退出码 1（适合放进 CI）
deploy manifest --preset remote-worker --write
                                # 无法从产物推断时显式声明 preset
```

推断只认**能证明**的东西：

| 产物 | 判定 |
| --- | --- |
| `fly/deploy.pixivflow.toml` + `fly/deploy.telepost.toml` | `split-worker` / `flyio` |
| `docker-compose.yml` 或 `compose.yaml` | `single-host` / `docker-compose` |
| `systemd/*.service` 或 `deploy/systemd/*.service` | `single-host` / `systemd` |
| 都没有 | 拒绝推断，提示用 `--preset` |

`remote-worker` 与 `single-machine-worker-sleep` **无法**从产物判定，必须显式声明——这不是
偷懒：一台机器的 compose 目录和两台机器的部署目录在文件层面可能长得一样。

### 示例：当前生产拓扑

```json
{
  "manifestVersion": 1,
  "preset": "split-worker",
  "platform": "flyio",
  "executorLifecycle": "wake-run-exit",
  "resourceProfile": "512m",
  "switches": {
    "clock": "cloudflare",
    "telegramIngress": "webhook",
    "network": "direct",
    "bots": 2,
    "search": "disabled",
    "review": "enabled"
  }
}
```

### 示例：单机 Compose

```json
{
  "manifestVersion": 1,
  "preset": "single-host",
  "platform": "docker-compose",
  "executorLifecycle": "always-on",
  "resourceProfile": "512m",
  "switches": {
    "clock": "internal",
    "telegramIngress": "polling",
    "network": "direct",
    "bots": 2,
    "search": "disabled",
    "review": "enabled"
  }
}
```

## 已知偏差：compose 限额与档位不一致

`docker-compose.yml` 的默认限额是 `TELEPOST_MEMORY_LIMIT:-320m` 与
`PIXIVFLOW_MEMORY_LIMIT:-256m`，合计 **576 MiB**；而矩阵 `512m` 档的分配是 320 + 192。

`deploy manifest` **不会把这个偏差抹平**：它按能容纳 576 MiB 的最小档位（`1g`）计算并打印
说明。要消除偏差必须二选一——调整 compose 的默认限额，或调整矩阵档位的分配——这需要单独
决定，不在清单工具里偷改。

## 与其它页的关系

- 统一部署模型与单一事实源表：[部署契约](deployment-contract.md)
- preset 与支持等级：[架构总览](../architectures/overview.md)
- 档位与内存：[环境变量与资源档位](environment.md)
- 后续计划（Phase 3 起）：[Roadmap](../ROADMAP-MULTI-ARCH.md)
