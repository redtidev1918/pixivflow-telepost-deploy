#!/usr/bin/env bash
set -euo pipefail

repo_dir=$(cd "$(dirname "$0")/.." && pwd)
cd "$repo_dir"

mkdir -p data/pixivflow proxy-data
if [[ ! -f .env ]]; then
  cp .env.example .env
  chmod 600 .env
  echo "Created .env; fill in Bot/Pixiv credentials before starting."
fi
if [[ ! -f data/pixivflow/config.json ]]; then
  cp pixivflow/config/fly-two-bots.example.json data/pixivflow/config.json
  echo "Created data/pixivflow/config.json; enable plans and replace TAG_A...TAG_D."
fi

python3 -m json.tool data/pixivflow/config.json >/dev/null
echo "Bootstrap complete. Run ./scripts/validate.sh after editing configuration."
