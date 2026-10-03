#!/usr/bin/env python3
"""把 TelePost 部署基线从 versions.json 同步到所有模板。

仓库里曾经同时存在五个互不相干的 TelePost 版本来源（.env.example、docker-compose、
两个 Dockerfile、fly/deploy.telepost.toml、init.go 的 telepostBaseline），它们各自
漂移过：本仓 pin 到 2.76.2 的时候，compose 默认值还停在 2.64.2、.env.example 停在
2.15.0、脚手架停在 2.17.6。现在只有 versions.json 是权威来源，其余全部由本脚本生成。

用法：
    ./scripts/sync-telepost-baseline.py                 # 按 versions.json 刷新所有模板
    ./scripts/sync-telepost-baseline.py --check         # 只校验，不一致则 exit 1
    ./scripts/sync-telepost-baseline.py --to 2.79.0     # 改基线并刷新（供 CI 自动更新用）

--to 会同时更新 versions.json 的 version / tag / image / source，并把上一个版本记为
Fly 配置里的 Rollback。它不校验该版本是否真的发布——那是 CI workflow 的事：
update-telepost.yml 先用 GitHub Release 与 GHCR manifest 验证，再调用本脚本。
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
VERSIONS = REPO / "versions.json"
IMAGE_REPO = "ghcr.io/redtidev1918/telepost"
GH_RELEASE = "https://github.com/redtidev1918/TelePost/releases/tag"

# 机器维护的注释行（紧跟在 fly 配置 TELEPOST_IMAGE 上一行），内容是幂等的。
PIN_MARKER = "# Pinned from versions.json"

TARGETS = [
    # (路径, 匹配整行的正则, 生成该行的模板)
    (
        ".env.example",
        re.compile(r"^TELEPOST_IMAGE=.*$", re.M),
        "TELEPOST_IMAGE={image}",
    ),
    (
        "docker-compose.yml",
        re.compile(r"^(\s*)image: \$\{TELEPOST_IMAGE:-[^}]*\}.*$", re.M),
        "    image: ${{TELEPOST_IMAGE:-{image}}}",
    ),
    (
        "docker/combined.Dockerfile",
        re.compile(r"^ARG TELEPOST_IMAGE=.*$", re.M),
        "ARG TELEPOST_IMAGE={image}",
    ),
    (
        "docker/telepost.Dockerfile",
        re.compile(r"^ARG TELEPOST_IMAGE=.*$", re.M),
        "ARG TELEPOST_IMAGE={image}",
    ),
    (
        "fly/deploy.telepost.toml",
        re.compile(r"^(\s*)TELEPOST_IMAGE = '[^']*'.*$", re.M),
        "{indent}TELEPOST_IMAGE = '{image}'",
    ),
]


def load_baseline() -> dict:
    data = json.loads(VERSIONS.read_text(encoding="utf-8"))
    telepost = data["telepost"]
    for key in ("version", "tag", "image"):
        if not telepost.get(key):
            raise SystemExit(f"versions.json 缺少 telepost.{key}")
    return data


def expected_image(version: str) -> str:
    return f"{IMAGE_REPO}:{version}"


def check_semver(value: str) -> bool:
    return re.fullmatch(r"\d+\.\d+\.\d+", value) is not None


def current_value(path: Path, pattern: re.Pattern[str]) -> str | None:
    text = path.read_text(encoding="utf-8")
    match = pattern.search(text)
    return match.group(0).strip() if match else None


def render(path: Path, pattern: re.Pattern[str], template: str, image: str) -> tuple[str, int]:
    """把匹配到的每一行替换成模板渲染结果，返回（新文本, 替换次数）。"""
    text = path.read_text(encoding="utf-8")
    count = 0

    def sub(match: re.Match[str]) -> str:
        nonlocal count
        count += 1
        indent = match.group(1) if pattern.groups else ""
        return template.format(image=image, indent=indent)

    return pattern.sub(sub, text), count


def sync_fly_comment(text: str, version: str, rollback: str) -> str:
    """在 fly 配置的 TELEPOST_IMAGE 上一行维护一条可读的 pin 说明。"""
    lines = text.split("\n")
    marker = (
        f"    {PIN_MARKER} (TelePost v{version}, synced "
        f"{dt.date.today().isoformat()}). Rollback = {rollback}."
    )
    for i, line in enumerate(lines):
        if not re.match(r"^\s*TELEPOST_IMAGE = '", line):
            continue
        if i > 0 and PIN_MARKER in lines[i - 1]:
            lines[i - 1] = marker
        else:
            lines.insert(i, marker)
        return "\n".join(lines)
    return text


def pinned_version(text: str) -> str | None:
    """从文件当前的 TELEPOST_IMAGE 声明里读出版本号。"""
    match = re.search(r"telepost:(\d+\.\d+\.\d+)", text)
    return match.group(1) if match else None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--to", metavar="X.Y.Z", help="把基线改成该版本（同时更新 versions.json）")
    parser.add_argument("--check", action="store_true", help="只校验，不写入")
    args = parser.parse_args()

    data = load_baseline()
    previous_version = data["telepost"]["version"]

    if args.to:
        version = args.to.strip().lstrip("v")
        if not check_semver(version):
            raise SystemExit(f"版本号必须是 X.Y.Z：{args.to!r}")
        data["telepost"] = {
            "version": version,
            "tag": f"v{version}",
            "image": expected_image(version),
            "minSupported": data["telepost"].get("minSupported", ""),
            "minSupportedNote": data["telepost"].get("minSupportedNote", ""),
            "source": f"{GH_RELEASE}/v{version}",
        }
        if args.check:
            raise SystemExit("--to 与 --check 不能同时使用")
        VERSIONS.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print(f"[OK]   versions.json → {version}")

    version = data["telepost"]["version"]
    image = data["telepost"]["image"]
    if not check_semver(version):
        raise SystemExit(f"versions.json 的 telepost.version 不是 X.Y.Z：{version!r}")
    if image != expected_image(version):
        raise SystemExit(f"versions.json 的 image 与 version 不一致：{image} != {expected_image(version)}")
    if data["telepost"].get("tag") != f"v{version}":
        raise SystemExit(f"versions.json 的 tag 与 version 不一致：{data['telepost'].get('tag')} != v{version}")

    errors = 0
    for rel, pattern, template in TARGETS:
        path = REPO / rel
        if not path.is_file():
            print(f"[FAIL] {rel} 不存在")
            errors += 1
            continue
        original = path.read_text(encoding="utf-8")
        new_text, count = render(path, pattern, template, image)
        if count != 1:
            print(f"[FAIL] {rel} 匹配到 {count} 处 TelePost 镜像声明（应为 1 处）")
            errors += 1
            continue
        if rel == "fly/deploy.telepost.toml" and new_text != original:
            # Rollback 指的是「这次被换掉的那一版」，不是当前版本。
            previous = pinned_version(original) or previous_version
            rollback = previous if previous != version else "versions.json 上一版"
            new_text = sync_fly_comment(new_text, version, rollback)
        if new_text == path.read_text(encoding="utf-8"):
            print(f"[OK]   {rel} 已是 {image}")
            continue
        if args.check:
            print(f"[FAIL] {rel} 落后于基线：{current_value(path, pattern)} != {image}")
            errors += 1
            continue
        path.write_text(new_text, encoding="utf-8")
        print(f"[OK]   {rel} → {image}")

    if errors:
        print(f"TelePost baseline sync failed with {errors} error(s).")
        return 1
    print(f"TelePost baseline = {version} ({image})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
