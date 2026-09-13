#!/usr/bin/env python3
"""检查 shell 脚本里「变量展开后面紧跟非 ASCII 字节」的写法。

为什么需要它：`$VAR（` 这种写法里，bash 会把全角括号的字节并进变量名，于是
`set -u` 下运行时报 `unbound variable`，而且变量名在报错里显示成乱码，排查很费时间。
这个错误只在运行时炸，静态文案检查抓不到，所以在这里静态拦掉。

修法：变量后面跟非 ASCII 字符时写成 `${VAR}`。

退出码 0 = 干净；非 0 = 有命中，具体位置打印到 stdout。
"""

import pathlib
import re
import sys

PATTERN = re.compile(r"\$([A-Za-z_][A-Za-z0-9_]*)(?=[^\x00-\x7f])")


def targets() -> list[pathlib.Path]:
    files: list[pathlib.Path] = []
    files += sorted(pathlib.Path("scripts").glob("*.sh"))
    files += [pathlib.Path("proxy/docker-entrypoint.sh")]
    files += sorted(pathlib.Path("fly/scripts").glob("*.sh"))
    return [f for f in files if f.exists()]


def main() -> int:
    problems: list[str] = []
    for path in targets():
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            for match in PATTERN.finditer(line):
                problems.append(
                    f"{path}:{number}: {match.group(0)} is followed by a non-ASCII byte; "
                    f"write it as ${{{match.group(1)}}}"
                )
    for problem in problems:
        print(problem)
    return 1 if problems else 0


if __name__ == "__main__":
    raise SystemExit(main())
