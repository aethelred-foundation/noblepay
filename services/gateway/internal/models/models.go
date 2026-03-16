package models

import (
	"time"
)

// PaymentStatus represents the lifecycle state of a payment.
type PaymentStatus string

const (
	PaymentStatusPending    PaymentStatus = "pending"
	PaymentStatusProcessing PaymentStatus = "processing"
	PaymentStatusCompleted  PaymentStatus = "completed"
	PaymentStatusFailed     PaymentStatus = "failed"
	PaymentStatusCancelled  PaymentStatus = "cancelled"
)

// Payment represents a cross-border payment transaction.
type Payment struct {
	ID              string        `json:"id"`
	SenderAddress   string        `json:"sender_address"`
	ReceiverAddress string        `json:"receiver_address"`
	Amount          string        `json:"amount"`
	Currency        string        `json:"currency"`
	Status          PaymentStatus `json:"status"`
	TxHash          string        `json:"tx_hash,omitempty"`
	Memo            string        `json:"memo,omitempty"`
	ComplianceCheck bool          `json:"compliance_check"`
	CreatedAt       time.Time     `json:"created_at"`
	UpdatedAt       time.Time     `json:"updated_at"`
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
	BlockHeight uint64    `json:"block_height"`
	TxHash      string    `json:"tx_hash"`
	EventType   string    `json:"event_type"`
	PaymentID   string    `json:"payment_id,omitempty"`
	Timestamp   time.Time `json:"timestamp"`
}

// SettlementRecord tracks reconciliation of payments.
type SettlementRecord struct {
	PaymentID  string    `json:"payment_id"`
	Settled    bool      `json:"settled"`
	SettledAt  time.Time `json:"settled_at,omitempty"`
	OnChainTx  string    `json:"on_chain_tx,omitempty"`
	Discrepancy string   `json:"discrepancy,omitempty"`
}

// HealthResponse is returned by health/readiness endpoints.
type HealthResponse struct {
	Status  string `json:"status"`
	Version string `json:"version,omitempty"`
}
