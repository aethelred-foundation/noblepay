package server

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"go.uber.org/zap"

	"github.com/aethelred/noblepay-gateway/internal/config"
	"github.com/aethelred/noblepay-gateway/internal/models"
	"github.com/aethelred/noblepay-gateway/internal/services"
)

func TestNewServer(t *testing.T) {
	logger := zap.NewNop()
	cfg := &config.Config{
		Port:             "0", // port 0 = random available port
		LogLevel:         "info",
		ComplianceAPIURL: "http://localhost:9999",
		RateLimitRPS:     100,
		ShutdownTimeout:  5 * time.Second,
		APIKey:           "test-key",
		Environment:      "test",
		WebhookSecret:    "test-webhook-secret",
	}

	srv, err := New(cfg, logger)
	if err != nil {
		t.Fatalf("unexpected setup error: %v", err)
	}
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

func TestProductionRouterDoesNotExposeOffChainPaymentMutations(t *testing.T) {
	cfg := &config.Config{
		Port: "0", ComplianceAPIURL: "http://127.0.0.1:9999", RateLimitRPS: 100,
		APIKey: "test-key", Environment: "test", WebhookSecret: "test-webhook-secret",
	}
	srv, err := New(cfg, zap.NewNop())
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/api/v1/payments", "/api/v1/payments/0x123/cancel"} {
		req := httptest.NewRequest(http.MethodPost, path, nil)
		req.Header.Set("X-API-Key", "test-key")
		recorder := httptest.NewRecorder()
		srv.httpServer.Handler.ServeHTTP(recorder, req)
		if recorder.Code != http.StatusMethodNotAllowed && recorder.Code != http.StatusNotFound {
			t.Fatalf("POST %s must be disabled; got %d", path, recorder.Code)
		}
	}
}

func TestPaymentProjectionReadsReturn503WhileIndexerIsUnready(t *testing.T) {
	cfg := &config.Config{
		Port: "0", ComplianceAPIURL: "http://127.0.0.1:9999", RateLimitRPS: 100,
		APIKey: "test-key", Environment: "test", WebhookSecret: "test-webhook-secret",
	}
	srv, err := New(cfg, zap.NewNop())
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/api/v1/payments", "/api/v1/payments/payment-1"} {
		request := httptest.NewRequest(http.MethodGet, path, nil)
		request.Header.Set("X-API-Key", "test-key")
		recorder := httptest.NewRecorder()
		srv.httpServer.Handler.ServeHTTP(recorder, request)
		if recorder.Code != http.StatusServiceUnavailable {
			t.Fatalf("GET %s returned %d while indexer was unready: %s", path, recorder.Code, recorder.Body.String())
		}
		if !strings.Contains(recorder.Body.String(), "canonical payment projection unavailable") ||
			strings.Contains(recorder.Body.String(), "payment-1") {
			t.Fatalf("GET %s returned stale or ambiguous data: %s", path, recorder.Body.String())
		}
	}
}

func TestProductionRouterTreatsWebhookAsNotificationAndBlocksUnreadyReads(t *testing.T) {
	const (
		contract   = "0x1111111111111111111111111111111111111111"
		paymentID  = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
		txHash     = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
		blockHash  = "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
		anchorHash = "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
		sender     = "0x2222222222222222222222222222222222222222"
		recipient  = "0x3333333333333333333333333333333333333333"
		token      = "0x4444444444444444444444444444444444444444"
		secret     = "canonical-webhook-secret"
	)
	addressTopic := func(address string) string { return "0x" + strings.Repeat("0", 24) + address[2:] }
	data := "0x" + fmt.Sprintf("%064x", 2_500_000) + strings.Repeat("0", 24) + token[2:] +
		fmt.Sprintf("%x", []byte("USD")) + strings.Repeat("0", 58)
	rpc := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			Method string            `json:"method"`
			Params []json.RawMessage `json:"params"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Fatal(err)
		}
		var result any
		switch request.Method {
		case "eth_chainId":
			result = "0x1ca4"
		case "eth_getTransactionReceipt":
			result = map[string]any{
				"blockNumber": "0x2a", "blockHash": blockHash, "status": "0x1", "transactionHash": txHash,
				"logs": []map[string]any{{
					"address": contract, "blockNumber": "0x2a", "blockHash": blockHash,
					"transactionHash": txHash, "transactionIndex": "0x0", "logIndex": "0x0",
					"topics": []string{services.PaymentInitiatedTopic, paymentID, addressTopic(sender), addressTopic(recipient)},
					"data":   data, "removed": false,
				}},
			}
		case "eth_getBlockByNumber":
			var number string
			if len(request.Params) == 0 || json.Unmarshal(request.Params[0], &number) != nil {
				t.Fatal("eth_getBlockByNumber requires a block quantity")
			}
			switch number {
			case "0x1":
				result = map[string]any{"number": "0x1", "hash": anchorHash, "timestamp": "0x1"}
			case "0x2a":
				result = map[string]any{"number": "0x2a", "hash": blockHash, "timestamp": "0x6553f100"}
			default:
				t.Fatalf("unexpected block quantity %s", number)
			}
		default:
			t.Fatalf("unexpected RPC method %s", request.Method)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": 1, "result": result})
	}))
	defer rpc.Close()

	cfg := &config.Config{
		Port: "0", ComplianceAPIURL: "http://127.0.0.1:9999", RateLimitRPS: 100,
		APIKey: "test-key", Environment: "test", WebhookSecret: secret,
		StorePath: filepath.Join(t.TempDir(), "gateway.json"), ChainRPCURL: rpc.URL,
		NoblePayAddress: contract, IndexerPollInterval: time.Hour,
		ChainID: 7332, NetworkAnchorBlock: 1, NetworkAnchorHash: anchorHash,
	}
	srv, err := New(cfg, zap.NewNop())
	if err != nil {
		t.Fatal(err)
	}
	payload, err := json.Marshal(models.WebhookEvent{
		WebhookID: "canonical-init-1", Type: services.PaymentInitiatedTopic,
		PaymentID: paymentID, TxHash: txHash, Data: "caller-controlled-fields-must-not-be-projected",
	})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/api/v1/webhooks/events", bytes.NewReader(payload))
	request.Header.Set("X-API-Key", "test-key")
	request.Header.Set("X-Webhook-Timestamp", fmt.Sprintf("%d", time.Now().Unix()))
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write(payload)
	request.Header.Set("X-Webhook-Signature", hex.EncodeToString(mac.Sum(nil)))
	recorder := httptest.NewRecorder()
	srv.httpServer.Handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusAccepted {
		t.Fatalf("verified webhook returned %d: %s", recorder.Code, recorder.Body.String())
	}
	var notification map[string]string
	if err := json.NewDecoder(recorder.Body).Decode(&notification); err != nil {
		t.Fatal(err)
	}
	if notification["status"] != "verified_notification" || notification["projection"] != "confirmed_range_indexer" {
		t.Fatalf("webhook response did not disclose notification-only semantics: %+v", notification)
	}

	getRequest := httptest.NewRequest(http.MethodGet, "/api/v1/payments/"+paymentID, nil)
	getRequest.Header.Set("X-API-Key", "test-key")
	getRecorder := httptest.NewRecorder()
	srv.httpServer.Handler.ServeHTTP(getRecorder, getRequest)
	if getRecorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("unready projection read returned %d: %s", getRecorder.Code, getRecorder.Body.String())
	}
	if strings.Contains(getRecorder.Body.String(), paymentID) || strings.Contains(getRecorder.Body.String(), "2500000") {
		t.Fatalf("unready response leaked stale projection data: %s", getRecorder.Body.String())
	}
}

func TestNewRejectsEmptyProductionCredentialsEvenWhenConfigIsConstructedDirectly(t *testing.T) {
	_, err := New(&config.Config{Environment: "production"}, zap.NewNop())
	if err == nil || !strings.Contains(err.Error(), "GATEWAY_API_KEY") {
		t.Fatalf("expected missing API key construction error, got %v", err)
	}
	_, err = New(&config.Config{Environment: "production", APIKey: "configured"}, zap.NewNop())
	if err == nil || !strings.Contains(err.Error(), "WEBHOOK_SECRET") {
		t.Fatalf("expected missing webhook secret construction error, got %v", err)
	}
}

func TestServerStartAndShutdown(t *testing.T) {
	logger := zap.NewNop()
	cfg := &config.Config{
		Port:             "0",
		LogLevel:         "info",
		ComplianceAPIURL: "http://localhost:9999",
		RateLimitRPS:     100,
		ShutdownTimeout:  5 * time.Second,
		APIKey:           "test-key",
		Environment:      "test",
	}

	srv, err := New(cfg, logger)
	if err != nil {
		t.Fatalf("unexpected setup error: %v", err)
	}

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
	err = <-errCh
	if err != nil && err != http.ErrServerClosed {
		t.Fatalf("unexpected error from Start: %v", err)
	}
}
