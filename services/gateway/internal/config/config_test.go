package config

import (
	"os"
	"testing"
)

func TestLoadFailsWithoutAPIKeyInProduction(t *testing.T) {
	// Clear env vars
	os.Unsetenv("GATEWAY_API_KEY")
	os.Unsetenv("WEBHOOK_SECRET")
	os.Unsetenv("APP_ENV")

	_, err := Load()
	if err == nil {
		t.Fatal("expected error when GATEWAY_API_KEY is not set in production mode")
	}
	if err.Error() != "FATAL: GATEWAY_API_KEY is required (set APP_ENV=test to bypass)" {
		t.Errorf("unexpected error message: %s", err.Error())
	}
}

func TestLoadFailsWithoutWebhookSecretInProduction(t *testing.T) {
	os.Setenv("GATEWAY_API_KEY", "some-key")
	os.Unsetenv("WEBHOOK_SECRET")
	os.Unsetenv("APP_ENV")
	defer os.Unsetenv("GATEWAY_API_KEY")

	_, err := Load()
	if err == nil {
		t.Fatal("expected error when WEBHOOK_SECRET is not set in production mode")
	}
	if err.Error() != "FATAL: WEBHOOK_SECRET is required (set APP_ENV=test to bypass)" {
		t.Errorf("unexpected error message: %s", err.Error())
	}
}

func TestLoadSucceedsInTestMode(t *testing.T) {
	os.Unsetenv("GATEWAY_API_KEY")
	os.Unsetenv("WEBHOOK_SECRET")
	os.Setenv("APP_ENV", "test")
	defer os.Unsetenv("APP_ENV")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("unexpected error in test mode: %v", err)
	}
	if cfg.APIKey != "" {
		t.Errorf("expected empty API key in test mode, got %q", cfg.APIKey)
	}
	if cfg.Environment != "test" {
		t.Errorf("expected environment 'test', got %q", cfg.Environment)
	}
}

func TestLoadDefaults(t *testing.T) {
	// Set APP_ENV=test to allow empty API key
	os.Setenv("APP_ENV", "test")
	os.Unsetenv("GATEWAY_PORT")
	os.Unsetenv("GATEWAY_LOG_LEVEL")
	os.Unsetenv("COMPLIANCE_TEE_URL")
	os.Unsetenv("RATE_LIMIT_RPS")
	os.Unsetenv("SHUTDOWN_TIMEOUT_SECS")
	os.Unsetenv("GATEWAY_API_KEY")
	os.Unsetenv("WEBHOOK_SECRET")
	defer os.Unsetenv("APP_ENV")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if cfg.Port != "8080" {
		t.Errorf("expected port 8080, got %q", cfg.Port)
	}
	if cfg.LogLevel != "info" {
		t.Errorf("expected log level info, got %q", cfg.LogLevel)
	}
	if cfg.ComplianceURL != "http://localhost:9090" {
		t.Errorf("expected compliance URL http://localhost:9090, got %q", cfg.ComplianceURL)
	}
	if cfg.RateLimitRPS != 100 {
		t.Errorf("expected rate limit 100, got %d", cfg.RateLimitRPS)
	}
	if cfg.APIKey != "" {
		t.Errorf("expected empty API key, got %q", cfg.APIKey)
	}
}

func TestLoadFromEnv(t *testing.T) {
	os.Setenv("GATEWAY_PORT", "9090")
	os.Setenv("GATEWAY_LOG_LEVEL", "debug")
	os.Setenv("COMPLIANCE_TEE_URL", "http://tee:8080")
	os.Setenv("RATE_LIMIT_RPS", "50")
	os.Setenv("SHUTDOWN_TIMEOUT_SECS", "30")
	os.Setenv("GATEWAY_API_KEY", "mykey")
	os.Setenv("WEBHOOK_SECRET", "mysecret")
	os.Setenv("APP_ENV", "production")

	defer func() {
		os.Unsetenv("GATEWAY_PORT")
		os.Unsetenv("GATEWAY_LOG_LEVEL")
		os.Unsetenv("COMPLIANCE_TEE_URL")
		os.Unsetenv("RATE_LIMIT_RPS")
		os.Unsetenv("SHUTDOWN_TIMEOUT_SECS")
		os.Unsetenv("GATEWAY_API_KEY")
		os.Unsetenv("WEBHOOK_SECRET")
		os.Unsetenv("APP_ENV")
	}()

	cfg, err := Load()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if cfg.Port != "9090" {
		t.Errorf("expected port 9090, got %q", cfg.Port)
	}
	if cfg.LogLevel != "debug" {
		t.Errorf("expected log level debug, got %q", cfg.LogLevel)
	}
	if cfg.ComplianceURL != "http://tee:8080" {
		t.Errorf("expected compliance URL http://tee:8080, got %q", cfg.ComplianceURL)
	}
	if cfg.RateLimitRPS != 50 {
		t.Errorf("expected rate limit 50, got %d", cfg.RateLimitRPS)
	}
	if cfg.APIKey != "mykey" {
		t.Errorf("expected API key 'mykey', got %q", cfg.APIKey)
	}
	if cfg.WebhookSecret != "mysecret" {
		t.Errorf("expected webhook secret 'mysecret', got %q", cfg.WebhookSecret)
	}
}

func TestEnvIntOrDefaultInvalidValue(t *testing.T) {
	os.Setenv("RATE_LIMIT_RPS", "not-a-number")
	defer os.Unsetenv("RATE_LIMIT_RPS")

	val := envIntOrDefault("RATE_LIMIT_RPS", 100)
	if val != 100 {
		t.Errorf("expected fallback 100 for invalid int, got %d", val)
	}
}

func TestEnvOrDefaultWithValue(t *testing.T) {
	os.Setenv("TEST_KEY_UNIQUE", "custom")
	defer os.Unsetenv("TEST_KEY_UNIQUE")

	val := envOrDefault("TEST_KEY_UNIQUE", "default")
	if val != "custom" {
		t.Errorf("expected 'custom', got %q", val)
	}
}

func TestEnvOrDefaultWithoutValue(t *testing.T) {
	os.Unsetenv("TEST_KEY_MISSING")

	val := envOrDefault("TEST_KEY_MISSING", "fallback")
	if val != "fallback" {
		t.Errorf("expected 'fallback', got %q", val)
	}
}
