package tests

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"go.uber.org/zap"

	"github.com/aethelred/noblepay-gateway/internal/handlers"
	"github.com/aethelred/noblepay-gateway/internal/services"
	"github.com/aethelred/noblepay-gateway/internal/store"
	"github.com/aethelred/noblepay-gateway/pkg/crypto"
)

// --- NP-04: API key auth always enforced ---

func TestAPIKeyAuthAlwaysRequired(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	// Even with empty key config, auth is enforced (uses fallback test-api-key).
	authed := handlers.APIKeyAuth("")(handler)

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rr := httptest.NewRecorder()
	authed.ServeHTTP(rr, req)

	if rr.Code != http.StatusUnauthorized {
		t.Errorf("expected 401 when no API key provided (empty config), got %d", rr.Code)
	}
}

func TestAPIKeyAuthRejectsWrongKey(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	authed := handlers.APIKeyAuth("correct-key")(handler)

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("X-API-Key", "wrong-key")
	rr := httptest.NewRecorder()
	authed.ServeHTTP(rr, req)

	if rr.Code != http.StatusUnauthorized {
		t.Errorf("expected 401 with wrong API key, got %d", rr.Code)
	}
}

func TestAPIKeyAuthAcceptsCorrectKey(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	authed := handlers.APIKeyAuth("my-secret")(handler)

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("X-API-Key", "my-secret")
	rr := httptest.NewRecorder()
	authed.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Errorf("expected 200 with correct API key, got %d", rr.Code)
	}
}

// --- NP-07: Webhook signature verification ---

func newWebhookHandler(t *testing.T) *handlers.WebhookHandler {
	t.Helper()
	logger := zap.NewNop()
	memStore := store.NewMemoryStore()
	indexer := services.NewBlockchainIndexer(memStore, logger)
	settlement := services.NewSettlementService(memStore, memStore, logger)
	return handlers.NewWebhookHandler(indexer, settlement, logger, testWebhookSecret)
}

func TestWebhookValidSignaturePasses(t *testing.T) {
	wh := newWebhookHandler(t)

	body := []byte(`{"webhook_id":"wh-valid-1","tx_hash":"0xabc","type":"transfer","payment_id":""}`)
	req := signedWebhookRequest(t, "/api/v1/webhooks/events", body)
	rr := httptest.NewRecorder()
	wh.HandleEvent(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200 for valid signed webhook, got %d: %s", rr.Code, rr.Body.String())
	}
}

func TestWebhookMissingSignatureRejected(t *testing.T) {
	wh := newWebhookHandler(t)

	body := []byte(`{"webhook_id":"wh-nosig","tx_hash":"0xabc","type":"transfer"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/webhooks/events", bytes.NewReader(body))
	req.Header.Set("X-Webhook-Timestamp", fmt.Sprintf("%d", time.Now().Unix()))
	rr := httptest.NewRecorder()
	wh.HandleEvent(rr, req)

	if rr.Code != http.StatusUnauthorized {
		t.Errorf("expected 401 for missing signature, got %d", rr.Code)
	}
}

func TestWebhookWrongHMACRejected(t *testing.T) {
	wh := newWebhookHandler(t)

	body := []byte(`{"webhook_id":"wh-badsig","tx_hash":"0xabc","type":"transfer"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/webhooks/events", bytes.NewReader(body))
	req.Header.Set("X-Webhook-Signature", "deadbeef0000000000000000000000000000000000000000000000000000dead")
	req.Header.Set("X-Webhook-Timestamp", fmt.Sprintf("%d", time.Now().Unix()))
	rr := httptest.NewRecorder()
	wh.HandleEvent(rr, req)

	if rr.Code != http.StatusUnauthorized {
		t.Errorf("expected 401 for wrong HMAC, got %d", rr.Code)
	}

	var resp map[string]string
	json.NewDecoder(rr.Body).Decode(&resp)
	if resp["error"] != "invalid webhook signature" {
		t.Errorf("expected 'invalid webhook signature' error, got %q", resp["error"])
	}
}

func TestWebhookExpiredTimestampRejected(t *testing.T) {
	wh := newWebhookHandler(t)

	body := []byte(`{"webhook_id":"wh-expired","tx_hash":"0xabc","type":"transfer"}`)
	// Use a timestamp 10 minutes in the past (exceeds 5-minute tolerance).
	oldTimestamp := fmt.Sprintf("%d", time.Now().Add(-10*time.Minute).Unix())
	sig := crypto.HMACSHA256Hex([]byte(testWebhookSecret), body)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/webhooks/events", bytes.NewReader(body))
	req.Header.Set("X-Webhook-Signature", sig)
	req.Header.Set("X-Webhook-Timestamp", oldTimestamp)
	rr := httptest.NewRecorder()
	wh.HandleEvent(rr, req)

	if rr.Code != http.StatusUnauthorized {
		t.Errorf("expected 401 for expired timestamp, got %d", rr.Code)
	}

	var resp map[string]string
	json.NewDecoder(rr.Body).Decode(&resp)
	if resp["error"] != "webhook timestamp expired" {
		t.Errorf("expected 'webhook timestamp expired' error, got %q", resp["error"])
	}
}

func TestWebhookMissingTimestampRejected(t *testing.T) {
	wh := newWebhookHandler(t)

	body := []byte(`{"webhook_id":"wh-nots","tx_hash":"0xabc","type":"transfer"}`)
	sig := crypto.HMACSHA256Hex([]byte(testWebhookSecret), body)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/webhooks/events", bytes.NewReader(body))
	req.Header.Set("X-Webhook-Signature", sig)
	// No timestamp header
	rr := httptest.NewRecorder()
	wh.HandleEvent(rr, req)

	if rr.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for missing timestamp, got %d", rr.Code)
	}
}

func TestWebhookDuplicateIDRejected(t *testing.T) {
	wh := newWebhookHandler(t)

	body := []byte(`{"webhook_id":"wh-duplicate-1","tx_hash":"0xabc","type":"transfer","payment_id":""}`)

	// First request should succeed.
	req1 := signedWebhookRequest(t, "/api/v1/webhooks/events", body)
	rr1 := httptest.NewRecorder()
	wh.HandleEvent(rr1, req1)

	if rr1.Code != http.StatusOK {
		t.Fatalf("first webhook expected 200, got %d", rr1.Code)
	}

	// Second request with same webhook_id should be rejected (replay).
	req2 := signedWebhookRequest(t, "/api/v1/webhooks/events", body)
	rr2 := httptest.NewRecorder()
	wh.HandleEvent(rr2, req2)

	if rr2.Code != http.StatusConflict {
		t.Errorf("expected 409 for duplicate webhook ID, got %d", rr2.Code)
	}

	var resp map[string]string
	json.NewDecoder(rr2.Body).Decode(&resp)
	if resp["error"] != "duplicate webhook event" {
		t.Errorf("expected 'duplicate webhook event' error, got %q", resp["error"])
	}
}

func TestWebhookMissingWebhookIDRejected(t *testing.T) {
	wh := newWebhookHandler(t)

	// Valid signature/timestamp but no webhook_id field.
	body := []byte(`{"tx_hash":"0xabc","type":"transfer","payment_id":""}`)
	req := signedWebhookRequest(t, "/api/v1/webhooks/events", body)
	rr := httptest.NewRecorder()
	wh.HandleEvent(rr, req)

	if rr.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for missing webhook_id, got %d", rr.Code)
	}
}

