#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "Usage: $0 <user@host> <remote-repo-dir> <policy.json>" >&2
  exit 2
fi

remote=$1
remote_dir=$2
policy_file=$3
[[ $remote =~ ^[A-Za-z0-9_.@:-]+$ ]] || { echo "Invalid SSH target" >&2; exit 2; }
[[ $remote_dir =~ ^[A-Za-z0-9_./-]+$ ]] || { echo "Invalid remote path" >&2; exit 2; }
python3 -m json.tool "$policy_file" >/dev/null

scp "$policy_file" "$remote:$remote_dir/.telepost-policy.upload.json"
ssh "$remote" sh -s -- "$remote_dir" <<'REMOTE'
set -eu
cd "$1"
cleanup() { rm -f .telepost-policy.upload.json; }
trap cleanup EXIT HUP INT TERM
./scripts/apply_telepost_policy.sh .telepost-policy.upload.json
REMOTE

echo "Remote TelePost policy applied."
