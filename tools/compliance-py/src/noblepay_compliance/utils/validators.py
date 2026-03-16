"""Input validation helpers for addresses, amounts, and identifiers."""

from __future__ import annotations

import re
from typing import Any

from pydantic import BaseModel, field_validator, model_validator

from noblepay_compliance.utils.constants import SUPPORTED_CURRENCIES

# ---------------------------------------------------------------------------
# Regex patterns
# ---------------------------------------------------------------------------

_ETH_ADDRESS_RE = re.compile(r"^0x[0-9a-fA-F]{40}$")
_COSMOS_ADDRESS_RE = re.compile(r"^[a-z]{1,10}1[a-z0-9]{38,58}$")
_ISO_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?)?$")


# ---------------------------------------------------------------------------
# Pure helpers
# ---------------------------------------------------------------------------


def is_valid_eth_address(address: str) -> bool:
    """Return True if *address* looks like a valid Ethereum / EVM hex address."""
    return bool(_ETH_ADDRESS_RE.match(address))


def is_valid_cosmos_address(address: str) -> bool:
    """Return True if *address* looks like a valid Bech32 Cosmos address."""
    return bool(_COSMOS_ADDRESS_RE.match(address))


def is_valid_address(address: str) -> bool:
    """Return True if *address* is either an EVM or Cosmos address."""
    return is_valid_eth_address(address) or is_valid_cosmos_address(address)


def is_valid_currency(code: str) -> bool:
    """Return True if *code* is a supported fiat currency."""
    return code.upper() in SUPPORTED_CURRENCIES


def is_positive_amount(amount: float | int) -> bool:
    """Return True if *amount* is a positive finite number."""
    return isinstance(amount, (int, float)) and amount > 0 and amount == amount  # NaN check


def is_valid_iso_date(value: str) -> bool:
    """Return True if *value* matches ISO-8601 date / datetime format."""
    return bool(_ISO_DATE_RE.match(value))


# ---------------------------------------------------------------------------
# Pydantic model for transaction validation
# ---------------------------------------------------------------------------


class TransactionInput(BaseModel):
    """Validated transaction input."""

    tx_id: str
    sender_address: str
    receiver_address: str
    amount: float
    currency: str
    timestamp: str
    sender_jurisdiction: str = ""
    receiver_jurisdiction: str = ""

    @field_validator("sender_address", "receiver_address")
    @classmethod
    def _check_address(cls, v: str) -> str:
        if not is_valid_address(v):
            raise ValueError(f"Invalid blockchain address: {v}")
        return v

    @field_validator("amount")
    @classmethod
    def _check_amount(cls, v: float) -> float:
        if not is_positive_amount(v):
            raise ValueError(f"Amount must be a positive number, got {v}")
        return v

    @field_validator("currency")
    @classmethod
    def _check_currency(cls, v: str) -> str:
        upper = v.upper()
        if upper not in SUPPORTED_CURRENCIES:
            raise ValueError(f"Unsupported currency: {v}")
        return upper

    @field_validator("timestamp")
    @classmethod
    def _check_timestamp(cls, v: str) -> str:
        if not is_valid_iso_date(v):
            raise ValueError(f"Invalid ISO-8601 timestamp: {v}")
        return v
