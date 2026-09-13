package main

// supervisor/supervisor_test.go —— 守护 single-machine-worker-sleep 的四条不变量。
//
// 这些测试跑在**真实子进程**上（testdata/fakeexecutor）：真实 spawn、真实退出码、
// 真实信号、真实环境继承。用假的进程抽象来测，等于自证。

import (
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

const fakeToken = "test-trigger-token-not-a-real-secret"

var fakeExecutable string

func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "supervisor-fakeexecutor-")
	if err != nil {
		panic(err)
	}
	fakeExecutable = filepath.Join(dir, "fakeexecutor")
	build := exec.Command("go", "build", "-o", fakeExecutable, "./testdata/fakeexecutor")
	build.Stdout, build.Stderr = os.Stdout, os.Stderr
	if err := build.Run(); err != nil {
		panic("无法构建假 executor：" + err.Error())
	}
	code := m.Run()
	_ = os.RemoveAll(dir)
	os.Exit(code)
}

// ---------------------------------------------------------------------------
// 环境白名单（设计文档要求：这条测试存在之前，preset 不得标记为已实现）
// ---------------------------------------------------------------------------

func TestChildEnvAllowlistDropsEveryTelegramCredential(t *testing.T) {
	parent := []string{
		"PATH=/usr/bin", "HOME=/root", "TZ=UTC",
		"PIXIV_REFRESH_TOKEN=pixiv-secret",
		"PIXIV_DOWNLOADER_CONFIG=/app/config/production.json",
		"SCHEDULER_TRIGGER_TOKEN=scheduler-secret",
		"TELEPOST_BOT1_SUBMIT_TOKEN=submit-secret",
		"BOT1_TOKEN=telegram-secret",
		"BOT1_CHANNEL_ID=-100123",
		"BOT1_OWNER_ID=42",
		"BOT2_WEBHOOK_SECRET_TOKEN=webhook-secret",
		"BOT2_REVIEW_CHAT_ID=-100999",
		"TELEGRAM_API_ID=123",
	}

	env, err := buildChildEnv(parent)
	if err != nil {
		t.Fatalf("白名单不应因合法的 Pixiv/调度凭据失败：%v", err)
	}
	joined := strings.Join(env, "\n")

	for _, forbidden := range []string{
		"BOT1_TOKEN", "BOT1_CHANNEL_ID", "BOT1_OWNER_ID",
		"BOT2_WEBHOOK_SECRET_TOKEN", "BOT2_REVIEW_CHAT_ID", "TELEGRAM_API_ID",
	} {
		if strings.Contains(joined, forbidden) {
			t.Errorf("executor 子进程不得继承 %s（SI-1：executor 永不持有 Telegram 凭据）", forbidden)
		}
	}
	for _, required := range []string{
		"PATH=/usr/bin", "PIXIV_REFRESH_TOKEN=pixiv-secret", "PIXIV_DOWNLOADER_CONFIG=",
		"SCHEDULER_TRIGGER_TOKEN=scheduler-secret", "TELEPOST_BOT1_SUBMIT_TOKEN=submit-secret",
	} {
		if !strings.Contains(joined, required) {
			t.Errorf("白名单漏掉了子进程必需的 %s", required)
		}
	}
}

func TestChildEnvAllowlistIsDenyByDefault(t *testing.T) {
	env, err := buildChildEnv([]string{
		"AWS_SECRET_ACCESS_KEY=x", "GH_TOKEN=y", "PIXIV_UNRELATED_OK=z", "RANDOM_VAR=w",
	})
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(env, "\n")
	for _, forbidden := range []string{"AWS_SECRET_ACCESS_KEY", "GH_TOKEN", "RANDOM_VAR"} {
		if strings.Contains(joined, forbidden) {
			t.Errorf("不在白名单里的变量必须一律不传：%s", forbidden)
		}
	}
	if !strings.Contains(joined, "PIXIV_UNRELATED_OK") {
		t.Errorf("Pixiv 前缀应当放行")
	}
}

func TestChildEnvRefusesWhenAllowlistWouldLeakATelegramCredential(t *testing.T) {
	// 纵深防御：即使有人给凭据取了一个落在白名单前缀里的名字，也必须拒绝启动，
	// 而不是「放行了但没注意」。
	parent := []string{"TELEPOST_BOT1_TOKEN=telegram-secret"}
	env, err := buildChildEnv(parent)
	if err == nil {
		t.Fatalf("白名单放行了 Telegram 凭据时必须拒绝，实际 env=%v", env)
	}
	if !strings.Contains(err.Error(), "SI-1") {
		t.Errorf("拒绝理由应指向 SI-1，实际：%v", err)
	}
}

func TestChildEnvIsWhatTheRealChildActuallyInherits(t *testing.T) {
	// 端到端：真的 spawn 一个子进程，让它 dump 自己的环境。
	dir := t.TempDir()
	dump := filepath.Join(dir, "env.txt")
	listen := freeAddr(t)

	s := newTestSupervisor(t, config{
		listen:       "127.0.0.1:0",
		childTrigger: listen,
		childCmd:     fakeCommand(t, "FAKE_ENV_DUMP="+dump+" FAKE_LISTEN="+listen),
		token:        fakeToken,
		readyTimeout: 20 * time.Second,
		readyPoll:    50 * time.Millisecond,
	})
	t.Setenv("BOT1_TOKEN", "telegram-secret-must-not-leak")
	t.Setenv("PIXIV_REFRESH_TOKEN", "pixiv-secret-must-reach-child")

	if _, err := s.children.spawn(s.cfg); err != nil {
		t.Fatalf("spawn 失败：%v", err)
	}
	waitForFile(t, dump, 15*time.Second)

	raw, err := os.ReadFile(dump)
	if err != nil {
		t.Fatal(err)
	}
	childEnv := string(raw)
	if strings.Contains(childEnv, "BOT1_TOKEN=telegram-secret-must-not-leak") {
		t.Errorf("真实子进程继承到了 Telegram 凭据：%s", childEnv)
	}
	if !strings.Contains(childEnv, "PIXIV_REFRESH_TOKEN=pixiv-secret-must-reach-child") {
		t.Errorf("真实子进程缺少 Pixiv 凭据")
	}
	s.shutdown()
}

// ---------------------------------------------------------------------------
// 触发路径：只有「通过鉴权的 POST」才能拉起进程
// ---------------------------------------------------------------------------

func TestUnauthenticatedTriggerNeverSpawns(t *testing.T) {
	cases := []struct {
		name   string
		method string
		path   string
		auth   string
		want   int
	}{
		{"missing token", http.MethodPost, "/internal/schedules/abc/run", "", http.StatusUnauthorized},
		{"wrong token", http.MethodPost, "/internal/schedules/abc/run", "Bearer nope", http.StatusUnauthorized},
		{"malformed header", http.MethodPost, "/internal/schedules/abc/run", fakeToken, http.StatusUnauthorized},
		// GET 必须 404 而不是 401：探测不该暴露鉴权状态，更不该拉起进程。
		{"get probe", http.MethodGet, "/internal/schedules/abc/run", "Bearer " + fakeToken, http.StatusNotFound},
		{"unknown path", http.MethodPost, "/api/whatever", "Bearer " + fakeToken, http.StatusNotFound},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			marker := filepath.Join(dir, "spawned.txt")
			s := newTestSupervisor(t, config{
				childTrigger: freeAddr(t),
				childCmd:     fakeCommand(t, "FAKE_SPAWN_MARKER="+marker+" FAKE_LISTEN=127.0.0.1:1"),
				token:        fakeToken,
				readyTimeout: 2 * time.Second,
				readyPoll:    50 * time.Millisecond,
			})
			startSupervisor(t, s)

			req, _ := http.NewRequest(tc.method, "http://"+s.Addr()+tc.path, strings.NewReader(`{"label":"x"}`))
			if tc.auth != "" {
				req.Header.Set("Authorization", tc.auth)
			}
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			resp.Body.Close()

			if resp.StatusCode != tc.want {
				t.Errorf("状态码 %d，期望 %d", resp.StatusCode, tc.want)
			}
			if _, err := os.Stat(marker); err == nil {
				t.Fatalf("未通过鉴权的请求拉起了 executor —— 这正是「探测把进程叫醒」的循环")
			}
			if s.children.spawns() != 0 {
				t.Errorf("spawn 次数 %d，期望 0", s.children.spawns())
			}
			s.shutdown()
		})
	}
}

func TestHealthzNeverSpawns(t *testing.T) {
	s := newTestSupervisor(t, config{
		childTrigger: freeAddr(t),
		childCmd:     fakeCommand(t, "FAKE_SPAWN_MARKER="+filepath.Join(t.TempDir(), "spawned.txt")),
		token:        fakeToken,
		readyTimeout: time.Second,
		readyPoll:    50 * time.Millisecond,
	})
	startSupervisor(t, s)

	resp, err := http.Get("http://" + s.Addr() + "/healthz")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("/healthz = %d，期望 200", resp.StatusCode)
	}
	if s.children.spawns() != 0 {
		t.Errorf("/healthz 不允许拉起 executor（它是 supervisor 自己的存活端点）")
	}
	s.shutdown()
}

func TestAuthenticatedTriggerSpawnsAndForwards(t *testing.T) {
	listen := freeAddr(t)
	s := newTestSupervisor(t, config{
		childTrigger: listen,
		childCmd:     fakeCommand(t, "FAKE_LISTEN="+listen),
		token:        fakeToken,
		readyTimeout: 20 * time.Second,
		readyPoll:    50 * time.Millisecond,
	})
	startSupervisor(t, s)
	defer s.shutdown()

	resp := trigger(t, s, "/internal/schedules/abc/run")
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusAccepted {
		t.Fatalf("状态码 %d，期望 202（转发子进程的应答）", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(body), "accepted") {
		t.Errorf("应当原样转发子进程的响应体，实际：%s", body)
	}
	if s.children.spawns() != 1 {
		t.Errorf("spawn 次数 %d，期望 1", s.children.spawns())
	}
}

func TestSecondTriggerForwardsWithoutSpawnAgain(t *testing.T) {
	listen := freeAddr(t)
	s := newTestSupervisor(t, config{
		childTrigger: listen,
		childCmd:     fakeCommand(t, "FAKE_LISTEN="+listen),
		token:        fakeToken,
		readyTimeout: 20 * time.Second,
		readyPoll:    50 * time.Millisecond,
	})
	startSupervisor(t, s)
	defer s.shutdown()

	for i := 0; i < 2; i++ {
		resp := trigger(t, s, "/internal/schedules/abc/run")
		resp.Body.Close()
		if resp.StatusCode != http.StatusAccepted {
			t.Fatalf("第 %d 次触发的状态码 %d", i+1, resp.StatusCode)
		}
	}
	if s.children.spawns() != 1 {
		t.Errorf("同一时刻只允许一个 executor（SI-4），spawn 次数 %d", s.children.spawns())
	}
}

// ---------------------------------------------------------------------------
// 生命周期：不重启、不因空闲被杀、能区分正常退出与被信号杀死
// ---------------------------------------------------------------------------

func TestDirectChildIsTheRealProcessNotAWrapperShell(t *testing.T) {
	// 回归：过去用 `sh -c <cmd>` 启动，包装 shell 成了直接子进程。后果在 Linux 上才暴露——
	// SIGTERM 传不到 executor，被 SIGKILL 的 executor 会被汇报成「exit 137」这种普通退出码，
	// 于是「区分 OOM/崩溃与账本判定收工」这条生命周期诊断全部失效。
	// 用 `sh -c "exec <cmd>"` 后，cmd.Process.Pid 必须就是 executor 自己的 pid。
	dir := t.TempDir()
	pidFile := filepath.Join(dir, "child.pid")
	listen := freeAddr(t)

	s := newTestSupervisor(t, config{
		childTrigger: listen,
		childCmd:     fakeCommand(t, "FAKE_PID_FILE="+pidFile+" FAKE_LISTEN="+listen),
		token:        fakeToken,
		readyTimeout: 20 * time.Second,
		readyPoll:    50 * time.Millisecond,
	})
	t.Cleanup(s.shutdown)

	cp, err := s.children.spawn(s.cfg)
	if err != nil {
		t.Fatalf("spawn 失败：%v", err)
	}
	waitForFile(t, pidFile, 15*time.Second)

	raw, err := os.ReadFile(pidFile)
	if err != nil {
		t.Fatal(err)
	}
	childPid := strings.TrimSpace(string(raw))
	if childPid != strconv.Itoa(cp.cmd.Process.Pid) {
		t.Fatalf("直接子进程 pid=%d，但真正的 executor pid=%s：中间还有包装 shell，信号与退出状态会失真",
			cp.cmd.Process.Pid, childPid)
	}
}

func TestChildExitIsNotRestartedAndMachineKeepsServing(t *testing.T) {
	listen := freeAddr(t)
	// 子进程退出后端口关闭；下一次触发才会再拉起新的子进程。
	s := newTestSupervisor(t, config{
		childTrigger: listen,
		childCmd:     fakeCommand(t, "FAKE_LISTEN="+listen+" FAKE_EXIT_CODE=0"),
		token:        fakeToken,
		readyTimeout: 2 * time.Second,
		readyPoll:    50 * time.Millisecond,
	})
	startSupervisor(t, s)
	defer s.shutdown()

	// 直接 spawn 并等它自己退出（模拟「账本空了 -> exit(0)」）。
	if _, err := s.children.spawn(s.cfg); err != nil {
		t.Fatal(err)
	}
	waitFor(t, 10*time.Second, func() bool { return s.children.running() == nil }, "子进程退出")

	state, ok := s.children.lastExit()
	if !ok {
		t.Fatal("应当记录子进程的退出状态")
	}
	if !state.normal {
		t.Errorf("退出码 0 应被记录为正常收工，实际：%s", state.describe())
	}
	if s.children.spawns() != 1 {
		t.Errorf("退出后不得自动重启，spawn 次数 %d", s.children.spawns())
	}

	// supervisor 本身必须还活着：机器常驻，退出的只有 executor 进程。
	resp, err := http.Get("http://" + s.Addr() + "/healthz")
	if err != nil {
		t.Fatalf("子进程退出后 supervisor 必须仍在服务：%v", err)
	}
	resp.Body.Close()
}

func TestSignalKilledChildIsDistinguishedFromNormalExit(t *testing.T) {
	listen := freeAddr(t)
	s := newTestSupervisor(t, config{
		childTrigger: listen,
		childCmd:     fakeCommand(t, "FAKE_LISTEN="+listen+" FAKE_SUICIDE_SIGNAL=1"),
		token:        fakeToken,
		readyTimeout: 5 * time.Second,
		readyPoll:    50 * time.Millisecond,
	})
	startSupervisor(t, s)
	defer s.shutdown()

	if _, err := s.children.spawn(s.cfg); err != nil {
		t.Fatal(err)
	}
	waitFor(t, 15*time.Second, func() bool { return s.children.running() == nil }, "被信号杀死的子进程")

	state, ok := s.children.lastExit()
	if !ok {
		t.Fatal("应当记录退出状态")
	}
	if state.normal {
		t.Errorf("被 SIGKILL 杀死不能被记成正常收工：%s", state.describe())
	}
	if state.signal == 0 {
		t.Errorf("应当记录致死的信号，实际：%s", state.describe())
	}
	if !strings.Contains(state.describe(), "信号") {
		t.Errorf("描述必须能让人一眼区分「OOM/崩溃」与「账本判定收工」：%s", state.describe())
	}
}

func TestSupervisorNeverKillsAHealthyChild(t *testing.T) {
	// 这是本 preset 唯一的致命误配：supervisor 自己判定空闲并杀掉子进程，
	// 会把下载中的批次截断。停机决策权只属于 executor 自己的账本。
	listen := freeAddr(t)
	s := newTestSupervisor(t, config{
		childTrigger: listen,
		childCmd:     fakeCommand(t, "FAKE_LISTEN="+listen),
		token:        fakeToken,
		readyTimeout: 20 * time.Second,
		readyPoll:    50 * time.Millisecond,
	})
	startSupervisor(t, s)
	defer s.shutdown()

	resp := trigger(t, s, "/internal/schedules/abc/run")
	resp.Body.Close()

	cp := s.children.running()
	if cp == nil {
		t.Fatal("触发后子进程应当存在")
	}
	pid := cp.cmd.Process.Pid

	// 等远长于任何合理的「空闲」定义；期间不发任何触发。
	time.Sleep(3 * time.Second)

	if s.children.running() == nil {
		t.Fatalf("supervisor 在空闲期杀掉了子进程 —— 停机决策权属于 executor 的账本，不属于 supervisor")
	}
	if err := syscall.Kill(pid, 0); err != nil {
		t.Fatalf("子进程 pid=%d 已不存在：%v", pid, err)
	}
	if s.children.spawns() != 1 {
		t.Errorf("空闲期不得重新 spawn，次数 %d", s.children.spawns())
	}
}

func TestShutdownForwardsSignalAndLeavesNoOrphan(t *testing.T) {
	listen := freeAddr(t)
	dir := t.TempDir()
	termMarker := filepath.Join(dir, "terminated.txt")
	s := newTestSupervisor(t, config{
		childTrigger:  listen,
		childCmd:      fakeCommand(t, "FAKE_LISTEN="+listen+" FAKE_TERM_MARKER="+termMarker),
		token:         fakeToken,
		readyTimeout:  20 * time.Second,
		readyPoll:     50 * time.Millisecond,
		shutdownGrace: 10 * time.Second,
	})
	startSupervisor(t, s)

	resp := trigger(t, s, "/internal/schedules/abc/run")
	resp.Body.Close()
	cp := s.children.running()
	if cp == nil {
		t.Fatal("触发后子进程应当存在")
	}
	pid := cp.cmd.Process.Pid

	s.shutdown()

	waitForFile(t, termMarker, 5*time.Second)
	waitFor(t, 5*time.Second, func() bool { return syscall.Kill(pid, 0) != nil }, "子进程退出，不留孤儿")

	// supervisor 自己要求停止时，日志不得把它说成「OOM 或崩溃」——那会把排查引偏。
	state, ok := s.children.lastExit()
	if !ok {
		t.Fatal("应当记录退出状态")
	}
	if !state.requested {
		t.Errorf("这次退出是 supervisor 发起的，必须被标记为 requested：%s", state.describe())
	}
	if strings.Contains(state.describe(), "OOM") {
		t.Errorf("supervisor 发起的停止不得被描述为故障：%s", state.describe())
	}
}

// ---------------------------------------------------------------------------
// 配置：fail closed
// ---------------------------------------------------------------------------

func TestConfigFailsClosedWithoutChildCommandOrToken(t *testing.T) {
	t.Setenv("SUPERVISOR_CHILD_CMD", "")
	t.Setenv("SCHEDULER_TRIGGER_TOKEN", "")
	if _, err := loadConfig(); err == nil {
		t.Fatalf("缺少 CHILD_CMD 时必须拒绝启动")
	}

	t.Setenv("SUPERVISOR_CHILD_CMD", "node pixivflow.js")
	if _, err := loadConfig(); err == nil {
		t.Fatalf("缺少 SCHEDULER_TRIGGER_TOKEN 时必须拒绝启动：没有它无法区分触发与探测")
	}

	t.Setenv("SCHEDULER_TRIGGER_TOKEN", fakeToken)
	cfg, err := loadConfig()
	if err != nil {
		t.Fatalf("配置齐全时应当能启动：%v", err)
	}
	if !strings.HasPrefix(cfg.triggerPrefix, "/") {
		t.Errorf("默认触发前缀必须是以 / 开头的路径，实际 %q", cfg.triggerPrefix)
	}
}

func TestChildGetsTheTriggerPortTheSupervisorForwardsTo(t *testing.T) {
	// 端口分工是 supervisor 的决定：子进程必须正好监听它转发的地址。
	// 否则表现为「触发一直 503」，而两边配置各自看起来都没问题。
	dir := t.TempDir()
	dump := filepath.Join(dir, "env.txt")
	listen := freeAddr(t)
	childPort := listenPort(listen)

	s := newTestSupervisor(t, config{
		listen:       "127.0.0.1:0",
		childTrigger: listen,
		childCmd:     fakeCommand(t, "FAKE_ENV_DUMP="+dump+" FAKE_LISTEN="+listen),
		token:        fakeToken,
		readyTimeout: 20 * time.Second,
		readyPoll:    50 * time.Millisecond,
	})
	t.Cleanup(s.shutdown)
	// 故意在父进程里放一个错误值，确认被子进程继承的是 supervisor 决定的值。
	t.Setenv("SCHEDULER_TRIGGER_PORT", "9999")

	if _, err := s.children.spawn(s.cfg); err != nil {
		t.Fatalf("spawn 失败：%v", err)
	}
	waitForFile(t, dump, 15*time.Second)
	raw, err := os.ReadFile(dump)
	if err != nil {
		t.Fatal(err)
	}
	want := "SCHEDULER_TRIGGER_PORT=" + childPort
	if !strings.Contains(string(raw), want) {
		t.Errorf("子进程必须收到 %s，实际环境里没有这一项", want)
	}
	if strings.Contains(string(raw), "SCHEDULER_TRIGGER_PORT=9999") {
		t.Errorf("子进程收到了父进程的错误端口值 9999")
	}
}

func TestConfigRefusesWhenBothPortsAreTheSame(t *testing.T) {
	t.Setenv("SUPERVISOR_CHILD_CMD", "node dist/index.js scheduler")
	t.Setenv("SCHEDULER_TRIGGER_TOKEN", fakeToken)
	t.Setenv("SUPERVISOR_LISTEN", "127.0.0.1:8090")
	t.Setenv("SUPERVISOR_CHILD_TRIGGER", "127.0.0.1:8090")
	if _, err := loadConfig(); err == nil {
		t.Fatalf("supervisor 与 executor 用同一个端口必须拒绝启动（否则就是谁先绑定谁赢的偶发故障）")
	}
	t.Setenv("SUPERVISOR_CHILD_TRIGGER", "127.0.0.1:8091")
	if _, err := loadConfig(); err != nil {
		t.Fatalf("端口分工正确时应当能启动：%v", err)
	}
}

func TestBearerComparisonRejectsMalformedHeaders(t *testing.T) {
	for _, header := range []string{"", fakeToken, "Bearer", "Bearer ", "Basic " + fakeToken, "bearer"} {
		if bearerMatches(header, fakeToken) {
			t.Errorf("Authorization=%q 不应通过鉴权", header)
		}
	}
	if !bearerMatches("Bearer "+fakeToken, fakeToken) {
		t.Errorf("正确的 Bearer 头必须通过")
	}
	if !bearerMatches("bearer "+fakeToken, fakeToken) {
		t.Errorf("scheme 大小写不敏感")
	}
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

func newTestSupervisor(t *testing.T, cfg config) *supervisor {
	t.Helper()
	if cfg.triggerPrefix == "" {
		cfg.triggerPrefix = defaultTriggerPrefix
	}
	if cfg.listen == "" {
		cfg.listen = "127.0.0.1:0"
	}
	logger := log.New(io.Discard, "", 0)
	return newSupervisor(cfg, logger)
}

func startSupervisor(t *testing.T, s *supervisor) {
	t.Helper()
	if err := s.listenAndServe(); err != nil {
		t.Fatalf("监听失败：%v", err)
	}
	t.Cleanup(s.shutdown)
	waitFor(t, 5*time.Second, func() bool {
		conn, err := net.DialTimeout("tcp", s.Addr(), 100*time.Millisecond)
		if err != nil {
			return false
		}
		conn.Close()
		return true
	}, "supervisor 开始服务")
}

// fakeCommand 生成一条能带上测试环境变量的子进程命令。
func fakeCommand(t *testing.T, envPairs string) string {
	t.Helper()
	parts := strings.Fields(envPairs)
	quoted := make([]string, 0, len(parts))
	for _, p := range parts {
		quoted = append(quoted, "'"+p+"'")
	}
	return "env " + strings.Join(quoted, " ") + " " + fakeExecutable
}

func trigger(t *testing.T, s *supervisor, path string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, "http://"+s.Addr()+path, strings.NewReader(`{"label":"test"}`))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+fakeToken)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("触发失败：%v", err)
	}
	return resp
}

func freeAddr(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	ln.Close()
	return addr
}

func waitFor(t *testing.T, timeout time.Duration, cond func() bool, what string) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("等待超时：%s", what)
}

func waitForFile(t *testing.T, path string, timeout time.Duration) {
	t.Helper()
	waitFor(t, timeout, func() bool {
		st, err := os.Stat(path)
		return err == nil && st.Size() >= 0
	}, "文件出现："+path)
}
