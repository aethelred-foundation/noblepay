package tests

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"go.uber.org/zap"

	"github.com/aethelred/noblepay-gateway/internal/handlers"
	"github.com/aethelred/noblepay-gateway/internal/models"
	"github.com/aethelred/noblepay-gateway/internal/services"
	"github.com/aethelred/noblepay-gateway/internal/store"
	"github.com/aethelred/noblepay-gateway/pkg/crypto"
)

const testWebhookSecret = "test-webhook-secret"

// signedWebhookRequest creates an HTTP request with proper HMAC signature and timestamp headers.
func signedWebhookRequest(t *testing.T, url string, body []byte) *http.Request {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		t.Fatalf("failed to create request: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	ts := fmt.Sprintf("%d", time.Now().Unix())
	sig := crypto.HMACSHA256Hex([]byte(testWebhookSecret), body)
	req.Header.Set("X-Webhook-Signature", sig)
	req.Header.Set("X-Webhook-Timestamp", ts)
	return req
}

// setupRouter builds a full chi router wired with all handlers, mirroring server.go.
func setupRouter(t *testing.T) *chi.Mux {
	t.Helper()
	logger := zap.NewNop()
	memStore := store.NewMemoryStore()

	complianceProxy := services.NewComplianceProxy("http://localhost:19999", logger)
	paymentSvc := services.NewPaymentService(memStore, complianceProxy, logger)
	indexer := services.NewBlockchainIndexer(memStore, logger)
	settlementSvc := services.NewSettlementService(memStore, memStore, logger)

	healthH := handlers.NewHealthHandler()
	paymentH := handlers.NewPaymentHandler(paymentSvc)
	webhookH := handlers.NewWebhookHandler(indexer, settlementSvc, logger, "test-webhook-secret")

	r := chi.NewRouter()

	r.Get("/healthz", healthH.Liveness)
	r.Get("/readyz", healthH.Readiness)

	r.Route("/api/v1", func(r chi.Router) {
		r.Post("/payments", paymentH.Submit)
		r.Get("/payments", paymentH.List)
		r.Get("/payments/{id}", paymentH.GetByID)
		r.Post("/payments/{id}/cancel", paymentH.Cancel)
		r.Post("/webhooks/events", webhookH.HandleEvent)
	})

	return r
}

func TestIntegrationPaymentLifecycle(t *testing.T) {
	router := setupRouter(t)
	ts := httptest.NewServer(router)
	defer ts.Close()

	client := ts.Client()

	// 1. Create a payment.
	body := `{"sender_address":"noble1alice","receiver_address":"noble1bob","amount":"10000","currency":"USDC","memo":"invoice-42"}`
	resp, err := client.Post(ts.URL+"/api/v1/payments", "application/json", bytes.NewBufferString(body))
	if err != nil {
		t.Fatalf("POST /payments failed: %v", err)
	}
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("expected 201, got %d", resp.StatusCode)
	}

	var payment models.Payment
	json.NewDecoder(resp.Body).Decode(&payment)
	resp.Body.Close()

	if payment.ID == "" {
		t.Fatal("expected non-empty payment ID")
	}
	if payment.Status != models.PaymentStatusPending {
		t.Errorf("expected pending, got %q", payment.Status)
	}

	// 2. Get by ID.
	resp, err = client.Get(ts.URL + "/api/v1/payments/" + payment.ID)
	if err != nil {
		t.Fatalf("GET /payments/{id} failed: %v", err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}
	var fetched models.Payment
	json.NewDecoder(resp.Body).Decode(&fetched)
	resp.Body.Close()
	if fetched.ID != payment.ID {
		t.Errorf("expected ID %q, got %q", payment.ID, fetched.ID)
	}

	// 3. List payments.
	resp, err = client.Get(ts.URL + "/api/v1/payments?limit=10")
	if err != nil {
		t.Fatalf("GET /payments failed: %v", err)
	}
	var payments []*models.Payment
	json.NewDecoder(resp.Body).Decode(&payments)
	resp.Body.Close()
	if len(payments) != 1 {
		t.Errorf("expected 1 payment, got %d", len(payments))
	}

	// 4. Cancel payment.
	resp, err = client.Post(ts.URL+"/api/v1/payments/"+payment.ID+"/cancel", "application/json", nil)
	if err != nil {
		t.Fatalf("POST /payments/{id}/cancel failed: %v", err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}
	var cancelled models.Payment
	json.NewDecoder(resp.Body).Decode(&cancelled)
	resp.Body.Close()
	if cancelled.Status != models.PaymentStatusCancelled {
		t.Errorf("expected cancelled, got %q", cancelled.Status)
	}

	// 5. Cannot cancel again.
	resp, err = client.Post(ts.URL+"/api/v1/payments/"+payment.ID+"/cancel", "application/json", nil)
	if err != nil {
		t.Fatalf("second cancel failed: %v", err)
	}
	if resp.StatusCode != http.StatusConflict {
		t.Errorf("expected 409, got %d", resp.StatusCode)
	}
	resp.Body.Close()
}

func TestIntegrationHealthEndpoints(t *testing.T) {
	router := setupRouter(t)
	ts := httptest.NewServer(router)
	defer ts.Close()

	client := ts.Client()

	for _, ep := range []string{"/healthz", "/readyz"} {
		resp, err := client.Get(ts.URL + ep)
		if err != nil {
			t.Fatalf("GET %s failed: %v", ep, err)
		}
		if resp.StatusCode != http.StatusOK {
			t.Errorf("GET %s: expected 200, got %d", ep, resp.StatusCode)
		}
		var health models.HealthResponse
		json.NewDecoder(resp.Body).Decode(&health)
		resp.Body.Close()
		if health.Version == "" {
			t.Errorf("GET %s: expected non-empty version", ep)
		}
	}
}

func TestIntegrationWebhookSettlement(t *testing.T) {
	logger := zap.NewNop()
	memStore := store.NewMemoryStore()

	// Use a mock compliance server that approves everything.
	mockCompliance := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(models.ComplianceResult{Approved: true, Score: 100})
	}))
	defer mockCompliance.Close()

	complianceProxy := services.NewComplianceProxy(mockCompliance.URL, logger)
	paymentSvc := services.NewPaymentService(memStore, complianceProxy, logger)
	indexer := services.NewBlockchainIndexer(memStore, logger)
	settlementSvc := services.NewSettlementService(memStore, memStore, logger)

	paymentH := handlers.NewPaymentHandler(paymentSvc)
	webhookH := handlers.NewWebhookHandler(indexer, settlementSvc, logger, "test-webhook-secret")

	r := chi.NewRouter()
	r.Post("/api/v1/payments", paymentH.Submit)
	r.Get("/api/v1/payments/{id}", paymentH.GetByID)
	r.Post("/api/v1/webhooks/events", webhookH.HandleEvent)

	ts := httptest.NewServer(r)
	defer ts.Close()
	client := ts.Client()

	// Create payment.
	body := `{"sender_address":"noble1a","receiver_address":"noble1b","amount":"500","currency":"USDC"}`
	resp, _ := client.Post(ts.URL+"/api/v1/payments", "application/json", bytes.NewBufferString(body))
	var payment models.Payment
	json.NewDecoder(resp.Body).Decode(&payment)
	resp.Body.Close()

	if !payment.ComplianceCheck {
		t.Error("expected compliance_check=true with mock compliance server")
	}

	// Send webhook event for settlement.
	webhookBody, _ := json.Marshal(models.WebhookEvent{
		WebhookID: "wh-settle-001",
		Type:      "transfer_complete",
		PaymentID: payment.ID,
		TxHash:    "0xsettled123",
	})
	webhookReq := signedWebhookRequest(t, ts.URL+"/api/v1/webhooks/events", webhookBody)
	resp, _ = client.Do(webhookReq)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("webhook expected 200, got %d", resp.StatusCode)
	}
	resp.Body.Close()

	// Verify payment is now completed.
	resp, _ = client.Get(ts.URL + "/api/v1/payments/" + payment.ID)
	var updated models.Payment
	json.NewDecoder(resp.Body).Decode(&updated)
	resp.Body.Close()

	if updated.Status != models.PaymentStatusCompleted {
		t.Errorf("expected completed after settlement, got %q", updated.Status)
	}
	if updated.TxHash != "0xsettled123" {
		t.Errorf("expected tx_hash '0xsettled123', got %q", updated.TxHash)
	}
}

func TestIntegrationNotFound(t *testing.T) {
	router := setupRouter(t)
	ts := httptest.NewServer(router)
	defer ts.Close()

	resp, err := ts.Client().Get(ts.URL + "/api/v1/payments/does-not-exist")
	if err != nil {
		t.Fatalf("request failed: %v", err)
	}
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("expected 404, got %d", resp.StatusCode)
	}
	resp.Body.Close()
}

func TestCryptoUtilities(t *testing.T) {
	// SHA256
	hash := crypto.SHA256Hex([]byte("hello"))
	if len(hash) != 64 {
		t.Errorf("expected 64-char hex hash, got %d chars", len(hash))
	}
	// Deterministic.
	if crypto.SHA256Hex([]byte("hello")) != hash {
		t.Error("SHA256 should be deterministic")
	}
	// Different input, different hash.
	if crypto.SHA256Hex([]byte("world")) == hash {
		t.Error("different inputs should produce different hashes")
	}

	// HMAC
	key := []byte("secret-key")
	mac := crypto.HMACSHA256Hex(key, []byte("data"))
	if len(mac) != 64 {
		t.Errorf("expected 64-char hex HMAC, got %d chars", len(mac))
	}

	// Verify
	if !crypto.VerifyHMAC(key, []byte("data"), mac) {
		t.Error("VerifyHMAC should return true for matching HMAC")
	}
	if crypto.VerifyHMAC(key, []byte("tampered"), mac) {
		t.Error("VerifyHMAC should return false for non-matching data")
	}
	if crypto.VerifyHMAC([]byte("wrong-key"), []byte("data"), mac) {
		t.Error("VerifyHMAC should return false for wrong key")
	}
}
