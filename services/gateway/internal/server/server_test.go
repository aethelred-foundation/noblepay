package server

import (
	"context"
	"net/http"
	"testing"
	"time"

	"go.uber.org/zap"

	"github.com/aethelred/noblepay-gateway/internal/config"
)

func TestNewServer(t *testing.T) {
	logger := zap.NewNop()
	cfg := &config.Config{
		Port:            "0", // port 0 = random available port
		LogLevel:        "info",
		ComplianceURL:   "http://localhost:9999",
		RateLimitRPS:    100,
		ShutdownTimeout: 5 * time.Second,
		APIKey:          "test-key",
		Environment:     "test",
		WebhookSecret:   "test-webhook-secret",
	}

	srv := New(cfg, logger)
	if srv == nil {
		t.Fatal("expected non-nil server")
	}
	if srv.httpServer == nil {
		t.Fatal("expected non-nil http server")
	}
	if srv.indexer == nil {
		t.Fatal("expected non-nil indexer")
	}
}

func TestServerStartAndShutdown(t *testing.T) {
	logger := zap.NewNop()
	cfg := &config.Config{
		Port:            "0",
		LogLevel:        "info",
		ComplianceURL:   "http://localhost:9999",
		RateLimitRPS:    100,
		ShutdownTimeout: 5 * time.Second,
		APIKey:          "test-key",
	}

	srv := New(cfg, logger)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	errCh := make(chan error, 1)
	go func() {
		errCh <- srv.Start(ctx)
	}()

	// Give the server a moment to start
	time.Sleep(100 * time.Millisecond)

	// Shut it down
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer shutdownCancel()

	if err := srv.Shutdown(shutdownCtx); err != nil {
		t.Fatalf("shutdown failed: %v", err)
	}

	// Start should return http.ErrServerClosed
	err := <-errCh
	if err != nil && err != http.ErrServerClosed {
		t.Fatalf("unexpected error from Start: %v", err)
	}
}
