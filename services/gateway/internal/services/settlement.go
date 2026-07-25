package services

import (
	"context"
	"strings"
	"time"

	"github.com/aethelred/noblepay-gateway/internal/models"
	"github.com/aethelred/noblepay-gateway/internal/store"
	"go.uber.org/zap"
)

// SettlementService handles reconciliation of payments against on-chain data.
type SettlementService struct {
	paymentStore store.PaymentStore
	eventStore   store.EventStore
	logger       *zap.Logger
}

// NewSettlementService creates a new SettlementService.
func NewSettlementService(ps store.PaymentStore, es store.EventStore, logger *zap.Logger) *SettlementService {
	return &SettlementService{
		paymentStore: ps,
		eventStore:   es,
		logger:       logger,
	}
}

// Reconcile checks a payment against its on-chain events and returns a settlement record.
func (ss *SettlementService) Reconcile(ctx context.Context, paymentID string) (*models.SettlementRecord, error) {
	payment, err := ss.paymentStore.GetByID(ctx, paymentID)
	if err != nil {
		return nil, err
	}

	events, err := ss.eventStore.GetEventsByPayment(ctx, paymentID)
	if err != nil {
		return nil, err
	}

	record := &models.SettlementRecord{
		PaymentID: paymentID,
	}

	// A settlement is recognized only by the exact canonical NoblePay event
	// topic. Human-readable webhook labels are never settlement evidence.
	for _, evt := range events {
		if strings.EqualFold(evt.EventType, PaymentSettledTopic) {
			record.Settled = true
			record.SettledAt = evt.Timestamp
			record.OnChainTx = evt.TxHash
			break
		}
	}

	if !record.Settled && (payment.Status == models.PaymentStatusSettled || payment.Status == models.PaymentStatusCompleted) {
		record.Discrepancy = "payment marked settled but no canonical PaymentSettled event found"
		ss.logger.Warn("settlement discrepancy detected",
			zap.String("payment_id", paymentID),
			zap.String("discrepancy", record.Discrepancy),
		)
	}

	if record.Settled && payment.Status != models.PaymentStatusSettled {
		// This fallback supports stores populated before atomic projection was
		// introduced. New canonical events update the read model atomically.
		payment.Status = models.PaymentStatusSettled
		payment.SettlementTxHash = record.OnChainTx
		payment.TxHash = record.OnChainTx
		payment.UpdatedAt = time.Now().UTC()
		if err := ss.paymentStore.Update(ctx, payment); err != nil {
			ss.logger.Error("failed to update payment after settlement", zap.Error(err))
		}
	}

	return record, nil
}
