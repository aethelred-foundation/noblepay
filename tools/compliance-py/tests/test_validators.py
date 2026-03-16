"""Tests for input validators."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from noblepay_compliance.utils.validators import (
    TransactionInput,
    is_positive_amount,
    is_valid_address,
    is_valid_cosmos_address,
    is_valid_currency,
    is_valid_eth_address,
    is_valid_iso_date,
)


class TestEthAddress:
    def test_valid(self):
        assert is_valid_eth_address("0x" + "a" * 40) is True

    def test_too_short(self):
        assert is_valid_eth_address("0x" + "a" * 39) is False

    def test_missing_prefix(self):
        assert is_valid_eth_address("a" * 40) is False

    def test_invalid_chars(self):
        assert is_valid_eth_address("0x" + "g" * 40) is False


class TestCosmosAddress:
    def test_valid(self):
        assert is_valid_cosmos_address("cosmos1" + "a" * 38) is True

    def test_invalid(self):
        assert is_valid_cosmos_address("invalid") is False


class TestIsValidAddress:
    def test_eth(self):
        assert is_valid_address("0x" + "0" * 40) is True

    def test_cosmos(self):
        assert is_valid_address("noble1" + "a" * 38) is True

    def test_garbage(self):
        assert is_valid_address("not-an-address") is False


class TestCurrency:
    def test_valid(self):
        assert is_valid_currency("USD") is True
        assert is_valid_currency("eur") is True

    def test_invalid(self):
        assert is_valid_currency("XYZ") is False


class TestPositiveAmount:
    def test_valid(self):
        assert is_positive_amount(100) is True
        assert is_positive_amount(0.01) is True

    def test_zero(self):
        assert is_positive_amount(0) is False

    def test_negative(self):
        assert is_positive_amount(-1) is False

    def test_nan(self):
        assert is_positive_amount(float("nan")) is False


class TestISODate:
    def test_date(self):
        assert is_valid_iso_date("2025-06-01") is True

    def test_datetime(self):
        assert is_valid_iso_date("2025-06-01T12:00:00Z") is True

    def test_invalid(self):
        assert is_valid_iso_date("06/01/2025") is False


class TestTransactionInput:
    def test_valid(self):
        tx = TransactionInput(
            tx_id="tx-001",
            sender_address="0x" + "a" * 40,
            receiver_address="0x" + "b" * 40,
            amount=1000.0,
            currency="usd",
            timestamp="2025-06-01T10:00:00Z",
        )
        assert tx.currency == "USD"

    def test_invalid_address(self):
        with pytest.raises(ValidationError):
            TransactionInput(
                tx_id="tx-001",
                sender_address="bad-address",
                receiver_address="0x" + "b" * 40,
                amount=1000.0,
                currency="USD",
                timestamp="2025-06-01",
            )

    def test_invalid_amount(self):
        with pytest.raises(ValidationError):
            TransactionInput(
                tx_id="tx-001",
                sender_address="0x" + "a" * 40,
                receiver_address="0x" + "b" * 40,
                amount=-100.0,
                currency="USD",
                timestamp="2025-06-01",
            )

    def test_invalid_currency(self):
        with pytest.raises(ValidationError):
            TransactionInput(
                tx_id="tx-001",
                sender_address="0x" + "a" * 40,
                receiver_address="0x" + "b" * 40,
                amount=100.0,
                currency="FAKE",
                timestamp="2025-06-01",
            )

    def test_invalid_timestamp(self):
        with pytest.raises(ValidationError):
            TransactionInput(
                tx_id="tx-001",
                sender_address="0x" + "a" * 40,
                receiver_address="0x" + "b" * 40,
                amount=100.0,
                currency="USD",
                timestamp="not-a-date",
            )

    def test_valid_with_timezone_offset(self):
        tx = TransactionInput(
            tx_id="tx-002",
            sender_address="0x" + "a" * 40,
            receiver_address="0x" + "b" * 40,
            amount=500.0,
            currency="EUR",
            timestamp="2025-06-01T10:00:00+05:30",
        )
        assert tx.timestamp == "2025-06-01T10:00:00+05:30"

    def test_valid_with_fractional_seconds(self):
        tx = TransactionInput(
            tx_id="tx-003",
            sender_address="0x" + "a" * 40,
            receiver_address="0x" + "b" * 40,
            amount=250.0,
            currency="GBP",
            timestamp="2025-06-01T10:00:00.123Z",
        )
        assert tx.timestamp == "2025-06-01T10:00:00.123Z"
