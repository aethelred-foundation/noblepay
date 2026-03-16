package server

import (
	"context"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"go.uber.org/zap"

	"github.com/aethelred/noblepay-gateway/internal/config"
	"github.com/aethelred/noblepay-gateway/internal/handlers"
	"github.com/aethelred/noblepay-gateway/internal/services"
	"github.com/aethelred/noblepay-gateway/internal/store"
)

// Server is the main HTTP server.
type Server struct {
	httpServer *http.Server
	logger     *zap.Logger
	cfg        *config.Config
	indexer    *services.BlockchainIndexer
}

// New creates and configures a new Server.
func New(cfg *config.Config, logger *zap.Logger) *Server {
	var paymentStore store.PaymentStore
	var eventStore store.EventStore

	if cfg.StorePath != "" {
		fs, err := store.NewFileStore(cfg.StorePath)
		if err != nil {
			logger.Fatal("failed to initialise file store", zap.Error(err))
		}
		paymentStore = fs
		eventStore = fs
		logger.Info("store: file-backed durable store active", zap.String("path", cfg.StorePath))
	} else {
		ms := store.NewMemoryStore()
		paymentStore = ms
		eventStore = ms
		logger.Info("store: in-memory store active (data will not survive restarts)")
	}

	// Services
	complianceProxy := services.NewComplianceProxy(cfg.ComplianceURL, logger)
	paymentSvc := services.NewPaymentService(paymentStore, complianceProxy, logger)
	indexer := services.NewBlockchainIndexer(eventStore, logger)
	settlementSvc := services.NewSettlementService(paymentStore, eventStore, logger)

	// Handlers
	healthH := handlers.NewHealthHandler()
	paymentH := handlers.NewPaymentHandler(paymentSvc)
	webhookH := handlers.NewWebhookHandler(indexer, settlementSvc, logger, cfg.WebhookSecret)

	// Router
	r := chi.NewRouter()

	// Global middleware
	rateLimiter := handlers.NewRateLimiter(cfg.RateLimitRPS)
	r.Use(handlers.RequestLogger(logger))
	r.Use(rateLimiter.Middleware)

	// Health endpoints (no auth)
	r.Get("/healthz", healthH.Liveness)
	r.Get("/readyz", healthH.Readiness)

	// API routes (with auth)
	r.Route("/api/v1", func(r chi.Router) {
		r.Use(handlers.APIKeyAuth(cfg.APIKey))

		r.Post("/payments", paymentH.Submit)
		r.Get("/payments", paymentH.List)
		r.Get("/payments/{id}", paymentH.GetByID)
		r.Post("/payments/{id}/cancel", paymentH.Cancel)

		r.Post("/webhooks/events", webhookH.HandleEvent)
	})

	return &Server{
		httpServer: &http.Server{
			Addr:         ":" + cfg.Port,
			Handler:      r,
			ReadTimeout:  10 * time.Second,
			WriteTimeout: 10 * time.Second,
			IdleTimeout:  60 * time.Second,
		},
		logger:  logger,
		cfg:     cfg,
		indexer: indexer,
	}
}

// Start begins listening and serving requests, and starts the blockchain indexer.
func (s *Server) Start(ctx context.Context) error {
	s.indexer.Start(ctx)
	s.logger.Info("server starting", zap.String("addr", s.httpServer.Addr))
	return s.httpServer.ListenAndServe()
}

// Shutdown gracefully shuts down the server.
func (s *Server) Shutdown(ctx context.Context) error {
	s.indexer.Stop()
	return s.httpServer.Shutdown(ctx)
}
