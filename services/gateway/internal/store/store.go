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
