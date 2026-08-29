#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "Usage: $0 <user@host> <remote-repo-dir> <config.json>" >&2
  exit 2
fi

remote=$1
remote_dir=$2
source_file=$3
[[ $remote =~ ^[A-Za-z0-9_.@:-]+$ ]] || { echo "Invalid SSH target" >&2; exit 2; }
[[ $remote_dir =~ ^[A-Za-z0-9_./-]+$ ]] || { echo "Invalid remote path" >&2; exit 2; }
python3 -m json.tool "$source_file" >/dev/null

ssh "$remote" "mkdir -p '$remote_dir/data/pixivflow'"
scp "$source_file" "$remote:$remote_dir/data/pixivflow/config.json.upload"
ssh "$remote" "python3 -m json.tool '$remote_dir/data/pixivflow/config.json.upload' >/dev/null && chmod 600 '$remote_dir/data/pixivflow/config.json.upload' && mv '$remote_dir/data/pixivflow/config.json.upload' '$remote_dir/data/pixivflow/config.json'"

echo "Remote PixivFlow configuration replaced atomically; no container restart was requested."
