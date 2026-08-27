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
	Payments         map[string]*models.Payment           `json:"payments"`
	Order            []string                             `json:"order"`
	Events           map[string][]*models.BlockchainEvent `json:"events"`
	IndexerBlock     *uint64                              `json:"indexer_block,omitempty"`
	IndexerBlockHash string                               `json:"indexer_block_hash,omitempty"`
}

func (s *FileStore) LoadIndexerCheckpoint(_ context.Context) (IndexerCheckpoint, bool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.data.IndexerBlock == nil {
		return IndexerCheckpoint{}, false, nil
	}
	return IndexerCheckpoint{Height: *s.data.IndexerBlock, BlockHash: s.data.IndexerBlockHash}, true, nil
}

func (s *FileStore) SaveIndexerCheckpoint(_ context.Context, checkpoint IndexerCheckpoint) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	next := cloneFileData(s.data)
	value := checkpoint.Height
	next.IndexerBlock = &value
	next.IndexerBlockHash = checkpoint.BlockHash
	if err := s.persist(next); err != nil {
		return err
	}
	s.data = next
	return nil
}

// FileStore is a file-backed durable implementation of PaymentStore and EventStore.
// It writes the full state to a JSON file using atomic rename (write-ahead)
// before returning success from any mutating operation.
type FileStore struct {
	mu            sync.RWMutex
	path          string
	data          fileData
	flushOverride func(fileData) error
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
func (s *FileStore) flush(data fileData) error {
	raw, err := json.MarshalIndent(data, "", "  ")
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
	directory, err := os.Open(dir)
	if err != nil {
		return fmt.Errorf("file store: open parent directory: %w", err)
	}
	defer directory.Close()
	if err := directory.Sync(); err != nil {
		return fmt.Errorf("file store: sync parent directory: %w", err)
	}
	return nil
}

func (s *FileStore) persist(data fileData) error {
	if s.flushOverride != nil {
		return s.flushOverride(data)
	}
	return s.flush(data)
}

func (s *FileStore) Create(_ context.Context, payment *models.Payment) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	next := cloneFileData(s.data)
	next.Payments[payment.ID] = clonePayment(payment)
	next.Order = append(next.Order, payment.ID)
	if err := s.persist(next); err != nil {
		return err
	}
	s.data = next
	return nil
}

func (s *FileStore) GetByID(_ context.Context, id string) (*models.Payment, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	p, ok := s.data.Payments[id]
	if !ok {
		return nil, models.ErrPaymentNotFound
	}
	return clonePayment(p), nil
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
		result = append(result, clonePayment(s.data.Payments[id]))
	}
	return result, nil
}

func (s *FileStore) Update(_ context.Context, payment *models.Payment) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.data.Payments[payment.ID]
	if !ok {
		return models.ErrPaymentNotFound
	}
	next := cloneFileData(s.data)
	next.Payments[payment.ID] = clonePayment(payment)
	if err := s.persist(next); err != nil {
		return err
	}
	s.data = next
	return nil
}

func (s *FileStore) SaveEvent(_ context.Context, event *models.BlockchainEvent) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, existing := range s.data.Events[event.PaymentID] {
		if sameEvent(existing, event) {
			return nil
		}
	}
	next := cloneFileData(s.data)
	next.Events[event.PaymentID] = append(next.Events[event.PaymentID], cloneEvent(event))
	if err := s.persist(next); err != nil {
		return err
	}
	s.data = next
	return nil
}

// ApplyChainEvent atomically appends a canonical log and updates the durable
// payment read model. A crash can therefore never expose a lifecycle event
// without its corresponding payment state (or the inverse).
func (s *FileStore) ApplyChainEvent(_ context.Context, event *models.BlockchainEvent) error {
	if event == nil {
		return fmt.Errorf("chain projection: nil event")
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	for _, paymentEvents := range s.data.Events {
		for _, existingEvent := range paymentEvents {
			if sameCanonicalLog(existingEvent, event) {
				if equivalentCanonicalEvent(existingEvent, event) {
					return nil
				}
				return fmt.Errorf("chain projection: canonical log identity collision")
			}
		}
	}

	projected, created, err := projectPayment(s.data.Payments[event.PaymentID], event)
	if err != nil {
		return err
	}
	next := cloneFileData(s.data)
	next.Payments[event.PaymentID] = clonePayment(projected)
	if created {
		next.Order = append(next.Order, event.PaymentID)
	}
	next.Events[event.PaymentID] = append(next.Events[event.PaymentID], cloneEvent(event))
	if err := s.persist(next); err != nil {
		return err
	}
	s.data = next
	return nil
}

// ApplyConfirmedChainRange persists every projection in a confirmed block
// range and the corresponding checkpoint in one atomic file replacement. The
// live in-memory state is swapped only after that durable write succeeds.
func (s *FileStore) ApplyConfirmedChainRange(ctx context.Context, confirmedRange ConfirmedChainRange) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	next := cloneFileData(s.data)
	var existingCheckpoint *IndexerCheckpoint
	if s.data.IndexerBlock != nil {
		existingCheckpoint = &IndexerCheckpoint{
			Height:    *s.data.IndexerBlock,
			BlockHash: s.data.IndexerBlockHash,
		}
	}
	if err := projectConfirmedChainRange(
		next.Payments,
		&next.Order,
		next.Events,
		existingCheckpoint,
		confirmedRange,
	); err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}

	checkpointHeight := confirmedRange.Checkpoint.Height
	next.IndexerBlock = &checkpointHeight
	next.IndexerBlockHash = confirmedRange.Checkpoint.BlockHash
	if err := s.persist(next); err != nil {
		return err
	}
	s.data = next
	return nil
}

func (s *FileStore) GetEventsByPayment(_ context.Context, paymentID string) ([]*models.BlockchainEvent, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	events := s.data.Events[paymentID]
	result := make([]*models.BlockchainEvent, len(events))
	for i, event := range events {
		result[i] = cloneEvent(event)
	}
	return result, nil
}

func cloneFileData(data fileData) fileData {
	copy := fileData{
		Payments:         clonePayments(data.Payments),
		Order:            append([]string(nil), data.Order...),
		Events:           cloneEvents(data.Events),
		IndexerBlockHash: data.IndexerBlockHash,
	}
	if data.IndexerBlock != nil {
		height := *data.IndexerBlock
		copy.IndexerBlock = &height
	}
	return copy
}
