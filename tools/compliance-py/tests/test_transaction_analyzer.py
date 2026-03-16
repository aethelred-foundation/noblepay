"""Tests for transaction pattern analysis."""

from __future__ import annotations

import pandas as pd
import pytest

from noblepay_compliance.analytics.transaction_analyzer import TransactionAnalyzer, TransactionPattern


class TestTransactionAnalyzer:
    def test_analyze_sender(self, sample_transactions: pd.DataFrame):
        analyzer = TransactionAnalyzer()
        sender = sample_transactions["sender_address"].iloc[0]
        result = analyzer.analyze_sender(sample_transactions, sender)
        assert isinstance(result, TransactionPattern)
        assert result.sender == sender
        assert result.tx_count >= 1

    def test_analyze_nonexistent_sender(self, sample_transactions: pd.DataFrame):
        analyzer = TransactionAnalyzer()
        result = analyzer.analyze_sender(sample_transactions, "0xnonexistent")
        assert result.tx_count == 0
        assert result.total_volume_usd == 0.0

    def test_analyze_all_senders(self, sample_transactions: pd.DataFrame):
        analyzer = TransactionAnalyzer()
        results = analyzer.analyze_all_senders(sample_transactions)
        unique_senders = sample_transactions["sender_address"].nunique()
        assert len(results) == unique_senders

    def test_velocity_check(self, sample_transactions: pd.DataFrame):
        analyzer = TransactionAnalyzer()
        sender = sample_transactions["sender_address"].iloc[0]
        result = analyzer.velocity_check(sample_transactions, sender, window_hours=48)
        assert result["sender"] == sender
        assert result["tx_count"] >= 1
        assert result["total_usd"] > 0

    def test_high_value_transactions(self, sample_transactions: pd.DataFrame):
        analyzer = TransactionAnalyzer()
        hvt = analyzer.high_value_transactions(sample_transactions, threshold=10000)
        assert all(hvt["amount_usd"] >= 10000)

    def test_structuring_detection(self):
        """Multiple just-below-threshold transactions within 24h should trigger."""
        analyzer = TransactionAnalyzer()
        df = pd.DataFrame({
            "sender_address": ["0x" + "a" * 40] * 4,
            "receiver_address": ["0x" + "b" * 40] * 4,
            "amount_usd": [4000, 3000, 2500, 3500],  # sum = 13000 > 10000, each < 10000
            "timestamp": pd.date_range("2025-06-01", periods=4, freq="2h"),
        })
        pattern = analyzer.analyze_sender(df, "0x" + "a" * 40)
        assert pattern.is_structuring_suspect is True

    def test_rapid_burst_count(self):
        """Transactions very close together should be counted as bursts."""
        analyzer = TransactionAnalyzer()
        df = pd.DataFrame({
            "sender_address": ["0x" + "c" * 40] * 3,
            "receiver_address": ["0x" + "d" * 40] * 3,
            "amount_usd": [100, 200, 300],
            "timestamp": pd.to_datetime([
                "2025-06-01 10:00:00",
                "2025-06-01 10:00:30",  # 30 sec gap
                "2025-06-01 10:05:00",  # 4.5 min gap (>60s)
            ]),
        })
        pattern = analyzer.analyze_sender(df, "0x" + "c" * 40)
        assert pattern.rapid_burst_count == 1  # only the first pair is within 60s

    def test_velocity_check_nonexistent_sender(self, sample_transactions: pd.DataFrame):
        """Velocity check for a sender not in the data returns zeros."""
        analyzer = TransactionAnalyzer()
        result = analyzer.velocity_check(sample_transactions, "0xnonexistent")
        assert result["tx_count"] == 0
        assert result["total_usd"] == 0.0

    def test_analyze_sender_with_string_timestamps(self):
        """Ensure _ensure_datetime converts string timestamps correctly."""
        analyzer = TransactionAnalyzer()
        df = pd.DataFrame({
            "sender_address": ["0x" + "a" * 40] * 2,
            "receiver_address": ["0x" + "b" * 40] * 2,
            "amount_usd": [1000, 2000],
            "timestamp": ["2025-06-01 10:00:00", "2025-06-01 12:00:00"],  # strings
        })
        pattern = analyzer.analyze_sender(df, "0x" + "a" * 40)
        assert pattern.tx_count == 2
        assert pattern.total_volume_usd == 3000.0

    def test_no_structuring_when_amounts_above_threshold(self):
        """No structuring if individual amounts are above the CTR threshold."""
        analyzer = TransactionAnalyzer()
        df = pd.DataFrame({
            "sender_address": ["0x" + "a" * 40] * 2,
            "receiver_address": ["0x" + "b" * 40] * 2,
            "amount_usd": [15000, 12000],  # above 10000
            "timestamp": pd.date_range("2025-06-01", periods=2, freq="2h"),
        })
        pattern = analyzer.analyze_sender(df, "0x" + "a" * 40)
        assert pattern.is_structuring_suspect is False

    def test_custom_structuring_window(self):
        """Test with a custom structuring window."""
        analyzer = TransactionAnalyzer(structuring_window_s=3600)  # 1 hour
        assert analyzer.structuring_window_s == 3600

    def test_detect_structuring_empty_df(self):
        """_detect_structuring returns False for an empty DataFrame."""
        analyzer = TransactionAnalyzer()
        empty_df = pd.DataFrame(columns=["sender_address", "receiver_address", "amount_usd", "timestamp"])
        assert analyzer._detect_structuring(empty_df) is False

    def test_single_transaction_no_burst(self):
        """A single transaction should have zero rapid burst count."""
        analyzer = TransactionAnalyzer()
        df = pd.DataFrame({
            "sender_address": ["0x" + "a" * 40],
            "receiver_address": ["0x" + "b" * 40],
            "amount_usd": [5000],
            "timestamp": pd.to_datetime(["2025-06-01 10:00:00"]),
        })
        pattern = analyzer.analyze_sender(df, "0x" + "a" * 40)
        assert pattern.rapid_burst_count == 0
        assert pattern.stddev_amount == 0.0
