"""Tests for risk dashboard metrics aggregation."""

from __future__ import annotations

import pandas as pd
import pytest

from noblepay_compliance.analytics.risk_dashboard import RiskDashboard, RiskMetrics


class TestRiskDashboard:
    def test_compute_metrics(self, scored_transactions: pd.DataFrame):
        dashboard = RiskDashboard()
        metrics = dashboard.compute_metrics(scored_transactions)
        assert isinstance(metrics, RiskMetrics)
        assert metrics.total_transactions == len(scored_transactions)
        assert metrics.total_volume_usd > 0
        assert metrics.high_risk_count + metrics.medium_risk_count + metrics.low_risk_count == len(scored_transactions)

    def test_empty_dataframe(self):
        dashboard = RiskDashboard()
        metrics = dashboard.compute_metrics(pd.DataFrame(columns=["amount_usd", "risk_score", "sender_address", "receiver_address"]))
        assert metrics.total_transactions == 0
        assert metrics.total_volume_usd == 0.0

    def test_daily_breakdown(self, scored_transactions: pd.DataFrame):
        dashboard = RiskDashboard()
        breakdown = dashboard.daily_breakdown(scored_transactions)
        assert len(breakdown) >= 1
        total_txns = sum(m.total_transactions for m in breakdown)
        assert total_txns == len(scored_transactions)

    def test_summary_dict(self, scored_transactions: pd.DataFrame):
        dashboard = RiskDashboard()
        d = dashboard.summary_dict(scored_transactions)
        assert isinstance(d, dict)
        assert "total_transactions" in d
        assert "avg_risk_score" in d

    def test_ctr_eligible(self, scored_transactions: pd.DataFrame):
        dashboard = RiskDashboard()
        metrics = dashboard.compute_metrics(scored_transactions)
        expected = int((scored_transactions["amount_usd"] >= 10000).sum())
        assert metrics.ctr_eligible_count == expected

    def test_jurisdiction_risk_counted(self, scored_transactions: pd.DataFrame):
        dashboard = RiskDashboard()
        metrics = dashboard.compute_metrics(scored_transactions)
        # IR, RU, SY present in sample data
        assert metrics.high_risk_jurisdiction_count > 0

    def test_daily_breakdown_string_timestamps(self):
        """Test daily_breakdown when timestamps are strings (not datetime64)."""
        dashboard = RiskDashboard()
        df = pd.DataFrame({
            "sender_address": ["0x" + "a" * 40, "0x" + "b" * 40],
            "receiver_address": ["0x" + "c" * 40, "0x" + "d" * 40],
            "amount_usd": [5000.0, 12000.0],
            "risk_score": [0.3, 0.8],
            "timestamp": ["2025-06-01 10:00:00", "2025-06-02 14:00:00"],  # strings
        })
        breakdown = dashboard.daily_breakdown(df)
        assert len(breakdown) == 2
        assert all(isinstance(m, RiskMetrics) for m in breakdown)

    def test_compute_metrics_without_jurisdictions(self):
        """Test compute_metrics when jurisdiction columns are absent."""
        dashboard = RiskDashboard()
        df = pd.DataFrame({
            "sender_address": ["0x" + "a" * 40],
            "receiver_address": ["0x" + "b" * 40],
            "amount_usd": [5000.0],
            "risk_score": [0.5],
        })
        metrics = dashboard.compute_metrics(df)
        assert metrics.high_risk_jurisdiction_count == 0
        assert metrics.total_transactions == 1
