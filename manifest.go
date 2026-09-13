package main

// manifest.go —— Phase 2：统一 deployment manifest。
//
// manifest 声明「这是一套什么部署」：preset、平台、executor 生命周期、资源档位，
// 以及少数几个允许的功能开关。定位是**部署编译器的输入契约**，不是运行时依赖：
// 业务代码永远不读它，也不会由它推导出平台分支。
//
// 权威来源是 docs/reference/architecture-matrix.json，构建时用 go:embed 打进二进制，
// 所以随 Release 分发的 deploy 二进制自带它所遵守的契约，不需要仓库在旁边。

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

//go:embed docs/reference/architecture-matrix.json
var matrixJSON []byte

const manifestFileName = "deployment.manifest.json"

// ---------------------------------------------------------------------------
// 矩阵结构（只声明 manifest 编译需要的字段）
// ---------------------------------------------------------------------------

type archMatrix struct {
	Enums struct {
		Lifecycle       []string `json:"lifecycle"`
		ClockProvider   []string `json:"clockProvider"`
		TelegramIngress []string `json:"telegramIngress"`
		NetworkMode     []string `json:"networkMode"`
		SearchMode      []string `json:"searchMode"`
	} `json:"enums"`
	Presets map[string]struct {
		Title          map[string]string `json:"title"`
		PlatformStatus map[string]struct {
			Status string `json:"status"`
		} `json:"platformStatus"`
		Defaults struct {
			Clock             string `json:"clock"`
			TelegramIngress   string `json:"telegramIngress"`
			Network           string `json:"network"`
			Bots              int    `json:"bots"`
			Search            string `json:"search"`
			Review            string `json:"review"`
			ResourceProfile   string `json:"resourceProfile"`
			ExecutorLifecycle string `json:"executorLifecycle"`
		} `json:"defaults"`
		RolePlacement map[string]struct {
			Lifecycle string `json:"lifecycle"`
			Provider  string `json:"provider"`
		} `json:"rolePlacement"`
		CredentialBoundary map[string]any `json:"credentialBoundary"`
	} `json:"presets"`
	FeatureSwitches map[string]struct {
		Values  json.RawMessage `json:"values"`
		Default json.RawMessage `json:"default"`
	} `json:"featureSwitches"`
	ResourceProfiles struct {
		Profiles map[string]struct {
			TotalBudgetMiB int `json:"totalBudgetMiB"`
		} `json:"profiles"`
	} `json:"resourceProfiles"`
	PlatformSupport []struct {
		Platform string `json:"platform"`
		Presets  []string
		Role     string `json:"role"`
	} `json:"platformSupport"`
	CombinationRules map[string][]combRule `json:"combinationRules"`
	Manifest         struct {
		File            string                     `json:"file"`
		ManifestVersion int                        `json:"manifestVersion"`
		Authority       string                     `json:"authority"`
		RequiredFields  []string                   `json:"requiredFields"`
		Fields          map[string]json.RawMessage `json:"fields"`
		RuntimeDep      bool                       `json:"runtimeDependency"`
	} `json:"manifest"`
}

type combRule struct {
	ID          string     `json:"id"`
	When        string     `json:"when"`
	Why         string     `json:"why"`
	Limitation  string     `json:"limitation"`
	CheckableBy string     `json:"checkableBy"`
	Predicate   *predicate `json:"predicate"`
}

type predicate struct {
	All []condition `json:"all"`
}

type condition struct {
	Field string `json:"field"`
	Op    string `json:"op"`
	Value any    `json:"value"`
}

var (
	matrixCache *archMatrix
	matrixErr   error
)

func archMatrixData() (*archMatrix, error) {
	if matrixCache != nil || matrixErr != nil {
		return matrixCache, matrixErr
	}
	var m archMatrix
	if err := json.Unmarshal(matrixJSON, &m); err != nil {
		matrixErr = fmt.Errorf("解析内嵌架构矩阵失败：%w", err)
		return nil, matrixErr
	}
	if len(m.Presets) == 0 {
		matrixErr = fmt.Errorf("内嵌架构矩阵没有 preset")
		return nil, matrixErr
	}
	matrixCache = &m
	return matrixCache, nil
}

// ---------------------------------------------------------------------------
// manifest 本身
// ---------------------------------------------------------------------------

// DeploymentManifest 是「这套部署是什么」的声明。
type DeploymentManifest struct {
	ManifestVersion   int              `json:"manifestVersion"`
	Preset            string           `json:"preset"`
	Platform          string           `json:"platform,omitempty"`
	ExecutorLifecycle string           `json:"executorLifecycle,omitempty"`
	ResourceProfile   string           `json:"resourceProfile,omitempty"`
	Switches          manifestSwitches `json:"switches"`
}

// 开关名与顺序固定：manifest 的 diff 必须可读。
type manifestSwitches struct {
	Clock           string `json:"clock,omitempty"`
	TelegramIngress string `json:"telegramIngress,omitempty"`
	Network         string `json:"network,omitempty"`
	Bots            int    `json:"bots,omitempty"`
	Search          string `json:"search,omitempty"`
	Review          string `json:"review,omitempty"`
}

type finding struct {
	Level  string // invalid | experimental | limitation | supported | note
	RuleID string
	Text   string
}

// defaultPlatform 选实现程度最高的平台；同档按字母序，保证结果稳定。
// 平台是独立维度：某个 preset 完全可能 compose 已实现、Fly 还是 planned。
func defaultPlatform(status map[string]struct {
	Status string `json:"status"`
}) string {
	rank := map[string]int{"stable": 0, "beta": 1, "planned": 2, "not-implemented": 3}
	best, bestScore := "", 99
	for name, entry := range status {
		score, ok := rank[entry.Status]
		if !ok {
			score = 4
		}
		if score < bestScore || (score == bestScore && (best == "" || name < best)) {
			best, bestScore = name, score
		}
	}
	return best
}

// defaultManifest 用矩阵里该 preset 的默认值构造一份 manifest。
func defaultManifest(mx *archMatrix, preset string) DeploymentManifest {
	p := mx.Presets[preset]
	m := DeploymentManifest{
		ManifestVersion: mx.Manifest.ManifestVersion,
		Preset:          preset,
		ResourceProfile: p.Defaults.ResourceProfile,
		Switches: manifestSwitches{
			Clock:           p.Defaults.Clock,
			TelegramIngress: p.Defaults.TelegramIngress,
			Network:         p.Defaults.Network,
			Bots:            p.Defaults.Bots,
			Search:          p.Defaults.Search,
			Review:          p.Defaults.Review,
		},
	}
	if m.ManifestVersion == 0 {
		m.ManifestVersion = 1
	}
	// 默认平台取实现程度最高的那个（stable > beta > planned），同档按字母序：
	// 平台是独立维度，某个 preset 完全可能 compose 已实现、Fly 还是 planned。
	if platform := defaultPlatform(p.PlatformStatus); platform != "" {
		m.Platform = platform
	}
	if m.Switches.Review == "" {
		m.Switches.Review = "enabled"
	}
	// executor 生命周期以矩阵 defaults 为准。当 preset 允许多种时（例如 remote-worker），
	// 默认值必须与默认 clock 自洽，所以它是一条显式声明，而不是从 "a | b" 里取第一个。
	m.ExecutorLifecycle = p.Defaults.ExecutorLifecycle
	if m.ExecutorLifecycle == "" {
		if rp, ok := p.RolePlacement["executor"]; ok {
			m.ExecutorLifecycle = firstAlternative(rp.Lifecycle)
		}
	}
	return m
}

func firstAlternative(s string) string {
	for _, part := range strings.Split(s, "|") {
		if v := strings.TrimSpace(part); v != "" {
			return v
		}
	}
	return ""
}

func alternatives(s string) []string {
	var out []string
	for _, part := range strings.Split(s, "|") {
		if v := strings.TrimSpace(part); v != "" {
			out = append(out, v)
		}
	}
	return out
}

// applyDefaults 用矩阵补齐 manifest 省略的字段，返回生效后的副本。
func applyDefaults(mx *archMatrix, in DeploymentManifest) DeploymentManifest {
	out := in
	base := defaultManifest(mx, in.Preset)
	if out.ManifestVersion == 0 {
		out.ManifestVersion = base.ManifestVersion
	}
	if out.Platform == "" {
		out.Platform = base.Platform
	}
	if out.ExecutorLifecycle == "" {
		out.ExecutorLifecycle = base.ExecutorLifecycle
	}
	if out.ResourceProfile == "" {
		out.ResourceProfile = base.ResourceProfile
	}
	if out.Switches.Clock == "" {
		out.Switches.Clock = base.Switches.Clock
	}
	if out.Switches.TelegramIngress == "" {
		out.Switches.TelegramIngress = base.Switches.TelegramIngress
	}
	if out.Switches.Network == "" {
		out.Switches.Network = base.Switches.Network
	}
	if out.Switches.Bots == 0 {
		out.Switches.Bots = base.Switches.Bots
	}
	if out.Switches.Search == "" {
		out.Switches.Search = base.Switches.Search
	}
	if out.Switches.Review == "" {
		out.Switches.Review = base.Switches.Review
	}
	return out
}

// manifestFields 把生效后的 manifest 摊平成断言可求值的字段表。
// 派生字段（profileBudgetMiB、*Credential*）来自矩阵，不是声明。
func manifestFields(mx *archMatrix, m DeploymentManifest) map[string]any {
	f := map[string]any{
		"preset":            m.Preset,
		"platform":          m.Platform,
		"executorLifecycle": m.ExecutorLifecycle,
		"resourceProfile":   m.ResourceProfile,
		"clock":             m.Switches.Clock,
		"telegramIngress":   m.Switches.TelegramIngress,
		"network":           m.Switches.Network,
		"bots":              m.Switches.Bots,
		"search":            m.Switches.Search,
		"review":            m.Switches.Review,
	}
	if prof, ok := mx.ResourceProfiles.Profiles[m.ResourceProfile]; ok {
		f["profileBudgetMiB"] = prof.TotalBudgetMiB
	}
	if p, ok := mx.Presets[m.Preset]; ok {
		// 主机级隔离是部署事实；「executor 是否持有 Telegram 凭据」恒为 false（SI-1）。
		if v, ok := p.CredentialBoundary["hostCredentialIsolation"].(bool); ok {
			f["hostCredentialIsolation"] = v
		}
		f["executorHoldsTelegramCredentials"] = false
	}
	return f
}

// evalCondition 求值单条断言。未知字段返回错误，避免「字段名写错就静默通过」。
func evalCondition(fields map[string]any, c condition) (bool, error) {
	lhs, ok := fields[c.Field]
	if !ok {
		return false, fmt.Errorf("未知字段 %q", c.Field)
	}
	switch c.Op {
	case "eq", "ne":
		equal := fmt.Sprint(lhs) == fmt.Sprint(c.Value)
		if c.Op == "ne" {
			return !equal, nil
		}
		return equal, nil
	case "in", "notIn":
		list, ok := c.Value.([]any)
		if !ok {
			return false, fmt.Errorf("in/notIn 的 value 必须是数组（字段 %q）", c.Field)
		}
		found := false
		for _, item := range list {
			if fmt.Sprint(lhs) == fmt.Sprint(item) {
				found = true
				break
			}
		}
		if c.Op == "notIn" {
			return !found, nil
		}
		return found, nil
	case "gte", "lte", "gt", "lt":
		l, lok := toFloat(lhs)
		r, rok := toFloat(c.Value)
		if !lok || !rok {
			return false, fmt.Errorf("数值比较的字段或值不是数字（字段 %q）", c.Field)
		}
		switch c.Op {
		case "gte":
			return l >= r, nil
		case "lte":
			return l <= r, nil
		case "gt":
			return l > r, nil
		default:
			return l < r, nil
		}
	default:
		return false, fmt.Errorf("未知操作符 %q", c.Op)
	}
}

func toFloat(v any) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case int:
		return float64(n), true
	case json.Number:
		f, err := n.Float64()
		return f, err == nil
	default:
		return 0, false
	}
}

// validateManifest 校验 manifest 与架构矩阵的一致性。
// 返回的 findings 按「最严重」优先排序：非法组合 > 未实现 > 限制 > 已满足。
func validateManifest(mx *archMatrix, in DeploymentManifest) []finding {
	var out []finding
	add := func(level, rule, text string) {
		out = append(out, finding{Level: level, RuleID: rule, Text: text})
	}

	p, known := mx.Presets[in.Preset]
	if !known {
		add("invalid", "unknown-preset", fmt.Sprintf("未知 preset：%q（架构矩阵里只有 %s）", in.Preset, strings.Join(sortedKeys(mx.Presets), ", ")))
		return out
	}
	m := applyDefaults(mx, in)

	// 版本
	if in.ManifestVersion != 0 && in.ManifestVersion != mx.Manifest.ManifestVersion {
		add("invalid", "manifest-version", fmt.Sprintf("manifestVersion=%d，本二进制支持的版本是 %d", in.ManifestVersion, mx.Manifest.ManifestVersion))
	}

	// 平台必须属于该 preset 允许的平台，且是「跑角色」的平台（cloudflare 是时钟平面）
	if m.Platform != "" {
		hostPlatforms := hostPlatformsFor(mx, m.Preset)
		if !containsString(hostPlatforms, m.Platform) {
			add("invalid", "platform-not-supported", fmt.Sprintf("preset %s 不支持平台 %q（可用：%s）", m.Preset, m.Platform, strings.Join(hostPlatforms, ", ")))
		}
	}

	// executor 生命周期必须是矩阵允许的可选值之一
	allowedLife := alternatives(p.RolePlacement["executor"].Lifecycle)
	if m.ExecutorLifecycle != "" && len(allowedLife) > 0 && !containsString(allowedLife, m.ExecutorLifecycle) {
		add("invalid", "lifecycle-not-supported", fmt.Sprintf("preset %s 的 executor 生命周期只能是 %s，收到 %q", m.Preset, strings.Join(allowedLife, " / "), m.ExecutorLifecycle))
	}

	// 资源档位必须是矩阵里的档位
	if _, ok := mx.ResourceProfiles.Profiles[m.ResourceProfile]; !ok {
		add("invalid", "unknown-resource-profile", fmt.Sprintf("未知资源档位：%q（可用：%s）", m.ResourceProfile, strings.Join(sortedKeys(mx.ResourceProfiles.Profiles), ", ")))
	}

	// 开关取值必须落在 featureSwitches 允许的集合里
	for _, sw := range []struct {
		name   string
		value  string
		values []string
	}{
		{"clock", m.Switches.Clock, mx.Enums.ClockProvider},
		{"telegramIngress", m.Switches.TelegramIngress, mx.Enums.TelegramIngress},
		{"network", m.Switches.Network, mx.Enums.NetworkMode},
		{"search", m.Switches.Search, mx.Enums.SearchMode},
	} {
		if sw.value == "" {
			continue
		}
		if !containsString(sw.values, sw.value) {
			add("invalid", "switch-value", fmt.Sprintf("开关 %s=%q 不是合法取值（可用：%s）", sw.name, sw.value, strings.Join(sw.values, ", ")))
		}
	}
	if m.Switches.Bots < 1 {
		add("invalid", "switch-value", fmt.Sprintf("开关 bots=%d 必须 >= 1", m.Switches.Bots))
	}

	// 组合规则：求值所有带 predicate 的规则
	fields := manifestFields(mx, m)
	buckets := sortedKeys(mx.CombinationRules)
	for _, bucket := range buckets {
		for _, rule := range mx.CombinationRules[bucket] {
			if rule.Predicate == nil {
				continue
			}
			match := true
			for _, c := range rule.Predicate.All {
				got, err := evalCondition(fields, c)
				if err != nil {
					add("invalid", rule.ID, fmt.Sprintf("规则求值失败：%v", err))
					match = false
					break
				}
				if !got {
					match = false
					break
				}
			}
			if !match {
				continue
			}
			switch bucket {
			case "invalid":
				add("invalid", rule.ID, rule.Why)
			case "experimental":
				add("experimental", rule.ID, rule.Why)
			case "supportedWithLimitations":
				add("limitation", rule.ID, rule.Limitation)
			case "supported":
				add("supported", rule.ID, rule.Why)
			}
		}
	}
	sortFindings(out)
	return out
}

func sortFindings(fs []finding) {
	weight := map[string]int{"invalid": 0, "experimental": 1, "limitation": 2, "supported": 3, "note": 4}
	sort.SliceStable(fs, func(i, j int) bool {
		if weight[fs[i].Level] != weight[fs[j].Level] {
			return weight[fs[i].Level] < weight[fs[j].Level]
		}
		return fs[i].RuleID < fs[j].RuleID
	})
}

// hostPlatformsFor 返回该 preset 可运行角色的平台（排除 clock 平面，例如 cloudflare）。
func hostPlatformsFor(mx *archMatrix, preset string) []string {
	var out []string
	for _, entry := range mx.PlatformSupport {
		if entry.Role == "clock" {
			continue
		}
		if containsString(entry.Presets, preset) {
			out = append(out, entry.Platform)
		}
	}
	sort.Strings(out)
	return out
}

func sortedKeys[T any](m map[string]T) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// ---------------------------------------------------------------------------
// 从部署目录推断
// ---------------------------------------------------------------------------

// inferManifest 从部署目录的产物推断 preset 与平台。
// 只推断能**证明**的东西：两份 Fly 配置 => split-worker；compose => single-host；
// systemd 单元 => single-host。remote-worker 与 sleep preset 无法从产物判定，
// 必须由 --preset 显式声明。
func inferManifest(mx *archMatrix, dir, presetOverride string) (DeploymentManifest, []string, error) {
	var notes []string

	if presetOverride != "" {
		if _, ok := mx.Presets[presetOverride]; !ok {
			return DeploymentManifest{}, nil, fmt.Errorf("未知 preset：%q（可用：%s）", presetOverride, strings.Join(sortedKeys(mx.Presets), ", "))
		}
		m := defaultManifest(mx, presetOverride)
		return m, []string{"preset 由 --preset 显式声明，未从产物推断"}, nil
	}

	pfFly := filepath.Join(dir, "fly", "deploy.pixivflow.toml")
	tpFly := filepath.Join(dir, "fly", "deploy.telepost.toml")
	compose := ""
	for _, name := range []string{"docker-compose.yml", "compose.yaml"} {
		if fileExists(filepath.Join(dir, name)) {
			compose = filepath.Join(dir, name)
			break
		}
	}

	switch {
	case fileExists(pfFly) && fileExists(tpFly):
		m := defaultManifest(mx, "split-worker")
		notes = append(notes, "发现两份 Fly 配置，判定为 split-worker")
		if compose != "" {
			notes = append(notes, "同一目录里也有 compose：仓库同时承载两条路径，这里按 Fly 配置判定；要声明 compose 路径用 --preset single-host 或写入清单")
		}
		notes = append(notes, inferProfileNote(mx, &m, "split-worker", ""))
		return m, notes, nil
	case compose != "":
		m := defaultManifest(mx, "single-host")
		m.Platform = "docker-compose"
		notes = append(notes, "发现 "+filepath.Base(compose)+"，判定为 single-host / docker-compose")
		notes = append(notes, inferProfileNote(mx, &m, "single-host", compose))
		return m, notes, nil
	case hasSystemdUnit(dir):
		m := defaultManifest(mx, "single-host")
		m.Platform = "systemd"
		notes = append(notes, "发现 systemd 单元，判定为 single-host / systemd")
		return m, notes, nil
	}
	return DeploymentManifest{}, nil, fmt.Errorf("无法识别部署类型：目录里既没有两份 Fly 配置，也没有 docker-compose.yml 或 systemd 单元；用 --preset 显式声明")
}

// inferProfileNote 只在能证明档位时改写 resourceProfile。
// co-located preset 的合计预算可以直接相加；多机部署的「档位」不由容器限额决定，
// 因此保留 preset 默认值并说明原因——不猜。
func inferProfileNote(mx *archMatrix, m *DeploymentManifest, preset, composePath string) string {
	if preset != "single-host" || composePath == "" {
		return fmt.Sprintf("资源档位沿用 preset 默认值 %s（多机部署无法从产物证明档位）", m.ResourceProfile)
	}
	total := composeMemoryBudgetMiB(composePath)
	if total == 0 {
		return fmt.Sprintf("资源档位沿用 preset 默认值 %s（compose 里没有可解析的内存限额）", m.ResourceProfile)
	}
	names := sortedKeys(mx.ResourceProfiles.Profiles)
	for _, name := range names {
		if mx.ResourceProfiles.Profiles[name].TotalBudgetMiB == total {
			m.ResourceProfile = name
			return fmt.Sprintf("compose 内存限额合计 %d MiB，匹配档位 %s", total, name)
		}
	}
	// 没有精确匹配时选「装得下」的最小档位，并说明这与 compose 的实际限额不一致：
	// 档位是声明，compose 是生效配置，两者对不上必须让人看见，而不是被静默抹平。
	for _, name := range names {
		if mx.ResourceProfiles.Profiles[name].TotalBudgetMiB >= total {
			m.ResourceProfile = name
			return fmt.Sprintf("compose 内存限额合计 %d MiB 不对应任何档位，按能容纳它的最小档位 %s 计（声明与生效配置存在偏差，请核对 compose 的 mem_limit）", total, name)
		}
	}
	return fmt.Sprintf("compose 内存限额合计 %d MiB 超过所有档位，沿用 preset 默认值 %s", total, m.ResourceProfile)
}

// composeMemoryBudgetMiB 求和 compose 里 TelePost 与 PixivFlow 的内存限额。
// 只统计这两个角色：内置代理是可选 profile，是否启用无法从文件静态判定。
func composeMemoryBudgetMiB(path string) int {
	raw, err := os.ReadFile(path)
	if err != nil {
		return 0
	}
	total := 0
	for _, line := range strings.Split(string(raw), "\n") {
		trimmed := strings.TrimSpace(line)
		if !strings.HasPrefix(trimmed, "mem_limit:") {
			continue
		}
		value := strings.TrimSpace(strings.TrimPrefix(trimmed, "mem_limit:"))
		varName := ""
		// ${NAME:-320m} / ${NAME} / 320m
		if strings.HasPrefix(value, "${") {
			inner := strings.TrimSuffix(strings.TrimPrefix(value, "${"), "}")
			if i := strings.Index(inner, ":-"); i >= 0 {
				varName, value = inner[:i], inner[i+2:]
			} else {
				varName, value = inner, ""
			}
		}
		if !strings.Contains(varName, "TELEPOST") && !strings.Contains(varName, "PIXIVFLOW") {
			continue
		}
		if mib := parseMiB(strings.Trim(value, " \t\"'}")); mib > 0 {
			total += mib
		}
	}
	return total
}

// parseMiB 把 320m / 1g / 512 解析成 MiB。
func parseMiB(s string) int {
	s = strings.TrimSpace(strings.ToLower(s))
	if s == "" {
		return 0
	}
	mult := 1
	switch s[len(s)-1] {
	case 'm':
		s = s[:len(s)-1]
	case 'g':
		s = s[:len(s)-1]
		mult = 1024
	}
	n, ok := atoi(s)
	if !ok || n <= 0 {
		return 0
	}
	return n * mult
}

func hasSystemdUnit(dir string) bool {
	for _, sub := range []string{"systemd", filepath.Join("deploy", "systemd")} {
		entries, err := os.ReadDir(filepath.Join(dir, sub))
		if err != nil {
			continue
		}
		for _, e := range entries {
			if strings.HasSuffix(e.Name(), ".service") {
				return true
			}
		}
	}
	return false
}

func fileExists(path string) bool {
	st, err := os.Stat(path)
	return err == nil && !st.IsDir()
}

// ---------------------------------------------------------------------------
// 子命令
// ---------------------------------------------------------------------------

func cmdManifest(dir, presetOverride string, check, write bool) {
	mx, err := archMatrixData()
	if err != nil {
		die("%v", err)
	}

	manifestPath := filepath.Join(dir, manifestFileName)

	if check {
		if !fileExists(manifestPath) {
			die("找不到 %s：先生成它（deploy manifest --write），或去掉 --check", manifestPath)
		}
		raw, err := os.ReadFile(manifestPath)
		if err != nil {
			die("读取 %s 失败：%v", manifestPath, err)
		}
		var m DeploymentManifest
		if err := json.Unmarshal(raw, &m); err != nil {
			die("解析 %s 失败：%v", manifestPath, err)
		}
		printManifest(mx, m, applyDefaults(mx, m))
		if !reportFindings(mx, m) {
			os.Exit(1)
		}
		okf("%s 与架构矩阵一致", manifestFileName)
		return
	}

	var m DeploymentManifest
	var notes []string
	if fileExists(manifestPath) {
		raw, err := os.ReadFile(manifestPath)
		if err != nil {
			die("读取 %s 失败：%v", manifestPath, err)
		}
		if err := json.Unmarshal(raw, &m); err != nil {
			die("解析 %s 失败：%v", manifestPath, err)
		}
		notes = append(notes, "使用已存在的 "+manifestFileName)
	} else {
		inferred, inferNotes, err := inferManifest(mx, dir, presetOverride)
		if err != nil {
			die("%v", err)
		}
		m, notes = inferred, inferNotes
	}

	effective := applyDefaults(mx, m)
	printManifest(mx, m, effective)
	for _, n := range notes {
		infof("%s", n)
	}
	if !reportFindings(mx, m) {
		os.Exit(1)
	}

	if write {
		blob, err := json.MarshalIndent(effective, "", "  ")
		if err != nil {
			die("序列化 manifest 失败：%v", err)
		}
		blob = append(blob, '\n')
		if err := os.WriteFile(manifestPath, blob, 0o644); err != nil {
			die("写入 %s 失败：%v", manifestPath, err)
		}
		okf("已写入 %s", manifestPath)
	}
}

// printManifest 打印 manifest 摘要。
func printManifest(mx *archMatrix, declared, effective DeploymentManifest) {
	title := mx.Presets[effective.Preset].Title["zh"]
	if title == "" {
		title = effective.Preset
	}
	okf("部署清单：%s（%s）", effective.Preset, title)
	infof("平台 %s ｜ executor 生命周期 %s ｜ 档位 %s", dash(effective.Platform), dash(effective.ExecutorLifecycle), dash(effective.ResourceProfile))
	sw := effective.Switches
	infof("开关 clock=%s telegramIngress=%s network=%s bots=%d search=%s review=%s",
		dash(sw.Clock), dash(sw.TelegramIngress), dash(sw.Network), sw.Bots, dash(sw.Search), dash(sw.Review))
	if profile, ok := mx.ResourceProfiles.Profiles[effective.ResourceProfile]; ok {
		infof("该档位总预算 %d MiB", profile.TotalBudgetMiB)
	}
}

func dash(s string) string {
	if s == "" {
		return "-"
	}
	return s
}

// reportFindings 打印校验结论，返回是否可接受（没有 invalid 即接受）。
func reportFindings(mx *archMatrix, m DeploymentManifest) bool {
	findings := validateManifest(mx, m)
	checked, elsewhere := 0, 0
	for _, bucket := range sortedKeys(mx.CombinationRules) {
		for _, rule := range mx.CombinationRules[bucket] {
			if rule.Predicate != nil {
				checked++
			} else if rule.CheckableBy != "" {
				elsewhere++
			}
		}
	}

	ok := true
	for _, f := range findings {
		switch f.Level {
		case "invalid":
			failf("非法组合 %s：%s", f.RuleID, f.Text)
			ok = false
		case "experimental":
			warnf("实验性 %s：%s", f.RuleID, f.Text)
		case "limitation":
			warnf("已知限制 %s：%s", f.RuleID, f.Text)
		case "supported":
			okf("组合 %s 合法：%s", f.RuleID, f.Text)
		}
	}
	if ok {
		infof("已校验 %d 条 manifest 可判定规则；另有 %d 条属于配置文件层面（由架构文档测试与 control-plane 测试守护）", checked, elsewhere)
	}
	return ok
}

// manifestSummary 给 doctor 用：尽力给出当前目录的部署清单，读不到就返回空。
func manifestSummary(dir string) string {
	mx, err := archMatrixData()
	if err != nil {
		return ""
	}
	manifestPath := filepath.Join(dir, manifestFileName)
	var m DeploymentManifest
	if fileExists(manifestPath) {
		raw, err := os.ReadFile(manifestPath)
		if err != nil {
			return ""
		}
		if err := json.Unmarshal(raw, &m); err != nil {
			return ""
		}
	} else {
		inferred, _, err := inferManifest(mx, dir, "")
		if err != nil {
			return ""
		}
		m = inferred
	}
	effective := applyDefaults(mx, m)
	sw := effective.Switches
	return fmt.Sprintf("%s ｜ platform=%s ｜ executor=%s ｜ profile=%s ｜ clock=%s ingress=%s network=%s bots=%d search=%s",
		effective.Preset, dash(effective.Platform), dash(effective.ExecutorLifecycle), dash(effective.ResourceProfile),
		dash(sw.Clock), dash(sw.TelegramIngress), dash(sw.Network), sw.Bots, dash(sw.Search))
}

// containsString 判断字符串切片是否包含目标值。
func containsString(list []string, want string) bool {
	for _, item := range list {
		if item == want {
			return true
		}
	}
	return false
}
