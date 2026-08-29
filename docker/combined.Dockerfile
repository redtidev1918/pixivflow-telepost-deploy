# syntax=docker/dockerfile:1.7

ARG TELEPOST_IMAGE=ghcr.io/redtidev1918/telepost:2.10.2
ARG NODE_IMAGE=node:20-bookworm-slim

FROM ${NODE_IMAGE} AS pixivflow-builder
ARG PIXIVFLOW_VERSION=2.10.3
ARG HTTP_PROXY
ARG HTTPS_PROXY
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && npm install --prefix /opt/pixivflow "pixivflow@${PIXIVFLOW_VERSION}" \
    && npm cache clean --force

FROM ${TELEPOST_IMAGE}
COPY --from=pixivflow-builder /usr/local/bin/node /usr/local/bin/node
COPY --from=pixivflow-builder /opt/pixivflow /opt/pixivflow
RUN ln -s /opt/pixivflow/node_modules/.bin/pixivflow /usr/local/bin/pixivflow \
    && node --version \
    && pixivflow --version

LABEL org.opencontainers.image.title="PixivFlow + TelePost" \
      org.opencontainers.image.description="Low-memory multi-bot PixivFlow and TelePost deployment runtime"