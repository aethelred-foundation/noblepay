package tests

import (
	"bytes"
	"context"
	"encoding/json"
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

// --- Handler Submit: internal error (store.Create fails) ---

func TestSubmitPaymentInternalError(t *testing.T) {
	logger := zap.NewNop()
	mockStore := &failingPaymentStore{createErr: errMockStore}
	compliance := services.NewComplianceProxy("http://localhost:19999", logger)
	svc := services.NewPaymentService(mockStore, compliance, logger)
	h := handlers.NewPaymentHandler(svc)

	body := `{"sender_address":"s","receiver_address":"r","amount":"100","currency":"USDC"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/payments", bytes.NewBufferString(body))
	rr := httptest.NewRecorder()
	h.Submit(rr, req)

	if rr.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500, got %d: %s", rr.Code, rr.Body.String())
	}
}

// --- Handler GetByID: internal error (non-ErrPaymentNotFound) ---

func TestGetByIDInternalError(t *testing.T) {
	logger := zap.NewNop()
	mockStore := &failingPaymentStore{getErr: errMockStore}
	compliance := services.NewComplianceProxy("http://localhost:19999", logger)
	svc := services.NewPaymentService(mockStore, compliance, logger)
	h := handlers.NewPaymentHandler(svc)

	r := chi.NewRouter()
	r.Get("/api/v1/payments/{id}", h.GetByID)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/payments/some-id", nil)
	rr := httptest.NewRecorder()
	r.ServeHTTP(rr, req)

	if rr.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500, got %d: %s", rr.Code, rr.Body.String())
	}
}

// --- Handler List: internal error (store.List fails) ---

func TestListPaymentsInternalError(t *testing.T) {
	logger := zap.NewNop()
	mockStore := &failingPaymentStore{listErr: errMockStore}
	compliance := services.NewComplianceProxy("http://localhost:19999", logger)
	svc := services.NewPaymentService(mockStore, compliance, logger)
	h := handlers.NewPaymentHandler(svc)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/payments?limit=10&offset=0", nil)
	rr := httptest.NewRecorder()
	h.List(rr, req)

	if rr.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500, got %d: %s", rr.Code, rr.Body.String())
	}
}

// --- Handler Cancel: internal error (non-ErrPaymentNotFound, non-ErrNotCancellable) ---

func TestCancelPaymentInternalError(t *testing.T) {
	logger := zap.NewNop()
	mockStore := &failingPaymentStore{getErr: errMockStore}
	compliance := services.NewComplianceProxy("http://localhost:19999", logger)
	svc := services.NewPaymentService(mockStore, compliance, logger)
	h := handlers.NewPaymentHandler(svc)

	r := chi.NewRouter()
	r.Post("/api/v1/payments/{id}/cancel", h.Cancel)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/payments/some-id/cancel", nil)
	rr := httptest.NewRecorder()
	r.ServeHTTP(rr, req)

	if rr.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500, got %d: %s", rr.Code, rr.Body.String())
	}
}

// --- Webhook HandleEvent: IndexEvent error ---

func TestWebhookHandleEventIndexError(t *testing.T) {
	logger := zap.NewNop()
	failEventStore := &failingEventStore{saveErr: errMockStore}
	memStore := store.NewMemoryStore()
	indexer := services.NewBlockchainIndexer(failEventStore, logger)
	settlement := services.NewSettlementService(memStore, memStore, logger)
	wh := handlers.NewWebhookHandler(indexer, settlement, logger, testWebhookSecret)

	body := []byte(`{"tx_hash":"0xabc","type":"transfer","payment_id":"pay-1","webhook_id":"wh-idx-err"}`)
	req := signedWebhookRequest(t, "/api/v1/webhooks/events", body)
	rr := httptest.NewRecorder()
	wh.HandleEvent(rr, req)

	if rr.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500 for index error, got %d", rr.Code)
	}
}

// --- Service: payment Submit store.Create error ---

func TestPaymentServiceSubmitStoreError(t *testing.T) {
	logger := zap.NewNop()
	mockStore := &failingPaymentStore{createErr: errMockStore}
	compliance := services.NewComplianceProxy("http://localhost:19999", logger)
	svc := services.NewPaymentService(mockStore, compliance, logger)

	_, err := svc.Submit(context.Background(), &models.SubmitPaymentRequest{
		SenderAddress:   "s",
		ReceiverAddress: "r",
		Amount:          "100",
		Currency:        "USDC",
	})
	if err == nil {
		t.Fatal("expected error from store.Create")
	}
}

// --- Service: payment Cancel store.Update error ---

func TestPaymentServiceCancelUpdateError(t *testing.T) {
	logger := zap.NewNop()
	// GetByID returns a pending payment, but Update fails
	mockStore := &failingPaymentStore{updateErr: errMockStore}
	compliance := services.NewComplianceProxy("http://localhost:19999", logger)
	svc := services.NewPaymentService(mockStore, compliance, logger)

	_, err := svc.Cancel(context.Background(), "some-id")
	if err == nil {
		t.Fatal("expected error from store.Update")
	}
}

// --- Service: settlement Reconcile event store error ---

func TestSettlementReconcileEventStoreError(t *testing.T) {
	logger := zap.NewNop()
	memStore := store.NewMemoryStore()
	failEvents := &failingEventStore{getErr: errMockStore}

	ctx := context.Background()

	// Create a payment in the real store
	memStore.Create(ctx, &models.Payment{
		ID:        "pay-event-err",
		Amount:    "100",
		Currency:  "USDC",
		Status:    models.PaymentStatusPending,
		CreatedAt: time.Now().UTC(),
		UpdatedAt: time.Now().UTC(),
	})

	settlement := services.NewSettlementService(memStore, failEvents, logger)
	_, err := settlement.Reconcile(ctx, "pay-event-err")
	if err == nil {
		t.Fatal("expected error from event store")
	}
}

// --- Service: settlement Reconcile update error in auto-update path ---

func TestSettlementReconcileUpdateError(t *testing.T) {
	logger := zap.NewNop()
	// Payment store that returns a pending payment but fails on update
	failPayStore := &failingPaymentStore{updateErr: errMockStore}
	memEventStore := store.NewMemoryStore()
	ctx := context.Background()

	// Save a transfer_complete event for the payment the mock store returns
	memEventStore.SaveEvent(ctx, &models.BlockchainEvent{
		TxHash:    "0xsettled",
		EventType: "transfer_complete",
		PaymentID: "test-id",
		Timestamp: time.Now().UTC(),
	})

	settlement := services.NewSettlementService(failPayStore, memEventStore, logger)
	record, err := settlement.Reconcile(ctx, "test-id")
	// The reconcile itself doesn't return an error on update failure, it just logs it
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !record.Settled {
		t.Error("expected settled=true")
	}
}

// --- Service: settlement Reconcile discrepancy with completed payment + matching settled event ---

func TestSettlementReconcileAlreadyCompleted(t *testing.T) {
	logger := zap.NewNop()
	memStore := store.NewMemoryStore()
	ctx := context.Background()

	// Create a completed payment
	payment := &models.Payment{
		ID:        "pay-already-complete",
		Amount:    "1000",
		Currency:  "USDC",
		Status:    models.PaymentStatusCompleted,
		TxHash:    "0xprevious",
		CreatedAt: time.Now().UTC(),
		UpdatedAt: time.Now().UTC(),
	}
	memStore.Create(ctx, payment)

	// Add a transfer_complete event
	memStore.SaveEvent(ctx, &models.BlockchainEvent{
		TxHash:    "0xprevious",
		EventType: "transfer_complete",
		PaymentID: "pay-already-complete",
		Timestamp: time.Now().UTC(),
	})

	settlement := services.NewSettlementService(memStore, memStore, logger)
	record, err := settlement.Reconcile(ctx, "pay-already-complete")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !record.Settled {
		t.Error("expected settled=true")
	}
	// No discrepancy: settled AND completed
	if record.Discrepancy != "" {
		t.Errorf("expected no discrepancy, got %q", record.Discrepancy)
	}
}

// --- Compliance: request context cancel ---

func TestComplianceProxyContextCancel(t *testing.T) {
	// Slow server to allow cancellation
	mockServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(5 * time.Second)
		json.NewEncoder(w).Encode(models.ComplianceResult{Approved: true})
	}))
	defer mockServer.Close()

	logger := zap.NewNop()
	proxy := services.NewComplianceProxy(mockServer.URL, logger)

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // cancel immediately

	_, err := proxy.Check(ctx, "sender", "receiver", "1000")
	if err == nil {
		t.Fatal("expected error for cancelled context")
	}
}
