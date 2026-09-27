#!/usr/bin/env python3
"""Workflow Protocol v1 验收脚本。

两种模式：

* 默认（离线）：校验 vendored fixtures 与 schema、`SOURCES.sha256`、以及反耦合断言。
  不联网、不发任何请求，可随时在本地跑。
* `--live`：对着真实执行端跑 `docs/architecture/workflow-protocol.md` §11.3 的验收清单。
  **会真的提交一次 `candidate_search` 作业**（真实搜索），所以必须显式加 `--live` 并给出令牌。

约定：只读之外的动作（只有 `--live` 的 POST /jobs、POST /jobs/{id}/cancel）必须能被清楚地看出来；
失败计数 → exit 1；用法错误 → exit 2。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
PROTOCOL_DIR = REPO / "docs" / "protocol" / "v1"
SCHEMA_PATH = PROTOCOL_DIR / "protocol.schema.json"
ERROR_MAP_PATH = PROTOCOL_DIR / "error-mapping.json"
MANIFEST_PATH = PROTOCOL_DIR / "SOURCES.sha256"

FAILURES: list[str] = []


def ok(msg: str) -> None:
    print(f"[OK]   {msg}")


def fail(msg: str) -> None:
    FAILURES.append(msg)
    print(f"[FAIL] {msg}")


def skip(msg: str) -> None:
    print(f"[SKIP] {msg}")


# --------------------------------------------------------------------------------------
# 极简 JSON Schema 子集校验（无第三方依赖时的兜底；优先用 jsonschema）
# --------------------------------------------------------------------------------------

def _type_ok(value, expected) -> bool:
    if expected == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if expected == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if expected == "string":
        return isinstance(value, str)
    if expected == "boolean":
        return isinstance(value, bool)
    if expected == "object":
        return isinstance(value, dict)
    if expected == "array":
        return isinstance(value, list)
    if expected == "null":
        return value is None
    return True


def _subset_validate(node: dict, value, root: dict, path: str) -> list[str]:
    errors: list[str] = []
    if "$ref" in node:
        ref = node["$ref"]
        if not ref.startswith("#/"):
            return errors
        target = root
        for part in ref[2:].split("/"):
            target = target.get(part, {})
        return _subset_validate(target, value, root, path)
    if "const" in node and value != node["const"]:
        errors.append(f"{path}: 期望常量 {node['const']!r}，实得 {value!r}")
    if "enum" in node and value not in node["enum"]:
        errors.append(f"{path}: {value!r} 不在枚举 {node['enum']}")
    types = node.get("type")
    if types is not None:
        candidates = types if isinstance(types, list) else [types]
        if not any(_type_ok(value, t) for t in candidates):
            return errors + [f"{path}: 类型应为 {types}，实得 {type(value).__name__}"]
    if isinstance(value, dict):
        for name in node.get("required", []):
            if name not in value:
                errors.append(f"{path}: 缺少必填字段 {name}")
        for name, sub in (node.get("properties") or {}).items():
            if name in value:
                errors += _subset_validate(sub, value[name], root, f"{path}.{name}")
    if isinstance(value, list):
        item_schema = node.get("items")
        if isinstance(item_schema, dict):
            for index, item in enumerate(value):
                errors += _subset_validate(item_schema, item, root, f"{path}[{index}]")
    return errors


def load_schema() -> dict:
    return json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))


def validate_against(schema: dict, entry: str, payload) -> list[str]:
    try:
        import jsonschema  # type: ignore

        validator = jsonschema.Draft202012Validator({"$ref": f"#/$defs/{entry}", **schema})
        return [f"{'/'.join(str(p) for p in e.path)}: {e.message}" for e in validator.iter_errors(payload)]
    except ImportError:
        return _subset_validate({"$ref": f"#/$defs/{entry}"}, payload, schema, "$")


def fixture_entry(name: str) -> str:
    prefix = name.split(".")[0]
    return {
        "task": "Task",
        "job": "Job",
        "event": "Event",
        "result": "Result_CandidateSearch",
        "capabilities": "Capabilities",
        "jobpage": "JobPage",
        "eventpage": "EventPage",
        "ackresult": "AckResult",
    }[prefix]


# --------------------------------------------------------------------------------------
# 离线检查
# --------------------------------------------------------------------------------------

BUSINESS_TERMS = (
    "refetch", "review", "slot", "telegram", "message_id",
    "disposition", "submission", "moderation", "publish",
)


def tokens(text: str) -> list[str]:
    return [part for part in re.split(r"[^a-z0-9]+", text.lower()) if part]


def contains_term(text: str, term: str) -> bool:
    """词元级子串匹配：`preview` 不应命中 `review`。"""
    haystack, needle = tokens(text), tokens(term)
    return any(haystack[i:i + len(needle)] == needle for i in range(len(haystack) - len(needle) + 1))


VENDORED_DIRS: list[Path] = [REPO.parent / "TelePost", REPO.parent / "PixivFlow"]


def check_vendored_copies() -> None:
    """SSOT 不持有 manifest（它就是源），manifest 由 sync 脚本写在每个消费仓里。"""
    rel_paths = ["protocol.schema.json", "error-mapping.json"] + [
        f"fixtures/{p.name}" for p in sorted((PROTOCOL_DIR / "fixtures").glob("*.json"))
    ]
    source_hashes = {rel: hashlib.sha256((PROTOCOL_DIR / rel).read_bytes()).hexdigest() for rel in rel_paths}
    checked = 0
    for repo in VENDORED_DIRS:
        dest = repo / "protocol" / "v1"
        if not dest.is_dir():
            skip(f"{repo.name} 未 vendored（跑 scripts/sync-protocol.sh 可生成）")
            continue
        checked += 1
        problems: list[str] = []
        for rel, digest in source_hashes.items():
            target = dest / rel
            if not target.exists():
                problems.append(f"{repo.name}/{rel} 缺失")
            elif hashlib.sha256(target.read_bytes()).hexdigest() != digest:
                problems.append(f"{repo.name}/{rel} 与 SSOT 不一致（需重新 sync）")
        manifest = dest / "SOURCES.sha256"
        if not manifest.exists():
            problems.append(f"{repo.name}/SOURCES.sha256 缺失")
        else:
            recorded = dict(reversed(ln.split("  ", 1)) for ln in manifest.read_text(encoding="utf-8").splitlines() if "  " in ln)
            for rel, digest in recorded.items():
                target = dest / rel
                if not target.exists() or hashlib.sha256(target.read_bytes()).hexdigest() != digest:
                    problems.append(f"{repo.name}/SOURCES.sha256 与文件不符：{rel}")
        for problem in problems:
            fail(problem)
        if not problems:
            ok(f"{repo.name} vendored 副本与 SSOT 一致（{len(rel_paths)} 文件 + manifest）")
    if checked == 0:
        skip("未发现 vendored 副本（--vendored 可指定其它仓库路径）")


PRODUCER_REASON_SOURCES: list[tuple[Path, str]] = [
    (REPO.parent / "PixivFlow" / "src" / "scheduler" / "TargetOutcome.ts", "TerminalReasonCode"),
]


def _reason_codes(path: Path, type_name: str) -> set[str] | None:
    """The string-literal members of an exported string-union type, or None when absent."""
    if not path.exists():
        return None
    text = path.read_text(encoding="utf-8")
    match = re.search(rf"export type {type_name}\s*=(.*?);", text, re.S)
    if not match:
        return None
    return set(re.findall(r"'([a-z0-9_]+)'", match.group(1)))


def check_error_mapping() -> None:
    """The protocol error enum is closed; a producer's internal codes must all map onto it."""
    if not ERROR_MAP_PATH.exists():
        fail(f"缺少 {ERROR_MAP_PATH.name}（封闭错误词表的映射表）")
        return
    schema = load_schema()
    enum = schema["$defs"]["Error"]["properties"]["code"]["enum"]
    mapping = json.loads(ERROR_MAP_PATH.read_text(encoding="utf-8"))
    protocol_codes = mapping.get("protocol_codes") or {}
    missing = [code for code in enum if code not in protocol_codes]
    extra = [code for code in protocol_codes if code not in enum]
    if missing:
        fail(f"error-mapping.json 缺少协议码：{missing}")
    if extra:
        fail(f"error-mapping.json 定义了 schema enum 之外的码：{extra}")
    if not missing and not extra:
        ok(f"错误词表与 schema enum 完全一致（{len(enum)} 个码）")
    for code, spec in protocol_codes.items():
        if not isinstance(spec, dict) or not isinstance(spec.get("retryable"), bool):
            fail(f"error-mapping.json: {code} 缺 retryable 默认值")
    internal = {
        key: value
        for key, value in (mapping.get("producer_internal") or {}).items()
        if not key.startswith("$")
    }
    dangling = sorted({value for value in internal.values() if value not in enum})
    if dangling:
        fail(f"producer_internal 指向未定义的协议码：{dangling}")
    for path, type_name in PRODUCER_REASON_SOURCES:
        codes = _reason_codes(path, type_name)
        if codes is None:
            skip(f"{path} 不在本机，跳过 {type_name} 覆盖率校验")
            continue
        unmapped = sorted(codes - set(internal))
        stale = sorted(set(internal) - codes)
        if unmapped:
            fail(f"{path.name}: {type_name} 有未映射的内部原因码：{unmapped}")
        else:
            ok(f"{path.name}: {len(codes)} 个内部原因码全部映射到协议码")
        if stale:
            fail(f"error-mapping.json 映射了 {path.name} 中不存在的内部原因码：{stale}")


def check_offline() -> None:
    schema = load_schema()
    try:
        import jsonschema  # type: ignore

        jsonschema.Draft202012Validator.check_schema(schema)
        ok("schema 是合法的 JSON Schema 2020-12")
    except ImportError:
        skip("未安装 jsonschema，跳过 meta-schema 校验（fixture 校验用内置子集校验器）")
    except Exception as exc:  # noqa: BLE001
        fail(f"schema 不是合法 JSON Schema：{exc}")

    fixtures = sorted(SCHEMA_PATH.parent.glob("fixtures/*.json"))
    if not fixtures:
        fail("没有找到 fixtures")
    for path in fixtures:
        payload = json.loads(path.read_text(encoding="utf-8"))
        errors = validate_against(schema, fixture_entry(path.name), payload)
        if errors:
            fail(f"{path.name} 校验失败：{errors[0]}")
        else:
            ok(f"{path.name} 通过 $defs/{fixture_entry(path.name)}")
        if path.name == "task.candidate_search.json":
            param_errors = validate_against(schema, "CandidateSearchParams", payload.get("params") or {})
            if param_errors:
                fail(f"{path.name} 的 params 校验失败：{param_errors[0]}")
            else:
                ok(f"{path.name} 的 params 通过 $defs/CandidateSearchParams")

    check_error_mapping()
    check_vendored_copies()

    surface: list[str] = list((schema.get("$defs") or {}).keys())
    for name, definition in (schema.get("$defs") or {}).items():
        surface.append(name)
        for prop in (definition.get("properties") or {}):
            surface.append(prop)
        for field_value in (definition.get("properties") or {}).values():
            if isinstance(field_value, dict) and "enum" in field_value:
                surface += [str(v) for v in field_value["enum"]]
    hits = [text for text in surface if any(contains_term(text, term) for term in BUSINESS_TERMS)]
    if hits:
        fail(f"schema 里出现业务词（耦合风险）：{hits}")
    else:
        ok("schema 的 $defs/字段名/枚举值不含业务词（反耦合）")


# --------------------------------------------------------------------------------------
# 联网检查
# --------------------------------------------------------------------------------------

def request(method: str, url: str, token: str | None, body=None, timeout: int = 30):
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Accept", "application/json")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", "replace")
            return resp.status, (json.loads(raw) if raw.strip() else None)
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", "replace")
        try:
            return exc.code, json.loads(raw)
        except json.JSONDecodeError:
            return exc.code, raw
    except Exception as exc:  # noqa: BLE001
        return 0, str(exc)


def check_live(args) -> None:
    base = args.pixivflow_url.rstrip("/")
    token = args.pixivflow_token

    status, capabilities = request("GET", f"{base}/capabilities", token)
    if status != 200 or not isinstance(capabilities, dict):
        fail(f"GET /capabilities → HTTP {status}（{capabilities}）")
        return
    versions = capabilities.get("protocol_versions") or []
    if "1" in [str(v) for v in versions]:
        ok(f"capabilities.protocol_versions 含 1：{versions}")
    else:
        fail(f"capabilities 未声明协议版本 1：{versions}")
    declared = {d.get("name"): d for d in capabilities.get("job_types") or [] if isinstance(d, dict)}
    if "candidate_search" in declared:
        budgets = {k: declared["candidate_search"].get(k) for k in ("queued_timeout_ms", "stall_timeout_ms", "default_deadline_ms")}
        if any(int(value or 0) <= 0 for value in budgets.values()):
            fail(f"candidate_search 预算不完整或为 0：{budgets}")
        else:
            ok(f"candidate_search 已声明且预算为正：{budgets}")
    else:
        fail(f"capabilities 未声明 candidate_search：{sorted(declared)}")
    schema = load_schema()
    errors = validate_against(schema, "Capabilities", capabilities)
    if errors:
        fail(f"capabilities 不符合 $defs/Capabilities：{errors[0]}")
    else:
        ok("capabilities 通过 $defs/Capabilities")

    task = json.loads((PROTOCOL_DIR / "fixtures" / "task.candidate_search.json").read_text(encoding="utf-8"))
    task["params"]["query"]["tags"] = args.tags
    task["params"]["constraints"]["exclude"] = [{"kind": item.split(":", 1)[0], "id": item.split(":", 1)[1]}
                                                for item in args.exclude]
    task["idempotency_key"] = args.idempotency_key
    task["correlation_id"] = args.correlation_id

    status, job = request("POST", f"{base}/jobs", token, task)
    if status not in (200, 201, 202) or not isinstance(job, dict):
        fail(f"POST /jobs → HTTP {status}（{job}）")
        return
    job_id = job.get("job_id") or job.get("id")
    ok(f"POST /jobs → HTTP {status}，job_id={job_id}，status={job.get('status')}")

    status, replayed = request("POST", f"{base}/jobs", token, task)
    if isinstance(replayed, dict) and (replayed.get("job_id") or replayed.get("id")) == job_id:
        ok("同一 idempotency_key 重放返回同一 job_id（幂等）")
    else:
        fail(f"重放未返回同一 job（HTTP {status}，{replayed}）")

    conflict_task = json.loads(json.dumps(task))
    conflict_task["params"]["query"]["tags"] = list(args.tags) + ["__protocol_conflict_probe__"]
    status, conflict = request("POST", f"{base}/jobs", token, conflict_task)
    conflict_code = (conflict.get("error") or {}).get("code") if isinstance(conflict, dict) else None
    if status == 409 and conflict_code == "idempotency_conflict":
        ok(f"同键不同参数 → 409 error.code={conflict_code}（幂等键不是『参数随便变都认』）")
    elif status in (200, 201, 202) and isinstance(conflict, dict) and (conflict.get("job_id") or conflict.get("id")) == job_id:
        fail("同一 idempotency_key 用不同参数提交仍返回原 job —— 幂等键无法发现参数漂移")
    else:
        fail(f"幂等键冲突未按协议拒绝：HTTP {status} error.code={conflict_code}（{conflict}）")

    status, unknown = request("POST", f"{base}/jobs", token, {**task, "job_type": "definitely_not_a_job_type"})
    if status == 400 and isinstance(unknown, dict) and (unknown.get("error") or {}).get("code"):
        ok(f"未知 job_type → 400 error.code={(unknown.get('error') or {}).get('code')}")
    else:
        fail(f"未知 job_type 未按协议拒绝：HTTP {status}（{unknown}）")

    deadline = time.time() + args.wait
    last = None
    while time.time() < deadline:
        status, current = request("GET", f"{base}/jobs/{job_id}", token)
        if status != 200 or not isinstance(current, dict):
            fail(f"GET /jobs/{job_id} → HTTP {status}（{current}）")
            return
        errors = validate_against(schema, "Job", current)
        if errors:
            fail(f"Job 投影不符合 $defs/Job：{errors[0]}")
            return
        if not current.get("updated_at"):
            fail("Job 投影缺少 updated_at（活性时钟不可信）")
            return
        if current.get("status") != last:
            print(f"[INFO] {job_id} status={current.get('status')} stage={(current.get('progress') or {}).get('stage')}")
            last = current.get("status")
        if current.get("status") in ("succeeded", "failed", "cancelled", "expired"):
            terminal = current
            break
        if args.cancel_after and time.time() > deadline - args.wait + args.cancel_after:
            status, cancelled = request("POST", f"{base}/jobs/{job_id}/cancel", token)
            print(f"[INFO] POST /jobs/{job_id}/cancel → HTTP {status} status={(cancelled or {}).get('status')}")
            args.cancel_after = None
        time.sleep(args.poll)
    else:
        fail(f"{job_id} 在 {args.wait}s 内未进入终态（疑似停摆）")
        return

    terminal_status = terminal.get("status")
    ok(f"{job_id} 终态 {terminal_status}（error={(terminal.get('error') or {}).get('code')}）")
    if args.expect and terminal_status != args.expect:
        fail(f"终态与期望不符：期望 {args.expect}，实得 {terminal_status}")

    flat = json.dumps(terminal, ensure_ascii=False)
    forbidden = [name for name in re.findall(r'"([A-Za-z_][A-Za-z0-9_]*)"', flat)
                 if name.lower().startswith("refetch")]
    if forbidden:
        fail(f"/jobs 投影仍暴露 refetch* 字段名：{sorted(set(forbidden))}")
    else:
        ok("/jobs 投影没有 refetch* 字段名（旧 shim 与新面未混用）")

    # 事件流：终态作业必须留下可对账的事件，否则消费者除了「没收到回调」以外没有任何依据（静默的根因）。
    events_url = terminal.get("events_url") or f"{base}/jobs/{job_id}/events"
    status, page = request("GET", events_url, token)
    if status != 200 or not isinstance(page, dict):
        fail(f"GET 事件流 → HTTP {status}（{page}）")
        return
    errors = validate_against(schema, "EventPage", page)
    if errors:
        fail(f"事件信封不符合 $defs/EventPage：{errors[0]}")
        return
    events = page.get("events") or []
    if not events:
        fail("作业已终态但事件流为空 —— 回调/对账没有依据，等于静默")
        return
    ok(f"事件流可读：{len(events)} 条，unacked={page.get('unacked')}")
    types = [item.get("type") for item in events]
    expected_type = f"job.{terminal_status}"
    if expected_type in types:
        ok(f"事件流含终态事件 {expected_type}")
    else:
        fail(f"事件流缺少终态事件 {expected_type}（实得 {types}）")
    foreign = [item for item in events if item.get("job_id") != job_id]
    if foreign:
        fail(f"事件流混入其它 job 的事件：{foreign[0].get('job_id')}")
    else:
        ok("事件流只含本 job 的事件")
    times = [int(item.get("at") or 0) for item in events]
    if times != sorted(times):
        fail(f"事件未按时间升序，不能直接当对账游标：{times}")
    else:
        ok("事件按时间升序（可直接用作对账游标）")

    # Ack：回调返回 2xx 只是三条确认路径之一；消费者补拉后必须能把游标回写，否则 unacked 永远不清零、回调失败不可发现。
    ack_url = f"{base}/jobs/{job_id}/events/ack"
    ack_through = events[-1].get("event_id")
    status, ack = request("POST", ack_url, token, {"ack_through": ack_through})
    ack_code = (ack.get("error") or {}).get("code") if isinstance(ack, dict) else None
    if status == 404 or ack_code in ("not_found", "unsupported"):
        fail("生产者未实现 POST /jobs/{job_id}/events/ack —— 补拉事件后无法对账，回调失败即永久静默")
        return
    if status != 200 or not isinstance(ack, dict):
        fail(f"POST 事件 ack → HTTP {status}（{ack}）")
        return
    errors = validate_against(schema, "AckResult", ack)
    if errors:
        fail(f"ack 响应不符合 $defs/AckResult：{errors[0]}")
        return
    ok(f"ack 生效：acked={ack.get('acked')} unacked={ack.get('unacked')}")
    if int(ack.get("unacked") or 0) != 0:
        fail(f"ack 后 unacked 仍为 {ack.get('unacked')}（消费者无法完成对账）")
    else:
        ok("ack 后 unacked 归零（消费者已追上）")
    status, again = request("POST", ack_url, token, {"ack_through": ack_through})
    if status == 200 and isinstance(again, dict) and int(again.get("unacked") or 0) == 0:
        ok("重复 ack 幂等（同一游标重复提交仍为 200/unacked=0）")
    else:
        fail(f"重复 ack 不幂等：HTTP {status}（{again}）")
    status, after_ack = request("GET", f"{base}/jobs/{job_id}", token)
    if isinstance(after_ack, dict) and after_ack.get("status") != terminal_status:
        fail(f"ack 改动了 Job 状态：{terminal_status} → {after_ack.get('status')}")
    else:
        ok("ack 不改变 Job 状态（确认不等于状态迁移）")


def main() -> int:
    parser = argparse.ArgumentParser(description="Workflow Protocol v1 验收")
    parser.add_argument("--live", action="store_true", help="对着真实执行端验收（会真的提交一次作业）")
    parser.add_argument("--pixivflow-url", default="")
    parser.add_argument("--pixivflow-token", default="")
    parser.add_argument("--tags", nargs="+", default=["西瓜肚"])
    parser.add_argument("--exclude", nargs="*", default=["work:149713091"])
    parser.add_argument("--idempotency-key", default="")
    parser.add_argument("--correlation-id", default="protocol-acceptance")
    parser.add_argument("--wait", type=int, default=240, help="等待终态的最长秒数")
    parser.add_argument("--poll", type=int, default=15)
    parser.add_argument("--cancel-after", type=int, default=0, help=">0 时在该秒数后取消作业")
    parser.add_argument("--expect", default="", help="期望终态（可选）")
    parser.add_argument("--vendored", nargs="*", default=[], help="要核对 vendored 副本的仓库路径（默认 ../TelePost ../PixivFlow）")
    args = parser.parse_args()

    if args.vendored:
        global VENDORED_DIRS
        VENDORED_DIRS = [Path(item).expanduser().resolve() for item in args.vendored]

    check_offline()

    if args.live:
        if not args.pixivflow_url:
            print("[FAIL] --live 需要 --pixivflow-url", file=sys.stderr)
            return 2
        if not args.idempotency_key:
            args.idempotency_key = f"protocol-acceptance-{int(time.time())}"
        check_live(args)
    else:
        skip("未加 --live，跳过联网验收（capabilities / jobs / cancel）")

    print()
    if FAILURES:
        print(f"[FAIL] {len(FAILURES)} 项未通过")
        return 1
    print("[OK]   Workflow Protocol v1 验收通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
