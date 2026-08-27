package store

import (
	"context"

	"github.com/aethelred/noblepay-gateway/internal/models"
)

// PaymentStore defines the storage interface for payments.
type PaymentStore interface {
	Create(ctx context.Context, payment *models.Payment) error
	GetByID(ctx context.Context, id string) (*models.Payment, error)
	List(ctx context.Context, limit, offset int) ([]*models.Payment, error)
	Update(ctx context.Context, payment *models.Payment) error
}

// EventStore defines the storage interface for blockchain events.
type EventStore interface {
	SaveEvent(ctx context.Context, event *models.BlockchainEvent) error
	GetEventsByPayment(ctx context.Context, paymentID string) ([]*models.BlockchainEvent, error)
}

// ChainProjectionStore atomically persists a canonical chain event and its
// resulting read model. Implementations must be idempotent by canonical log
// identity and must reject impossible lifecycle transitions.
type ChainProjectionStore interface {
	PaymentStore
	EventStore
	ApplyChainEvent(ctx context.Context, event *models.BlockchainEvent) error
}

// IndexerCheckpoint identifies the confirmed canonical block through which
// all relevant NoblePay logs have been projected.
type IndexerCheckpoint struct {
	Height    uint64 `json:"height"`
	BlockHash string `json:"block_hash"`
}

// IndexerStateStore persists the last fully indexed canonical block so
// restarts do not silently duplicate, skip, or cross a reorg.
type IndexerStateStore interface {
	LoadIndexerCheckpoint(ctx context.Context) (IndexerCheckpoint, bool, error)
	SaveIndexerCheckpoint(ctx context.Context, checkpoint IndexerCheckpoint) error
}

// ConfirmedChainRange is one contiguous, confirmed block range. Events must be
// in canonical log order and every event must belong to [FromHeight,
// Checkpoint.Height]. Empty ranges are valid: advancing past blocks without
// NoblePay logs is still durable chain progress.
type ConfirmedChainRange struct {
	FromHeight uint64
	Events     []*models.BlockchainEvent
	Checkpoint IndexerCheckpoint
}

// ConfirmedChainRangeStore is the only production write boundary used by the
// chain indexer. Implementations must validate and project the complete range,
// persist the resulting read model and checkpoint as one transaction, and
// leave the previous state untouched if any event or persistence step fails.
type ConfirmedChainRangeStore interface {
	ChainProjectionStore
	IndexerStateStore
	ApplyConfirmedChainRange(ctx context.Context, confirmedRange ConfirmedChainRange) error
}
