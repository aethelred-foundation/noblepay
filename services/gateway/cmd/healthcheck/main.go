package main

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	defaultGatewayPort = "4018"
	healthcheckTimeout = 4 * time.Second
)

func main() {
	ctx, cancel := context.WithTimeout(context.Background(), healthcheckTimeout)
	defer cancel()

	if err := check(
		ctx,
		http.DefaultClient,
		gatewayHealthcheckURL(gatewayPort()),
		os.Getenv("STORE_PATH"),
	); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func gatewayPort() string {
	if port := strings.TrimSpace(os.Getenv("GATEWAY_PORT")); port != "" {
		return port
	}
	return defaultGatewayPort
}

func gatewayHealthcheckURL(port string) string {
	return "http://127.0.0.1:" + port + "/readyz"
}

func check(ctx context.Context, client *http.Client, endpoint, storePath string) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return fmt.Errorf("create healthcheck request: %w", err)
	}

	response, err := client.Do(request)
	if err != nil {
		return fmt.Errorf("gateway healthcheck failed: %w", err)
	}
	defer response.Body.Close()

	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return fmt.Errorf("gateway healthcheck returned HTTP %d", response.StatusCode)
	}

	if strings.TrimSpace(storePath) != "" {
		if err := checkWritableDirectory(filepath.Dir(storePath)); err != nil {
			return fmt.Errorf("gateway store healthcheck failed: %w", err)
		}
	}

	return nil
}

func checkWritableDirectory(directory string) error {
	file, err := os.CreateTemp(directory, ".noblepay-healthcheck-*")
	if err != nil {
		return fmt.Errorf("create probe: %w", err)
	}
	name := file.Name()
	if err := file.Close(); err != nil {
		os.Remove(name)
		return fmt.Errorf("close probe: %w", err)
	}
	if err := os.Remove(name); err != nil {
		return fmt.Errorf("remove probe: %w", err)
	}
	return nil
}
