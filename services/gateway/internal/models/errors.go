package models

import "errors"

var (
	ErrPaymentNotFound = errors.New("payment not found")
	ErrMissingSender   = errors.New("sender_address is required")
	ErrMissingReceiver = errors.New("receiver_address is required")
	ErrMissingAmount   = errors.New("amount is required")
	ErrMissingCurrency = errors.New("currency is required")
	ErrNotCancellable  = errors.New("payment cannot be cancelled in current state")
)
