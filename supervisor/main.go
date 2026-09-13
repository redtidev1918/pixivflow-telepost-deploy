package main

// supervisor/main.go —— single-machine-worker-sleep 的常驻 supervisor。
//
// 它做什么：常驻占住 executor 的触发端口，在**通过鉴权的**触发到来时拉起 PixivFlow
// 子进程，转发这次触发，然后等子进程按自己的账本退出。子进程退出后不重启。
//
// 它绝不做什么（每条都是从被删除的缺陷拓扑里学来的）：
//   - 不实现空闲判定：停机决策权只属于 executor 自己的账本（exitWhenIdle/idleGraceMs）。
//     supervisor 没有、也不允许有「空闲多久就杀掉子进程」的定时器。
//   - 不因平台探针而拉起子进程：探测请求既不是 POST 也带不了正确 token，因此不会 spawn。
//     「探测把刚退出的子进程拉回来」这条停不下来的循环就此断掉。
//   - 不碰任何业务状态：它不知道 schedule id 是什么，也不校验它——404 由子进程回答。
//   - 不打印任何凭据。
//
// 它是部署层组件，不是业务组件：所以它活在部署仓库里、用 Go 写、无运行时依赖，
// 与 PixivFlow/TelePost 的职责边界由环境白名单强制（见 child.go）。

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

const (
	defaultListen        = "127.0.0.1:8090"
	defaultChildTrigger  = "127.0.0.1:8091"
	defaultTriggerPrefix = "/internal/schedules/"
)

// config 是 supervisor 的全部可配置项。所有值来自环境变量：它跑在容器里，
// 没有配置文件可读，也不该引入第二份配置来源。
type config struct {
	// listen：触发入站监听地址。默认只绑回环——触发路径不经过公网。
	listen string
	// childTrigger：子进程（executor）的触发端口。supervisor 把通过鉴权的请求转发到这里。
	childTrigger string
	// childCmd：如何拉起 executor。以 `sh -c "exec <childCmd>"` 启动，因此必须是**单条命令**
	// （不能是管道或 && 链；需要更多逻辑就写个包装脚本）。exec 是刻意的：不留包装 shell，
	// 信号与退出状态才直接来自 executor。
	childCmd string
	// token：触发令牌。为空时 fail-closed（503），绝不拉起任何进程。
	token string
	// triggerPrefix：触发路径前缀，默认 /internal/schedules/。
	triggerPrefix string
	// readyTimeout：spawn 之后等待子进程可拨通的时限；超时返回 503，不假装成功。
	readyTimeout time.Duration
	// readyPoll：就绪探测间隔。
	readyPoll time.Duration
	// shutdownGrace：supervisor 收到停止信号后，留给子进程退出的时间。
	shutdownGrace time.Duration
}

func loadConfig() (config, error) {
	cfg := config{
		listen:        envOr("SUPERVISOR_LISTEN", defaultListen),
		childTrigger:  envOr("SUPERVISOR_CHILD_TRIGGER", defaultChildTrigger),
		childCmd:      strings.TrimSpace(os.Getenv("SUPERVISOR_CHILD_CMD")),
		token:         strings.TrimSpace(os.Getenv("SCHEDULER_TRIGGER_TOKEN")),
		triggerPrefix: envOr("SUPERVISOR_TRIGGER_PREFIX", defaultTriggerPrefix),
		readyTimeout:  durationOr("SUPERVISOR_CHILD_READY_TIMEOUT_MS", 90*time.Second),
		readyPoll:     durationOr("SUPERVISOR_CHILD_READY_POLL_MS", 250*time.Millisecond),
		shutdownGrace: durationOr("SUPERVISOR_SHUTDOWN_GRACE_MS", 20*time.Second),
	}
	if cfg.childCmd == "" {
		return config{}, errors.New("必须设置 SUPERVISOR_CHILD_CMD：supervisor 需要知道如何拉起 executor")
	}
	if cfg.token == "" {
		// fail closed：没有令牌就无法区分「触发」与「探测」，那就什么都不做。
		return config{}, errors.New("必须设置 SCHEDULER_TRIGGER_TOKEN：没有它无法区分触发与探测，supervisor 拒绝启动")
	}
	if !strings.HasPrefix(cfg.triggerPrefix, "/") {
		return config{}, fmt.Errorf("SUPERVISOR_TRIGGER_PREFIX 必须以 / 开头，收到 %q", cfg.triggerPrefix)
	}
	return cfg, nil
}

func envOr(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}

func durationOr(key string, fallback time.Duration) time.Duration {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback
	}
	ms, err := time.ParseDuration(raw + "ms")
	if err != nil || ms <= 0 {
		log.Printf("supervisor: %s=%q 不是合法的毫秒数，使用默认值 %s", key, raw, fallback)
		return fallback
	}
	return ms
}

func main() {
	log.SetFlags(log.LstdFlags | log.LUTC)
	cfg, err := loadConfig()
	if err != nil {
		log.Printf("supervisor: %v", err)
		os.Exit(1)
	}

	s := newSupervisor(cfg, log.Default())

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()

	if err := s.listenAndServe(); err != nil {
		log.Printf("supervisor: 监听 %s 失败：%v", cfg.listen, err)
		os.Exit(1)
	}
	log.Printf("supervisor: 已开始监听 %s（触发前缀 %s，子进程端口 %s）", s.Addr(), cfg.triggerPrefix, cfg.childTrigger)

	<-ctx.Done()
	log.Printf("supervisor: 收到停止信号，等待子进程退出（最多 %s）", cfg.shutdownGrace)
	s.shutdown()
	log.Printf("supervisor: 已退出；机器常驻，退出的只有这个进程")
}
