#!/bin/sh
# Runtime-editable production config bootstrap.
#
# The scheduler hot-reloads its config (schedulerRuntime.watchConfig=true), so the
# editable copy must live on the persistent volume (/app/data), not baked into the
# image. On first start we hydrate the volume from the versioned default baked in
# the image; after that operators edit the volume copy directly and the running
# process picks it up on the next write.
set -eu

CONFIG_SRC=/app/config/pixivflow.production.json
CONFIG_DEST="${PIXIV_DOWNLOADER_CONFIG:-/app/data/production.json}"
mkdir -p "$(dirname "$CONFIG_DEST")"
if [ ! -s "$CONFIG_DEST" ]; then
  cp "$CONFIG_SRC" "$CONFIG_DEST"
  chmod 0644 "$CONFIG_DEST"
fi

echo "PIXIVFLOW_REVISION=${PIXIVFLOW_REVISION:-unknown}"
exec node dist/index.js scheduler
