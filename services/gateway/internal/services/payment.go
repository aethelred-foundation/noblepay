package services

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"time"

	"github.com/aethelred/noblepay-gateway/internal/models"
	"github.com/aethelred/noblepay-gateway/internal/store"
	"go.uber.org/zap"
)

// PaymentService handles payment business logic.
type PaymentService struct {
	store      store.PaymentStore
	compliance *ComplianceProxy
	logger     *zap.Logger
}

// NewPaymentService creates a new PaymentService.
func NewPaymentService(s store.PaymentStore, c *ComplianceProxy, logger *zap.Logger) *PaymentService {
	return &PaymentService{
		store:      s,
		compliance: c,
		logger:     logger,
	}
}

// Submit creates a new payment after running compliance checks.
func (ps *PaymentService) Submit(ctx context.Context, req *models.SubmitPaymentRequest) (*models.Payment, error) {
	if err := req.Validate(); err != nil {
		return nil, err
	}

	// Run compliance check via TEE proxy.
	complianceResult, err := ps.compliance.Check(ctx, req.SenderAddress, req.ReceiverAddress, req.Amount)
	if err != nil {
		ps.logger.Warn("compliance check failed, proceeding with flag", zap.Error(err))
	}

	payment := &models.Payment{
		ID:              generateID(),
		SenderAddress:   req.SenderAddress,
		ReceiverAddress: req.ReceiverAddress,
		Amount:          req.Amount,
		Currency:        req.Currency,
		Memo:            req.Memo,
		Status:          models.PaymentStatusPending,
		ComplianceCheck: complianceResult != nil && complianceResult.Approved,
		CreatedAt:       time.Now().UTC(),
		UpdatedAt:       time.Now().UTC(),
	}

	if err := ps.store.Create(ctx, payment); err != nil {
		return nil, err
	}

	ps.logger.Info("payment submitted",
		zap.String("id", payment.ID),
		zap.String("amount", payment.Amount),
		zap.String("currency", payment.Currency),
	)

	return payment, nil
}

// GetByID retrieves a payment by ID.
func (ps *PaymentService) GetByID(ctx context.Context, id string) (*models.Payment, error) {
	return ps.store.GetByID(ctx, id)
}

// List returns a paginated list of payments.
func (ps *PaymentService) List(ctx context.Context, limit, offset int) ([]*models.Payment, error) {
	if limit <= 0 {
		limit = 20
	}
	if limit > 100 {
		limit = 100
	}
	if offset < 0 {
		offset = 0
	}
	return ps.store.List(ctx, limit, offset)
}

// Cancel transitions a payment to cancelled if it is still pending.
func (ps *PaymentService) Cancel(ctx context.Context, id string) (*models.Payment, error) {
	payment, err := ps.store.GetByID(ctx, id)
	if err != nil {
		return nil, err
	}

	if payment.Status != models.PaymentStatusPending {
		return nil, models.ErrNotCancellable
	}

	payment.Status = models.PaymentStatusCancelled
	payment.UpdatedAt = time.Now().UTC()

	if err := ps.store.Update(ctx, payment); err != nil {
		return nil, err
	}

	ps.logger.Info("payment cancelled", zap.String("id", id))
	return payment, nil
}

func generateID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
