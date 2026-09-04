# syntax=docker/dockerfile:1.7
# 可选 co-locate 层：Fly 合一台（一台机同跑 TelePost + PixivFlow，共享内存峰值）。
# 解耦部署的默认路径是 docker-compose.yml 的两个独立镜像（telepost + pixivflow）。

ARG TELEPOST_IMAGE=ghcr.io/redtidev1918/telepost:2.10.34
ARG NODE_IMAGE=node:24-bookworm-slim

FROM ${NODE_IMAGE} AS pixivflow-builder
ARG PIXIVFLOW_VERSION=2.10.27
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
      org.opencontainers.image.description="Low-memory multi-bot PixivFlow and TelePost deployment runtime" \
      org.opencontainers.image.source="https://github.com/redtidev1918/pixivflow-telepost-deploy" \
      org.opencontainers.image.documentation="https://github.com/redtidev1918/pixivflow-telepost-deploy#readme" \
      org.opencontainers.image.licenses="MIT"
