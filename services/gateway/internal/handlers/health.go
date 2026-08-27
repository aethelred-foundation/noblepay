package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/aethelred/noblepay-gateway/internal/models"
)

const version = "0.1.0"

// HealthHandler handles health and dependency-aware readiness checks.
type HealthHandler struct {
	ready func() error
}

// NewHealthHandler creates a new HealthHandler.
func NewHealthHandler() *HealthHandler {
	return &HealthHandler{ready: func() error { return nil }}
}

// NewReadinessHealthHandler creates a handler backed by live dependency checks.
func NewReadinessHealthHandler(ready func() error) *HealthHandler {
	return &HealthHandler{ready: ready}
}

// Liveness returns 200 if the service is alive.
func (h *HealthHandler) Liveness(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, models.HealthResponse{
		Status:  "ok",
		Version: version,
	})
}

// Readiness returns 200 if the service is ready to accept traffic.
func (h *HealthHandler) Readiness(w http.ResponseWriter, r *http.Request) {
	if err := h.ready(); err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{
			"status": "not_ready",
			"error":  err.Error(),
		})
		return
	}
	writeJSON(w, http.StatusOK, models.HealthResponse{
		Status:  "ready",
		Version: version,
	})
}

func writeJSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}
