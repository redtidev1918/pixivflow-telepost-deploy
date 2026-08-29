# 国内服务器部署方案

## 适用场景

- 服务器位于中国大陆
- 无公网 IP
- 需要代理访问 Pixiv 和 Telegram API

## 配置要点

```ini
# 运行模式（无公网 IP）
RUN_MODE=POLLING

# 启用代理
PROXY_ENABLED=true
SUB_URL=你的机场订阅地址

# 各服务通过代理访问外网
PIXIVFLOW_PROXY=http://proxy:7890
TELEPOST_PROXY=http://proxy:7890
```

## 启动

```bash
docker compose --profile all up -d
```
