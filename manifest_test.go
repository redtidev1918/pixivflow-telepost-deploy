package main

// manifest_test.go —— Phase 2 的部署清单测试。
//
// 关注两件事：
//  1. 推断与校验的行为（能不能从产物认清部署、非法组合是否带规则 id 被拦下）；
//  2. 矩阵与求值器的结构一致性（内嵌矩阵不过期、每条规则要么机器可判定要么声明由谁守护、
//     断言里的字段名真实存在）。第 2 类才是防漂移的关键：字段名写错不能让规则静默失效。

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func mustMatrix(t *testing.T) *archMatrix {
	t.Helper()
	mx, err := archMatrixData()
	if err != nil {
		t.Fatalf("加载内嵌架构矩阵失败：%v", err)
	}
	return mx
}

func findingFor(fs []finding, ruleID string) (finding, bool) {
	for _, f := range fs {
		if f.RuleID == ruleID {
			return f, true
		}
	}
	return finding{}, false
}

func hasInvalid(fs []finding) bool {
	for _, f := range fs {
		if f.Level == "invalid" {
			return true
		}
	}
	return false
}

// ---------------------------------------------------------------------------
// 推断
// ---------------------------------------------------------------------------

func TestManifestInfersSplitWorkerFromTwoFlyConfigs(t *testing.T) {
	mx := mustMatrix(t)
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "fly"), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"deploy.pixivflow.toml", "deploy.telepost.toml"} {
		if err := os.WriteFile(filepath.Join(dir, "fly", name), []byte("app = \"x\"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	m, _, err := inferManifest(mx, dir, "")
	if err != nil {
		t.Fatalf("推断失败：%v", err)
	}
	if m.Preset != "split-worker" {
		t.Errorf("preset = %q，期望 split-worker", m.Preset)
	}
	if m.Platform != "flyio" {
		t.Errorf("platform = %q，期望 flyio", m.Platform)
	}
	if m.ExecutorLifecycle != "wake-run-exit" {
		t.Errorf("executorLifecycle = %q，期望 wake-run-exit（来自矩阵 rolePlacement）", m.ExecutorLifecycle)
	}
	if m.Switches.Clock == "" {
		t.Errorf("clock 未从矩阵 defaults 补齐")
	}
	if hasInvalid(validateManifest(mx, m)) {
		t.Errorf("推断出的 split-worker 清单不应包含非法组合")
	}
}

func TestManifestInfersSingleHostAndProfileFromCompose(t *testing.T) {
	mx := mustMatrix(t)
	dir := t.TempDir()
	compose := `services:
  telepost:
    mem_limit: ${TELEPOST_MEMORY_LIMIT:-320m}
  pixivflow:
    mem_limit: ${PIXIVFLOW_MEMORY_LIMIT:-192m}
`
	if err := os.WriteFile(filepath.Join(dir, "docker-compose.yml"), []byte(compose), 0o644); err != nil {
		t.Fatal(err)
	}

	m, notes, err := inferManifest(mx, dir, "")
	if err != nil {
		t.Fatalf("推断失败：%v", err)
	}
	if m.Preset != "single-host" || m.Platform != "docker-compose" {
		t.Errorf("得到 %s/%s，期望 single-host/docker-compose", m.Preset, m.Platform)
	}
	// 320 + 192 = 512，应与 512m 档精确匹配。
	if m.ResourceProfile != "512m" {
		t.Errorf("resourceProfile = %q，期望 512m（compose 合计 512 MiB）", m.ResourceProfile)
	}
	if !strings.Contains(strings.Join(notes, "\n"), "512") {
		t.Errorf("推断说明里应提到合计预算，实际：%v", notes)
	}
}

func TestManifestComposeBudgetMismatchIsReportedNotSilentlyRounded(t *testing.T) {
	mx := mustMatrix(t)
	dir := t.TempDir()
	compose := `services:
  telepost:
    mem_limit: ${TELEPOST_MEMORY_LIMIT:-320m}
  pixivflow:
    mem_limit: ${PIXIVFLOW_MEMORY_LIMIT:-256m}
`
	if err := os.WriteFile(filepath.Join(dir, "docker-compose.yml"), []byte(compose), 0o644); err != nil {
		t.Fatal(err)
	}
	m, notes, err := inferManifest(mx, dir, "")
	if err != nil {
		t.Fatalf("推断失败：%v", err)
	}
	// 576 MiB 不对应任何档位：选能容纳它的最小档位，并且必须把偏差说出来。
	if m.ResourceProfile != "1g" {
		t.Errorf("resourceProfile = %q，期望 1g（装得下 576 MiB 的最小档位）", m.ResourceProfile)
	}
	joined := strings.Join(notes, "\n")
	if !strings.Contains(joined, "偏差") {
		t.Errorf("compose 限额与档位不一致时必须显式说明，实际：%v", notes)
	}
}

func TestManifestInferenceFailsWithoutArtifacts(t *testing.T) {
	mx := mustMatrix(t)
	if _, _, err := inferManifest(mx, t.TempDir(), ""); err == nil {
		t.Fatalf("空目录应当推断失败并要求 --preset")
	}
}

func TestManifestInferenceHonoursExplicitPreset(t *testing.T) {
	mx := mustMatrix(t)
	m, notes, err := inferManifest(mx, t.TempDir(), "remote-worker")
	if err != nil {
		t.Fatalf("显式 preset 不应失败：%v", err)
	}
	if m.Preset != "remote-worker" {
		t.Errorf("preset = %q，期望 remote-worker", m.Preset)
	}
	if len(notes) == 0 {
		t.Errorf("显式声明应当留下说明，避免被误读成从产物推断")
	}
	if _, _, err := inferManifest(mx, t.TempDir(), "kubernetes"); err == nil {
		t.Errorf("未知 preset 必须报错")
	}
}

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

func TestManifestValidationAcceptsEveryPresetDefault(t *testing.T) {
	mx := mustMatrix(t)
	for _, preset := range sortedKeys(mx.Presets) {
		m := defaultManifest(mx, preset)
		fs := validateManifest(mx, m)
		if hasInvalid(fs) {
			t.Errorf("preset %s 的默认清单被判为非法：%+v", preset, fs)
		}
	}
}

func TestManifestValidationRejectsIllegalCombinations(t *testing.T) {
	mx := mustMatrix(t)
	cases := []struct {
		name   string
		mutate func(*DeploymentManifest)
		wantID string
		level  string
	}{
		{
			name:   "stopped executor with internal clock",
			mutate: func(m *DeploymentManifest) { m.Switches.Clock = "internal" },
			wantID: "wake-run-exit-without-external-clock",
			level:  "invalid",
		},
		{
			name:   "review disabled",
			mutate: func(m *DeploymentManifest) { m.Switches.Review = "disabled" },
			wantID: "review-disabled",
			level:  "invalid",
		},
		{
			name:   "bundled proxy on 256m",
			mutate: func(m *DeploymentManifest) { m.Switches.Network = "proxy"; m.ResourceProfile = "256m" },
			wantID: "bundled-proxy-on-256m",
			level:  "invalid",
		},
		{
			name:   "search on 512m",
			mutate: func(m *DeploymentManifest) { m.Switches.Search = "enabled"; m.ResourceProfile = "512m" },
			wantID: "search-on-512m",
			level:  "invalid",
		},
		{
			name:   "three bots co-located on 512m",
			mutate: func(m *DeploymentManifest) { m.Switches.Bots = 3 },
			wantID: "many-bots-on-512m",
			level:  "limitation",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			m := defaultManifest(mx, "split-worker")
			if tc.wantID == "review-disabled" || tc.wantID == "search-on-512m" ||
				tc.wantID == "bundled-proxy-on-256m" || tc.wantID == "many-bots-on-512m" {
				m = defaultManifest(mx, "single-host")
			}
			tc.mutate(&m)
			f, ok := findingFor(validateManifest(mx, m), tc.wantID)
			if !ok {
				t.Fatalf("期望命中规则 %s，实际：%+v", tc.wantID, validateManifest(mx, m))
			}
			if f.Level != tc.level {
				t.Errorf("规则 %s 的级别是 %s，期望 %s", tc.wantID, f.Level, tc.level)
			}
			if strings.TrimSpace(f.Text) == "" {
				t.Errorf("规则 %s 没有给出理由文本", tc.wantID)
			}
		})
	}
}

func TestManifestValidationRejectsUnknownValues(t *testing.T) {
	mx := mustMatrix(t)
	cases := map[string]struct {
		m      DeploymentManifest
		wantID string
	}{
		"preset":    {DeploymentManifest{Preset: "kubernetes"}, "unknown-preset"},
		"profile":   {DeploymentManifest{Preset: "single-host", ResourceProfile: "4g"}, "unknown-resource-profile"},
		"switch":    {DeploymentManifest{Preset: "single-host", Switches: manifestSwitches{Clock: "cron-job"}}, "switch-value"},
		"lifecycle": {DeploymentManifest{Preset: "single-host", ExecutorLifecycle: "wake-run-exit"}, "lifecycle-not-supported"},
		"platform":  {DeploymentManifest{Preset: "split-worker", Platform: "systemd"}, "platform-not-supported"},
		"bots":      {DeploymentManifest{Preset: "single-host", Switches: manifestSwitches{Bots: -1}}, "switch-value"},
		"version":   {DeploymentManifest{ManifestVersion: 99, Preset: "single-host"}, "manifest-version"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			if _, ok := findingFor(validateManifest(mx, tc.m), tc.wantID); !ok {
				t.Errorf("期望命中 %s，实际：%+v", tc.wantID, validateManifest(mx, tc.m))
			}
		})
	}
}

func TestManifestSleepPresetIsExperimentalNotInvalid(t *testing.T) {
	mx := mustMatrix(t)
	m := defaultManifest(mx, "single-machine-worker-sleep")
	fs := validateManifest(mx, m)
	if hasInvalid(fs) {
		t.Fatalf("未实现的 preset 是 experimental，不是 invalid：%+v", fs)
	}
	f, ok := findingFor(fs, "single-machine-worker-sleep")
	if !ok || f.Level != "experimental" {
		t.Fatalf("期望 experimental 级提示，实际：%+v", fs)
	}
}

// ---------------------------------------------------------------------------
// 结构一致性（防漂移）
// ---------------------------------------------------------------------------

func TestEmbeddedMatrixMatchesRepositoryFile(t *testing.T) {
	embedded := strings.TrimSpace(string(matrixJSON))
	onDisk, err := os.ReadFile(matrixPath)
	if err != nil {
		t.Fatalf("读取 %s 失败：%v", matrixPath, err)
	}
	if embedded != strings.TrimSpace(string(onDisk)) {
		t.Fatalf("内嵌架构矩阵与 %s 不一致：改了矩阵却没重新构建/提交就会发生这种漂移", matrixPath)
	}
}

func TestEveryCombinationRuleIsMachineCheckedOrExplicitlyElsewhere(t *testing.T) {
	mx := mustMatrix(t)
	for _, bucket := range sortedKeys(mx.CombinationRules) {
		for _, rule := range mx.CombinationRules[bucket] {
			hasPredicate := rule.Predicate != nil && len(rule.Predicate.All) > 0
			hasElsewhere := strings.TrimSpace(rule.CheckableBy) != ""
			switch {
			case hasPredicate && hasElsewhere:
				t.Errorf("规则 %s 既标了 predicate 又标了 checkableBy，职责不清", rule.ID)
			case !hasPredicate && !hasElsewhere:
				t.Errorf("规则 %s 既不可机器判定，也没说明由谁守护——这样它会静默失效", rule.ID)
			}
		}
	}
}

func TestPredicateFieldsAreResolvableForEveryPreset(t *testing.T) {
	mx := mustMatrix(t)
	// 字段名写错必须让测试失败，而不是让规则静默不匹配。
	for _, preset := range sortedKeys(mx.Presets) {
		fields := manifestFields(mx, applyDefaults(mx, defaultManifest(mx, preset)))
		for _, bucket := range sortedKeys(mx.CombinationRules) {
			for _, rule := range mx.CombinationRules[bucket] {
				if rule.Predicate == nil {
					continue
				}
				for _, c := range rule.Predicate.All {
					if _, ok := fields[c.Field]; !ok {
						t.Errorf("规则 %s 引用了未知字段 %q（preset %s）", rule.ID, c.Field, preset)
					}
					if _, err := evalCondition(fields, c); err != nil {
						t.Errorf("规则 %s 的断言求值失败：%v", rule.ID, err)
					}
				}
			}
		}
	}
}

func TestEveryPresetDeclaresItsDefaultExecutorLifecycle(t *testing.T) {
	mx := mustMatrix(t)
	// remote-worker 允许 wake-run-exit 与 always-on 两种；若默认值靠「取第一个」推导，
	// 就会得到与默认 clock=internal 自相矛盾的组合。默认值必须是显式声明。
	for _, preset := range sortedKeys(mx.Presets) {
		if mx.Presets[preset].Defaults.ExecutorLifecycle == "" {
			t.Errorf("preset %s 没有声明 defaults.executorLifecycle", preset)
		}
	}
}

func TestManifestDefaultsComeFromTheMatrix(t *testing.T) {
	mx := mustMatrix(t)
	for _, preset := range sortedKeys(mx.Presets) {
		want := mx.Presets[preset].Defaults
		got := defaultManifest(mx, preset)
		if got.Switches.Clock != want.Clock || got.Switches.TelegramIngress != want.TelegramIngress ||
			got.Switches.Network != want.Network || got.Switches.Bots != want.Bots ||
			got.Switches.Search != want.Search || got.ResourceProfile != want.ResourceProfile ||
			got.ExecutorLifecycle != want.ExecutorLifecycle {
			t.Errorf("preset %s 的默认值没有完全来自矩阵：got %+v want %+v", preset, got, want)
		}
	}
}

func TestManifestWriteThenCheckRoundTrip(t *testing.T) {
	mx := mustMatrix(t)
	dir := t.TempDir()
	m := defaultManifest(mx, "single-host")
	m.Switches.Bots = 3

	blob, err := json.MarshalIndent(applyDefaults(mx, m), "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, manifestFileName)
	if err := os.WriteFile(path, append(blob, '\n'), 0o644); err != nil {
		t.Fatal(err)
	}

	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var reloaded DeploymentManifest
	if err := json.Unmarshal(raw, &reloaded); err != nil {
		t.Fatalf("写出的清单必须能被读回：%v", err)
	}
	if reloaded.Preset != "single-host" || reloaded.Switches.Bots != 3 {
		t.Errorf("往返后内容变了：%+v", reloaded)
	}
	if _, ok := findingFor(validateManifest(mx, reloaded), "many-bots-on-512m"); !ok {
		t.Errorf("3 个 Bot 在 512m 档应命中 many-bots-on-512m")
	}
}

func TestManifestContractIsDeclaredInTheMatrix(t *testing.T) {
	mx := mustMatrix(t)
	if mx.Manifest.File != manifestFileName {
		t.Errorf("矩阵声明的清单文件名是 %q，代码用的是 %q", mx.Manifest.File, manifestFileName)
	}
	if mx.Manifest.RuntimeDep {
		t.Errorf("manifest 不是运行时依赖：矩阵的 manifest.runtimeDependency 必须为 false")
	}
	for _, field := range []string{"preset", "platform", "executorLifecycle", "resourceProfile", "switches"} {
		if _, ok := mx.Manifest.Fields[field]; !ok {
			t.Errorf("矩阵的 manifest.fields 缺少字段 %q", field)
		}
	}
	if !containsString(mx.Manifest.RequiredFields, "preset") {
		t.Errorf("preset 必须是必填字段")
	}
}

func TestHostPlatformExcludesTheClockPlane(t *testing.T) {
	mx := mustMatrix(t)
	// cloudflare 是时钟平面，不是跑角色的平台。
	for _, preset := range sortedKeys(mx.Presets) {
		for _, p := range hostPlatformsFor(mx, preset) {
			if p == "cloudflare" {
				t.Errorf("preset %s 的宿主平台里出现了时钟平面 cloudflare", preset)
			}
		}
	}
	if got := hostPlatformsFor(mx, "split-worker"); len(got) != 1 || got[0] != "flyio" {
		t.Errorf("split-worker 的宿主平台应为 [flyio]，实际 %v", got)
	}
}
