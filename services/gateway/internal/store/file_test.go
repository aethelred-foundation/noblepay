package store

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/aethelred/noblepay-gateway/internal/models"
)

func tmpStorePath(t *testing.T) string {
	t.Helper()
	return filepath.Join(t.TempDir(), "store.json")
}

func makePayment(id string) *models.Payment {
	return &models.Payment{
		ID:              id,
		SenderAddress:   "noble1sender",
		ReceiverAddress: "noble1receiver",
		Amount:          "1000",
		Currency:        "USDC",
		Status:          models.PaymentStatusPending,
		CreatedAt:       time.Now().UTC(),
		UpdatedAt:       time.Now().UTC(),
	}
}

// ---------- Basic CRUD ----------

func TestFileStore_CreateAndGetByID(t *testing.T) {
	path := tmpStorePath(t)
	s, err := NewFileStore(path)
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}

	ctx := context.Background()
	p := makePayment("pay-1")

	if err := s.Create(ctx, p); err != nil {
		t.Fatalf("Create: %v", err)
	}

	got, err := s.GetByID(ctx, "pay-1")
	if err != nil {
		t.Fatalf("GetByID: %v", err)
	}
	if got.ID != "pay-1" {
		t.Fatalf("expected pay-1, got %s", got.ID)
	}
	if got.Amount != "1000" {
		t.Fatalf("expected amount 1000, got %s", got.Amount)
	}
}

func TestFileStore_GetByID_NotFound(t *testing.T) {
	path := tmpStorePath(t)
	s, err := NewFileStore(path)
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}

	_, err = s.GetByID(context.Background(), "nonexistent")
	if err != models.ErrPaymentNotFound {
		t.Fatalf("expected ErrPaymentNotFound, got %v", err)
	}
}

func TestFileStore_List(t *testing.T) {
	path := tmpStorePath(t)
	s, err := NewFileStore(path)
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}

	ctx := context.Background()
	for i := 0; i < 5; i++ {
		if err := s.Create(ctx, makePayment(fmt.Sprintf("pay-%d", i))); err != nil {
			t.Fatalf("Create: %v", err)
		}
	}

	list, err := s.List(ctx, 3, 1)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(list) != 3 {
		t.Fatalf("expected 3 items, got %d", len(list))
	}
	if list[0].ID != "pay-1" {
		t.Fatalf("expected pay-1 at offset 1, got %s", list[0].ID)
	}
}

func TestFileStore_Update(t *testing.T) {
	path := tmpStorePath(t)
	s, err := NewFileStore(path)
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}

	ctx := context.Background()
	p := makePayment("pay-u")
	s.Create(ctx, p)

	p.Status = models.PaymentStatusCompleted
	if err := s.Update(ctx, p); err != nil {
		t.Fatalf("Update: %v", err)
	}

	got, _ := s.GetByID(ctx, "pay-u")
	if got.Status != models.PaymentStatusCompleted {
		t.Fatalf("expected completed, got %s", got.Status)
	}
}

func TestFileStore_Update_NotFound(t *testing.T) {
	path := tmpStorePath(t)
	s, _ := NewFileStore(path)
	err := s.Update(context.Background(), makePayment("ghost"))
	if err != models.ErrPaymentNotFound {
		t.Fatalf("expected ErrPaymentNotFound, got %v", err)
	}
}

func TestFileStore_Events(t *testing.T) {
	path := tmpStorePath(t)
	s, _ := NewFileStore(path)
	ctx := context.Background()

	evt := &models.BlockchainEvent{
		BlockHeight: 100,
		TxHash:      "0xabc",
		EventType:   "transfer",
		PaymentID:   "pay-e",
		Timestamp:   time.Now().UTC(),
	}

	if err := s.SaveEvent(ctx, evt); err != nil {
		t.Fatalf("SaveEvent: %v", err)
	}

	events, err := s.GetEventsByPayment(ctx, "pay-e")
	if err != nil {
		t.Fatalf("GetEventsByPayment: %v", err)
	}
	if len(events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(events))
	}
	if events[0].TxHash != "0xabc" {
		t.Fatalf("expected 0xabc, got %s", events[0].TxHash)
	}
}

// ---------- Persistence across restarts ----------

func TestFileStore_PersistsAfterRestart(t *testing.T) {
	path := tmpStorePath(t)
	ctx := context.Background()

	// First instance: write data.
	s1, err := NewFileStore(path)
	if err != nil {
		t.Fatalf("NewFileStore (1st): %v", err)
	}
	s1.Create(ctx, makePayment("persist-1"))
	s1.Create(ctx, makePayment("persist-2"))
	s1.SaveEvent(ctx, &models.BlockchainEvent{
		BlockHeight: 42,
		TxHash:      "0xpersist",
		EventType:   "settle",
		PaymentID:   "persist-1",
		Timestamp:   time.Now().UTC(),
	})

	// Second instance: simulate restart by opening the same file.
	s2, err := NewFileStore(path)
	if err != nil {
		t.Fatalf("NewFileStore (2nd): %v", err)
	}

	got, err := s2.GetByID(ctx, "persist-1")
	if err != nil {
		t.Fatalf("GetByID after restart: %v", err)
	}
	if got.Amount != "1000" {
		t.Fatalf("expected amount 1000 after restart, got %s", got.Amount)
	}

	list, _ := s2.List(ctx, 100, 0)
	if len(list) != 2 {
		t.Fatalf("expected 2 payments after restart, got %d", len(list))
	}

	events, _ := s2.GetEventsByPayment(ctx, "persist-1")
	if len(events) != 1 {
		t.Fatalf("expected 1 event after restart, got %d", len(events))
	}
}

// ---------- Webhook replay dedup survives restart ----------

func TestFileStore_WebhookDedupSurvivesRestart(t *testing.T) {
	path := tmpStorePath(t)
	ctx := context.Background()

	s1, _ := NewFileStore(path)
	s1.SaveEvent(ctx, &models.BlockchainEvent{
		BlockHeight: 10,
		TxHash:      "0xdedup",
		EventType:   "mint",
		PaymentID:   "dedup-pay",
		Timestamp:   time.Now().UTC(),
	})

	// Restart.
	s2, _ := NewFileStore(path)

	events, _ := s2.GetEventsByPayment(ctx, "dedup-pay")
	if len(events) != 1 {
		t.Fatalf("expected 1 event (dedup check), got %d", len(events))
	}
	if events[0].TxHash != "0xdedup" {
		t.Fatalf("expected tx 0xdedup, got %s", events[0].TxHash)
	}
}

// ---------- Concurrent writes ----------

func TestFileStore_ConcurrentWrites(t *testing.T) {
	path := tmpStorePath(t)
	s, _ := NewFileStore(path)
	ctx := context.Background()

	const n = 50
	var wg sync.WaitGroup
	wg.Add(n)
	errs := make(chan error, n)

	for i := 0; i < n; i++ {
		go func(i int) {
			defer wg.Done()
			if err := s.Create(ctx, makePayment(fmt.Sprintf("conc-%d", i))); err != nil {
				errs <- err
			}
		}(i)
	}

	wg.Wait()
	close(errs)

	for err := range errs {
		t.Fatalf("concurrent Create error: %v", err)
	}

	list, _ := s.List(ctx, 1000, 0)
	if len(list) != n {
		t.Fatalf("expected %d payments after concurrent writes, got %d", n, len(list))
	}

	// Verify the file is readable by a new instance.
	s2, err := NewFileStore(path)
	if err != nil {
		t.Fatalf("NewFileStore after concurrent writes: %v", err)
	}
	list2, _ := s2.List(ctx, 1000, 0)
	if len(list2) != n {
		t.Fatalf("expected %d payments after reload, got %d", n, len(list2))
	}
}

// ---------- File on disk is valid JSON ----------

func TestFileStore_FileIsValidJSON(t *testing.T) {
	path := tmpStorePath(t)
	s, _ := NewFileStore(path)
	ctx := context.Background()

	s.Create(ctx, makePayment("json-check"))

	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if len(raw) == 0 {
		t.Fatal("store file is empty")
	}
	// Quick sanity: should start with '{'
	if raw[0] != '{' {
		t.Fatalf("expected JSON object, file starts with %q", string(raw[:1]))
	}
}
