#!/usr/bin/env bash
# 部署前配置校验：确保必填项已填、JSON/YAML 语法正确、无敏感值入库
# 用法: ./scripts/validate.sh
set -euo pipefail

cd "$(dirname "$0")/.."
errors=0

echo "=== 1. 检查 .env 是否存在 ==="
if [[ ! -f .env ]]; then
  echo "  [FAIL] .env 不存在。请先 cp .env.example .env"
  errors=$((errors+1))
else
  echo "  [OK] .env 存在"
  set -a; source .env; set +a
fi

echo ""
echo "=== 2. 检查必填配置 ==="
for var in BOT1_TOKEN BOT1_CHANNEL_ID; do
  if [[ -z "${!var:-}" ]]; then
    echo "  [FAIL] ${var} 未设置"
    errors=$((errors+1))
  else
    echo "  [OK] ${var} 已设置"
  fi
done

echo ""
echo "=== 3. 检查 JSON 配置文件语法 ==="
for f in pixivflow/config/*.json; do
  if [[ -f "$f" ]]; then
    python3 -m json.tool "$f" >/dev/null 2>&1 || {
      echo "  [FAIL] $f JSON 语法错误"
      errors=$((errors+1))
    }
    echo "  [OK] $f"
  fi
done

echo ""
echo "=== 4. 检查 YAML 配置文件语法 ==="
for f in proxy/config.example.yaml docker-compose.yml; do
  if [[ -f "$f" ]]; then
    python3 -c "import yaml; yaml.safe_load(open('$f'))" 2>/dev/null || {
      echo "  [FAIL] $f YAML 语法错误"
      errors=$((errors+1))
    }
    echo "  [OK] $f"
  fi
done

echo ""
echo "=== 5. 检查敏感信息是否误入库 ==="
git ls-files | while read -r f; do
  if grep -qiE "(token|secret|password|api[_-]?key)" "$f" 2>/dev/null; then
    if ! grep -qiE "(example|EXAMPLE|your_|change_me|placeholder)" "$f"; then
      echo "  [WARN] $f 可能包含敏感信息，请确认"
    fi
  fi
done

echo ""
if [[ $errors -gt 0 ]]; then
  echo "❌ 校验失败：$errors 个错误"
  exit 1
else
  echo "✅ 配置校验通过"
fi
