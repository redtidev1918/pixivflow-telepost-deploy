FROM metacubex/mihomo:v1.19.30

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# 配置目录(由 volume 挂载持久化)
VOLUME ["/root/.config/mihomo"]

ENTRYPOINT ["docker-entrypoint.sh"]
