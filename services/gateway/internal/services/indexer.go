package services

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"math/big"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/aethelred/noblepay-gateway/internal/models"
	"github.com/aethelred/noblepay-gateway/internal/store"
	"go.uber.org/zap"
)

const (
	PaymentInitiatedTopic = "0x6da8f0a08bde2e903c0475ac9f32040171d897b9811f2e9efad54cea07427818"
	PaymentClearedTopic   = "0x39f1d8a84b0961dd884711c7a32b66e6c8755baa37a8002b26dd576b53a9cc2d"
	PaymentFlaggedTopic   = "0xb5dd5e69213b23092750ca8dcede2bd4f29c49198055f6b243ad12ced44e7526"
	PaymentBlockedTopic   = "0x767e527f44920dd8bf94181412f0c6d4e95298c285b051d046930d1d41cf1d58"
	PaymentSettledTopic   = "0xd235661899dbd3c2a99f69cdafb4e46f407f4d84a18f70dbfb11cfbdf3dc2d21"
	PaymentRefundedTopic  = "0x7a1dd09597e0454bccf83a57e47d6ce29d4f89f3dd01f54d4bcf1768b1728654"

	// defaultIndexerMaxBlockRange bounds every eth_getLogs response and every
	// checkpoint transaction. Catch-up advances one range per poll so startup
	// work is bounded and readiness remains false until the confirmed head is
	// reached.
	defaultIndexerMaxBlockRange uint64 = 2_000
)

var (
	bytes32Hex             = regexp.MustCompile(`^0x[0-9a-fA-F]{64}$`)
	canonicalPaymentTopics = []string{
		PaymentInitiatedTopic,
		PaymentClearedTopic,
		PaymentFlaggedTopic,
		PaymentBlockedTopic,
		PaymentSettledTopic,
		PaymentRefundedTopic,
	}
	eventNamesByTopic = map[string]string{
		PaymentInitiatedTopic: "PaymentInitiated",
		PaymentClearedTopic:   "PaymentCleared",
		PaymentFlaggedTopic:   "PaymentFlagged",
		PaymentBlockedTopic:   "PaymentBlocked",
		PaymentSettledTopic:   "PaymentSettled",
		PaymentRefundedTopic:  "PaymentRefunded",
	}
)

// BlockchainIndexer polls confirmed JSON-RPC logs from the deployed NoblePay
// contract. Every supported log is ABI-decoded and atomically applied to the
// durable payment projection before the canonical block checkpoint advances.
type BlockchainIndexer struct {
	eventStore      store.EventStore
	projectionStore store.ChainProjectionStore
	stateStore      store.IndexerStateStore
	rangeStore      store.ConfirmedChainRangeStore
	logger          *zap.Logger
	rpcURL          string
	contract        string
	confirmations   uint64
	expectedChainID uint64
	anchorBlock     uint64
	anchorHash      string
	requireIdentity bool
	maxBlockRange   uint64
	httpClient      *http.Client
	stopCh          chan struct{}
	stopOnce        sync.Once
	tickInterval    time.Duration
	nextBlock       uint64
	checkpoint      *store.IndexerCheckpoint
	ready           atomic.Bool
	catchingUp      atomic.Bool
	lastSuccess     atomic.Int64
}

// NewBlockchainIndexer creates a disabled test indexer. Production must use a
// real RPC constructor; this path never emits fabricated chain progress.
func NewBlockchainIndexer(es store.EventStore, logger *zap.Logger) *BlockchainIndexer {
	return newBlockchainIndexer(es, "", "", 0, 0, 10*time.Second, logger)
}

// NewRPCBlockchainIndexer creates an unconfirmed RPC indexer for isolated
// tests and backwards-compatible callers. Production should use
// NewConfirmedRPCBlockchainIndexer.
func NewRPCBlockchainIndexer(
	es store.EventStore,
	rpcURL string,
	contract string,
	startBlock uint64,
	interval time.Duration,
	logger *zap.Logger,
) *BlockchainIndexer {
	return newBlockchainIndexer(es, strings.TrimRight(rpcURL, "/"), contract, startBlock, 0, interval, logger)
}

// NewConfirmedRPCBlockchainIndexer creates a production RPC indexer that only
// checkpoints logs buried under the configured number of confirmations.
func NewConfirmedRPCBlockchainIndexer(
	es store.EventStore,
	rpcURL string,
	contract string,
	startBlock uint64,
	confirmations uint64,
	interval time.Duration,
	logger *zap.Logger,
) *BlockchainIndexer {
	return newBlockchainIndexer(es, strings.TrimRight(rpcURL, "/"), contract, startBlock, confirmations, interval, logger)
}

// NewAnchoredConfirmedRPCBlockchainIndexer creates the production indexer.
// It verifies both chain ID and an immutable block hash on startup and before
// every poll, preventing an RPC/DNS switch to another network that reuses the
// same chain ID.
func NewAnchoredConfirmedRPCBlockchainIndexer(
	es store.EventStore,
	rpcURL string,
	contract string,
	startBlock uint64,
	confirmations uint64,
	expectedChainID uint64,
	anchorBlock uint64,
	anchorHash string,
	interval time.Duration,
	logger *zap.Logger,
) *BlockchainIndexer {
	indexer := newBlockchainIndexer(es, strings.TrimRight(rpcURL, "/"), contract, startBlock, confirmations, interval, logger)
	indexer.expectedChainID = expectedChainID
	indexer.anchorBlock = anchorBlock
	indexer.anchorHash = strings.ToLower(anchorHash)
	indexer.requireIdentity = true
	return indexer
}

func newBlockchainIndexer(
	es store.EventStore,
	rpcURL string,
	contract string,
	startBlock uint64,
	confirmations uint64,
	interval time.Duration,
	logger *zap.Logger,
) *BlockchainIndexer {
	stateStore, _ := es.(store.IndexerStateStore)
	projectionStore, _ := es.(store.ChainProjectionStore)
	rangeStore, _ := es.(store.ConfirmedChainRangeStore)
	return &BlockchainIndexer{
		eventStore: es, projectionStore: projectionStore, stateStore: stateStore, rangeStore: rangeStore, logger: logger,
		rpcURL: rpcURL, contract: strings.ToLower(contract), nextBlock: startBlock, confirmations: confirmations,
		maxBlockRange: defaultIndexerMaxBlockRange,
		httpClient:    &http.Client{Timeout: 10 * time.Second},
		stopCh:        make(chan struct{}), tickInterval: interval,
	}
}

// Start validates the RPC endpoint, contract, and durable canonical checkpoint
// synchronously before spawning the poll loop.
func (bi *BlockchainIndexer) Start(ctx context.Context) error {
	if bi.rpcURL == "" {
		bi.ready.Store(true) // explicitly disabled test mode
		return nil
	}
	if bi.tickInterval <= 0 {
		return fmt.Errorf("indexer poll interval must be positive")
	}
	if bi.maxBlockRange == 0 {
		return fmt.Errorf("indexer max block range must be positive")
	}
	if bi.rangeStore == nil || bi.stateStore == nil || bi.projectionStore == nil {
		return fmt.Errorf("indexer requires one atomic confirmed-range projection and checkpoint store")
	}
	if err := bi.verifyNetworkIdentity(ctx); err != nil {
		return fmt.Errorf("verify configured network identity: %w", err)
	}

	checkpoint, exists, err := bi.stateStore.LoadIndexerCheckpoint(ctx)
	if err != nil {
		return fmt.Errorf("load indexer checkpoint: %w", err)
	}
	if exists {
		if checkpoint.Height == math.MaxUint64 || !bytes32Hex.MatchString(checkpoint.BlockHash) {
			return fmt.Errorf("invalid indexer checkpoint")
		}
		canonicalBlock, err := bi.blockByNumber(ctx, checkpoint.Height)
		if err != nil {
			return fmt.Errorf("verify indexer checkpoint: %w", err)
		}
		if !strings.EqualFold(canonicalBlock.Hash, checkpoint.BlockHash) {
			return fmt.Errorf("indexer checkpoint block hash no longer canonical")
		}
		bi.nextBlock = checkpoint.Height + 1
		bi.checkpoint = &checkpoint
	}

	var code string
	if err := bi.rpcCall(ctx, "eth_getCode", []any{bi.contract, "latest"}, &code); err != nil {
		return fmt.Errorf("validate NoblePay contract: %w", err)
	}
	if code == "" || code == "0x" || code == "0x0" {
		return fmt.Errorf("NoblePay contract has no code at %s", bi.contract)
	}
	if err := bi.poll(ctx); err != nil {
		return fmt.Errorf("initial chain poll: %w", err)
	}

	bi.logger.Info("blockchain indexer started",
		zap.String("rpc_url", bi.rpcURL), zap.String("contract", bi.contract),
		zap.Uint64("confirmations", bi.confirmations), zap.Uint64("next_block", bi.nextBlock))
	go bi.run(ctx)
	return nil
}

// Stop signals the indexer to stop and is safe to call repeatedly.
func (bi *BlockchainIndexer) Stop() {
	bi.stopOnce.Do(func() { close(bi.stopCh) })
}

func (bi *BlockchainIndexer) run(ctx context.Context) {
	if bi.rpcURL == "" {
		return
	}
	ticker := time.NewTicker(bi.tickInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			bi.logger.Info("indexer stopping: context cancelled")
			return
		case <-bi.stopCh:
			bi.logger.Info("indexer stopping: stop signal received")
			return
		case <-ticker.C:
			if err := bi.poll(ctx); err != nil {
				bi.ready.Store(false)
				bi.logger.Error("real chain poll failed", zap.Error(err))
			}
		}
	}
}

type orderedRPCLog struct {
	log              rpcLog
	blockHeight      uint64
	transactionIndex uint64
	logIndex         uint64
}

func (bi *BlockchainIndexer) poll(ctx context.Context) (err error) {
	defer func() {
		if err != nil {
			bi.ready.Store(false)
		}
	}()
	if err := bi.verifyNetworkIdentity(ctx); err != nil {
		return fmt.Errorf("verify configured network identity: %w", err)
	}
	if bi.checkpoint != nil {
		canonicalBlock, err := bi.blockByNumber(ctx, bi.checkpoint.Height)
		if err != nil {
			return fmt.Errorf("revalidate indexer checkpoint: %w", err)
		}
		if !strings.EqualFold(canonicalBlock.Hash, bi.checkpoint.BlockHash) {
			return fmt.Errorf("indexer checkpoint block hash no longer canonical")
		}
	}
	var blockHex string
	if err := bi.rpcCall(ctx, "eth_blockNumber", []any{}, &blockHex); err != nil {
		return err
	}
	latest, err := parseHexUint64(blockHex)
	if err != nil {
		return fmt.Errorf("invalid eth_blockNumber result: %w", err)
	}
	if latest < bi.confirmations {
		bi.markSuccessfulPoll(true)
		return nil
	}
	confirmedLatest := latest - bi.confirmations
	if confirmedLatest < bi.nextBlock {
		bi.markSuccessfulPoll(true)
		return nil
	}
	processedThrough := confirmedLatest
	if confirmedLatest-bi.nextBlock >= bi.maxBlockRange {
		processedThrough = bi.nextBlock + bi.maxBlockRange - 1
	}

	var logs []rpcLog
	filter := map[string]any{
		"address":   bi.contract,
		"fromBlock": fmt.Sprintf("0x%x", bi.nextBlock),
		"toBlock":   fmt.Sprintf("0x%x", processedThrough),
		"topics":    []any{canonicalPaymentTopics},
	}
	if err := bi.rpcCall(ctx, "eth_getLogs", []any{filter}, &logs); err != nil {
		return err
	}

	ordered := make([]orderedRPCLog, 0, len(logs))
	for _, chainLog := range logs {
		if chainLog.Removed {
			return fmt.Errorf("RPC returned removed log %s; operator reconciliation required", chainLog.TransactionHash)
		}
		height, err := parseHexUint64(chainLog.BlockNumber)
		if err != nil || height < bi.nextBlock || height > processedThrough {
			return fmt.Errorf("invalid or out-of-range log block number %q", chainLog.BlockNumber)
		}
		txIndex, err := parseHexUint64(chainLog.TransactionIndex)
		if err != nil {
			return fmt.Errorf("invalid log transaction index: %w", err)
		}
		logIndex, err := parseHexUint64(chainLog.LogIndex)
		if err != nil {
			return fmt.Errorf("invalid log index: %w", err)
		}
		ordered = append(ordered, orderedRPCLog{chainLog, height, txIndex, logIndex})
	}
	sort.Slice(ordered, func(i, j int) bool {
		if ordered[i].blockHeight != ordered[j].blockHeight {
			return ordered[i].blockHeight < ordered[j].blockHeight
		}
		if ordered[i].transactionIndex != ordered[j].transactionIndex {
			return ordered[i].transactionIndex < ordered[j].transactionIndex
		}
		return ordered[i].logIndex < ordered[j].logIndex
	})

	blocks := make(map[uint64]*rpcBlock)
	decodedEvents := make([]*models.BlockchainEvent, 0, len(ordered))
	for _, orderedLog := range ordered {
		block := blocks[orderedLog.blockHeight]
		if block == nil {
			block, err = bi.blockByNumber(ctx, orderedLog.blockHeight)
			if err != nil {
				return fmt.Errorf("load canonical block %d: %w", orderedLog.blockHeight, err)
			}
			blocks[orderedLog.blockHeight] = block
		}
		if !strings.EqualFold(orderedLog.log.Address, bi.contract) {
			return fmt.Errorf("RPC returned log for unexpected contract %s", orderedLog.log.Address)
		}
		event, err := decodeCanonicalPaymentLog(orderedLog.log, block)
		if err != nil {
			return fmt.Errorf("decode NoblePay log: %w", err)
		}
		decodedEvents = append(decodedEvents, event)
	}

	// Logs and their initial block contexts were loaded over several RPC calls.
	// Immediately before the single store transaction, re-check the immutable
	// network identity, the prior checkpoint, every distinct event block, and
	// the new checkpoint block. A reorg or RPC target switch during decode thus
	// leaves the previous projection and checkpoint untouched.
	if err := bi.verifyNetworkIdentity(ctx); err != nil {
		return fmt.Errorf("revalidate configured network identity before commit: %w", err)
	}
	if bi.checkpoint != nil {
		canonicalBlock, err := bi.blockByNumber(ctx, bi.checkpoint.Height)
		if err != nil {
			return fmt.Errorf("revalidate prior checkpoint before commit: %w", err)
		}
		if !strings.EqualFold(canonicalBlock.Hash, bi.checkpoint.BlockHash) {
			return fmt.Errorf("indexer checkpoint block hash changed before commit")
		}
	}
	checkpointBefore, err := bi.blockByNumber(ctx, processedThrough)
	if err != nil {
		return fmt.Errorf("revalidate checkpoint block %d before event checks: %w", processedThrough, err)
	}
	var lastValidatedEventHeight *uint64
	for _, event := range decodedEvents {
		if lastValidatedEventHeight != nil && *lastValidatedEventHeight == event.BlockHeight {
			continue
		}
		canonicalBlock, err := bi.blockByNumber(ctx, event.BlockHeight)
		if err != nil {
			return fmt.Errorf("revalidate event block %d before commit: %w", event.BlockHeight, err)
		}
		if !strings.EqualFold(canonicalBlock.Hash, event.BlockHash) {
			return fmt.Errorf("event block %d changed before commit", event.BlockHeight)
		}
		height := event.BlockHeight
		lastValidatedEventHeight = &height
	}
	checkpointBlock, err := bi.blockByNumber(ctx, processedThrough)
	if err != nil {
		return fmt.Errorf("revalidate checkpoint block %d before commit: %w", processedThrough, err)
	}
	if !strings.EqualFold(checkpointBefore.Hash, checkpointBlock.Hash) {
		return fmt.Errorf("checkpoint block %d changed during pre-commit validation", processedThrough)
	}
	checkpoint := store.IndexerCheckpoint{
		Height: processedThrough, BlockHash: checkpointBlock.Hash,
	}
	confirmedRange := store.ConfirmedChainRange{
		FromHeight: bi.nextBlock,
		Events:     decodedEvents,
		Checkpoint: checkpoint,
	}
	if err := bi.rangeStore.ApplyConfirmedChainRange(ctx, confirmedRange); err != nil {
		return fmt.Errorf("atomically persist confirmed NoblePay range: %w", err)
	}
	bi.nextBlock = processedThrough + 1
	bi.checkpoint = &checkpoint
	bi.markSuccessfulPoll(processedThrough == confirmedLatest)
	return nil
}

func (bi *BlockchainIndexer) verifyNetworkIdentity(ctx context.Context) error {
	if !bi.requireIdentity {
		return nil
	}
	if bi.expectedChainID == 0 {
		return fmt.Errorf("expected chain ID must be positive")
	}
	if !bytes32Hex.MatchString(bi.anchorHash) {
		return fmt.Errorf("expected network anchor hash is invalid")
	}
	var chainIDHex string
	if err := bi.rpcCall(ctx, "eth_chainId", []any{}, &chainIDHex); err != nil {
		return fmt.Errorf("read chain ID: %w", err)
	}
	chainID, err := parseHexUint64(chainIDHex)
	if err != nil || chainID != bi.expectedChainID {
		return fmt.Errorf("RPC chain ID does not match configured network")
	}
	anchor, err := bi.blockByNumber(ctx, bi.anchorBlock)
	if err != nil {
		return fmt.Errorf("read immutable network anchor: %w", err)
	}
	if !strings.EqualFold(anchor.Hash, bi.anchorHash) {
		return fmt.Errorf("RPC immutable network anchor hash mismatch")
	}
	return nil
}

func (bi *BlockchainIndexer) markSuccessfulPoll(caughtUp bool) {
	bi.catchingUp.Store(!caughtUp)
	bi.ready.Store(caughtUp)
	bi.lastSuccess.Store(time.Now().UnixNano())
}

// Ready reports whether a real RPC poll succeeded recently.
func (bi *BlockchainIndexer) Ready() error {
	if !bi.ready.Load() {
		if bi.catchingUp.Load() {
			return fmt.Errorf("chain indexer is catching up to the confirmed head")
		}
		return fmt.Errorf("chain indexer is not ready")
	}
	if bi.rpcURL != "" {
		last := time.Unix(0, bi.lastSuccess.Load())
		if last.IsZero() || time.Since(last) > 3*bi.tickInterval {
			return fmt.Errorf("chain indexer poll is stale")
		}
	}
	return nil
}

type rpcLog struct {
	Address          string   `json:"address"`
	BlockNumber      string   `json:"blockNumber"`
	BlockHash        string   `json:"blockHash"`
	TransactionHash  string   `json:"transactionHash"`
	TransactionIndex string   `json:"transactionIndex"`
	LogIndex         string   `json:"logIndex"`
	Data             string   `json:"data"`
	Topics           []string `json:"topics"`
	Removed          bool     `json:"removed"`
}

type rpcReceipt struct {
	BlockNumber     string   `json:"blockNumber"`
	BlockHash       string   `json:"blockHash"`
	Status          string   `json:"status"`
	TransactionHash string   `json:"transactionHash"`
	Logs            []rpcLog `json:"logs"`
}

type rpcBlock struct {
	Number    string `json:"number"`
	Hash      string `json:"hash"`
	Timestamp string `json:"timestamp"`
	Time      time.Time
}

type rpcResponse struct {
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

func (bi *BlockchainIndexer) rpcCall(ctx context.Context, method string, params any, result any) error {
	payload, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, bi.rpcURL, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := bi.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return fmt.Errorf("RPC status %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	var envelope rpcResponse
	if err := json.NewDecoder(io.LimitReader(resp.Body, 2<<20)).Decode(&envelope); err != nil {
		return err
	}
	if envelope.Error != nil {
		return fmt.Errorf("RPC %s error %d: %s", method, envelope.Error.Code, envelope.Error.Message)
	}
	if len(envelope.Result) == 0 || string(envelope.Result) == "null" {
		return fmt.Errorf("RPC %s returned no result", method)
	}
	return json.Unmarshal(envelope.Result, result)
}

func (bi *BlockchainIndexer) blockByNumber(ctx context.Context, height uint64) (*rpcBlock, error) {
	var block rpcBlock
	if err := bi.rpcCall(ctx, "eth_getBlockByNumber", []any{fmt.Sprintf("0x%x", height), false}, &block); err != nil {
		return nil, err
	}
	parsedHeight, err := parseHexUint64(block.Number)
	if err != nil || parsedHeight != height {
		return nil, fmt.Errorf("RPC returned mismatched block number %q", block.Number)
	}
	if !bytes32Hex.MatchString(block.Hash) {
		return nil, fmt.Errorf("RPC returned invalid block hash %q", block.Hash)
	}
	timestamp, err := parseHexUint64(block.Timestamp)
	if err != nil || timestamp > math.MaxInt64 {
		return nil, fmt.Errorf("RPC returned invalid block timestamp %q", block.Timestamp)
	}
	block.Hash = strings.ToLower(block.Hash)
	block.Time = time.Unix(int64(timestamp), 0).UTC()
	return &block, nil
}

func parseHexUint64(value string) (uint64, error) {
	if len(value) < 3 || !strings.HasPrefix(value, "0x") {
		return 0, fmt.Errorf("expected 0x-prefixed quantity")
	}
	return strconv.ParseUint(value[2:], 16, 64)
}

// IndexEvent persists either a decoded canonical projection or, only for the
// explicitly disabled test indexer, a raw test event.
func (bi *BlockchainIndexer) IndexEvent(ctx context.Context, event *models.BlockchainEvent) error {
	if event == nil {
		return fmt.Errorf("cannot index nil event")
	}
	if bi.rpcURL != "" {
		return fmt.Errorf("direct event projection is disabled; confirmed ranges are the only production write path")
	}
	bi.logger.Info("indexing blockchain event",
		zap.String("tx_hash", event.TxHash), zap.String("event_type", event.EventType), zap.Uint64("block_height", event.BlockHeight))
	if event.EventName != "" {
		if bi.projectionStore == nil {
			return fmt.Errorf("canonical event requires a payment projection store")
		}
		return bi.projectionStore.ApplyChainEvent(ctx, event)
	}
	return bi.eventStore.SaveEvent(ctx, event)
}

// VerifyAndIndexEvent verifies a webhook selector against a successful,
// canonical transaction receipt. With a real RPC configuration it is strictly
// notification-only: the confirmed range poller remains the sole production
// projection/checkpoint writer. The disabled test indexer retains its legacy
// in-memory behavior for isolated handler tests.
func (bi *BlockchainIndexer) VerifyAndIndexEvent(ctx context.Context, selector *models.BlockchainEvent) error {
	if bi.rpcURL == "" {
		return bi.IndexEvent(ctx, selector)
	}
	if err := bi.verifyNetworkIdentity(ctx); err != nil {
		bi.ready.Store(false)
		return fmt.Errorf("verify configured network identity before webhook: %w", err)
	}
	if selector == nil || !bytes32Hex.MatchString(selector.TxHash) ||
		!bytes32Hex.MatchString(selector.EventType) || !bytes32Hex.MatchString(selector.PaymentID) {
		return fmt.Errorf("webhook must contain a transaction hash, event topic, and payment id as 32-byte hex values")
	}
	eventTopic := strings.ToLower(selector.EventType)
	if _, supported := eventNamesByTopic[eventTopic]; !supported {
		return fmt.Errorf("webhook event topic is not a supported NoblePay payment event")
	}

	var receipt rpcReceipt
	if err := bi.rpcCall(ctx, "eth_getTransactionReceipt", []any{selector.TxHash}, &receipt); err != nil {
		return fmt.Errorf("verify webhook receipt: %w", err)
	}
	if receipt.Status != "0x1" || !strings.EqualFold(receipt.TransactionHash, selector.TxHash) ||
		!bytes32Hex.MatchString(receipt.BlockHash) {
		return fmt.Errorf("webhook transaction is missing, reverted, or mismatched")
	}
	height, err := parseHexUint64(receipt.BlockNumber)
	if err != nil {
		return fmt.Errorf("invalid webhook receipt block: %w", err)
	}
	if bi.confirmations > 0 {
		var latestHex string
		if err := bi.rpcCall(ctx, "eth_blockNumber", []any{}, &latestHex); err != nil {
			return fmt.Errorf("verify webhook confirmations: %w", err)
		}
		latest, err := parseHexUint64(latestHex)
		if err != nil || latest < bi.confirmations || height > latest-bi.confirmations {
			return fmt.Errorf("webhook receipt has fewer than %d confirmations", bi.confirmations)
		}
	}
	block, err := bi.blockByNumber(ctx, height)
	if err != nil {
		return fmt.Errorf("verify webhook block: %w", err)
	}
	if !strings.EqualFold(block.Hash, receipt.BlockHash) {
		return fmt.Errorf("webhook receipt block is not canonical")
	}

	matches := make([]*models.BlockchainEvent, 0, 1)
	for _, receiptLog := range receipt.Logs {
		if receiptLog.Removed || !strings.EqualFold(receiptLog.Address, bi.contract) || len(receiptLog.Topics) < 2 {
			continue
		}
		if strings.EqualFold(receiptLog.Topics[0], eventTopic) && strings.EqualFold(receiptLog.Topics[1], selector.PaymentID) {
			if !strings.EqualFold(receiptLog.BlockHash, receipt.BlockHash) ||
				!strings.EqualFold(receiptLog.TransactionHash, receipt.TransactionHash) {
				return fmt.Errorf("webhook receipt contains a mismatched log identity")
			}
			canonicalEvent, err := decodeCanonicalPaymentLog(receiptLog, block)
			if err != nil {
				return fmt.Errorf("decode verified webhook event: %w", err)
			}
			matches = append(matches, canonicalEvent)
		}
	}
	if len(matches) != 1 {
		return fmt.Errorf("webhook receipt does not contain exactly one matching NoblePay event")
	}
	if err := bi.verifyNetworkIdentity(ctx); err != nil {
		bi.ready.Store(false)
		return fmt.Errorf("revalidate configured network identity after webhook verification: %w", err)
	}
	canonicalBlock, err := bi.blockByNumber(ctx, height)
	if err != nil {
		return fmt.Errorf("revalidate webhook block: %w", err)
	}
	if !strings.EqualFold(canonicalBlock.Hash, receipt.BlockHash) {
		return fmt.Errorf("webhook receipt block changed during verification")
	}
	*selector = *matches[0]
	return nil
}

// WebhookNotificationOnly reports whether verified webhooks are deliberately
// excluded from the projection write path. Production callers can use this to
// return an honest accepted-for-indexing response without reconciling data that
// has not yet crossed the confirmed-range checkpoint.
func (bi *BlockchainIndexer) WebhookNotificationOnly() bool {
	return bi.rpcURL != ""
}

func decodeCanonicalPaymentLog(chainLog rpcLog, block *rpcBlock) (*models.BlockchainEvent, error) {
	if block == nil || !bytes32Hex.MatchString(block.Hash) || block.Time.IsZero() {
		return nil, fmt.Errorf("missing canonical block context")
	}
	height, err := parseHexUint64(chainLog.BlockNumber)
	if err != nil {
		return nil, fmt.Errorf("invalid block number: %w", err)
	}
	blockHeight, err := parseHexUint64(block.Number)
	if err != nil || height != blockHeight || !strings.EqualFold(chainLog.BlockHash, block.Hash) {
		return nil, fmt.Errorf("log does not belong to canonical block")
	}
	logIndex, err := parseHexUint64(chainLog.LogIndex)
	if err != nil {
		return nil, fmt.Errorf("invalid log index: %w", err)
	}
	if _, err := parseHexUint64(chainLog.TransactionIndex); err != nil {
		return nil, fmt.Errorf("invalid transaction index: %w", err)
	}
	if !bytes32Hex.MatchString(chainLog.TransactionHash) || len(chainLog.Topics) == 0 {
		return nil, fmt.Errorf("invalid transaction hash or missing event topic")
	}
	eventTopic := strings.ToLower(chainLog.Topics[0])
	eventName, supported := eventNamesByTopic[eventTopic]
	if !supported {
		return nil, fmt.Errorf("unsupported NoblePay payment topic %s", eventTopic)
	}
	if len(chainLog.Topics) < 2 || !bytes32Hex.MatchString(chainLog.Topics[1]) {
		return nil, fmt.Errorf("event has no canonical payment id")
	}
	data, err := decodeABIData(chainLog.Data)
	if err != nil {
		return nil, err
	}

	event := &models.BlockchainEvent{
		BlockHeight: height,
		BlockHash:   strings.ToLower(chainLog.BlockHash),
		LogIndex:    logIndex,
		TxHash:      strings.ToLower(chainLog.TransactionHash),
		EventType:   eventTopic,
		EventName:   eventName,
		PaymentID:   strings.ToLower(chainLog.Topics[1]),
		RawData:     strings.ToLower(chainLog.Data),
		Timestamp:   block.Time,
	}

	switch eventTopic {
	case PaymentInitiatedTopic:
		if len(chainLog.Topics) != 4 || len(data) != 96 {
			return nil, fmt.Errorf("PaymentInitiated must contain 4 topics and 3 data words")
		}
		sender, err := decodeTopicAddress(chainLog.Topics[2])
		if err != nil {
			return nil, fmt.Errorf("invalid PaymentInitiated sender: %w", err)
		}
		receiver, err := decodeTopicAddress(chainLog.Topics[3])
		if err != nil {
			return nil, fmt.Errorf("invalid PaymentInitiated recipient: %w", err)
		}
		token, err := decodeWordAddress(data[32:64])
		if err != nil {
			return nil, fmt.Errorf("invalid PaymentInitiated token: %w", err)
		}
		for _, paddingByte := range data[67:96] {
			if paddingByte != 0 {
				return nil, fmt.Errorf("PaymentInitiated currency has non-canonical ABI padding")
			}
		}
		currencyBytes := data[64:67]
		amount := new(big.Int).SetBytes(data[:32])
		if amount.Sign() == 0 {
			return nil, fmt.Errorf("PaymentInitiated amount is zero")
		}
		event.SenderAddress = sender
		event.ReceiverAddress = receiver
		event.Amount = amount.String()
		event.TokenAddress = token
		event.CurrencyCode = "0x" + hex.EncodeToString(currencyBytes)
		if isUpperASCIICurrency(currencyBytes) {
			event.Currency = string(currencyBytes)
		}
		event.ProjectedStatus = models.PaymentStatusPending
	case PaymentClearedTopic:
		if len(chainLog.Topics) != 2 || len(data) != 32 {
			return nil, fmt.Errorf("PaymentCleared must contain 2 topics and 1 data word")
		}
		riskScore, err := decodeUint8Word(data)
		if err != nil || riskScore > 100 {
			return nil, fmt.Errorf("invalid PaymentCleared risk score")
		}
		event.RiskScore = &riskScore
		event.ProjectedStatus = models.PaymentStatusPassed
	case PaymentFlaggedTopic:
		if len(chainLog.Topics) != 2 || len(data) != 64 {
			return nil, fmt.Errorf("PaymentFlagged must contain 2 topics and 2 data words")
		}
		riskScore, err := decodeUint8Word(data[:32])
		if err != nil || riskScore > 100 {
			return nil, fmt.Errorf("invalid PaymentFlagged risk score")
		}
		event.RiskScore = &riskScore
		event.InvestigationHash = "0x" + hex.EncodeToString(data[32:64])
		event.ProjectedStatus = models.PaymentStatusFlagged
	case PaymentBlockedTopic:
		if len(chainLog.Topics) != 2 || len(data) != 32 {
			return nil, fmt.Errorf("PaymentBlocked must contain 2 topics and 1 data word")
		}
		event.InvestigationHash = "0x" + hex.EncodeToString(data)
		event.ProjectedStatus = models.PaymentStatusBlocked
	case PaymentSettledTopic:
		if len(chainLog.Topics) != 2 || len(data) != 64 {
			return nil, fmt.Errorf("PaymentSettled must contain 2 topics and 2 data words")
		}
		if err := validateEventTimestamp(data[:32], block.Time); err != nil {
			return nil, fmt.Errorf("invalid PaymentSettled timestamp: %w", err)
		}
		event.FeeCollected = new(big.Int).SetBytes(data[32:64]).String()
		event.ProjectedStatus = models.PaymentStatusSettled
	case PaymentRefundedTopic:
		if len(chainLog.Topics) != 2 || len(data) != 32 {
			return nil, fmt.Errorf("PaymentRefunded must contain 2 topics and 1 data word")
		}
		if err := validateEventTimestamp(data, block.Time); err != nil {
			return nil, fmt.Errorf("invalid PaymentRefunded timestamp: %w", err)
		}
		event.ProjectedStatus = models.PaymentStatusRefunded
	}
	return event, nil
}

func decodeABIData(value string) ([]byte, error) {
	if !strings.HasPrefix(value, "0x") || len(value)%2 != 0 {
		return nil, fmt.Errorf("event data is not canonical hex")
	}
	decoded, err := hex.DecodeString(value[2:])
	if err != nil {
		return nil, fmt.Errorf("event data is not canonical hex: %w", err)
	}
	return decoded, nil
}

func decodeTopicAddress(topic string) (string, error) {
	if !bytes32Hex.MatchString(topic) {
		return "", fmt.Errorf("address topic is not bytes32")
	}
	decoded, _ := hex.DecodeString(topic[2:])
	return decodeWordAddress(decoded)
}

func decodeWordAddress(word []byte) (string, error) {
	if len(word) != 32 {
		return "", fmt.Errorf("address word has length %d", len(word))
	}
	for _, paddingByte := range word[:12] {
		if paddingByte != 0 {
			return "", fmt.Errorf("address word has nonzero padding")
		}
	}
	address := "0x" + hex.EncodeToString(word[12:])
	if address == "0x"+strings.Repeat("0", 40) {
		return "", fmt.Errorf("address is zero")
	}
	return address, nil
}

func isUpperASCIICurrency(currency []byte) bool {
	if len(currency) != 3 {
		return false
	}
	for _, character := range currency {
		if character < 'A' || character > 'Z' {
			return false
		}
	}
	return true
}

func decodeUint8Word(word []byte) (uint8, error) {
	if len(word) != 32 {
		return 0, fmt.Errorf("uint8 word has length %d", len(word))
	}
	for _, paddingByte := range word[:31] {
		if paddingByte != 0 {
			return 0, fmt.Errorf("uint8 word overflows")
		}
	}
	return word[31], nil
}

func validateEventTimestamp(word []byte, blockTime time.Time) error {
	value := new(big.Int).SetBytes(word)
	if !value.IsUint64() || value.Uint64() > math.MaxInt64 {
		return fmt.Errorf("timestamp overflows")
	}
	if value.Uint64() != uint64(blockTime.Unix()) {
		return fmt.Errorf("event timestamp does not equal canonical block timestamp")
	}
	return nil
}

// GetEvents retrieves all indexed events for a given payment.
func (bi *BlockchainIndexer) GetEvents(ctx context.Context, paymentID string) ([]*models.BlockchainEvent, error) {
	return bi.eventStore.GetEventsByPayment(ctx, paymentID)
}
