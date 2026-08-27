package config

import (
	"fmt"
	"net"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var (
	evmAddress = regexp.MustCompile(`^0x[0-9a-fA-F]{40}$`)
	blockHash  = regexp.MustCompile(`^0x[0-9a-fA-F]{64}$`)
)

// Config holds application configuration loaded from environment variables.
type Config struct {
	Port                 string
	LogLevel             string
	ComplianceAPIURL     string
	ComplianceAPIKey     string
	ComplianceTimeout    time.Duration
	ComplianceMaxAge     time.Duration
	ChainRPCURL          string
	ChainID              uint64
	NetworkAnchorBlock   uint64
	NetworkAnchorHash    string
	NoblePayAddress      string
	IndexerStartBlock    uint64
	IndexerConfirmations uint64
	IndexerPollInterval  time.Duration
	RateLimitRPS         int
	ShutdownTimeout      time.Duration
	APIKey               string
	Environment          string
	WebhookSecret        string
	StorePath            string
	TrustedProxyCIDRs    []string
}

// Load reads and validates configuration. Test mode may use in-memory storage,
// an unauthenticated compliance double, and a disabled chain monitor. Every
// other environment fails closed unless durable storage and real dependencies
// are explicitly configured.
func Load() (*Config, error) {
	env := envOrDefault("APP_ENV", "production")
	isTest := env == "test"

	rateLimit, err := positiveInt("RATE_LIMIT_RPS", 100)
	if err != nil {
		return nil, err
	}
	shutdownSecs, err := positiveInt("SHUTDOWN_TIMEOUT_SECS", 15)
	if err != nil {
		return nil, err
	}
	complianceTimeoutSecs, err := positiveInt("COMPLIANCE_TIMEOUT_SECS", 5)
	if err != nil {
		return nil, err
	}
	complianceMaxAgeHours, err := positiveInt("COMPLIANCE_MAX_DATASET_AGE_HOURS", 24)
	if err != nil {
		return nil, err
	}
	pollSecs, err := positiveInt("INDEXER_POLL_INTERVAL_SECS", 10)
	if err != nil {
		return nil, err
	}
	startBlock, err := unsignedInt("INDEXER_START_BLOCK", 0)
	if err != nil {
		return nil, err
	}
	confirmations, err := unsignedInt("INDEXER_CONFIRMATIONS", 2)
	if err != nil {
		return nil, err
	}
	chainID, err := unsignedInt("NOBLEPAY_CHAIN_ID", 0)
	if err != nil {
		return nil, err
	}
	anchorBlock, err := unsignedInt("AETHELRED_NETWORK_ANCHOR_BLOCK", 0)
	if err != nil {
		return nil, err
	}

	cfg := &Config{
		Port:                 envOrDefault("GATEWAY_PORT", "4018"),
		LogLevel:             envOrDefault("GATEWAY_LOG_LEVEL", "info"),
		ComplianceAPIURL:     os.Getenv("COMPLIANCE_API_URL"),
		ComplianceAPIKey:     os.Getenv("COMPLIANCE_API_KEY"),
		ComplianceTimeout:    time.Duration(complianceTimeoutSecs) * time.Second,
		ComplianceMaxAge:     time.Duration(complianceMaxAgeHours) * time.Hour,
		ChainRPCURL:          os.Getenv("CHAIN_RPC_URL"),
		ChainID:              chainID,
		NetworkAnchorBlock:   anchorBlock,
		NetworkAnchorHash:    strings.ToLower(strings.TrimSpace(os.Getenv("AETHELRED_NETWORK_ANCHOR_HASH"))),
		NoblePayAddress:      os.Getenv("NOBLEPAY_CONTRACT_ADDRESS"),
		IndexerStartBlock:    startBlock,
		IndexerConfirmations: confirmations,
		IndexerPollInterval:  time.Duration(pollSecs) * time.Second,
		RateLimitRPS:         rateLimit,
		ShutdownTimeout:      time.Duration(shutdownSecs) * time.Second,
		APIKey:               os.Getenv("GATEWAY_API_KEY"),
		Environment:          env,
		WebhookSecret:        os.Getenv("WEBHOOK_SECRET"),
		StorePath:            os.Getenv("STORE_PATH"),
	}
	if raw := strings.TrimSpace(os.Getenv("TRUSTED_PROXY_CIDRS")); raw != "" {
		for _, candidate := range strings.Split(raw, ",") {
			cidr := strings.TrimSpace(candidate)
			if _, _, err := net.ParseCIDR(cidr); err != nil {
				return nil, fmt.Errorf("FATAL: TRUSTED_PROXY_CIDRS contains invalid CIDR %q", cidr)
			}
			cfg.TrustedProxyCIDRs = append(cfg.TrustedProxyCIDRs, cidr)
		}
	}

	if isTest {
		if cfg.ComplianceAPIURL == "" {
			cfg.ComplianceAPIURL = "http://127.0.0.1:9090"
		}
		return cfg, nil
	}

	required := []struct {
		name  string
		value string
	}{
		{"GATEWAY_API_KEY", cfg.APIKey},
		{"WEBHOOK_SECRET", cfg.WebhookSecret},
		{"COMPLIANCE_API_URL", cfg.ComplianceAPIURL},
		{"COMPLIANCE_API_KEY", cfg.ComplianceAPIKey},
		{"COMPLIANCE_MAX_DATASET_AGE_HOURS", os.Getenv("COMPLIANCE_MAX_DATASET_AGE_HOURS")},
		{"STORE_PATH", cfg.StorePath},
		{"CHAIN_RPC_URL", cfg.ChainRPCURL},
		{"NOBLEPAY_CHAIN_ID", os.Getenv("NOBLEPAY_CHAIN_ID")},
		{"AETHELRED_NETWORK_ANCHOR_BLOCK", os.Getenv("AETHELRED_NETWORK_ANCHOR_BLOCK")},
		{"AETHELRED_NETWORK_ANCHOR_HASH", cfg.NetworkAnchorHash},
		{"NOBLEPAY_CONTRACT_ADDRESS", cfg.NoblePayAddress},
		{"INDEXER_START_BLOCK", os.Getenv("INDEXER_START_BLOCK")},
	}
	for _, item := range required {
		if strings.TrimSpace(item.value) == "" {
			return nil, fmt.Errorf("FATAL: %s is required outside APP_ENV=test", item.name)
		}
	}

	if err := validateExternalHTTPSOrigin("COMPLIANCE_API_URL", cfg.ComplianceAPIURL); err != nil {
		return nil, err
	}
	if err := validateHTTPURL("CHAIN_RPC_URL", cfg.ChainRPCURL); err != nil {
		return nil, err
	}
	if !evmAddress.MatchString(cfg.NoblePayAddress) || strings.EqualFold(cfg.NoblePayAddress, "0x"+strings.Repeat("0", 40)) {
		return nil, fmt.Errorf("FATAL: NOBLEPAY_CONTRACT_ADDRESS must be a nonzero EVM address")
	}
	if cfg.ChainID == 0 {
		return nil, fmt.Errorf("FATAL: NOBLEPAY_CHAIN_ID must be a positive integer")
	}
	if !blockHash.MatchString(cfg.NetworkAnchorHash) {
		return nil, fmt.Errorf("FATAL: AETHELRED_NETWORK_ANCHOR_HASH must be a 32-byte 0x-prefixed block hash")
	}
	if cfg.StorePath == ":memory:" || cfg.StorePath == "." {
		return nil, fmt.Errorf("FATAL: STORE_PATH must identify durable storage")
	}
	if cfg.IndexerConfirmations == 0 {
		return nil, fmt.Errorf("FATAL: INDEXER_CONFIRMATIONS must be at least 1 outside APP_ENV=test")
	}

	return cfg, nil
}

func validateHTTPURL(name, raw string) error {
	parsed, err := url.ParseRequestURI(raw)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return fmt.Errorf("FATAL: %s must be an absolute http(s) URL", name)
	}
	return nil
}

func validateExternalHTTPSOrigin(name, raw string) error {
	parsed, err := url.ParseRequestURI(raw)
	if err != nil || parsed.Host == "" || parsed.Scheme != "https" {
		return fmt.Errorf("FATAL: %s must be an absolute https URL", name)
	}
	if parsed.User != nil || (parsed.Path != "" && parsed.Path != "/") || parsed.RawQuery != "" || parsed.Fragment != "" {
		return fmt.Errorf("FATAL: %s must be an https origin without credentials, path, query, or fragment", name)
	}

	hostname := strings.ToLower(parsed.Hostname())
	if hostname == "localhost" || strings.HasSuffix(hostname, ".localhost") {
		return fmt.Errorf("FATAL: %s must reference an external audited service", name)
	}
	if ip := net.ParseIP(hostname); ip != nil && (ip.IsLoopback() || ip.IsUnspecified()) {
		return fmt.Errorf("FATAL: %s must reference an external audited service", name)
	}
	for _, suffix := range []string{".invalid", ".test", ".example"} {
		if strings.HasSuffix(hostname, suffix) {
			return fmt.Errorf("FATAL: %s must not use a reserved test hostname", name)
		}
	}
	for _, marker := range []string{"mock", "placeholder", "replace-with"} {
		if strings.Contains(hostname, marker) {
			return fmt.Errorf("FATAL: %s must not reference a mock or placeholder service", name)
		}
	}
	return nil
}

func positiveInt(key string, fallback int) (int, error) {
	raw := os.Getenv(key)
	if raw == "" {
		return fallback, nil
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value <= 0 {
		return 0, fmt.Errorf("FATAL: %s must be a positive integer", key)
	}
	return value, nil
}

func unsignedInt(key string, fallback uint64) (uint64, error) {
	raw := os.Getenv(key)
	if raw == "" {
		return fallback, nil
	}
	value, err := strconv.ParseUint(raw, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("FATAL: %s must be an unsigned integer", key)
	}
	return value, nil
}

func envOrDefault(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

// Retained for callers/tests that use the old helper directly.
func envIntOrDefault(key string, fallback int) int {
	value, err := positiveInt(key, fallback)
	if err != nil {
		return fallback
	}
	return value
}
