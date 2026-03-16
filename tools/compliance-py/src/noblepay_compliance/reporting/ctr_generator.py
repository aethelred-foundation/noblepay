"""Currency Transaction Report (CTR) generation following FinCEN format."""

from __future__ import annotations

import uuid
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from typing import Any

import pandas as pd
from pydantic import BaseModel

from noblepay_compliance.utils.constants import CTR_THRESHOLD_USD


class CTRPerson(BaseModel):
    """Person conducting or benefiting from the transaction."""

    name: str
    address: str = ""
    id_type: str = ""
    id_number: str = ""
    account_number: str = ""
    role: str = "conductor"  # "conductor" or "beneficiary"


class CTRTransaction(BaseModel):
    """Single currency transaction above the reporting threshold."""

    tx_id: str
    date: str
    amount_usd: float
    currency: str = "USD"
    transaction_type: str = "wire"  # "wire", "deposit", "withdrawal"


class CTRReport(BaseModel):
    """Complete Currency Transaction Report."""

    report_id: str = ""
    filing_institution: str = ""
    filing_date: str = ""
    transaction_date: str = ""
    total_amount_usd: float = 0.0
    persons: list[CTRPerson] = []
    transactions: list[CTRTransaction] = []


class CTRGenerator:
    """Generate FinCEN-style Currency Transaction Reports.

    A CTR is required for currency transactions exceeding $10,000.
    """

    def __init__(self, filing_institution: str = "NoblePay Inc.") -> None:
        self.filing_institution = filing_institution

    def identify_reportable(self, df: pd.DataFrame, amount_col: str = "amount_usd") -> pd.DataFrame:
        """Filter a transaction DataFrame to only CTR-eligible rows (>= threshold)."""
        return df[df[amount_col] >= CTR_THRESHOLD_USD].copy()

    def create_report(
        self,
        persons: list[CTRPerson],
        transactions: list[CTRTransaction],
        transaction_date: str = "",
    ) -> CTRReport:
        """Build a ``CTRReport`` from persons and transactions."""
        total = sum(t.amount_usd for t in transactions)
        now_str = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

        return CTRReport(
            report_id=str(uuid.uuid4()),
            filing_institution=self.filing_institution,
            filing_date=now_str,
            transaction_date=transaction_date or (transactions[0].date if transactions else now_str),
            total_amount_usd=total,
            persons=persons,
            transactions=transactions,
        )

    # ------------------------------------------------------------------
    # Serialisation
    # ------------------------------------------------------------------

    def to_json(self, report: CTRReport) -> str:
        return report.model_dump_json(indent=2)

    def to_dict(self, report: CTRReport) -> dict[str, Any]:
        return report.model_dump()

    def to_xml(self, report: CTRReport) -> str:
        root = ET.Element("CTRReport", xmlns="urn:fincen:ctr")
        self._add(root, "ReportID", report.report_id)
        self._add(root, "FilingInstitution", report.filing_institution)
        self._add(root, "FilingDate", report.filing_date)
        self._add(root, "TransactionDate", report.transaction_date)
        self._add(root, "TotalAmountUSD", f"{report.total_amount_usd:.2f}")

        persons_el = ET.SubElement(root, "Persons")
        for p in report.persons:
            p_el = ET.SubElement(persons_el, "Person")
            self._add(p_el, "Name", p.name)
            self._add(p_el, "Address", p.address)
            self._add(p_el, "IDType", p.id_type)
            self._add(p_el, "IDNumber", p.id_number)
            self._add(p_el, "AccountNumber", p.account_number)
            self._add(p_el, "Role", p.role)

        txns_el = ET.SubElement(root, "Transactions")
        for t in report.transactions:
            t_el = ET.SubElement(txns_el, "Transaction")
            self._add(t_el, "TxID", t.tx_id)
            self._add(t_el, "Date", t.date)
            self._add(t_el, "AmountUSD", f"{t.amount_usd:.2f}")
            self._add(t_el, "Currency", t.currency)
            self._add(t_el, "TransactionType", t.transaction_type)

        ET.indent(root, space="  ")
        return ET.tostring(root, encoding="unicode", xml_declaration=True)

    @staticmethod
    def _add(parent: ET.Element, tag: str, text: str) -> ET.Element:
        el = ET.SubElement(parent, tag)
        el.text = text
        return el
