#!/usr/bin/env bash
# 从 .env 生成 TelePost config.ini
# 用法: ./telepost/scripts/generate_config.sh
set -euo pipefail

cd "$(dirname "$0")/../.."

if [[ ! -f .env ]]; then
  echo "错误: 未找到 .env，请先 cp .env.example .env 并填写配置" >&2
  exit 1
fi

# 加载 .env（忽略注释和空行）
set -a
source .env
set +a

# 生成 config.ini
cat > telepost/config.ini <<EOF
[BOT]
TOKEN = ${BOT1_TOKEN:-}
CHANNEL_ID = ${BOT1_CHANNEL_ID:-}
OWNER_ID = ${BOT1_OWNER_ID:-}
BOT_MODE = ${BOT1_BOT_MODE:-MIXED}
API_REVIEW_REQUIRED = ${BOT1_API_REVIEW_REQUIRED:-false}
CHAT_REVIEW_REQUIRED = ${BOT1_CHAT_REVIEW_REQUIRED:-false}
SUBMIT_LIMIT_PER_HOUR = ${BOT1_SUBMIT_LIMIT_PER_HOUR:-10}
SHOW_SUBMITTER = ${BOT1_SHOW_SUBMITTER:-true}
RUN_MODE = ${RUN_MODE:-AUTO}

[WEBHOOK]
URL = ${WEBHOOK_URL:-}
PORT = ${TELEPOST_PORT:-8080}

[SEARCH]
ENABLED = ${SEARCH_ENABLED:-false}
ANALYZER = ${SEARCH_ANALYZER:-simple}

[DB]
CACHE_SIZE_KB = 1024
EOF

echo "已生成 telepost/config.ini（不含敏感值的占位）"
echo "提示: 实际部署建议使用环境变量注入，无需 config.ini"
