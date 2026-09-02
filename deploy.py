#!/usr/bin/env python3
"""deploy — TelePost/PixivFlow 一键式多平台部署工具。

平台：Fly.io（telesubmit.fly.toml）与 Docker Compose（.env），
macOS / Linux / Windows 通用（Python 3.8+ 标准库，无第三方依赖）。

用法：
  python3 deploy.py [--platform fly|compose|auto] [全局选项] 子命令 [参数]

子命令：
  deploy                部署当前配置（保持现有版本）
  tp <版本|latest>      升级并部署（fly: TelePost 镜像 tag；compose: 部署套件 tag）
  pf <版本>             升级 PixivFlow 并部署
  status                状态/健康检查
  logs [行数]           最近日志
  doctor                环境自检
  version               显示工具与当前配置版本
"""
import argparse
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.request

VERSION = "2.1.0"
TELEPOST_REPO = "ghcr.io/redtidev1918/telepost"
KIT_REPO = "ghcr.io/redtidev1918/pixivflow-telepost-deploy"
DEFAULT_FLY_CONFIG = "telesubmit.fly.toml"
DEFAULT_COMPOSE_ENV = ".env"
HEALTH_TIMEOUT = int(os.environ.get("HEALTH_TIMEOUT", "240"))
HEALTH_INTERVAL = 6

# --------------------------------------------------------------------------
# 日志与界面
# --------------------------------------------------------------------------

def _use_color() -> bool:
    return sys.stdout.isatty() and os.environ.get("NO_COLOR") != "1"


class _C:
    if _use_color():
        BOLD, DIM = "\033[1m", "\033[2m"
        RED, GREEN, YELLOW, CYAN, RESET = "\033[31m", "\033[32m", "\033[33m", "\033[36m", "\033[0m"
    else:
        BOLD = DIM = RED = GREEN = YELLOW = CYAN = RESET = ""


def ok(msg): print(f"{_C.GREEN}{_C.BOLD}✓{_C.RESET} {msg}", flush=True)
def info(msg): print(f"{_C.CYAN}▸{_C.RESET} {msg}", flush=True)
def warn(msg): print(f"{_C.YELLOW}!{_C.RESET} {msg}", file=sys.stderr, flush=True)
def fail(msg): print(f"{_C.RED}{_C.BOLD}✗{_C.RESET} {msg}", file=sys.stderr, flush=True)
def step(n, msg): print(f"\n{_C.BOLD}{_C.CYAN}[{n}]{_C.RESET}{_C.BOLD} {msg}{_C.RESET}", flush=True)


class AppError(Exception):
    pass


LOG_DIR = os.environ.get("LOG_DIR", "/tmp/deploy-logs" if sys.platform != "win32" else os.path.join(os.environ.get("TEMP", "."), "deploy-logs"))
LOG_FILE = ""


def setup_logging():
    global LOG_FILE
    os.makedirs(LOG_DIR, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    LOG_FILE = os.path.join(LOG_DIR, f"deploy-{stamp}.log")
    logger = logging.getLogger("deploy")
    logger.setLevel(logging.DEBUG)
    fh = logging.FileHandler(LOG_FILE, encoding="utf-8")
    fh.setFormatter(logging.Formatter("%(asctime)s %(message)s"))
    logger.addHandler(fh)
    return logger


log = setup_logging()


def run(cmd, *, capture=False, echo=False):
    """执行命令；返回 CompletedProcess。输出写入日志，echo 时同步到终端。"""
    log.debug("$ %s", " ".join(cmd))
    if capture:
        p = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
        if p.stdout:
            log.debug(p.stdout.rstrip())
        if p.stderr:
            log.debug("[stderr] " + p.stderr.rstrip())
        if echo:
            if p.stdout:
                print(p.stdout, end="")
            if p.stderr:
                print(p.stderr, end="", file=sys.stderr)
        return p
    # 非捕获：实时输出到终端，同时写日志（简单方式：只记命令与结果码）
    p = subprocess.run(cmd)
    log.debug("(exit %d)", p.returncode)
    return p


def die(msg):
    fail(msg)
    if LOG_FILE:
        print(f"\n完整日志见：{LOG_FILE}", file=sys.stderr)
    raise SystemExit(1)


def have(exe):
    return shutil.which(exe) is not None


def fly_bin():
    for c in ("flyctl", "fly"):
        if have(c):
            return c
    return None


# --------------------------------------------------------------------------
# 配置文件读写（文本级，避免依赖 TOML 解析库，兼容各 Python 版本）
# --------------------------------------------------------------------------

_TOML_KV = re.compile(r'^([ \t]*)([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*"([^"]*)"[ \t]*$')
_ENV_KV = re.compile(r'^([A-Za-z_][A-Za-z0-9_]*)=(.*)$')


def toml_get(path, key):
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                m = _TOML_KV.match(line.rstrip("\n"))
                if m and m.group(2) == key:
                    return m.group(3)
    except OSError:
        pass
    return None


def toml_set(path, key, val):
    out = []
    found = False
    with open(path, encoding="utf-8") as f:
        for line in f:
            m = _TOML_KV.match(line.rstrip("\n"))
            if m and m.group(2) == key:
                out.append(f'{m.group(1)}{key} = "{val}"\n')
                found = True
            else:
                out.append(line)
    if not found:
        raise AppError(f"{path} 里没有键 {key}")
    with open(path, "w", encoding="utf-8") as f:
        f.writelines(out)


def env_get(path, key):
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                m = _ENV_KV.match(line.rstrip("\n"))
                if m and m.group(1) == key:
                    return m.group(2).strip()
    except OSError:
        pass
    return None


def env_set(path, key, val):
    out = []
    found = False
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                m = _ENV_KV.match(line.rstrip("\n"))
                if m and m.group(1) == key:
                    out.append(f"{key}={val}\n")
                    found = True
                else:
                    out.append(line)
    except OSError:
        out = []
    if not found:
        out.append(f"{key}={val}\n")
    with open(path, "w", encoding="utf-8") as f:
        f.writelines(out)


# --------------------------------------------------------------------------
# 平台自适应
# --------------------------------------------------------------------------

def detect_platform(args):
    if args.platform != "auto":
        return args.platform
    fb = fly_bin()
    if os.path.exists(args.config or DEFAULT_FLY_CONFIG) and fb:
        p = run([fb, "auth", "whoami"], capture=True)
        if p.returncode == 0:
            return "fly"
    if os.path.exists("docker-compose.yml") or os.path.exists("compose.yaml"):
        return "compose"
    die("无法自动检测部署平台。用 --platform fly|compose 指定")


def config_for(platform, args):
    return args.config if args.config else (DEFAULT_FLY_CONFIG if platform == "fly" else DEFAULT_COMPOSE_ENV)


def _compose_default_image():
    for name in ("docker-compose.yml", "compose.yaml"):
        try:
            with open(name, encoding="utf-8") as f:
                for line in f:
                    m = re.search(r"image:\s*\$\{[A-Za-z_]+:-([^}\s]+)\}", line)
                    if m and "STACK_IMAGE" in line:
                        return m.group(1)
        except OSError:
            pass
    return f"{KIT_REPO}:latest"


def tp_version(platform, cfg):
    if platform == "fly":
        v = toml_get(cfg, "TELEPOST_IMAGE") or ""
        return v.rsplit(":", 1)[-1]
    v = env_get(cfg, "STACK_IMAGE") or _compose_default_image()
    return v.rsplit(":", 1)[-1]


def _compose_default_arg(key):
    for name in ("docker-compose.yml", "compose.yaml"):
        try:
            with open(name, encoding="utf-8") as f:
                for line in f:
                    m = re.search(rf"{key}:\s*\$\{{[A-Za-z_]+:-([^}}\s]+)\}}", line)
                    if m:
                        return m.group(1)
        except OSError:
            pass
    return None


def pf_version(platform, cfg):
    if platform == "fly":
        return toml_get(cfg, "PIXIVFLOW_VERSION") or "?"
    return env_get(cfg, "PIXIVFLOW_VERSION") or _compose_default_arg("PIXIVFLOW_VERSION") or "?"


# --------------------------------------------------------------------------
# 子命令
# --------------------------------------------------------------------------

def cmd_doctor(args):
    platform = detect_platform(args)
    cfg = config_for(platform, args)
    step("1/3", "平台")
    ok(f"使用平台：{platform}")

    step("2/3", "依赖与环境")
    problems = 0
    if platform == "fly":
        fb = fly_bin()
        if fb:
            ok(f"{fb} 可用")
        else:
            fail("缺 flyctl/fly"); problems += 1
        if os.path.exists(cfg):
            ok(f"{cfg} 存在")
        else:
            fail(f"{cfg} 不存在"); problems += 1
        app = toml_get(cfg, "app")
        if app:
            ok(f"app = {app}")
        else:
            fail("无法解析 app"); problems += 1
        if fb:
            p = run([fb, "auth", "whoami"], capture=True)
            if p.returncode == 0:
                ok(f"已登录：{p.stdout.strip()}")
            else:
                fail(f"fly 未登录（运行 {fb} auth login）"); problems += 1
    else:
        if have("docker"):
            ok("docker 可用")
        else:
            fail("缺 docker"); problems += 1
        p = run(["docker", "compose", "version"], capture=True)
        if p.returncode == 0:
            ok("docker compose 可用")
        else:
            fail("缺 docker compose v2"); problems += 1
        p = run(["docker", "info"], capture=True)
        if p.returncode == 0:
            ok("docker daemon 运行中")
        else:
            warn("docker daemon 未运行（部署前需启动）"); problems += 1
        if os.path.exists(cfg):
            ok(f"{cfg} 存在")
        else:
            warn(f"{cfg} 不存在（将用 compose 默认值）")

    step("3/3", "当前版本")
    ok(f"TelePost/套件 : {tp_version(platform, cfg)}")
    ok(f"PixivFlow    : {pf_version(platform, cfg)}")
    if problems:
        die(f"自检存在 {problems} 个未满足项")
    ok("自检通过")


def cmd_version(args):
    platform = detect_platform(args)
    cfg = config_for(platform, args)
    print(f"{_C.BOLD}deploy v{VERSION}{_C.RESET}")
    print(f"  platform      : {platform}")
    print(f"  TelePost/套件 : {tp_version(platform, cfg)}")
    print(f"  PixivFlow     : {pf_version(platform, cfg)}")


def health_url(platform, cfg):
    if platform == "fly":
        app = toml_get(cfg, "app")
        return f"https://{app}.fly.dev/health"
    return "http://127.0.0.1:8080/health"


def fetch_health(url, timeout=10):
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return json.load(r)
    except Exception:
        return None


def cmd_status(args):
    platform = detect_platform(args)
    cfg = config_for(platform, args)
    if platform == "fly":
        info(f"app = {toml_get(cfg, 'app')}")
        run([fly_bin(), "status", "-a", toml_get(cfg, "app")], echo=True)
    else:
        run(["docker", "compose", "ps"], echo=True)
    print()
    info("健康端点：")
    h = fetch_health(health_url(platform, cfg))
    if h:
        print(json.dumps(h, ensure_ascii=False, indent=2))
    else:
        warn(f"  {health_url(platform, cfg)} 不可达")


def cmd_logs(args):
    platform = detect_platform(args)
    cfg = config_for(platform, args)
    n = args.arg or 100
    if platform == "fly":
        p = run([fly_bin(), "logs", "-a", toml_get(cfg, "app"), "--no-tail"], capture=True)
    else:
        p = run(["docker", "compose", "logs", "--tail", str(n), "stack"], capture=True)
    lines = (p.stdout or "").splitlines()[-n:]
    print("\n".join(lines))


def _show_health(url):
    h = fetch_health(url)
    if h:
        status = h.get("status")
        avail = h.get("system_available_mb")
        if status:
            print(f"  status        : {status}")
        if avail is not None:
            print(f"  可用内存(MB)   : {avail}")


def cmd_deploy(args):
    platform = detect_platform(args)
    cfg = config_for(platform, args)

    step("1/3", "部署前检查")
    if platform == "fly":
        fb = fly_bin() or die("未找到 flyctl/fly")
        if run([fb, "auth", "whoami"], capture=True).returncode != 0:
            die("fly 未登录")
        app = toml_get(cfg, "app")
        info(f"平台=fly  app={app}")
        info(f"TelePost={TELEPOST_REPO}:{tp_version(platform, cfg)}  PixivFlow={pf_version(platform, cfg)}")
    else:
        if not have("docker"):
            die("未找到 docker")
        if run(["docker", "info"], capture=True).returncode != 0:
            die("docker daemon 未运行")
        info(f"平台=compose  TelePost/套件={tp_version(platform, cfg)}  PixivFlow={pf_version(platform, cfg)}")

    step("2/3", "执行部署")
    if args.dry_run:
        if platform == "fly":
            print(f"[dry-run] {fly_bin()} deploy -c {cfg} --remote-only --strategy rolling")
        elif args.build:
            print("[dry-run] docker compose build stack && docker compose up -d stack")
        else:
            print("[dry-run] docker compose pull stack && docker compose up -d stack")
        return

    for attempt in range(1, args.retries + 2):
        info(f"尝试 {attempt}/{args.retries + 1}")
        rc = 0
        if platform == "fly":
            rc = run([fly_bin(), "deploy", "-c", cfg, "--remote-only", "--strategy", "rolling"], echo=True).returncode
        elif args.build:
            rc = run(["docker", "compose", "build", "stack"], echo=True).returncode
            if rc == 0:
                rc = run(["docker", "compose", "up", "-d", "stack"], echo=True).returncode
        else:
            rc = run(["docker", "compose", "pull", "stack"], echo=True).returncode
            if rc == 0:
                rc = run(["docker", "compose", "up", "-d", "stack"], echo=True).returncode
        if rc == 0:
            ok("部署命令成功")
            break
        fail(f"部署失败（尝试 {attempt}）")
        if attempt <= args.retries:
            warn("15s 后重试...")
            time.sleep(15)
        else:
            die("部署多次失败")

    step("3/3", "等待健康检查")
    url = health_url(platform, cfg)
    deadline = time.time() + HEALTH_TIMEOUT
    waited = 0
    while time.time() < deadline:
        if fetch_health(url):
            ok("健康检查通过")
            break
        waited += HEALTH_INTERVAL
        print(f"  ... 等待中（{waited}s）\r", end="")
        time.sleep(HEALTH_INTERVAL)
    print()
    if fetch_health(url) is None:
        die(f"健康检查超时（{HEALTH_TIMEOUT}s）")
    info("结果：")
    _show_health(url)
    ok("部署完成 ✅")


def cmd_upgrade(args):
    platform = detect_platform(args)
    cfg = config_for(platform, args)
    target = args.arg
    if not target:
        die(f"缺少版本参数（用法：deploy.py {args.kind} <版本|latest>）")
    cur = tp_version(platform, cfg) if args.kind == "tp" else pf_version(platform, cfg)

    if args.dry_run:
        info(f"[dry-run] 将 {args.kind} 从 {cur} 升级到 {target}（不写配置）")
        return

    if platform == "fly":
        if args.kind == "tp":
            toml_set(cfg, "TELEPOST_IMAGE", f"{TELEPOST_REPO}:{target}")
            info(f"TelePost: {cur} → {target}")
        else:
            toml_set(cfg, "PIXIVFLOW_VERSION", target)
            info(f"PixivFlow: {cur} → {target}")
    else:
        if args.kind == "tp":
            env_set(cfg, "STACK_IMAGE", f"{KIT_REPO}:{target}")
            info(f"部署套件(含 TelePost): {cur} → {target}")
        else:
            env_set(cfg, "PIXIVFLOW_VERSION", target)
            info(f"PixivFlow: {cur} → {target}（仅 --build 本地构建生效）")


# --------------------------------------------------------------------------
# 主入口
# --------------------------------------------------------------------------

def main(argv=None):
    p = argparse.ArgumentParser(prog="deploy", description="TelePost/PixivFlow 多平台一键部署", add_help=False)
    p.add_argument("--platform", "-p", choices=["fly", "compose", "auto"], default="auto")
    p.add_argument("--config", "-c", default=None, help="配置文件（fly: toml；compose: env）")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--verbose", "-v", action="store_true")
    p.add_argument("--no-color", action="store_true")
    p.add_argument("--retries", type=int, default=2)
    p.add_argument("--build", action="store_true", help="compose：本地构建")
    p.add_argument("-h", "--help", action="store_true")
    sub = p.add_subparsers(dest="cmd")

    sub.add_parser("deploy", help="部署当前配置")
    for name in ("tp", "pf"):
        sp = sub.add_parser(name, help="升级并部署")
        sp.set_defaults(kind=name)
        sp.add_argument("arg", nargs="?")
    sp = sub.add_parser("status", help="状态/健康检查")
    sp = sub.add_parser("logs", help="最近日志")
    sp.add_argument("arg", nargs="?", type=int)
    sub.add_parser("doctor", help="环境自检")
    sub.add_parser("version", help="版本信息")

    args = p.parse_args(argv)
    if args.help or not args.cmd:
        p.print_help()
        return 0

    if args.no_color or not sys.stdout.isatty():
        _C.BOLD = _C.DIM = _C.RED = _C.GREEN = _C.YELLOW = _C.CYAN = _C.RESET = ""

    log.debug("invoke: platform=%s cmd=%s", args.platform, args.cmd)
    try:
        {
            "deploy": cmd_deploy,
            "tp": lambda a: (cmd_upgrade(a), cmd_deploy(a)),
            "pf": lambda a: (cmd_upgrade(a), cmd_deploy(a)),
            "status": cmd_status,
            "logs": cmd_logs,
            "doctor": cmd_doctor,
            "version": cmd_version,
        }[args.cmd](args)
    except KeyboardInterrupt:
        warn("中断")
        return 130
    except AppError as e:
        die(str(e))
    return 0


if __name__ == "__main__":
    sys.exit(main())
