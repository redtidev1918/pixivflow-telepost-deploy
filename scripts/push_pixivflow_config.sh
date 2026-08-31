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

ssh "$remote" sh -s -- "$remote_dir" <<'REMOTE'
set -eu
mkdir -p "$1/data/pixivflow"
REMOTE
scp "$source_file" "$remote:$remote_dir/data/pixivflow/config.json.upload"
ssh "$remote" sh -s -- "$remote_dir" <<'REMOTE'
set -eu
upload_file=$1/data/pixivflow/config.json.upload
target_file=$1/data/pixivflow/config.json
python3 -m json.tool "$upload_file" >/dev/null
chmod 600 "$upload_file"
mv "$upload_file" "$target_file"
REMOTE

echo "Remote PixivFlow configuration replaced atomically; no container restart was requested."
