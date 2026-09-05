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
