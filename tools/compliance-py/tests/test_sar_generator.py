"""Tests for SAR report generation."""

from __future__ import annotations

import json
import xml.etree.ElementTree as ET

import pytest

from noblepay_compliance.reporting.sar_generator import (
    SARGenerator,
    SARReport,
    SARSubject,
    SARTransaction,
)


@pytest.fixture()
def sar_subjects() -> list[SARSubject]:
    return [
        SARSubject(name="Jane Smith", address="123 Main St", id_type="SSN", id_number="xxx-xx-1234", role="subject"),
    ]


@pytest.fixture()
def sar_transactions() -> list[SARTransaction]:
    return [
        SARTransaction(tx_id="tx-001", date="2025-06-01", amount_usd=9500, sender="0xabc", receiver="0xdef"),
        SARTransaction(tx_id="tx-002", date="2025-06-01", amount_usd=9800, sender="0xabc", receiver="0xghi"),
    ]


class TestSARGenerator:
    def test_create_report(self, sar_subjects, sar_transactions):
        gen = SARGenerator()
        report = gen.create_report(
            subjects=sar_subjects,
            transactions=sar_transactions,
            narrative="Multiple just-below-threshold transactions detected.",
            suspicious_activity_types=["structuring"],
        )
        assert isinstance(report, SARReport)
        assert report.total_amount_usd == 19300.0
        assert report.report_id
        assert report.bsa_id.startswith("SAR-")

    def test_to_json(self, sar_subjects, sar_transactions):
        gen = SARGenerator()
        report = gen.create_report(
            subjects=sar_subjects,
            transactions=sar_transactions,
            narrative="Test narrative",
        )
        json_str = gen.to_json(report)
        parsed = json.loads(json_str)
        assert parsed["total_amount_usd"] == 19300.0
        assert len(parsed["subjects"]) == 1
        assert len(parsed["transactions"]) == 2

    def test_to_xml(self, sar_subjects, sar_transactions):
        gen = SARGenerator()
        report = gen.create_report(
            subjects=sar_subjects,
            transactions=sar_transactions,
            narrative="XML test",
            suspicious_activity_types=["structuring", "layering"],
        )
        xml_str = gen.to_xml(report)
        assert "<?xml" in xml_str
        assert "<SARReport" in xml_str
        root = ET.fromstring(xml_str)
        # Check namespace
        assert "fincen" in root.tag or root.tag == "SARReport" or "sar" in root.attrib.get("xmlns", "")

    def test_to_dict(self, sar_subjects, sar_transactions):
        gen = SARGenerator()
        report = gen.create_report(
            subjects=sar_subjects,
            transactions=sar_transactions,
            narrative="Dict test",
        )
        d = gen.to_dict(report)
        assert isinstance(d, dict)
        assert d["total_amount_usd"] == 19300.0

    def test_create_report_empty_transactions(self, sar_subjects):
        """When transactions list is empty, dates should fall back to now_str."""
        gen = SARGenerator()
        report = gen.create_report(
            subjects=sar_subjects,
            transactions=[],
            narrative="Empty txn test",
        )
        assert isinstance(report, SARReport)
        assert report.total_amount_usd == 0.0
        assert report.activity_start_date != ""
        assert report.activity_end_date != ""

    def test_create_report_with_explicit_dates(self, sar_subjects, sar_transactions):
        gen = SARGenerator()
        report = gen.create_report(
            subjects=sar_subjects,
            transactions=sar_transactions,
            narrative="Explicit dates test",
            activity_start_date="2025-01-01",
            activity_end_date="2025-06-30",
        )
        assert report.activity_start_date == "2025-01-01"
        assert report.activity_end_date == "2025-06-30"

    def test_custom_filing_institution(self):
        gen = SARGenerator(filing_institution="Custom Bank")
        report = gen.create_report(
            subjects=[SARSubject(name="Test")],
            transactions=[],
            narrative="Test",
        )
        assert report.filing_institution == "Custom Bank"
