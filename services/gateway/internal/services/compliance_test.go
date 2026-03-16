package services

import (
	"context"
	"testing"

	"go.uber.org/zap"
)

func TestComplianceProxyBadURL(t *testing.T) {
	logger := zap.NewNop()
	// A URL with a control character will cause http.NewRequestWithContext to fail
	proxy := NewComplianceProxy("http://invalid\x7f:9090", logger)

	_, err := proxy.Check(context.Background(), "sender", "receiver", "1000")
	if err == nil {
		t.Fatal("expected error for invalid URL")
	}
}

func TestComplianceProxyNilContext(t *testing.T) {
	logger := zap.NewNop()
	// Passing nil context causes NewRequestWithContext to fail
	proxy := NewComplianceProxy("http://localhost:9090", logger)

	_, err := proxy.Check(nil, "sender", "receiver", "1000") //nolint:staticcheck
	if err == nil {
		t.Fatal("expected error for nil context")
	}
}
