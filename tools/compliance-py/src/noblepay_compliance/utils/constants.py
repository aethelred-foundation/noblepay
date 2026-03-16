"""Jurisdiction codes, risk thresholds, and compliance constants."""

from __future__ import annotations

# ---------------------------------------------------------------------------
# Risk thresholds
# ---------------------------------------------------------------------------

HIGH_RISK_THRESHOLD: float = 0.75
MEDIUM_RISK_THRESHOLD: float = 0.40
LOW_RISK_THRESHOLD: float = 0.0

# CTR filing threshold (USD)
CTR_THRESHOLD_USD: float = 10_000.00

# Structuring detection window (seconds) and aggregation threshold
STRUCTURING_WINDOW_SECONDS: int = 86_400  # 24 hours
STRUCTURING_AGGREGATE_THRESHOLD_USD: float = 10_000.00

# ---------------------------------------------------------------------------
# Jurisdiction / country risk tiers
# ---------------------------------------------------------------------------

HIGH_RISK_JURISDICTIONS: frozenset[str] = frozenset({
    "AF",  # Afghanistan
    "BY",  # Belarus
    "MM",  # Myanmar
    "CF",  # Central African Republic
    "CU",  # Cuba
    "CD",  # DR Congo
    "IR",  # Iran
    "IQ",  # Iraq
    "LB",  # Lebanon
    "LY",  # Libya
    "ML",  # Mali
    "NI",  # Nicaragua
    "KP",  # North Korea
    "RU",  # Russia
    "SO",  # Somalia
    "SS",  # South Sudan
    "SD",  # Sudan
    "SY",  # Syria
    "VE",  # Venezuela
    "YE",  # Yemen
    "ZW",  # Zimbabwe
})

MEDIUM_RISK_JURISDICTIONS: frozenset[str] = frozenset({
    "AL",  # Albania
    "BA",  # Bosnia
    "KH",  # Cambodia
    "GH",  # Ghana
    "HT",  # Haiti
    "JM",  # Jamaica
    "JO",  # Jordan
    "KE",  # Kenya
    "LA",  # Laos
    "MZ",  # Mozambique
    "NG",  # Nigeria
    "PK",  # Pakistan
    "PA",  # Panama
    "PH",  # Philippines
    "SN",  # Senegal
    "TZ",  # Tanzania
    "UG",  # Uganda
    "VN",  # Vietnam
})

# ---------------------------------------------------------------------------
# Sanctions fuzzy-match threshold (0–100 scale used by rapidfuzz)
# ---------------------------------------------------------------------------

SANCTIONS_MATCH_THRESHOLD: int = 85

# ---------------------------------------------------------------------------
# Supported fiat currency codes
# ---------------------------------------------------------------------------

SUPPORTED_CURRENCIES: frozenset[str] = frozenset({
    "USD", "EUR", "GBP", "CHF", "JPY", "CAD", "AUD", "SGD",
    "AED", "SAR", "HKD", "MXN", "BRL", "INR", "ZAR", "NGN",
})

# ---------------------------------------------------------------------------
# Risk feature column names (used by ML models)
# ---------------------------------------------------------------------------

RISK_FEATURE_COLUMNS: list[str] = [
    "amount_usd",
    "sender_risk_score",
    "receiver_risk_score",
    "sender_jurisdiction_risk",
    "receiver_jurisdiction_risk",
    "is_new_sender",
    "is_new_receiver",
    "sender_tx_count_24h",
    "receiver_tx_count_24h",
    "amount_deviation_from_mean",
    "hour_of_day",
    "is_weekend",
]
