package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeTemp(t *testing.T, name, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestFlyConfigHasBuildImage(t *testing.T) {
	withImage := `app = "example"

[build]
  image = 'old:tag'
`
	withoutImage := `app = "example"

[build]
  dockerfile = '../docker/telepost.Dockerfile'
  [build.args]
    TELEPOST_IMAGE = 'ghcr.io/example/telepost:1.0.0'
`
	if !flyConfigHasBuildImage(writeTemp(t, "fly.toml", withImage)) {
		t.Fatal("legacy [build].image was not detected")
	}
	if flyConfigHasBuildImage(writeTemp(t, "fly.toml", withoutImage)) {
		t.Fatal("[build].args 里的镜像基线被误当成已禁用的 [build].image")
	}
}

func TestFlyProfileIsAutosleep(t *testing.T) {
	cases := []struct {
		name string
		toml string
		want bool
	}{
		{
			"autosleep stop + min 0",
			"auto_stop_machines = \"stop\"\nauto_start_machines = true\nmin_machines_running = 0\n",
			true,
		},
		{
			"always-on",
			"auto_stop_machines = false\nmin_machines_running = 1\n",
			false,
		},
		{
			"min 0 but auto_stop false is still always-on",
			"auto_stop_machines = false\nmin_machines_running = 0\n",
			false,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			path := writeTemp(t, "fly.toml", tc.toml)
			if got := flyProfileIsAutosleep(path); got != tc.want {
				t.Fatalf("flyProfileIsAutosleep = %v, want %v", got, tc.want)
			}
		})
	}
}

// 脚手架（telesubmit.fly.toml / pixivflow.fly.toml）只要还在，规范配置就必须获胜：
// 这条不变量正是「deploy tp 不会读回旧合一拓扑」的根。
func TestFlyCfgForPrefersCanonical(t *testing.T) {
	if _, err := os.Stat(canonicalTelepostCfg); err != nil {
		t.Skipf("仓库里没有 %s", canonicalTelepostCfg)
	}
	if got := flyCfgFor(planeTelepost); got != canonicalTelepostCfg {
		t.Fatalf("flyCfgFor(telepost) = %q, want %q", got, canonicalTelepostCfg)
	}
	if got := flyCfgFor(planePixivflow); got != canonicalPixivflowCfg {
		t.Fatalf("flyCfgFor(pixivflow) = %q, want %q", got, canonicalPixivflowCfg)
	}
}

func TestPlaneTopologyError(t *testing.T) {
	cases := []struct {
		name  string
		plane string
		toml  string
		want  bool
	}{
		{
			"clean telepost",
			planeTelepost,
			"app = 'telesubmit-multi-bot'\n[build]\n  dockerfile = '../docker/telepost.Dockerfile'\n",
			false,
		},
		{
			"clean pixivflow",
			planePixivflow,
			"app = 'pixivflow-scheduler'\n[build]\n  dockerfile = '../docker/pixivflow-scheduler.Dockerfile'\n",
			false,
		},
		{
			"combined dockerfile is rejected on both planes",
			planeTelepost,
			"[build]\n  dockerfile = '../docker/combined.Dockerfile'\n",
			true,
		},
		{
			"telepost carrying pixivflow keys is rejected",
			planeTelepost,
			"[env]\n  PIXIVFLOW_ENABLED = 'true'\n",
			true,
		},
		{
			"pixivflow carrying telepost keys is rejected",
			planePixivflow,
			"[env]\n  RUN_MODE = 'WEBHOOK'\n",
			true,
		},
		{
			"mixed file fails on pixivflow too",
			planePixivflow,
			"[build]\n  dockerfile = '../docker/combined.Dockerfile'\n",
			true,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			path := writeTemp(t, "fly.toml", tc.toml)
			msg := planeTopologyError(tc.plane, path)
			if tc.want && msg == "" {
				t.Fatal("混用配置没有被识别")
			}
			if !tc.want && msg != "" {
				t.Fatalf("合格配置被误判：%s", msg)
			}
		})
	}

	// 空文件/不存在不归这里报：存在性由各调用方自己检查。
	if msg := planeTopologyError(planeTelepost, filepath.Join(t.TempDir(), "missing.toml")); msg != "" {
		t.Fatalf("缺失文件应返回空，得到：%s", msg)
	}
}

// 权威配置用单引号、脚手架用双引号：两种写法都要能读、能写，且写入时保留原风格。
func TestTomlQuoting(t *testing.T) {
	single := writeTemp(t, "single.toml", "app = 'pixivflow-scheduler'\n")
	if got := tomlGet(single, "app"); got != "pixivflow-scheduler" {
		t.Fatalf("单引号读取 = %q", got)
	}
	tomlSet(single, "app", "renamed")
	if got := tomlRawValue(single, "app"); got != "'renamed'" {
		t.Fatalf("写入后应保留单引号，得到 %q", got)
	}

	double := writeTemp(t, "double.toml", "app = \"telesubmit-multi-bot\"\n")
	if got := tomlGet(double, "app"); got != "telesubmit-multi-bot" {
		t.Fatalf("双引号读取 = %q", got)
	}
	tomlSet(double, "app", "renamed")
	if got := tomlRawValue(double, "app"); got != `"renamed"` {
		t.Fatalf("写入后应保留双引号，得到 %q", got)
	}

	// 布尔/数字是不带引号的标量，quoted-only 的正则会漏掉它们。
	scalars := writeTemp(t, "scalars.toml", "auto_stop_machines = false\nmin_machines_running = 0\n")
	if got := tomlScalar(scalars, "auto_stop_machines"); got != "false" {
		t.Fatalf("tomlScalar(auto_stop_machines) = %q", got)
	}
	if got := tomlScalar(scalars, "min_machines_running"); got != "0" {
		t.Fatalf("tomlScalar(min_machines_running) = %q", got)
	}
}

// 发布基线是「已发布且不可变」的引用：REF 是带 v 前缀的 tag，不能是分支或浮动 tag。
func TestPixivflowScaffoldBaselineIsImmutable(t *testing.T) {
	if !strings.HasPrefix(pixivBaselineRef, "v"+pixivBaseline) {
		t.Fatalf("PIXIVFLOW_REF 基线 %q 与版本 %q 不一致", pixivBaselineRef, pixivBaseline)
	}
	for _, value := range []string{pixivBaselineRef, telepostBaseline} {
		for _, bad := range []string{"latest", "master", "main"} {
			if strings.Contains(value, bad) {
				t.Fatalf("脚手架基线不是不可变引用：%s", value)
			}
		}
	}
}
