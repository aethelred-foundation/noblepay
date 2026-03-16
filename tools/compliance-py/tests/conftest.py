"""Shared pytest fixtures for NoblePay compliance tests."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from noblepay_compliance.utils.constants import RISK_FEATURE_COLUMNS


@pytest.fixture()
def rng() -> np.random.Generator:
    """Seeded random generator for reproducibility."""
    return np.random.default_rng(42)


@pytest.fixture()
def sample_transactions() -> pd.DataFrame:
    """A small DataFrame of sample transactions."""
    return pd.DataFrame(
        {
            "tx_id": [f"tx-{i}" for i in range(10)],
            "sender_address": [
                "0x" + f"{i:040x}" for i in range(10)
            ],
            "receiver_address": [
                "0x" + f"{i + 100:040x}" for i in range(10)
            ],
            "amount_usd": [500, 9500, 3000, 15000, 200, 8000, 9999, 11000, 4500, 6000],
            "currency": ["USD"] * 10,
            "timestamp": pd.date_range("2025-06-01", periods=10, freq="h"),
            "sender_jurisdiction": ["US", "US", "GB", "IR", "US", "NG", "US", "US", "DE", "RU"],
            "receiver_jurisdiction": ["GB", "DE", "US", "US", "JP", "US", "CA", "SY", "US", "US"],
        }
    )


@pytest.fixture()
def scored_transactions(sample_transactions: pd.DataFrame, rng: np.random.Generator) -> pd.DataFrame:
    """Transactions with risk_score column added."""
    df = sample_transactions.copy()
    df["risk_score"] = rng.uniform(0.0, 1.0, size=len(df))
    return df


@pytest.fixture()
def training_df(rng: np.random.Generator) -> pd.DataFrame:
    """DataFrame suitable for training the risk scorer (labelled)."""
    n = 200
    data: dict[str, np.ndarray] = {}
    for col in RISK_FEATURE_COLUMNS:
        if col.startswith("is_"):
            data[col] = rng.integers(0, 2, size=n).astype(np.float64)
        elif col == "hour_of_day":
            data[col] = rng.integers(0, 24, size=n).astype(np.float64)
        else:
            data[col] = rng.uniform(0, 10000, size=n)

    df = pd.DataFrame(data)
    # Simple rule: high amount + high jurisdiction risk -> suspicious
    df["is_suspicious"] = (
        (df["amount_usd"] > 5000) & (df["sender_jurisdiction_risk"] > 5000)
    ).astype(int)
    return df


@pytest.fixture()
def sanctions_entries():
    """Sample sanctions entries."""
    from noblepay_compliance.models.sanctions_matcher import SanctionsEntry

    return [
        SanctionsEntry(name="John Doe", aliases=["J. Doe", "Johnny Doe"], source="OFAC-SDN"),
        SanctionsEntry(name="Acme Corp", aliases=["Acme Corporation", "ACME LLC"], source="OFAC-SDN"),
        SanctionsEntry(name="Ivan Petrov", aliases=["I. Petrov"], source="EU-SANCTIONS"),
        SanctionsEntry(name="Al-Rashid Trading", aliases=["Al Rashid Co."], source="OFAC-SDN"),
    ]
