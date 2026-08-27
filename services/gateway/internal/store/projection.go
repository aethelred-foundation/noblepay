package store

import (
	"fmt"
	"math"
	"math/big"
	"regexp"
	"strings"

	"github.com/aethelred/noblepay-gateway/internal/models"
)

var canonicalBlockHash = regexp.MustCompile(`^0x[0-9a-fA-F]{64}$`)

const (
	eventPaymentInitiated = "PaymentInitiated"
	eventPaymentCleared   = "PaymentCleared"
	eventPaymentFlagged   = "PaymentFlagged"
	eventPaymentBlocked   = "PaymentBlocked"
	eventPaymentSettled   = "PaymentSettled"
	eventPaymentRefunded  = "PaymentRefunded"
)

// projectPayment deterministically derives the read model for one canonical
// event. The caller is responsible for checking log-identity idempotency and
// persisting the event and returned payment in one store transaction.
func projectPayment(existing *models.Payment, event *models.BlockchainEvent) (*models.Payment, bool, error) {
	if event == nil {
		return nil, false, fmt.Errorf("chain projection: nil event")
	}
	if event.PaymentID == "" || event.TxHash == "" || event.BlockHash == "" || event.Timestamp.IsZero() {
		return nil, false, fmt.Errorf("chain projection: incomplete canonical event")
	}

	if event.EventName == eventPaymentInitiated {
		if event.ProjectedStatus != models.PaymentStatusPending ||
			event.SenderAddress == "" || event.ReceiverAddress == "" ||
			event.Amount == "" || event.TokenAddress == "" || event.CurrencyCode == "" {
			return nil, false, fmt.Errorf("chain projection: malformed PaymentInitiated event")
		}
		if existing != nil {
			return nil, false, fmt.Errorf("chain projection: payment %s was initiated more than once", event.PaymentID)
		}
		return &models.Payment{
			ID:               event.PaymentID,
			SenderAddress:    event.SenderAddress,
			ReceiverAddress:  event.ReceiverAddress,
			Amount:           event.Amount,
			Currency:         event.Currency,
			CurrencyCode:     event.CurrencyCode,
			TokenAddress:     event.TokenAddress,
			Status:           models.PaymentStatusPending,
			TxHash:           event.TxHash,
			InitiationTxHash: event.TxHash,
			InitiationBlock:  event.BlockHeight,
			LastEventBlock:   event.BlockHeight,
			CreatedAt:        event.Timestamp,
			UpdatedAt:        event.Timestamp,
		}, true, nil
	}

	if existing == nil {
		return nil, false, fmt.Errorf("chain projection: %s references unknown payment %s", event.EventName, event.PaymentID)
	}
	if event.ProjectedStatus == "" {
		return nil, false, fmt.Errorf("chain projection: %s has no projected status", event.EventName)
	}
	if err := validateTransition(existing.Status, event.ProjectedStatus, event.EventName); err != nil {
		return nil, false, err
	}

	projected := clonePayment(existing)
	projected.Status = event.ProjectedStatus
	projected.TxHash = event.TxHash
	projected.LastEventBlock = event.BlockHeight
	projected.UpdatedAt = event.Timestamp
	switch event.EventName {
	case eventPaymentCleared, eventPaymentFlagged, eventPaymentBlocked:
		projected.ComplianceCheck = true
	case eventPaymentSettled:
		amount, amountOK := new(big.Int).SetString(existing.Amount, 10)
		fee, feeOK := new(big.Int).SetString(event.FeeCollected, 10)
		if !amountOK || !feeOK || amount.Sign() <= 0 || fee.Sign() < 0 || fee.Cmp(amount) >= 0 {
			return nil, false, fmt.Errorf("chain projection: invalid settlement fee %q for amount %q", event.FeeCollected, existing.Amount)
		}
		projected.ComplianceCheck = true
		projected.SettlementTxHash = event.TxHash
		projected.FeeCollected = event.FeeCollected
	case eventPaymentRefunded:
		projected.RefundTxHash = event.TxHash
	default:
		return nil, false, fmt.Errorf("chain projection: unsupported event %q", event.EventName)
	}
	return projected, false, nil
}

func validateTransition(from, to models.PaymentStatus, eventName string) error {
	valid := false
	switch from {
	case models.PaymentStatusPending:
		valid = to == models.PaymentStatusPassed || to == models.PaymentStatusFlagged ||
			to == models.PaymentStatusBlocked || to == models.PaymentStatusRefunded
	case models.PaymentStatusPassed:
		valid = to == models.PaymentStatusSettled || to == models.PaymentStatusRefunded
	case models.PaymentStatusFlagged, models.PaymentStatusBlocked:
		valid = to == models.PaymentStatusRefunded
	}
	if !valid {
		return fmt.Errorf("chain projection: impossible transition %s -> %s from %s", from, to, eventName)
	}

	expected := map[string]models.PaymentStatus{
		eventPaymentCleared:  models.PaymentStatusPassed,
		eventPaymentFlagged:  models.PaymentStatusFlagged,
		eventPaymentBlocked:  models.PaymentStatusBlocked,
		eventPaymentSettled:  models.PaymentStatusSettled,
		eventPaymentRefunded: models.PaymentStatusRefunded,
	}[eventName]
	if expected == "" || expected != to {
		return fmt.Errorf("chain projection: event %s cannot project status %s", eventName, to)
	}
	return nil
}

func sameCanonicalLog(left, right *models.BlockchainEvent) bool {
	return left != nil && right != nil &&
		strings.EqualFold(left.BlockHash, right.BlockHash) &&
		left.LogIndex == right.LogIndex &&
		strings.EqualFold(left.TxHash, right.TxHash)
}

func equivalentCanonicalEvent(left, right *models.BlockchainEvent) bool {
	if !sameCanonicalLog(left, right) {
		return false
	}
	return left.BlockHeight == right.BlockHeight &&
		strings.EqualFold(left.EventType, right.EventType) &&
		left.EventName == right.EventName &&
		strings.EqualFold(left.PaymentID, right.PaymentID) &&
		strings.EqualFold(left.RawData, right.RawData) &&
		left.Timestamp.Equal(right.Timestamp) &&
		left.ProjectedStatus == right.ProjectedStatus &&
		strings.EqualFold(left.SenderAddress, right.SenderAddress) &&
		strings.EqualFold(left.ReceiverAddress, right.ReceiverAddress) &&
		left.Amount == right.Amount &&
		strings.EqualFold(left.TokenAddress, right.TokenAddress) &&
		left.Currency == right.Currency && left.CurrencyCode == right.CurrencyCode &&
		left.FeeCollected == right.FeeCollected &&
		equalRiskScore(left.RiskScore, right.RiskScore) &&
		strings.EqualFold(left.InvestigationHash, right.InvestigationHash)
}

func equalRiskScore(left, right *uint8) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}

// projectConfirmedChainRange validates and applies a complete confirmed range
// to caller-owned clones. Callers commit those clones only after this function
// succeeds, which makes a malformed later log incapable of leaking an earlier
// projection into live state.
func projectConfirmedChainRange(
	payments map[string]*models.Payment,
	order *[]string,
	events map[string][]*models.BlockchainEvent,
	existingCheckpoint *IndexerCheckpoint,
	confirmedRange ConfirmedChainRange,
) error {
	checkpoint := confirmedRange.Checkpoint
	if checkpoint.Height == math.MaxUint64 {
		return fmt.Errorf("chain projection range: checkpoint height cannot advance")
	}
	if !canonicalBlockHash.MatchString(checkpoint.BlockHash) {
		return fmt.Errorf("chain projection range: invalid checkpoint block hash")
	}
	if confirmedRange.FromHeight > checkpoint.Height {
		return fmt.Errorf("chain projection range: start height exceeds checkpoint")
	}
	if existingCheckpoint != nil {
		if !canonicalBlockHash.MatchString(existingCheckpoint.BlockHash) {
			return fmt.Errorf("chain projection range: existing checkpoint hash is invalid")
		}
		if existingCheckpoint.Height == math.MaxUint64 || confirmedRange.FromHeight != existingCheckpoint.Height+1 {
			return fmt.Errorf("chain projection range: non-contiguous checkpoint advance")
		}
	}

	var previous *models.BlockchainEvent
	for _, event := range confirmedRange.Events {
		if event == nil {
			return fmt.Errorf("chain projection range: nil event")
		}
		if event.BlockHeight < confirmedRange.FromHeight || event.BlockHeight > checkpoint.Height {
			return fmt.Errorf("chain projection range: event block %d is outside the confirmed range", event.BlockHeight)
		}
		if !canonicalBlockHash.MatchString(event.BlockHash) {
			return fmt.Errorf("chain projection range: event has invalid block hash")
		}
		if previous != nil && (event.BlockHeight < previous.BlockHeight ||
			(event.BlockHeight == previous.BlockHeight && event.LogIndex <= previous.LogIndex)) {
			return fmt.Errorf("chain projection range: events are not in strict canonical log order")
		}

		for _, paymentEvents := range events {
			for _, existingEvent := range paymentEvents {
				if sameCanonicalLog(existingEvent, event) {
					if equivalentCanonicalEvent(existingEvent, event) {
						return fmt.Errorf("chain projection range: event replays an already checkpointed log")
					}
					return fmt.Errorf("chain projection range: canonical log identity collision")
				}
			}
		}

		projected, created, err := projectPayment(payments[event.PaymentID], event)
		if err != nil {
			return err
		}
		payments[event.PaymentID] = clonePayment(projected)
		if created {
			*order = append(*order, event.PaymentID)
		}
		events[event.PaymentID] = append(events[event.PaymentID], cloneEvent(event))
		previous = event
	}
	return nil
}
