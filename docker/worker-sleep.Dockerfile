# syntax=docker/dockerfile:1.7
# RELEASE-ONLY：single-machine-worker-sleep（preset B）的**执行侧**镜像。
#
# 它只负责「常驻 supervisor + 按需 executor」这一侧：
#   - supervisor 二进制来自本仓库（Go，仅标准库），构建期编译进来；
#   - executor 运行时来自已被固定的 PixivFlow 镜像，不重新构建、不装第二份依赖。
# 业务侧（publisher / telegram-ingress / clock）仍然用上游 TelePost 镜像，本镜像不碰它。
#
# 机器上两个容器共享一个物理卷，状态命名空间互不相交（SI-7）：
#   pixivflow 容器只写 <volume>/pixivflow/**，telepost 容器只写 <volume>/botN/**。
#
# 端口分工（由 supervisor 拥有，因此写在这里而不是留给运维对齐）：
#   8090 = supervisor 常驻占住的对外触发端口（时钟照旧 POST 到这里）
#   8091 = executor 子进程自己的触发端口（supervisor 转发到它，并通过
#          SCHEDULER_TRIGGER_PORT 替子进程指定）
#
# 故意不配健康检查：探测指向触发端口就会把刚退出的 executor 重新拉起来。
# 这里连 HEALTHCHECK 指令都没有——存活检查只允许指向 supervisor 自己的 /healthz。

# 与 docker/pixivflow.Dockerfile 保持同一个默认 tag：CI 已经会拉它。生产按各自
# 平台的固定规则换成发布 tag 或按提交号构建的镜像（见 docs/operations/upgrades.md）。
ARG PIXIVFLOW_IMAGE=ghcr.io/redtidev1918/pixivflow:2.12.0
ARG GO_IMAGE=golang:1.22-bookworm

# --- supervisor 构建阶段 -----------------------------------------------------
FROM ${GO_IMAGE} AS supervisor-builder
# 只拷 supervisor 包与 go.mod：本包的依赖只有标准库，不需要下载模块。
COPY go.mod /src/go.mod
COPY supervisor /src/supervisor
WORKDIR /src
ENV CGO_ENABLED=0
RUN go build -trimpath -ldflags="-s -w" -o /out/pixivflow-supervisor ./supervisor

# --- 运行阶段 ---------------------------------------------------------------
FROM ${PIXIVFLOW_IMAGE}

COPY --from=supervisor-builder /out/pixivflow-supervisor /usr/local/bin/pixivflow-supervisor

# 两个端口都由本进程负责：8090 对外，8091 给子进程。
ENV SUPERVISOR_LISTEN=127.0.0.1:8090 \
    SUPERVISOR_CHILD_TRIGGER=127.0.0.1:8091 \
    SUPERVISOR_TRIGGER_PREFIX=/internal/schedules/ \
    # 子进程命令必须与基础镜像的 CMD 一致（同一个 scheduler 入口），且必须是单条命令：
    # supervisor 用 `sh -c "exec <cmd>"` 启动，不留包装 shell，否则信号与退出状态会失真。
    SUPERVISOR_CHILD_CMD="node dist/index.js scheduler"

LABEL org.opencontainers.image.title="PixivFlow on-demand executor supervisor" \
      org.opencontainers.image.description="Resident supervisor that spawns the PixivFlow executor on demand for the single-machine-worker-sleep preset" \
      org.opencontainers.image.source="https://github.com/redtidev1918/pixivflow-telepost-deploy" \
      org.opencontainers.image.documentation="https://github.com/redtidev1918/pixivflow-telepost-deploy/blob/main/docs/architectures/single-machine-worker-sleep.md" \
      org.opencontainers.image.licenses="MIT"

# 显式清掉可能从基础镜像继承来的 HEALTHCHECK。基础镜像的检查指向执行端的触发端口，
# 而本 preset 下那个端口是「按需进程」的：探测会把它重新拉起来。只允许检查 supervisor
# 自己的 /healthz，而它由运维在平台侧配置，不写进镜像。
HEALTHCHECK NONE

EXPOSE 8090

# 覆盖基础镜像的 CMD：默认进程是 supervisor，executor 由它按需拉起。
ENTRYPOINT ["/usr/local/bin/pixivflow-supervisor"]
