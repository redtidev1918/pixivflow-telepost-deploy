# 部署场景速查

两条路径，任选其一：

- **Docker Compose（推荐，本机/海外/国内 VPS）**：用 `deploy init`（傻瓜式，
  一个二进制即可）或仓库内 `./scripts/bootstrap.sh` 初始化，再按场景补 `.env`。
- **`deploy` 工具（Go 单二进制）**：Docker / Fly.io / 无 Docker 的 Linux VPS
  （systemd 后端）统一入口，自动检测或 `--platform` 显式指定。

## Docker Compose 场景

| 场景 | `.env` 关键项 | 启动命令 |
|---|---|---|
| 家庭/NAT/无公网 | `RUN_MODE=AUTO`, `WEBHOOK_URL=`（默认） | `docker compose up -d` |
| 海外 VPS + 域名 | 设置 `WEBHOOK_DOMAIN`、`WEBHOOK_URL` | `docker compose --profile webhook up -d` |
| 国内服务器 + 外部代理 | 设置 `HTTP_PROXY_URL`、`EGRESS_ALL_PROXY` | `docker compose up -d` |
| 国内服务器 + 内置 Mihomo | 再设置 `SUB_URL` | `docker compose --profile proxy up -d` |

`deploy init` 的向导会按上面场景提问（回车=Polling）并自动写好对应 `.env`
与提示命令；`init` 只依赖 Docker + 一个二进制，不需要 clone 仓库或 bash/python。

## 无 Docker 的 Linux VPS（systemd 后端）

只要一台有 systemd 的 Linux 机器（TelePost 是 Python、PixivFlow 是 Node，两者
同机组合最省钱）：

```bash
sudo ./deploy doctor --platform systemd        # 自检（systemctl/python3/git + 写权限）
sudo ./deploy deploy --platform systemd        # 首次：自动 clone /opt/telepost + venv/pip + npm i -g pixivflow + 引导填写 BOT1_TOKEN/BOT1_CHANNEL_ID → 装 telepost.service
./deploy status --platform systemd             # systemctl status + 健康
./deploy logs 100 --platform systemd           # journalctl 最近日志
sudo ./deploy tp latest --platform systemd     # 升级 TelePost（git pull + pip + restart）
sudo ./deploy pf latest --platform systemd     # 升级 PixivFlow（npm 重装 + restart）
```

说明：写 `/opt` 与 `/etc/systemd` 需要 root（非 root 自动 `sudo`）；首次部署还会
自动安装 `python3-venv`（如需），启用 PixivFlow 时要求 Node 22+。

## Fly.io

```bash
cp fly/deploy.fly-multi-bot.toml ./telesubmit.fly.toml   # 改 app 名与版本基线
./deploy doctor --platform fly        # 检查 flyctl 登录等
./deploy deploy --platform fly        # 或 ./deploy tp latest --platform fly
```

平台自动检测顺序（`--platform auto`）：`telesubmit.fly.toml` + flyctl 已登录 →
Fly.io；目录里有 `docker-compose.yml` → Compose；Linux 有 systemctl → systemd。
有公网不代表必须用 Webhook；无法稳定提供 HTTPS 入站时，Polling 更简单可靠。
