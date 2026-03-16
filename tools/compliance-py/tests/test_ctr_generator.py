"""Tests for CTR report generation."""

from __future__ import annotations

import json
import xml.etree.ElementTree as ET

import pandas as pd
import pytest

from noblepay_compliance.reporting.ctr_generator import (
    CTRGenerator,
    CTRPerson,
    CTRReport,
    CTRTransaction,
)


@pytest.fixture()
def ctr_persons() -> list[CTRPerson]:
    return [
        CTRPerson(name="Bob Jones", address="456 Elm St", id_type="DL", id_number="D1234567", role="conductor"),
    ]


@pytest.fixture()
def ctr_transactions() -> list[CTRTransaction]:
    return [
        CTRTransaction(tx_id="tx-100", date="2025-06-15", amount_usd=25000, currency="USD", transaction_type="wire"),
    ]


class TestCTRGenerator:
    def test_identify_reportable(self, sample_transactions: pd.DataFrame):
        gen = CTRGenerator()
        reportable = gen.identify_reportable(sample_transactions)
        assert all(reportable["amount_usd"] >= 10000)

    def test_create_report(self, ctr_persons, ctr_transactions):
        gen = CTRGenerator()
        report = gen.create_report(persons=ctr_persons, transactions=ctr_transactions)
        assert isinstance(report, CTRReport)
        assert report.total_amount_usd == 25000.0

    def test_to_json(self, ctr_persons, ctr_transactions):
        gen = CTRGenerator()
        report = gen.create_report(persons=ctr_persons, transactions=ctr_transactions)
        json_str = gen.to_json(report)
        parsed = json.loads(json_str)
        assert parsed["total_amount_usd"] == 25000.0

    def test_to_xml(self, ctr_persons, ctr_transactions):
        gen = CTRGenerator()
        report = gen.create_report(persons=ctr_persons, transactions=ctr_transactions)
        xml_str = gen.to_xml(report)
        assert "<?xml" in xml_str
        assert "<CTRReport" in xml_str

    def test_to_dict(self, ctr_persons, ctr_transactions):
        gen = CTRGenerator()
        report = gen.create_report(persons=ctr_persons, transactions=ctr_transactions)
        d = gen.to_dict(report)
        assert isinstance(d, dict)
        assert d["total_amount_usd"] == 25000.0

    def test_create_report_empty_transactions(self, ctr_persons):
        """When transactions list is empty, transaction_date should fall back to now_str."""
        gen = CTRGenerator()
        report = gen.create_report(persons=ctr_persons, transactions=[])
        assert isinstance(report, CTRReport)
        assert report.total_amount_usd == 0.0
        assert report.transaction_date != ""  # Should be set to now_str

    def test_create_report_with_explicit_date(self, ctr_persons, ctr_transactions):
        gen = CTRGenerator()
        report = gen.create_report(
            persons=ctr_persons,
            transactions=ctr_transactions,
            transaction_date="2025-07-01",
        )
        assert report.transaction_date == "2025-07-01"

    def test_custom_filing_institution(self):
        gen = CTRGenerator(filing_institution="Custom Bank")
        persons = [CTRPerson(name="Test Person")]
        txns = [CTRTransaction(tx_id="tx-1", date="2025-06-01", amount_usd=15000)]
        report = gen.create_report(persons=persons, transactions=txns)
        assert report.filing_institution == "Custom Bank"
