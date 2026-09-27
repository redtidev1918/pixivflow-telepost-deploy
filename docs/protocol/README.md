# Workflow Protocol（PixivFlow ↔ TelePost）规范与契约资产

本目录是跨仓协议的 **SSOT（唯一事实来源）**：规范说明在 `../architecture/workflow-protocol.md`，机器可校验的 schema 与 fixtures 在本目录。

```
docs/protocol/
  README.md                 ← 本文件：版本策略、消费方式、契约测试要求
  v1/
    protocol.schema.json    ← JSON Schema 2020-12，$defs: Task/Job/Event/Result/Asset/Capabilities/Error
    error-mapping.json      ← 封闭错误词表：协议码（含 retryable 默认值）+ 生产者内部原因码 → 协议码
    fixtures/               ← 双方契约测试共用的示例报文（必须能通过 schema 校验）
```

## 1 版本策略

- 协议大版本是**目录**（`v1/`、未来的 `v2/`），报文里的 `protocol_version: "1"` 与之对应。
- **只增不改**：新增可选字段不需要升版本；删除字段、改字段语义、改枚举值必须升大版本。
- 任何一方都必须**忽略未知字段**（schema 不禁止额外属性，仅约束必填与类型）。因此 `additionalProperties: true` 是刻意的，不是疏漏。
- 生产者与消费者各自声明支持范围：生产者通过 `GET /capabilities` 的 `protocol_versions`，消费者通过请求里的 `protocol_version`；不匹配 → `400 { error: { code: "unsupported_protocol_version" } }`。

## 2 双方如何消费（契约测试）

两个仓库都保留一份**vendored 副本**（`protocol/v1/…`），由本目录的 `scripts/sync-protocol.sh` 同步（脚本会写入 `protocol/v1/SOURCES.sha256`）。已同步：TelePost、PixivFlow 各 13 个文件（schema + error-mapping + 11 fixtures，另加清单）。

```bash
./scripts/sync-protocol.sh                       # 同步到 ../TelePost 与 ../PixivFlow
./scripts/sync-protocol.sh /path/to/repo         # 同步到指定仓库
./scripts/sync-protocol.sh --check               # 只校验，不写入
```

契约测试要求：

1. **Schema 校验**：把本仓**真实产生/消费**的报文（生产者：`Job` 投影、`Event`、`Result`、`Asset`；消费者：`Task`、事件回调体）逐一用 `protov1` 的对应 `$defs` 入口校验通过。
2. **Fixture 回放**：`fixtures/` 里每个示例报文都要能被本仓的解析器接受（不抛异常、必填字段可读），且本仓序列化出的等价报文能通过同一个 schema。
3. **副本一致性**：`protocol/v1/SOURCES.sha256` 必须与本目录内容一致（`scripts/sync-protocol.sh --check`），防止一侧偷偷改了协议。
4. **错误码封闭**：`Error.code` 是封闭枚举，生产者必须在 job facade 处把自己的内部原因码映射进来（`error-mapping.json` 的 `producer_internal`）。验收脚本会校验「协议码 ↔ schema enum 完全一致」以及「生产者 `TerminalReasonCode` 的每个成员都有映射」，新增内部原因码却不给消费者语义会直接失败。
5. **反耦合断言**：生产者的 schema/代码里不得出现消费者业务名词（`review`/`审核`/`refetch`/`替换`/`发布` 等），消费者的 `Task` 里不得出现生产者内部字段；已自动化——两仓契约测试各自断言协议资产的 `$defs`/`properties`/`enum` 不含业务词（按词元匹配），代码层按 `../architecture/workflow-protocol.md` §8 清单人工 + grep 复核。

## 3 校验方式

两仓的契约测试 + 一次总验收（已落地，先跑这三条）：

```bash
# 总验收（离线）：schema/fixtures/params/封闭词表/两仓副本哈希/反耦合
./scripts/verify-protocol-v1.py
# 总验收（联网）：capabilities -> POST /jobs -> 幂等重放 -> 轮询 -> cancel
./scripts/verify-protocol-v1.py --live http://127.0.0.1:8090 --tags 西瓜肚 --expect succeeded
# 消费者侧（TelePost）——真实 jsonschema 库校验 schema/fixtures/哈希/反耦合
cd TelePost && python -m pytest -q tests/test_protocol_contract.py   # 需要带 pytest + jsonschema 的 venv
# 生产者侧（PixivFlow）——无新依赖，内置 JSON Schema 子集校验器
cd PixivFlow && npx jest src/__tests__/protocol/contract.test.ts
# 副本一致性（在本仓执行，可接 CI）
./scripts/sync-protocol.sh --check
```

单个报文的手工校验：

```bash
python3 - <<'PY'
import json, jsonschema
schema = json.load(open('docs/protocol/v1/protocol.schema.json'))
doc    = json.load(open('docs/protocol/v1/fixtures/job.running.json'))
jsonschema.validate(doc, {'$ref': '#/$defs/Job', **{k: v for k, v in schema.items() if k != '$defs'}, '$defs': schema['$defs']})
print('ok')
PY
```

（`jsonschema` 仅用于本地/CI 校验，两仓运行时不引入该依赖；PixivFlow 侧刻意不引入任何 schema 库，改用内置子集校验器，覆盖协议实际用到的 `type/enum/const/required/properties/items/minLength/minItems/minimum/$ref`。）

### 3.1 各仓契约测试现状（2026-09-28 实测）

| 仓 | 文件 | 覆盖 | 结果 |
|---|---|---|---|
| TelePost | `tests/test_protocol_contract.py` | 8 项：资产存在（含 `error-mapping.json`）、schema 合法、11 个 fixture 全部校验通过、`$ref` 全解析、vendored 哈希一致、未知字段被接受（只增不改）、schema 无业务名词、封闭错误词表可映射（enum ↔ `protocol_codes` 双向一致 + `retryable` 缺省 + `producer_internal` 不悬空） | `8 passed` |
| PixivFlow | `src/__tests__/protocol/contract.test.ts` | 17 项：同上（`it.each` 展开每个 fixture）+ 同样的反耦合断言 + 生产者侧词表检查（额外解析 `src/scheduler/TargetOutcome.ts` 的 `TerminalReasonCode` union，未映射/多余映射都失败） | `17 passed`，`npx tsc --noEmit` exit 0 |
| deploy | `scripts/verify-protocol-v1.py`（离线） | schema meta 校验（有 jsonschema 时）、11 个 fixture + `params` 走对应 `$defs`、错误词表与 enum 双向一致、生产者 union 覆盖率、两仓副本哈希、反耦合 | exit 0（`python3` 与带 `jsonschema` 的 venv 两条路径） |
| deploy | `scripts/sync-protocol.sh --check` | 两仓副本逐字节比对 + `SOURCES.sha256` 校验 | exit 0 |

反耦合断言按**词元**匹配（`preview` 不会被 `review` 误伤），检查 `$defs` 名、`properties` 名与 `enum` 值；fixtures 里的 `correlation_id`/`labels`/`callback_url` 属于**调用方不透明数据**，不受该断言约束。


## 4 变更流程

1. 改本目录的 schema/fixtures（只增不改，升大版本除外）。
2. 更新 `../architecture/workflow-protocol.md` 对应小节与 `docs/CONTRACT.md` 索引。
3. 跑 `scripts/sync-protocol.sh` 同步两仓副本。
4. 两仓契约测试为绿后，才允许推动实现变更（顺序见规范 §10：A 生命周期可信 → B job facade → C 消费者切换 → D 事件义务/资产 → E 契约测试固化）。
