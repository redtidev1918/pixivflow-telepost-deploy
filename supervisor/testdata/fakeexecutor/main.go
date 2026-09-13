// supervisor/testdata/fakeexecutor —— 测试用的假 executor。
//
// 它不是产品代码，只用于让 supervisor 的测试跑在**真实子进程**上：真实 spawn、
// 真实退出码、真实信号、真实环境继承。用假实现替换子进程会让「白名单是否真的生效」
// 这类断言退化成自证。
package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"
)

func main() {
	// 把继承到的环境 dump 到文件，供测试断言白名单。
	if dump := os.Getenv("FAKE_ENV_DUMP"); dump != "" {
		lines := os.Environ()
		_ = os.WriteFile(dump, []byte(strings.Join(lines, "\n")+"\n"), 0o600)
	}
	if marker := os.Getenv("FAKE_SPAWN_MARKER"); marker != "" {
		f, err := os.OpenFile(marker, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
		if err == nil {
			fmt.Fprintln(f, "spawned")
			f.Close()
		}
	}

	// 模拟「被信号杀死」：自己给自己发 SIGKILL。
	if os.Getenv("FAKE_SUICIDE_SIGNAL") != "" {
		time.Sleep(150 * time.Millisecond)
		_ = syscall.Kill(syscall.Getpid(), syscall.SIGKILL)
		select {}
	}
	// 模拟异常退出码。
	if code := os.Getenv("FAKE_EXIT_CODE"); code != "" {
		n, _ := strconv.Atoi(code)
		time.Sleep(150 * time.Millisecond)
		os.Exit(n)
	}

	addr := os.Getenv("FAKE_LISTEN")
	if addr == "" {
		addr = "127.0.0.1:8091"
	}

	// SIGTERM：默认优雅退出；FAKE_IGNORE_SIGTERM 用于测试宽限期后的 SIGKILL。
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGTERM)
	if os.Getenv("FAKE_IGNORE_SIGTERM") == "" {
		go func() {
			<-stop
			if done := os.Getenv("FAKE_TERM_MARKER"); done != "" {
				_ = os.WriteFile(done, []byte("terminated\n"), 0o600)
			}
			os.Exit(0)
		}()
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/internal/schedules/", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("content-type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		_ = json.NewEncoder(w).Encode(map[string]string{
			"disposition": "accepted",
			"path":        r.URL.Path,
			"auth":        r.Header.Get("Authorization"),
		})
	})

	srv := &http.Server{Addr: addr, Handler: mux}
	if err := srv.ListenAndServe(); err != nil {
		fmt.Fprintln(os.Stderr, "fakeexecutor:", err)
		os.Exit(1)
	}
}
