package handlers

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"

	"github.com/aethelred/noblepay-gateway/internal/models"
	"github.com/aethelred/noblepay-gateway/internal/services"
)

// PaymentHandler handles payment CRUD HTTP endpoints.
type PaymentHandler struct {
	svc *services.PaymentService
}

// NewPaymentHandler creates a new PaymentHandler.
func NewPaymentHandler(svc *services.PaymentService) *PaymentHandler {
	return &PaymentHandler{svc: svc}
}

// Submit handles POST /api/v1/payments
func (ph *PaymentHandler) Submit(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	var req models.SubmitPaymentRequest
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&req); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": "request body too large"})
			return
		}
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "request body must contain one JSON object"})
		return
	}

	payment, err := ph.svc.Submit(r.Context(), &req)
	if err != nil {
		if errors.Is(err, models.ErrOffChainMutationDisabled) {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": err.Error()})
			return
		}
		if errors.Is(err, models.ErrMissingSender) || errors.Is(err, models.ErrMissingReceiver) ||
			errors.Is(err, models.ErrMissingAmount) || errors.Is(err, models.ErrMissingCurrency) {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		if errors.Is(err, models.ErrComplianceDenied) {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "payment rejected by compliance"})
			return
		}
		if errors.Is(err, models.ErrComplianceUnavailable) {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "compliance service unavailable"})
			return
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}

	writeJSON(w, http.StatusCreated, payment)
}

// GetByID handles GET /api/v1/payments/{id}
func (ph *PaymentHandler) GetByID(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if id == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "missing payment id"})
		return
	}

	payment, err := ph.svc.GetByID(r.Context(), id)
	if err != nil {
		if errors.Is(err, models.ErrPaymentNotFound) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "payment not found"})
			return
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}

	writeJSON(w, http.StatusOK, payment)
}

// List handles GET /api/v1/payments
func (ph *PaymentHandler) List(w http.ResponseWriter, r *http.Request) {
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	offset, _ := strconv.Atoi(r.URL.Query().Get("offset"))

	payments, err := ph.svc.List(r.Context(), limit, offset)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}

	writeJSON(w, http.StatusOK, payments)
}

// Cancel handles POST /api/v1/payments/{id}/cancel
func (ph *PaymentHandler) Cancel(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if id == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "missing payment id"})
		return
	}

	payment, err := ph.svc.Cancel(r.Context(), id)
	if err != nil {
		if errors.Is(err, models.ErrOffChainMutationDisabled) {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": err.Error()})
			return
		}
		if errors.Is(err, models.ErrPaymentNotFound) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "payment not found"})
			return
		}
		if errors.Is(err, models.ErrNotCancellable) {
			writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}

	writeJSON(w, http.StatusOK, payment)
}
