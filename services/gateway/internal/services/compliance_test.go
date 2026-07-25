package services

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"go.uber.org/zap"
)

func complianceHealthPayload(timestamp time.Time) map[string]any {
	formatted := timestamp.UTC().Format(time.RFC3339)
	return map[string]any{
		"status": "healthy",
		"sanctions_lists": map[string]any{
			"total_entries":        100,
			"last_updated":         map[string]string{"OFAC": formatted, "UAE Central Bank": formatted, "UN": formatted, "EU": formatted},
			"source":               "audited-vendor-feed",
			"dataset_generated_at": formatted,
			"dataset_digest":       "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		},
	}
}

func complianceHealthServer(t *testing.T, payload map[string]any) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/v1/health" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(payload)
	}))
	t.Cleanup(server.Close)
	return server
}

func TestComplianceProxyReadyRequiresCompleteFreshSanctionsMetadata(t *testing.T) {
	server := complianceHealthServer(t, complianceHealthPayload(time.Now()))
	proxy := NewAuthenticatedComplianceProxy(server.URL, "secret", time.Second, 24*time.Hour, zap.NewNop())
	if err := proxy.Ready(context.Background()); err != nil {
		t.Fatalf("expected complete fresh health response to be ready: %v", err)
	}
}

func TestComplianceProxyReadyRejectsMissingSanctionsMetadata(t *testing.T) {
	server := complianceHealthServer(t, map[string]any{"status": "healthy"})
	proxy := NewAuthenticatedComplianceProxy(server.URL, "secret", time.Second, 24*time.Hour, zap.NewNop())
	if err := proxy.Ready(context.Background()); err == nil {
		t.Fatal("expected incomplete sanctions metadata to fail readiness")
	}
}

func TestComplianceProxyReadyRejectsStaleSanctionsMetadata(t *testing.T) {
	server := complianceHealthServer(t, complianceHealthPayload(time.Now().Add(-25*time.Hour)))
	proxy := NewAuthenticatedComplianceProxy(server.URL, "secret", time.Second, 24*time.Hour, zap.NewNop())
	if err := proxy.Ready(context.Background()); err == nil {
		t.Fatal("expected stale sanctions metadata to fail readiness")
	}
}

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

func TestComplianceProxySendsAmountAsExactUint256DecimalString(t *testing.T) {
	const amount = "115792089237316195423570985008687907853269984665640564039457584007913129639935"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			Payment struct {
				ID     string `json:"id"`
				Amount string `json:"amount"`
			} `json:"payment"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Fatal(err)
		}
		if request.Payment.Amount != amount {
			t.Fatalf("amount lost precision: got %q", request.Payment.Amount)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"success": true, "request_id": request.Payment.ID,
			"result": map[string]any{
				"payment_id": request.Payment.ID, "sanctions_clear": true,
				"aml_risk_score": 1, "travel_rule_compliant": true, "status": "Passed",
			},
		})
	}))
	defer server.Close()
	proxy := NewComplianceProxy(server.URL, zap.NewNop())
	if _, err := proxy.Check(context.Background(), "sender", "receiver", amount, "USDC"); err != nil {
		t.Fatal(err)
	}
}

func TestComplianceProxyRejectsNonCanonicalOrOverflowingAmounts(t *testing.T) {
	proxy := NewComplianceProxy("http://127.0.0.1:1", zap.NewNop())
	for _, amount := range []string{
		"0", "01", "-1", "1.0", " 1",
		"115792089237316195423570985008687907853269984665640564039457584007913129639936",
	} {
		if _, err := proxy.Check(context.Background(), "sender", "receiver", amount); err == nil {
			t.Fatalf("expected invalid amount %q to be rejected before I/O", amount)
		}
	}
}
