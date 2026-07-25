package config

import (
	"os"
	"strings"
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
	if err.Error() != "FATAL: GATEWAY_API_KEY is required outside APP_ENV=test" {
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
	if err.Error() != "FATAL: WEBHOOK_SECRET is required outside APP_ENV=test" {
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
	if cfg.IndexerConfirmations != 2 {
		t.Errorf("expected two confirmation default, got %d", cfg.IndexerConfirmations)
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
	os.Unsetenv("COMPLIANCE_API_URL")
	os.Unsetenv("RATE_LIMIT_RPS")
	os.Unsetenv("SHUTDOWN_TIMEOUT_SECS")
	os.Unsetenv("GATEWAY_API_KEY")
	os.Unsetenv("WEBHOOK_SECRET")
	defer os.Unsetenv("APP_ENV")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if cfg.Port != "4018" {
		t.Errorf("expected port 4018, got %q", cfg.Port)
	}
	if cfg.LogLevel != "info" {
		t.Errorf("expected log level info, got %q", cfg.LogLevel)
	}
	if cfg.ComplianceAPIURL != "http://127.0.0.1:9090" {
		t.Errorf("expected compliance URL http://127.0.0.1:9090, got %q", cfg.ComplianceAPIURL)
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
	os.Setenv("COMPLIANCE_API_URL", "https://compliance.vendor.com")
	os.Setenv("RATE_LIMIT_RPS", "50")
	os.Setenv("SHUTDOWN_TIMEOUT_SECS", "30")
	os.Setenv("GATEWAY_API_KEY", "mykey")
	os.Setenv("WEBHOOK_SECRET", "mysecret")
	os.Setenv("COMPLIANCE_API_KEY", "compliance-secret")
	os.Setenv("COMPLIANCE_MAX_DATASET_AGE_HOURS", "24")
	os.Setenv("STORE_PATH", "/var/lib/noblepay/gateway.json")
	os.Setenv("CHAIN_RPC_URL", "https://rpc.example.test")
	os.Setenv("NOBLEPAY_CHAIN_ID", "7332")
	os.Setenv("AETHELRED_NETWORK_ANCHOR_BLOCK", "1")
	os.Setenv("AETHELRED_NETWORK_ANCHOR_HASH", "0x"+strings.Repeat("ab", 32))
	os.Setenv("NOBLEPAY_CONTRACT_ADDRESS", "0x1111111111111111111111111111111111111111")
	os.Setenv("INDEXER_START_BLOCK", "123")
	os.Setenv("APP_ENV", "production")

	defer func() {
		os.Unsetenv("GATEWAY_PORT")
		os.Unsetenv("GATEWAY_LOG_LEVEL")
		os.Unsetenv("COMPLIANCE_API_URL")
		os.Unsetenv("RATE_LIMIT_RPS")
		os.Unsetenv("SHUTDOWN_TIMEOUT_SECS")
		os.Unsetenv("GATEWAY_API_KEY")
		os.Unsetenv("WEBHOOK_SECRET")
		os.Unsetenv("COMPLIANCE_API_KEY")
		os.Unsetenv("COMPLIANCE_MAX_DATASET_AGE_HOURS")
		os.Unsetenv("STORE_PATH")
		os.Unsetenv("CHAIN_RPC_URL")
		os.Unsetenv("NOBLEPAY_CHAIN_ID")
		os.Unsetenv("AETHELRED_NETWORK_ANCHOR_BLOCK")
		os.Unsetenv("AETHELRED_NETWORK_ANCHOR_HASH")
		os.Unsetenv("NOBLEPAY_CONTRACT_ADDRESS")
		os.Unsetenv("INDEXER_START_BLOCK")
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
	if cfg.ComplianceAPIURL != "https://compliance.vendor.com" {
		t.Errorf("expected compliance URL https://compliance.vendor.com, got %q", cfg.ComplianceAPIURL)
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
	if cfg.ChainID != 7332 || cfg.NetworkAnchorBlock != 1 || cfg.NetworkAnchorHash != "0x"+strings.Repeat("ab", 32) {
		t.Fatalf("unexpected configured network identity: chain=%d block=%d hash=%s", cfg.ChainID, cfg.NetworkAnchorBlock, cfg.NetworkAnchorHash)
	}
}

func setRequiredProductionEnv(t *testing.T, complianceURL string) {
	t.Helper()
	t.Setenv("APP_ENV", "production")
	t.Setenv("GATEWAY_API_KEY", "gateway-secret")
	t.Setenv("WEBHOOK_SECRET", "webhook-secret")
	t.Setenv("COMPLIANCE_API_URL", complianceURL)
	t.Setenv("COMPLIANCE_API_KEY", "compliance-secret")
	t.Setenv("COMPLIANCE_MAX_DATASET_AGE_HOURS", "24")
	t.Setenv("STORE_PATH", "/var/lib/noblepay/gateway.json")
	t.Setenv("CHAIN_RPC_URL", "https://rpc.vendor.com")
	t.Setenv("NOBLEPAY_CHAIN_ID", "7332")
	t.Setenv("AETHELRED_NETWORK_ANCHOR_BLOCK", "1")
	t.Setenv("AETHELRED_NETWORK_ANCHOR_HASH", "0x"+strings.Repeat("ab", 32))
	t.Setenv("NOBLEPAY_CONTRACT_ADDRESS", "0x1111111111111111111111111111111111111111")
	t.Setenv("INDEXER_START_BLOCK", "123")
}

func TestLoadRejectsInvalidProductionNetworkIdentity(t *testing.T) {
	setRequiredProductionEnv(t, "https://compliance.vendor.com")
	t.Setenv("NOBLEPAY_CHAIN_ID", "0")
	if _, err := Load(); err == nil || !strings.Contains(err.Error(), "NOBLEPAY_CHAIN_ID") {
		t.Fatalf("expected invalid chain ID rejection, got %v", err)
	}

	t.Setenv("NOBLEPAY_CHAIN_ID", "7332")
	t.Setenv("AETHELRED_NETWORK_ANCHOR_HASH", "0x1234")
	if _, err := Load(); err == nil || !strings.Contains(err.Error(), "AETHELRED_NETWORK_ANCHOR_HASH") {
		t.Fatalf("expected invalid anchor hash rejection, got %v", err)
	}
}

func TestLoadRejectsLocalComplianceAPIURLInProduction(t *testing.T) {
	setRequiredProductionEnv(t, "http://127.0.0.1:9090")
	if _, err := Load(); err == nil {
		t.Fatal("expected a loopback compliance API URL to fail in production")
	}
}

func TestLoadRejectsMockComplianceAPIURLInProduction(t *testing.T) {
	setRequiredProductionEnv(t, "https://mock-compliance.vendor.com")
	if _, err := Load(); err == nil {
		t.Fatal("expected a mock compliance API URL to fail in production")
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
