"""Transaction pattern analysis on pandas DataFrames."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np
import pandas as pd

from noblepay_compliance.utils.constants import (
    CTR_THRESHOLD_USD,
    STRUCTURING_AGGREGATE_THRESHOLD_USD,
    STRUCTURING_WINDOW_SECONDS,
)


@dataclass
class TransactionPattern:
    """Summary of detected patterns for a sender."""

    sender: str
    total_volume_usd: float
    tx_count: int
    avg_amount: float
    max_amount: float
    min_amount: float
    stddev_amount: float
    is_structuring_suspect: bool
    rapid_burst_count: int  # txns within 60 s of each other


class TransactionAnalyzer:
    """Analyse transaction DataFrames for suspicious patterns.

    Expected DataFrame columns:
    - sender_address (str)
    - receiver_address (str)
    - amount_usd (float)
    - timestamp (datetime64 or parseable string)
    """

    def __init__(self, structuring_window_s: int = STRUCTURING_WINDOW_SECONDS) -> None:
        self.structuring_window_s = structuring_window_s

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def analyze_sender(self, df: pd.DataFrame, sender: str) -> TransactionPattern:
        """Compute pattern summary for a single sender."""
        sub = df[df["sender_address"] == sender].copy()
        if sub.empty:
            return TransactionPattern(
                sender=sender,
                total_volume_usd=0.0,
                tx_count=0,
                avg_amount=0.0,
                max_amount=0.0,
                min_amount=0.0,
                stddev_amount=0.0,
                is_structuring_suspect=False,
                rapid_burst_count=0,
            )

        amounts = sub["amount_usd"]
        sub = self._ensure_datetime(sub)
        sub = sub.sort_values("timestamp")

        return TransactionPattern(
            sender=sender,
            total_volume_usd=float(amounts.sum()),
            tx_count=len(sub),
            avg_amount=float(amounts.mean()),
            max_amount=float(amounts.max()),
            min_amount=float(amounts.min()),
            stddev_amount=float(amounts.std()) if len(sub) > 1 else 0.0,
            is_structuring_suspect=self._detect_structuring(sub),
            rapid_burst_count=self._count_rapid_bursts(sub),
        )

    def analyze_all_senders(self, df: pd.DataFrame) -> list[TransactionPattern]:
        """Compute pattern summaries for every unique sender."""
        senders = df["sender_address"].unique()
        return [self.analyze_sender(df, s) for s in senders]

    def velocity_check(self, df: pd.DataFrame, sender: str, window_hours: int = 24) -> dict[str, Any]:
        """Return transaction count and volume within the last *window_hours* for *sender*."""
        sub = df[df["sender_address"] == sender].copy()
        sub = self._ensure_datetime(sub)
        if sub.empty:
            return {"sender": sender, "tx_count": 0, "total_usd": 0.0, "window_hours": window_hours}

        latest = sub["timestamp"].max()
        cutoff = latest - pd.Timedelta(hours=window_hours)
        window = sub[sub["timestamp"] >= cutoff]
        return {
            "sender": sender,
            "tx_count": len(window),
            "total_usd": float(window["amount_usd"].sum()),
            "window_hours": window_hours,
        }

    def high_value_transactions(self, df: pd.DataFrame, threshold: float = CTR_THRESHOLD_USD) -> pd.DataFrame:
        """Filter to transactions above *threshold* USD."""
        return df[df["amount_usd"] >= threshold].copy()

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _ensure_datetime(df: pd.DataFrame) -> pd.DataFrame:
        if not pd.api.types.is_datetime64_any_dtype(df["timestamp"]):
            df = df.copy()
            df["timestamp"] = pd.to_datetime(df["timestamp"])
        return df

    def _detect_structuring(self, sorted_df: pd.DataFrame) -> bool:
        """Detect potential structuring (many just-below-threshold txns in 24 h window)."""
        sorted_df = self._ensure_datetime(sorted_df)
        if sorted_df.empty:
            return False

        timestamps = sorted_df["timestamp"].values
        amounts = sorted_df["amount_usd"].values

        for i in range(len(sorted_df)):
            window_end = timestamps[i] + np.timedelta64(self.structuring_window_s, "s")
            mask = (timestamps >= timestamps[i]) & (timestamps <= window_end)
            window_amounts = amounts[mask]
            if (
                window_amounts.sum() >= STRUCTURING_AGGREGATE_THRESHOLD_USD
                and all(a < CTR_THRESHOLD_USD for a in window_amounts)
                and len(window_amounts) >= 2
            ):
                return True
        return False

    @staticmethod
    def _count_rapid_bursts(sorted_df: pd.DataFrame, burst_seconds: int = 60) -> int:
        """Count transactions that occur within *burst_seconds* of each other."""
        if len(sorted_df) < 2:
            return 0
        ts = sorted_df["timestamp"].values
        diffs = np.diff(ts).astype("timedelta64[s]").astype(np.float64)
        return int(np.sum(diffs <= burst_seconds))
