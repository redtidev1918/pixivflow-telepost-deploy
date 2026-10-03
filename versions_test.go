package main

// versions_test.go — TelePost 部署基线的一致性守护。
//
// 这个仓库曾经同时存在五个互不相干的 TelePost 版本来源，各自漂移：本仓 pin 到
// 2.76.2 的时候，docker-compose 默认还停在 2.64.2、.env.example 停在 2.15.0、
// 脚手架的 telepostBaseline 停在 2.17.6。「默认部署版本」因此取决于用户用的是
// 哪条路径，而不是取决于仓库。
//
// 现在唯一权威来源是 versions.json，其余文件由 scripts/sync-telepost-baseline.py
// 生成。本测试不复制契约，只校验所有来源都指向同一个版本——失败时逐个列出各来源
// 的实际值，而不是一句 expected "2.x.y"，因为开发者需要知道该去改哪一个文件。

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

const versionsPath = "versions.json"

type telepostBaselineDoc struct {
	Version          string `json:"version"`
	Tag              string `json:"tag"`
	Image            string `json:"image"`
	MinSupported     string `json:"minSupported"`
	MinSupportedNote string `json:"minSupportedNote"`
	Source           string `json:"source"`
}

type versionsFile struct {
	Telepost telepostBaselineDoc `json:"telepost"`
}

func loadVersions(t *testing.T) versionsFile {
	t.Helper()
	raw, err := os.ReadFile(versionsPath)
	if err != nil {
		t.Fatalf("读取 %s: %v", versionsPath, err)
	}
	var doc versionsFile
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("解析 %s: %v", versionsPath, err)
	}
	return doc
}

// 各模板里「TelePost 镜像声明」的正则：每个文件必须且只能命中一次。
type baselineSource struct {
	name    string
	path    string
	pattern *regexp.Regexp
}

// pinnedTelepostVersion 用一个能同时匹配 `...telepost:2.78.0` 声明的正则取出版本号。
var pinnedTelepostVersion = regexp.MustCompile(`redtidev1918/telepost:(\d+\.\d+\.\d+)`)

func baselineSources() []baselineSource {
	return []baselineSource{
		{"docker-compose", "docker-compose.yml", pinnedTelepostVersion},
		{".env.example", ".env.example", pinnedTelepostVersion},
		{"docker/combined.Dockerfile", "docker/combined.Dockerfile", pinnedTelepostVersion},
		{"docker/telepost.Dockerfile", "docker/telepost.Dockerfile", pinnedTelepostVersion},
		{"fly/deploy.telepost.toml", "fly/deploy.telepost.toml", pinnedTelepostVersion},
	}
}

func parseSemver(t *testing.T, value string) [3]int {
	t.Helper()
	parts := strings.Split(value, ".")
	if len(parts) != 3 {
		t.Fatalf("版本号 %q 不是 X.Y.Z", value)
	}
	var out [3]int
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil {
			t.Fatalf("版本号 %q 不是 X.Y.Z: %v", value, err)
		}
		out[i] = n
	}
	return out
}

func lessThan(a, b [3]int) bool {
	for i := range a {
		if a[i] != b[i] {
			return a[i] < b[i]
		}
	}
	return false
}

// TestTelepostBaselineMetadataIsSelfConsistent 校验 versions.json 自身：
// version / tag / image 必须互相推导得出，且不低于最低兼容版本。
func TestTelepostBaselineMetadataIsSelfConsistent(t *testing.T) {
	doc := loadVersions(t)
	b := doc.Telepost

	if !regexp.MustCompile(`^\d+\.\d+\.\d+$`).MatchString(b.Version) {
		t.Fatalf("telepost.version 必须是发布版本号 X.Y.Z，得到 %q", b.Version)
	}
	if want := "v" + b.Version; b.Tag != want {
		t.Errorf("telepost.tag = %q，应为 %q", b.Tag, want)
	}
	if want := telepostRepo + ":" + b.Version; b.Image != want {
		t.Errorf("telepost.image = %q，应为 %q", b.Image, want)
	}
	if b.MinSupported != "" {
		if lessThan(parseSemver(t, b.Version), parseSemver(t, b.MinSupported)) {
			t.Errorf("默认部署版本 %s 低于最低兼容版本 %s", b.Version, b.MinSupported)
		}
		if b.MinSupportedNote == "" {
			t.Errorf("minSupported=%s 但没有说明它的语义；最低兼容版本容易被误当成默认版本", b.MinSupported)
		}
	}
	if b.Source != "" && !strings.Contains(b.Source, b.Tag) {
		t.Errorf("telepost.source = %q，应指向 tag %s", b.Source, b.Tag)
	}
}

// TestTelepostBaselineSourcesAgree 校验所有模板与脚手架常量都指向同一个版本。
func TestTelepostBaselineSourcesAgree(t *testing.T) {
	want := loadVersions(t).Telepost.Version

	type seen struct {
		name, version string
	}
	var got []seen
	for _, src := range baselineSources() {
		raw, err := os.ReadFile(src.path)
		if err != nil {
			t.Fatalf("读取 %s: %v", src.path, err)
		}
		matches := src.pattern.FindAllStringSubmatch(string(raw), -1)
		if len(matches) != 1 {
			t.Fatalf("%s 里有 %d 处 TelePost 镜像声明（应恰好 1 处）", src.path, len(matches))
		}
		got = append(got, seen{src.name, matches[0][1]})
	}
	got = append(got, seen{"init.go (scaffold)", telepostBaseline})

	var bad []string
	for _, s := range got {
		if s.version != want {
			bad = append(bad, fmt.Sprintf("  %-28s = %s", s.name, s.version))
		}
	}
	if len(bad) > 0 {
		t.Fatalf("TelePost baseline mismatch（权威来源 %s = %s）:\n%s\n\n"+
			"修正：改 versions.json 后运行 ./scripts/sync-telepost-baseline.py",
			versionsPath, want, strings.Join(bad, "\n"))
	}
}

// TestScaffoldFlyTemplateUsesBaseline 校验 deploy init 生成的 Fly 配置用的是当前基线。
//
// 只测源码常量是不够的：init 会把内嵌模板里的 TELEPOST_IMAGE 重写成 telepostBaseline，
// 脚手架写给第三方的 pin 必须和仓库里跑的是同一个版本。
func TestScaffoldFlyTemplateUsesBaseline(t *testing.T) {
	want := loadVersions(t).Telepost.Image
	dir := t.TempDir()
	if err := writeFlyTpl(dir, map[string]string{}); err != nil {
		t.Fatalf("writeFlyTpl: %v", err)
	}
	raw, err := os.ReadFile(filepath.Join(dir, "telesubmit.fly.toml"))
	if err != nil {
		t.Fatalf("读取生成的 Fly 配置: %v", err)
	}
	matches := pinnedTelepostVersion.FindAllStringSubmatch(string(raw), -1)
	if len(matches) != 1 {
		t.Fatalf("生成的 Fly 配置里有 %d 处 TelePost 镜像声明（应恰好 1 处）", len(matches))
	}
	if got := telepostRepo + ":" + matches[0][1]; got != want {
		t.Fatalf("脚手架 pin = %s，基线要求 %s", got, want)
	}
}

// TestTelepostBaselineIsNotAFloatingRef 保证基线是不可变引用。
// latest / 分支名会让第三方每次构建都指向不同代码，回滚也就无从谈起。
func TestTelepostBaselineIsNotAFloatingRef(t *testing.T) {
	b := loadVersions(t).Telepost
	// 只比较「版本/标签」本身，不对整条 image 做子串匹配：
	// 镜像仓库名 redtidev1918 里就含 "dev"，子串匹配会误报。
	for _, bad := range []string{"latest", "master", "main", "dev", "nightly", "stable"} {
		if b.Version == bad || b.Tag == bad {
			t.Fatalf("TelePost 基线是浮动引用（%s）：version=%s tag=%s", bad, b.Version, b.Tag)
		}
	}
	if !strings.HasSuffix(b.Image, ":"+b.Version) {
		t.Fatalf("TelePost 镜像必须固定到明确版本（…:%s），得到 %s", b.Version, b.Image)
	}
	// tag 部分必须是版本号，不能是 latest 之类的浮动标签。
	imageTag := b.Image[strings.LastIndex(b.Image, ":")+1:]
	if !regexp.MustCompile(`^\d+\.\d+\.\d+$`).MatchString(imageTag) {
		t.Fatalf("TelePost 镜像标签不是发布版本号：%s", imageTag)
	}
}
