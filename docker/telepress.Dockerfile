# syntax=docker/dockerfile:1.7
#
# TelePress standalone content-publishing HTTP service.
#
# Build context: the pixivflow-telepost-deploy repo root.
#   docker build -f docker/telepress.Dockerfile -t telepress .
#
# Secrets are injected at runtime by Fly (TELEGRAPH_ACCESS_TOKEN,
# TELEPRESS_API_KEY); nothing secret is baked into the image.

FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

# Pin exactly the PyPI release this image is meant to run.
RUN pip install --no-cache-dir "telepress[api]==0.11.0"

EXPOSE 8000
CMD ["telepress-server"]
