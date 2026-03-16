package tests

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"go.uber.org/zap"

	"github.com/aethelred/noblepay-gateway/internal/models"
	"github.com/aethelred/noblepay-gateway/internal/services"
	"github.com/aethelred/noblepay-gateway/internal/store"
)

func TestPaymentServiceSubmit(t *testing.T) {
	logger := zap.NewNop()
	memStore := store.NewMemoryStore()
	compliance := services.NewComplianceProxy("http://localhost:19999", logger)
	svc := services.NewPaymentService(memStore, compliance, logger)

	payment, err := svc.Submit(context.Background(), &models.SubmitPaymentRequest{
		SenderAddress:   "noble1sender",
		ReceiverAddress: "noble1receiver",
		Amount:          "5000",
		Currency:        "USDC",
		Memo:            "test payment",
	})

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if payment.ID == "" {
		t.Error("expected non-empty payment ID")
	}
	if payment.Status != models.PaymentStatusPending {
		t.Errorf("expected pending status, got %q", payment.Status)
	}
	if payment.Memo != "test payment" {
		t.Errorf("expected memo 'test payment', got %q", payment.Memo)
	}
	if payment.CreatedAt.IsZero() {
		t.Error("expected non-zero created_at")
	}
}

func TestPaymentServiceSubmitValidation(t *testing.T) {
	logger := zap.NewNop()
	memStore := store.NewMemoryStore()
	compliance := services.NewComplianceProxy("http://localhost:19999", logger)
	svc := services.NewPaymentService(memStore, compliance, logger)

	tests := []struct {
		name string
		req  models.SubmitPaymentRequest
	}{
		{"missing sender", models.SubmitPaymentRequest{ReceiverAddress: "r", Amount: "1", Currency: "USDC"}},
		{"missing receiver", models.SubmitPaymentRequest{SenderAddress: "s", Amount: "1", Currency: "USDC"}},
		{"missing amount", models.SubmitPaymentRequest{SenderAddress: "s", ReceiverAddress: "r", Currency: "USDC"}},
		{"missing currency", models.SubmitPaymentRequest{SenderAddress: "s", ReceiverAddress: "r", Amount: "1"}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := svc.Submit(context.Background(), &tt.req)
			if err == nil {
				t.Error("expected validation error, got nil")
			}
		})
	}
}

func TestPaymentServiceCancel(t *testing.T) {
	logger := zap.NewNop()
	memStore := store.NewMemoryStore()
	compliance := services.NewComplianceProxy("http://localhost:19999", logger)
	svc := services.NewPaymentService(memStore, compliance, logger)

	payment, _ := svc.Submit(context.Background(), &models.SubmitPaymentRequest{
		SenderAddress:   "noble1sender",
		ReceiverAddress: "noble1receiver",
		Amount:          "100",
		Currency:        "USDC",
	})

	cancelled, err := svc.Cancel(context.Background(), payment.ID)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cancelled.Status != models.PaymentStatusCancelled {
		t.Errorf("expected cancelled, got %q", cancelled.Status)
	}

	// Cancelling again should fail.
	_, err = svc.Cancel(context.Background(), payment.ID)
	if err != models.ErrNotCancellable {
		t.Errorf("expected ErrNotCancellable, got %v", err)
	}
}

func TestPaymentServiceList(t *testing.T) {
	logger := zap.NewNop()
	memStore := store.NewMemoryStore()
	compliance := services.NewComplianceProxy("http://localhost:19999", logger)
	svc := services.NewPaymentService(memStore, compliance, logger)

	for i := 0; i < 5; i++ {
		svc.Submit(context.Background(), &models.SubmitPaymentRequest{
			SenderAddress:   "noble1sender",
			ReceiverAddress: "noble1receiver",
			Amount:          "100",
			Currency:        "USDC",
		})
	}

	// List first 3.
	payments, err := svc.List(context.Background(), 3, 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(payments) != 3 {
		t.Errorf("expected 3, got %d", len(payments))
	}

	// List with offset.
	payments, err = svc.List(context.Background(), 10, 3)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(payments) != 2 {
		t.Errorf("expected 2, got %d", len(payments))
	}
}

func TestBlockchainIndexer(t *testing.T) {
	logger := zap.NewNop()
	memStore := store.NewMemoryStore()
	indexer := services.NewBlockchainIndexer(memStore, logger)

	ctx := context.Background()
	event := &models.BlockchainEvent{
		BlockHeight: 12345,
		TxHash:      "0xabc123",
		EventType:   "transfer",
		PaymentID:   "pay-001",
		Timestamp:   time.Now().UTC(),
	}

	if err := indexer.IndexEvent(ctx, event); err != nil {
		t.Fatalf("unexpected error indexing event: %v", err)
	}

	events, err := indexer.GetEvents(ctx, "pay-001")
	if err != nil {
		t.Fatalf("unexpected error getting events: %v", err)
	}
	if len(events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(events))
	}
	if events[0].TxHash != "0xabc123" {
		t.Errorf("expected tx_hash '0xabc123', got %q", events[0].TxHash)
	}
}

func TestSettlementReconcile(t *testing.T) {
	logger := zap.NewNop()
	memStore := store.NewMemoryStore()
	compliance := services.NewComplianceProxy("http://localhost:19999", logger)
	paymentSvc := services.NewPaymentService(memStore, compliance, logger)
	settlementSvc := services.NewSettlementService(memStore, memStore, logger)

	ctx := context.Background()

	payment, _ := paymentSvc.Submit(ctx, &models.SubmitPaymentRequest{
		SenderAddress:   "noble1sender",
		ReceiverAddress: "noble1receiver",
		Amount:          "1000",
		Currency:        "USDC",
	})

	// No events yet, should not be settled.
	record, err := settlementSvc.Reconcile(ctx, payment.ID)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if record.Settled {
		t.Error("expected unsettled record")
	}

	// Add a transfer_complete event.
	memStore.SaveEvent(ctx, &models.BlockchainEvent{
		BlockHeight: 100,
		TxHash:      "0xsettled",
		EventType:   "transfer_complete",
		PaymentID:   payment.ID,
		Timestamp:   time.Now().UTC(),
	})

	// Now reconciliation should settle it.
	record, err = settlementSvc.Reconcile(ctx, payment.ID)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !record.Settled {
		t.Error("expected settled record after transfer_complete event")
	}
	if record.OnChainTx != "0xsettled" {
		t.Errorf("expected on_chain_tx '0xsettled', got %q", record.OnChainTx)
	}

	// Payment should now be completed.
	updated, _ := paymentSvc.GetByID(ctx, payment.ID)
	if updated.Status != models.PaymentStatusCompleted {
		t.Errorf("expected completed status after settlement, got %q", updated.Status)
	}
}

func TestComplianceProxyWithMockServer(t *testing.T) {
	// Start a mock compliance TEE server.
	mockServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/compliance/check" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		if r.Method != http.MethodPost {
			t.Errorf("unexpected method: %s", r.Method)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(models.ComplianceResult{
			Approved: true,
			Score:    95,
			Reason:   "all clear",
		})
	}))
	defer mockServer.Close()

	logger := zap.NewNop()
	proxy := services.NewComplianceProxy(mockServer.URL, logger)

	result, err := proxy.Check(context.Background(), "sender", "receiver", "1000")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !result.Approved {
		t.Error("expected approved=true")
	}
	if result.Score != 95 {
		t.Errorf("expected score 95, got %d", result.Score)
	}
}
