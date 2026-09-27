#!/usr/bin/env bash
# Sync the PixivFlow <-> TelePost Workflow Protocol assets from the deploy repo's
# docs/protocol/<version>/ into the consuming repos (vendored copy + SOURCES.sha256).
#
#   scripts/sync-protocol.sh                 # sync into ../TelePost and ../PixivFlow
#   scripts/sync-protocol.sh /path/to/repo   # sync into explicit repos
#   scripts/sync-protocol.sh --check         # verify vendored copies, write nothing
#
# The protocol spec itself lives in docs/architecture/workflow-protocol.md; this script
# only distributes the machine-checkable half (schema + fixtures).
set -euo pipefail

repo_dir=$(cd "$(dirname "$0")/.." && pwd)
version=${PROTOCOL_VERSION:-v1}
source_dir="$repo_dir/docs/protocol/$version"

check=0
if [ "${1:-}" = "--check" ]; then
  check=1
  shift
fi

targets=("$@")
if [ ${#targets[@]} -eq 0 ]; then
  targets=("$repo_dir/../TelePost" "$repo_dir/../PixivFlow")
fi

if [ ! -f "$source_dir/protocol.schema.json" ]; then
  echo "missing protocol source: $source_dir/protocol.schema.json" >&2
  exit 1
fi

# Relative paths that make up a vendored copy. Keep sorted for a stable manifest.
rel_paths=("protocol.schema.json")
while IFS= read -r f; do
  rel_paths+=("fixtures/$f")
done < <(cd "$source_dir/fixtures" && ls -1 *.json | LC_ALL=C sort)

hash_file() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    sha256sum "$1" | awk '{print $1}'
  fi
}

errors=0
for target in "${targets[@]}"; do
  dest="$target/protocol/$version"
  if [ ! -d "$target" ]; then
    echo "[FAIL] $target is not a directory" >&2
    errors=$((errors + 1))
    continue
  fi

  if [ "$check" = "1" ]; then
    for rel in "${rel_paths[@]}"; do
      if [ ! -f "$dest/$rel" ]; then
        echo "[FAIL] $dest/$rel missing (run scripts/sync-protocol.sh)" >&2
        errors=$((errors + 1))
        continue
      fi
      if ! cmp -s "$source_dir/$rel" "$dest/$rel"; then
        echo "[FAIL] $dest/$rel differs from $source_dir/$rel" >&2
        errors=$((errors + 1))
      fi
    done
    if [ -f "$dest/SOURCES.sha256" ]; then
      while read -r want rel; do
        [ -n "$rel" ] || continue
        if [ ! -f "$dest/$rel" ]; then
          echo "[FAIL] $dest/$rel listed in SOURCES.sha256 but missing" >&2
          errors=$((errors + 1))
          continue
        fi
        got=$(hash_file "$dest/$rel")
        if [ "$got" != "$want" ]; then
          echo "[FAIL] $dest/$rel sha256 $got != recorded $want" >&2
          errors=$((errors + 1))
        fi
      done < "$dest/SOURCES.sha256"
    else
      echo "[FAIL] $dest/SOURCES.sha256 missing" >&2
      errors=$((errors + 1))
    fi
    echo "[OK] checked $dest ($((${#rel_paths[@]} + 1)) files)"
    continue
  fi

  mkdir -p "$dest/fixtures"
  cp "$source_dir/protocol.schema.json" "$dest/protocol.schema.json"
  for rel in "${rel_paths[@]}"; do
    case "$rel" in
      fixtures/*) cp "$source_dir/$rel" "$dest/$rel" ;;
    esac
  done

  : > "$dest/SOURCES.sha256"
  for rel in "${rel_paths[@]}"; do
    printf '%s  %s\n' "$(hash_file "$dest/$rel")" "$rel" >> "$dest/SOURCES.sha256"
  done
  echo "[OK] synced $dest ($((${#rel_paths[@]} + 1)) files)"
done

if [ "$errors" -gt 0 ]; then
  echo "protocol sync: $errors problem(s)" >&2
  exit 1
fi

if [ "$check" = "0" ]; then
  echo "next: run the consumer contract tests (TelePost: tests/test_protocol_contract.py, PixivFlow: src/__tests__/protocol/contract.test.ts)"
fi
