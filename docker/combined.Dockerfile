# syntax=docker/dockerfile:1.7
# RELEASE-ONLY：只组合已经发布的 TelePost 镜像与 npm PixivFlow 版本。
# 不得用于部署 PixivFlow 未发布源码；源码热修复请使用 `deploy source <PixivFlow目录>`。
# 可选 co-locate 层：Fly 合一台（一台机同跑 TelePost + PixivFlow，共享内存峰值）。
# 解耦部署的默认路径是 docker-compose.yml 的两个独立镜像（telepost + pixivflow）。

ARG TELEPOST_IMAGE=ghcr.io/redtidev1918/telepost:2.17.3
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
# 用 johnvansickle 静态构建（42MB、编解码齐全），替代 apt ffmpeg 那
# ~200MB 的 mesa/X11 依赖树——后者经代理拉大包会长时间挂起导致构建失败。
# 基础镜像自带 python3(lzma+urllib) 与 CA，无需额外 apt 包。
RUN python3 - <<'PY'
import io, os, tarfile, time, urllib.request
url = "https://johnvansickle.com/ffmpeg/releases/ffmpeg-7.0.2-amd64-static.tar.xz"
last = None
for attempt in range(4):
    try:
        with urllib.request.urlopen(url, timeout=60) as r:
            data = r.read()
        break
    except Exception as e:  # 停滞/断连即整体重试
        last = e
        print("download retry", attempt, e, flush=True)
        time.sleep(3 * (attempt + 1))
else:
    raise SystemExit(f"ffmpeg download failed: {last}")
with tarfile.open(fileobj=io.BytesIO(data), mode="r:xz") as tf:
    for m in tf.getmembers():
        if m.isfile() and os.path.basename(m.name) in ("ffmpeg", "ffprobe"):
            with tf.extractfile(m) as src, open("/usr/local/bin/" + os.path.basename(m.name), "wb") as dst:
                dst.write(src.read())
for b in ("ffmpeg", "ffprobe"):
    p = "/usr/local/bin/" + b
    os.chmod(p, 0o755)
os.system("ffmpeg -version | head -1")
PY
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
