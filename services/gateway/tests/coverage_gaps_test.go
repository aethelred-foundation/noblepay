package tests

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
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
)

// --- Middleware coverage ---

func TestRequestLoggerMiddleware(t *testing.T) {
	logger := zap.NewNop()

	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok"))
	})

	logged := handlers.RequestLogger(logger)(inner)

	req := httptest.NewRequest(http.MethodGet, "/test", nil)
	rr := httptest.NewRecorder()
	logged.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rr.Code)
	}
}

func TestRequestLoggerWriteHeader(t *testing.T) {
	logger := zap.NewNop()

	// Handler that writes a non-200 status to exercise WriteHeader on statusWriter
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		w.Write([]byte("not found"))
	})

	logged := handlers.RequestLogger(logger)(inner)

	req := httptest.NewRequest(http.MethodGet, "/missing", nil)
	rr := httptest.NewRecorder()
	logged.ServeHTTP(rr, req)

	if rr.Code != http.StatusNotFound {
		t.Errorf("expected 404, got %d", rr.Code)
	}
}

func TestRateLimiterTokenReset(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	rl := handlers.NewRateLimiter(1) // 1 request per second
	limited := rl.Middleware(handler)

	// First request should pass
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rr := httptest.NewRecorder()
	limited.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rr.Code)
	}

	// Second request should be rate limited
	req = httptest.NewRequest(http.MethodGet, "/", nil)
	rr = httptest.NewRecorder()
	limited.ServeHTTP(rr, req)
	if rr.Code != http.StatusTooManyRequests {
		t.Errorf("expected 429, got %d", rr.Code)
	}

	// Wait for token reset (just over 1 second)
	time.Sleep(1100 * time.Millisecond)

	// Should pass again after reset
	req = httptest.NewRequest(http.MethodGet, "/", nil)
	rr = httptest.NewRecorder()
	limited.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Errorf("expected 200 after reset, got %d", rr.Code)
	}
}

// --- Payment handler: Submit bad JSON ---

func TestSubmitPaymentBadJSON(t *testing.T) {
	h, _ := setupPaymentHandler(t)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/payments", bytes.NewBufferString("{invalid json"))
	rr := httptest.NewRecorder()
	h.Submit(rr, req)

	if rr.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for bad JSON, got %d", rr.Code)
	}
}

// Test all validation errors for Submit handler (receiver, amount, currency)
func TestSubmitPaymentAllValidationErrors(t *testing.T) {
	h, _ := setupPaymentHandler(t)

	tests := []struct {
		name string
		body string
	}{
		{"missing receiver", `{"sender_address":"s","amount":"1","currency":"USDC"}`},
		{"missing amount", `{"sender_address":"s","receiver_address":"r","currency":"USDC"}`},
		{"missing currency", `{"sender_address":"s","receiver_address":"r","amount":"1"}`},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/api/v1/payments", bytes.NewBufferString(tt.body))
			rr := httptest.NewRecorder()
			h.Submit(rr, req)
			if rr.Code != http.StatusBadRequest {
				t.Errorf("expected 400, got %d", rr.Code)
			}
		})
	}
}

// --- Payment handler: GetByID with empty id (no chi param) ---

func TestGetByIDEmptyID(t *testing.T) {
	h, _ := setupPaymentHandler(t)

	// Call without chi context => id will be ""
	req := httptest.NewRequest(http.MethodGet, "/api/v1/payments/", nil)
	rr := httptest.NewRecorder()
	h.GetByID(rr, req)

	if rr.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for empty id, got %d", rr.Code)
	}
}

// --- Payment handler: Cancel with empty id ---

func TestCancelEmptyID(t *testing.T) {
	h, _ := setupPaymentHandler(t)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/payments//cancel", nil)
	rr := httptest.NewRecorder()
	h.Cancel(rr, req)

	if rr.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for empty id, got %d", rr.Code)
	}
}

// --- Payment handler: Cancel not found ---

func TestCancelPaymentNotFound(t *testing.T) {
	h, _ := setupPaymentHandler(t)

	r := chi.NewRouter()
	r.Post("/api/v1/payments/{id}/cancel", h.Cancel)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/payments/nonexistent/cancel", nil)
	rr := httptest.NewRecorder()
	r.ServeHTTP(rr, req)

	if rr.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", rr.Code)
	}
}

// --- Payment handler: Cancel not cancellable (already cancelled) ---

func TestCancelPaymentNotCancellable(t *testing.T) {
	h, svc := setupPaymentHandler(t)

	payment, _ := svc.Submit(context.Background(), &models.SubmitPaymentRequest{
		SenderAddress:   "noble1abc",
		ReceiverAddress: "noble1xyz",
		Amount:          "100",
		Currency:        "USDC",
	})

	// Cancel it first
	svc.Cancel(context.Background(), payment.ID)

	r := chi.NewRouter()
	r.Post("/api/v1/payments/{id}/cancel", h.Cancel)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/payments/"+payment.ID+"/cancel", nil)
	rr := httptest.NewRecorder()
	r.ServeHTTP(rr, req)

	if rr.Code != http.StatusConflict {
		t.Fatalf("expected 409, got %d", rr.Code)
	}
}

// --- Webhook handler: bad JSON ---

func TestWebhookHandleEventBadJSON(t *testing.T) {
	logger := zap.NewNop()
	memStore := store.NewMemoryStore()
	indexer := services.NewBlockchainIndexer(memStore, logger)
	settlement := services.NewSettlementService(memStore, memStore, logger)
	wh := handlers.NewWebhookHandler(indexer, settlement, logger, testWebhookSecret)

	body := []byte("not json")
	req := signedWebhookRequest(t, "/api/v1/webhooks/events", body)
	rr := httptest.NewRecorder()
	wh.HandleEvent(rr, req)

	if rr.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rr.Code)
	}
}

// --- Webhook handler: missing fields ---

func TestWebhookHandleEventMissingFields(t *testing.T) {
	logger := zap.NewNop()
	memStore := store.NewMemoryStore()
	indexer := services.NewBlockchainIndexer(memStore, logger)
	settlement := services.NewSettlementService(memStore, memStore, logger)
	wh := handlers.NewWebhookHandler(indexer, settlement, logger, testWebhookSecret)

	tests := []struct {
		name string
		body string
	}{
		{"missing tx_hash", `{"type":"transfer","webhook_id":"wh-1"}`},
		{"missing type", `{"tx_hash":"0xabc","webhook_id":"wh-2"}`},
		{"both empty", `{"tx_hash":"","type":"","webhook_id":"wh-3"}`},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			body := []byte(tt.body)
			req := signedWebhookRequest(t, "/api/v1/webhooks/events", body)
			rr := httptest.NewRecorder()
			wh.HandleEvent(rr, req)
			if rr.Code != http.StatusBadRequest {
				t.Errorf("expected 400, got %d", rr.Code)
			}
		})
	}
}

// --- Webhook handler: event without payment_id (no reconciliation) ---

func TestWebhookHandleEventWithoutPaymentID(t *testing.T) {
	logger := zap.NewNop()
	memStore := store.NewMemoryStore()
	indexer := services.NewBlockchainIndexer(memStore, logger)
	settlement := services.NewSettlementService(memStore, memStore, logger)
	wh := handlers.NewWebhookHandler(indexer, settlement, logger, testWebhookSecret)

	body := []byte(`{"tx_hash":"0xabc123","type":"transfer","payment_id":"","webhook_id":"wh-no-pay"}`)
	req := signedWebhookRequest(t, "/api/v1/webhooks/events", body)
	rr := httptest.NewRecorder()
	wh.HandleEvent(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rr.Code)
	}
}

// --- Webhook handler: reconciliation failure (payment not found) ---

func TestWebhookHandleEventReconciliationFailure(t *testing.T) {
	logger := zap.NewNop()
	memStore := store.NewMemoryStore()
	indexer := services.NewBlockchainIndexer(memStore, logger)
	settlement := services.NewSettlementService(memStore, memStore, logger)
	wh := handlers.NewWebhookHandler(indexer, settlement, logger, testWebhookSecret)

	// payment_id references a non-existent payment, so reconciliation will fail (warn logged)
	body := []byte(`{"tx_hash":"0xabc123","type":"transfer_complete","payment_id":"nonexistent-pay","webhook_id":"wh-reconcile-fail"}`)
	req := signedWebhookRequest(t, "/api/v1/webhooks/events", body)
	rr := httptest.NewRecorder()
	wh.HandleEvent(rr, req)

	// Should still return 200 (event was indexed, reconciliation failure is just a warning)
	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rr.Code)
	}
}

// --- Indexer Start/Stop/run lifecycle ---

func TestIndexerStartAndStop(t *testing.T) {
	logger := zap.NewNop()
	memStore := store.NewMemoryStore()
	indexer := services.NewBlockchainIndexer(memStore, logger)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	indexer.Start(ctx)

	// Let the goroutine run briefly
	time.Sleep(50 * time.Millisecond)

	// Stop via Stop()
	indexer.Stop()

	// Give it time to exit
	time.Sleep(50 * time.Millisecond)
}

func TestIndexerStopViaContext(t *testing.T) {
	logger := zap.NewNop()
	memStore := store.NewMemoryStore()
	indexer := services.NewBlockchainIndexer(memStore, logger)

	ctx, cancel := context.WithCancel(context.Background())

	indexer.Start(ctx)

	// Let the goroutine run briefly
	time.Sleep(50 * time.Millisecond)

	// Stop via context cancellation
	cancel()

	// Give it time to exit
	time.Sleep(50 * time.Millisecond)
}

// --- Payment service: List boundary cases ---

func TestPaymentServiceListDefaultLimit(t *testing.T) {
	logger := zap.NewNop()
	memStore := store.NewMemoryStore()
	compliance := services.NewComplianceProxy("http://localhost:19999", logger)
	svc := services.NewPaymentService(memStore, compliance, logger)

	ctx := context.Background()

	// Create 3 payments
	for i := 0; i < 3; i++ {
		svc.Submit(ctx, &models.SubmitPaymentRequest{
			SenderAddress:   "s",
			ReceiverAddress: "r",
			Amount:          "100",
			Currency:        "USDC",
		})
	}

	// limit <= 0 defaults to 20
	payments, err := svc.List(ctx, 0, 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(payments) != 3 {
		t.Errorf("expected 3, got %d", len(payments))
	}

	// Negative limit
	payments, err = svc.List(ctx, -1, 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(payments) != 3 {
		t.Errorf("expected 3, got %d", len(payments))
	}
}

func TestPaymentServiceListMaxLimit(t *testing.T) {
	logger := zap.NewNop()
	memStore := store.NewMemoryStore()
	compliance := services.NewComplianceProxy("http://localhost:19999", logger)
	svc := services.NewPaymentService(memStore, compliance, logger)

	ctx := context.Background()

	// Create 3 payments
	for i := 0; i < 3; i++ {
		svc.Submit(ctx, &models.SubmitPaymentRequest{
			SenderAddress:   "s",
			ReceiverAddress: "r",
			Amount:          "100",
			Currency:        "USDC",
		})
	}

	// limit > 100 capped to 100
	payments, err := svc.List(ctx, 200, 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(payments) != 3 {
		t.Errorf("expected 3, got %d", len(payments))
	}
}

func TestPaymentServiceListNegativeOffset(t *testing.T) {
	logger := zap.NewNop()
	memStore := store.NewMemoryStore()
	compliance := services.NewComplianceProxy("http://localhost:19999", logger)
	svc := services.NewPaymentService(memStore, compliance, logger)

	ctx := context.Background()

	svc.Submit(ctx, &models.SubmitPaymentRequest{
		SenderAddress:   "s",
		ReceiverAddress: "r",
		Amount:          "100",
		Currency:        "USDC",
	})

	// Negative offset defaults to 0
	payments, err := svc.List(ctx, 10, -5)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(payments) != 1 {
		t.Errorf("expected 1, got %d", len(payments))
	}
}

// --- Payment service: Cancel not found ---

func TestPaymentServiceCancelNotFound(t *testing.T) {
	logger := zap.NewNop()
	memStore := store.NewMemoryStore()
	compliance := services.NewComplianceProxy("http://localhost:19999", logger)
	svc := services.NewPaymentService(memStore, compliance, logger)

	_, err := svc.Cancel(context.Background(), "nonexistent")
	if !errors.Is(err, models.ErrPaymentNotFound) {
		t.Errorf("expected ErrPaymentNotFound, got %v", err)
	}
}

// --- Payment service: Submit with successful compliance (approved=true) ---

func TestPaymentServiceSubmitWithApprovedCompliance(t *testing.T) {
	mockServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(models.ComplianceResult{
			Approved: true,
			Score:    100,
		})
	}))
	defer mockServer.Close()

	logger := zap.NewNop()
	memStore := store.NewMemoryStore()
	compliance := services.NewComplianceProxy(mockServer.URL, logger)
	svc := services.NewPaymentService(memStore, compliance, logger)

	payment, err := svc.Submit(context.Background(), &models.SubmitPaymentRequest{
		SenderAddress:   "noble1s",
		ReceiverAddress: "noble1r",
		Amount:          "1000",
		Currency:        "USDC",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !payment.ComplianceCheck {
		t.Error("expected compliance_check=true")
	}
}

// --- Payment service: Submit with compliance returning not approved ---

func TestPaymentServiceSubmitWithRejectedCompliance(t *testing.T) {
	mockServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(models.ComplianceResult{
			Approved: false,
			Score:    10,
		})
	}))
	defer mockServer.Close()

	logger := zap.NewNop()
	memStore := store.NewMemoryStore()
	compliance := services.NewComplianceProxy(mockServer.URL, logger)
	svc := services.NewPaymentService(memStore, compliance, logger)

	payment, err := svc.Submit(context.Background(), &models.SubmitPaymentRequest{
		SenderAddress:   "noble1s",
		ReceiverAddress: "noble1r",
		Amount:          "1000",
		Currency:        "USDC",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if payment.ComplianceCheck {
		t.Error("expected compliance_check=false for rejected compliance")
	}
}

// --- Settlement: discrepancy case (completed payment but no on-chain event) ---

func TestSettlementReconcileDiscrepancy(t *testing.T) {
	logger := zap.NewNop()
	memStore := store.NewMemoryStore()
	ctx := context.Background()

	// Create a payment directly in the store as "completed" without on-chain events
	payment := &models.Payment{
		ID:        "pay-discrepancy",
		Amount:    "1000",
		Currency:  "USDC",
		Status:    models.PaymentStatusCompleted,
		CreatedAt: time.Now().UTC(),
		UpdatedAt: time.Now().UTC(),
	}
	memStore.Create(ctx, payment)

	settlement := services.NewSettlementService(memStore, memStore, logger)
	record, err := settlement.Reconcile(ctx, "pay-discrepancy")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if record.Settled {
		t.Error("expected unsettled")
	}
	if record.Discrepancy == "" {
		t.Error("expected discrepancy message")
	}
}

// --- Settlement: payment not found ---

func TestSettlementReconcilePaymentNotFound(t *testing.T) {
	logger := zap.NewNop()
	memStore := store.NewMemoryStore()
	settlement := services.NewSettlementService(memStore, memStore, logger)

	_, err := settlement.Reconcile(context.Background(), "nonexistent")
	if !errors.Is(err, models.ErrPaymentNotFound) {
		t.Errorf("expected ErrPaymentNotFound, got %v", err)
	}
}

// --- Settlement: settled event on non-completed payment (auto-update) ---

func TestSettlementReconcileAutoUpdate(t *testing.T) {
	logger := zap.NewNop()
	memStore := store.NewMemoryStore()
	ctx := context.Background()

	// Create a pending payment
	payment := &models.Payment{
		ID:        "pay-auto-update",
		Amount:    "500",
		Currency:  "USDC",
		Status:    models.PaymentStatusPending,
		CreatedAt: time.Now().UTC(),
		UpdatedAt: time.Now().UTC(),
	}
	memStore.Create(ctx, payment)

	// Add a transfer_complete event
	memStore.SaveEvent(ctx, &models.BlockchainEvent{
		TxHash:    "0xsettled-auto",
		EventType: "transfer_complete",
		PaymentID: "pay-auto-update",
		Timestamp: time.Now().UTC(),
	})

	settlement := services.NewSettlementService(memStore, memStore, logger)
	record, err := settlement.Reconcile(ctx, "pay-auto-update")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !record.Settled {
		t.Error("expected settled")
	}
	if record.OnChainTx != "0xsettled-auto" {
		t.Errorf("expected tx '0xsettled-auto', got %q", record.OnChainTx)
	}

	// Payment should now be completed
	updated, _ := memStore.GetByID(ctx, "pay-auto-update")
	if updated.Status != models.PaymentStatusCompleted {
		t.Errorf("expected completed, got %q", updated.Status)
	}
	if updated.TxHash != "0xsettled-auto" {
		t.Errorf("expected tx_hash '0xsettled-auto', got %q", updated.TxHash)
	}
}

// --- Settlement: events with non-matching event type (no settlement) ---

func TestSettlementReconcileNonMatchingEvents(t *testing.T) {
	logger := zap.NewNop()
	memStore := store.NewMemoryStore()
	ctx := context.Background()

	payment := &models.Payment{
		ID:        "pay-no-match",
		Amount:    "100",
		Currency:  "USDC",
		Status:    models.PaymentStatusPending,
		CreatedAt: time.Now().UTC(),
		UpdatedAt: time.Now().UTC(),
	}
	memStore.Create(ctx, payment)

	memStore.SaveEvent(ctx, &models.BlockchainEvent{
		TxHash:    "0xother",
		EventType: "transfer_initiated",
		PaymentID: "pay-no-match",
		Timestamp: time.Now().UTC(),
	})

	settlement := services.NewSettlementService(memStore, memStore, logger)
	record, err := settlement.Reconcile(ctx, "pay-no-match")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if record.Settled {
		t.Error("expected unsettled for non-matching event type")
	}
}

// --- Compliance: non-200 status code ---

func TestComplianceProxyNon200(t *testing.T) {
	mockServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
	}))
	defer mockServer.Close()

	logger := zap.NewNop()
	proxy := services.NewComplianceProxy(mockServer.URL, logger)

	_, err := proxy.Check(context.Background(), "sender", "receiver", "1000")
	if err == nil {
		t.Fatal("expected error for non-200 status")
	}
}

// --- Compliance: unreachable server ---

func TestComplianceProxyUnreachable(t *testing.T) {
	logger := zap.NewNop()
	proxy := services.NewComplianceProxy("http://127.0.0.1:1", logger)

	_, err := proxy.Check(context.Background(), "sender", "receiver", "1000")
	if err == nil {
		t.Fatal("expected error for unreachable server")
	}
}

// --- Compliance: invalid response body ---

func TestComplianceProxyInvalidJSON(t *testing.T) {
	mockServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("not json"))
	}))
	defer mockServer.Close()

	logger := zap.NewNop()
	proxy := services.NewComplianceProxy(mockServer.URL, logger)

	_, err := proxy.Check(context.Background(), "sender", "receiver", "1000")
	if err == nil {
		t.Fatal("expected error for invalid JSON response")
	}
}

// --- Handler: List with no query params (default limit/offset) ---

func TestListPaymentsNoQueryParams(t *testing.T) {
	h, svc := setupPaymentHandler(t)

	svc.Submit(context.Background(), &models.SubmitPaymentRequest{
		SenderAddress:   "s",
		ReceiverAddress: "r",
		Amount:          "100",
		Currency:        "USDC",
	})

	req := httptest.NewRequest(http.MethodGet, "/api/v1/payments", nil)
	rr := httptest.NewRecorder()
	h.List(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rr.Code)
	}
}

// --- Handler: List with invalid query params ---

func TestListPaymentsInvalidQueryParams(t *testing.T) {
	h, _ := setupPaymentHandler(t)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/payments?limit=abc&offset=xyz", nil)
	rr := httptest.NewRecorder()
	h.List(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200 (defaults applied), got %d", rr.Code)
	}
}
