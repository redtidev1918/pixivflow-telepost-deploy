package main

// supervisor/server.go —— 触发入站：鉴权、按需拉起、原样转发。
//
// 路径与鉴权契约与 split-worker 下执行端自己暴露的触发接口**完全一致**
// （POST /internal/schedules/{scheduleId}/run + Authorization: Bearer <token>），
// 所以从 split-worker 迁到本 preset 时，时钟侧一行都不用改。

import (
	"context"
	"crypto/subtle"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"strings"
	"time"
)

// forwardTimeout：转发给 executor 的超时。触发是 accept-then-background 语义
// （落库即应答，下载在后台跑 10–40 分钟），所以这里只需要覆盖「子进程回应」的时间。
const forwardTimeout = 30 * time.Second

type supervisor struct {
	cfg      config
	logger   *log.Logger
	children *spawner
	server   *http.Server
	listener net.Listener
	addr     string
}

func newSupervisor(cfg config, logger *log.Logger) *supervisor {
	if logger == nil {
		logger = log.Default()
	}
	s := &supervisor{cfg: cfg, logger: logger, children: newSpawner(logger)}
	mux := http.NewServeMux()
	mux.HandleFunc("/", s.handle)
	s.server = &http.Server{
		Handler: mux,
		// 触发是短请求，超时防止慢连接把常驻进程拖住。
		ReadHeaderTimeout: 10 * time.Second,
		WriteTimeout:      forwardTimeout + 10*time.Second,
	}
	return s
}

// listenAndServe 绑定端口并开始在后台服务。它不阻塞：调用方（main）自己等停止信号。
// 测试传 127.0.0.1:0 拿一个随机端口。
func (s *supervisor) listenAndServe() error {
	ln, err := net.Listen("tcp", s.cfg.listen)
	if err != nil {
		return err
	}
	s.listener = ln
	s.addr = ln.Addr().String()
	go func() {
		if err := s.server.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			s.logger.Printf("supervisor: HTTP 服务退出：%v", err)
		}
	}()
	return nil
}

func (s *supervisor) Addr() string { return s.addr }

// shutdown 停服并处理子进程。子进程的停止只在这里发生：supervisor 自己要走。
func (s *supervisor) shutdown() {
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = s.server.Shutdown(shutdownCtx)
	s.children.terminate(s.cfg.shutdownGrace)
}

func (s *supervisor) handle(w http.ResponseWriter, r *http.Request) {
	// 1) supervisor 自己的存活端点。它永不触发任何东西。
	//    注意：这**不是** executor 的健康检查——指向触发端口的检查是被禁止的，
	//    因为它会把刚退出的子进程重新拉起来。
	if r.URL.Path == "/healthz" {
		w.Header().Set("content-type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, `{"status":"supervisor-alive","executor":"on-demand"}`+"\n")
		return
	}

	// 2) 只接管触发路径；其余路径 404，不碰子进程。
	if !strings.HasPrefix(r.URL.Path, s.cfg.triggerPrefix) {
		http.NotFound(w, r)
		return
	}

	// 3) 只注册 POST。用 GET 探测会得到 404 而不是 401——这样「鉴权生效」不会被掩盖，
	//    也不会因为一次探测就把子进程拉起来。这条与执行端的契约一致。
	if r.Method != http.MethodPost {
		http.NotFound(w, r)
		return
	}

	// 4) 鉴权。没有令牌一律不进 spawn 路径。
	if s.cfg.token == "" {
		// fail closed：无法区分触发与探测时，什么都不做。
		s.logger.Printf("supervisor: 未配置 SCHEDULER_TRIGGER_TOKEN，拒绝处理触发")
		http.Error(w, `{"error":"trigger token not configured"}`, http.StatusServiceUnavailable)
		return
	}
	if !bearerMatches(r.Header.Get("Authorization"), s.cfg.token) {
		s.logger.Printf("supervisor: 触发鉴权失败，未拉起任何进程（路径 %s 方法 %s）", r.URL.Path, r.Method)
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return
	}

	// 5) 通过鉴权 = 真的有人要跑任务：按需拉起 executor，等它就绪，再原样转发。
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		http.Error(w, `{"error":"cannot read trigger body"}`, http.StatusBadRequest)
		return
	}

	if _, err := s.children.spawn(s.cfg); err != nil {
		s.logger.Printf("supervisor: %v", err)
		http.Error(w, `{"error":"executor could not be started"}`, http.StatusServiceUnavailable)
		return
	}
	if err := waitReady(r.Context(), s.cfg.childTrigger, s.cfg.readyTimeout, s.cfg.readyPoll); err != nil {
		s.logger.Printf("supervisor: %v", err)
		http.Error(w, `{"error":"executor did not become ready"}`, http.StatusServiceUnavailable)
		return
	}

	s.forward(w, r, body)
}

// forward 把触发请求原样转给 executor：同一路径、同一方法、同一 Authorization。
// 子进程仍会自己校验一次令牌（纵深防御），并由它回答 404 / 幂等 / already_completed。
func (s *supervisor) forward(w http.ResponseWriter, r *http.Request, body []byte) {
	target := "http://" + s.cfg.childTrigger + r.URL.RequestURI()
	req, err := http.NewRequestWithContext(r.Context(), r.Method, target, strings.NewReader(string(body)))
	if err != nil {
		http.Error(w, `{"error":"cannot build child request"}`, http.StatusInternalServerError)
		return
	}
	for key, values := range r.Header {
		if isHopByHop(key) {
			continue
		}
		for _, v := range values {
			req.Header.Add(key, v)
		}
	}

	client := &http.Client{Timeout: forwardTimeout}
	resp, err := client.Do(req)
	if err != nil {
		s.logger.Printf("supervisor: 转发触发到 executor 失败：%v", err)
		http.Error(w, `{"error":"executor unreachable"}`, http.StatusServiceUnavailable)
		return
	}
	defer resp.Body.Close()

	for key, values := range resp.Header {
		if isHopByHop(key) {
			continue
		}
		for _, v := range values {
			w.Header().Add(key, v)
		}
	}
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, resp.Body)
}

func isHopByHop(key string) bool {
	switch strings.ToLower(key) {
	case "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
		"te", "trailer", "transfer-encoding", "upgrade":
		return true
	}
	return false
}

// bearerMatches 常量时间比较，避免用响应时间泄漏令牌前缀。
func bearerMatches(header, token string) bool {
	const prefix = "Bearer "
	if len(header) <= len(prefix) || !strings.EqualFold(header[:len(prefix)], prefix) {
		return false
	}
	got := strings.TrimSpace(header[len(prefix):])
	return subtle.ConstantTimeCompare([]byte(got), []byte(token)) == 1
}

// dialTimeout 只做一次带超时的 TCP 连接，用于就绪探测。
func dialTimeout(addr string, timeout time.Duration) (net.Conn, error) {
	if timeout <= 0 {
		timeout = 250 * time.Millisecond
	}
	return net.DialTimeout("tcp", addr, timeout)
}
