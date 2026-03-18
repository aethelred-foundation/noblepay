package handlers

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/aethelred/noblepay-gateway/internal/models"
	"github.com/aethelred/noblepay-gateway/internal/services"
	"go.uber.org/zap"
)

const (
	// webhookTimestampTolerance is the maximum age of a webhook before it is rejected.
	webhookTimestampTolerance = 5 * time.Minute
	// maxProcessedWebhookIDs is the maximum number of webhook IDs kept for replay protection.
	maxProcessedWebhookIDs = 10000
)

// WebhookHandler processes incoming blockchain event webhooks.
type WebhookHandler struct {
	indexer       *services.BlockchainIndexer
	settlement    *services.SettlementService
	logger        *zap.Logger
	webhookSecret string

	mu           sync.Mutex
	processedIDs map[string]time.Time
}

// NewWebhookHandler creates a new WebhookHandler.
func NewWebhookHandler(indexer *services.BlockchainIndexer, settlement *services.SettlementService, logger *zap.Logger, webhookSecret string) *WebhookHandler {
	return &WebhookHandler{
		indexer:       indexer,
		settlement:    settlement,
		logger:        logger,
		webhookSecret: webhookSecret,
		processedIDs:  make(map[string]time.Time),
	}
}

// verifySignature checks the HMAC-SHA256 signature of the request body.
func (wh *WebhookHandler) verifySignature(body []byte, signature string) bool {
	mac := hmac.New(sha256.New, []byte(wh.webhookSecret))
	mac.Write(body)
	expected := hex.EncodeToString(mac.Sum(nil))
	return hmac.Equal([]byte(expected), []byte(signature))
}

// verifyTimestamp checks that the webhook timestamp is within the tolerance window.
func verifyTimestamp(tsHeader string) error {
	ts, err := strconv.ParseInt(tsHeader, 10, 64)
	if err != nil {
		return fmt.Errorf("invalid timestamp format")
	}

	// Reject timestamps that are clearly unreasonable (before year 2000 or after year 2100)
	// to avoid overflow issues with duration arithmetic on extreme values.
	const (
		minReasonableTS int64 = 946684800  // 2000-01-01 00:00:00 UTC
		maxReasonableTS int64 = 4102444800 // 2100-01-01 00:00:00 UTC
	)
	if ts < minReasonableTS || ts > maxReasonableTS {
		return fmt.Errorf("timestamp outside tolerance window")
	}

	webhookTime := time.Unix(ts, 0)
	diff := time.Since(webhookTime)
	if diff < 0 {
		diff = -diff
	}
	if diff > webhookTimestampTolerance {
		return fmt.Errorf("timestamp outside tolerance window")
	}
	return nil
}

// isDuplicate checks if the webhook ID has already been processed (replay protection).
func (wh *WebhookHandler) isDuplicate(webhookID string) bool {
	wh.mu.Lock()
	defer wh.mu.Unlock()

	if _, exists := wh.processedIDs[webhookID]; exists {
		return true
	}

	// Evict old entries if map is too large.
	if len(wh.processedIDs) >= maxProcessedWebhookIDs {
		cutoff := time.Now().Add(-webhookTimestampTolerance * 2)
		for id, t := range wh.processedIDs {
			if t.Before(cutoff) {
				delete(wh.processedIDs, id)
			}
		}
	}

	wh.processedIDs[webhookID] = time.Now()
	return false
}

// HandleEvent handles POST /api/v1/webhooks/events
func (wh *WebhookHandler) HandleEvent(w http.ResponseWriter, r *http.Request) {
	// Read raw body for signature verification.
	body, err := io.ReadAll(r.Body)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "failed to read request body"})
		return
	}

	// Verify HMAC signature.
	signature := r.Header.Get("X-Webhook-Signature")
	if signature == "" {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "missing webhook signature"})
		return
	}
	if !wh.verifySignature(body, signature) {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid webhook signature"})
		return
	}

	// Verify timestamp.
	tsHeader := r.Header.Get("X-Webhook-Timestamp")
	if tsHeader == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "missing webhook timestamp"})
		return
	}
	if err := verifyTimestamp(tsHeader); err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "webhook timestamp expired"})
		return
	}

	// Decode the event.
	var evt models.WebhookEvent
	if err := json.Unmarshal(body, &evt); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid event payload"})
		return
	}

	if evt.TxHash == "" || evt.Type == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "tx_hash and type are required"})
		return
	}

	// Check for webhook ID and replay protection.
	if evt.WebhookID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "webhook_id is required"})
		return
	}
	if wh.isDuplicate(evt.WebhookID) {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "duplicate webhook event"})
		return
	}

	// Convert webhook event to blockchain event and index it.
	blockEvent := &models.BlockchainEvent{
		TxHash:    evt.TxHash,
		EventType: evt.Type,
		PaymentID: evt.PaymentID,
		Timestamp: time.Now().UTC(),
	}

	if err := wh.indexer.IndexEvent(r.Context(), blockEvent); err != nil {
		wh.logger.Error("failed to index webhook event", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to process event"})
		return
	}

	// Trigger settlement reconciliation if there is a payment ID.
	if evt.PaymentID != "" {
		if _, err := wh.settlement.Reconcile(r.Context(), evt.PaymentID); err != nil {
			wh.logger.Warn("settlement reconciliation failed", zap.Error(err), zap.String("payment_id", evt.PaymentID))
		}
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "accepted"})
}
