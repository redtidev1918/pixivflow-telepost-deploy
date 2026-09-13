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

    # 触发入口必须真的可达：容器内的 127.0.0.1 只有容器自己可见，宿主机与宿主
    # cron/systemd timer 都到不了。supervisor 必须监听容器网络地址，再由 compose 发布。
    if listen.startswith("127.") or listen.startswith("localhost"):
        problems.append(
            f"SUPERVISOR_LISTEN={listen!r} binds loopback inside the container: nothing outside "
            "the container (host, host cron, systemd timer) could reach the trigger endpoint"
        )

    # 发布面必须精确：只发布 supervisor 的对外端口，且只绑宿主机 loopback；子进程端口永不发布。
    published = sleep.get("ports") or []
    if len(published) != 1:
        problems.append(
            f"the overlay must publish exactly one port (the supervisor trigger); got {len(published)}"
        )
    for entry in published:
        host_ip = str(entry.get("host_ip", ""))
        target = entry.get("target")
        if host_ip not in ("127.0.0.1", "::1"):
            problems.append(
                f"published port {entry.get('published')} binds host {host_ip!r}; the trigger must be "
                "reachable from the host only, never from the network"
            )
        if target != 8090:
            problems.append(
                f"published port maps to container port {target}; only the supervisor's own 8090 may be published"
            )

    # 子进程端口不能出现在任何服务的发布列表里，也不能被其它服务引用。
    child_port = child.rsplit(":", 1)[-1] if child else "8091"
    for name, service in services.items():
        for entry in service.get("ports") or []:
            if str(entry.get("target")) == child_port or str(entry.get("published")) == child_port:
                problems.append(
                    f"service {name!r} publishes the executor child port {child_port}; that port must stay "
                    "container-internal (publishing it would let a probe reach the on-demand child directly)"
                )

    if str(sleep.get("network_mode", "")) == "host":
        problems.append(
            "network_mode: host would drop the container network (and with it the telepost service name "
            "resolution the executor delivers to)"
        )

    # 这一层只改执行侧：业务侧的服务必须原样保留（含它自己的健康检查）。
    telepost = services.get("telepost", {})
    if not telepost:
        problems.append("the telepost service disappeared from the merged model")
    else:
        if not telepost.get("healthcheck"):
            problems.append("the telepost service must keep its own healthcheck; the overlay only changes the executor side")
        if str(telepost.get("image", "")) != "" and "telepost" not in str(telepost.get("image", "")):
            problems.append(f"the telepost service image changed to {telepost.get('image')!r}; the overlay must not touch the service side")

    for problem in problems:
        print(problem)
    return 1 if problems else 0


if __name__ == "__main__":
    raise SystemExit(main())
