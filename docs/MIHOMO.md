# Mihomo 代理配置指南

Mihomo（原 Clash.Meta）是本套件中可选的代理组件，用于国内服务器
访问 Pixiv 和 Telegram API。

---

## 启用代理

在 `.env` 中设置：

```ini
# 启用代理容器
PROXY_ENABLED=true

# 机场订阅地址（从你的代理服务商获取）
SUB_URL=https://your-airport.example/subscription?url=xxxxx

# 为各服务配置代理
PIXIVFLOW_PROXY=http://proxy:7890
TELEPOST_PROXY=http://proxy:7890
```

启动：

```bash
docker compose --profile proxy up -d
# 或直接启动全部服务
docker compose --profile all up -d
```

---

## 验证代理

```bash
# 进入 TelePost 容器测试
docker compose exec telepost bash

# 测试代理是否可用
export https_proxy=http://proxy:7890
curl -I https://www.google.com
unset https_proxy
```

---

## 自定义代理配置

如果不想使用订阅地址，可以手动配置：

1. 创建 `data/proxy/config.yaml`
2. 放入完整的 Mihomo 配置
3. 重启代理容器

```bash
docker compose restart proxy
```

---

## 面板管理

Mihomo 面板（仅本机访问）：

- API: `http://127.0.0.1:9090`
- 代理端口: `127.0.0.1:7890`

---

## 注意事项

- 代理端口只绑定宿主机 `127.0.0.1`，公网不可访问
- 订阅地址（`SUB_URL`）写入 `.env`，不会被提交到 Git
- 代理容器重启后会自动拉取最新订阅
- 国内服务器建议同时配置 Docker 镜像加速器
