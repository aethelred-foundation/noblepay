package handlers

import (
	"crypto/sha256"
	"crypto/subtle"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"go.uber.org/zap"
)

// RequestLogger is a middleware that logs each request.
func RequestLogger(logger *zap.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			ww := &statusWriter{ResponseWriter: w, status: http.StatusOK}
			next.ServeHTTP(ww, r)
			logger.Info("request",
				zap.String("method", r.Method),
				zap.String("path", r.URL.Path),
				zap.Int("status", ww.status),
				zap.Duration("duration", time.Since(start)),
			)
		})
	}
}

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (sw *statusWriter) WriteHeader(code int) {
	sw.status = code
	sw.ResponseWriter.WriteHeader(code)
}

// APIKeyAuth is a middleware that requires a valid API key header. An empty
// configured key never grants access, including in tests.
func APIKeyAuth(apiKey string) func(http.Handler) http.Handler {
	expected := sha256.Sum256([]byte(apiKey))
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			key := r.Header.Get("X-API-Key")
			actual := sha256.Sum256([]byte(key))
			if apiKey == "" || key == "" || subtle.ConstantTimeCompare(actual[:], expected[:]) != 1 {
				http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// RateLimiter is a simple token-bucket rate limiter per IP.
type RateLimiter struct {
	mu             sync.Mutex
	buckets        map[string]*bucket
	rate           int
	trustedProxies []*net.IPNet
	lastCleanup    time.Time
}

type bucket struct {
	tokens    int
	lastReset time.Time
	lastSeen  time.Time
}

const (
	maxRateLimitBuckets = 10_000
	rateLimitBucketTTL  = 10 * time.Minute
)

// NewRateLimiter creates a rate limiter allowing rps requests per second per IP.
func NewRateLimiter(rps int) *RateLimiter {
	limiter, _ := NewRateLimiterWithTrustedProxies(rps, nil)
	return limiter
}

// NewRateLimiterWithTrustedProxies creates a limiter that accepts forwarded
// client IPs only when every hop between the client and this service is a
// configured trusted proxy. An empty list ignores forwarding headers.
func NewRateLimiterWithTrustedProxies(rps int, trustedCIDRs []string) (*RateLimiter, error) {
	if rps <= 0 {
		rps = 1
	}
	limiter := &RateLimiter{
		buckets:     make(map[string]*bucket),
		rate:        rps,
		lastCleanup: time.Now(),
	}
	for _, raw := range trustedCIDRs {
		_, network, err := net.ParseCIDR(strings.TrimSpace(raw))
		if err != nil {
			return nil, err
		}
		limiter.trustedProxies = append(limiter.trustedProxies, network)
	}
	return limiter, nil
}

// Middleware returns the rate limiting middleware handler.
func (rl *RateLimiter) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ip := rl.clientIP(r)
		if !rl.allow(ip) {
			http.Error(w, `{"error":"rate limit exceeded"}`, http.StatusTooManyRequests)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (rl *RateLimiter) clientIP(r *http.Request) string {
	peer := normalizedIP(r.RemoteAddr)
	if peer == "" || !rl.isTrustedProxy(net.ParseIP(peer)) {
		return peer
	}

	forwarded := strings.Split(r.Header.Get("X-Forwarded-For"), ",")
	for i := len(forwarded) - 1; i >= 0; i-- {
		candidate := normalizedIP(strings.TrimSpace(forwarded[i]))
		parsed := net.ParseIP(candidate)
		if parsed == nil {
			return peer
		}
		if !rl.isTrustedProxy(parsed) {
			return candidate
		}
	}
	return peer
}

func normalizedIP(address string) string {
	if host, _, err := net.SplitHostPort(address); err == nil {
		address = host
	}
	ip := net.ParseIP(strings.Trim(address, "[]"))
	if ip == nil {
		return "unknown"
	}
	return ip.String()
}

func (rl *RateLimiter) isTrustedProxy(ip net.IP) bool {
	if ip == nil {
		return false
	}
	for _, network := range rl.trustedProxies {
		if network.Contains(ip) {
			return true
		}
	}
	return false
}

func (rl *RateLimiter) allow(ip string) bool {
	rl.mu.Lock()
	defer rl.mu.Unlock()

	b, ok := rl.buckets[ip]
	now := time.Now()
	if now.Sub(rl.lastCleanup) >= rateLimitBucketTTL/2 {
		for key, candidate := range rl.buckets {
			if now.Sub(candidate.lastSeen) >= rateLimitBucketTTL {
				delete(rl.buckets, key)
			}
		}
		rl.lastCleanup = now
	}

	if !ok {
		if len(rl.buckets) >= maxRateLimitBuckets {
			return false
		}
		rl.buckets[ip] = &bucket{tokens: rl.rate - 1, lastReset: now, lastSeen: now}
		return true
	}
	b.lastSeen = now

	// Reset tokens every second.
	if now.Sub(b.lastReset) >= time.Second {
		b.tokens = rl.rate
		b.lastReset = now
	}

	if b.tokens <= 0 {
		return false
	}

	b.tokens--
	return true
}

// LimitRequestBody applies one request-size ceiling to every route, including
// authenticated webhook ingestion.
func LimitRequestBody(maxBytes int64) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Body != nil {
				r.Body = http.MaxBytesReader(w, r.Body, maxBytes)
			}
			next.ServeHTTP(w, r)
		})
	}
}

// RequireProjectionReady prevents canonical payment reads while the indexer
// is starting, catching up, stale, or has observed a network/reorg failure.
// Callers receive no projection payload on failure.
func RequireProjectionReady(ready func() error) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if ready == nil || ready() != nil {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusServiceUnavailable)
				_, _ = w.Write([]byte(`{"status":"not_ready","error":"canonical payment projection unavailable"}` + "\n"))
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
