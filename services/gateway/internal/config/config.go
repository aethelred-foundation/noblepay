package config

import (
	"fmt"
	"os"
	"strconv"
	"time"
)

// Config holds application configuration loaded from environment variables.
type Config struct {
	Port            string
	LogLevel        string
	ComplianceURL   string
	RateLimitRPS    int
	ShutdownTimeout time.Duration
	APIKey          string
	Environment     string
	WebhookSecret   string
	StorePath       string
}

// Load reads configuration from environment variables with sensible defaults.
// Returns an error if required configuration is missing.
func Load() (*Config, error) {
	env := envOrDefault("APP_ENV", "production")
	apiKey := envOrDefault("GATEWAY_API_KEY", "")
	webhookSecret := envOrDefault("WEBHOOK_SECRET", "")

	if apiKey == "" && env != "test" {
		return nil, fmt.Errorf("FATAL: GATEWAY_API_KEY is required (set APP_ENV=test to bypass)")
	}

	if webhookSecret == "" && env != "test" {
		return nil, fmt.Errorf("FATAL: WEBHOOK_SECRET is required (set APP_ENV=test to bypass)")
	}

	return &Config{
		Port:            envOrDefault("GATEWAY_PORT", "8080"),
		LogLevel:        envOrDefault("GATEWAY_LOG_LEVEL", "info"),
		ComplianceURL:   envOrDefault("COMPLIANCE_TEE_URL", "http://localhost:9090"),
		RateLimitRPS:    envIntOrDefault("RATE_LIMIT_RPS", 100),
		ShutdownTimeout: time.Duration(envIntOrDefault("SHUTDOWN_TIMEOUT_SECS", 15)) * time.Second,
		APIKey:          apiKey,
		Environment:     env,
		WebhookSecret:   webhookSecret,
		StorePath:       envOrDefault("STORE_PATH", ""),
	}, nil
}

func envOrDefault(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func envIntOrDefault(key string, fallback int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return fallback
}
