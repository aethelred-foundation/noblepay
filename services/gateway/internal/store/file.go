package store

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"

	"github.com/aethelred/noblepay-gateway/internal/models"
)

// fileData is the on-disk JSON structure.
type fileData struct {
	Payments map[string]*models.Payment            `json:"payments"`
	Order    []string                              `json:"order"`
	Events   map[string][]*models.BlockchainEvent  `json:"events"`
}

// FileStore is a file-backed durable implementation of PaymentStore and EventStore.
// It writes the full state to a JSON file using atomic rename (write-ahead)
// before returning success from any mutating operation.
type FileStore struct {
	mu   sync.RWMutex
	path string
	data fileData
}

// NewFileStore creates a new file-backed store. If the file already exists
// it is loaded into memory. Otherwise a fresh store is initialised.
func NewFileStore(path string) (*FileStore, error) {
	s := &FileStore{
		path: path,
		data: fileData{
			Payments: make(map[string]*models.Payment),
			Events:   make(map[string][]*models.BlockchainEvent),
		},
	}

	if _, err := os.Stat(path); err == nil {
		raw, readErr := os.ReadFile(path)
		if readErr != nil {
			return nil, fmt.Errorf("file store: read %s: %w", path, readErr)
		}
		if len(raw) > 0 {
			if jsonErr := json.Unmarshal(raw, &s.data); jsonErr != nil {
				return nil, fmt.Errorf("file store: parse %s: %w", path, jsonErr)
			}
		}
		// Ensure maps are non-nil after unmarshal.
		if s.data.Payments == nil {
			s.data.Payments = make(map[string]*models.Payment)
		}
		if s.data.Events == nil {
			s.data.Events = make(map[string][]*models.BlockchainEvent)
		}
	}

	return s, nil
}

// flush writes the current state to disk atomically: write to a temp file
// in the same directory, then rename over the target path.
func (s *FileStore) flush() error {
	raw, err := json.MarshalIndent(s.data, "", "  ")
	if err != nil {
		return fmt.Errorf("file store: marshal: %w", err)
	}

	dir := filepath.Dir(s.path)
	tmp, err := os.CreateTemp(dir, ".noblepay-store-*.tmp")
	if err != nil {
		return fmt.Errorf("file store: create temp: %w", err)
	}
	tmpName := tmp.Name()

	if _, err := tmp.Write(raw); err != nil {
		tmp.Close()
		os.Remove(tmpName)
		return fmt.Errorf("file store: write temp: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		os.Remove(tmpName)
		return fmt.Errorf("file store: sync temp: %w", err)
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpName)
		return fmt.Errorf("file store: close temp: %w", err)
	}

	if err := os.Rename(tmpName, s.path); err != nil {
		os.Remove(tmpName)
		return fmt.Errorf("file store: rename: %w", err)
	}
	return nil
}

func (s *FileStore) Create(_ context.Context, payment *models.Payment) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.data.Payments[payment.ID] = payment
	s.data.Order = append(s.data.Order, payment.ID)
	if err := s.flush(); err != nil {
		// Roll back in-memory state on flush failure.
		delete(s.data.Payments, payment.ID)
		s.data.Order = s.data.Order[:len(s.data.Order)-1]
		return err
	}
	return nil
}

func (s *FileStore) GetByID(_ context.Context, id string) (*models.Payment, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	p, ok := s.data.Payments[id]
	if !ok {
		return nil, models.ErrPaymentNotFound
	}
	return p, nil
}

func (s *FileStore) List(_ context.Context, limit, offset int) ([]*models.Payment, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	total := len(s.data.Order)
	if offset >= total {
		return []*models.Payment{}, nil
	}
	end := offset + limit
	if end > total {
		end = total
	}

	result := make([]*models.Payment, 0, end-offset)
	for _, id := range s.data.Order[offset:end] {
		result = append(result, s.data.Payments[id])
	}
	return result, nil
}

func (s *FileStore) Update(_ context.Context, payment *models.Payment) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	prev, ok := s.data.Payments[payment.ID]
	if !ok {
		return models.ErrPaymentNotFound
	}
	s.data.Payments[payment.ID] = payment
	if err := s.flush(); err != nil {
		s.data.Payments[payment.ID] = prev
		return err
	}
	return nil
}

func (s *FileStore) SaveEvent(_ context.Context, event *models.BlockchainEvent) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.data.Events[event.PaymentID] = append(s.data.Events[event.PaymentID], event)
	if err := s.flush(); err != nil {
		// Roll back.
		evts := s.data.Events[event.PaymentID]
		s.data.Events[event.PaymentID] = evts[:len(evts)-1]
		return err
	}
	return nil
}

func (s *FileStore) GetEventsByPayment(_ context.Context, paymentID string) ([]*models.BlockchainEvent, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.data.Events[paymentID], nil
}
