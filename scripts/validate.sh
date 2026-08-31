#!/usr/bin/env bash
set -euo pipefail

repo_dir=$(cd "$(dirname "$0")/.." && pwd)
cd "$repo_dir"
mode=${1:-}
errors=0

fail() { echo "[FAIL] $*"; errors=$((errors + 1)); }
ok() { echo "[OK] $*"; }

while IFS= read -r file; do
  if python3 -m json.tool "$file" >/dev/null; then ok "$file JSON"; else fail "$file JSON"; fi
done < <(find config pixivflow/config fly/config -type f -name '*.json' -print | sort)
if [[ -f data/pixivflow/config.json ]]; then
  if python3 -m json.tool data/pixivflow/config.json >/dev/null; then ok "runtime PixivFlow JSON"; else fail "runtime PixivFlow JSON"; fi
fi

if python3 -c 'import tomllib' >/dev/null 2>&1; then
  while IFS= read -r file; do
    if python3 - "$file" <<'PY'
import sys
import tomllib

with open(sys.argv[1], "rb") as handle:
    tomllib.load(handle)
PY
    then ok "$file TOML"; else fail "$file TOML"; fi
  done < <(find fly -type f -name '*.toml' -print | sort)
else
  echo "[SKIP] TOML validation requires Python 3.11+"
fi

for file in scripts/*.sh proxy/docker-entrypoint.sh fly/scripts/*.sh; do
  if bash -n "$file"; then ok "$file shell syntax"; else fail "$file shell syntax"; fi
done

if python3 scripts/check_public_repo.py; then ok "public repository hygiene"; else fail "public repository hygiene"; fi

if command -v shellcheck >/dev/null; then
  if shellcheck scripts/*.sh proxy/docker-entrypoint.sh fly/scripts/*.sh; then ok "ShellCheck"; else fail "ShellCheck"; fi
else
  echo "[SKIP] ShellCheck is unavailable"
fi

if command -v docker >/dev/null && docker compose version >/dev/null 2>&1; then
  if docker compose --env-file .env.example config --quiet; then ok "Docker Compose model"; else fail "Docker Compose model"; fi
else
  echo "[SKIP] Docker Compose is unavailable"
fi

if [[ $mode != "--examples" ]]; then
  [[ -f .env ]] || fail ".env missing; run ./scripts/bootstrap.sh"
  [[ -f data/pixivflow/config.json ]] || fail "data/pixivflow/config.json missing; run ./scripts/bootstrap.sh"
  if [[ -f .env ]]; then
    python3 - .env <<'PY' || errors=$((errors + 1))
import sys
values = {}
for raw in open(sys.argv[1], encoding="utf-8"):
    line = raw.strip()
    if not line or line.startswith("#") or "=" not in line:
        continue
    key, value = line.split("=", 1)
    values[key] = value.strip()
missing = [key for key in ("BOT1_TOKEN", "BOT1_CHANNEL_ID") if not values.get(key)]
if missing:
    print("[FAIL] missing required values: " + ", ".join(missing))
    raise SystemExit(1)
print("[OK] required deployment values")
PY
  fi
fi

if [[ $errors -gt 0 ]]; then
  echo "Validation failed with $errors error(s)."
  exit 1
fi
echo "Validation passed."
