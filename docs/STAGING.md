# Staging 验证清单：durable occurrences + external clock（TelePost 2.14.0 / PixivFlow 2.12.0 / Deploy 1.10.0）

目标：在**独立 staging Fly app**（512MB、autosleep）上验证，不动生产。核心三句话：
1) 普通 Telegram/健康流量唤醒机器 → **零**定时执行；
2) 受认证的 schedule HTTP 触发唤醒 → 只跑**当前这一次** canonical occurrence，重复触发幂等；
3) 作品在投递前锁定，重试/重启/outbox 重放不换作品、不造第二篇。

## 0. 前置
```bash
# 用 release v1.10.0（已 pin TelePost 2.14.0 / PixivFlow 2.12.0）
git checkout v1.10.0
export APP=<your-staging-app>          # 单独的 staging app，勿用生产名
fly apps create $APP
fly volumes create data --size 1 -r iad -a $APP

# secrets（令牌用强随机；SCHEDULER_TRIGGER_TOKEN 与 Cloudflare/看门狗一致）
openssl rand -hex 32                     # 生成 SCHEDULER_TRIGGER_TOKEN
fly secrets set -a $APP \
  BOT1_TOKEN=... BOT2_TOKEN=... \
  BOT1_CHANNEL_ID=... BOT2_CHANNEL_ID=... \
  BOT1_OWNER_ID=... BOT2_OWNER_ID=... \
  PIXIV_REFRESH_TOKEN=... \
  TELEPOST_BOT1_SUBMIT_TOKEN=... TELEPOST_BOT2_SUBMIT_TOKEN=... \
  SCHEDULER_TRIGGER_TOKEN=<上面的随机串>
```

把 `pixivflow/config/fly-two-bots.example.json` 复制为卷内 `data/pixivflow/config.json`
（已含 `schedulerRuntime.mode:"external"` + trigger 块、`morning`/`evening` 两个 schedule）。
改成 staging 的 topic/target；投递 `fields.source_label/source_ref/scheduled_at` 已就位。
部署：`fly deploy -a $APP -c fly/deploy.fly-autosleep.toml`。

## 1. 冷启动不跑定时（invariant #1/#10）
```bash
fly machines stop -a $APP --select        # 或等 auto-stop
# 用一次普通 Telegram 消息 / 健康检查唤醒
curl -i "https://$APP.fly.dev/health"
# 唤醒后查 PixivFlow：不应出现新的 schedule_slots 行
fly logs -a $APP | grep -Ei "occurrence|slot|scheduled"   # 期望：无定时执行日志
```
判定：唤醒只服务 Telegram/health，**没有** morning/evening occurrence 被创建。

## 2. 触发端点鉴权（fail-closed）
```bash
# 无 token → 401；带错 token → 401
curl -i -X POST "https://$APP.fly.dev/internal/schedules/morning/run"
curl -i -X POST -H "Authorization: Bearer wrong" \
  "https://$APP.fly.dev/internal/schedules/morning/run"
# 未知 schedule id → 404
curl -i -X POST -H "Authorization: Bearer $TOK" \
  "https://$APP.fly.dev/internal/schedules/nope/run"
```

## 3. 窗口外触发：不补历史（425/410）
```bash
# 在该 schedule 非时间窗（且 grace 外）触发 → 期望 425（未到）或 410（过期），不执行
curl -i -X POST -H "Authorization: Bearer $TOK" \
  "https://$APP.fly.dev/internal/schedules/morning/run"
```

## 4. 窗口内触发 → 精确跑一次 + 幂等
把 staging 的某个 schedule cron 临时改成“当前时刻后几分钟”（热重载即可，无需重启），到点附近：
```bash
# 立即连发 3 次（模拟 watchdog + 网络重试）
for i in 1 2 3; do
  curl -s -X POST -H "Authorization: Bearer $TOK" \
    -H "Content-Type: application/json" -d '{"label":"staging 早班"}' \
    "https://$APP.fly.dev/internal/schedules/morning/run" &
done; wait
# 期望：DB 只有 1 个 slot（morning@<stamp>），每个 target 1 个 item；TelePost 每个 target 只收到 1 篇。
fly logs -a $APP | grep -Ei "lockWork|already_completed|submitted|no_candidate"
```
判定：TelePost 审核群每个 target 恰好 1 张卡，控制卡显示 `🏷️ PixivFlow · … · BotN`（source_label）。

## 5. 作品锁：重启/重放不换作品
- 在一次 occurrence 投递途中（或 TelePost 审核中不发布）`fly machines restart -a $APP --select`。
- 机器起来后再次触发同一 schedule：应 resume 到**同一** occurrence、同一 `work_id`；
  outbox 重放复用同一 artifact，不重新候选。
```bash
# 查 slot_items：work_id 在重启前后一致；status 走向 submitted，无重复 work_id
fly logs -a $APP | grep -Ei "resume|lockWork|reuse|outbox"
```

## 6. ad-hoc 不碰定时账本
- TelePost 审核卡点「重抓/换一张」（或 `pixivflow scheduler:run-once`）：应只影响**那一个 target**，
  且 `schedule_slots` 不新增/不被标记完成。

## 7. 资源 / 冷启动
```bash
fly metrics -a $APP        # 或 Machine 视图：峰值 RSS 应在 512MB 内
# 计时：POST 触发 → 机器 started → 开始跑 occurrence 的冷启动耗时
time curl -s -X POST -H "Authorization: Bearer $TOK" \
  "https://$APP.fly.dev/internal/schedules/morning/run" -o /dev/null
```
确认 idle 后机器回到 stopped（auto_stop=stop, min_machines_running=0）。

## 8. 外部时钟（Cloudflare）冒烟
- Worker `SCHEDULES` 映射到 staging schedule id；`SCHEDULE_TRIGGER_URL=https://$APP.fly.dev`。
- `curl -X POST -H "Authorization: Bearer $TOK" "https://<worker>.workers.dev/__trigger/morning"`
  应唤醒 staging 并跑同一幂等 occurrence。

## 回滚
- staging 与生产隔离；生产不动。生产切换前：备份两个卷里的 SQLite（TelePost `data/`、
  PixivFlow config/DB），保留当前生产镜像 tag；回滚即把生产 toml 的镜像 tag 指回旧版本并
  `fly deploy`。**不要**删除旧卷。
