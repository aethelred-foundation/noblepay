"""Tests for regulatory export (JSON / XML)."""

from __future__ import annotations

import json
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path

import pandas as pd
import pytest

from noblepay_compliance.reporting.regulatory_export import ExportMetadata, RegulatoryExporter


class TestRegulatoryExporter:
    def test_to_json_from_dataframe(self, sample_transactions: pd.DataFrame):
        exporter = RegulatoryExporter()
        json_str = exporter.to_json(sample_transactions, report_type="TRANSACTION_LOG")
        parsed = json.loads(json_str)
        assert parsed["metadata"]["report_type"] == "TRANSACTION_LOG"
        assert parsed["metadata"]["record_count"] == len(sample_transactions)
        assert isinstance(parsed["data"], list)

    def test_to_json_from_dict(self):
        exporter = RegulatoryExporter()
        data = {"key": "value", "count": 42}
        json_str = exporter.to_json(data, report_type="RISK_SUMMARY")
        parsed = json.loads(json_str)
        assert parsed["metadata"]["report_type"] == "RISK_SUMMARY"

    def test_to_xml_from_dataframe(self, sample_transactions: pd.DataFrame):
        exporter = RegulatoryExporter()
        xml_str = exporter.to_xml(sample_transactions, report_type="TRANSACTION_LOG")
        assert "<?xml" in xml_str
        root = ET.fromstring(xml_str)
        assert root.tag == "RegulatoryExport"

    def test_export_json_to_file(self, sample_transactions: pd.DataFrame):
        exporter = RegulatoryExporter()
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "export.json"
            meta = exporter.export_json(sample_transactions, path)
            assert isinstance(meta, ExportMetadata)
            assert meta.format == "json"
            assert path.exists()
            content = json.loads(path.read_text())
            assert content["metadata"]["record_count"] == len(sample_transactions)

    def test_export_xml_to_file(self, sample_transactions: pd.DataFrame):
        exporter = RegulatoryExporter()
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "export.xml"
            meta = exporter.export_xml(sample_transactions, path)
            assert isinstance(meta, ExportMetadata)
            assert meta.format == "xml"
            assert path.exists()

    def test_to_json_from_list_of_dicts(self):
        exporter = RegulatoryExporter()
        data = [{"a": 1}, {"a": 2}]
        json_str = exporter.to_json(data, report_type="CTR")
        parsed = json.loads(json_str)
        assert parsed["metadata"]["record_count"] == 2

    def test_to_xml_from_dict(self):
        """Single dict (not a list) should be wrapped in a list for XML export."""
        exporter = RegulatoryExporter()
        data = {"key": "value", "count": 42}
        xml_str = exporter.to_xml(data, report_type="RISK_SUMMARY")
        assert "<?xml" in xml_str
        root = ET.fromstring(xml_str)
        assert root.tag == "RegulatoryExport"
        # Should contain exactly 1 Record element
        data_el = root.find("Data")
        records = data_el.findall("Record")
        assert len(records) == 1

    def test_export_xml_from_dict(self):
        """export_xml with a single dict should handle the not-isinstance-list branch."""
        exporter = RegulatoryExporter()
        data = {"metric": "risk_score", "value": 0.85}
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "export_dict.xml"
            meta = exporter.export_xml(data, path, report_type="RISK_SUMMARY")
            assert isinstance(meta, ExportMetadata)
            assert meta.format == "xml"
            assert meta.record_count == 1
            assert path.exists()

    def test_export_json_from_dict(self):
        """export_json with a single dict."""
        exporter = RegulatoryExporter()
        data = {"summary": "test"}
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "export_dict.json"
            meta = exporter.export_json(data, path, report_type="RISK_SUMMARY")
            assert isinstance(meta, ExportMetadata)
            assert meta.format == "json"
            assert meta.record_count == 1

    def test_to_json_from_dict_record_count(self):
        """A single dict should have record_count=1 in metadata."""
        exporter = RegulatoryExporter()
        data = {"key": "value"}
        json_str = exporter.to_json(data, report_type="RISK_SUMMARY")
        parsed = json.loads(json_str)
        assert parsed["metadata"]["record_count"] == 1

    def test_custom_institution_name(self):
        exporter = RegulatoryExporter(institution_name="Custom Bank")
        data = [{"a": 1}]
        json_str = exporter.to_json(data)
        parsed = json.loads(json_str)
        assert parsed["metadata"]["institution_name"] == "Custom Bank"
