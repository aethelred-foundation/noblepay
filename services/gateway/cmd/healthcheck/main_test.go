package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

func TestGatewayPort(t *testing.T) {
	t.Setenv("GATEWAY_PORT", "")
	if got := gatewayPort(); got != defaultGatewayPort {
		t.Fatalf("gatewayPort() = %q, want %q", got, defaultGatewayPort)
	}

	t.Setenv("GATEWAY_PORT", " 4020 ")
	if got := gatewayPort(); got != "4020" {
		t.Fatalf("gatewayPort() = %q, want %q", got, "4020")
	}
}

func TestCheck(t *testing.T) {
	tests := []struct {
		name       string
		statusCode int
		wantError  string
	}{
		{name: "ready", statusCode: http.StatusOK},
		{name: "not ready", statusCode: http.StatusServiceUnavailable, wantError: "HTTP 503"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
				writer.WriteHeader(test.statusCode)
			}))
			t.Cleanup(server.Close)

			err := check(context.Background(), server.Client(), server.URL+"/readyz", "")
			if test.wantError == "" && err != nil {
				t.Fatalf("check() error = %v", err)
			}
			if test.wantError != "" && (err == nil || !strings.Contains(err.Error(), test.wantError)) {
				t.Fatalf("check() error = %v, want substring %q", err, test.wantError)
			}
		})
	}
}

func TestCheckWritableStore(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/readyz" {
			t.Errorf("request path = %q, want %q", request.URL.Path, "/readyz")
		}
		writer.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(server.Close)

	storePath := filepath.Join(t.TempDir(), "store.json")
	if err := check(context.Background(), server.Client(), server.URL+"/readyz", storePath); err != nil {
		t.Fatalf("check() error = %v", err)
	}
}

func TestCheckRejectsMissingStoreDirectory(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(server.Close)

	storePath := filepath.Join(t.TempDir(), "missing", "store.json")
	err := check(context.Background(), server.Client(), server.URL+"/readyz", storePath)
	if err == nil || !strings.Contains(err.Error(), "store healthcheck failed") {
		t.Fatalf("check() error = %v, want store healthcheck failure", err)
	}
}
