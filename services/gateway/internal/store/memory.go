package store

import (
	"context"
	"sync"

	"github.com/aethelred/noblepay-gateway/internal/models"
)

// MemoryStore is a thread-safe in-memory implementation of PaymentStore and EventStore.
type MemoryStore struct {
	mu       sync.RWMutex
	payments map[string]*models.Payment
	order    []string // maintain insertion order for listing

	eventMu sync.RWMutex
	events  map[string][]*models.BlockchainEvent // keyed by payment ID
}

// NewMemoryStore creates a new in-memory store.
func NewMemoryStore() *MemoryStore {
	return &MemoryStore{
		payments: make(map[string]*models.Payment),
		events:   make(map[string][]*models.BlockchainEvent),
	}
}

func (s *MemoryStore) Create(_ context.Context, payment *models.Payment) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.payments[payment.ID] = payment
	s.order = append(s.order, payment.ID)
	return nil
}

func (s *MemoryStore) GetByID(_ context.Context, id string) (*models.Payment, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	p, ok := s.payments[id]
	if !ok {
		return nil, models.ErrPaymentNotFound
	}
	return p, nil
}

func (s *MemoryStore) List(_ context.Context, limit, offset int) ([]*models.Payment, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	total := len(s.order)
	if offset >= total {
		return []*models.Payment{}, nil
	}
	end := offset + limit
	if end > total {
		end = total
	}

	result := make([]*models.Payment, 0, end-offset)
	for _, id := range s.order[offset:end] {
		result = append(result, s.payments[id])
	}
	return result, nil
}

func (s *MemoryStore) Update(_ context.Context, payment *models.Payment) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.payments[payment.ID]; !ok {
		return models.ErrPaymentNotFound
	}
	s.payments[payment.ID] = payment
	return nil
}

func (s *MemoryStore) SaveEvent(_ context.Context, event *models.BlockchainEvent) error {
	s.eventMu.Lock()
	defer s.eventMu.Unlock()
	s.events[event.PaymentID] = append(s.events[event.PaymentID], event)
	return nil
}

func (s *MemoryStore) GetEventsByPayment(_ context.Context, paymentID string) ([]*models.BlockchainEvent, error) {
	s.eventMu.RLock()
	defer s.eventMu.RUnlock()
	return s.events[paymentID], nil
}
