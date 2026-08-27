package services

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aethelred/noblepay-gateway/internal/models"
	"github.com/aethelred/noblepay-gateway/internal/store"
	"go.uber.org/zap"
)

const (
	projectionContract = "0x1111111111111111111111111111111111111111"
	projectionPayment  = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	projectionSender   = "0x2222222222222222222222222222222222222222"
	projectionReceiver = "0x3333333333333333333333333333333333333333"
	projectionToken    = "0x4444444444444444444444444444444444444444"
)

type rpcRoundTripFunc func(*http.Request) (*http.Response, error)

func (roundTrip rpcRoundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return roundTrip(request)
}

func TestCanonicalPaymentLifecycleProjectionAndIdempotency(t *testing.T) {
	storage := store.NewMemoryStore()
	indexer := NewBlockchainIndexer(storage, zap.NewNop())

	initiated := mustDecodeFixture(t, initiationLog(10, 0), fixtureBlock(10))
	if err := indexer.IndexEvent(context.Background(), initiated); err != nil {
		t.Fatal(err)
	}
	cleared := mustDecodeFixture(t, lifecycleLog(PaymentClearedTopic, abiWord(17), 11, 0), fixtureBlock(11))
	if err := indexer.IndexEvent(context.Background(), cleared); err != nil {
		t.Fatal(err)
	}
	settledData := abiWord(uint64(fixtureBlock(12).Time.Unix())) + abiWord(12_345)
	settled := mustDecodeFixture(t, lifecycleLog(PaymentSettledTopic, settledData, 12, 0), fixtureBlock(12))
	if err := indexer.IndexEvent(context.Background(), settled); err != nil {
		t.Fatal(err)
	}
	if err := indexer.IndexEvent(context.Background(), settled); err != nil {
		t.Fatalf("canonical replay must be idempotent: %v", err)
	}

	payment, err := storage.GetByID(context.Background(), projectionPayment)
	if err != nil {
		t.Fatal(err)
	}
	if payment.Status != models.PaymentStatusSettled || payment.SettlementTxHash != settled.TxHash ||
		payment.FeeCollected != "12345" || payment.InitiationTxHash != initiated.TxHash {
		t.Fatalf("unexpected settled projection: %+v", payment)
	}
	if !payment.CreatedAt.Equal(fixtureBlock(10).Time) || !payment.UpdatedAt.Equal(fixtureBlock(12).Time) {
		t.Fatalf("projection timestamps are not canonical block timestamps: %+v", payment)
	}
	events, err := storage.GetEventsByPayment(context.Background(), projectionPayment)
	if err != nil || len(events) != 3 {
		t.Fatalf("expected exactly three durable events after replay, got %d (%v)", len(events), err)
	}

	flagged := mustDecodeFixture(t, lifecycleLog(PaymentFlaggedTopic, abiWord(75)+strings.Repeat("ab", 32), 13, 0), fixtureBlock(13))
	if err := indexer.IndexEvent(context.Background(), flagged); err == nil {
		t.Fatal("expected impossible settled -> flagged transition to fail closed")
	}
}

func TestDecodeAllCanonicalLifecycleEvents(t *testing.T) {
	timestamp := uint64(fixtureBlock(20).Time.Unix())
	tests := []struct {
		name      string
		topic     string
		data      string
		status    models.PaymentStatus
		riskScore *uint8
	}{
		{name: "cleared", topic: PaymentClearedTopic, data: abiWord(9), status: models.PaymentStatusPassed, riskScore: uint8Pointer(9)},
		{name: "flagged", topic: PaymentFlaggedTopic, data: abiWord(71) + strings.Repeat("ab", 32), status: models.PaymentStatusFlagged, riskScore: uint8Pointer(71)},
		{name: "blocked", topic: PaymentBlockedTopic, data: strings.Repeat("cd", 32), status: models.PaymentStatusBlocked},
		{name: "settled", topic: PaymentSettledTopic, data: abiWord(timestamp) + abiWord(500), status: models.PaymentStatusSettled},
		{name: "refunded", topic: PaymentRefundedTopic, data: abiWord(timestamp), status: models.PaymentStatusRefunded},
	}
	for index, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			event, err := decodeCanonicalPaymentLog(lifecycleLog(test.topic, test.data, 20, uint64(index)), fixtureBlock(20))
			if err != nil {
				t.Fatal(err)
			}
			if event.EventType != test.topic || event.ProjectedStatus != test.status || event.EventName == "" {
				t.Fatalf("unexpected decoded event: %+v", event)
			}
			if test.riskScore != nil && (event.RiskScore == nil || *event.RiskScore != *test.riskScore) {
				t.Fatalf("unexpected risk score: %+v", event.RiskScore)
			}
		})
	}
}

func TestMalformedCanonicalLifecycleLogsFailClosed(t *testing.T) {
	block := fixtureBlock(30)
	tests := []struct {
		name string
		log  rpcLog
	}{
		{name: "unknown topic", log: lifecycleLog("0x"+strings.Repeat("ff", 32), abiWord(1), 30, 0)},
		{name: "risk overflow", log: lifecycleLog(PaymentClearedTopic, strings.Repeat("00", 30)+"0100", 30, 1)},
		{name: "risk over policy maximum", log: lifecycleLog(PaymentClearedTopic, abiWord(101), 30, 2)},
		{name: "settlement timestamp mismatch", log: lifecycleLog(PaymentSettledTopic, abiWord(1)+abiWord(0), 30, 3)},
		{name: "extra lifecycle topic", log: func() rpcLog {
			log := lifecycleLog(PaymentBlockedTopic, strings.Repeat("ab", 32), 30, 4)
			log.Topics = append(log.Topics, projectionPayment)
			return log
		}()},
		{name: "short data", log: lifecycleLog(PaymentFlaggedTopic, abiWord(80), 30, 5)},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := decodeCanonicalPaymentLog(test.log, block); err == nil {
				t.Fatal("expected malformed canonical event to fail")
			}
		})
	}
}

func TestConfirmedPollProjectsInCanonicalOrderAndResumesFromHashCheckpoint(t *testing.T) {
	const latest = uint64(102)
	var mu sync.Mutex
	getLogsCalls := 0
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
		case "eth_getCode":
			result = "0x6000"
		case "eth_blockNumber":
			result = fmt.Sprintf("0x%x", latest)
		case "eth_getBlockByNumber":
			var number string
			if err := json.Unmarshal(request.Params[0], &number); err != nil {
				t.Fatal(err)
			}
			height, err := parseHexUint64(number)
			if err != nil {
				t.Fatal(err)
			}
			block := fixtureBlock(height)
			result = map[string]any{"number": block.Number, "hash": block.Hash, "timestamp": block.Timestamp}
		case "eth_getLogs":
			mu.Lock()
			getLogsCalls++
			mu.Unlock()
			settledBlock := fixtureBlock(100)
			result = []rpcLog{
				lifecycleLog(PaymentSettledTopic, abiWord(uint64(settledBlock.Time.Unix()))+abiWord(250), 100, 0),
				initiationLog(98, 0),
				lifecycleLog(PaymentClearedTopic, abiWord(4), 99, 0),
			}
		default:
			t.Fatalf("unexpected RPC method %s", request.Method)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": 1, "result": result})
	}))
	defer rpc.Close()

	path := filepath.Join(t.TempDir(), "gateway.json")
	storage, err := store.NewFileStore(path)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	indexer := NewConfirmedRPCBlockchainIndexer(storage, rpc.URL, projectionContract, 98, 2, time.Hour, zap.NewNop())
	if err := indexer.Start(ctx); err != nil {
		t.Fatal(err)
	}
	indexer.Stop()
	cancel()

	payment, err := storage.GetByID(context.Background(), projectionPayment)
	if err != nil {
		t.Fatal(err)
	}
	if payment.Status != models.PaymentStatusSettled || payment.FeeCollected != "250" {
		t.Fatalf("logs were not projected in canonical order: %+v", payment)
	}
	checkpoint, exists, err := storage.LoadIndexerCheckpoint(context.Background())
	if err != nil || !exists || checkpoint.Height != 100 || checkpoint.BlockHash != fixtureBlock(100).Hash {
		t.Fatalf("unexpected durable checkpoint: %+v exists=%v err=%v", checkpoint, exists, err)
	}

	restartedStore, err := store.NewFileStore(path)
	if err != nil {
		t.Fatal(err)
	}
	restarted := NewConfirmedRPCBlockchainIndexer(restartedStore, rpc.URL, projectionContract, 98, 2, time.Hour, zap.NewNop())
	restartCtx, restartCancel := context.WithCancel(context.Background())
	if err := restarted.Start(restartCtx); err != nil {
		t.Fatal(err)
	}
	restarted.Stop()
	restartCancel()
	mu.Lock()
	defer mu.Unlock()
	if getLogsCalls != 1 {
		t.Fatalf("restart replayed an already-checkpointed range; eth_getLogs calls=%d", getLogsCalls)
	}
}

func TestReorgBetweenDecodeAndAtomicCommitLeavesPriorProjectionAndCheckpoint(t *testing.T) {
	storage := store.NewMemoryStore()
	initial := mustDecodeFixture(t, initiationLog(49, 0), fixtureBlock(49))
	if err := storage.ApplyConfirmedChainRange(context.Background(), store.ConfirmedChainRange{
		FromHeight: 49,
		Events:     []*models.BlockchainEvent{initial},
		Checkpoint: store.IndexerCheckpoint{Height: 49, BlockHash: fixtureBlock(49).Hash},
	}); err != nil {
		t.Fatal(err)
	}

	var block50Calls int
	rpcClient := &http.Client{Transport: rpcRoundTripFunc(func(r *http.Request) (*http.Response, error) {
		var request struct {
			Method string            `json:"method"`
			Params []json.RawMessage `json:"params"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Fatal(err)
		}
		var result any
		switch request.Method {
		case "eth_getCode":
			result = "0x6000"
		case "eth_blockNumber":
			result = "0x34" // 52, confirmed through block 50
		case "eth_getLogs":
			result = []rpcLog{lifecycleLog(PaymentClearedTopic, abiWord(8), 50, 0)}
		case "eth_getBlockByNumber":
			var quantity string
			if err := json.Unmarshal(request.Params[0], &quantity); err != nil {
				t.Fatal(err)
			}
			height, err := parseHexUint64(quantity)
			if err != nil {
				t.Fatal(err)
			}
			block := fixtureBlock(height)
			if height == 50 {
				block50Calls++
				if block50Calls >= 2 {
					block.Hash = "0x" + strings.Repeat("ff", 32)
				}
			}
			result = map[string]any{"number": block.Number, "hash": block.Hash, "timestamp": block.Timestamp}
		default:
			t.Fatalf("unexpected RPC method %s", request.Method)
		}
		encoded, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "result": result})
		if err != nil {
			return nil, err
		}
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     make(http.Header),
			Body:       io.NopCloser(bytes.NewReader(encoded)),
		}, nil
	})}

	indexer := NewConfirmedRPCBlockchainIndexer(storage, "http://rpc.invalid", projectionContract, 0, 2, time.Hour, zap.NewNop())
	indexer.httpClient = rpcClient
	err := indexer.Start(context.Background())
	if err == nil || !strings.Contains(err.Error(), "changed before commit") {
		t.Fatalf("expected pre-commit reorg rejection, got %v", err)
	}
	if err := indexer.Ready(); err == nil {
		t.Fatal("indexer must remain unready after pre-commit canonicality failure")
	}
	payment, err := storage.GetByID(context.Background(), projectionPayment)
	if err != nil || payment.Status != models.PaymentStatusPending || payment.LastEventBlock != 49 {
		t.Fatalf("reorg changed prior projection: %+v err=%v", payment, err)
	}
	events, err := storage.GetEventsByPayment(context.Background(), projectionPayment)
	if err != nil || len(events) != 1 {
		t.Fatalf("reorg appended a partial range: events=%d err=%v", len(events), err)
	}
	checkpoint, exists, err := storage.LoadIndexerCheckpoint(context.Background())
	if err != nil || !exists || checkpoint.Height != 49 || checkpoint.BlockHash != fixtureBlock(49).Hash {
		t.Fatalf("reorg advanced checkpoint: %+v exists=%v err=%v", checkpoint, exists, err)
	}
}

func TestConfirmedReorgRecoveryRebuildsFreshStoreAndStaysUnreadyUntilCaughtUp(t *testing.T) {
	temporaryDirectory := t.TempDir()
	quarantinedPath := filepath.Join(temporaryDirectory, "quarantined-gateway.json")
	quarantinedStore, err := store.NewFileStore(quarantinedPath)
	if err != nil {
		t.Fatal(err)
	}
	oldEvent := mustDecodeFixture(t, initiationLog(90, 0), fixtureBlock(90))
	if err := quarantinedStore.ApplyConfirmedChainRange(context.Background(), store.ConfirmedChainRange{
		FromHeight: 90,
		Events:     []*models.BlockchainEvent{oldEvent},
		Checkpoint: store.IndexerCheckpoint{Height: 90, BlockHash: fixtureBlock(90).Hash},
	}); err != nil {
		t.Fatal(err)
	}
	quarantinedEvidence, err := os.ReadFile(quarantinedPath)
	if err != nil {
		t.Fatal(err)
	}

	const (
		startBlock    = uint64(100)
		latestBlock   = uint64(105)
		confirmations = uint64(2)
		chainID       = uint64(7332)
		anchorBlock   = uint64(1)
	)
	anchorHash := fixtureBlock(anchorBlock).Hash
	type scannedRange struct{ from, to uint64 }
	scanned := make([]scannedRange, 0, 2)
	rpcClient := &http.Client{Transport: rpcRoundTripFunc(func(request *http.Request) (*http.Response, error) {
		var rpcRequest struct {
			Method string            `json:"method"`
			Params []json.RawMessage `json:"params"`
		}
		if err := json.NewDecoder(request.Body).Decode(&rpcRequest); err != nil {
			t.Fatal(err)
		}
		var result any
		switch rpcRequest.Method {
		case "eth_chainId":
			result = fmt.Sprintf("0x%x", chainID)
		case "eth_getCode":
			result = "0x6000"
		case "eth_blockNumber":
			result = fmt.Sprintf("0x%x", latestBlock)
		case "eth_getBlockByNumber":
			var quantity string
			if err := json.Unmarshal(rpcRequest.Params[0], &quantity); err != nil {
				t.Fatal(err)
			}
			height, err := parseHexUint64(quantity)
			if err != nil {
				t.Fatal(err)
			}
			block := fixtureBlock(height)
			result = map[string]any{"number": block.Number, "hash": block.Hash, "timestamp": block.Timestamp}
		case "eth_getLogs":
			var filter map[string]any
			if err := json.Unmarshal(rpcRequest.Params[0], &filter); err != nil {
				t.Fatal(err)
			}
			from, err := parseHexUint64(filter["fromBlock"].(string))
			if err != nil {
				t.Fatal(err)
			}
			to, err := parseHexUint64(filter["toBlock"].(string))
			if err != nil {
				t.Fatal(err)
			}
			scanned = append(scanned, scannedRange{from: from, to: to})
			logs := make([]rpcLog, 0, 1)
			if from <= 100 && to >= 100 {
				logs = append(logs, initiationLog(100, 0))
			}
			if from <= 103 && to >= 103 {
				logs = append(logs, lifecycleLog(PaymentClearedTopic, abiWord(6), 103, 0))
			}
			result = logs
		default:
			t.Fatalf("unexpected RPC method %s", rpcRequest.Method)
		}
		encoded, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "result": result})
		if err != nil {
			return nil, err
		}
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     make(http.Header),
			Body:       io.NopCloser(bytes.NewReader(encoded)),
		}, nil
	})}

	freshPath := filepath.Join(temporaryDirectory, "replacement", "gateway.json")
	if err := os.Mkdir(filepath.Dir(freshPath), 0o700); err != nil {
		t.Fatal(err)
	}
	freshStore, err := store.NewFileStore(freshPath)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	indexer := NewAnchoredConfirmedRPCBlockchainIndexer(
		freshStore,
		"http://rpc.invalid",
		projectionContract,
		startBlock,
		confirmations,
		chainID,
		anchorBlock,
		anchorHash,
		time.Hour,
		zap.NewNop(),
	)
	indexer.maxBlockRange = 2
	indexer.httpClient = rpcClient
	if err := indexer.Start(ctx); err != nil {
		t.Fatalf("start fresh recovery indexer: %v", err)
	}
	defer indexer.Stop()

	if err := indexer.Ready(); err == nil || !strings.Contains(err.Error(), "catching up") {
		t.Fatalf("replacement projection became readable before catch-up: %v", err)
	}
	checkpoint, exists, err := freshStore.LoadIndexerCheckpoint(context.Background())
	if err != nil || !exists || checkpoint.Height != 101 {
		t.Fatalf("first bounded replay range has wrong checkpoint: %+v exists=%v err=%v", checkpoint, exists, err)
	}
	if err := indexer.poll(ctx); err != nil {
		t.Fatalf("complete recovery catch-up: %v", err)
	}
	if err := indexer.Ready(); err != nil {
		t.Fatalf("replacement projection did not become ready at confirmed head: %v", err)
	}
	checkpoint, exists, err = freshStore.LoadIndexerCheckpoint(context.Background())
	if err != nil || !exists || checkpoint.Height != latestBlock-confirmations || checkpoint.BlockHash != fixtureBlock(103).Hash {
		t.Fatalf("replacement checkpoint did not reach confirmed head: %+v exists=%v err=%v", checkpoint, exists, err)
	}
	payment, err := freshStore.GetByID(context.Background(), projectionPayment)
	if err != nil || payment.Status != models.PaymentStatusPassed || payment.LastEventBlock != 103 {
		t.Fatalf("fresh replay did not rebuild canonical payment lifecycle: %+v err=%v", payment, err)
	}
	if len(scanned) != 2 || scanned[0] != (scannedRange{100, 101}) || scanned[1] != (scannedRange{102, 103}) {
		t.Fatalf("recovery did not replay exactly from configured start block: %+v", scanned)
	}
	afterRecovery, err := os.ReadFile(quarantinedPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(afterRecovery, quarantinedEvidence) {
		t.Fatal("fresh recovery modified quarantined incident evidence")
	}
}

func TestBoundedCatchUpCheckpointsEachRangeAndSurvivesRestart(t *testing.T) {
	const latest = uint64(107) // confirmed head is 105 with two confirmations
	type scannedRange struct {
		from uint64
		to   uint64
	}
	var mu sync.Mutex
	ranges := make([]scannedRange, 0, 3)
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
		case "eth_getCode":
			result = "0x6000"
		case "eth_blockNumber":
			result = fmt.Sprintf("0x%x", latest)
		case "eth_getBlockByNumber":
			var number string
			if err := json.Unmarshal(request.Params[0], &number); err != nil {
				t.Fatal(err)
			}
			height, err := parseHexUint64(number)
			if err != nil {
				t.Fatal(err)
			}
			block := fixtureBlock(height)
			result = map[string]any{"number": block.Number, "hash": block.Hash, "timestamp": block.Timestamp}
		case "eth_getLogs":
			var filter map[string]any
			if err := json.Unmarshal(request.Params[0], &filter); err != nil {
				t.Fatal(err)
			}
			from, err := parseHexUint64(filter["fromBlock"].(string))
			if err != nil {
				t.Fatal(err)
			}
			to, err := parseHexUint64(filter["toBlock"].(string))
			if err != nil {
				t.Fatal(err)
			}
			mu.Lock()
			ranges = append(ranges, scannedRange{from: from, to: to})
			mu.Unlock()
			logs := make([]rpcLog, 0, 1)
			if from <= 100 && to >= 100 {
				logs = append(logs, initiationLog(100, 0))
			}
			if from <= 103 && to >= 103 {
				logs = append(logs, lifecycleLog(PaymentClearedTopic, abiWord(5), 103, 0))
			}
			if from <= 105 && to >= 105 {
				settledBlock := fixtureBlock(105)
				logs = append(logs, lifecycleLog(
					PaymentSettledTopic,
					abiWord(uint64(settledBlock.Time.Unix()))+abiWord(250),
					105,
					0,
				))
			}
			result = logs
		default:
			t.Fatalf("unexpected RPC method %s", request.Method)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": 1, "result": result})
	}))
	defer rpc.Close()

	path := filepath.Join(t.TempDir(), "bounded-gateway.json")
	storage, err := store.NewFileStore(path)
	if err != nil {
		t.Fatal(err)
	}
	firstCtx, firstCancel := context.WithCancel(context.Background())
	first := NewConfirmedRPCBlockchainIndexer(storage, rpc.URL, projectionContract, 100, 2, time.Hour, zap.NewNop())
	first.maxBlockRange = 2
	if err := first.Start(firstCtx); err != nil {
		t.Fatal(err)
	}
	if err := first.Ready(); err == nil || !strings.Contains(err.Error(), "catching up") {
		t.Fatalf("indexer must remain unready after first bounded range, got %v", err)
	}
	checkpoint, exists, err := storage.LoadIndexerCheckpoint(context.Background())
	if err != nil || !exists || checkpoint.Height != 101 {
		t.Fatalf("first poll checkpointed beyond its range: %+v exists=%v err=%v", checkpoint, exists, err)
	}
	first.Stop()
	firstCancel()

	restartedStore, err := store.NewFileStore(path)
	if err != nil {
		t.Fatal(err)
	}
	restartCtx, restartCancel := context.WithCancel(context.Background())
	restarted := NewConfirmedRPCBlockchainIndexer(restartedStore, rpc.URL, projectionContract, 100, 2, time.Hour, zap.NewNop())
	restarted.maxBlockRange = 2
	if err := restarted.Start(restartCtx); err != nil {
		t.Fatal(err)
	}
	if err := restarted.Ready(); err == nil || !strings.Contains(err.Error(), "catching up") {
		t.Fatalf("restarted indexer must remain unready before confirmed head, got %v", err)
	}
	checkpoint, exists, err = restartedStore.LoadIndexerCheckpoint(context.Background())
	if err != nil || !exists || checkpoint.Height != 103 {
		t.Fatalf("restart did not resume at the next bounded range: %+v exists=%v err=%v", checkpoint, exists, err)
	}
	if err := restarted.poll(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := restarted.Ready(); err != nil {
		t.Fatalf("indexer should become ready exactly at confirmed head: %v", err)
	}
	checkpoint, exists, err = restartedStore.LoadIndexerCheckpoint(context.Background())
	if err != nil || !exists || checkpoint.Height != 105 {
		t.Fatalf("final range checkpoint is incorrect: %+v exists=%v err=%v", checkpoint, exists, err)
	}
	payment, err := restartedStore.GetByID(context.Background(), projectionPayment)
	if err != nil || payment.Status != models.PaymentStatusSettled {
		t.Fatalf("bounded catch-up did not preserve lifecycle projection: %+v err=%v", payment, err)
	}
	restarted.Stop()
	restartCancel()

	mu.Lock()
	defer mu.Unlock()
	want := []scannedRange{{100, 101}, {102, 103}, {104, 105}}
	if len(ranges) != len(want) {
		t.Fatalf("expected %d bounded log scans, got %d: %+v", len(want), len(ranges), ranges)
	}
	for index := range want {
		if ranges[index] != want[index] {
			t.Fatalf("scan %d was %+v, want %+v", index, ranges[index], want[index])
		}
	}
}

func TestStartRejectsCheckpointWhoseHashIsNoLongerCanonical(t *testing.T) {
	storage := store.NewMemoryStore()
	if err := storage.SaveIndexerCheckpoint(context.Background(), store.IndexerCheckpoint{
		Height: 7, BlockHash: "0x" + strings.Repeat("aa", 32),
	}); err != nil {
		t.Fatal(err)
	}
	rpc := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"jsonrpc": "2.0", "id": 1,
			"result": map[string]any{
				"number": "0x7", "hash": "0x" + strings.Repeat("bb", 32), "timestamp": "0x6553f107",
			},
		})
	}))
	defer rpc.Close()

	indexer := NewConfirmedRPCBlockchainIndexer(storage, rpc.URL, projectionContract, 0, 2, time.Hour, zap.NewNop())
	if err := indexer.Start(context.Background()); err == nil || !strings.Contains(err.Error(), "no longer canonical") {
		t.Fatalf("expected stale checkpoint hash to fail closed, got %v", err)
	}
}

func mustDecodeFixture(t *testing.T, log rpcLog, block *rpcBlock) *models.BlockchainEvent {
	t.Helper()
	event, err := decodeCanonicalPaymentLog(log, block)
	if err != nil {
		t.Fatal(err)
	}
	return event
}

func fixtureBlock(height uint64) *rpcBlock {
	timestamp := uint64(1_700_000_000) + height
	return &rpcBlock{
		Number: fmt.Sprintf("0x%x", height), Hash: fmt.Sprintf("0x%064x", height+1),
		Timestamp: fmt.Sprintf("0x%x", timestamp), Time: time.Unix(int64(timestamp), 0).UTC(),
	}
}

func initiationLog(height, logIndex uint64) rpcLog {
	block := fixtureBlock(height)
	return rpcLog{
		Address: projectionContract, BlockNumber: block.Number, BlockHash: block.Hash,
		TransactionHash: fmt.Sprintf("0x%064x", 10_000+height), TransactionIndex: "0x0",
		LogIndex: fmt.Sprintf("0x%x", logIndex),
		Topics:   []string{PaymentInitiatedTopic, projectionPayment, addressTopic(projectionSender), addressTopic(projectionReceiver)},
		Data: "0x" + abiWord(1_500_000) + strings.Repeat("0", 24) + projectionToken[2:] +
			fmt.Sprintf("%x", []byte("USD")) + strings.Repeat("0", 58),
	}
}

func lifecycleLog(topic, data string, height, logIndex uint64) rpcLog {
	block := fixtureBlock(height)
	return rpcLog{
		Address: projectionContract, BlockNumber: block.Number, BlockHash: block.Hash,
		TransactionHash: fmt.Sprintf("0x%064x", 20_000+height), TransactionIndex: "0x0",
		LogIndex: fmt.Sprintf("0x%x", logIndex), Topics: []string{topic, projectionPayment}, Data: "0x" + data,
	}
}

func abiWord(value uint64) string {
	return fmt.Sprintf("%064x", value)
}

func uint8Pointer(value uint8) *uint8 {
	return &value
}
