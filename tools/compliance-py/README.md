# NoblePay Compliance & Analytics Toolkit

Python toolkit for ML-based compliance, transaction analytics, and regulatory reporting.
Complements the Rust TEE engine with model training, data analytics, and reporting tools.

## Features

- **ML Risk Scoring** -- Gradient-boosted classifier for transaction risk
- **Anomaly Detection** -- Isolation Forest for unsupervised transaction anomaly detection
- **Sanctions Matching** -- Fuzzy name matching against sanctions lists (Levenshtein / rapidfuzz)
- **Transaction Analytics** -- Pattern analysis, corridor statistics, risk dashboards
- **Regulatory Reporting** -- FinCEN SAR/CTR generation, XML/JSON export

## Quick Start

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
pytest tests/ -v
```
