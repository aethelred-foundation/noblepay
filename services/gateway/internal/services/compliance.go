package services

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/aethelred/noblepay-gateway/internal/models"
	"go.uber.org/zap"
)

const maxComplianceResponseBytes = 1 << 20
const maxUint256Decimal = "115792089237316195423570985008687907853269984665640564039457584007913129639935"

var sha3Digest = regexp.MustCompile(`^[0-9a-fA-F]{64}$`)
var positiveDecimalInteger = regexp.MustCompile(`^[1-9][0-9]*$`)

// ComplianceProxy communicates with the independently audited external
// compliance API required by production.
type ComplianceProxy struct {
	baseURL       string
	apiKey        string
	timeout       time.Duration
	maxDatasetAge time.Duration
	httpClient    *http.Client
	logger        *zap.Logger
}

// NewComplianceProxy is retained for test callers. Production construction
// must use NewAuthenticatedComplianceProxy so the external API receives auth.
func NewComplianceProxy(baseURL string, logger *zap.Logger) *ComplianceProxy {
	return NewAuthenticatedComplianceProxy(baseURL, "", 5*time.Second, 24*time.Hour, logger)
}

// NewAuthenticatedComplianceProxy creates an authenticated, bounded client.
func NewAuthenticatedComplianceProxy(
	baseURL, apiKey string,
	timeout, maxDatasetAge time.Duration,
	logger *zap.Logger,
) *ComplianceProxy {
	return &ComplianceProxy{
		baseURL:       strings.TrimRight(baseURL, "/"),
		apiKey:        apiKey,
		timeout:       timeout,
		maxDatasetAge: maxDatasetAge,
		httpClient: &http.Client{
			Timeout: timeout,
		},
		logger: logger,
	}
}

type screeningRequest struct {
	Payment       screeningPayment `json:"payment"`
	TravelRule    any              `json:"travel_rule_data"`
	TimeoutMillis uint64           `json:"timeout_ms"`
}

type screeningPayment struct {
	ID          string            `json:"id"`
	Sender      string            `json:"sender"`
	Recipient   string            `json:"recipient"`
	Amount      string            `json:"amount"`
	Currency    string            `json:"currency"`
	PurposeHash *string           `json:"purpose_hash"`
	Metadata    map[string]string `json:"metadata"`
	Timestamp   time.Time         `json:"timestamp"`
}

type screeningResponse struct {
	Success   bool             `json:"success"`
	Result    *screeningResult `json:"result"`
	Error     *string          `json:"error"`
	RequestID string           `json:"request_id"`
}

type screeningResult struct {
	PaymentID           string `json:"payment_id"`
	SanctionsClear      bool   `json:"sanctions_clear"`
	AMLRiskScore        int    `json:"aml_risk_score"`
	TravelRuleCompliant bool   `json:"travel_rule_compliant"`
	Status              string `json:"status"`
}

// Check calls POST /v1/screen using the required compliance API schema. The
// optional currency keeps source compatibility for older test callers.
func (cp *ComplianceProxy) Check(ctx context.Context, sender, receiver, amount string, currency ...string) (*models.ComplianceResult, error) {
	if !validUint256Decimal(amount) {
		return nil, fmt.Errorf("amount must be a canonical positive uint256 decimal string in the currency's smallest unit")
	}
	currencyValue := "USD"
	if len(currency) > 0 && strings.TrimSpace(currency[0]) != "" {
		currencyValue = strings.ToUpper(strings.TrimSpace(currency[0]))
	}

	requestID, err := newUUID()
	if err != nil {
		return nil, fmt.Errorf("generate compliance request id: %w", err)
	}
	reqBody := screeningRequest{
		Payment: screeningPayment{
			ID: requestID, Sender: sender, Recipient: receiver, Amount: amount,
			Currency: currencyValue, Metadata: map[string]string{"source": "noblepay-gateway"},
			Timestamp: time.Now().UTC(),
		},
		TravelRule:    nil,
		TimeoutMillis: uint64(cp.timeout.Milliseconds()),
	}

	body, err := json.Marshal(reqBody)
	if err != nil {
		return nil, fmt.Errorf("marshal compliance request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, cp.baseURL+"/v1/screen", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("create compliance request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	if cp.apiKey != "" {
		req.Header.Set("X-API-Key", cp.apiKey)
	}

	resp, err := cp.httpClient.Do(req)
	if err != nil {
		cp.logger.Warn("external compliance API unreachable", zap.Error(err))
		return nil, fmt.Errorf("compliance request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		message, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return nil, fmt.Errorf("compliance check returned status %d: %s", resp.StatusCode, strings.TrimSpace(string(message)))
	}

	var response screeningResponse
	decoder := json.NewDecoder(io.LimitReader(resp.Body, maxComplianceResponseBytes))
	if err := decoder.Decode(&response); err != nil {
		return nil, fmt.Errorf("decode compliance response: %w", err)
	}
	if !response.Success || response.Result == nil {
		reason := "screening failed without an error"
		if response.Error != nil && *response.Error != "" {
			reason = *response.Error
		}
		return nil, fmt.Errorf("compliance screening rejected: %s", reason)
	}
	if !strings.EqualFold(response.RequestID, requestID) || !strings.EqualFold(response.Result.PaymentID, requestID) {
		return nil, fmt.Errorf("compliance response id does not match request")
	}
	if response.Result.AMLRiskScore < 0 || response.Result.AMLRiskScore > 100 {
		return nil, fmt.Errorf("compliance response contains invalid AML score")
	}

	approved := response.Result.Status == "Passed" && response.Result.SanctionsClear && response.Result.TravelRuleCompliant
	reason := ""
	if !approved {
		reason = fmt.Sprintf("status=%s sanctions_clear=%t travel_rule_compliant=%t",
			response.Result.Status, response.Result.SanctionsClear, response.Result.TravelRuleCompliant)
	}
	result := &models.ComplianceResult{Approved: approved, Reason: reason, Score: response.Result.AMLRiskScore}
	cp.logger.Info("compliance check completed", zap.Bool("approved", approved), zap.Int("score", result.Score))
	return result, nil
}

func validUint256Decimal(value string) bool {
	if !positiveDecimalInteger.MatchString(value) || len(value) > len(maxUint256Decimal) {
		return false
	}
	return len(value) < len(maxUint256Decimal) || value <= maxUint256Decimal
}

// Ready verifies that the external service is reachable and reports a complete,
// fresh, integrity-addressed sanctions snapshot for every required list.
func (cp *ComplianceProxy) Ready(ctx context.Context) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, cp.baseURL+"/v1/health", nil)
	if err != nil {
		return fmt.Errorf("create compliance health request: %w", err)
	}
	resp, err := cp.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("compliance health request failed: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("compliance health returned status %d", resp.StatusCode)
	}
	var health struct {
		Status         string `json:"status"`
		SanctionsLists *struct {
			TotalEntries       int               `json:"total_entries"`
			LastUpdated        map[string]string `json:"last_updated"`
			Source             string            `json:"source"`
			DatasetGeneratedAt string            `json:"dataset_generated_at"`
			DatasetDigest      string            `json:"dataset_digest"`
		} `json:"sanctions_lists"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&health); err != nil {
		return fmt.Errorf("decode compliance health response: %w", err)
	}
	if health.Status != "healthy" {
		return fmt.Errorf("compliance service is not healthy")
	}
	if health.SanctionsLists == nil || health.SanctionsLists.TotalEntries <= 0 {
		return fmt.Errorf("compliance service returned incomplete sanctions metadata")
	}
	metadata := health.SanctionsLists
	source := strings.ToLower(strings.TrimSpace(metadata.Source))
	if source == "" || strings.Contains(source, "mock") || strings.Contains(source, "test") || strings.Contains(source, "fixture") {
		return fmt.Errorf("compliance service returned a non-production sanctions source")
	}
	if !sha3Digest.MatchString(metadata.DatasetDigest) {
		return fmt.Errorf("compliance service returned an invalid sanctions dataset digest")
	}
	now := time.Now().UTC()
	if err := validateFreshTimestamp("dataset_generated_at", metadata.DatasetGeneratedAt, now, cp.maxDatasetAge); err != nil {
		return err
	}
	for _, list := range []string{"OFAC", "UAE Central Bank", "UN", "EU"} {
		updatedAt, ok := metadata.LastUpdated[list]
		if !ok {
			return fmt.Errorf("compliance service is missing %s sanctions freshness", list)
		}
		if err := validateFreshTimestamp(list, updatedAt, now, cp.maxDatasetAge); err != nil {
			return err
		}
	}
	return nil
}

func validateFreshTimestamp(label, raw string, now time.Time, maxAge time.Duration) error {
	parsed, err := time.Parse(time.RFC3339, raw)
	if err != nil {
		return fmt.Errorf("compliance service returned an invalid %s timestamp", label)
	}
	if parsed.After(now.Add(5 * time.Minute)) {
		return fmt.Errorf("compliance service returned a future %s timestamp", label)
	}
	if maxAge <= 0 || parsed.Before(now.Add(-maxAge)) {
		return fmt.Errorf("compliance service returned stale %s sanctions data", label)
	}
	return nil
}

func newUUID() (string, error) {
	bytes := make([]byte, 16)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}
	bytes[6] = (bytes[6] & 0x0f) | 0x40
	bytes[8] = (bytes[8] & 0x3f) | 0x80
	encoded := hex.EncodeToString(bytes)
	return encoded[0:8] + "-" + encoded[8:12] + "-" + encoded[12:16] + "-" + encoded[16:20] + "-" + encoded[20:32], nil
}
