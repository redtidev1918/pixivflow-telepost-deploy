#!/usr/bin/env bash
# 只读核对：线上跑的镜像/提交号是否就是仓库里固定的那个。
#
# 为什么值得单独一遍：镜像层缓存 + 分支引用会让「部署成功」和「跑的是新代码」脱钩。
# 这里用运行中/最近运行的镜像引用与启动日志里的 PIXIVFLOW_REVISION 去核对，不重新部署。
set -uo pipefail

repo_dir=$(cd "$(dirname "$0")/.." && pwd) || exit 1
cd "$repo_dir" || exit 1

pixivflow_app=${PIXIVFLOW_APP:-pixivflow-scheduler}
telepost_app=${TELEPOST_APP:-telesubmit-multi-bot}

failures=0
fail() { echo "[FAIL] $*"; failures=$((failures + 1)); }
ok() { echo "[OK]   $*"; }
skip() { echo "[SKIP] $*"; }

pinned_telepost=$(python3 -c '
import re, sys
text = open("fly/deploy.telepost.toml", encoding="utf-8").read()
m = re.search(r"^\s*TELEPOST_IMAGE\s*=\s*[\x27\"]([^\x27\"]+)", text, re.M)
print(m.group(1) if m else "")
')
pinned_pixivflow=$(python3 -c '
import re
text = open("fly/deploy.pixivflow.toml", encoding="utf-8").read()
m = re.search(r"^\s*PIXIVFLOW_REF\s*=\s*[\x27\"]([^\x27\"]+)", text, re.M)
print(m.group(1) if m else "")
')

if [[ -z "$pinned_telepost" || -z "$pinned_pixivflow" ]]; then
  fail "仓库里没有固定镜像/提交号（TELEPOST_IMAGE / PIXIVFLOW_REF）"
fi
for value in "$pinned_telepost" "$pinned_pixivflow"; do
  case "$value" in
    *latest*|*master*|*main*) fail "固定值不是不可变引用：${value}" ;;
  esac
done
[[ -n "$pinned_telepost" ]] && ok "仓库固定的 TelePost 镜像：${pinned_telepost}"
[[ -n "$pinned_pixivflow" ]] && ok "仓库固定的 PixivFlow 提交：${pinned_pixivflow}"

echo
if deployed=$(fly image show -a "$telepost_app" 2>/dev/null) && [[ -n "$deployed" ]]; then
  tag=${pinned_telepost##*:}
  if [[ "$deployed" == *"$tag"* ]]; then
    ok "TelePost 线上镜像匹配 ${tag}"
  else
    fail "TelePost 线上镜像与固定版本不一致（期望含 ${tag}）"
  fi
else
  skip "无法读取 ${telepost_app} 的镜像引用"
fi

echo
# 提交号只能从执行端自己的启动日志里读：镜像构建时把它写进 PIXIVFLOW_REVISION，
# 而 docker/pixivflow-scheduler.Dockerfile 里那行是
#     ENV PIXIVFLOW_REVISION=${PIXIVFLOW_VERSION}+${PIXIVFLOW_REF}
# ——写进去的是 build-arg 的**字面量**，不是解析后的提交。所以 PIXIVFLOW_REF 必须是
# 40 位提交号：填 tag 时镜像只会自报 tag 名（实测 `2.19.0+v2.19.0`），"线上跑的到底是
# 哪个提交" 就永远无法证明。
#
# 这里刻意不把 tag 解析成提交号来"兼容"：镜像里没有那个提交，核对通过只会是假象。填了
# tag 就直接 FAIL，让不合格的部署喊出来。
#
# 早先的实现在 else 分支里用 `git ls-remote origin` 解析 tag，而 origin 指向本仓库
# （pixivflow-telepost-deploy），那里永远没有 PixivFlow 的 tag，于是每次都退化成
# SKIP——一项看起来在做、其实没做的核对。这也是它被换成显式判断的原因之一。
expected_short=""
if [[ ! "$pinned_pixivflow" =~ ^[0-9a-f]{40}$ ]]; then
  fail "PIXIVFLOW_REF 不是 40 位提交号（${pinned_pixivflow}）：镜像只自报该字面量，无法证明提交来源"
elif ! logs=$(fly logs -a "$pixivflow_app" --no-tail 2>/dev/null); then
  skip "无法读取 ${pixivflow_app} 的日志"
else
  expected_short=${pinned_pixivflow:0:12}
  revision=$(printf '%s' "$logs" | grep -o 'PIXIVFLOW_REVISION[^ ]*' | tail -1)
  if [[ -z "$revision" ]]; then
    skip "执行端最近日志里没有版本行（机器可能还没被唤醒过）"
  elif [[ "$revision" == *"$expected_short"* ]]; then
    ok "执行端报告的版本包含 ${expected_short}（来自 PIXIVFLOW_REF）"
  else
    fail "执行端报告的版本与固定提交不一致（期望含 ${expected_short}，来自 PIXIVFLOW_REF）"
  fi
fi

exit $(( failures > 0 ? 1 : 0 ))
