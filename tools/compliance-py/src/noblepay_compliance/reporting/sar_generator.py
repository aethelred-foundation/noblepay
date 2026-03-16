"""Suspicious Activity Report (SAR) generation following FinCEN format."""

from __future__ import annotations

import json
import uuid
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from pydantic import BaseModel


class SARSubject(BaseModel):
    """Subject (person or entity) involved in suspicious activity."""

    name: str
    address: str = ""
    id_type: str = ""  # e.g. "SSN", "EIN", "PASSPORT"
    id_number: str = ""
    account_number: str = ""
    role: str = "subject"  # "subject" or "beneficiary"


class SARTransaction(BaseModel):
    """A transaction referenced in the SAR."""

    tx_id: str
    date: str  # ISO-8601
    amount_usd: float
    sender: str
    receiver: str
    description: str = ""


class SARReport(BaseModel):
    """Complete Suspicious Activity Report."""

    report_id: str = ""
    bsa_id: str = ""
    filing_institution: str = ""
    filing_date: str = ""
    activity_start_date: str = ""
    activity_end_date: str = ""
    total_amount_usd: float = 0.0
    narrative: str = ""
    suspicious_activity_types: list[str] = field(default_factory=list)
    subjects: list[SARSubject] = field(default_factory=list)
    transactions: list[SARTransaction] = field(default_factory=list)

    class Config:
        arbitrary_types_allowed = True


class SARGenerator:
    """Generate FinCEN-style Suspicious Activity Reports.

    Usage::

        gen = SARGenerator(filing_institution="NoblePay Inc.")
        report = gen.create_report(
            subjects=[...],
            transactions=[...],
            narrative="...",
            suspicious_activity_types=["structuring"],
        )
        xml_str = gen.to_xml(report)
        json_str = gen.to_json(report)
    """

    def __init__(self, filing_institution: str = "NoblePay Inc.") -> None:
        self.filing_institution = filing_institution

    def create_report(
        self,
        subjects: list[SARSubject],
        transactions: list[SARTransaction],
        narrative: str,
        suspicious_activity_types: list[str] | None = None,
        activity_start_date: str = "",
        activity_end_date: str = "",
    ) -> SARReport:
        """Build a ``SARReport`` with auto-generated IDs and totals."""
        total = sum(t.amount_usd for t in transactions)
        now_str = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

        return SARReport(
            report_id=str(uuid.uuid4()),
            bsa_id=f"SAR-{uuid.uuid4().hex[:12].upper()}",
            filing_institution=self.filing_institution,
            filing_date=now_str,
            activity_start_date=activity_start_date or (transactions[0].date if transactions else now_str),
            activity_end_date=activity_end_date or (transactions[-1].date if transactions else now_str),
            total_amount_usd=total,
            narrative=narrative,
            suspicious_activity_types=suspicious_activity_types or [],
            subjects=subjects,
            transactions=transactions,
        )

    # ------------------------------------------------------------------
    # Serialisation
    # ------------------------------------------------------------------

    def to_json(self, report: SARReport) -> str:
        """Serialise to JSON string."""
        return report.model_dump_json(indent=2)

    def to_dict(self, report: SARReport) -> dict[str, Any]:
        """Serialise to plain dict."""
        return report.model_dump()

    def to_xml(self, report: SARReport) -> str:
        """Serialise to FinCEN-style XML."""
        root = ET.Element("SARReport", xmlns="urn:fincen:sar")
        self._add_el(root, "ReportID", report.report_id)
        self._add_el(root, "BSAID", report.bsa_id)
        self._add_el(root, "FilingInstitution", report.filing_institution)
        self._add_el(root, "FilingDate", report.filing_date)
        self._add_el(root, "ActivityStartDate", report.activity_start_date)
        self._add_el(root, "ActivityEndDate", report.activity_end_date)
        self._add_el(root, "TotalAmountUSD", f"{report.total_amount_usd:.2f}")
        self._add_el(root, "Narrative", report.narrative)

        types_el = ET.SubElement(root, "SuspiciousActivityTypes")
        for sat in report.suspicious_activity_types:
            self._add_el(types_el, "Type", sat)

        subjects_el = ET.SubElement(root, "Subjects")
        for s in report.subjects:
            s_el = ET.SubElement(subjects_el, "Subject")
            self._add_el(s_el, "Name", s.name)
            self._add_el(s_el, "Address", s.address)
            self._add_el(s_el, "IDType", s.id_type)
            self._add_el(s_el, "IDNumber", s.id_number)
            self._add_el(s_el, "AccountNumber", s.account_number)
            self._add_el(s_el, "Role", s.role)

        txns_el = ET.SubElement(root, "Transactions")
        for t in report.transactions:
            t_el = ET.SubElement(txns_el, "Transaction")
            self._add_el(t_el, "TxID", t.tx_id)
            self._add_el(t_el, "Date", t.date)
            self._add_el(t_el, "AmountUSD", f"{t.amount_usd:.2f}")
            self._add_el(t_el, "Sender", t.sender)
            self._add_el(t_el, "Receiver", t.receiver)
            self._add_el(t_el, "Description", t.description)

        ET.indent(root, space="  ")
        return ET.tostring(root, encoding="unicode", xml_declaration=True)

    @staticmethod
    def _add_el(parent: ET.Element, tag: str, text: str) -> ET.Element:
        el = ET.SubElement(parent, tag)
        el.text = text
        return el
