package tests

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/aethelred/noblepay-gateway/internal/services"
	"go.uber.org/zap"
)

func approvedComplianceServer(t *testing.T) *httptest.Server {
	return complianceServer(t, "Passed", true, true, 5)
}

func complianceServer(t *testing.T, status string, sanctionsClear, travelRuleCompliant bool, score int) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && r.URL.Path == "/v1/health" {
			_ = json.NewEncoder(w).Encode(map[string]any{"status": "healthy"})
			return
		}
		if r.Method != http.MethodPost || r.URL.Path != "/v1/screen" {
			http.NotFound(w, r)
			return
		}
		var request struct {
			Payment struct {
				ID string `json:"id"`
			} `json:"payment"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil || request.Payment.ID == "" {
			http.Error(w, "invalid request", http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"success":    true,
			"request_id": request.Payment.ID,
			"result": map[string]any{
				"payment_id":            request.Payment.ID,
				"sanctions_clear":       sanctionsClear,
				"aml_risk_score":        score,
				"travel_rule_compliant": travelRuleCompliant,
				"status":                status,
			},
		})
	}))
	t.Cleanup(server.Close)
	return server
}

func approvedComplianceProxy(t *testing.T, logger *zap.Logger) *services.ComplianceProxy {
	t.Helper()
	return services.NewComplianceProxy(approvedComplianceServer(t).URL, logger)
}
