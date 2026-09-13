package main

// architecture_docs_test.go — 文档一致性守护。
//
// 它强制三类约定不会漂移：
//  1. preset 名称与支持等级在 机器矩阵 / 架构索引 / AGENTS.md 三处一致；
//  2. 文档里引用的仓库文件真实存在，英文镜像与中文页一一对应；
//  3. split-worker 的安全契约（执行端无 Telegram 凭据、TelePost 是唯一 webhook owner、
//     执行端无健康检查、force_https=false）没有被文档或配置改掉。
//
// 数据来源是 docs/reference/architecture-matrix.json：本测试不复制契约，只校验它。

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const matrixPath = "docs/reference/architecture-matrix.json"

type matrix struct {
	MatrixVersion int `json:"matrixVersion"`
	Enums         struct {
		SupportLevel []string `json:"supportLevel"`
		Lifecycle    []string `json:"lifecycle"`
	} `json:"enums"`
	Presets map[string]struct {
		Title  map[string]string `json:"title"`
		Doc    string            `json:"doc"`
		Status struct {
			Support          string   `json:"support"`
			Documented       bool     `json:"documented"`
			Implemented      bool     `json:"implemented"`
			Tested           bool     `json:"tested"`
			ProductionProven bool     `json:"productionProven"`
			Evidence         []string `json:"evidence"`
		} `json:"status"`
		Units []struct {
			ID        string `json:"id"`
			Lifecycle string `json:"lifecycle"`
		} `json:"units"`
		RolePlacement map[string]struct {
			Unit      string `json:"unit"`
			Lifecycle string `json:"lifecycle"`
		} `json:"rolePlacement"`
		Allowed            map[string]any `json:"allowed"`
		CredentialBoundary map[string]any `json:"credentialBoundary"`
	} `json:"presets"`
	ProductionTopology struct {
		CanonicalPreset   string   `json:"canonicalPreset"`
		CanonicalDoc      string   `json:"canonicalDoc"`
		CanonicalSentence string   `json:"canonicalSentence"`
		ExclusiveClaim    string   `json:"exclusiveClaimPattern"`
		NegationMarkers   []string `json:"negationMarkers"`
		ProhibitionAllow  []string `json:"prohibitionContextAllowlist"`
	} `json:"productionTopology"`
	SecurityInvariants []struct {
		ID       string   `json:"id"`
		Applies  []string `json:"applies"`
		Enforced []string `json:"enforcedBy"`
	} `json:"securityInvariants"`
	Documentation struct {
		PrimaryLanguage string            `json:"primaryLanguage"`
		RootMirror      map[string]string `json:"rootMirror"`
		MirroredPages   []string          `json:"mirroredPages"`
		MovedPages      map[string]string `json:"movedPages"`
	} `json:"documentation"`
}

func repoRoot(t *testing.T) string {
	t.Helper()
	wd, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	return wd
}

func loadMatrix(t *testing.T) matrix {
	t.Helper()
	raw, err := os.ReadFile(matrixPath)
	if err != nil {
		t.Fatalf("read %s: %v", matrixPath, err)
	}
	var m matrix
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("parse %s: %v", matrixPath, err)
	}
	if m.MatrixVersion == 0 {
		t.Fatalf("%s: matrixVersion missing", matrixPath)
	}
	return m
}

func readIfExists(t *testing.T, rel string) (string, bool) {
	t.Helper()
	raw, err := os.ReadFile(rel)
	if err != nil {
		return "", false
	}
	return string(raw), true
}

func mustRead(t *testing.T, rel string) string {
	t.Helper()
	raw, err := os.ReadFile(rel)
	if err != nil {
		t.Fatalf("read %s: %v", rel, err)
	}
	return string(raw)
}

// markdownFiles walks a directory and returns every .md path relative to the repo root.
func markdownFiles(t *testing.T, dir string) []string {
	t.Helper()
	var out []string
	err := filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() || !strings.HasSuffix(path, ".md") {
			return nil
		}
		out = append(out, filepath.ToSlash(path))
		return nil
	})
	if err != nil {
		t.Fatalf("walk %s: %v", dir, err)
	}
	sort.Strings(out)
	return out
}

func contains(list []string, want string) bool {
	for _, item := range list {
		if item == want {
			return true
		}
	}
	return false
}

// ---------------------------------------------------------------------------
// 1. preset 名与支持等级三处一致
// ---------------------------------------------------------------------------

func TestPresetsAreConsistentAcrossMatrixIndexAndAgents(t *testing.T) {
	m := loadMatrix(t)

	var names []string
	for name := range m.Presets {
		names = append(names, name)
	}
	sort.Strings(names)
	if len(names) == 0 {
		t.Fatalf("matrix declares no presets")
	}

	overview := mustRead(t, "docs/architectures/overview.md")
	agents := mustRead(t, "AGENTS.md")

	for _, name := range names {
		preset := m.Presets[name]
		if preset.Doc == "" {
			t.Errorf("preset %q: matrix field `doc` is empty", name)
			continue
		}
		if _, ok := readIfExists(t, preset.Doc); !ok {
			t.Errorf("preset %q: documented at %q but the file does not exist", name, preset.Doc)
		}
		// 每个支持等级 stable 的 preset 必须同时是 implemented 与 tested。
		if preset.Status.Support == "stable" {
			if !preset.Status.Implemented || !preset.Status.Tested {
				t.Errorf("preset %q: support=stable requires implemented=true and tested=true", name)
			}
		}
		// support 枚举合法。
		if !contains(m.Enums.SupportLevel, preset.Status.Support) {
			t.Errorf("preset %q: support %q is not a legal enum value %v", name, preset.Status.Support, m.Enums.SupportLevel)
		}
		// 名称必须出现在架构索引与 AGENTS.md。
		if !strings.Contains(overview, "`"+name+"`") {
			t.Errorf("docs/architectures/overview.md does not mention preset %q", name)
		}
		if !strings.Contains(agents, "`"+name+"`") {
			t.Errorf("AGENTS.md does not mention preset %q", name)
		}
		// 架构索引必须按名称链接到 preset 文档（以文件名出现）。
		base := filepath.Base(preset.Doc)
		if !strings.Contains(overview, base) {
			t.Errorf("docs/architectures/overview.md does not link to %s", base)
		}
	}
}

func TestPresetLifecycleEnumsAreLegal(t *testing.T) {
	m := loadMatrix(t)
	legal := map[string]bool{}
	for _, v := range m.Enums.Lifecycle {
		legal[v] = true
	}
	for name, preset := range m.Presets {
		for _, unit := range preset.Units {
			for _, part := range strings.Split(unit.Lifecycle, "|") {
				part = strings.TrimSpace(part)
				if part == "" || part == "platform-dependent" {
					continue
				}
				if !legal[part] {
					t.Errorf("preset %q unit %q: lifecycle %q is not a legal enum value %v", name, unit.ID, part, m.Enums.Lifecycle)
				}
			}
		}
		for role, placement := range preset.RolePlacement {
			if placement.Lifecycle == "" {
				continue
			}
			for _, part := range strings.Split(placement.Lifecycle, "|") {
				part = strings.TrimSpace(part)
				if part == "" || part == "platform-dependent" {
					continue
				}
				if !legal[part] {
					t.Errorf("preset %q rolePlacement[%q]: lifecycle %q is not a legal enum value %v", name, role, part, m.Enums.Lifecycle)
				}
			}
		}
	}
}

// ---------------------------------------------------------------------------
// 2. 文档引用的仓库文件必须存在；中英镜像一一对应
// ---------------------------------------------------------------------------

func TestConfigFilesReferencedByDocsExist(t *testing.T) {
	// 文档里引用的仓库配置/脚本路径。这里扫真实引用，而不是维护一份固定清单，
	// 这样文档里写错路径会立刻暴露。
	re := regexp.MustCompile(`(?:\./)?(?:docker-compose\.yml|fly/deploy\.[a-z0-9_-]+\.toml|fly/config/[A-Za-z0-9_./-]+|control-plane/(?:wrangler\.toml|src/[A-Za-z0-9_./-]+)|docker/[A-Za-z0-9._-]+\.Dockerfile|scripts/[A-Za-z0-9._-]+\.(?:sh|py)|pixivflow/config/[A-Za-z0-9._/-]+\.json|config/[A-Za-z0-9._/-]+\.json|\.env\.example)`)
	seen := map[string]bool{}
	for _, file := range markdownFiles(t, "docs") {
		content := mustRead(t, file)
		for _, loc := range re.FindAllStringIndex(content, -1) {
			match := content[loc[0]:loc[1]]
			if loc[0] > 0 {
				prev := content[loc[0]-1]
				if prev == '/' || (prev >= 'a' && prev <= 'z') || (prev >= 'A' && prev <= 'Z') || (prev >= '0' && prev <= '9') {
					continue // 这是更长路径的一段（例如 /app/config/...），不是仓库相对引用
				}
			}
			match = strings.TrimPrefix(match, "./")
			if seen[match] {
				continue
			}
			seen[match] = true
			if _, ok := readIfExists(t, match); !ok {
				t.Errorf("%s references %q which does not exist", file, match)
			}
		}
	}
}

func TestMirroredPagesExistInBothLanguages(t *testing.T) {
	m := loadMatrix(t)

	// mirroredPages 的每一页都必须同时存在中文与英文版本。
	for _, page := range m.Documentation.MirroredPages {
		cn := filepath.Join("docs", filepath.FromSlash(page))
		en := filepath.Join("docs", "en", filepath.FromSlash(page))
		if _, ok := readIfExists(t, cn); !ok {
			t.Errorf("mirrored page %q is missing its Chinese file %s", page, cn)
		}
		if _, ok := readIfExists(t, en); !ok {
			t.Errorf("mirrored page %q is missing its English file %s", page, en)
		}
	}

	// 反向：docs/en/ 下的每一页都必须有同路径的中文对应文件。
	enRoot := filepath.Join("docs", "en")
	for _, file := range markdownFiles(t, enRoot) {
		rel := strings.TrimPrefix(file, enRoot+"/")
		if strings.HasSuffix(rel, "_sidebar.md") {
			continue
		}
		cn := filepath.Join("docs", filepath.FromSlash(rel))
		if _, ok := readIfExists(t, cn); !ok {
			t.Errorf("%s has no Chinese counterpart at %s", file, cn)
		}
	}

	// 仓库根 README 双语成对。
	for cn, en := range m.Documentation.RootMirror {
		if _, ok := readIfExists(t, cn); !ok {
			t.Errorf("root mirror source %s missing", cn)
		}
		if _, ok := readIfExists(t, en); !ok {
			t.Errorf("root mirror target %s missing", en)
		}
	}
}

func TestSidebarLinksPointToExistingPages(t *testing.T) {
	for _, sidebar := range []string{"docs/_sidebar.md", "docs/en/_sidebar.md"} {
		content := mustRead(t, sidebar)
		base := filepath.Dir(sidebar)
		for _, match := range regexp.MustCompile(`\]\((/[^)#\s]+\.md)\)`).FindAllStringSubmatch(content, -1) {
			// 侧边栏链接是站点绝对路径（/xxx.md），站点根是 docs/。
			target := filepath.Join("docs", filepath.FromSlash(strings.TrimPrefix(match[1], "/")))
			if _, ok := readIfExists(t, target); !ok {
				// 指向中文页的英文链接（/concepts/...）同样必须存在。
				t.Errorf("%s links to %s which does not exist", sidebar, match[1])
			}
			_ = base
		}
	}
}

// ---------------------------------------------------------------------------
// 3. 「唯一生产拓扑」只能有一处声明
// ---------------------------------------------------------------------------

func TestNoSecondDeclarationOfTheOnlyProductionTopology(t *testing.T) {
	m := loadMatrix(t)
	pt := m.ProductionTopology

	if pt.CanonicalDoc == "" || pt.CanonicalSentence == "" {
		t.Fatalf("productionTopology.canonicalDoc / canonicalSentence must be set in %s", matrixPath)
	}

	// 规范声明必须出现在规范文件里，且只出现在这一个文件里。
	hits := 0
	for _, file := range markdownFiles(t, "docs") {
		if strings.Contains(mustRead(t, file), pt.CanonicalSentence) {
			hits++
			if file != pt.CanonicalDoc {
				t.Errorf("canonical production-topology sentence also appears in %s (canonical: %s)", file, pt.CanonicalDoc)
			}
		}
	}
	if hits != 1 {
		t.Errorf("canonical production-topology sentence appears in %d file(s); want exactly 1 in %s", hits, pt.CanonicalDoc)
	}

	claim := regexp.MustCompile(pt.ExclusiveClaim)
	if claim == nil {
		t.Fatalf("productionTopology.exclusiveClaimPattern is not a valid Go regexp")
	}
	for _, file := range append(markdownFiles(t, "docs"), "README.md", "README.en.md", "AGENTS.md") {
		if _, ok := readIfExists(t, file); !ok {
			continue
		}
		if contains(pt.ProhibitionAllow, file) {
			continue
		}
		for i, line := range strings.Split(mustRead(t, file), "\n") {
			if !claim.MatchString(line) {
				continue
			}
			negated := false
			for _, marker := range pt.NegationMarkers {
				if strings.Contains(line, marker) {
					negated = true
					break
				}
			}
			if !negated {
				t.Errorf("%s:%d states an exclusive production topology without negating it: %q", file, i+1, strings.TrimSpace(line))
			}
		}
	}
}

// ---------------------------------------------------------------------------
// 4. split-worker 的安全契约没有被破坏
// ---------------------------------------------------------------------------

func TestSplitWorkerSafetyContract(t *testing.T) {
	m := loadMatrix(t)

	pixivflow := mustRead(t, "fly/deploy.pixivflow.toml")
	telepost := mustRead(t, "fly/deploy.telepost.toml")

	// SI-1：执行端配置里不得出现任何 Telegram 令牌或频道 ID。
	telegramKey := regexp.MustCompile(`(?im)^\s*BOT[0-9]+_(TOKEN|CHANNEL_ID|OWNER_ID|REVIEW_CHAT_ID|WEBHOOK_SECRET_TOKEN)\s*=`)
	if matches := telegramKey.FindAllString(pixivflow, -1); len(matches) > 0 {
		t.Errorf("fly/deploy.pixivflow.toml holds Telegram credentials (SI-1 violation): %v", matches)
	}
	// 执行端的凭据经平台 secret 注入（fly secrets set），配置文件里不得出现任何 Telegram 键；
	// 这一条已由上面的 telegramKey 检查覆盖。

	// SI-2：业务端是 webhook owner，必须保持 force_https = false（Flycast 明文投递）。
	if !strings.Contains(telepost, "force_https = false") {
		t.Errorf("fly/deploy.telepost.toml lost force_https = false; Flycast delivery would 301 into a dead end")
	}
	if !strings.Contains(telepost, "auto_stop_machines = false") || !strings.Contains(telepost, "min_machines_running = 1") {
		t.Errorf("fly/deploy.telepost.toml must stay resident (auto_stop_machines = false, min_machines_running = 1)")
	}

	// SI-5：执行端没有健康检查、没有平台 auto-stop、没有重启策略。
	if strings.Contains(pixivflow, "checks]") {
		t.Errorf("fly/deploy.pixivflow.toml declares a health check; a probe would wake a machine that just decided it had finished (SI-5)")
	}
	if regexp.MustCompile(`(?m)^\s*auto_stop_machines\s*=\s*(true|"stop"|"suspend")`).MatchString(pixivflow) {
		t.Errorf("fly/deploy.pixivflow.toml enables platform auto-stop; the executor must stop itself via its own ledger (SI-5)")
	}
	if !strings.Contains(pixivflow, `policy = 'never'`) && !strings.Contains(pixivflow, `policy = "never"`) {
		t.Errorf("fly/deploy.pixivflow.toml must set restart policy to 'never' so the machine can reach 'stopped'")
	}

	// 矩阵侧：SI-1 必须应用于 split-worker 与 remote-worker，且不适用于共置 preset。
	for _, inv := range m.SecurityInvariants {
		if inv.ID != "SI-1" {
			continue
		}
		for _, must := range []string{"split-worker", "remote-worker"} {
			if !contains(inv.Applies, must) {
				t.Errorf("security invariant SI-1 no longer applies to %s", must)
			}
		}
		for _, forbidden := range []string{"single-host", "single-machine-worker-sleep"} {
			if contains(inv.Applies, forbidden) {
				t.Errorf("security invariant SI-1 must not claim to apply to %s (roles are co-located there)", forbidden)
			}
		}
	}

	// 文档侧：split-worker 页必须把这条边界写清楚，共置 preset 页必须承认边界不成立。
	splitDoc := mustRead(t, "docs/architectures/split-worker.md")
	if !regexp.MustCompile(`没\*{0,4}有\*{0,4}任何.{0,4}Telegram`).MatchString(splitDoc) {
		t.Errorf("docs/architectures/split-worker.md must state that the executor holds no Telegram token")
	}
	for _, coLocated := range []string{"docs/architectures/single-host.md", "docs/architectures/single-machine-worker-sleep.md"} {
		doc := mustRead(t, coLocated)
		if !strings.Contains(doc, "不成立") {
			t.Errorf("%s must state that the split-worker credential boundary does not hold for a co-located preset", coLocated)
		}
	}
}

// ---------------------------------------------------------------------------
// 5. 文档不得重新引入已删除的拓扑或模糊表述
// ---------------------------------------------------------------------------

// ruleLineMatches 只在「同一行出现命中且该行没有否定/历史标记」时报告，
// 因此解释为什么某拓扑被删除的段落不会被误报。
func ruleLineMatches(rules []struct {
	pattern *regexp.Regexp
	why     string
}, line string) bool {
	for _, rule := range rules {
		if !rule.pattern.MatchString(line) {
			continue
		}
		for _, marker := range []string{"不是", "禁止", "绝不", "已删除", "删除", "never", "deleted", "历史"} {
			if strings.Contains(line, marker) {
				return false
			}
		}
		return true
	}
	return false
}

func firstWhy(rules []struct {
	pattern *regexp.Regexp
	why     string
}, line string) string {
	for _, rule := range rules {
		if rule.pattern.MatchString(line) {
			return rule.why
		}
	}
	return ""
}

func TestDocsDoNotResurrectRemovedTopologies(t *testing.T) {
	// 这些拓扑与命令已被删除并有明确的删除理由；文档不得把它们当作可选方案重新提出。
	resurrect := []struct {
		pattern *regexp.Regexp
		why     string
	}{
		{regexp.MustCompile(`deploy (split|source)\b`), "`deploy split` / `deploy source` were deleted (commit 35ab597)"},
		{regexp.MustCompile(`docs/(SERVERLESS-CUTOVER|AUTOSTOP)\.md`), "the serverless cutover and auto-stop guides were deleted (commit 90a350f)"},
		{regexp.MustCompile(`auto_stop_machines\s*=\s*"?(stop|suspend)"?`), "machine-level auto-stop was deleted (commit a98c3a7)"},
	}
	for _, file := range markdownFiles(t, "docs") {
		if strings.HasSuffix(file, "incidents/2026-09-11-pixiv-egress-rate-limit.md") {
			continue // 事故记录可以描述历史
		}
		if strings.Contains(file, "/en/incidents/") {
			continue
		}
		if strings.HasSuffix(file, "architectures/single-machine-worker-sleep.md") {
			continue // 该页唯一的工作就是解释为什么机器级 auto-stop 不被允许
		}
		for i, line := range strings.Split(mustRead(t, file), "\n") {
			if !ruleLineMatches(resurrect, line) {
				continue
			}
			t.Errorf("%s:%d mentions a removed topology: %s", file, i+1, firstWhy(resurrect, line))
		}
	}
}

func TestDocsAvoidVagueLanguage(t *testing.T) {
	// 这些词把决策推回给读者。文档要么给出确定值，要么写明这是真实的未知项。
	banned := []string{"通常", "视情况", "差不多", "建议自行配置"}
	scopes := append(markdownFiles(t, "docs"), "README.md", "AGENTS.md")
	for _, file := range scopes {
		if _, ok := readIfExists(t, file); !ok {
			continue
		}
		lines := strings.Split(mustRead(t, file), "\n")
		for i, line := range lines {
			for _, word := range banned {
				if strings.Contains(line, word) {
					t.Errorf("%s:%d uses vague wording %q: %q", file, i+1, word, strings.TrimSpace(line))
				}
			}
		}
	}
}

func TestMovedPagesAreNotReferencedAsAlive(t *testing.T) {
	m := loadMatrix(t)
	scopes := append(markdownFiles(t, "docs"), "README.md", "README.en.md", "AGENTS.md", "SUPPORT.md", "CONTRIBUTING.md", "SECURITY.md", "fly/README.md")
	for moved, newPath := range m.Documentation.MovedPages {
		base := filepath.Base(moved)
		for _, file := range scopes {
			if file == moved {
				continue
			}
			content, ok := readIfExists(t, file)
			if !ok {
				continue
			}
			// 只拦「当作活文档链接」的写法：markdown 链接或站点路径。
			patterns := []string{
				"(" + strings.TrimSuffix(base, ".md") + ".md)",
				"/" + strings.TrimSuffix(moved, ".md"),
				"/en/" + strings.TrimSuffix(strings.TrimPrefix(moved, "docs/"), ".md"),
			}
			for _, p := range patterns {
				if strings.Contains(content, p) {
					t.Errorf("%s still links to %s, which moved to %s", file, moved, newPath)
				}
			}
		}
	}
}
