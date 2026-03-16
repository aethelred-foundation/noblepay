package tests

import (
	"context"
	"testing"
	"time"

	"github.com/aethelred/noblepay-gateway/internal/models"
	"github.com/aethelred/noblepay-gateway/internal/store"
)

func TestMemoryStoreCreateAndGet(t *testing.T) {
	s := store.NewMemoryStore()
	ctx := context.Background()

	payment := &models.Payment{
		ID:              "pay-001",
		SenderAddress:   "noble1sender",
		ReceiverAddress: "noble1receiver",
		Amount:          "500",
		Currency:        "USDC",
		Status:          models.PaymentStatusPending,
		CreatedAt:       time.Now().UTC(),
		UpdatedAt:       time.Now().UTC(),
	}

	if err := s.Create(ctx, payment); err != nil {
		t.Fatalf("Create failed: %v", err)
	}

	got, err := s.GetByID(ctx, "pay-001")
	if err != nil {
		t.Fatalf("GetByID failed: %v", err)
	}
	if got.Amount != "500" {
		t.Errorf("expected amount '500', got %q", got.Amount)
	}
	if got.SenderAddress != "noble1sender" {
		t.Errorf("expected sender 'noble1sender', got %q", got.SenderAddress)
	}
}

func TestMemoryStoreGetNotFound(t *testing.T) {
	s := store.NewMemoryStore()
	_, err := s.GetByID(context.Background(), "nonexistent")
	if err != models.ErrPaymentNotFound {
		t.Errorf("expected ErrPaymentNotFound, got %v", err)
	}
}

func TestMemoryStoreList(t *testing.T) {
	s := store.NewMemoryStore()
	ctx := context.Background()

	for i := 0; i < 5; i++ {
		s.Create(ctx, &models.Payment{
			ID:        "pay-" + string(rune('a'+i)),
			Amount:    "100",
			Currency:  "USDC",
			Status:    models.PaymentStatusPending,
			CreatedAt: time.Now().UTC(),
			UpdatedAt: time.Now().UTC(),
		})
	}

	// Full list.
	payments, err := s.List(ctx, 10, 0)
	if err != nil {
		t.Fatalf("List failed: %v", err)
	}
	if len(payments) != 5 {
		t.Errorf("expected 5 payments, got %d", len(payments))
	}

	// With offset.
	payments, err = s.List(ctx, 10, 3)
	if err != nil {
		t.Fatalf("List with offset failed: %v", err)
	}
	if len(payments) != 2 {
		t.Errorf("expected 2 payments, got %d", len(payments))
	}

	// Offset beyond length.
	payments, err = s.List(ctx, 10, 100)
	if err != nil {
		t.Fatalf("List with large offset failed: %v", err)
	}
	if len(payments) != 0 {
		t.Errorf("expected 0 payments, got %d", len(payments))
	}
}

func TestMemoryStoreUpdate(t *testing.T) {
	s := store.NewMemoryStore()
	ctx := context.Background()

	payment := &models.Payment{
		ID:     "pay-update",
		Amount: "100",
		Status: models.PaymentStatusPending,
	}
	s.Create(ctx, payment)

	payment.Status = models.PaymentStatusCompleted
	payment.Amount = "200"
	if err := s.Update(ctx, payment); err != nil {
		t.Fatalf("Update failed: %v", err)
	}

	got, _ := s.GetByID(ctx, "pay-update")
	if got.Status != models.PaymentStatusCompleted {
		t.Errorf("expected completed status, got %q", got.Status)
	}
	if got.Amount != "200" {
		t.Errorf("expected amount '200', got %q", got.Amount)
	}
}

func TestMemoryStoreUpdateNotFound(t *testing.T) {
	s := store.NewMemoryStore()
	err := s.Update(context.Background(), &models.Payment{ID: "nonexistent"})
	if err != models.ErrPaymentNotFound {
		t.Errorf("expected ErrPaymentNotFound, got %v", err)
	}
}

func TestMemoryStoreEvents(t *testing.T) {
	s := store.NewMemoryStore()
	ctx := context.Background()

	event := &models.BlockchainEvent{
		BlockHeight: 100,
		TxHash:      "0xabc",
		EventType:   "transfer",
		PaymentID:   "pay-001",
		Timestamp:   time.Now().UTC(),
	}

	if err := s.SaveEvent(ctx, event); err != nil {
		t.Fatalf("SaveEvent failed: %v", err)
	}

	events, err := s.GetEventsByPayment(ctx, "pay-001")
	if err != nil {
		t.Fatalf("GetEventsByPayment failed: %v", err)
	}
	if len(events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(events))
	}
	if events[0].TxHash != "0xabc" {
		t.Errorf("expected tx_hash '0xabc', got %q", events[0].TxHash)
	}

	// No events for unknown payment.
	events, _ = s.GetEventsByPayment(ctx, "unknown")
	if len(events) != 0 {
		t.Errorf("expected 0 events, got %d", len(events))
	}
}
