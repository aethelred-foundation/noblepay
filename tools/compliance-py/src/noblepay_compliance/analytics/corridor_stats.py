"""Payment corridor statistics and analytics."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np
import pandas as pd


@dataclass
class CorridorSummary:
    """Aggregated statistics for a payment corridor (origin -> destination)."""

    origin: str
    destination: str
    tx_count: int
    total_volume_usd: float
    avg_amount_usd: float
    median_amount_usd: float
    max_amount_usd: float
    min_amount_usd: float
    unique_senders: int
    unique_receivers: int


class CorridorStats:
    """Compute statistics per payment corridor.

    A corridor is defined by the pair (sender_jurisdiction, receiver_jurisdiction).
    The input DataFrame must contain at least:
    - sender_jurisdiction (str)
    - receiver_jurisdiction (str)
    - amount_usd (float)
    - sender_address (str)
    - receiver_address (str)
    """

    def summarize(self, df: pd.DataFrame) -> list[CorridorSummary]:
        """Return a ``CorridorSummary`` for every unique corridor in *df*."""
        if df.empty:
            return []

        grouped = df.groupby(["sender_jurisdiction", "receiver_jurisdiction"])
        results: list[CorridorSummary] = []
        for (origin, dest), group in grouped:
            amounts = group["amount_usd"]
            results.append(CorridorSummary(
                origin=str(origin),
                destination=str(dest),
                tx_count=len(group),
                total_volume_usd=float(amounts.sum()),
                avg_amount_usd=float(amounts.mean()),
                median_amount_usd=float(amounts.median()),
                max_amount_usd=float(amounts.max()),
                min_amount_usd=float(amounts.min()),
                unique_senders=int(group["sender_address"].nunique()),
                unique_receivers=int(group["receiver_address"].nunique()),
            ))
        return results

    def top_corridors(self, df: pd.DataFrame, by: str = "total_volume_usd", top_n: int = 10) -> list[CorridorSummary]:
        """Return the top-*n* corridors ranked by *by* (descending)."""
        summaries = self.summarize(df)
        summaries.sort(key=lambda s: getattr(s, by), reverse=True)
        return summaries[:top_n]

    def corridor_dataframe(self, df: pd.DataFrame) -> pd.DataFrame:
        """Return corridor summaries as a DataFrame for further analysis."""
        summaries = self.summarize(df)
        if not summaries:
            return pd.DataFrame()
        records = [
            {
                "origin": s.origin,
                "destination": s.destination,
                "tx_count": s.tx_count,
                "total_volume_usd": s.total_volume_usd,
                "avg_amount_usd": s.avg_amount_usd,
                "median_amount_usd": s.median_amount_usd,
                "max_amount_usd": s.max_amount_usd,
                "min_amount_usd": s.min_amount_usd,
                "unique_senders": s.unique_senders,
                "unique_receivers": s.unique_receivers,
            }
            for s in summaries
        ]
        return pd.DataFrame(records)

    def high_risk_corridors(
        self,
        df: pd.DataFrame,
        high_risk_jurisdictions: frozenset[str] | set[str] | None = None,
    ) -> list[CorridorSummary]:
        """Return corridors where either origin or destination is high-risk."""
        from noblepay_compliance.utils.constants import HIGH_RISK_JURISDICTIONS

        hr = high_risk_jurisdictions or HIGH_RISK_JURISDICTIONS
        summaries = self.summarize(df)
        return [s for s in summaries if s.origin in hr or s.destination in hr]
