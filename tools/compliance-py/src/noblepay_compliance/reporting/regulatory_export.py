"""Export compliance data to regulatory formats (XML / JSON)."""

from __future__ import annotations

import json
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pandas as pd


@dataclass
class ExportMetadata:
    """Metadata attached to every regulatory export."""

    institution_name: str
    export_date: str
    report_type: str  # "SAR", "CTR", "TRANSACTION_LOG", "RISK_SUMMARY"
    record_count: int
    format: str  # "json" or "xml"


class RegulatoryExporter:
    """Export pandas DataFrames and report dicts to regulatory XML / JSON files."""

    def __init__(self, institution_name: str = "NoblePay Inc.") -> None:
        self.institution_name = institution_name

    # ------------------------------------------------------------------
    # JSON export
    # ------------------------------------------------------------------

    def to_json(
        self,
        data: pd.DataFrame | list[dict[str, Any]] | dict[str, Any],
        report_type: str = "TRANSACTION_LOG",
    ) -> str:
        """Serialise *data* to a regulatory JSON string with metadata wrapper."""
        records = self._to_records(data)
        payload = {
            "metadata": {
                "institution_name": self.institution_name,
                "export_date": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "report_type": report_type,
                "record_count": len(records) if isinstance(records, list) else 1,
                "format": "json",
            },
            "data": records,
        }
        return json.dumps(payload, indent=2, default=str)

    def export_json(
        self,
        data: pd.DataFrame | list[dict[str, Any]] | dict[str, Any],
        path: str | Path,
        report_type: str = "TRANSACTION_LOG",
    ) -> ExportMetadata:
        """Write JSON export to *path* and return metadata."""
        content = self.to_json(data, report_type)
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        records = self._to_records(data)
        return ExportMetadata(
            institution_name=self.institution_name,
            export_date=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            report_type=report_type,
            record_count=len(records) if isinstance(records, list) else 1,
            format="json",
        )

    # ------------------------------------------------------------------
    # XML export
    # ------------------------------------------------------------------

    def to_xml(
        self,
        data: pd.DataFrame | list[dict[str, Any]] | dict[str, Any],
        report_type: str = "TRANSACTION_LOG",
    ) -> str:
        """Serialise *data* to a regulatory XML string with metadata wrapper."""
        records = self._to_records(data)
        if not isinstance(records, list):
            records = [records]

        root = ET.Element("RegulatoryExport")
        meta = ET.SubElement(root, "Metadata")
        self._add(meta, "InstitutionName", self.institution_name)
        self._add(meta, "ExportDate", datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))
        self._add(meta, "ReportType", report_type)
        self._add(meta, "RecordCount", str(len(records)))
        self._add(meta, "Format", "xml")

        data_el = ET.SubElement(root, "Data")
        for rec in records:
            rec_el = ET.SubElement(data_el, "Record")
            for key, value in rec.items():
                self._add(rec_el, str(key), str(value))

        ET.indent(root, space="  ")
        return ET.tostring(root, encoding="unicode", xml_declaration=True)

    def export_xml(
        self,
        data: pd.DataFrame | list[dict[str, Any]] | dict[str, Any],
        path: str | Path,
        report_type: str = "TRANSACTION_LOG",
    ) -> ExportMetadata:
        """Write XML export to *path* and return metadata."""
        content = self.to_xml(data, report_type)
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        records = self._to_records(data)
        if not isinstance(records, list):
            records = [records]
        return ExportMetadata(
            institution_name=self.institution_name,
            export_date=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            report_type=report_type,
            record_count=len(records),
            format="xml",
        )

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _to_records(data: pd.DataFrame | list[dict[str, Any]] | dict[str, Any]) -> list[dict[str, Any]] | dict[str, Any]:
        if isinstance(data, pd.DataFrame):
            return data.to_dict(orient="records")
        return data

    @staticmethod
    def _add(parent: ET.Element, tag: str, text: str) -> ET.Element:
        el = ET.SubElement(parent, tag)
        el.text = text
        return el
