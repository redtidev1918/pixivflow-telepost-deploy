#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 || ( $# -eq 2 && $2 != "--no-restart" ) ]]; then
  echo "Usage: $0 <policy.json> [--no-restart]" >&2
  exit 2
fi

repo_dir=$(cd "$(dirname "$0")/.." && pwd)
policy_file=$1
env_file=$repo_dir/.env
[[ -f $env_file ]] || { echo ".env not found; run ./scripts/bootstrap.sh first" >&2; exit 1; }

python3 - "$policy_file" "$env_file" <<'PY'
import json
import os
import sys

policy_path, env_path = sys.argv[1:]
with open(policy_path, encoding="utf-8") as handle:
    policy = json.load(handle)
if not isinstance(policy, dict) or set(policy) != {"bots"} or not isinstance(policy["bots"], dict):
    raise SystemExit("policy root must contain only a bots object")

mapping = {
    "channelId": "CHANNEL_ID",
    "reviewChatId": "REVIEW_CHAT_ID",
    "apiReviewRequired": "API_REVIEW_REQUIRED",
    "chatReviewRequired": "CHAT_REVIEW_REQUIRED",
}
updates = {}
for raw_index, values in policy["bots"].items():
    if not raw_index.isdigit() or int(raw_index) < 1 or not isinstance(values, dict) or not values:
        raise SystemExit(f"invalid bot policy: {raw_index!r}")
    unknown = set(values) - set(mapping)
    if unknown:
        raise SystemExit(f"bot {raw_index} has unknown keys: {sorted(unknown)}")
    for key, value in values.items():
        if key.endswith("Required"):
            if not isinstance(value, bool):
                raise SystemExit(f"bot {raw_index} {key} must be boolean")
            rendered = "true" if value else "false"
        else:
            if not isinstance(value, (str, int)) or not str(value).strip():
                raise SystemExit(f"bot {raw_index} {key} must be a non-empty chat id")
            rendered = str(value).strip()
        if "\n" in rendered or "\r" in rendered:
            raise SystemExit("policy values cannot contain newlines")
        updates[f"BOT{int(raw_index)}_{mapping[key]}"] = rendered

with open(env_path, encoding="utf-8") as handle:
    lines = handle.read().splitlines()
seen = set()
output = []
for line in lines:
    key = line.split("=", 1)[0] if "=" in line and not line.lstrip().startswith("#") else None
    if key in updates:
        output.append(f"{key}={updates[key]}")
        seen.add(key)
    else:
        output.append(line)
for key in sorted(set(updates) - seen):
    output.append(f"{key}={updates[key]}")

temp_path = env_path + ".upload"
fd = os.open(temp_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w", encoding="utf-8") as handle:
    handle.write("\n".join(output) + "\n")
os.replace(temp_path, env_path)
PY

if [[ ${2:-} != "--no-restart" ]]; then
  cd "$repo_dir"
  docker compose up -d --no-deps --force-recreate stack
  echo "TelePost policy applied; Bot processes restarted once and persisted data was preserved."
else
  echo "TelePost policy staged in .env; restart the stack when ready."
fi
