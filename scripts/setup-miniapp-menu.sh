#!/usr/bin/env bash
# 配置 Telegram Mini App Menu Button（BotFather 等价物，§72-§73）。
#
# 用法：
#   BOT1_TOKEN=... MINIAPP_URL=https://telepost.example/app/ ./scripts/setup-miniapp-menu.sh
#
# 也可设置整个 Bot 的菜单按钮（永久的 Main Mini App 入口）。该命令可恢复
# （重复执行幂等）。若你希望保留默认按钮，可用 call 形式单独配置 private chat。
set -euo pipefail

require() { : "${!1:?需要环境变量 $1}"; }
require BOT1_TOKEN
: "${MINIAPP_URL:?需要 MINIAPP_URL 环境变量}"

for i in 1; do
  token_var="BOT${i}_TOKEN"
  token="${!token_var:-}"
  [ -n "$token" ] || continue
  echo "==> 配置 bot${i} 的 Mini App menu button: $MINIAPP_URL"
  curl -sS -f -m 20 \
    "https://api.telegram.org/bot${token}/setChatMenuButton" \
    -H 'Content-Type: application/json' \
    -d "{\"menu_button\":{\"type\":\"web_app\",\"text\":\"🖥 打开 TelePost\",\"web_app\":{\"url\":\"${MINIAPP_URL}\"}}}"
  echo
done

echo "完成。菜单按钮已设置（private chat 永久入口）。"
