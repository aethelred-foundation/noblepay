package services

import (
	"context"
	"testing"
	"time"

	"go.uber.org/zap"

	"github.com/aethelred/noblepay-gateway/internal/store"
)

func TestIndexerRunContextCancel(t *testing.T) {
	logger := zap.NewNop()
	memStore := store.NewMemoryStore()
	indexer := NewBlockchainIndexer(memStore, logger)

	ctx, cancel := context.WithCancel(context.Background())

	done := make(chan struct{})
	go func() {
		indexer.run(ctx)
		close(done)
	}()

	// Cancel context to trigger the ctx.Done() branch
	cancel()

	select {
	case <-done:
		// success
	case <-time.After(2 * time.Second):
		t.Fatal("run did not exit after context cancel")
	}
}

func TestIndexerRunStopSignal(t *testing.T) {
	logger := zap.NewNop()
	memStore := store.NewMemoryStore()
	indexer := NewBlockchainIndexer(memStore, logger)

	ctx := context.Background()

	done := make(chan struct{})
	go func() {
		indexer.run(ctx)
		close(done)
	}()

	// Send stop signal to trigger the stopCh branch
	indexer.Stop()

	select {
	case <-done:
		// success
	case <-time.After(2 * time.Second):
		t.Fatal("run did not exit after stop signal")
	}
}

func TestIndexerStartStop(t *testing.T) {
	logger := zap.NewNop()
	memStore := store.NewMemoryStore()
	indexer := NewBlockchainIndexer(memStore, logger)

	ctx := context.Background()
	indexer.Start(ctx)

	// Brief pause to let goroutine start
	time.Sleep(20 * time.Millisecond)

	indexer.Stop()

	// Brief pause to let goroutine exit
	time.Sleep(20 * time.Millisecond)
}

func TestIndexerRunTickerHeartbeat(t *testing.T) {
	logger := zap.NewNop()
	memStore := store.NewMemoryStore()
	indexer := NewBlockchainIndexer(memStore, logger)
	// Use a very short tick interval to trigger the ticker.C case
	indexer.tickInterval = 10 * time.Millisecond

	ctx, cancel := context.WithCancel(context.Background())

	done := make(chan struct{})
	go func() {
		indexer.run(ctx)
		close(done)
	}()

	// Wait long enough for at least one tick
	time.Sleep(50 * time.Millisecond)

	// Cancel to stop
	cancel()

	select {
	case <-done:
		// success
	case <-time.After(2 * time.Second):
		t.Fatal("run did not exit after context cancel")
	}
}
