# syntax=docker/dockerfile:1.7
#
# PixivFlow scheduler worker image: the long-lived executor for one app/machine/volume.
#
# Built from a pinned PixivFlow commit (never a branch) so every run can answer
# "which code produced this?" from the machine itself. The compiled dist, the
# runtime dependencies and the versioned production config are baked in; the only
# thing that comes from outside the image is the volume at /app/data, which holds
# the slot ledger, the delivery outbox and the download cache.
#
# Build context: the pixivflow-telepost-deploy repo root.
#   docker build -f docker/pixivflow-scheduler.Dockerfile \
#     --build-arg PIXIVFLOW_REF=<40-char commit> \
#     --build-arg PIXIVFLOW_VERSION=<released version> -t pixivflow-scheduler .

ARG NODE_IMAGE=node:24-bookworm-slim

FROM alpine/git AS pixivflow-src
# Required, not defaulted: a default invites a branch name, and a branch name both
# defeats reproducibility and keeps this layer cached forever.
ARG PIXIVFLOW_REF
WORKDIR /src
RUN test -n "${PIXIVFLOW_REF}" \
    && git init -q . \
    && git remote add origin https://github.com/redtidev1918/PixivFlow.git \
    && git fetch -q --depth 1 origin "${PIXIVFLOW_REF}" \
    && git checkout -q FETCH_HEAD \
    && git rev-parse HEAD > /PIXIVFLOW_COMMIT

FROM ${NODE_IMAGE} AS build
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY --from=pixivflow-src /src /build
COPY --from=pixivflow-src /PIXIVFLOW_COMMIT /tmp/PIXIVFLOW_COMMIT
# GIT_COMMIT is what scripts/write-version.js bakes into src/version.ts, and the runtime
# prints it at startup. Without it every image, pinned or not, reports commit "dev" --
# i.e. the machine could not answer "which code is running?" at all.
RUN npm ci --no-audit --no-fund \
    && GIT_COMMIT="$(cat /tmp/PIXIVFLOW_COMMIT)" npm run build

FROM ${NODE_IMAGE}
ARG PIXIVFLOW_REF
ARG PIXIVFLOW_VERSION=0.0.0
# Runtime: python3 (ugoira frame synthesis), the static ffmpeg build (ugoira -> GIF),
# and ca-certificates for the Pixiv and TelePost calls.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 ca-certificates curl xz-utils \
    && rm -rf /var/lib/apt/lists/*
ADD https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz /tmp/ffmpeg.tar.xz
RUN tar -xf /tmp/ffmpeg.tar.xz -C /tmp \
    && mv /tmp/ffmpeg-*-static/ffmpeg /usr/local/bin/ffmpeg \
    && rm -rf /tmp/ffmpeg*

WORKDIR /app
COPY --from=build /build/dist ./dist
# Workspace packages: node_modules/@redtidev/* are RELATIVE symlinks into packages/,
# so the packages dir (with their built dist) must ship too.
COPY --from=build /build/packages ./packages
COPY --from=build /build/node_modules ./node_modules
COPY --from=build /build/package.json ./
COPY --from=build /tmp/PIXIVFLOW_COMMIT /app/PIXIVFLOW_COMMIT
# The single authoritative config: external clock, run-to-completion lifecycle and
# delivery into TelePost's submission API. It holds no Telegram token and no
# channel id, so an execution machine cannot post to a channel at all.
#
# Its storage paths stay RELATIVE (./data/...), never absolute: the config loader
# auto-"fixes" absolute paths that fall outside the config directory (/app/config) and
# rewrites the file in place. Relative paths resolve against the project root /app, so
# ./data/... lands on the mounted volume /app/data -- and off-volume paths such as
# /app/downloads never appear.
COPY pixivflow/config/production.json /app/config/pixivflow.production.json

ENV NODE_ENV=production
# What the process reports about itself at startup: the version label plus the
# commit it was actually built from. verify-production.sh compares this against
# the expected ref, so an image that silently lags is caught by an operator rather
# than by a half-finished batch.
ENV PIXIVFLOW_REVISION=${PIXIVFLOW_VERSION}+${PIXIVFLOW_REF}
EXPOSE 8090
# `scheduler` mounts the authenticated trigger server and the durable slot runner.
# The echo is not decoration: verify-images.sh reads PIXIVFLOW_REVISION out of the
# machine's own startup log to prove the running image is the pinned one. Without it the
# provenance check silently degrades into "no version line in the logs" and gets skipped.
CMD ["sh", "-c", "echo \"PIXIVFLOW_REVISION=${PIXIVFLOW_REVISION:-unknown}\"; exec node dist/index.js scheduler"]
