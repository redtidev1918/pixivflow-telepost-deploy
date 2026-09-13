#!/usr/bin/env bash
#
# Post-window finalization wrapper (session-independent, read-only).
#
# The post-window collector (`post-window-collect.sh`) does the evidence work and
# writes `post-window/DONE.marker` when it finishes. This wrapper waits for that
# marker, verifies the evidence files the acceptance needs actually exist and are
# non-empty where required, and only then writes `FINALIZATION_READY` in the
# evidence root. If the collector never finishes, this script times out and
# records TIMEOUT instead of ever writing FINALIZATION_READY.
#
# It is deliberately a tiny wrapper: it does not re-run any probe, does not wake
# any Machine, and contains zero collection logic.
#
# Usage:
#   ./scripts/finalize-evidence.sh [--root DIR] [--timeout 3600]
set -uo pipefail

root="${EVIDENCE_DIR:-$(cd "$(dirname "$0")/.." && pwd)/evidence/2026-09-13}"
timeout_s=3600
while [[ $# -gt 0 ]]; do
  case "$1" in
    --root) root=${2:-}; shift 2 ;;
    --timeout) timeout_s=${2:-}; shift 2 ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "[FAIL] unknown argument: $1" >&2; exit 6 ;;
  esac
done

export ALL_PROXY='' all_proxy='' http_proxy='' https_proxy='' NO_PROXY='*'
mkdir -p "$root"

log="$root/finalize.log"
say() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$log"; }

post_window="$root/post-window"
watcher="$root/watcher"
done_marker="$post_window/DONE.marker"

say "waiting for collector DONE.marker ($done_marker)"
waited=0
while [[ ! -f "$done_marker" ]]; do
  if (( waited >= timeout_s )); then
    {
      echo "FINALIZATION_READY=false"
      echo "reason=collector DONE.marker missing after ${timeout_s}s"
      echo "finalized_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    } > "$root/FINALIZATION_TIMEOUT.marker"
    say "TIMEOUT: collector never wrote DONE.marker; wrote FINALIZATION_TIMEOUT.marker"
    exit 7
  fi
  sleep 10
  waited=$((waited + 10))
done
say "DONE.marker present"

# Required, non-empty evidence files. Missing or empty => not ready.
required_nonempty=(
  "$post_window/telepost.txt"
  "$post_window/admission.txt"
  "$post_window/outcome.txt"
  "$watcher/result.txt"
  "$watcher/ledger.txt"
  "$watcher/executor.log"
)
missing=""
for f in "${required_nonempty[@]}"; do
  if [[ ! -s "$f" ]]; then
    missing="$missing $(basename "$f")"
  fi
done

if [[ -n "$missing" ]]; then
  {
    echo "FINALIZATION_READY=false"
    echo "reason=evidence files missing/empty:$missing"
    echo "collected_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } > "$root/FINALIZATION_READY"
  say "evidence incomplete (${missing}); wrote FINALIZATION_READY=false marker"
  exit 8
fi

{
  echo "collected_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "bot1_window_complete=true"
  echo "bot2_window_complete=true"
  echo "evidence_root=$root"
} > "$root/FINALIZATION_READY"
say "FINALIZATION_READY written (bot1+bot2 windows complete)"
exit 0