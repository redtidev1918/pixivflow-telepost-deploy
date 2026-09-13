#!/usr/bin/env python3
"""校验 worker-sleep 覆盖层合并后的 compose 模型。

输入是 `docker compose -f docker-compose.yml -f docker-compose.worker-sleep.yml config --format json`
的输出（stdin）。存在的原因是：这层覆盖只做一件事——把「常驻 executor」换成「常驻 supervisor
+ 按需 executor」——而这件事一旦表达错（例如忘了禁用健康检查），后果是一个停不下来的循环：
指向触发端口的探测会把刚按账本收工的子进程重新拉起来。这种错误在 YAML 里肉眼看不出来，
但可以在合并后的模型里断言出来。

退出码 0 表示通过；非 0 表示有检查项不满足，具体原因打印到 stdout。
"""

import json
import sys


def main() -> int:
    try:
        model = json.load(sys.stdin)
    except Exception as exc:  # 模型渲染失败就是失败，不要静默通过
        print(f"cannot render merged compose model: {exc}")
        return 1

    services = model.get("services", {})
    sleep = services.get("pixivflow", {})
    problems = []

    image = str(sleep.get("image", ""))
    if "pixivflow-sleep" not in image:
        problems.append(
            f"pixivflow service still uses {image!r}; the overlay must swap in the supervisor runtime"
        )

    health = sleep.get("healthcheck")
    if not isinstance(health, dict) or health.get("disable") is not True:
        problems.append(
            "the overlay must disable the inherited executor healthcheck "
            "(a probe pointing at the trigger port would resurrect the just-exited child)"
        )

    env = sleep.get("environment", {}) or {}
    listen = str(env.get("SUPERVISOR_LISTEN", ""))
    child = str(env.get("SUPERVISOR_CHILD_TRIGGER", ""))
    if not listen or not child:
        problems.append(
            "SUPERVISOR_LISTEN / SUPERVISOR_CHILD_TRIGGER must be set: the port split is part of the topology"
        )
    elif listen.rsplit(":", 1)[-1] == child.rsplit(":", 1)[-1]:
        problems.append("SUPERVISOR_LISTEN and SUPERVISOR_CHILD_TRIGGER must use different ports")
    if not str(env.get("SUPERVISOR_CHILD_CMD", "")).strip():
        problems.append("SUPERVISOR_CHILD_CMD must be set: the supervisor needs to know how to start the executor")

    # 这一层只改执行侧：业务侧的服务必须原样保留（含它自己的健康检查）。
    telepost = services.get("telepost", {})
    if not telepost:
        problems.append("the telepost service disappeared from the merged model")
    elif not telepost.get("healthcheck"):
        problems.append("the telepost service must keep its own healthcheck; the overlay only changes the executor side")

    for problem in problems:
        print(problem)
    return 1 if problems else 0


if __name__ == "__main__":
    raise SystemExit(main())
