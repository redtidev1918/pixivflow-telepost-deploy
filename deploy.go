// deploy — TelePost/PixivFlow 多平台一键部署工具（Go 单二进制）。
//
// 平台：Fly.io（telesubmit.fly.toml）与 Docker Compose（.env）。
// Windows / macOS / Linux 通用，静态编译，零运行时依赖。
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"
)

const (
	appVersion        = "3.4.0"
	telepostRepo      = "ghcr.io/redtidev1918/telepost"
	kitRepo           = "ghcr.io/redtidev1918/pixivflow-telepost-deploy"
	defaultFlyCfg     = "telesubmit.fly.toml"
	defaultEnv        = ".env"
	healthTimeout     = 240 * time.Second
	healthStep        = 6 * time.Second
	telepostGitURL    = "https://github.com/redtidev1918/TelePost.git"
	systemdInstallDir = "/opt/telepost"
	systemdUnitPath   = "/etc/systemd/system/telepost.service"
)

// verbose 开启时，run() 的捕获模式也会把命令输出回显到终端。
var verbose bool

// ---- 颜色 ----
type color struct{ on bool }

func (c color) wrap(code, s string) string {
	if !c.on {
		return s
	}
	return "\x1b[" + code + "m" + s + "\x1b[0m"
}

var clr = color{on: isTTY()}

func isTTY() bool {
	fi, err := os.Stdout.Stat()
	return err == nil && fi.Mode()&os.ModeCharDevice != 0
}

func okf(format string, a ...any)   { fmt.Printf(clr.wrap("1;32", "✓")+" "+format+"\n", a...) }
func infof(format string, a ...any) { fmt.Printf(clr.wrap("36", "▸")+" "+format+"\n", a...) }
func warnf(format string, a ...any) {
	fmt.Fprintf(os.Stderr, clr.wrap("33", "!")+" "+format+"\n", a...)
}
func failf(format string, a ...any) {
	fmt.Fprintf(os.Stderr, clr.wrap("1;31", "✗")+" "+format+"\n", a...)
}
func stepf(n, s string) {
	fmt.Printf("\n" + clr.wrap("1;36", "["+n+"]") + clr.wrap("1", " "+s) + "\n")
}

// ---- 日志 ----
var logFile *os.File

func setupLog() {
	dir := os.Getenv("LOG_DIR")
	if dir == "" {
		dir = filepath.Join(os.TempDir(), "deploy-logs")
	}
	_ = os.MkdirAll(dir, 0o755)
	p := filepath.Join(dir, fmt.Sprintf("deploy-%s.log", time.Now().Format("20060102-150405")))
	f, err := os.Create(p)
	if err == nil {
		logFile = f
	}
}

func logf(format string, a ...any) {
	if logFile != nil {
		fmt.Fprintf(logFile, "%s %s\n", time.Now().Format("15:04:05"), fmt.Sprintf(format, a...))
	}
}

func die(format string, a ...any) {
	failf(format, a...)
	if logFile != nil {
		fmt.Fprintf(os.Stderr, "\n完整日志见：%s\n", logFile.Name())
	}
	os.Exit(1)
}

// ---- 命令执行 ----
func run(cmd []string, echo bool) int {
	logf("$ %s", strings.Join(cmd, " "))
	c := exec.Command(cmd[0], cmd[1:]...)
	c.Stdin = os.Stdin
	if echo {
		c.Stdout = os.Stdout
		c.Stderr = os.Stderr
		code := 1
		if err := c.Run(); err != nil {
			if ee, ok := err.(*exec.ExitError); ok {
				code = ee.ExitCode()
			}
		} else {
			code = 0
		}
		logf("(exit %d)", code)
		return code
	}
	out, err := c.CombinedOutput()
	if logFile != nil {
		logFile.Write(out)
	}
	if verbose {
		os.Stdout.Write(out)
	}
	if err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			return ee.ExitCode()
		}
		return 1
	}
	return 0
}

func have(exe string) bool { _, err := exec.LookPath(exe); return err == nil }

func flyBin() string {
	for _, c := range []string{"flyctl", "fly"} {
		if have(c) {
			return c
		}
	}
	return ""
}

// ---- 工作目录 ----
// deploy 是发布到 PATH 里的单二进制：若当前目录不是仓库（没有 compose/toml
// 等标记文件），先沿 cwd 向上找，再回退到可执行文件所在目录，让用户在任何
// 位置运行都能定位配置。
func enterRepoDir() {
	candidates := []string{"docker-compose.yml", "compose.yaml", defaultFlyCfg, defaultEnv}
	isRepo := func(dir string) bool {
		for _, f := range candidates {
			if _, err := os.Stat(filepath.Join(dir, f)); err == nil {
				return true
			}
		}
		return false
	}
	if isRepo(".") {
		return
	}
	// 沿当前目录向上（最多 8 层，覆盖在仓库子目录里运行的情况）
	wd, err := os.Getwd()
	if err == nil {
		for depth, dir := 0, wd; depth < 8; depth++ {
			parent := filepath.Dir(dir)
			if parent == dir {
				break
			}
			dir = parent
			if isRepo(dir) {
				_ = os.Chdir(dir)
				return
			}
		}
	}
	// 可执行文件所在目录（例如把二进制放在仓库根目录、从任意 cwd 调用）
	exe, err := os.Executable()
	if err == nil {
		dir := filepath.Dir(exe)
		if isRepo(dir) {
			_ = os.Chdir(dir)
			return
		}
	}
	// 保持当前目录；detectPlatform 会给出“无法自动检测平台”的提示
}

// ---- 平台检测 ----
func detectPlatform(platform, config string) string {
	if platform != "auto" {
		return platform
	}
	fb := flyBin()
	if fb != "" {
		if _, err := os.Stat(defaultFlyCfg); err == nil {
			if run([]string{fb, "auth", "whoami"}, false) == 0 {
				return "fly"
			}
		}
	}
	for _, f := range []string{"docker-compose.yml", "compose.yaml"} {
		if _, err := os.Stat(f); err == nil {
			return "compose"
		}
	}
	// systemd 是 Linux 裸机的兜底：有 systemctl 即视为 systemd（不含 systemd 的
	// 容器/最小系统仍走 docker/compose）。
	if runtime.GOOS == "linux" && have("systemctl") {
		return "systemd"
	}
	return "" // 未检测到；调用方决定是报错还是兜底（如 version）
}

func configFor(platform, config string) string {
	if config != "" {
		return config
	}
	switch platform {
	case "fly":
		return defaultFlyCfg
	case "systemd":
		return filepath.Join(systemdInstallDir, ".env")
	default:
		return defaultEnv
	}
}

// ---- toml / env 文本读写 ----
var tomlKV = regexp.MustCompile(`^([ \t]*)([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*"([^"]*)"[ \t]*$`)
var envKV = regexp.MustCompile(`^([A-Za-z_][A-Za-z0-9_]*)=(.*)$`)

func readLines(path string) []string {
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()
	var lines []string
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1024*1024), 1024*1024)
	for sc.Scan() {
		lines = append(lines, sc.Text())
	}
	return lines
}

func tomlGet(path, key string) string {
	for _, line := range readLines(path) {
		m := tomlKV.FindStringSubmatch(line)
		if m != nil && m[2] == key {
			return m[3]
		}
	}
	return ""
}

func tomlSet(path, key, val string) {
	lines := readLines(path)
	found := false
	for i, line := range lines {
		m := tomlKV.FindStringSubmatch(line)
		if m != nil && m[2] == key {
			lines[i] = m[1] + key + ` = "` + val + `"`
			found = true
		}
	}
	if !found {
		die("%s 里没有键 %s", path, key)
	}
	writeLines(path, lines)
}

func envGet(path, key string) string {
	for _, line := range readLines(path) {
		m := envKV.FindStringSubmatch(line)
		if m != nil && m[1] == key {
			return strings.TrimSpace(m[2])
		}
	}
	return ""
}

func envSet(path, key, val string) {
	lines := readLines(path)
	found := false
	for i, line := range lines {
		m := envKV.FindStringSubmatch(line)
		if m != nil && m[1] == key {
			lines[i] = key + "=" + val
			found = true
		}
	}
	if !found {
		lines = append(lines, key+"="+val)
	}
	writeLines(path, lines)
}

func writeLines(path string, lines []string) {
	f, err := os.Create(path)
	if err != nil {
		die("无法写入 %s: %v", path, err)
	}
	defer f.Close()
	for _, l := range lines {
		fmt.Fprintln(f, l)
	}
}

// ---- 版本读取 ----
var composeArgRe = regexp.MustCompile(`\$\{[A-Za-z_]+:-([^}\s]+)\}`)

func composeDefaultArg(key string) string {
	for _, name := range []string{"docker-compose.yml", "compose.yaml"} {
		for _, line := range readLines(name) {
			if strings.Contains(line, key) && strings.Contains(line, "${") {
				if m := composeArgRe.FindStringSubmatch(line); m != nil {
					return m[1]
				}
			}
		}
	}
	return ""
}

func tpVersion(platform, cfg string) string {
	if platform == "fly" {
		v := tomlGet(cfg, "TELEPOST_IMAGE")
		if i := strings.LastIndex(v, ":"); i >= 0 {
			return v[i+1:]
		}
		return v
	}
	if platform == "systemd" {
		// 源码部署：读 git describe（无 git 目录则显示 git）
		if have("git") {
			if out, err := exec.Command("git", "-C", systemdInstallDir, "describe", "--tags", "--always").Output(); err == nil {
				return strings.TrimSpace(string(out))
			}
		}
		return "git"
	}
	v := envGet(cfg, "STACK_IMAGE")
	if v == "" {
		v = composeDefaultArg("STACK_IMAGE")
	}
	if v == "" {
		v = kitRepo + ":latest"
	}
	if i := strings.LastIndex(v, ":"); i >= 0 {
		return v[i+1:]
	}
	return v
}

func pfVersion(platform, cfg string) string {
	if platform == "fly" {
		if v := tomlGet(cfg, "PIXIVFLOW_VERSION"); v != "" {
			return v
		}
		return "?"
	}
	if platform == "systemd" {
		return pixivflowVersion() // 全局 npm 包的 pixivflow 版本
	}
	if v := envGet(cfg, "PIXIVFLOW_VERSION"); v != "" {
		return v
	}
	if v := composeDefaultArg("PIXIVFLOW_VERSION"); v != "" {
		return v
	}
	return "?"
}

// pixivflowVersion 返回全局 pixivflow CLI 的版本；未安装则返回 "未安装"。
func pixivflowVersion() string {
	if have("pixivflow") {
		if out, err := exec.Command("pixivflow", "--version").Output(); err == nil {
			return strings.TrimSpace(string(out))
		}
	}
	return "未安装"
}

// ---- 健康检查 ----
func healthURL(platform, cfg string) string {
	if platform == "fly" {
		return "https://" + tomlGet(cfg, "app") + ".fly.dev/health"
	}
	return "http://127.0.0.1:8080/health"
}

func fetchHealth(url string, timeout time.Duration) map[string]any {
	c := &http.Client{Timeout: timeout}
	resp, err := c.Get(url)
	if err != nil {
		return nil
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil
	}
	var m map[string]any
	if json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&m) != nil {
		return nil
	}
	return m
}

// ---- 子命令 ----
func cmdDoctor(platform, cfg string) {
	stepf("1/3", "平台")
	okf("使用平台：%s", platform)

	if platform == "systemd" {
		systemdDoctor()
		stepf("3/3", "当前版本")
		okf("TelePost : %s", tpVersion(platform, cfg))
		okf("PixivFlow: %s", pfVersion(platform, cfg))
		return
	}

	stepf("2/3", "依赖与环境")
	problems := 0
	if platform == "fly" {
		fb := flyBin()
		if fb != "" {
			okf("%s 可用", fb)
		} else {
			failf("缺 flyctl/fly")
			problems++
		}
		if _, err := os.Stat(cfg); err == nil {
			okf("%s 存在", cfg)
		} else {
			failf("%s 不存在", cfg)
			problems++
		}
		if app := tomlGet(cfg, "app"); app != "" {
			okf("app = %s", app)
		} else {
			failf("无法解析 app")
			problems++
		}
		if fb != "" {
			if run([]string{fb, "auth", "whoami"}, false) == 0 {
				okf("fly 已登录")
			} else {
				failf("fly 未登录（运行 %s auth login）", fb)
				problems++
			}
		}
	} else {
		if have("docker") {
			okf("docker 可用")
		} else {
			failf("缺 docker")
			problems++
		}
		if run([]string{"docker", "compose", "version"}, false) == 0 {
			okf("docker compose 可用")
		} else {
			failf("缺 docker compose v2")
			problems++
		}
		if run([]string{"docker", "info"}, false) == 0 {
			okf("docker daemon 运行中")
		} else {
			warnf("docker daemon 未运行（部署前需启动）")
			problems++
		}
		if _, err := os.Stat(cfg); err == nil {
			okf("%s 存在", cfg)
		} else {
			warnf("%s 不存在（将用 compose 默认值）", cfg)
		}
	}

	stepf("3/3", "当前版本")
	okf("TelePost/套件 : %s", tpVersion(platform, cfg))
	okf("PixivFlow    : %s", pfVersion(platform, cfg))
	if problems > 0 {
		die("自检存在 %d 个未满足项", problems)
	}
	okf("自检通过")
}

func cmdVersion(platform, cfg string) {
	fmt.Printf(clr.wrap("1", "deploy v"+appVersion) + "\n")
	fmt.Printf("  platform      : %s\n", platform)
	fmt.Printf("  TelePost/套件 : %s\n", tpVersion(platform, cfg))
	fmt.Printf("  PixivFlow     : %s\n", pfVersion(platform, cfg))
}

func cmdStatus(platform, cfg string) {
	if platform == "fly" {
		fb := flyBin()
		if fb == "" {
			die("未找到 flyctl/fly")
		}
		infof("app = %s", tomlGet(cfg, "app"))
		run([]string{fb, "status", "-a", tomlGet(cfg, "app")}, true)
	} else if platform == "systemd" {
		systemdStatus()
		return
	} else {
		run([]string{"docker", "compose", "ps"}, true)
	}
	fmt.Println()
	infof("健康端点：")
	if h := fetchHealth(healthURL(platform, cfg), 15*time.Second); h != nil {
		b, _ := json.MarshalIndent(h, "", "  ")
		fmt.Println(string(b))
	} else {
		warnf("%s 不可达", healthURL(platform, cfg))
	}
}

func cmdLogs(platform, cfg string, n int) {
	if n <= 0 {
		n = 100
	}
	if platform == "systemd" {
		systemdLogs(n)
		return
	}
	var out []byte
	if platform == "fly" {
		fb := flyBin()
		if fb == "" {
			die("未找到 flyctl/fly")
		}
		c := exec.Command(fb, "logs", "-a", tomlGet(cfg, "app"), "--no-tail")
		out, _ = c.Output()
	} else {
		c := exec.Command("docker", "compose", "logs", "--tail", fmt.Sprint(n), "stack")
		out, _ = c.Output()
	}
	lines := strings.Split(strings.TrimRight(string(out), "\n"), "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	fmt.Println(strings.Join(lines, "\n"))
}

func cmdUpgrade(platform, cfg, kind, target string, dryRun bool) {
	if target == "" {
		die("缺少版本参数（用法：deploy %s <版本|latest>）", kind)
	}
	if platform == "systemd" {
		cur := tpVersion(platform, cfg)
		if dryRun {
			infof("[dry-run] 将 %s 从 %s 升级到 %s（git pull + pip + restart）", kind, cur, target)
			return
		}
		systemdUpgrade(kind, target, dryRun)
		return
	}
	cur := tpVersion(platform, cfg)
	if kind == "pf" {
		cur = pfVersion(platform, cfg)
	}
	if dryRun {
		infof("[dry-run] 将 %s 从 %s 升级到 %s（不写配置）", kind, cur, target)
		return
	}
	if platform == "fly" {
		if kind == "tp" {
			tomlSet(cfg, "TELEPOST_IMAGE", telepostRepo+":"+target)
			infof("TelePost: %s → %s", cur, target)
		} else {
			tomlSet(cfg, "PIXIVFLOW_VERSION", target)
			infof("PixivFlow: %s → %s", cur, target)
		}
	} else {
		if kind == "tp" {
			envSet(cfg, "STACK_IMAGE", kitRepo+":"+target)
			infof("部署套件(含 TelePost): %s → %s", cur, target)
		} else {
			envSet(cfg, "PIXIVFLOW_VERSION", target)
			infof("PixivFlow: %s → %s（仅 --build 本地构建生效）", cur, target)
		}
	}
}

// ---- systemd 后端（Linux 裸机直跑 TelePost）----

const systemdUnitTemplate = `[Unit]
Description=TelePost Telegram Bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=%s
EnvironmentFile=%s
ExecStart=%s/.venv/bin/python run.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
`

func sudoCmd() []string {
	if os.Geteuid() == 0 {
		return nil
	}
	return []string{"sudo"}
}

func systemdRun(args []string, echo bool) int {
	return run(append(sudoCmd(), args...), echo)
}

func prompt(label string) string {
	fmt.Printf("  %s: ", label)
	sc := bufio.NewScanner(os.Stdin)
	if sc.Scan() {
		return strings.TrimSpace(sc.Text())
	}
	return ""
}

func systemdEnsureEnv(cfg string, dryRun bool) {
	// 组合部署走多 bot 模式（BOT1_TOKEN），supervisor 才能同时托管 PixivFlow。
	if envGet(cfg, "BOT1_TOKEN") != "" && envGet(cfg, "BOT1_CHANNEL_ID") != "" {
		return
	}
	if dryRun {
		infof("[dry-run] 将引导填写 %s 的 BOT1_TOKEN / BOT1_CHANNEL_ID", cfg)
		return
	}
	infof("首次部署需要填写最小配置（写入 %s）：", cfg)
	bot1Token := envGet(cfg, "BOT1_TOKEN")
	if bot1Token == "" {
		bot1Token = prompt("BOT1_TOKEN（BotFather 获取）")
	}
	bot1Channel := envGet(cfg, "BOT1_CHANNEL_ID")
	if bot1Channel == "" {
		bot1Channel = prompt("BOT1_CHANNEL_ID（@频道 或 -100 数字 ID）")
	}
	if bot1Token == "" || bot1Channel == "" {
		die("BOT1_TOKEN 与 BOT1_CHANNEL_ID 均为必填")
	}
	envSet(cfg, "BOT1_TOKEN", bot1Token)
	envSet(cfg, "BOT1_CHANNEL_ID", bot1Channel)
	if envGet(cfg, "RUN_MODE") == "" {
		envSet(cfg, "RUN_MODE", "POLLING")
	}
	if envGet(cfg, "PIXIVFLOW_ENABLED") == "" {
		if strings.EqualFold(prompt("启用 PixivFlow 自动投稿？(y/N)"), "y") {
			envSet(cfg, "PIXIVFLOW_ENABLED", "true")
			envSet(cfg, "PIXIVFLOW_COMMAND", "pixivflow scheduler")
			envSet(cfg, "PIXIVFLOW_CONFIG", filepath.Join(systemdInstallDir, "data", "pixivflow", "config.json"))
		} else {
			envSet(cfg, "PIXIVFLOW_ENABLED", "false")
		}
	}
}

func systemdDoctor() {
	problems := 0
	for _, exe := range []string{"systemctl", "python3", "git"} {
		if have(exe) {
			okf("%s 可用", exe)
		} else {
			failf("缺 %s", exe)
			problems++
		}
	}
	if os.Geteuid() != 0 && !have("sudo") {
		failf("非 root 且无 sudo（写 systemd unit 需要权限）")
		problems++
	} else {
		okf("具备写入 systemd 的权限")
	}
	if _, err := os.Stat(systemdInstallDir); err == nil {
		okf("%s 已存在", systemdInstallDir)
	} else {
		infof("%s 不存在（首次部署将 clone）", systemdInstallDir)
	}
	if problems > 0 {
		die("自检存在 %d 个未满足项", problems)
	}
	okf("systemd 自检通过")
}

func systemdInstall(cfg string, dryRun bool) {
	stepf("1/5", "获取 TelePost 源码")
	if _, err := os.Stat(systemdInstallDir); err == nil {
		infof("%s 已存在，git pull 更新", systemdInstallDir)
		if !dryRun {
			systemdRun([]string{"git", "-C", systemdInstallDir, "pull", "--ff-only"}, true)
		}
	} else {
		infof("git clone 到 %s", systemdInstallDir)
		if !dryRun {
			systemdRun([]string{"git", "clone", "--depth", "1", telepostGitURL, systemdInstallDir}, true)
		}
	}

	stepf("2/5", "安装 Python 依赖（venv + pip）")
	if !dryRun {
		if _, err := os.Stat(filepath.Join(systemdInstallDir, ".venv")); err != nil {
			if systemdRun([]string{"python3", "-m", "venv", filepath.Join(systemdInstallDir, ".venv")}, true) != 0 {
				infof("venv 创建失败，尝试安装 python3-venv …")
				systemdRun([]string{"apt-get", "install", "-y", "python3-venv"}, true)
				if systemdRun([]string{"python3", "-m", "venv", filepath.Join(systemdInstallDir, ".venv")}, true) != 0 {
					die("无法创建 venv，请手动安装 python3-venv")
				}
			}
		}
		systemdRun([]string{filepath.Join(systemdInstallDir, ".venv", "bin", "pip"), "install", "-r",
			filepath.Join(systemdInstallDir, "requirements.txt")}, true)
	} else {
		infof("[dry-run] python3 -m venv + pip install -r requirements.txt")
	}

	stepf("3/5", "安装 PixivFlow（Node + npm，组合单机省钱形态）")
	systemdInstallPixivflow(cfg, dryRun)

	stepf("4/5", "配置")
	systemdEnsureEnv(cfg, dryRun)
	unit := fmt.Sprintf(systemdUnitTemplate, systemdInstallDir, cfg, systemdInstallDir)
	if !dryRun {
		writeLines(systemdUnitPath, strings.Split(strings.TrimRight(unit, "\n"), "\n"))
		infof("已写入 %s", systemdUnitPath)
	} else {
		infof("[dry-run] 将写入 %s", systemdUnitPath)
	}

	stepf("5/5", "启动服务")
	if !dryRun {
		systemdRun([]string{"systemctl", "daemon-reload"}, true)
		systemdRun([]string{"systemctl", "enable", "--now", "telepost"}, true)
	} else {
		infof("[dry-run] systemctl daemon-reload && enable --now telepost")
	}
}

// systemdInstallPixivflow 安装 Node 运行时与 pixivflow CLI（可选，缺 Node 22+ 时提示）。
func systemdInstallPixivflow(cfg string, dryRun bool) {
	enabled := envGet(cfg, "PIXIVFLOW_ENABLED") == "true"
	if !enabled && !dryRun {
		// 未启用自动投稿时跳过，但仍检查 node 供后续 pf 升级使用
		if !have("node") {
			infof("未启用 PixivFlow 且无 node，跳过（如需自动投稿，先装 Node 22+ 再 deploy）")
		}
		return
	}
	if dryRun {
		infof("[dry-run] 检测 node>=22 → npm install -g pixivflow@latest")
		return
	}
	if !have("node") || !have("npm") {
		die("缺少 node/npm：PixivFlow 需要 Node 22+。建议：\n" +
			"  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash - && sudo apt-get install -y nodejs\n" +
			"装好后重新运行 deploy")
	}
	// 版本检查：PixivFlow 需要 Node 22.12+
	if out, err := exec.Command("node", "--version").Output(); err == nil {
		v := strings.TrimSpace(strings.TrimPrefix(string(out), "v"))
		if major := v; major != "" && major < "22" {
			warnf("node 版本 %s 偏低，PixivFlow 建议 Node 22.12+", v)
		}
	}
	if systemdRun([]string{"npm", "install", "-g", "pixivflow@latest"}, true) != 0 {
		die("npm install -g pixivflow 失败")
	}
	okf("PixivFlow CLI 已安装")
}

func systemdUpgrade(kind, target string, dryRun bool) {
	if kind == "pf" {
		if dryRun {
			infof("[dry-run] npm install -g pixivflow@latest + systemctl restart telepost")
			return
		}
		if !have("npm") {
			die("缺少 npm：先安装 Node 22+ 再升级 PixivFlow")
		}
		systemdRun([]string{"npm", "install", "-g", "pixivflow@latest"}, true)
		systemdRun([]string{"systemctl", "restart", "telepost"}, true)
		return
	}
	if dryRun {
		infof("[dry-run] git pull + pip install + systemctl restart telepost")
		return
	}
	systemdRun([]string{"git", "-C", systemdInstallDir, "pull", "--ff-only"}, true)
	systemdRun([]string{filepath.Join(systemdInstallDir, ".venv", "bin", "pip"), "install", "-r",
		filepath.Join(systemdInstallDir, "requirements.txt")}, true)
	systemdRun([]string{"systemctl", "restart", "telepost"}, true)
}

func systemdStatus() {
	systemdRun([]string{"systemctl", "status", "telepost", "--no-pager"}, true)
	fmt.Println()
	infof("健康端点：")
	if h := fetchHealth("http://127.0.0.1:8080/health", 15*time.Second); h != nil {
		b, _ := json.MarshalIndent(h, "", "  ")
		fmt.Println(string(b))
	} else {
		warnf("http://127.0.0.1:8080/health 不可达（服务可能未启动或端口不同）")
	}
}

func systemdLogs(n int) {
	args := []string{"journalctl", "-u", "telepost", "-n", fmt.Sprint(n), "--no-pager"}
	run(args, true)
}

func showHealth(url string) {
	if h := fetchHealth(url, 10*time.Second); h != nil {
		if s, ok := h["status"].(string); ok {
			fmt.Printf("  status       : %s\n", s)
		}
		if v, ok := h["system_available_mb"].(float64); ok {
			fmt.Printf("  可用内存(MB)  : %.1f\n", v)
		}
	}
}

func cmdDeploy(platform, cfg string, dryRun, build bool, retries int) {
	if platform == "systemd" {
		systemdInstall(cfg, dryRun)
		// 健康检查
		stepf("健康检查", "http://127.0.0.1:8080/health")
		if dryRun {
			return
		}
		deadline := time.Now().Add(healthTimeout)
		for time.Now().Before(deadline) {
			if fetchHealth("http://127.0.0.1:8080/health", 10*time.Second) != nil {
				okf("健康检查通过")
				return
			}
			time.Sleep(healthStep)
		}
		die("健康检查超时（%v）。查看 journalctl -u telepost", healthTimeout)
		return
	}

	stepf("1/3", "部署前检查")
	if platform == "fly" {
		fb := flyBin()
		if fb == "" {
			die("未找到 flyctl/fly")
		}
		if run([]string{fb, "auth", "whoami"}, false) != 0 {
			die("fly 未登录")
		}
		infof("平台=fly  app=%s", tomlGet(cfg, "app"))
		infof("TelePost=%s:%s  PixivFlow=%s", telepostRepo, tpVersion(platform, cfg), pfVersion(platform, cfg))
	} else {
		if !have("docker") {
			die("未找到 docker")
		}
		if run([]string{"docker", "info"}, false) != 0 {
			die("docker daemon 未运行")
		}
		infof("平台=compose  TelePost/套件=%s  PixivFlow=%s", tpVersion(platform, cfg), pfVersion(platform, cfg))
	}

	stepf("2/3", "执行部署")
	if dryRun {
		if platform == "fly" {
			fmt.Printf("[dry-run] %s deploy -c %s --remote-only --strategy rolling\n", flyBin(), cfg)
		} else if build {
			fmt.Println("[dry-run] docker compose build stack && docker compose up -d stack")
		} else {
			fmt.Println("[dry-run] docker compose pull stack && docker compose up -d stack")
		}
		return
	}

	for attempt := 1; attempt <= retries+1; attempt++ {
		infof("尝试 %d/%d", attempt, retries+1)
		rc := 0
		if platform == "fly" {
			rc = run([]string{flyBin(), "deploy", "-c", cfg, "--remote-only", "--strategy", "rolling"}, true)
		} else if build {
			rc = run([]string{"docker", "compose", "build", "stack"}, true)
			if rc == 0 {
				rc = run([]string{"docker", "compose", "up", "-d", "stack"}, true)
			}
		} else {
			rc = run([]string{"docker", "compose", "pull", "stack"}, true)
			if rc == 0 {
				rc = run([]string{"docker", "compose", "up", "-d", "stack"}, true)
			}
		}
		if rc == 0 {
			okf("部署命令成功")
			break
		}
		failf("部署失败（尝试 %d）", attempt)
		if attempt <= retries {
			warnf("15s 后重试...")
			time.Sleep(15 * time.Second)
		} else {
			die("部署多次失败")
		}
	}

	stepf("3/3", "等待健康检查")
	url := healthURL(platform, cfg)
	deadline := time.Now().Add(healthTimeout)
	waited := 0
	for time.Now().Before(deadline) {
		if fetchHealth(url, 10*time.Second) != nil {
			okf("健康检查通过")
			break
		}
		waited += int(healthStep / time.Second)
		fmt.Printf("  ... 等待中（%ds）\r", waited)
		time.Sleep(healthStep)
	}
	fmt.Println()
	if fetchHealth(url, 10*time.Second) == nil {
		die("健康检查超时（%v）", healthTimeout)
	}
	infof("结果：")
	showHealth(url)
	okf("部署完成 ✅")
}

// ---- 用法 ----
func usage() {
	fmt.Print(`deploy — TelePost/PixivFlow 多平台一键部署（Go 单二进制）

可在任意目录运行：自动定位仓库配置（当前目录 → 上级目录 → 可执行文件所在目录）。

用法：
  deploy [--platform fly|compose|systemd|auto] [全局选项] <子命令> [参数]

子命令：
  init [目录]        全新部署：从内嵌模板生成目录并引导填写 Bot 信息（默认当前目录）
  deploy            部署当前配置（保持现有版本）
  tp <版本|latest>  升级并部署（fly: TelePost 镜像 tag；compose: 部署套件 tag）
  pf <版本>         升级 PixivFlow 并部署
  status            状态 / 健康
  logs [行数]       最近日志
  doctor            环境自检
  version           显示工具与当前配置版本

全局选项：
  --platform fly|compose|systemd|auto
                                部署平台（默认 auto 自动检测）
  --config FILE                配置文件（fly: toml；compose: env）
  --dry-run                    只预览、不改配置
  --verbose                    回显命令完整输出
  --no-color                   禁用彩色
  --retries N                  部署失败重试次数（默认 2）
  --build                      compose：本地构建
  --force                      init：目标目录已有配置时强制重新生成
`)
	os.Exit(0)
}

// ---- 参数解析 ----
type opts struct {
	platform string
	config   string
	dryRun   bool
	verbose  bool
	noColor  bool
	retries  int
	build    bool
	force    bool
	cmd      string
	arg      string
}

func parseArgs(args []string) opts {
	o := opts{platform: "auto", retries: 2}
	i := 0
	for i < len(args) {
		a := args[i]
		switch {
		case a == "--platform" || a == "-p":
			i++
			o.platform = args[i]
		case a == "--config" || a == "-c":
			i++
			o.config = args[i]
		case a == "--dry-run":
			o.dryRun = true
		case a == "--verbose" || a == "-v":
			o.verbose = true
		case a == "--no-color":
			o.noColor = true
		case a == "--retries":
			i++
			o.retries, _ = atoi(args[i])
		case a == "--build":
			o.build = true
		case a == "--force":
			o.force = true
		case a == "-h" || a == "--help" || a == "help":
			usage()
		case strings.HasPrefix(a, "-"):
			fmt.Fprintf(os.Stderr, "未知选项：%s\n\n", a)
			usage()
		default:
			o.cmd = a
			if i+1 < len(args) && !strings.HasPrefix(args[i+1], "-") {
				o.arg = args[i+1]
				i++
			}
		}
		i++
	}
	return o
}

func atoi(s string) (int, bool) {
	var n int
	if _, err := fmt.Sscanf(s, "%d", &n); err != nil {
		return 0, false
	}
	return n, true
}

func main() {
	setupLog()
	defer func() {
		if logFile != nil {
			logFile.Close()
		}
	}()

	o := parseArgs(os.Args[1:])
	verbose = o.verbose
	if o.noColor || !isTTY() {
		clr.on = false
	}
	if o.cmd == "" {
		usage()
	}
	// init 不需要任何现成配置/平台：在任何地方就地生成全新部署目录。
	if o.cmd == "init" {
		cmdInit(o.arg, o.force)
		return
	}
	// 允许在任意目录运行：cwd 不是仓库时回退到可执行文件所在目录。
	enterRepoDir()

	logf("invoke: platform=%s cmd=%s arg=%s", o.platform, o.cmd, o.arg)
	platform := detectPlatform(o.platform, o.config)
	if platform == "" {
		if o.cmd == "version" {
			platform = "fly" // version 仅展示版本，任意目录可用
		} else {
			die("无法自动检测部署平台，用 --platform fly|compose|systemd 指定")
		}
	}
	cfg := configFor(platform, o.config)

	switch o.cmd {
	case "deploy":
		cmdDeploy(platform, cfg, o.dryRun, o.build, o.retries)
	case "tp", "pf":
		cmdUpgrade(platform, cfg, o.cmd, o.arg, o.dryRun)
		cmdDeploy(platform, cfg, o.dryRun, o.build, o.retries)
	case "status":
		cmdStatus(platform, cfg)
	case "logs":
		n, _ := atoi(o.arg)
		cmdLogs(platform, cfg, n)
	case "doctor":
		cmdDoctor(platform, cfg)
	case "version":
		cmdVersion(platform, cfg)
	default:
		failf("未知子命令：%s", o.cmd)
		usage()
	}
	logf("exit 0")
}
