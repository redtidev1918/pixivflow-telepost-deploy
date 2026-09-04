// deploy init — 傻瓜式一键初始化：从二进制内嵌的模板就地生成一个全新部署目录。
//
// 用户只需要：下载一个 deploy 二进制 → 运行 deploy init → 按向导填 Bot 信息 →
// deploy doctor && deploy deploy。不需要 clone 仓库、不需要 bash/python。
package main

import (
	"bufio"
	"embed"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

//go:embed docker-compose.yml
//go:embed .env.example
//go:embed pixivflow/config/fly-two-bots.example.json
//go:embed caddy/Caddyfile
//go:embed proxy
//go:embed fly/deploy.fly-multi-bot.toml
var scaffold embed.FS

// 与 docker-compose/.env 基线保持一致（发版时同步更新）。
const (
	telepostBaseline = "2.10.38"
	pixivBaseline    = "2.10.28"
)

// 向导场景（answers 里的 SCENARIO 键；缺省 = polling）。
const (
	scenarioWebhook = "webhook"
	scenarioProxy   = "proxy"
	scenarioFly     = "fly"
)

// wizard 询问的关键项：env key → 提示语。
var wizardKeys = []struct {
	key  string
	prom string
	req  bool
}{
	{"BOT1_TOKEN", "Bot 1 Token（@BotFather 创建，机器人需为频道管理员）", true},
	{"BOT1_CHANNEL_ID", "Bot 1 频道 ID（@yourchannel 或 -100xxxxxxxxxx）", true},
	{"BOT1_OWNER_ID", "Bot 1 管理员 Telegram 用户 ID（数字）", true},
}

func cmdInit(dir string, force bool) {
	if dir == "" {
		dir = "."
	}
	abs, err := filepath.Abs(dir)
	if err != nil {
		die("无法解析目录 %s: %v", dir, err)
	}
	if fi, statErr := os.Stat(abs); statErr == nil && !fi.IsDir() {
		die("%s 不是目录", abs)
	}

	marker := []string{"docker-compose.yml", ".env"}
	existing := ""
	for _, m := range marker {
		if _, err := os.Stat(filepath.Join(abs, m)); err == nil {
			existing = m
			break
		}
	}
	if existing != "" && !force {
		die("%s 已存在 %s（已初始化过？）。确认覆盖请加 --force", abs, existing)
	}

	infof("将在 %s 生成全新部署目录", abs)
	answers := wizard()
	scenario := answers["SCENARIO"]
	delete(answers, "SCENARIO")
	if err := writeScaffold(abs, answers); err != nil {
		die("初始化失败: %v", err)
	}
	if scenario == scenarioFly {
		if err := writeFlyTpl(abs, answers); err != nil {
			die("初始化失败（Fly 配置）: %v", err)
		}
	}
	okf("初始化完成")
	nextSteps(scenario)
	infof("建议：编辑 data/pixivflow/config.json 把示例主题（ミク/アークナイツ）换成你想要的 tag；")
	infof("投稿 token 由 Bot 内 /gen_token 生成后填入 .env 的 TELEPOST_BOT1_SUBMIT_TOKEN。")
}

// nextSteps 按场景输出启动命令。
func nextSteps(scenario string) {
	fmt.Println()
	infof("接下来：")
	if scenario == scenarioWebhook {
		fmt.Println("  1) 自检后启动（需域名 A/AAAA 已指向本机并放通 80/443）：")
		fmt.Println("     ./deploy doctor")
		fmt.Println("     docker compose --profile webhook up -d")
	} else if scenario == scenarioProxy {
		fmt.Println("  1) 自检后启动（内置 Mihomo 代理，国内网络）：")
		fmt.Println("     ./deploy doctor")
		fmt.Println("     docker compose --profile proxy up -d")
	} else if scenario == scenarioFly {
		fmt.Println("  1) Fly.io 部署（需先安装并登录 flyctl）：")
		fmt.Println("     fly auth login")
		fmt.Println("     fly secrets set --app 你的app名 $(把 .env 里 BOT1_*/BOT2_*/PIXIV_* 等键值对上)")
		fmt.Println("     ./deploy deploy --platform fly       # 读 ./telesubmit.fly.toml")
		fmt.Println("   先编辑 ./telesubmit.fly.toml：把 app 改成你的应用名。")
	} else {
		fmt.Println("  1) 进入目录后自检：  ./deploy doctor")
		fmt.Println("  2) 一键部署：        ./deploy deploy        （或 ./deploy tp latest 升级并部署）")
		fmt.Println("  3) 常用维护：        ./deploy status / logs / doctor")
	}
}

// wizard 在 TTY 下逐项询问必需信息；非交互（无输入）时静默返回 nil，.env 保留占位符。
func wizard() map[string]string {
	if os.Stdin == nil {
		return nil
	}
	fi, err := os.Stdin.Stat()
	if err != nil || fi.Mode()&os.ModeCharDevice == 0 {
		return nil
	}
	reader := bufio.NewReader(os.Stdin)
	read := func(prom string) (string, error) {
		fmt.Printf("  %s\n", prom)
		fmt.Print("  > ")
		line, err := reader.ReadString('\n')
		return strings.TrimSpace(line), err
	}
	answers := map[string]string{}
	fmt.Println()
	infof("填写部署信息（直接回车跳过可选项目）：")
	for i, k := range wizardKeys {
		v, err := read(k.prom)
		// 非交互（自动化/管道）：首个问题就 EOF 时静默结束，不再追问。
		if i == 0 && err != nil && v == "" {
			return nil
		}
		if v != "" {
			answers[k.key] = v
		} else if k.req {
			warnf("%s 为空：之后需要编辑 .env 补上才能启动", k.key)
		}
		if err != nil {
			break // 中途 EOF（如 Ctrl-D）：用已收集的回答继续
		}
	}
	// Bot 数量（默认 2；2..N 依次询问）
	botCount := 2
	if v, err := read("几个 Bot？(1-9，默认 2)"); err == nil && v != "" {
		if n, perr := strconv.Atoi(strings.TrimSpace(v)); perr == nil && n >= 1 && n <= 9 {
			botCount = n
		}
	}
	for b := 2; b <= botCount; b++ {
		prefix := fmt.Sprintf("Bot %d", b)
		keys := []struct{ key, prom string }{
			{fmt.Sprintf("BOT%d_TOKEN", b), prefix + " Token（@BotFather 创建）"},
			{fmt.Sprintf("BOT%d_CHANNEL_ID", b), prefix + " 频道 ID（@yourchannel 或 -100 数字）"},
			{fmt.Sprintf("BOT%d_OWNER_ID", b), prefix + " 管理员 Telegram 用户 ID（数字）"},
		}
		for _, k := range keys {
			if x, err := read(k.prom); err == nil && x != "" {
				answers[k.key] = x
			}
		}
	}
	// 可选 PixivFlow
	if v, err := read("是否启用 PixivFlow 自动投稿？(Y/n)"); err == nil && !strings.EqualFold(v, "n") {
		if x, err := read("PIXIV_REFRESH_TOKEN（Pixiv 登录令牌，可先留空）"); err == nil && x != "" {
			answers["PIXIV_REFRESH_TOKEN"] = x
		}
	}
	// 部署场景（默认 Polling）
	if v, err := read("部署场景？\n      1) Polling（默认：无公网/NAT，直接拉取）\n      2) Webhook（有域名，反代+证书）\n      3) 国内+内置 Mihomo 代理\n      4) Fly.io\n    输入 1-4 或回车=1"); err == nil && v != "" {
		switch strings.TrimSpace(v) {
		case "2":
			answers["SCENARIO"] = scenarioWebhook
			if d, err := read("域名（如 bot.example.com）"); err == nil && d != "" {
				answers["WEBHOOK_DOMAIN"] = d
				answers["WEBHOOK_URL"] = "https://" + d
			}
		case "3":
			answers["SCENARIO"] = scenarioProxy
			if u, err := read("外部代理 HTTP_PROXY_URL（如 http://1.2.3.4:7890；内置 Mihomo 填 http://proxy:7890）"); err == nil && u != "" {
				answers["HTTP_PROXY_URL"] = u
				answers["EGRESS_ALL_PROXY"] = u
			}
			if s, err := read("内置 Mihomo 订阅链接 SUB_URL（可空=纯外部代理）"); err == nil && s != "" {
				answers["SUB_URL"] = s
			}
		case "4":
			answers["SCENARIO"] = scenarioFly
			if v, err := read("启用 Fly auto-stop 省钱？(y/N，间断高峰画像推荐)"); err == nil && strings.EqualFold(v, "y") {
				answers["AUTOSTOP"] = "true"
			}
		}
	}
	return answers
}

// writeScaffold 把内嵌模板写入目标目录并套用向导答案。
func writeScaffold(dir string, answers map[string]string) error {
	for _, sub := range []string{"data/pixivflow", "proxy-data"} {
		if err := os.MkdirAll(filepath.Join(dir, sub), 0o755); err != nil {
			return err
		}
	}
	files := []struct {
		src, dst string
		mode     fs.FileMode
	}{
		{"docker-compose.yml", "docker-compose.yml", 0o644},
		{".env.example", ".env", 0o600},
		{"pixivflow/config/fly-two-bots.example.json", "data/pixivflow/config.json", 0o644},
		{"caddy/Caddyfile", "caddy/Caddyfile", 0o644},
		{"proxy/Dockerfile", "proxy/Dockerfile", 0o644},
		{"proxy/docker-entrypoint.sh", "proxy/docker-entrypoint.sh", 0o755},
		{"proxy/config.example.yaml", "proxy/config.example.yaml", 0o644},
	}
	for _, f := range files {
		data, err := scaffold.ReadFile(f.src)
		if err != nil {
			return fmt.Errorf("读取内嵌 %s: %w", f.src, err)
		}
		if f.src == ".env.example" {
			data = fillEnv(data, answers)
		}
		dst := filepath.Join(dir, f.dst)
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(dst, data, f.mode); err != nil {
			return fmt.Errorf("写入 %s: %w", f.dst, err)
		}
	}
	return nil
}

// fillEnv 把向导答案写回 .env 的对应键（无答案的行保持原样/占位符）。
func fillEnv(tpl []byte, answers map[string]string) []byte {
	if len(answers) == 0 {
		return tpl
	}
	lines := strings.Split(string(tpl), "\n")
	seen := map[string]bool{}
	for i, line := range lines {
		eq := strings.IndexByte(line, '=')
		if eq <= 0 {
			continue
		}
		key := strings.TrimSpace(line[:eq])
		seen[key] = true
		if val, ok := answers[key]; ok {
			lines[i] = key + "=" + val
		}
	}
	// 追加模板里没有的多 bot 键（BOT3_*、BOT4_*…），让向导收集的第 3 个及以后的 bot 生效。
	var extra []string
	for k := range answers {
		if !seen[k] && strings.HasPrefix(k, "BOT") {
			extra = append(extra, k)
		}
	}
	sort.Strings(extra)
	for _, k := range extra {
		lines = append(lines, k+"="+answers[k])
	}
	return []byte(strings.Join(lines, "\n"))
}

// writeFlyTpl 生成 ./telesubmit.fly.toml（把内嵌模板的镜像基线刷新到当前值）。
func writeFlyTpl(dir string, answers map[string]string) error {
	data, err := scaffold.ReadFile("fly/deploy.fly-multi-bot.toml")
	if err != nil {
		return fmt.Errorf("读取内嵌 fly 模板: %w", err)
	}
	lines := strings.Split(string(data), "\n")
	for i, line := range lines {
		tr := strings.TrimSpace(line)
		switch {
		case strings.HasPrefix(tr, "TELEPOST_IMAGE"):
			lines[i] = "  TELEPOST_IMAGE = \"" + telepostRepo + ":" + telepostBaseline + "\""
		case strings.HasPrefix(tr, "PIXIVFLOW_VERSION"):
			lines[i] = "  PIXIVFLOW_VERSION = \"" + pixivBaseline + "\""
		case strings.HasPrefix(tr, "auto_stop_machines"):
			if answers["AUTOSTOP"] == "true" {
				lines[i] = "  auto_stop_machines = \"stop\""
			}
		case strings.HasPrefix(tr, "min_machines_running"):
			if answers["AUTOSTOP"] == "true" {
				lines[i] = "  min_machines_running = 0"
			}
		}
	}
	dst := filepath.Join(dir, "telesubmit.fly.toml")
	if err := os.WriteFile(dst, []byte(strings.Join(lines, "\n")), 0o644); err != nil {
		return err
	}
	autoNote := ""
	if answers["AUTOSTOP"] == "true" {
		autoNote = "；已启用 auto-stop（stop 释放 RAM 停止计费）"
	}
	infof("已生成 telesubmit.fly.toml（镜像基线 TelePost %s + PixivFlow %s%s；请修改 app 名）",
		telepostBaseline, pixivBaseline, autoNote)
	return nil
}
