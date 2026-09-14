#!/usr/bin/env bash
# 配置 Telegram Mini App Menu Button（BotFather 等价物，§72-§73）。
#
# 用法（BOT1 与 BOT2 均可选，至少提供一个）：
#   BOT1_TOKEN=... BOT2_TOKEN=... MINIAPP_URL=https://telepost.example/app/ \
#     ./scripts/setup-miniapp-menu.sh
#
# 幂等可重跑；只配置 token 已提供的 Bot。若想保留默认按钮，可手动用
# setChatMenuButton 单独改 private chat。
set -euo pipefail

: "${MINIAPP_URL:?需要 MINIAPP_URL 环境变量}"

rc=0
for n in 1 2; do
  token_var="BOT${n}_TOKEN"
  token="${!token_var:-}"
  if [ -z "$token" ]; then
    echo "==> 跳过 bot${n}（未提供 BOT${n}_TOKEN）"
    continue
  fi
  # WebApp 按启动 URL 的 ?bot= 选择 API 前缀（/api/botN/v1）；menu 按钮带上它。
  case "$MINIAPP_URL" in
    *\?*) bot_url="${MINIAPP_URL}&bot=bot${n}" ;;
    *)    bot_url="${MINIAPP_URL}?bot=bot${n}" ;;
  esac
  echo "==> 配置 bot${n} 的 Mini App menu button: $bot_url"
  if ! curl -sS -f -m 20 \
    "https://api.telegram.org/bot${token}/setChatMenuButton" \
    -H 'Content-Type: application/json' \
    -d "{\"menu_button\":{\"type\":\"web_app\",\"text\":\"🖥 打开 TelePost\",\"web_app\":{\"url\":\"${bot_url}\"}}}"; then
    echo "   bot${n} 配置失败" >&2
    rc=1
  else
    echo
  fi
done

if [ "$rc" -eq 0 ]; then
  echo "完成。已配置的 Bot 菜单按钮已设置（private chat 永久入口）。"
else
  echo "部分 Bot 配置失败，请检查上面的输出。" >&2
fi
exit "$rc"