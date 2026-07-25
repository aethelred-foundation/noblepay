package server

import (
	"context"
	"fmt"
	"net/http"
	"strings"
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
	compliance *services.ComplianceProxy
}

// New creates a server without terminating the host process on setup errors.
func New(cfg *config.Config, logger *zap.Logger) (*Server, error) {
	if cfg.Environment != "test" {
		if strings.TrimSpace(cfg.APIKey) == "" {
			return nil, fmt.Errorf("GATEWAY_API_KEY is required outside test mode")
		}
		if strings.TrimSpace(cfg.WebhookSecret) == "" {
			return nil, fmt.Errorf("WEBHOOK_SECRET is required outside test mode")
		}
		if cfg.IndexerConfirmations == 0 {
			return nil, fmt.Errorf("INDEXER_CONFIRMATIONS must be at least 1 outside test mode")
		}
	}
	var paymentStore store.PaymentStore
	var eventStore store.EventStore

	if cfg.StorePath != "" {
		fileStore, err := store.NewFileStore(cfg.StorePath)
		if err != nil {
			return nil, fmt.Errorf("initialise durable store: %w", err)
		}
		paymentStore = fileStore
		eventStore = fileStore
		logger.Info("store: file-backed durable store active", zap.String("path", cfg.StorePath))
	} else if cfg.Environment == "test" {
		memoryStore := store.NewMemoryStore()
		paymentStore = memoryStore
		eventStore = memoryStore
	} else {
		return nil, fmt.Errorf("durable STORE_PATH is required outside test mode")
	}

	complianceProxy := services.NewAuthenticatedComplianceProxy(
		cfg.ComplianceAPIURL, cfg.ComplianceAPIKey, cfg.ComplianceTimeout,
		cfg.ComplianceMaxAge, logger,
	)
	paymentService := services.NewPaymentQueryService(paymentStore, logger)

	var indexer *services.BlockchainIndexer
	if cfg.Environment == "test" && cfg.ChainRPCURL == "" {
		indexer = services.NewBlockchainIndexer(eventStore, logger)
	} else {
		indexer = services.NewAnchoredConfirmedRPCBlockchainIndexer(
			eventStore, cfg.ChainRPCURL, cfg.NoblePayAddress,
			cfg.IndexerStartBlock, cfg.IndexerConfirmations,
			cfg.ChainID, cfg.NetworkAnchorBlock, cfg.NetworkAnchorHash,
			cfg.IndexerPollInterval, logger,
		)
	}
	settlementService := services.NewSettlementService(paymentStore, eventStore, logger)

	ready := func() error {
		if err := indexer.Ready(); err != nil {
			return err
		}
		if cfg.Environment != "test" {
			ctx, cancel := context.WithTimeout(context.Background(), cfg.ComplianceTimeout)
			defer cancel()
			if err := complianceProxy.Ready(ctx); err != nil {
				return err
			}
		}
		return nil
	}
	healthHandler := handlers.NewReadinessHealthHandler(ready)
	paymentHandler := handlers.NewPaymentHandler(paymentService)
	webhookHandler := handlers.NewWebhookHandler(indexer, settlementService, logger, cfg.WebhookSecret)

	router := chi.NewRouter()
	rateLimiter, err := handlers.NewRateLimiterWithTrustedProxies(cfg.RateLimitRPS, cfg.TrustedProxyCIDRs)
	if err != nil {
		return nil, fmt.Errorf("configure trusted proxies: %w", err)
	}
	router.Use(handlers.RequestLogger(logger))
	router.Use(rateLimiter.Middleware)
	router.Use(handlers.LimitRequestBody(1 << 20))
	router.Get("/healthz", healthHandler.Liveness)
	router.Get("/readyz", healthHandler.Readiness)
	router.Route("/api/v1", func(router chi.Router) {
		router.Use(handlers.APIKeyAuth(cfg.APIKey))
		router.Group(func(reads chi.Router) {
			reads.Use(handlers.RequireProjectionReady(indexer.Ready))
			reads.Get("/payments", paymentHandler.List)
			reads.Get("/payments/{id}", paymentHandler.GetByID)
		})
		router.Post("/webhooks/events", webhookHandler.HandleEvent)
	})

	return &Server{
		httpServer: &http.Server{
			Addr: ":" + cfg.Port, Handler: router,
			ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second,
			WriteTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second,
			MaxHeaderBytes: 16 << 10,
		},
		logger: logger, cfg: cfg, indexer: indexer, compliance: complianceProxy,
	}, nil
}

// Start validates external dependencies before listening.
func (s *Server) Start(ctx context.Context) error {
	if s.cfg.Environment != "test" {
		if err := s.compliance.Ready(ctx); err != nil {
			return fmt.Errorf("compliance dependency is not ready: %w", err)
		}
	}
	if err := s.indexer.Start(ctx); err != nil {
		return fmt.Errorf("chain indexer failed to start: %w", err)
	}
	s.logger.Info("server starting", zap.String("addr", s.httpServer.Addr))
	return s.httpServer.ListenAndServe()
}

// Shutdown gracefully shuts down the server.
func (s *Server) Shutdown(ctx context.Context) error {
	s.indexer.Stop()
	return s.httpServer.Shutdown(ctx)
}
