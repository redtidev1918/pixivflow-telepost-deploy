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
	"strings"
)

//go:embed docker-compose.yml
//go:embed .env.example
//go:embed pixivflow/config/fly-two-bots.example.json
//go:embed caddy/Caddyfile
//go:embed proxy
var scaffold embed.FS

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
	if err := writeScaffold(abs, answers); err != nil {
		die("初始化失败: %v", err)
	}
	okf("初始化完成")
	fmt.Println()
	infof("接下来：")
	fmt.Println("  1) 进入目录后自检：  ./deploy doctor")
	fmt.Println("  2) 一键部署：        ./deploy deploy        （或 ./deploy tp latest 升级并部署）")
	fmt.Println("  3) 常用维护：        ./deploy status / logs / doctor")
	fmt.Println()
	infof("建议：编辑 data/pixivflow/config.json 把示例主题（ミク/アークナイツ）换成你想要的 tag；")
	infof("投稿 token 由 Bot 内 /gen_token 生成后填入 .env 的 TELEPOST_BOT1_SUBMIT_TOKEN。")
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
	// 可选第二个 Bot
	v, err := read("是否启用第二个 Bot？(y/N)")
	if err == nil && strings.EqualFold(v, "y") {
		for _, k := range []string{"BOT2_TOKEN", "BOT2_CHANNEL_ID", "BOT2_OWNER_ID"} {
			if x, err := read(k); err == nil && x != "" {
				answers[k] = x
			}
		}
	}
	// 可选 PixivFlow
	if v, err = read("是否启用 PixivFlow 自动投稿？(Y/n)"); err == nil && !strings.EqualFold(v, "n") {
		if x, err := read("PIXIV_REFRESH_TOKEN（Pixiv 登录令牌，可先留空）"); err == nil && x != "" {
			answers["PIXIV_REFRESH_TOKEN"] = x
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
	for i, line := range lines {
		eq := strings.IndexByte(line, '=')
		if eq <= 0 {
			continue
		}
		key := strings.TrimSpace(line[:eq])
		if val, ok := answers[key]; ok {
			lines[i] = key + "=" + val
		}
	}
	return []byte(strings.Join(lines, "\n"))
}
