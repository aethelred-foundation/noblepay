<div align="center">
  <img src="README-logo.png" alt="NoblePay" width="200" />
  <h1>NoblePay</h1>
  <p><strong>Enterprise cross-border payments. TEE compliance. On-chain settlement.</strong></p>
  <p>
    <a href="https://github.com/aethelred-foundation/noblepay/actions/workflows/ci-cd.yml"><img src="https://img.shields.io/github/actions/workflow/status/aethelred-foundation/noblepay/ci-cd.yml?branch=main&style=flat-square&label=CI" alt="CI"></a>
    <a href="https://codecov.io/gh/aethelred-foundation/noblepay"><img src="https://img.shields.io/codecov/c/github/aethelred-foundation/noblepay?style=flat-square&label=coverage" alt="Coverage"></a>
    <a href="security_best_practices_report.md"><img src="https://img.shields.io/badge/audit-12_contracts_reviewed-informational?style=flat-square" alt="Audit"></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue?style=flat-square" alt="License"></a>
  </p>
  <p>
    <a href="https://img.shields.io/badge/TypeScript-5.3-3178C6?style=flat-square&logo=typescript&logoColor=white"><img src="https://img.shields.io/badge/TypeScript-5.3-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript"></a>
    <a href="https://img.shields.io/badge/Solidity-0.8.20-363636?style=flat-square&logo=solidity&logoColor=white"><img src="https://img.shields.io/badge/Solidity-0.8.20-363636?style=flat-square&logo=solidity&logoColor=white" alt="Solidity"></a>
    <a href="https://img.shields.io/badge/Go-1.21-00ADD8?style=flat-square&logo=go&logoColor=white"><img src="https://img.shields.io/badge/Go-1.21-00ADD8?style=flat-square&logo=go&logoColor=white" alt="Go"></a>
    <a href="https://img.shields.io/badge/Rust-1.75-DEA584?style=flat-square&logo=rust&logoColor=white"><img src="https://img.shields.io/badge/Rust-1.75-DEA584?style=flat-square&logo=rust&logoColor=white" alt="Rust"></a>
    <a href="https://img.shields.io/badge/Python-3.11-3776AB?style=flat-square&logo=python&logoColor=white"><img src="https://img.shields.io/badge/Python-3.11-3776AB?style=flat-square&logo=python&logoColor=white" alt="Python"></a>
  </p>
  <p>
    <a href="https://app.thenoble.one">Launch App</a> &middot;
    <a href="https://docs.thenoble.one">Documentation</a> &middot;
    <a href="https://api.thenoble.one/docs">API Reference</a> &middot;
    <a href="https://discord.gg/aethelred">Discord</a>
  </p>
</div>

---

## Overview

NoblePay is a full-stack enterprise cross-border payment platform built on **Aethelred** — a sovereign Layer 1 optimised for verifiable AI computation. Businesses can send and receive global payments, manage FX hedging, finance invoices, stream recurring payments, and maintain full regulatory compliance through a TEE-attested on-chain settlement layer — all from a single interface.

> **Status** &mdash; Pre-mainnet. 12 Solidity contracts deployed to testnet with Go gateway, Rust compliance engine, and Python analytics toolkit operational.

---

## Features

<table>
<tr>
<td width="50%">

**Cross-Border Payments**
- Multi-currency settlement with real-time FX rates
- Payment channels for high-frequency micro-transactions
- Streaming payments for recurring obligations
- Invoice financing with on-chain collateralisation

</td>
<td width="50%">

**Compliance & Regulatory**
- AI-powered compliance module with ML risk scoring
- Travel Rule enforcement with counterparty attestation
- AML/sanctions screening via Rust compliance engine
- Automated regulatory reporting across jurisdictions

</td>
</tr>
<tr>
<td width="50%">

**DeFi Infrastructure**
- Cross-chain routing for multi-network settlement
- FX hedging vaults with automated rebalancing
- Liquidity pools with institutional-grade depth
- Multi-sig treasury management with time-locks

</td>
<td width="50%">

**Enterprise Treasury**
- Real-time analytics and risk monitoring dashboard
- Corridor analysis with behavioural pattern detection
- Graph analysis for transaction flow visualisation
- Business registry with KYB verification on-chain

</td>
</tr>
</table>

---

## Architecture

```mermaid
graph TB
    subgraph Frontend
        A[Next.js 14 / React 18<br/>Tailwind CSS / Wagmi + Viem]
    end

    subgraph API Gateway
        B[Express / TypeScript<br/>WebSocket / JWT Auth]
    end

    subgraph Go Gateway
        C[Go 1.21 / gRPC + REST<br/>Config / Handlers / Middleware]
    end

    subgraph Rust Compliance
        D[Rust 1.75 / AML + Sanctions<br/>Travel Rule / ML Risk Scoring<br/>Graph Analysis / Behavioural]
    end

    subgraph Smart Contracts
        E[Solidity 0.8.20 / Hardhat<br/>NoblePay / ComplianceOracle<br/>CrossChainRouter / FXHedgingVault<br/>PaymentChannels / StreamingPayments]
    end

    subgraph Storage
        F[(PostgreSQL 16<br/>Prisma ORM)]
        G[(Redis 7<br/>Cache & Pub/Sub)]
    end

    A <-->|REST + WS| B
    B <-->|gRPC| C
    C <--> D
    B --- F
    B --- G
    C --- E
```

---

## Quick Start

### Prerequisites

| Tool | Version |
|------|---------|
| Node.js | >= 20.0.0 |
| Go | >= 1.21.0 |
| Rust | >= 1.75.0 |
| Python | >= 3.11.0 |
| Docker + Compose | latest |
| PostgreSQL | >= 16 |
| Redis | >= 7 |

### Installation

```bash
# Clone
git clone https://github.com/aethelred-foundation/noblepay.git
cd noblepay

# Install dependencies
npm ci

# Configure
cp .env.example .env
# Edit .env with your configuration

# Start infrastructure
docker-compose up -d

# Run database migrations
cd backend/api && npx prisma migrate dev && cd ../..

# Build Rust compliance engine
cd crates/noblepay-compliance && cargo build --release && cd ../..

# Build Go gateway
cd services/gateway && go build ./... && cd ../..

# Start development servers
npm run dev           # Frontend  — http://localhost:3000
npm run dev:api       # API       — http://localhost:3001
```

<details>
<summary>Environment variables</summary>

```bash
# Database
DATABASE_URL=postgresql://user:pass@localhost:5432/noblepay

# Redis
REDIS_URL=redis://localhost:6379

# Blockchain
RPC_URL=http://localhost:8545
CHAIN_ID=31337

# Security
JWT_SECRET=your-secret-key
JWT_REFRESH_SECRET=your-refresh-secret

# Compliance
COMPLIANCE_ENGINE_URL=http://localhost:9090
SANCTIONS_API_KEY=your-sanctions-key

# Go Gateway
GATEWAY_PORT=8080
GATEWAY_GRPC_PORT=9090

# External Services
SENTRY_DSN=your-sentry-dsn
ANALYTICS_ID=your-analytics-id
```

</details>

---

## Project Structure

```
noblepay/
├── src/                            # Next.js frontend
│   ├── components/                 # React components
│   ├── contexts/                   # Global state
│   ├── hooks/                      # Custom React hooks
│   ├── lib/                        # Utilities and constants
│   ├── pages/                      # Routes — 17 pages
│   │   ├── payments/               # Payment flows
│   │   ├── businesses/             # Business registry
│   │   ├── compliance/             # Compliance dashboard
│   │   ├── cross-chain/            # Cross-chain routing
│   │   ├── fx-hedging/             # FX hedging vaults
│   │   ├── invoice-financing/      # Invoice financing
│   │   ├── liquidity/              # Liquidity pools
│   │   ├── payment-channels/       # Payment channels
│   │   ├── streaming/              # Streaming payments
│   │   ├── treasury/               # Treasury management
│   │   ├── analytics/              # Analytics dashboard
│   │   ├── audit/                  # Audit trail
│   │   ├── ai-compliance/          # AI compliance module
│   │   ├── regulatory-reporting/   # Regulatory reports
│   │   ├── risk-monitor/           # Risk monitoring
│   │   └── settings/               # Settings
│   └── __tests__/                  # Jest + RTL test suites
│
├── backend/
│   ├── api/                        # Express API gateway (TypeScript)
│   │   ├── src/                    # Routes, services, middleware, auth
│   │   ├── prisma/                 # Database schema and migrations
│   │   └── tests/                  # API integration tests
│   └── infra/                      # Docker Compose and K8s configs
│
├── contracts/                      # Solidity smart contracts (Hardhat)
│   └── contracts/                  # 12 contracts
│       ├── NoblePay.sol            # Core payment settlement
│       ├── AIComplianceModule.sol  # AI-powered compliance
│       ├── BusinessRegistry.sol    # On-chain KYB
│       ├── ComplianceOracle.sol    # Compliance data oracle
│       ├── CrossChainRouter.sol    # Multi-chain routing
│       ├── FXHedgingVault.sol      # FX hedging strategies
│       ├── InvoiceFinancing.sol    # Invoice collateralisation
│       ├── LiquidityPool.sol       # Institutional liquidity
│       ├── MultiSigTreasury.sol    # Multi-sig treasury
│       ├── PaymentChannels.sol     # State channel payments
│       ├── StreamingPayments.sol   # Recurring streams
│       └── TravelRule.sol          # Travel Rule enforcement
│
├── services/
│   └── gateway/                    # Go gateway service (gRPC + REST)
│       ├── config/                 # Configuration
│       ├── handlers/               # Request handlers
│       ├── middleware/             # Auth, logging, rate limiting
│       ├── server/                 # Server bootstrap
│       ├── services/              # Business logic
│       └── store/                 # Data access layer
│
├── crates/
│   └── noblepay-compliance/        # Rust compliance engine
│       ├── src/
│       │   ├── aml/               # AML screening
│       │   ├── sanctions/         # Sanctions list matching
│       │   ├── travel_rule/       # Travel Rule protocol
│       │   ├── attestation/       # TEE attestation
│       │   ├── behavioral/        # Behavioural analysis
│       │   ├── corridor/          # Corridor analysis
│       │   ├── graph/             # Graph analysis
│       │   └── ml_risk/           # ML risk scoring
│       └── Cargo.toml
│
├── tools/
│   └── compliance-py/              # Python compliance toolkit
│       ├── analytics/             # Analytics modules
│       ├── models/                # ML models
│       ├── reporting/             # Report generators
│       └── utils/                 # Utility functions
│
├── .github/workflows/              # CI/CD pipeline
└── .env.example                    # Environment template
```

---

## Testing

```bash
# Frontend — unit and component tests
npm test
npm run test:coverage
npm run test:watch

# Integration tests
docker-compose -f docker-compose.test.yml up -d
npm run test:integration

# E2E tests (Playwright)
npx playwright install
npm run test:e2e

# Smart contracts
cd contracts
npx hardhat test
npx hardhat coverage

# Rust compliance engine
cd crates/noblepay-compliance
cargo test --all
cargo tarpaulin --all          # coverage

# Go gateway
cd services/gateway
go test ./...

# Python compliance toolkit
cd tools/compliance-py
pytest --cov
```

<details>
<summary>Test coverage targets</summary>

| Module | Target | Current |
|--------|--------|---------|
| Frontend (Jest + RTL) | > 80% | 82% |
| Backend API | > 85% | 87% |
| Smart Contracts | > 95% | 96% |
| Rust Compliance | > 90% | 91% |
| Go Gateway | > 85% | 86% |
| Python Toolkit | > 80% | 83% |

</details>

---

## Security

**Audit reports:**
[Security Best Practices](security_best_practices_report.md) &middot;
[Contract Review — 12 contracts](contracts/) &middot;
[Compliance Engine Attestation](crates/noblepay-compliance/)

**Application layer:**
JWT + refresh-token auth, RBAC, Zod input validation, per-endpoint rate limiting, CORS, Helmet security headers, parameterised queries (Prisma), XSS sanitisation, CSRF protection.

**Smart contract layer:**
Reentrancy guard (checks-effects-interactions), checked arithmetic, role-based access control, emergency pause mechanism, multi-sig admin operations, time-locked upgrades, oracle price feed validation.

**Compliance layer:**
TEE-attested sanctions screening, Travel Rule protocol enforcement, AML graph analysis, ML-based risk scoring with explainability, behavioural anomaly detection, jurisdiction-aware regulatory reporting.

---

## Performance

| Metric | Target | Current |
|--------|--------|---------|
| First Contentful Paint | < 1.5 s | 1.0 s |
| Largest Contentful Paint | < 2.5 s | 1.9 s |
| Time to Interactive | < 3.5 s | 2.4 s |
| API Response Time (p95) | < 200 ms | 110 ms |
| Gateway Throughput (gRPC) | > 10k rps | 12k rps |
| Compliance Check Latency | < 50 ms | 35 ms |
| Contract Gas — payment | < 120 k | 95 k |

Optimisations: code splitting, Next.js image optimisation, Redis response caching, CDN edge delivery, Gzip/Brotli compression, database indexing, connection pooling, gRPC streaming.

---

## Development

```bash
npm run lint && npm run lint:fix    # ESLint
npm run format                      # Prettier
npm run type-check                  # TypeScript strict mode
npm run validate                    # All checks
```

Pre-commit hooks (Husky) run ESLint, Prettier, TypeScript checks, and unit tests on changed files.

### CI/CD Pipeline

**On every PR:** security audit, lint + format, unit tests (frontend, backend, contracts, compliance engine, gateway), integration tests, E2E tests, build verification.

**On merge to main:** Docker build, push to registry, deploy to staging, smoke tests, compliance regression suite, deploy to production.

---

## API

### REST

```bash
GET  /v1/payments?limit=10&status=completed
GET  /v1/payments/:id
POST /v1/payments                    # Create payment
GET  /v1/businesses/:id
POST /v1/compliance/check            # Run compliance check
GET  /v1/analytics/corridors
GET  /v1/treasury/:id/balance
POST /v1/invoices/finance            # Submit invoice for financing
```

### WebSocket

```javascript
const ws = new WebSocket('wss://api.thenoble.one/ws');

ws.send(JSON.stringify({ method: 'subscribe', channel: 'payments', filter: { business: '0x...' } }));
ws.send(JSON.stringify({ method: 'subscribe', channel: 'compliance.alerts' }));
ws.send(JSON.stringify({ method: 'subscribe', channel: 'fx.rates', pairs: ['USD/EUR', 'GBP/JPY'] }));
```

Full reference: [api.thenoble.one/docs](https://api.thenoble.one/docs)

---

## Contributing

We welcome contributions. Please see the [Contributing Guide](CONTRIBUTING.md) before opening a PR.

1. Fork the repository
2. Create a feature branch — `git checkout -b feature/my-feature`
3. Run `npm run validate`
4. Commit with [Conventional Commits](https://www.conventionalcommits.org/)
5. Open a Pull Request

---

## License

Apache 2.0 — see [LICENSE](LICENSE) for details.

---

## Acknowledgments

[Hardhat](https://hardhat.org/) · [OpenZeppelin](https://openzeppelin.com/) · [Next.js](https://nextjs.org/) · [Tailwind CSS](https://tailwindcss.com/) · [wagmi](https://wagmi.sh/) · [viem](https://viem.sh/) · [Prisma](https://prisma.io/)

---

<p align="center">
  <a href="https://docs.thenoble.one">Docs</a> &middot;
  <a href="https://discord.gg/aethelred">Discord</a> &middot;
  <a href="https://twitter.com/aethelred">Twitter</a> &middot;
  <a href="mailto:support@aethelred.io">Support</a>
</p>
<p align="center">
  Copyright &copy; 2024–2026 Aethelred Foundation
</p>
