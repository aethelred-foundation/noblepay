package services

import (
	"context"
	"time"

	"github.com/aethelred/noblepay-gateway/internal/models"
	"github.com/aethelred/noblepay-gateway/internal/store"
	"go.uber.org/zap"
)

// BlockchainIndexer listens for on-chain events and indexes them.
type BlockchainIndexer struct {
	eventStore   store.EventStore
	logger       *zap.Logger
	stopCh       chan struct{}
	tickInterval time.Duration
}

// NewBlockchainIndexer creates a new indexer.
func NewBlockchainIndexer(es store.EventStore, logger *zap.Logger) *BlockchainIndexer {
	return &BlockchainIndexer{
		eventStore:   es,
		logger:       logger,
		stopCh:       make(chan struct{}),
		tickInterval: 10 * time.Second,
	}
}

// Start begins the mock event listening loop. In production this would
// subscribe to a blockchain node via websocket or polling.
func (bi *BlockchainIndexer) Start(ctx context.Context) {
	bi.logger.Info("blockchain indexer started")
	go bi.run(ctx)
}

// Stop signals the indexer to stop.
func (bi *BlockchainIndexer) Stop() {
	close(bi.stopCh)
}

func (bi *BlockchainIndexer) run(ctx context.Context) {
	ticker := time.NewTicker(bi.tickInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			bi.logger.Info("indexer stopping: context cancelled")
			return
		case <-bi.stopCh:
			bi.logger.Info("indexer stopping: stop signal received")
			return
		case <-ticker.C:
			// In production, this would poll or receive real events.
			bi.logger.Debug("indexer heartbeat: no new events")
		}
	}
}

// IndexEvent processes and stores a single blockchain event.
func (bi *BlockchainIndexer) IndexEvent(ctx context.Context, event *models.BlockchainEvent) error {
	bi.logger.Info("indexing blockchain event",
		zap.String("tx_hash", event.TxHash),
		zap.String("event_type", event.EventType),
		zap.Uint64("block_height", event.BlockHeight),
	)
	return bi.eventStore.SaveEvent(ctx, event)
}

// GetEvents retrieves all indexed events for a given payment.
func (bi *BlockchainIndexer) GetEvents(ctx context.Context, paymentID string) ([]*models.BlockchainEvent, error) {
	return bi.eventStore.GetEventsByPayment(ctx, paymentID)
}
