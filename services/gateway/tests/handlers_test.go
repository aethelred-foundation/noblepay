package tests

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"go.uber.org/zap"

	"github.com/aethelred/noblepay-gateway/internal/handlers"
	"github.com/aethelred/noblepay-gateway/internal/models"
	"github.com/aethelred/noblepay-gateway/internal/services"
	"github.com/aethelred/noblepay-gateway/internal/store"
)

func setupPaymentHandler(t *testing.T) (*handlers.PaymentHandler, *services.PaymentService) {
	t.Helper()
	logger := zap.NewNop()
	memStore := store.NewMemoryStore()
	compliance := services.NewComplianceProxy("http://localhost:19999", logger)
	svc := services.NewPaymentService(memStore, compliance, logger)
	h := handlers.NewPaymentHandler(svc)
	return h, svc
}

func TestHealthLiveness(t *testing.T) {
	h := handlers.NewHealthHandler()
	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	rr := httptest.NewRecorder()

	h.Liveness(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", rr.Code)
	}

	var resp models.HealthResponse
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}
	if resp.Status != "ok" {
		t.Errorf("expected status 'ok', got %q", resp.Status)
	}
	if resp.Version == "" {
		t.Error("expected non-empty version")
	}
}

func TestHealthReadiness(t *testing.T) {
	h := handlers.NewHealthHandler()
	req := httptest.NewRequest(http.MethodGet, "/readyz", nil)
	rr := httptest.NewRecorder()

	h.Readiness(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", rr.Code)
	}

	var resp models.HealthResponse
	json.NewDecoder(rr.Body).Decode(&resp)
	if resp.Status != "ready" {
		t.Errorf("expected status 'ready', got %q", resp.Status)
	}
}

func TestSubmitPayment(t *testing.T) {
	h, _ := setupPaymentHandler(t)

	body := `{"sender_address":"noble1abc","receiver_address":"noble1xyz","amount":"1000","currency":"USDC"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/payments", bytes.NewBufferString(body))
	rr := httptest.NewRecorder()

	h.Submit(rr, req)

	if rr.Code != http.StatusCreated {
		t.Fatalf("expected status 201, got %d: %s", rr.Code, rr.Body.String())
	}

	var payment models.Payment
	json.NewDecoder(rr.Body).Decode(&payment)

	if payment.ID == "" {
		t.Error("expected non-empty payment ID")
	}
	if payment.Amount != "1000" {
		t.Errorf("expected amount '1000', got %q", payment.Amount)
	}
	if payment.Status != models.PaymentStatusPending {
		t.Errorf("expected status 'pending', got %q", payment.Status)
	}
}

func TestSubmitPaymentValidation(t *testing.T) {
	h, _ := setupPaymentHandler(t)

	// Missing sender
	body := `{"receiver_address":"noble1xyz","amount":"1000","currency":"USDC"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/payments", bytes.NewBufferString(body))
	rr := httptest.NewRecorder()

	h.Submit(rr, req)

	if rr.Code != http.StatusBadRequest {
		t.Fatalf("expected status 400, got %d", rr.Code)
	}
}

func TestGetPaymentByID(t *testing.T) {
	h, svc := setupPaymentHandler(t)

	// Create a payment first.
	payment, err := svc.Submit(nil, &models.SubmitPaymentRequest{
		SenderAddress:   "noble1abc",
		ReceiverAddress: "noble1xyz",
		Amount:          "500",
		Currency:        "USDC",
	})
	if err != nil {
		t.Fatalf("failed to create payment: %v", err)
	}

	// Set up chi context with URL param.
	r := chi.NewRouter()
	r.Get("/api/v1/payments/{id}", h.GetByID)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/payments/"+payment.ID, nil)
	rr := httptest.NewRecorder()
	r.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d: %s", rr.Code, rr.Body.String())
	}

	var fetched models.Payment
	json.NewDecoder(rr.Body).Decode(&fetched)
	if fetched.ID != payment.ID {
		t.Errorf("expected ID %q, got %q", payment.ID, fetched.ID)
	}
}

func TestGetPaymentNotFound(t *testing.T) {
	h, _ := setupPaymentHandler(t)

	r := chi.NewRouter()
	r.Get("/api/v1/payments/{id}", h.GetByID)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/payments/nonexistent", nil)
	rr := httptest.NewRecorder()
	r.ServeHTTP(rr, req)

	if rr.Code != http.StatusNotFound {
		t.Fatalf("expected status 404, got %d", rr.Code)
	}
}

func TestListPayments(t *testing.T) {
	h, svc := setupPaymentHandler(t)

	// Create 3 payments.
	for i := 0; i < 3; i++ {
		svc.Submit(nil, &models.SubmitPaymentRequest{
			SenderAddress:   "noble1abc",
			ReceiverAddress: "noble1xyz",
			Amount:          "100",
			Currency:        "USDC",
		})
	}

	req := httptest.NewRequest(http.MethodGet, "/api/v1/payments?limit=10&offset=0", nil)
	rr := httptest.NewRecorder()
	h.List(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", rr.Code)
	}

	var payments []*models.Payment
	json.NewDecoder(rr.Body).Decode(&payments)
	if len(payments) != 3 {
		t.Errorf("expected 3 payments, got %d", len(payments))
	}
}

func TestCancelPayment(t *testing.T) {
	h, svc := setupPaymentHandler(t)

	payment, _ := svc.Submit(nil, &models.SubmitPaymentRequest{
		SenderAddress:   "noble1abc",
		ReceiverAddress: "noble1xyz",
		Amount:          "200",
		Currency:        "USDC",
	})

	r := chi.NewRouter()
	r.Post("/api/v1/payments/{id}/cancel", h.Cancel)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/payments/"+payment.ID+"/cancel", nil)
	rr := httptest.NewRecorder()
	r.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d: %s", rr.Code, rr.Body.String())
	}

	var cancelled models.Payment
	json.NewDecoder(rr.Body).Decode(&cancelled)
	if cancelled.Status != models.PaymentStatusCancelled {
		t.Errorf("expected status 'cancelled', got %q", cancelled.Status)
	}
}

func TestAPIKeyAuthMiddleware(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	// With auth configured
	authed := handlers.APIKeyAuth("secret-key")(handler)

	// No key -> 401
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rr := httptest.NewRecorder()
	authed.ServeHTTP(rr, req)
	if rr.Code != http.StatusUnauthorized {
		t.Errorf("expected 401 without key, got %d", rr.Code)
	}

	// Wrong key -> 401
	req = httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("X-API-Key", "wrong")
	rr = httptest.NewRecorder()
	authed.ServeHTTP(rr, req)
	if rr.Code != http.StatusUnauthorized {
		t.Errorf("expected 401 with wrong key, got %d", rr.Code)
	}

	// Correct key -> 200
	req = httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("X-API-Key", "secret-key")
	rr = httptest.NewRecorder()
	authed.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Errorf("expected 200 with correct key, got %d", rr.Code)
	}
}

func TestAPIKeyAuthEmptyKeyUsesTestKey(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	authed := handlers.APIKeyAuth("")(handler)

	// Without any key -> 401 (no longer skips auth)
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rr := httptest.NewRecorder()
	authed.ServeHTTP(rr, req)
	if rr.Code != http.StatusUnauthorized {
		t.Errorf("expected 401 when no key provided and apiKey is empty, got %d", rr.Code)
	}

	// With the fallback test key -> 200
	req = httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("X-API-Key", "test-api-key")
	rr = httptest.NewRecorder()
	authed.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Errorf("expected 200 with test-api-key, got %d", rr.Code)
	}
}

func TestRateLimiterMiddleware(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	rl := handlers.NewRateLimiter(2) // 2 requests per second
	limited := rl.Middleware(handler)

	// First 2 requests should pass.
	for i := 0; i < 2; i++ {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		rr := httptest.NewRecorder()
		limited.ServeHTTP(rr, req)
		if rr.Code != http.StatusOK {
			t.Errorf("request %d: expected 200, got %d", i+1, rr.Code)
		}
	}

	// Third request should be rate limited.
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rr := httptest.NewRecorder()
	limited.ServeHTTP(rr, req)
	if rr.Code != http.StatusTooManyRequests {
		t.Errorf("expected 429 for rate limited request, got %d", rr.Code)
	}
}
