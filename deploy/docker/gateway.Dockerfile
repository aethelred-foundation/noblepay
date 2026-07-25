FROM golang:1.25.12-bookworm AS build
WORKDIR /src
COPY services/gateway/go.mod services/gateway/go.sum ./
RUN go mod download
COPY services/gateway ./
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/noblepay-gateway ./cmd/gateway

FROM debian:13.6-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /var/lib/noblepay-gateway \
    && chown 65532:65532 /var/lib/noblepay-gateway
COPY --from=build --chown=65532:65532 /out/noblepay-gateway /usr/local/bin/noblepay-gateway
USER 65532:65532
EXPOSE 4018
HEALTHCHECK --interval=20s --timeout=5s --start-period=10s --retries=5 \
  CMD curl --fail --silent --show-error http://127.0.0.1:4018/readyz >/dev/null || exit 1
ENTRYPOINT ["/usr/local/bin/noblepay-gateway"]
