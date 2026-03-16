package services

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/aethelred/noblepay-gateway/internal/models"
	"go.uber.org/zap"
)

// ComplianceProxy communicates with the Rust TEE compliance service.
type ComplianceProxy struct {
	baseURL    string
	httpClient *http.Client
	logger     *zap.Logger
}

// NewComplianceProxy creates a new compliance proxy.
func NewComplianceProxy(baseURL string, logger *zap.Logger) *ComplianceProxy {
	return &ComplianceProxy{
		baseURL: baseURL,
		httpClient: &http.Client{
			Timeout: 5 * time.Second,
		},
		logger: logger,
	}
}

type complianceRequest struct {
	Sender   string `json:"sender"`
	Receiver string `json:"receiver"`
	Amount   string `json:"amount"`
}

// Check calls the TEE compliance endpoint to verify a transaction.
func (cp *ComplianceProxy) Check(ctx context.Context, sender, receiver, amount string) (*models.ComplianceResult, error) {
	reqBody := complianceRequest{
		Sender:   sender,
		Receiver: receiver,
		Amount:   amount,
	}

	body, err := json.Marshal(reqBody)
	if err != nil {
		return nil, fmt.Errorf("marshal compliance request: %w", err)
	}

	url := cp.baseURL + "/api/v1/compliance/check"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("create compliance request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := cp.httpClient.Do(req)
	if err != nil {
		cp.logger.Warn("compliance TEE unreachable", zap.Error(err))
		return nil, fmt.Errorf("compliance request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("compliance check returned status %d", resp.StatusCode)
	}

	var result models.ComplianceResult
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("decode compliance response: %w", err)
	}

	cp.logger.Info("compliance check completed",
		zap.Bool("approved", result.Approved),
		zap.Int("score", result.Score),
	)

	return &result, nil
}
