package tests

import (
	"context"
	"errors"

	"github.com/aethelred/noblepay-gateway/internal/models"
)

var errMockStore = errors.New("mock store error")

// failingPaymentStore is a PaymentStore that returns errors on all operations.
type failingPaymentStore struct {
	createErr error
	getErr    error
	listErr   error
	updateErr error
}

func (f *failingPaymentStore) Create(_ context.Context, _ *models.Payment) error {
	if f.createErr != nil {
		return f.createErr
	}
	return nil
}

func (f *failingPaymentStore) GetByID(_ context.Context, _ string) (*models.Payment, error) {
	if f.getErr != nil {
		return nil, f.getErr
	}
	return &models.Payment{
		ID:     "test-id",
		Status: models.PaymentStatusPending,
	}, nil
}

func (f *failingPaymentStore) List(_ context.Context, _, _ int) ([]*models.Payment, error) {
	if f.listErr != nil {
		return nil, f.listErr
	}
	return nil, nil
}

func (f *failingPaymentStore) Update(_ context.Context, _ *models.Payment) error {
	if f.updateErr != nil {
		return f.updateErr
	}
	return nil
}

// failingEventStore is an EventStore that returns errors.
type failingEventStore struct {
	saveErr error
	getErr  error
}

func (f *failingEventStore) SaveEvent(_ context.Context, _ *models.BlockchainEvent) error {
	if f.saveErr != nil {
		return f.saveErr
	}
	return nil
}

func (f *failingEventStore) GetEventsByPayment(_ context.Context, _ string) ([]*models.BlockchainEvent, error) {
	if f.getErr != nil {
		return nil, f.getErr
	}
	return nil, nil
}
