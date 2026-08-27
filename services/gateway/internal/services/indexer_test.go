package services

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"go.uber.org/zap"

	"github.com/aethelred/noblepay-gateway/internal/models"
	"github.com/aethelred/noblepay-gateway/internal/store"
)

func TestVerifiedWebhookIsNotificationOnlyAndRequiresMatchingReceipt(t *testing.T) {
	const contract = "0x1111111111111111111111111111111111111111"
	const txHash = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	const paymentID = "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
	const blockHash = "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
	const sender = "0x2222222222222222222222222222222222222222"
	const recipient = "0x3333333333333333333333333333333333333333"
	const token = "0x4444444444444444444444444444444444444444"
	const blockTimestamp = uint64(1700000000)
	data := "0x" + fmt.Sprintf("%064x", 1_500_000) + strings.Repeat("0", 24) + token[2:] +
		fmt.Sprintf("%x", []byte("USD")) + strings.Repeat("0", 58)
	rpcClient := &http.Client{Transport: rpcRoundTripFunc(func(r *http.Request) (*http.Response, error) {
		var request struct {
			Method string `json:"method"`
		}
		_ = json.NewDecoder(r.Body).Decode(&request)
		var result any
		switch request.Method {
		case "eth_getTransactionReceipt":
			result = map[string]any{
				"blockNumber": "0x2a", "blockHash": blockHash, "status": "0x1", "transactionHash": txHash,
				"logs": []map[string]any{{
					"address": contract, "blockNumber": "0x2a", "blockHash": blockHash,
					"transactionHash": txHash, "transactionIndex": "0x0", "logIndex": "0x1",
					"topics": []string{PaymentInitiatedTopic, paymentID, addressTopic(sender), addressTopic(recipient)},
					"data":   data, "removed": false,
				}},
			}
		case "eth_getBlockByNumber":
			result = map[string]any{"number": "0x2a", "hash": blockHash, "timestamp": fmt.Sprintf("0x%x", blockTimestamp)}
		case "eth_blockNumber":
			result = "0x2c"
		default:
			t.Fatalf("unexpected method %s", request.Method)
		}
		encoded, err := json.Marshal(map[string]any{
			"jsonrpc": "2.0", "id": 1, "result": result,
		})
		if err != nil {
			return nil, err
		}
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     make(http.Header),
			Body:       io.NopCloser(bytes.NewReader(encoded)),
		}, nil
	})}

	storage := store.NewMemoryStore()
	indexer := NewConfirmedRPCBlockchainIndexer(storage, "http://rpc.invalid", contract, 0, 2, time.Second, zap.NewNop())
	indexer.httpClient = rpcClient
	event := &models.BlockchainEvent{TxHash: txHash, EventType: PaymentInitiatedTopic, PaymentID: paymentID}
	if err := indexer.VerifyAndIndexEvent(context.Background(), event); err != nil {
		t.Fatal(err)
	}
	if event.BlockHeight != 42 {
		t.Fatalf("expected verified block 42, got %d", event.BlockHeight)
	}
	events, _ := storage.GetEventsByPayment(context.Background(), paymentID)
	if len(events) != 0 {
		t.Fatalf("verified webhook bypassed confirmed-range projection; events=%d", len(events))
	}
	if _, err := storage.GetByID(context.Background(), paymentID); err != models.ErrPaymentNotFound {
		t.Fatalf("verified webhook created an out-of-checkpoint projection: %v", err)
	}
	if event.SenderAddress != sender || event.ReceiverAddress != recipient || event.TokenAddress != token ||
		event.Amount != "1500000" || event.Currency != "USD" || event.ProjectedStatus != models.PaymentStatusPending {
		t.Fatalf("unexpected canonical webhook notification: %+v", event)
	}
	if !event.Timestamp.Equal(time.Unix(int64(blockTimestamp), 0).UTC()) {
		t.Fatalf("notification used non-canonical timestamp %s", event.Timestamp)
	}

	bad := &models.BlockchainEvent{TxHash: txHash, EventType: PaymentInitiatedTopic, PaymentID: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"}
	if err := indexer.VerifyAndIndexEvent(context.Background(), bad); err == nil {
		t.Fatal("expected mismatched payment topic to fail")
	}
}

func TestAnchoredIndexerRejectsWrongChainAndSameIDWrongAnchor(t *testing.T) {
	const contract = "0x1111111111111111111111111111111111111111"
	const expectedAnchor = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	for _, test := range []struct {
		name       string
		chainID    string
		anchorHash string
		message    string
	}{
		{name: "wrong chain", chainID: "0x1", anchorHash: expectedAnchor, message: "chain ID"},
		{name: "same ID wrong anchor", chainID: "0x1ca4", anchorHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", message: "anchor hash mismatch"},
	} {
		t.Run(test.name, func(t *testing.T) {
			rpc := networkIdentityRPC(t, test.chainID, func() string { return test.anchorHash })
			defer rpc.Close()
			indexer := NewAnchoredConfirmedRPCBlockchainIndexer(
				store.NewMemoryStore(), rpc.URL, contract, 0, 2,
				7332, 1, expectedAnchor, time.Hour, zap.NewNop(),
			)
			err := indexer.Start(context.Background())
			if err == nil || !strings.Contains(err.Error(), test.message) {
				t.Fatalf("expected %s rejection, got %v", test.message, err)
			}
		})
	}
}

func TestAnchoredIndexerRejectsRPCIdentityDriftBeforePoll(t *testing.T) {
	const contract = "0x1111111111111111111111111111111111111111"
	const expectedAnchor = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	var drifted atomic.Bool
	rpc := networkIdentityRPC(t, "0x1ca4", func() string {
		if drifted.Load() {
			return "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
		}
		return expectedAnchor
	})
	defer rpc.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	indexer := NewAnchoredConfirmedRPCBlockchainIndexer(
		store.NewMemoryStore(), rpc.URL, contract, 0, 2,
		7332, 1, expectedAnchor, time.Hour, zap.NewNop(),
	)
	if err := indexer.Start(ctx); err != nil {
		t.Fatalf("start anchored indexer: %v", err)
	}
	defer indexer.Stop()
	drifted.Store(true)
	if err := indexer.poll(ctx); err == nil || !strings.Contains(err.Error(), "anchor hash mismatch") {
		t.Fatalf("expected identity drift rejection before poll, got %v", err)
	}
	if err := indexer.Ready(); err == nil {
		t.Fatal("drifted indexer must not remain ready")
	}
}

func TestAnchoredIndexerRejectsRPCIdentityDriftBeforeWebhookProjection(t *testing.T) {
	const contract = "0x1111111111111111111111111111111111111111"
	const expectedAnchor = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	const driftedAnchor = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	const txHash = "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
	const paymentID = "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"

	var drifted atomic.Bool
	var receiptCalls atomic.Int64
	rpc := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			Method string `json:"method"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Error(err)
			return
		}
		var result any
		switch request.Method {
		case "eth_chainId":
			result = "0x1ca4"
		case "eth_getBlockByNumber":
			hash := expectedAnchor
			if drifted.Load() {
				hash = driftedAnchor
			}
			result = map[string]any{"number": "0x1", "hash": hash, "timestamp": "0x1"}
		case "eth_getCode":
			result = "0x6000"
		case "eth_blockNumber":
			result = "0x0"
		case "eth_getTransactionReceipt":
			receiptCalls.Add(1)
			result = nil
		default:
			t.Errorf("unexpected RPC method %s", request.Method)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": 1, "result": result})
	}))
	defer rpc.Close()

	storage := store.NewMemoryStore()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	indexer := NewAnchoredConfirmedRPCBlockchainIndexer(
		storage, rpc.URL, contract, 0, 2,
		7332, 1, expectedAnchor, time.Hour, zap.NewNop(),
	)
	if err := indexer.Start(ctx); err != nil {
		t.Fatalf("start anchored indexer: %v", err)
	}
	defer indexer.Stop()

	drifted.Store(true)
	event := &models.BlockchainEvent{
		TxHash: txHash, EventType: PaymentInitiatedTopic, PaymentID: paymentID,
	}
	if err := indexer.VerifyAndIndexEvent(ctx, event); err == nil || !strings.Contains(err.Error(), "anchor hash mismatch") {
		t.Fatalf("expected identity drift rejection before webhook verification, got %v", err)
	}
	if receiptCalls.Load() != 0 {
		t.Fatalf("drifted RPC receipt must not be queried; calls=%d", receiptCalls.Load())
	}
	if events, err := storage.GetEventsByPayment(ctx, paymentID); err != nil || len(events) != 0 {
		t.Fatalf("identity drift must not persist an event; events=%d err=%v", len(events), err)
	}
	if _, err := storage.GetByID(ctx, paymentID); err != models.ErrPaymentNotFound {
		t.Fatalf("identity drift must not create a payment projection, got %v", err)
	}
	if err := indexer.Ready(); err == nil {
		t.Fatal("drifted webhook verification must mark the indexer unready")
	}
}

func networkIdentityRPC(t *testing.T, chainID string, anchorHash func() string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			Method string            `json:"method"`
			Params []json.RawMessage `json:"params"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Error(err)
			return
		}
		var result any
		switch request.Method {
		case "eth_chainId":
			result = chainID
		case "eth_getBlockByNumber":
			result = map[string]any{"number": "0x1", "hash": anchorHash(), "timestamp": "0x1"}
		case "eth_getCode":
			result = "0x6000"
		case "eth_blockNumber":
			result = "0x0"
		default:
			t.Errorf("unexpected RPC method %s", request.Method)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": 1, "result": result})
	}))
}

func addressTopic(address string) string {
	return "0x" + strings.Repeat("0", 24) + address[2:]
}

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
