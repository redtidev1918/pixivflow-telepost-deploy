# syntax=docker/dockerfile:1.7
ARG TELEPOST_IMAGE=ghcr.io/redtidev1918/telepost:2.81.4
FROM ${TELEPOST_IMAGE}

# Override the additive TelePress dependency without changing the immutable
# TelePost application image. Keep this pin equal to TelePost requirements.txt
# and docker/telepress.Dockerfile (cross-repo version-sync contract). The
# default silently lagged at 0.17.0 while the other two moved to 0.17.1/0.17.2,
# so a compose deployment kept the short-overflow-page pagination; the
# deployment-contract test now pins all three to one version.
ARG TELEPRESS_VERSION=0.17.2
RUN pip install --no-cache-dir "telepress==${TELEPRESS_VERSION}"
