# syntax=docker/dockerfile:1.7
ARG TELEPOST_IMAGE=ghcr.io/redtidev1918/telepost:2.81.1
FROM ${TELEPOST_IMAGE}

# Override the additive TelePress dependency without changing the immutable
# TelePost application image. Keep this pin equal to TelePost requirements.txt
# and docker/telepress.Dockerfile (cross-repo version-sync contract).
ARG TELEPRESS_VERSION=0.17.0
RUN pip install --no-cache-dir "telepress==${TELEPRESS_VERSION}"
