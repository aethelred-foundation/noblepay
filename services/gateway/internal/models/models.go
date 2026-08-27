package models

import (
	"time"
)

// PaymentStatus represents the lifecycle state of a payment.
type PaymentStatus string

const (
	PaymentStatusPending  PaymentStatus = "pending"
	PaymentStatusPassed   PaymentStatus = "passed"
	PaymentStatusFlagged  PaymentStatus = "flagged"
	PaymentStatusBlocked  PaymentStatus = "blocked"
	PaymentStatusSettled  PaymentStatus = "settled"
	PaymentStatusRefunded PaymentStatus = "refunded"

	// The following values belong to the isolated legacy, off-chain mutation
	// service. Production routes never create these states; the on-chain
	// projection above is the source of truth exposed by the gateway.
	PaymentStatusProcessing PaymentStatus = "processing"
	PaymentStatusCompleted  PaymentStatus = "completed"
	PaymentStatusFailed     PaymentStatus = "failed"
	PaymentStatusCancelled  PaymentStatus = "cancelled"
)

// Payment represents a cross-border payment transaction.
type Payment struct {
	ID               string        `json:"id"`
	SenderAddress    string        `json:"sender_address"`
	ReceiverAddress  string        `json:"receiver_address"`
	Amount           string        `json:"amount"`
	Currency         string        `json:"currency"`
	CurrencyCode     string        `json:"currency_code,omitempty"`
	TokenAddress     string        `json:"token_address,omitempty"`
	Status           PaymentStatus `json:"status"`
	TxHash           string        `json:"tx_hash,omitempty"`
	InitiationTxHash string        `json:"initiation_tx_hash,omitempty"`
	SettlementTxHash string        `json:"settlement_tx_hash,omitempty"`
	RefundTxHash     string        `json:"refund_tx_hash,omitempty"`
	FeeCollected     string        `json:"fee_collected,omitempty"`
	InitiationBlock  uint64        `json:"initiation_block,omitempty"`
	LastEventBlock   uint64        `json:"last_event_block,omitempty"`
	Memo             string        `json:"memo,omitempty"`
	ComplianceCheck  bool          `json:"compliance_check"`
	CreatedAt        time.Time     `json:"created_at"`
	UpdatedAt        time.Time     `json:"updated_at"`
}

// SubmitPaymentRequest is the request body for creating a payment.
type SubmitPaymentRequest struct {
	SenderAddress   string `json:"sender_address"`
	ReceiverAddress string `json:"receiver_address"`
	Amount          string `json:"amount"`
	Currency        string `json:"currency"`
	Memo            string `json:"memo,omitempty"`
}

// Validate checks that required fields are present.
func (r *SubmitPaymentRequest) Validate() error {
	if r.SenderAddress == "" {
		return ErrMissingSender
	}
	if r.ReceiverAddress == "" {
		return ErrMissingReceiver
	}
	if r.Amount == "" {
		return ErrMissingAmount
	}
	if r.Currency == "" {
		return ErrMissingCurrency
	}
	return nil
}

// WebhookEvent represents a blockchain event delivered via webhook.
type WebhookEvent struct {
	ID        string    `json:"id"`
	WebhookID string    `json:"webhook_id"`
	Type      string    `json:"type"`
	PaymentID string    `json:"payment_id"`
	TxHash    string    `json:"tx_hash"`
	Data      string    `json:"data,omitempty"`
	Timestamp time.Time `json:"timestamp"`
}

// ComplianceResult holds the result from the TEE compliance check.
type ComplianceResult struct {
	Approved bool   `json:"approved"`
	Reason   string `json:"reason,omitempty"`
	Score    int    `json:"score"`
}

// BlockchainEvent represents an on-chain event captured by the indexer.
type BlockchainEvent struct {
	BlockHeight       uint64        `json:"block_height"`
	BlockHash         string        `json:"block_hash,omitempty"`
	LogIndex          uint64        `json:"log_index"`
	TxHash            string        `json:"tx_hash"`
	EventType         string        `json:"event_type"`
	EventName         string        `json:"event_name,omitempty"`
	PaymentID         string        `json:"payment_id,omitempty"`
	RawData           string        `json:"raw_data,omitempty"`
	Timestamp         time.Time     `json:"timestamp"`
	ProjectedStatus   PaymentStatus `json:"projected_status,omitempty"`
	SenderAddress     string        `json:"sender_address,omitempty"`
	ReceiverAddress   string        `json:"receiver_address,omitempty"`
	Amount            string        `json:"amount,omitempty"`
	TokenAddress      string        `json:"token_address,omitempty"`
	Currency          string        `json:"currency,omitempty"`
	CurrencyCode      string        `json:"currency_code,omitempty"`
	FeeCollected      string        `json:"fee_collected,omitempty"`
	RiskScore         *uint8        `json:"risk_score,omitempty"`
	InvestigationHash string        `json:"investigation_hash,omitempty"`
}

// SettlementRecord tracks reconciliation of payments.
type SettlementRecord struct {
	PaymentID   string    `json:"payment_id"`
	Settled     bool      `json:"settled"`
	SettledAt   time.Time `json:"settled_at,omitempty"`
	OnChainTx   string    `json:"on_chain_tx,omitempty"`
	Discrepancy string    `json:"discrepancy,omitempty"`
}

// HealthResponse is returned by health/readiness endpoints.
type HealthResponse struct {
	Status  string `json:"status"`
	Version string `json:"version,omitempty"`
}
