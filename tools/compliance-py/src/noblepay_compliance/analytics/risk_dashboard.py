"""Risk metrics aggregation for dashboard reporting."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import numpy as np
import pandas as pd

from noblepay_compliance.utils.constants import (
    CTR_THRESHOLD_USD,
    HIGH_RISK_JURISDICTIONS,
    HIGH_RISK_THRESHOLD,
    MEDIUM_RISK_THRESHOLD,
)


@dataclass
class RiskMetrics:
    """Aggregated risk metrics for a time period."""

    period_start: str
    period_end: str
    total_transactions: int
    total_volume_usd: float
    high_risk_count: int
    medium_risk_count: int
    low_risk_count: int
    high_risk_volume_usd: float
    avg_risk_score: float
    max_risk_score: float
    ctr_eligible_count: int
    high_risk_jurisdiction_count: int
    unique_senders: int
    unique_receivers: int


class RiskDashboard:
    """Aggregate risk metrics from scored transaction DataFrames.

    Input DataFrame is expected to contain at minimum:
    - amount_usd (float)
    - risk_score (float, 0..1)
    - timestamp (datetime or str)
    - sender_address (str)
    - receiver_address (str)

    Optional columns:
    - sender_jurisdiction (str)
    - receiver_jurisdiction (str)
    """

    def compute_metrics(
        self,
        df: pd.DataFrame,
        period_start: str | None = None,
        period_end: str | None = None,
    ) -> RiskMetrics:
        """Compute aggregated risk metrics for the transactions in *df*."""
        if df.empty:
            return RiskMetrics(
                period_start=period_start or "",
                period_end=period_end or "",
                total_transactions=0,
                total_volume_usd=0.0,
                high_risk_count=0,
                medium_risk_count=0,
                low_risk_count=0,
                high_risk_volume_usd=0.0,
                avg_risk_score=0.0,
                max_risk_score=0.0,
                ctr_eligible_count=0,
                high_risk_jurisdiction_count=0,
                unique_senders=0,
                unique_receivers=0,
            )

        risk_scores = df["risk_score"]
        amounts = df["amount_usd"]

        high_mask = risk_scores >= HIGH_RISK_THRESHOLD
        medium_mask = (risk_scores >= MEDIUM_RISK_THRESHOLD) & (risk_scores < HIGH_RISK_THRESHOLD)
        low_mask = risk_scores < MEDIUM_RISK_THRESHOLD

        # Jurisdiction risk
        hr_jurisdiction_count = 0
        if "sender_jurisdiction" in df.columns and "receiver_jurisdiction" in df.columns:
            hr_jurisdiction_count = int(
                df["sender_jurisdiction"].isin(HIGH_RISK_JURISDICTIONS).sum()
                + df["receiver_jurisdiction"].isin(HIGH_RISK_JURISDICTIONS).sum()
            )

        return RiskMetrics(
            period_start=period_start or "",
            period_end=period_end or "",
            total_transactions=len(df),
            total_volume_usd=float(amounts.sum()),
            high_risk_count=int(high_mask.sum()),
            medium_risk_count=int(medium_mask.sum()),
            low_risk_count=int(low_mask.sum()),
            high_risk_volume_usd=float(amounts[high_mask].sum()),
            avg_risk_score=float(risk_scores.mean()),
            max_risk_score=float(risk_scores.max()),
            ctr_eligible_count=int((amounts >= CTR_THRESHOLD_USD).sum()),
            high_risk_jurisdiction_count=hr_jurisdiction_count,
            unique_senders=int(df["sender_address"].nunique()),
            unique_receivers=int(df["receiver_address"].nunique()),
        )

    def daily_breakdown(self, df: pd.DataFrame) -> list[RiskMetrics]:
        """Return ``RiskMetrics`` per calendar day."""
        df = df.copy()
        if not pd.api.types.is_datetime64_any_dtype(df["timestamp"]):
            df["timestamp"] = pd.to_datetime(df["timestamp"])

        df["_date"] = df["timestamp"].dt.date
        results: list[RiskMetrics] = []
        for date, group in df.groupby("_date"):
            day_str = str(date)
            results.append(self.compute_metrics(group, period_start=day_str, period_end=day_str))
        return results

    def summary_dict(self, df: pd.DataFrame) -> dict[str, Any]:
        """Return metrics as a flat dictionary (handy for JSON export)."""
        m = self.compute_metrics(df)
        return {
            "total_transactions": m.total_transactions,
            "total_volume_usd": m.total_volume_usd,
            "high_risk_count": m.high_risk_count,
            "medium_risk_count": m.medium_risk_count,
            "low_risk_count": m.low_risk_count,
            "high_risk_volume_usd": m.high_risk_volume_usd,
            "avg_risk_score": m.avg_risk_score,
            "max_risk_score": m.max_risk_score,
            "ctr_eligible_count": m.ctr_eligible_count,
            "high_risk_jurisdiction_count": m.high_risk_jurisdiction_count,
            "unique_senders": m.unique_senders,
            "unique_receivers": m.unique_receivers,
        }
