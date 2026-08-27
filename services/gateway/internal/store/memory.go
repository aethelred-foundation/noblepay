package store

import (
	"context"
	"fmt"
	"strings"
	"sync"

	"github.com/aethelred/noblepay-gateway/internal/models"
)

// MemoryStore is a thread-safe in-memory implementation of PaymentStore and EventStore.
type MemoryStore struct {
	mu       sync.RWMutex
	payments map[string]*models.Payment
	order    []string // maintain insertion order for listing

	eventMu           sync.RWMutex
	events            map[string][]*models.BlockchainEvent // keyed by payment ID
	indexerCheckpoint *IndexerCheckpoint
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
	s.payments[payment.ID] = clonePayment(payment)
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
	return clonePayment(p), nil
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
		result = append(result, clonePayment(s.payments[id]))
	}
	return result, nil
}

func (s *MemoryStore) Update(_ context.Context, payment *models.Payment) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.payments[payment.ID]; !ok {
		return models.ErrPaymentNotFound
	}
	s.payments[payment.ID] = clonePayment(payment)
	return nil
}

func (s *MemoryStore) SaveEvent(_ context.Context, event *models.BlockchainEvent) error {
	s.eventMu.Lock()
	defer s.eventMu.Unlock()
	for _, existing := range s.events[event.PaymentID] {
		if sameEvent(existing, event) {
			return nil
		}
	}
	s.events[event.PaymentID] = append(s.events[event.PaymentID], cloneEvent(event))
	return nil
}

// ApplyChainEvent atomically updates the in-memory event log and payment read
// model. It mirrors FileStore semantics so tests exercise production lifecycle
// validation rather than a permissive fake.
func (s *MemoryStore) ApplyChainEvent(_ context.Context, event *models.BlockchainEvent) error {
	if event == nil {
		return fmt.Errorf("chain projection: nil event")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.eventMu.Lock()
	defer s.eventMu.Unlock()

	for _, paymentEvents := range s.events {
		for _, existingEvent := range paymentEvents {
			if sameCanonicalLog(existingEvent, event) {
				if equivalentCanonicalEvent(existingEvent, event) {
					return nil
				}
				return fmt.Errorf("chain projection: canonical log identity collision")
			}
		}
	}

	projected, created, err := projectPayment(s.payments[event.PaymentID], event)
	if err != nil {
		return err
	}
	s.payments[event.PaymentID] = clonePayment(projected)
	if created {
		s.order = append(s.order, event.PaymentID)
	}
	s.events[event.PaymentID] = append(s.events[event.PaymentID], cloneEvent(event))
	return nil
}

// ApplyConfirmedChainRange projects a complete confirmed block range and its
// checkpoint under one lock pair. All work happens on clones so an invalid
// later event or cancelled request leaves the live projection unchanged.
func (s *MemoryStore) ApplyConfirmedChainRange(ctx context.Context, confirmedRange ConfirmedChainRange) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.eventMu.Lock()
	defer s.eventMu.Unlock()

	nextPayments := clonePayments(s.payments)
	nextOrder := append([]string(nil), s.order...)
	nextEvents := cloneEvents(s.events)
	var existingCheckpoint *IndexerCheckpoint
	if s.indexerCheckpoint != nil {
		value := *s.indexerCheckpoint
		existingCheckpoint = &value
	}
	if err := projectConfirmedChainRange(
		nextPayments,
		&nextOrder,
		nextEvents,
		existingCheckpoint,
		confirmedRange,
	); err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}

	checkpoint := confirmedRange.Checkpoint
	s.payments = nextPayments
	s.order = nextOrder
	s.events = nextEvents
	s.indexerCheckpoint = &checkpoint
	return nil
}

func (s *MemoryStore) GetEventsByPayment(_ context.Context, paymentID string) ([]*models.BlockchainEvent, error) {
	s.eventMu.RLock()
	defer s.eventMu.RUnlock()
	events := s.events[paymentID]
	result := make([]*models.BlockchainEvent, len(events))
	for i, event := range events {
		result[i] = cloneEvent(event)
	}
	return result, nil
}

func clonePayment(payment *models.Payment) *models.Payment {
	if payment == nil {
		return nil
	}
	copy := *payment
	return &copy
}

func cloneEvent(event *models.BlockchainEvent) *models.BlockchainEvent {
	if event == nil {
		return nil
	}
	copy := *event
	if event.RiskScore != nil {
		riskScore := *event.RiskScore
		copy.RiskScore = &riskScore
	}
	return &copy
}

func sameEvent(left, right *models.BlockchainEvent) bool {
	return left != nil && right != nil &&
		left.BlockHeight == right.BlockHeight && strings.EqualFold(left.TxHash, right.TxHash) &&
		strings.EqualFold(left.EventType, right.EventType) && strings.EqualFold(left.PaymentID, right.PaymentID)
}

func (s *MemoryStore) LoadIndexerCheckpoint(_ context.Context) (IndexerCheckpoint, bool, error) {
	s.eventMu.RLock()
	defer s.eventMu.RUnlock()
	if s.indexerCheckpoint == nil {
		return IndexerCheckpoint{}, false, nil
	}
	return *s.indexerCheckpoint, true, nil
}

func (s *MemoryStore) SaveIndexerCheckpoint(_ context.Context, checkpoint IndexerCheckpoint) error {
	s.eventMu.Lock()
	defer s.eventMu.Unlock()
	value := checkpoint
	s.indexerCheckpoint = &value
	return nil
}

func clonePayments(payments map[string]*models.Payment) map[string]*models.Payment {
	cloned := make(map[string]*models.Payment, len(payments))
	for id, payment := range payments {
		cloned[id] = clonePayment(payment)
	}
	return cloned
}

func cloneEvents(events map[string][]*models.BlockchainEvent) map[string][]*models.BlockchainEvent {
	cloned := make(map[string][]*models.BlockchainEvent, len(events))
	for paymentID, paymentEvents := range events {
		clonedEvents := make([]*models.BlockchainEvent, len(paymentEvents))
		for index, event := range paymentEvents {
			clonedEvents[index] = cloneEvent(event)
		}
		cloned[paymentID] = clonedEvents
	}
	return cloned
}
