package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestFlyRuntimeConfigRemovesBuildMode(t *testing.T) {
	input := `app = "example"

[build]
  image = 'old:tag'

[build.args]
  VERSION = "old"

[env]
  TZ = "Asia/Shanghai"
`
	output := flyRuntimeConfig(input)
	if strings.Contains(output, "[build") || strings.Contains(output, "old") {
		t.Fatalf("build configuration leaked into source deployment:\n%s", output)
	}
	if !strings.Contains(output, `[env]`) || !strings.Contains(output, `TZ = "Asia/Shanghai"`) {
		t.Fatalf("runtime configuration was removed:\n%s", output)
	}

	path := filepath.Join(t.TempDir(), "fly.toml")
	if err := os.WriteFile(path, []byte(input), 0o600); err != nil {
		t.Fatal(err)
	}
	if !flyConfigHasBuildImage(path) {
		t.Fatal("legacy [build].image was not detected")
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
			path := filepath.Join(t.TempDir(), "fly.toml")
			if err := os.WriteFile(path, []byte(tc.toml), 0o600); err != nil {
				t.Fatal(err)
			}
			if got := flyProfileIsAutosleep(path); got != tc.want {
				t.Fatalf("flyProfileIsAutosleep = %v, want %v", got, tc.want)
			}
		})
	}
}
