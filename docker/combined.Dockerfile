# syntax=docker/dockerfile:1.7
# RELEASE-ONLY：只组合已经发布的 TelePost 镜像与 npm PixivFlow 版本。
# 本镜像只用于 single-host preset（一台机器同跑 TelePost + PixivFlow，共享内存峰值）。
# 解耦部署的默认路径是 docker-compose.yml 的两个独立镜像（telepost + pixivflow）。

ARG TELEPOST_IMAGE=ghcr.io/redtidev1918/telepost:2.84.7
ARG NODE_IMAGE=node:24-bookworm-slim

FROM ${NODE_IMAGE} AS pixivflow-builder
ARG PIXIVFLOW_VERSION=2.12.0
ARG HTTP_PROXY
ARG HTTPS_PROXY
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --prefix /opt/pixivflow "pixivflow@${PIXIVFLOW_VERSION}" \
    && npm cache clean --force

FROM ${TELEPOST_IMAGE}
ARG HTTP_PROXY
ARG HTTPS_PROXY
# PixivFlow 的 ugoira（动图）转 GIF 在运行时 spawn python3 + ffmpeg；
# 基础镜像缺 ffmpeg，合一台必须装上，否则动图只投递 ZIP/JSON。
# 版本保持 7.0.2 的静态构建，直接 COPY 二进制（mwader/static-ffmpeg 固定 tag）：
# 同一条上游源码的静态链接产物、无外部动态库依赖；不再从 johnvansickle 站点下载
# ——那个站点 TLS 握手/读取长时间不可用时，Validate 的 Build combined runtime 会
# 稳定失败（SSL: UNEXPECTED_EOF_WHILE_READING），与业务代码无关。
# 也不用 apt ffmpeg：那会拖进 ~200MB mesa/X11 依赖树。
COPY --from=mwader/static-ffmpeg:7.0.2 /ffmpeg /usr/local/bin/ffmpeg
COPY --from=mwader/static-ffmpeg:7.0.2 /ffprobe /usr/local/bin/ffprobe
RUN chmod 0755 /usr/local/bin/ffmpeg /usr/local/bin/ffprobe \
    && ffmpeg -version | head -1 \
    && ffprobe -version | head -1
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



