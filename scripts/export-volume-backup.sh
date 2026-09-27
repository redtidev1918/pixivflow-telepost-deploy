#!/usr/bin/env bash
#
# 卷备份导出：把两个 Fly 卷上的持久状态导出一份到本机，并留下可复核的清单。
#
# 为什么存在：Fly 卷快照只保留 5 份（snapshot_retention = 5，约 5 天），比静默损坏的
# 发现周期短，而且 Fly 之外没有任何副本，也没有演练过的恢复。本脚本补上「一份离开
# Fly 的拷贝 + 一份逐文件 sha256 清单」。
#
# 契约来源：docs/operations/backup.md（备份对象 / 绝不备份 / SQLite 三件套 / 恢复流程）。
#
# 只读保证（生产端）：
#   * 不写、不改、不删 /app/data 下的任何文件，也不碰卷上的其它路径。
#   * 不 start/stop/scale 机器：机器是 stopped 时报 [FAIL] 并给出该由人敲的命令。
#   * 远端只在容器的 /tmp 里搭中转目录，打包完成后删除（中转目录不是持久状态）。
#   * 凭据不出卷：文件名像凭据的路径整条拒绝导出；JSON 里命中凭据规则的键/值
#     **在容器内**先脱敏再打包，本机只会落盘脱敏后的内容。清单里只留 sha256（不可逆）。
#
# 导出内容（backup.md 的备份对象，按卷分，不合并）：
#   telepost  卷 data（vol_4y5e58mylle1nnjr）           /app/data/bot{N}/…
#   pixivflow 卷 pixivflow_data（vol_r68wlk8ynj1x5lq4） /app/data/…
#   SQLite 一律「主文件 + -wal + -shm 在同一个 tar 动作里」，绝不单独拷一个 .db。
#   默认连带 downloads/（downloads 是可重建缓存，代价是重新访问 Pixiv；用
#   --exclude downloads 可以只导不可重建的状态）。
#
# 用法：
#   ./scripts/export-volume-backup.sh [选项]
#
# 选项：
#   --plane all|telepost|pixivflow  要导出的平面（默认 all）
#   --out DIR                       导出根目录（默认 ${VOLUME_BACKUP_ROOT}，否则
#                                   ${HOME}/.local/share/pixivflow-volume-backups）
#   --exclude PATH                  额外排除的卷内相对路径，可重复（例：downloads）
#   --include-logs                  连带导出 *.log（默认不导：日志不是状态）
#   --no-compress                   不打 gzip，直接留 .tar
#   --keep-remote                   保留容器 /tmp 里的中转目录（排错用）
#   --strict-integrity              源库 PRAGMA integrity_check 不是 ok 就整体失败（exit 7）；
#                                   默认只记 [WARN] 并写进 manifest/verification（理由：ops 手工留的
#                                   `*.bak-*` 副本若本身可疑，不该阻断整份备份）
#   -h, --help                      打印这段用法
#
# 机器是 stopped 时（pixivflow 的设计态，机器 83d1650bd23948 / app pixivflow-scheduler）：
#   报 [FAIL] 并 exit 3。脚本**不会**替你启动机器。要么先
#     fly machine start 83d1650bd23948 -a pixivflow-scheduler
#   导出完再
#     fly machine stop 83d1650bd23948 -a pixivflow-scheduler
#   要么改用平台快照：fly volumes snapshots list vol_r68wlk8ynj1x5lq4
#   业务端（telesubmit-multi-bot）常驻，不需要任何机器操作。
#
# 退出码：0 成功；2 用法错误；3 机器 stopped；4 本机前置条件不满足；
#         5 远端导出失败；6 传输/校验失败；7 源库 PRAGMA integrity_check 不是 ok
#         （只有显式 --strict-integrity 才会走到 7；默认是 [WARN] + 记进清单）
set -euo pipefail

repo_dir=$(cd "$(dirname "$0")/.." && pwd)
cd "$repo_dir"

# fly 走代理会 EOF（api.machines.dev 在有 HTTPS_PROXY 时返回 `Get …: EOF`），一律清掉。
export ALL_PROXY='' all_proxy='' http_proxy='' https_proxy='' NO_PROXY='*'

plane=all
out_root=${VOLUME_BACKUP_ROOT:-${HOME}/.local/share/pixivflow-volume-backups}
include_logs=0
compress=1
keep_remote=0
strict_integrity=0
# 用字符串而不是数组：macOS 自带 bash 3.2 在 `set -u` 下展开空数组 `"${a[@]}"` 会报
# `unbound variable`（本轮实测撞到）。--exclude 的值已被限定在 [A-Za-z0-9._/-]，空格分隔安全。
exclude_args=''
failures=0

ok() { printf '[OK]   %s\n' "$*"; }
fail() { printf '[FAIL] %s\n' "$*"; failures=$((failures + 1)); }
warn() { printf '[WARN] %s\n' "$*"; }
info() { printf '[INFO] %s\n' "$*"; }
usage() { awk 'NR > 1 { if ($0 == "set -euo pipefail") exit; print }' "$0"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --plane)
      plane=${2:-}
      shift 2
      ;;
    --out)
      out_root=${2:-}
      shift 2
      ;;
    --exclude)
      value=${2:-}
      case "$value" in
        ''|*[!A-Za-z0-9._/-]*)
          printf '[FAIL] --exclude 只接受卷内相对路径（[A-Za-z0-9._/-]）：%s\n' "$value" >&2
          exit 2
          ;;
      esac
      exclude_args="${exclude_args} ${value}"
      shift 2
      ;;
    --include-logs)
      include_logs=1
      shift
      ;;
    --no-compress)
      compress=0
      shift
      ;;
    --keep-remote)
      keep_remote=1
      shift
      ;;
    --strict-integrity)
      strict_integrity=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf '[FAIL] 未知参数：%s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

case "$plane" in
  all|telepost|pixivflow) ;;
  *)
    printf '[FAIL] --plane 只能是 all|telepost|pixivflow：%s\n' "$plane" >&2
    exit 2
    ;;
esac

for tool in fly python3 tar gzip curl; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    printf '[FAIL] 缺少本机命令：%s\n' "$tool" >&2
    exit 4
  fi
done
if command -v shasum >/dev/null 2>&1; then
  sha256_of() { shasum -a 256 "$1" | awk '{print $1}'; }
elif command -v sha256sum >/dev/null 2>&1; then
  sha256_of() { sha256sum "$1" | awk '{print $1}'; }
else
  printf '[FAIL] 需要 shasum 或 sha256sum\n' >&2
  exit 4
fi
if ! fly auth whoami >/dev/null 2>&1; then
  printf '[FAIL] fly 未登录（先 fly auth login）\n' >&2
  exit 4
fi

plane_app() {
  case "$1" in
    telepost) printf '%s' "${TELEPOST_APP:-telesubmit-multi-bot}" ;;
    pixivflow) printf '%s' "${PIXIVFLOW_APP:-pixivflow-scheduler}" ;;
  esac
}
plane_volume() {
  case "$1" in
    telepost) printf '%s' "${TELEPOST_VOLUME_ID:-vol_4y5e58mylle1nnjr}" ;;
    pixivflow) printf '%s' "${PIXIVFLOW_VOLUME_ID:-vol_r68wlk8ynj1x5lq4}" ;;
  esac
}

# 远端导出脚本：用 `fly ssh console -C "sh -s -- ARG…"` 把这段喂进容器执行。
# 参数：ROOT DATA INCLUDE_LOGS KEEP_REMOTE [operator-exclude…]
remote_exporter() {
  cat <<'REMOTE_EOF'
set -eu
ROOT=$1
DATA=$2
INCLUDE_LOGS=$3
KEEP_REMOTE=$4
COMPRESS=$5
shift 5

STAGE=$ROOT/tree
META=$ROOT/_meta
PROBE=$ROOT/probe
rm -rf "$ROOT"
mkdir -p "$STAGE" "$META" "$PROBE"

excludes_file=$ROOT/operator-excludes.txt
: > "$excludes_file"
for x in "$@"; do printf '%s\n' "$x" >> "$excludes_file"; done

exclusion_reason() {
  rel=$1
  base=${rel##*/}
  case "$rel" in
    lost+found|lost+found/*)
      printf '%s\n' 'never-back-up: 文件系统保留目录，不是状态（backup.md 绝不备份）'
      return 0
      ;;
    api_uploads|api_uploads/*)
      printf '%s\n' 'never-back-up: 临时媒体（原始投稿文件，进审核群后即删，backup.md 绝不备份）'
      return 0
      ;;
  esac
  case "$base" in
    .env|.env.*|*.pem|*.key|*.p12|*.pfx|id_rsa*|.netrc|.pgpass)
      printf '%s\n' 'never-back-up: 凭据（按凭据契约重新下发，不进备份）'
      return 0
      ;;
  esac
  case "$base" in
    *token*|*Token*|*secret*|*Secret*|*password*|*passwd*|*api_key*|*apikey*|*credential*|*Credential*)
      printf '%s\n' 'never-back-up: 文件名像凭据（token/secret/password/api_key）'
      return 0
      ;;
  esac
  if [ "$INCLUDE_LOGS" -eq 0 ]; then
    case "$base" in
      *.log)
        printf '%s\n' 'default-skip: 日志不是状态，且不保证不含凭据形状的字符串（--include-logs 可显式加入）'
        return 0
        ;;
    esac
  fi
  while IFS= read -r x; do
    case "$rel" in
      "$x"|"$x"/*)
        printf '%s\n' "operator-exclude: --exclude ${x}"
        return 0
        ;;
    esac
  done < "$excludes_file"
  return 0
}

find "$DATA" -type f | LC_ALL=C sort > "$ROOT/all-files.txt"

# 1. 排除清单：一条不落，全部留证，绝不静默丢文件。
while IFS= read -r f; do
  rel=${f#"$DATA"/}
  reason=$(exclusion_reason "$rel")
  if [ -n "$reason" ]; then printf '%s\t%s\n' "$rel" "$reason"; fi
done < "$ROOT/all-files.txt" > "$META/EXCLUDED.tsv"

# 2. SQLite 三件套：主文件与 -wal/-shm 在同一个 tar 动作里（backup.md §SQLite 安全）。
# 伴生后缀是裸的 `-wal` / `-shm`：写成 `.db-wal` 会把 `x.db-wal` 削成 `x`（少了 `.db`），
# 本轮实测就是这么踩的。主文件按扩展名认（`*.db`），伴生文件按后缀认——这样 ops 手工留的
# `submissions.db.bak-…-wal` 这类也会和它的主文件一起原子拷。
: > "$META/ORPHANS.tsv"
: > "$META/TRIPLE_BASES.txt"
while IFS= read -r f; do
  rel=${f#"$DATA"/}
  case "$rel" in
    *.db) dbfile=$rel ;;
    *-wal) dbfile=${rel%-wal} ;;
    *-shm) dbfile=${rel%-shm} ;;
    *) continue ;;
  esac
  if [ ! -f "$DATA/$dbfile" ]; then
    printf '%s\t%s\n' "$rel" "orphan-companion: 找不到主文件 ${dbfile}，这个文件按普通文件导出" >> "$META/ORPHANS.tsv"
    continue
  fi
  reason=$(exclusion_reason "$dbfile")
  if [ -z "$reason" ]; then printf '%s\n' "$dbfile" >> "$META/TRIPLE_BASES.txt"; fi
done < "$ROOT/all-files.txt"
LC_ALL=C sort -u -o "$META/TRIPLE_BASES.txt" "$META/TRIPLE_BASES.txt"

: > "$META/ATOMIC_TRIPLES.tsv"
: > "$ROOT/consumed.txt"
while IFS= read -r dbfile; do
  dir=${dbfile%/*}
  name=${dbfile##*/}
  if [ "$dir" = "$dbfile" ]; then dir=.; fi
  if [ "$dir" = "." ]; then outdir=$STAGE; else outdir=$STAGE/$dir; fi
  mkdir -p "$outdir"
  : > "$ROOT/members.txt"
  printf '%s\n' "$name" >> "$ROOT/members.txt"
  printf '%s\n' "$dbfile" >> "$ROOT/consumed.txt"
  members=$name
  if [ -f "$DATA/${dbfile}-wal" ]; then
    printf '%s\n' "${name}-wal" >> "$ROOT/members.txt"
    printf '%s\n' "${dbfile}-wal" >> "$ROOT/consumed.txt"
    members="$members ${name}-wal"
  fi
  if [ -f "$DATA/${dbfile}-shm" ]; then
    printf '%s\n' "${name}-shm" >> "$ROOT/members.txt"
    printf '%s\n' "${dbfile}-shm" >> "$ROOT/consumed.txt"
    members="$members ${name}-shm"
  fi
  # 一个 tar 动作生成（这是「原子」的那一步），再单独解开；不用管道，免得 tar 的失败
  # 被管道最后一段的成功掩掉（dash 没有 pipefail，本轮实测吃过这个亏）。
  tar -C "$DATA/$dir" -cf "$ROOT/triple.tar" -T "$ROOT/members.txt"
  tar -C "$outdir" -xf "$ROOT/triple.tar"
  rm -f "$ROOT/triple.tar"
  printf '%s\t%s\n' "$dbfile" "$members" >> "$META/ATOMIC_TRIPLES.tsv"
done < "$META/TRIPLE_BASES.txt"

# 3. 其余文件按原路径复制（保留 mtime/mode）。三件套已经原子拷过的成员跳过，别拷第二遍。
while IFS= read -r f; do
  rel=${f#"$DATA"/}
  if [ -s "$ROOT/consumed.txt" ] && grep -Fxq -- "$rel" "$ROOT/consumed.txt"; then continue; fi
  reason=$(exclusion_reason "$rel")
  if [ -n "$reason" ]; then continue; fi
  mkdir -p "$STAGE/$(dirname "$rel")"
  cp -p "$f" "$STAGE/$rel"
done < "$ROOT/all-files.txt"

# 4. 远端就地脱敏：凭据值不能进 tar，更不能落到本机磁盘。
cat > "$ROOT/redact.py" <<'PY'
import hashlib
import json
import os
import re
import sys

stage, meta = sys.argv[1], sys.argv[2]

KEY_RULE = re.compile(
    r"(?i)(token|secret|password|passwd|credential|authorization|cookie"
    r"|api[_-]?key|private[_-]?key|bearer|session[_-]?id)"
)
VALUE_RULES = (
    ("bearer-value", re.compile(r"(?i)^\s*bearer\s+\S")),
    (
        "credential-in-url",
        re.compile(r"(?i)[?&](access_token|token|api[_-]?key|apikey|key|secret|signature|sig|password)="),
    ),
)
PLACEHOLDER = "<redacted-by-export-volume-backup>"
DECLARED_CONFIGS = {"production.json", "config.json", "runtime-policy.json"}


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


source_rows = []
redacted_rows = []
unparsed_rows = []

for root, dirs, files in os.walk(stage):
    dirs.sort()
    for name in sorted(files):
        if not name.endswith(".json"):
            continue
        path = os.path.join(root, name)
        rel = os.path.relpath(path, stage)
        source_rows.append((rel, sha256(path)))
        try:
            with open(path, encoding="utf-8") as handle:
                data = json.load(handle)
        except Exception as exc:  # noqa: BLE001 - 记录原因比掩盖好
            if name in DECLARED_CONFIGS:
                sys.stderr.write(f"[FAIL] {rel}: 声明的运行配置不是合法 JSON：{exc}\n")
                raise SystemExit(1)
            unparsed_rows.append((rel, f"{type(exc).__name__}: {exc}"))
            continue

        hits = []

        def walk(node, prefix):
            if isinstance(node, dict):
                for key, value in node.items():
                    child = f"{prefix}.{key}"
                    if isinstance(value, (dict, list)):
                        walk(value, child)
                        continue
                    if KEY_RULE.search(str(key)):
                        node[key] = PLACEHOLDER
                        hits.append((child, "key-name"))
                        continue
                    if isinstance(value, str):
                        for label, pattern in VALUE_RULES:
                            if pattern.search(value):
                                node[key] = PLACEHOLDER
                                hits.append((child, label))
                                break
            elif isinstance(node, list):
                for index, value in enumerate(node):
                    walk(value, f"{prefix}[{index}]")

        walk(data, "")
        if hits:
            # 只有真的脱敏过才重写；没命中的 JSON 保持字节不变（不制造 diff 噪声）。
            with open(path, "w", encoding="utf-8") as handle:
                json.dump(data, handle, ensure_ascii=False, indent=2)
                handle.write("\n")
            for child, label in hits:
                redacted_rows.append((rel, child, label))

with open(os.path.join(meta, "SOURCE_SHA256.tsv"), "w", encoding="utf-8") as handle:
    for rel, digest in source_rows:
        handle.write(f"{rel}\t{digest}\n")
with open(os.path.join(meta, "REDACTED.tsv"), "w", encoding="utf-8") as handle:
    for rel, child, label in redacted_rows:
        handle.write(f"{rel}\t{child}\t{label}\n")
with open(os.path.join(meta, "REDACT_UNPARSED.tsv"), "w", encoding="utf-8") as handle:
    for rel, detail in unparsed_rows:
        handle.write(f"{rel}\t{detail}\n")

print(f"RESULT json_files={len(source_rows)} redacted_keys={len(redacted_rows)}")
for rel, child, label in redacted_rows:
    sys.stderr.write(f"[INFO] 脱敏 {rel}: {child} ({label})\n")
PY
python3 "$ROOT/redact.py" "$STAGE" "$META" || exit 1

# 5. 源库可打开性抽查：只在 /tmp 的副本上做，绝不碰 /app/data。
cat > "$ROOT/probe.py" <<'PY'
import hashlib
import os
import shutil
import sqlite3
import sys

stage, triples_tsv, probe_root, meta = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
rows = []

for raw in open(triples_tsv, encoding="utf-8"):
    line = raw.rstrip("\n")
    if not line:
        continue
    rel = line.split("\t", 1)[0]
    src = os.path.join(stage, rel)
    target_dir = os.path.join(probe_root, hashlib.sha256(rel.encode("utf-8")).hexdigest()[:16])
    os.makedirs(target_dir, exist_ok=True)
    name = os.path.basename(rel)
    for suffix in ("", "-wal", "-shm"):
        candidate = src + suffix
        if os.path.exists(candidate):
            shutil.copy2(candidate, os.path.join(target_dir, name + suffix))
    target = os.path.join(target_dir, name)
    try:
        connection = sqlite3.connect(f"file:{target}?mode=ro", uri=True)
        try:
            result = connection.execute("PRAGMA integrity_check;").fetchone()[0]
        finally:
            connection.close()
        rows.append((rel, "ok" if result == "ok" else "failed", str(result)))
    except Exception as exc:  # noqa: BLE001 - 探针失败要如实记下
        rows.append((rel, "probe-error", f"{type(exc).__name__}: {exc}"))

with open(os.path.join(meta, "INTEGRITY.tsv"), "w", encoding="utf-8") as handle:
    for rel, status, detail in rows:
        handle.write(f"{rel}\t{status}\t{detail}\n")

bad = [row for row in rows if row[1] != "ok"]
# 一行一个 key：本机解析用 `sed -n 's/^RESULT KEY=//p'`，一行里塞两个 key 会解析不到。
print(f"RESULT integrity_ok={len(rows) - len(bad)}")
print(f"RESULT integrity_bad={len(bad)}")
for rel, status, detail in bad:
    sys.stderr.write(f"[WARN] 源库抽查不通过：{rel} {status} {detail}\n")
PY
python3 "$ROOT/probe.py" "$STAGE" "$META/ATOMIC_TRIPLES.tsv" "$PROBE" "$META" ||
  printf '%s\n' '[WARN] 源库抽查探针自身出错，结论以本机复演为准' >&2

# 6. 逐文件清单：字节数 + sha256（一次 python 走完，别给每个文件起三个进程）。
cat > "$ROOT/manifest_files.py" <<'PY'
import hashlib
import os
import sys

stage, out = sys.argv[1], sys.argv[2]


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


count = 0
total = 0
with open(out, "w", encoding="utf-8") as handle:
    for root, dirs, files in os.walk(stage):
        dirs.sort()
        for name in sorted(files):
            path = os.path.join(root, name)
            rel = os.path.relpath(path, stage)
            size = os.path.getsize(path)
            count += 1
            total += size
            handle.write(f"{rel}\t{size}\t{sha256(path)}\n")

print(f"RESULT staged_files={count}")
print(f"RESULT staged_bytes={total}")
PY
python3 "$ROOT/manifest_files.py" "$STAGE" "$META/files.tsv"

# 7. 打包 + 自哈希（包放在 $ROOT 之外，避免把自己装进去）。
if [ "$COMPRESS" -eq 1 ]; then
  TARBALL=$ROOT.tar.gz
  rm -f "$TARBALL"
  tar -C "$ROOT" -cf - tree _meta | gzip -1 > "$TARBALL"
else
  TARBALL=$ROOT.tar
  rm -f "$TARBALL"
  tar -C "$ROOT" -cf "$TARBALL" tree _meta
fi
tarball_bytes=$(stat -c %s "$TARBALL")
tarball_sha=$(sha256sum "$TARBALL" | cut -d' ' -f1)
revision=$(printenv PIXIVFLOW_REVISION 2>/dev/null || true)

printf 'RESULT tarball=%s\n' "$TARBALL"
printf 'RESULT tarball_bytes=%s\n' "$tarball_bytes"
printf 'RESULT tarball_sha256=%s\n' "$tarball_sha"
printf 'RESULT remote_root=%s\n' "$ROOT"
printf 'RESULT data_root=%s\n' "$DATA"
printf 'RESULT runtime_revision=%s\n' "$revision"

if [ "$KEEP_REMOTE" -eq 0 ]; then
  rm -rf "$ROOT"
  printf 'RESULT staging_removed=true\n'
else
  printf 'RESULT staging_removed=false\n'
fi
REMOTE_EOF
}

build_manifest_py() {
  cat <<'PY'
import hashlib
import json
import os
import re
import sys

export_dir = sys.argv[1]
data_dir = os.path.join(export_dir, "data")
meta_dir = os.path.join(export_dir, "_meta")

plane = os.environ["PLANE"]
app = os.environ["APP"]
volume_id = os.environ["VOLUME_ID"]

CREDENTIAL_NAME = re.compile(
    r"(?i)(^\.env|\.env\.|token|secret|password|passwd|api[_-]?key|apikey|credential|\.pem$|\.key$|id_rsa)"
)


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_tsv(name):
    path = os.path.join(meta_dir, name)
    rows = []
    if not os.path.exists(path):
        return rows
    for raw in open(path, encoding="utf-8"):
        line = raw.rstrip("\n")
        if line:
            rows.append(line.split("\t"))
    return rows


problems = []
files = []
total_bytes = 0
for rel, size, digest in read_tsv("files.tsv"):
    path = os.path.join(data_dir, rel)
    if not os.path.isfile(path):
        problems.append(f"缺文件：{rel}")
        continue
    local_size = os.path.getsize(path)
    local_digest = sha256(path)
    if str(local_size) != size:
        problems.append(f"字节数不符：{rel} {local_size} != {size}")
    elif local_digest != digest:
        problems.append(f"sha256 不符：{rel}")
    files.append({"path": rel, "bytes": local_size, "sha256": local_digest})
    total_bytes += local_size

for entry in list(files):
    name = os.path.basename(entry["path"])
    if CREDENTIAL_NAME.search(name):
        problems.append(f"导出树里出现像凭据的文件名：{entry['path']}")

excluded = [{"path": row[0], "reason": row[1]} for row in read_tsv("EXCLUDED.tsv") if len(row) > 1]
orphans = [{"path": row[0], "reason": row[1]} for row in read_tsv("ORPHANS.tsv") if len(row) > 1]
redacted = [{"file": row[0], "path": row[1], "rule": row[2]} for row in read_tsv("REDACTED.tsv") if len(row) > 2]
source_hashes = {row[0]: row[1] for row in read_tsv("SOURCE_SHA256.tsv") if len(row) > 1}
triples = [{"db": row[0], "members": row[1].split()} for row in read_tsv("ATOMIC_TRIPLES.tsv") if len(row) > 1]
integrity_rows = read_tsv("INTEGRITY.tsv")
integrity = [
    {"path": row[0], "status": row[1], "detail": row[2] if len(row) > 2 else ""}
    for row in integrity_rows
]
if triples and not integrity:
    problems.append("远端没有对任何 SQLite 三件套产出 INTEGRITY.tsv")

machine = json.load(open(os.environ["MACHINES_JSON"], encoding="utf-8"))
volume = json.load(open(os.environ["VOLUMES_JSON"], encoding="utf-8"))
try:
    health = json.load(open(os.environ["HEALTH_JSON"], encoding="utf-8"))
except Exception:  # noqa: BLE001 - 拿不到就记空
    health = {}
if not isinstance(health, dict):
    health = {}

machine_keys = ("id", "name", "state", "region", "image_ref", "created_at", "updated_at", "instance_id")
volumes = {item.get("id"): item for item in volume}

# 只取白名单字段：`fly machine list --json` 的 config.env 可能带 secret，绝不整份落盘。
machines_out = []
for item in machine:
    config = item.get("config") or {}
    slim = {key: item[key] for key in machine_keys if key in item}
    slim["mounts"] = config.get("mounts")
    slim["guest"] = config.get("guest")
    slim["fly_release_version"] = (config.get("metadata") or {}).get("fly_release_version")
    machines_out.append(slim)

volume_out = None
if volume_id in volumes:
    item = volumes[volume_id]
    volume_out = {
        key: item.get(key)
        for key in (
            "id",
            "name",
            "state",
            "size_gb",
            "region",
            "zone",
            "encrypted",
            "snapshot_retention",
            "auto_backup_enabled",
            "attached_machine_id",
            "created_at",
        )
    }

tarball_name = os.environ["TARBALL_NAME"]
manifest = {
    "schema": "pixivflow-volume-backup/1",
    "generated_at": os.environ["GENERATED_AT"],
    "tool": "scripts/export-volume-backup.sh",
    "plane": plane,
    "app": app,
    "volume": volume_out,
    "machines": machines_out,
    "source": {
        "data_root": os.environ["DATA_ROOT"],
        "runtime_revision": os.environ.get("RUNTIME_REVISION") or None,
        "runtime_revision_source": "容器内 printenv PIXIVFLOW_REVISION（业务端无此变量，见 health 的 version/commit）",
        "health": health,
    },
    "repo_pins": {
        "PIXIVFLOW_REF": os.environ.get("PIXIVFLOW_REF") or None,
        "PIXIVFLOW_VERSION": os.environ.get("PIXIVFLOW_VERSION") or None,
        "TELEPOST_IMAGE": os.environ.get("TELEPOST_IMAGE") or None,
    },
    "export": {
        "tarball": tarball_name,
        "tarball_bytes": int(os.environ["TARBALL_BYTES"]),
        "tarball_sha256": os.environ["TARBALL_SHA256"],
        "compressed": os.environ["COMPRESS"] == "1",
        "include_logs": os.environ["INCLUDE_LOGS"] == "1",
        "remote_retention": "容器 /tmp 中转目录已删除" if os.environ["STAGING_REMOVED"] == "true" else "容器 /tmp 中转目录保留（--keep-remote）",
    },
    "sqlite_triples": triples,
    "orphan_companions": orphans,
    "integrity_probe": integrity,
    "redaction": {
        "policy": "在容器内脱敏：键名或值命中凭据规则的 JSON 值替换为占位符；文件名像凭据的路径整条拒绝导出",
        "redacted_keys": redacted,
        "source_sha256": source_hashes,
    },
    "excluded": excluded,
    "files": files,
    "totals": {"files": len(files), "bytes": total_bytes},
    "verified": {
        "transfer_sha256_match": True,
        "file_count": len(files),
        "all_file_sha256_match": not problems,
        "source_integrity_all_ok": not [row for row in integrity if row["status"] != "ok"],
        "source_integrity_strict": os.environ.get("STRICT_INTEGRITY") == "1",
    },
}

with open(os.path.join(export_dir, "manifest.json"), "w", encoding="utf-8") as handle:
    json.dump(manifest, handle, ensure_ascii=False, indent=2)
    handle.write("\n")

lines = [
    f"plane={plane} app={app} volume={volume_id}",
    f"files={len(files)} bytes={total_bytes}",
    f"excluded={len(excluded)} orphan_companions={len(orphans)} redacted_keys={len(redacted)}",
    f"sqlite_triples={len(triples)}",
]
for row in integrity:
    lines.append(f"integrity {row['path']} {row['status']} {row['detail']}")
lines.append("per-file sha256: 全部与远端一致" if not problems else "per-file sha256: 有差异")
with open(os.path.join(export_dir, "verification.txt"), "w", encoding="utf-8") as handle:
    handle.write("\n".join(lines) + "\n")

for line in lines:
    print(f"[INFO] {line}")
if problems:
    for problem in problems[:20]:
        print(f"[FAIL] {problem}", file=sys.stderr)
    raise SystemExit(1)
bad = [row for row in integrity if row["status"] != "ok"]
if bad:
    # 源库抽查不通过：默认只警告（ops 手工留的 *.bak-* 副本可疑不该阻断整份备份），
    # 只有显式 --strict-integrity 才整体失败。
    for row in bad:
        print(f"[WARN] 源库 integrity_check 不是 ok：{row['path']} {row['status']} {row['detail']}", file=sys.stderr)
    if os.environ.get("STRICT_INTEGRITY") == "1":
        raise SystemExit(7)
print("[OK]   逐文件 sha256 校验通过（本地 == 远端）")
PY
}

export_plane() {
  plane_name=$1
  app=$(plane_app "$plane_name")
  volume_id=$(plane_volume "$plane_name")
  info "平面 ${plane_name}：app=${app} 卷=${volume_id}"

  machines_json=$run_tmp/${plane_name}-machines.json
  volumes_json=$run_tmp/${plane_name}-volumes.json
  health_json=$run_tmp/${plane_name}-health.json
  if ! fly machine list -a "$app" --json >"$machines_json" 2>"$run_tmp/${plane_name}-machine.err"; then
    fail "读不到 ${app} 的机器列表"
    return 4
  fi
  if ! fly volumes list -a "$app" --json >"$volumes_json" 2>/dev/null; then
    fail "读不到 ${app} 的卷列表"
    return 4
  fi

  started=$(python3 - "$machines_json" "$volume_id" <<'PY'
import json
import sys

machines = json.load(open(sys.argv[1], encoding="utf-8"))
volume_id = sys.argv[2]
for item in machines:
    if item.get("state") != "started":
        continue
    mounts = (item.get("config") or {}).get("mounts") or []
    if any(mount.get("volume") == volume_id for mount in mounts):
        print(item["id"])
        break
PY
)
  owner=$(python3 - "$machines_json" "$volume_id" <<'PY'
import json
import sys

machines = json.load(open(sys.argv[1], encoding="utf-8"))
volume_id = sys.argv[2]
for item in machines:
    mounts = (item.get("config") or {}).get("mounts") or []
    if any(mount.get("volume") == volume_id for mount in mounts):
        print(item["id"])
        break
PY
)
  if [ -z "$started" ]; then
    fail "平面 ${plane_name}：没有挂着 ${volume_id} 的 started 机器（脚本不会替你启动）"
    if [ -n "$owner" ]; then
      info "先 fly machine start ${owner} -a ${app}，导出完再 fly machine stop ${owner} -a ${app}"
    fi
    info "或改用平台快照：fly volumes snapshots list ${volume_id}"
    return 3
  fi
  ok "机器 ${started} 在跑，卷 ${volume_id} 已挂载"

  case "$plane_name" in
    telepost)
      curl -s --max-time 20 "${TELEPOST_HEALTH_URL:-https://${app}.fly.dev/health}" -o "$health_json" 2>/dev/null ||
        printf '{}\n' >"$health_json"
      ;;
    *)
      printf '{}\n' >"$health_json"
      ;;
  esac

  remote_root=/tmp/vb-${plane_name}-${run_ts}
  remote_args="sh -s -- ${remote_root} /app/data ${include_logs} ${keep_remote} ${compress}"
  # 这里故意不加引号做分词：--exclude 的值只允许 [A-Za-z0-9._/-]，没有空格。
  for x in ${exclude_args}; do remote_args="${remote_args} ${x}"; done

  rc=0
  remote_out=$(remote_exporter | fly ssh console -a "$app" -C "$remote_args" 2>"$run_tmp/${plane_name}-remote.err") || rc=$?
  if [ "$rc" -ne 0 ]; then
    fail "远端导出失败（exit ${rc}）：${app}"
    tail -n 20 "$run_tmp/${plane_name}-remote.err" >&2 || true
    return 5
  fi

  result() { printf '%s\n' "$remote_out" | sed -n "s/^RESULT ${1}=//p" | head -n 1; }
  for key in tarball tarball_sha256 tarball_bytes staged_files staged_bytes; do
    if [ -z "$(result "$key")" ]; then
      fail "远端没有回报 ${key}"
      tail -n 20 "$run_tmp/${plane_name}-remote.err" >&2 || true
      return 5
    fi
  done
  ok "远端打包完成：$(result staged_files) 个文件 / $(result staged_bytes) B，tar 包 $(result tarball_bytes) B"

  dest=${out_dir}/${plane_name}
  mkdir -p "$dest"
  case "$(result tarball)" in
    *.tar.gz) local_tar=${dest}/volume-backup.tar.gz ;;
    *) local_tar=${dest}/volume-backup.tar ;;
  esac
  if ! fly sftp get -q -a "$app" "$(result tarball)" "$local_tar" >"$run_tmp/${plane_name}-sftp.log" 2>&1; then
    fail "下载失败：$(result tarball)"
    tail -n 10 "$run_tmp/${plane_name}-sftp.log" >&2 || true
    return 6
  fi
  local_sha=$(sha256_of "$local_tar")
  if [ "$local_sha" != "$(result tarball_sha256)" ]; then
    fail "传输校验失败：本地 ${local_sha} != 远端 $(result tarball_sha256)"
    return 6
  fi
  ok "传输校验通过（sha256 ${local_sha}）"

  unpack=$run_tmp/${plane_name}-unpack
  rm -rf "$unpack"
  mkdir -p "$unpack"
  tar -xf "$local_tar" -C "$unpack"
  if [ ! -d "$unpack/tree" ] || [ ! -d "$unpack/_meta" ]; then
    fail "包结构不对：缺少 tree/ 或 _meta/"
    return 6
  fi
  rm -rf "$dest/data" "$dest/_meta"
  mv "$unpack/tree" "$dest/data"
  mv "$unpack/_meta" "$dest/_meta"

  pixivflow_ref=$(python3 - fly/deploy.pixivflow.toml PIXIVFLOW_REF <<'PY'
import re
import sys

text = open(sys.argv[1], encoding="utf-8").read()
match = re.search(r"^\s*" + re.escape(sys.argv[2]) + r"\s*=\s*['\"]([^'\"]+)", text, re.M)
print(match.group(1) if match else "")
PY
)
  pixivflow_version=$(python3 - fly/deploy.pixivflow.toml PIXIVFLOW_VERSION <<'PY'
import re
import sys

text = open(sys.argv[1], encoding="utf-8").read()
match = re.search(r"^\s*" + re.escape(sys.argv[2]) + r"\s*=\s*['\"]([^'\"]+)", text, re.M)
print(match.group(1) if match else "")
PY
)
  telepost_image=$(python3 - fly/deploy.telepost.toml TELEPOST_IMAGE <<'PY'
import re
import sys

text = open(sys.argv[1], encoding="utf-8").read()
match = re.search(r"^\s*" + re.escape(sys.argv[2]) + r"\s*=\s*['\"]([^'\"]+)", text, re.M)
print(match.group(1) if match else "")
PY
)

  build_manifest_py >"$run_tmp/build-manifest.py"

  rc=0
  PLANE="$plane_name" \
    APP="$app" \
    VOLUME_ID="$volume_id" \
    MACHINES_JSON="$machines_json" \
    VOLUMES_JSON="$volumes_json" \
    HEALTH_JSON="$health_json" \
    DATA_ROOT="$(result data_root)" \
    RUNTIME_REVISION="$(result runtime_revision)" \
    TARBALL_NAME="$(basename "$local_tar")" \
    TARBALL_BYTES="$(result tarball_bytes)" \
    TARBALL_SHA256="$(result tarball_sha256)" \
    STAGING_REMOVED="$(result staging_removed)" \
    COMPRESS="$compress" \
    INCLUDE_LOGS="$include_logs" \
    STRICT_INTEGRITY="$strict_integrity" \
    GENERATED_AT="$run_ts" \
    PIXIVFLOW_REF="$pixivflow_ref" \
    PIXIVFLOW_VERSION="$pixivflow_version" \
    TELEPOST_IMAGE="$telepost_image" \
    python3 "$run_tmp/build-manifest.py" "$dest" >"$run_tmp/${plane_name}-verify.out" 2>&1 || rc=$?
  if [ "$rc" -ne 0 ]; then
    fail "导出包校验失败（exit ${rc}）：${dest}"
    tail -n 30 "$run_tmp/${plane_name}-verify.out" >&2 || true
    return "$rc"
  fi
  sed -n '1,40p' "$run_tmp/${plane_name}-verify.out"
  orphans=$(sed -n 's/.*orphan_companions=\([0-9][0-9]*\).*/\1/p' "$run_tmp/${plane_name}-verify.out" | head -n 1)
  if [ -n "$orphans" ] && [ "$orphans" -gt 0 ]; then
    warn "导出树里有 ${orphans} 个孤儿 -wal/-shm 文件（找不到对应的主库），已按普通文件导出，见 _meta/ORPHANS.tsv"
  fi
  ok "导出与校验完成：${dest}"
  return 0
}

run_ts=$(date -u +%Y%m%dT%H%M%SZ)
out_dir=${out_root}/${run_ts}
run_tmp=$(mktemp -d)
mkdir -p "$out_dir"
trap 'rm -rf "${run_tmp}"' EXIT
info "这次导出的根目录：${out_dir}"

case "$plane" in
  all) planes=(telepost pixivflow) ;;
  *) planes=("$plane") ;;
esac

overall=0
for plane_name in "${planes[@]}"; do
  rc=0
  export_plane "$plane_name" || rc=$?
  if [ "$rc" -ne 0 ]; then
    if [ "$rc" -gt "$overall" ]; then overall=$rc; fi
  fi
done

if [ "$overall" -ne 0 ]; then
  printf '[FAIL] 导出没有全部成功（worst exit %s）\n' "$overall" >&2
  exit "$overall"
fi
ok "全部平面导出并校验完成：${out_dir}"
exit 0
