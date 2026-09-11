# syntax=docker/dockerfile:1.7
#
# One-shot PixivFlow executor image for a Fly Machine.
#
# Built ONCE by CI (or the Fly remote builder) from a pinned PixivFlow ref and
# deployed to machines by the control plane's Fly provider. A running machine
# never installs or builds anything: the image already contains the compiled
# dist, the runtime dependencies, the versioned production/shadow configs and
# the one-slot bootstrap. The exact PixivFlow commit is baked in so every
# production run can answer "which code was this?".
#
# Build context: the pixivflow-telepost-deploy repo root.
#   docker build -f docker/pixivflow-executor.Dockerfile \
#     --build-arg PIXIVFLOW_REF=master -t registry.fly.io/pixivflow-executor:v1 .

ARG NODE_IMAGE=node:24-bookworm-slim

FROM alpine/git AS pixivflow-src
ARG PIXIVFLOW_REF=master
WORKDIR /src
RUN git clone --depth 1 --branch "${PIXIVFLOW_REF}" https://github.com/redtidev1918/PixivFlow.git .

FROM ${NODE_IMAGE} AS build
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY --from=pixivflow-src /src /build
# Traceability: the exact commit this image executes (an empty file means the
# ref was not a git checkout and the image must not be trusted for production).
RUN (git rev-parse HEAD || echo unknown) > /tmp/PIXIVFLOW_COMMIT
RUN npm ci --no-audit --no-fund && npm run build

FROM ${NODE_IMAGE}
# Runtime only: python3 (ugoira frame synthesis) and curl/jq (the control-plane
# callbacks). Downloaded media stays on the ephemeral filesystem and dies with
# the machine.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 ca-certificates curl jq xz-utils \
    && rm -rf /var/lib/apt/lists/*
# ugoira -> GIF needs an ffmpeg with full codecs; the slim image has none.
ADD https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz /tmp/ffmpeg.tar.xz
RUN tar -xf /tmp/ffmpeg.tar.xz -C /tmp \
    && mv /tmp/ffmpeg-*-static/ffmpeg /usr/local/bin/ffmpeg \
    && rm -rf /tmp/ffmpeg*

WORKDIR /app/pixivflow
COPY --from=build /build/dist ./dist
COPY --from=build /build/node_modules ./node_modules
COPY --from=build /build/package.json ./
COPY --from=build /tmp/PIXIVFLOW_COMMIT /app/PIXIVFLOW_COMMIT
# Versioned configs: live (real review groups and channels) and shadow (cannot
# publish). The bootstrap picks by MODE so a shadow machine can never be handed
# production delivery targets.
COPY control-plane/config/pixivflow.production.json /app/config/pixivflow.production.json
COPY control-plane/config/pixivflow.shadow.json /app/config/pixivflow.shadow.json
COPY fly/executor/bootstrap.sh /usr/local/bin/execute-one-slot
RUN chmod +x /usr/local/bin/execute-one-slot

ENV NODE_ENV=production
# One slot per machine boot: claim -> execute -> report -> exit.
CMD ["/usr/local/bin/execute-one-slot"]
