"""Tests for corridor statistics."""

from __future__ import annotations

import pandas as pd
import pytest

from noblepay_compliance.analytics.corridor_stats import CorridorStats, CorridorSummary


class TestCorridorStats:
    def test_summarize(self, sample_transactions: pd.DataFrame):
        cs = CorridorStats()
        summaries = cs.summarize(sample_transactions)
        assert len(summaries) > 0
        for s in summaries:
            assert isinstance(s, CorridorSummary)
            assert s.tx_count >= 1

    def test_top_corridors(self, sample_transactions: pd.DataFrame):
        cs = CorridorStats()
        top = cs.top_corridors(sample_transactions, by="total_volume_usd", top_n=3)
        assert len(top) <= 3
        # Should be sorted descending
        if len(top) >= 2:
            assert top[0].total_volume_usd >= top[1].total_volume_usd

    def test_corridor_dataframe(self, sample_transactions: pd.DataFrame):
        cs = CorridorStats()
        cdf = cs.corridor_dataframe(sample_transactions)
        assert isinstance(cdf, pd.DataFrame)
        assert "origin" in cdf.columns
        assert "total_volume_usd" in cdf.columns

    def test_high_risk_corridors(self, sample_transactions: pd.DataFrame):
        cs = CorridorStats()
        hr = cs.high_risk_corridors(sample_transactions)
        # IR, RU, SY are in sample data and are high-risk
        assert len(hr) > 0
        from noblepay_compliance.utils.constants import HIGH_RISK_JURISDICTIONS
        for s in hr:
            assert s.origin in HIGH_RISK_JURISDICTIONS or s.destination in HIGH_RISK_JURISDICTIONS

    def test_empty_dataframe(self):
        cs = CorridorStats()
        summaries = cs.summarize(pd.DataFrame(columns=["sender_jurisdiction", "receiver_jurisdiction", "amount_usd", "sender_address", "receiver_address"]))
        assert summaries == []

    def test_corridor_dataframe_empty(self):
        cs = CorridorStats()
        result = cs.corridor_dataframe(pd.DataFrame(columns=["sender_jurisdiction", "receiver_jurisdiction", "amount_usd", "sender_address", "receiver_address"]))
        assert isinstance(result, pd.DataFrame)
        assert result.empty

    def test_high_risk_corridors_custom_jurisdictions(self, sample_transactions: pd.DataFrame):
        cs = CorridorStats()
        # Use a custom set that includes "US" as high-risk
        hr = cs.high_risk_corridors(sample_transactions, high_risk_jurisdictions={"US"})
        assert len(hr) > 0
        for s in hr:
            assert s.origin == "US" or s.destination == "US"

    def test_top_corridors_by_tx_count(self, sample_transactions: pd.DataFrame):
        cs = CorridorStats()
        top = cs.top_corridors(sample_transactions, by="tx_count", top_n=2)
        assert len(top) <= 2
        if len(top) >= 2:
            assert top[0].tx_count >= top[1].tx_count
