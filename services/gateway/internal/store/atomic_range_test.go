package store

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"testing"
	"time"

	"github.com/aethelred/noblepay-gateway/internal/models"
)

func rangeHash(value uint64) string {
	return fmt.Sprintf("0x%064x", value)
}

func rangeInitiation(paymentID string, height, logIndex uint64) *models.BlockchainEvent {
	return &models.BlockchainEvent{
		BlockHeight:     height,
		BlockHash:       rangeHash(height),
		LogIndex:        logIndex,
		TxHash:          rangeHash(height*100 + logIndex + 1),
		EventType:       rangeHash(9001),
		EventName:       eventPaymentInitiated,
		PaymentID:       paymentID,
		RawData:         "0x0102",
		Timestamp:       time.Unix(int64(height), 0).UTC(),
		ProjectedStatus: models.PaymentStatusPending,
		SenderAddress:   "0x1111111111111111111111111111111111111111",
		ReceiverAddress: "0x2222222222222222222222222222222222222222",
		Amount:          "1000",
		TokenAddress:    "0x3333333333333333333333333333333333333333",
		Currency:        "USD",
		CurrencyCode:    "0x555344",
	}
}

func rangeCleared(paymentID string, height, logIndex uint64) *models.BlockchainEvent {
	risk := uint8(7)
	return &models.BlockchainEvent{
		BlockHeight:     height,
		BlockHash:       rangeHash(height),
		LogIndex:        logIndex,
		TxHash:          rangeHash(height*100 + logIndex + 1),
		EventType:       rangeHash(9002),
		EventName:       eventPaymentCleared,
		PaymentID:       paymentID,
		RawData:         "0x07",
		Timestamp:       time.Unix(int64(height), 0).UTC(),
		ProjectedStatus: models.PaymentStatusPassed,
		RiskScore:       &risk,
	}
}

func TestConfirmedRangeInvalidSecondEventDoesNotPartiallyCommit(t *testing.T) {
	constructors := map[string]func(t *testing.T) ConfirmedChainRangeStore{
		"memory": func(_ *testing.T) ConfirmedChainRangeStore { return NewMemoryStore() },
		"file": func(t *testing.T) ConfirmedChainRangeStore {
			storage, err := NewFileStore(filepath.Join(t.TempDir(), "gateway.json"))
			if err != nil {
				t.Fatal(err)
			}
			return storage
		},
	}
	for name, construct := range constructors {
		t.Run(name, func(t *testing.T) {
			storage := construct(t)
			err := storage.ApplyConfirmedChainRange(context.Background(), ConfirmedChainRange{
				FromHeight: 10,
				Events: []*models.BlockchainEvent{
					rangeInitiation("payment-first", 10, 0),
					rangeCleared("payment-never-initiated", 11, 0),
				},
				Checkpoint: IndexerCheckpoint{Height: 11, BlockHash: rangeHash(11)},
			})
			if err == nil {
				t.Fatal("expected invalid second event to reject the complete range")
			}
			if _, err := storage.GetByID(context.Background(), "payment-first"); !errors.Is(err, models.ErrPaymentNotFound) {
				t.Fatalf("first event leaked into payment projection: %v", err)
			}
			events, err := storage.GetEventsByPayment(context.Background(), "payment-first")
			if err != nil || len(events) != 0 {
				t.Fatalf("first event leaked into event projection: events=%d err=%v", len(events), err)
			}
			if checkpoint, exists, err := storage.LoadIndexerCheckpoint(context.Background()); err != nil || exists {
				t.Fatalf("checkpoint advanced after invalid range: %+v exists=%v err=%v", checkpoint, exists, err)
			}
		})
	}
}

func TestFileConfirmedRangeFlushFailureLeavesProjectionAndCheckpointUntouched(t *testing.T) {
	storage, err := NewFileStore(filepath.Join(t.TempDir(), "gateway.json"))
	if err != nil {
		t.Fatal(err)
	}
	storage.flushOverride = func(fileData) error { return errors.New("injected flush failure") }
	err = storage.ApplyConfirmedChainRange(context.Background(), ConfirmedChainRange{
		FromHeight: 20,
		Events:     []*models.BlockchainEvent{rangeInitiation("payment-flush", 20, 0)},
		Checkpoint: IndexerCheckpoint{Height: 21, BlockHash: rangeHash(21)},
	})
	if err == nil || err.Error() != "injected flush failure" {
		t.Fatalf("expected injected flush failure, got %v", err)
	}
	if _, err := storage.GetByID(context.Background(), "payment-flush"); !errors.Is(err, models.ErrPaymentNotFound) {
		t.Fatalf("payment mutated despite flush failure: %v", err)
	}
	if events, err := storage.GetEventsByPayment(context.Background(), "payment-flush"); err != nil || len(events) != 0 {
		t.Fatalf("event mutated despite flush failure: events=%d err=%v", len(events), err)
	}
	if checkpoint, exists, err := storage.LoadIndexerCheckpoint(context.Background()); err != nil || exists {
		t.Fatalf("checkpoint mutated despite flush failure: %+v exists=%v err=%v", checkpoint, exists, err)
	}
}

func TestFileConfirmedRangePersistsAndResumesAfterRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "gateway.json")
	storage, err := NewFileStore(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := storage.ApplyConfirmedChainRange(context.Background(), ConfirmedChainRange{
		FromHeight: 30,
		Events:     []*models.BlockchainEvent{rangeInitiation("payment-restart", 30, 0)},
		Checkpoint: IndexerCheckpoint{Height: 31, BlockHash: rangeHash(31)},
	}); err != nil {
		t.Fatal(err)
	}

	restarted, err := NewFileStore(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := restarted.ApplyConfirmedChainRange(context.Background(), ConfirmedChainRange{
		FromHeight: 32,
		Events:     []*models.BlockchainEvent{rangeCleared("payment-restart", 32, 0)},
		Checkpoint: IndexerCheckpoint{Height: 33, BlockHash: rangeHash(33)},
	}); err != nil {
		t.Fatalf("resume from durable checkpoint: %v", err)
	}
	payment, err := restarted.GetByID(context.Background(), "payment-restart")
	if err != nil || payment.Status != models.PaymentStatusPassed {
		t.Fatalf("unexpected resumed projection: %+v err=%v", payment, err)
	}
	checkpoint, exists, err := restarted.LoadIndexerCheckpoint(context.Background())
	if err != nil || !exists || checkpoint.Height != 33 || checkpoint.BlockHash != rangeHash(33) {
		t.Fatalf("unexpected resumed checkpoint: %+v exists=%v err=%v", checkpoint, exists, err)
	}
}
