FROM golang:1.25.12-bookworm AS build
WORKDIR /src
COPY services/gateway/go.mod services/gateway/go.sum ./
RUN go mod download
COPY services/gateway ./
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/noblepay-gateway ./cmd/gateway \
    && CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/noblepay-healthcheck ./cmd/healthcheck \
    && mkdir -p /out/state

FROM gcr.io/distroless/static-debian13@sha256:f7f8f729987ad0fdf6b05eeeae94b26e6a0f613bdf46feea7fc40f7bd72953e6 AS runtime
COPY --from=build --chown=65532:65532 /out/noblepay-gateway /usr/local/bin/noblepay-gateway
COPY --from=build --chown=65532:65532 /out/noblepay-healthcheck /usr/local/bin/noblepay-healthcheck
COPY --from=build --chown=65532:65532 /out/state/ /var/lib/noblepay-gateway/
USER 65532:65532
EXPOSE 4018
HEALTHCHECK --interval=20s --timeout=5s --start-period=10s --retries=5 \
  CMD ["/usr/local/bin/noblepay-healthcheck"]
ENTRYPOINT ["/usr/local/bin/noblepay-gateway"]
