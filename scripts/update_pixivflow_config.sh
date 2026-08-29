#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <config.json>" >&2
  exit 2
fi

repo_dir=$(cd "$(dirname "$0")/.." && pwd)
source_file=$1
target_file=$repo_dir/data/pixivflow/config.json
upload_file=$target_file.upload

python3 -m json.tool "$source_file" >/dev/null
mkdir -p "$(dirname "$target_file")"
cp "$source_file" "$upload_file"
chmod 600 "$upload_file"
mv "$upload_file" "$target_file"

echo "PixivFlow configuration replaced atomically. The running scheduler will validate and reload it automatically."
