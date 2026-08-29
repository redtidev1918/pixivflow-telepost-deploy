#!/bin/sh
set -e

CFG_DIR=/root/.config/mihomo
mkdir -p "$CFG_DIR"

# 1. 配置:已有则用挂载的;没有则从 SUB_URL 拉取
if [ ! -s "$CFG_DIR/config.yaml" ]; then
  if [ -z "$SUB_URL" ]; then
    echo "[entrypoint] 缺少配置:请挂载 config.yaml 到 $CFG_DIR,或在 .env 中设置 SUB_URL" >&2
    exit 1
  fi
  echo "[entrypoint] 从 SUB_URL 拉取订阅 -> config.yaml"
  curl -fsSL --retry 3 -m 120 -A "clash" -o "$CFG_DIR/config.yaml.tmp" "$SUB_URL"
  mv "$CFG_DIR/config.yaml.tmp" "$CFG_DIR/config.yaml"
fi

# 2. 容器内需 allow-lan 才能与宿主机端口映射打通(对外暴露由 compose 的 127.0.0.1 绑定控制)
sed -i 's/^allow-lan: false/allow-lan: true/' "$CFG_DIR/config.yaml" || true

# 3. geo 数据文件(直连 GitHub 失败时走镜像)
for f in geosite.dat geoip.metadb; do
  if [ ! -s "$CFG_DIR/$f" ]; then
    echo "[entrypoint] 下载 $f"
    curl -fsSL --retry 2 -m 300 -o "$CFG_DIR/$f.tmp" \
      "https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/$f" \
    || curl -fsSL --retry 2 -m 300 -o "$CFG_DIR/$f.tmp" \
      "https://ghfast.top/https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/$f" \
    || { echo "[entrypoint] $f 下载失败,可手动放入 $CFG_DIR/" >&2; exit 1; }
    mv "$CFG_DIR/$f.tmp" "$CFG_DIR/$f"
  fi
done

echo "[entrypoint] 启动 mihomo"
exec /mihomo -d "$CFG_DIR"
