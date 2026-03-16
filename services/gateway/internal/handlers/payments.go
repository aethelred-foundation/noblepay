package handlers

import (
	"encoding/json"
	"errors"
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
	var req models.SubmitPaymentRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}

	payment, err := ph.svc.Submit(r.Context(), &req)
	if err != nil {
		if errors.Is(err, models.ErrMissingSender) || errors.Is(err, models.ErrMissingReceiver) ||
			errors.Is(err, models.ErrMissingAmount) || errors.Is(err, models.ErrMissingCurrency) {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
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
