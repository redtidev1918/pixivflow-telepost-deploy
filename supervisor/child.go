package main

// supervisor/child.go —— 拉起与管理 executor 子进程，以及**环境白名单**。
//
// 环境白名单是这个 preset 的安全核心。共置部署的 hostCredentialIsolation=false：
// 同机进程理论上能读到业务端的 secret，所以「executor 不持有 Telegram 凭据」（SI-1）
// 不能靠「懒得传」维持，必须靠一份**只放行 Pixiv 与调度凭据的白名单**强制。
// 白名单是 deny-by-default 的：不在名单里的变量一律不传。

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"
)

// exactEnvAllowlist：通用运行环境。与凭据无关，只是让子进程能正常启动。
var exactEnvAllowlist = map[string]bool{
	"PATH": true, "HOME": true, "TZ": true, "LANG": true, "LC_ALL": true,
	"TMPDIR": true, "TEMP": true, "TMP": true, "HOSTNAME": true,
	"NODE_ENV": true, "NODE_OPTIONS": true,
	"PIXIV_DOWNLOADER_CONFIG": true, "HTTP_PROXY": true, "HTTPS_PROXY": true,
	"NO_PROXY": true, "http_proxy": true, "https_proxy": true, "no_proxy": true,
}

// prefixEnvAllowlist：Pixiv 登录与调度凭据，以及投稿接口令牌。
var prefixEnvAllowlist = []string{"PIXIV_", "SCHEDULER_", "TELEPOST_BOT"}

// telegramCredentialName 匹配任何 Telegram 凭据名。白名单之外再加一道拒付检查：
// 即使将来有人往 PUBLISHER_ 之类的新前缀里塞 token，也不会被静默传下去。
// 注意边界字符类必须允许下划线作为分隔：`TELEPOST_BOT1_TOKEN` 这种「好前缀 + 凭据名」
// 也必须被拒。`TELEPOST_BOT1_SUBMIT_TOKEN` 是投稿接口令牌，不在此列（executor 持有它是正常的）。
var telegramCredentialName = regexp.MustCompile(`(?i)(^|[^A-Za-z0-9])BOT[0-9]+_(TOKEN|CHANNEL_ID|OWNER_ID|REVIEW_CHAT_ID|WEBHOOK_SECRET_TOKEN)$|TELEGRAM`)

// buildChildEnv 返回传给 executor 子进程的环境变量。
// 若名单里出现 Telegram 凭据名，直接拒绝启动子进程——这不是可以放行的边缘情况。
func buildChildEnv(parent []string) ([]string, error) {
	out := make([]string, 0, len(parent))
	for _, kv := range parent {
		i := strings.Index(kv, "=")
		if i <= 0 {
			continue
		}
		name, value := kv[:i], kv[i+1:]
		if !envAllowed(name) {
			continue
		}
		if telegramCredentialName.MatchString(name) {
			return nil, fmt.Errorf("环境白名单拒绝放行 Telegram 凭据 %q：executor 不得持有它（SI-1）", name)
		}
		out = append(out, name+"="+value)
	}
	return out, nil
}

func envAllowed(name string) bool {
	if exactEnvAllowlist[name] {
		return true
	}
	if strings.HasSuffix(name, "_SUBMIT_TOKEN") {
		return true
	}
	for _, prefix := range prefixEnvAllowlist {
		if strings.HasPrefix(name, prefix) {
			return true
		}
	}
	return false
}

// childState 记录子进程的结局。supervisor 必须能区分「正常 exit(0)」与「被信号杀死」：
// 前者是设计行为（账本空了），后者是 OOM 或崩溃，两者的排查方向完全不同。
type childState struct {
	startedAt time.Time
	exitedAt  time.Time
	exitCode  int
	signal    syscall.Signal
	normal    bool // exit(0)
	// requested：这次退出是 supervisor 自己的停止流程造成的，不是故障。
	// 少了这个区分，日志会把「我们让它停」说成「OOM 或崩溃」，把排查引向错误方向。
	requested bool
	err       error
}

func (c childState) describe() string {
	switch {
	case c.signal != 0 && c.requested:
		return fmt.Sprintf("被 supervisor 的停止信号 %v 终止（跑了 %s）—— 属于本进程的退出流程，不是故障", c.signal, c.exitedAt.Sub(c.startedAt).Round(time.Millisecond))
	case c.signal != 0:
		return fmt.Sprintf("被信号 %v 杀死（%s 后）—— 通常是 OOM 或崩溃，不是账本判定的正常收工", c.signal, c.exitedAt.Sub(c.startedAt).Round(time.Millisecond))
	case c.normal:
		return fmt.Sprintf("正常 exit(0)（跑了 %s）—— 账本判定空闲，这是设计行为", c.exitedAt.Sub(c.startedAt).Round(time.Millisecond))
	default:
		return fmt.Sprintf("异常退出 code=%d（跑了 %s）", c.exitCode, c.exitedAt.Sub(c.startedAt).Round(time.Millisecond))
	}
}

// childProcess 是一个正在运行的 executor 子进程。
type childProcess struct {
	cmd    *exec.Cmd
	done   chan struct{}
	state  childState
	start  time.Time
	attach sync.Mutex
}

// spawnCount 供测试断言「有没有被拉起」，生产路径只做计数与日志。
type spawner struct {
	mu          sync.Mutex
	count       int
	refusals    int
	terminating bool
	child       *childProcess
	lastState   *childState
	onExitHook  func(childState)
	onSpawn     func()
	logger      *log.Logger
}

func newSpawner(logger *log.Logger) *spawner {
	return &spawner{logger: logger}
}

// running 返回当前活着的子进程；没有则返回 nil。
func (sp *spawner) running() *childProcess {
	sp.mu.Lock()
	defer sp.mu.Unlock()
	if sp.child == nil {
		return nil
	}
	select {
	case <-sp.child.done:
		return nil
	default:
		return sp.child
	}
}

func (sp *spawner) spawns() int {
	sp.mu.Lock()
	defer sp.mu.Unlock()
	return sp.count
}

func (sp *spawner) lastExit() (childState, bool) {
	sp.mu.Lock()
	defer sp.mu.Unlock()
	if sp.lastState == nil {
		return childState{}, false
	}
	return *sp.lastState, true
}

// spawn 拉起一个 executor 子进程。调用方必须保证同一时刻只有一个：
// 「同一 Pixiv 凭据最多一个活跃生产执行」（SI-4）在这里落成互斥。
func (sp *spawner) spawn(cfg config) (*childProcess, error) {
	sp.mu.Lock()
	defer sp.mu.Unlock()
	if sp.child != nil {
		select {
		case <-sp.child.done:
			// 已退出：允许拉起新的
		default:
			return sp.child, nil
		}
	}

	env, err := buildChildEnv(os.Environ())
	if err != nil {
		sp.refusals++
		return nil, err
	}

	cmd := exec.Command("sh", "-c", cfg.childCmd)
	cmd.Env = env
	// 子进程的输出直接进容器日志：executor 的日志是排查账本与投递的主要凭据。
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	// supervisor 自己不因空闲杀子进程；但 supervisor 收到停止信号时，子进程不能变成孤儿。
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: false}

	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("拉起 executor 失败：%w", err)
	}

	cp := &childProcess{cmd: cmd, done: make(chan struct{}), start: time.Now()}
	sp.child = cp
	sp.count++
	if sp.onSpawn != nil {
		sp.onSpawn()
	}
	sp.logger.Printf("supervisor: 已拉起 executor pid=%d（第 %d 次；机器常驻，只有这个进程是按需的）", cmd.Process.Pid, sp.count)

	go func() {
		err := cmd.Wait()
		state := childState{startedAt: cp.start, exitedAt: time.Now()}
		if err == nil {
			state.normal = true
		} else {
			var ee *exec.ExitError
			if errors.As(err, &ee) {
				if ws, ok := ee.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
					state.signal = ws.Signal()
				} else {
					state.exitCode = ee.ExitCode()
				}
			} else {
				state.err = err
			}
		}
		cp.state = state
		sp.mu.Lock()
		state.requested = sp.terminating
		sp.lastState = &state
		sp.mu.Unlock()
		close(cp.done)
		sp.logger.Printf("supervisor: executor 已退出：%s；不重启它（下次触发到来时才会再拉起）", state.describe())
		if sp.onExitHook != nil {
			sp.onExitHook(state)
		}
	}()

	return cp, nil
}

// terminate 只在 supervisor 自己停止时调用：把信号转给子进程并等它退出。
// 它**不**用于空闲回收——那属于子进程自己的账本。
func (sp *spawner) terminate(grace time.Duration) {
	cp := sp.running()
	if cp == nil {
		return
	}
	sp.mu.Lock()
	sp.terminating = true
	sp.mu.Unlock()
	sp.logger.Printf("supervisor: 把停止信号转给 executor pid=%d", cp.cmd.Process.Pid)
	_ = cp.cmd.Process.Signal(syscall.SIGTERM)

	select {
	case <-cp.done:
		sp.logger.Printf("supervisor: executor 已响应停止信号")
	case <-time.After(grace):
		// 宽限期到仍不退出：supervisor 自己要死了，不能留孤儿进程占着账本。
		sp.logger.Printf("supervisor: executor 未在 %s 内退出，发送 SIGKILL（这次不是空闲回收）", grace)
		_ = cp.cmd.Process.Kill()
		<-cp.done
	}
}

// waitReady 等待子进程的触发端口可拨通。supervisor 不知道子进程内部状态，
// 只认「能不能连上」这一件事；等不到就返回错误，由调用方回 503，绝不假装成功。
func waitReady(ctx context.Context, addr string, timeout, poll time.Duration) error {
	deadline := time.Now().Add(timeout)
	for {
		if conn, err := dialTimeout(addr, poll); err == nil {
			_ = conn.Close()
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("等待 executor 就绪超时（%s，地址 %s）", timeout, addr)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(poll):
		}
	}
}
