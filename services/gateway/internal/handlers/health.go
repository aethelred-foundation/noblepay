package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/aethelred/noblepay-gateway/internal/models"
)

const version = "0.1.0"

// HealthHandler handles health and readiness checks.
type HealthHandler struct{}

// NewHealthHandler creates a new HealthHandler.
func NewHealthHandler() *HealthHandler {
	return &HealthHandler{}
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
