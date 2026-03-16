//! Core domain types for the NoblePay compliance engine.
//!
//! Every struct in this module derives [`serde::Serialize`] and [`serde::Deserialize`]
//! so that it can be passed over the Axum HTTP boundary or persisted to audit logs.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

// ---------------------------------------------------------------------------
// Payment
// ---------------------------------------------------------------------------

/// A payment to be screened by the compliance engine.
///
/// The engine never stores raw PII — `purpose_hash` is a SHA-3 commitment to the
/// payment purpose description, and `metadata` carries opaque key-value pairs that
/// the caller can use for correlation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Payment {
    /// Unique identifier for this payment, generated client-side.
    pub id: Uuid,
    /// Originator entity name or wallet address.
    pub sender: String,
    /// Beneficiary entity name or wallet address.
    pub recipient: String,
    /// Payment amount in the smallest unit of the currency (e.g. cents, satoshis).
    pub amount: u64,
    /// ISO 4217 currency code or ticker symbol (e.g. "USD", "AED", "USDC").
    pub currency: String,
    /// SHA-3-256 hash of the stated payment purpose, hex-encoded.
    pub purpose_hash: Option<String>,
    /// Arbitrary key-value metadata for caller-side correlation.
    pub metadata: std::collections::HashMap<String, String>,
    /// When the payment was initiated.
    #[serde(default = "Utc::now")]
    pub timestamp: DateTime<Utc>,
}

impl Payment {
    /// Create a minimal payment for testing.
    #[cfg(test)]
    pub fn test_payment(sender: &str, recipient: &str, amount: u64, currency: &str) -> Self {
        Self {
            id: Uuid::new_v4(),
            sender: sender.to_string(),
            recipient: recipient.to_string(),
            amount,
            currency: currency.to_string(),
            purpose_hash: None,
            metadata: std::collections::HashMap::new(),
            timestamp: Utc::now(),
        }
    }
}

// ---------------------------------------------------------------------------
// ComplianceResult
// ---------------------------------------------------------------------------

/// The outcome of a full compliance screening pipeline for a single payment.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ComplianceResult {
    /// Unique identifier linking back to the screened [`Payment`].
    pub payment_id: Uuid,
    /// Whether the entity cleared all sanctions lists.
    pub sanctions_clear: bool,
    /// Composite AML risk score in the range `[0, 100]`.
    pub aml_risk_score: u8,
    /// Whether FATF Travel Rule requirements are satisfied.
    pub travel_rule_compliant: bool,
    /// Overall disposition.
    pub status: ComplianceStatus,
    /// Cryptographic attestation from the TEE proving the result was computed
    /// inside a genuine enclave.
    #[serde(with = "hex_bytes")]
    pub attestation: Vec<u8>,
    /// Wall-clock duration of the screening pipeline in milliseconds.
    pub screening_duration_ms: u64,
    /// Individual risk factors that contributed to the AML score.
    pub risk_factors: Vec<RiskFactor>,
    /// When the screening was completed.
    pub screened_at: DateTime<Utc>,
}

// ---------------------------------------------------------------------------
// Sanctions types
// ---------------------------------------------------------------------------

/// A single entry on a sanctions list.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SanctionsEntry {
    /// Primary entity name as published by the listing authority.
    pub entity_name: String,
    /// Classification of the entity.
    pub entity_type: EntityType,
    /// Which sanctions list this entry originates from.
    pub list_source: SanctionsList,
    /// Known aliases and transliterations.
    pub aliases: Vec<String>,
    /// Associated wallet addresses, postal addresses, or IPs.
    pub addresses: Vec<String>,
    /// National ID numbers, passport numbers, or registration numbers.
    pub id_numbers: Vec<String>,
}

/// The type of sanctioned entity.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub enum EntityType {
    Individual,
    Organization,
    Vessel,
    Aircraft,
    Unknown,
}

/// Supported sanctions lists.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub enum SanctionsList {
    /// U.S. Office of Foreign Assets Control — SDN list.
    Ofac,
    /// UAE Central Bank sanctions list.
    UaeCentralBank,
    /// United Nations Security Council consolidated list.
    UnitedNations,
    /// European Union consolidated sanctions list.
    EuropeanUnion,
}

impl std::fmt::Display for SanctionsList {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Ofac => write!(f, "OFAC"),
            Self::UaeCentralBank => write!(f, "UAE Central Bank"),
            Self::UnitedNations => write!(f, "UN"),
            Self::EuropeanUnion => write!(f, "EU"),
        }
    }
}

/// Result of checking a single entity against the sanctions database.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SanctionsCheckResult {
    /// Whether a match was found on any list.
    pub is_match: bool,
    /// Confidence score for the best match, `0.0` to `1.0`.
    pub match_score: f64,
    /// Details of the matching entries, if any.
    pub matched_entries: Vec<SanctionsMatchDetail>,
}

/// Details about a single sanctions match.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SanctionsMatchDetail {
    pub entry: SanctionsEntry,
    /// The field that matched (name, alias, address, id).
    pub matched_field: String,
    /// The query value that triggered the match.
    pub query_value: String,
    /// Similarity score `0.0` to `1.0`.
    pub similarity: f64,
}

// ---------------------------------------------------------------------------
// AML / Risk types
// ---------------------------------------------------------------------------

/// Individual risk factors that can contribute to the composite AML score.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub enum RiskFactor {
    /// Transaction amount exceeds the high-value threshold.
    HighValueTransaction,
    /// Sender has an unusually high transaction frequency.
    FrequentTransactions,
    /// One or both counterparties are in a high-risk jurisdiction.
    HighRiskJurisdiction,
    /// The counterparty has not been seen before.
    NewCounterparty,
    /// Behavioral pattern deviates from the entity's historical norm.
    UnusualPattern,
    /// Multiple transactions just below reporting thresholds.
    StructuredTransactions,
    /// Funds moving rapidly through intermediary accounts.
    RapidMovement,
}

impl RiskFactor {
    /// Human-readable label used in reports and logs.
    pub fn label(&self) -> &'static str {
        match self {
            Self::HighValueTransaction => "High-value transaction",
            Self::FrequentTransactions => "Frequent transactions",
            Self::HighRiskJurisdiction => "High-risk jurisdiction",
            Self::NewCounterparty => "New counterparty",
            Self::UnusualPattern => "Unusual pattern",
            Self::StructuredTransactions => "Structured transactions",
            Self::RapidMovement => "Rapid movement",
        }
    }
}

/// Aggregate AML risk level derived from the composite score.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
pub enum AMLRiskLevel {
    /// Score 0–25.
    Low,
    /// Score 26–50.
    Medium,
    /// Score 51–75.
    High,
    /// Score 76–100.
    Critical,
}

impl AMLRiskLevel {
    /// Derive the risk level from a composite score.
    pub fn from_score(score: u8) -> Self {
        match score {
            0..=25 => Self::Low,
            26..=50 => Self::Medium,
            51..=75 => Self::High,
            _ => Self::Critical,
        }
    }
}

/// The overall compliance disposition for a screened payment.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum ComplianceStatus {
    /// All checks passed — payment may proceed.
    Passed,
    /// One or more risk factors exceeded thresholds — requires manual review.
    Flagged,
    /// Hard sanctions match or critical risk — payment must be blocked.
    Blocked,
}

// ---------------------------------------------------------------------------
// Travel Rule types
// ---------------------------------------------------------------------------

/// Originator and beneficiary information required by the FATF Travel Rule.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TravelRuleData {
    /// Originator full legal name.
    pub originator_name: Option<String>,
    /// Originator account or wallet identifier.
    pub originator_account: Option<String>,
    /// Originator physical address (street, city, country).
    pub originator_address: Option<String>,
    /// Originator national identity or registration number.
    pub originator_id: Option<String>,
    /// Beneficiary full legal name.
    pub beneficiary_name: Option<String>,
    /// Beneficiary account or wallet identifier.
    pub beneficiary_account: Option<String>,
    /// Beneficiary institution (VASP) identifier.
    pub beneficiary_institution: Option<String>,
}

impl TravelRuleData {
    /// Returns `true` when all required originator fields are present.
    pub fn originator_complete(&self) -> bool {
        self.originator_name.is_some()
            && self.originator_account.is_some()
            && self.originator_address.is_some()
    }

    /// Returns `true` when all required beneficiary fields are present.
    pub fn beneficiary_complete(&self) -> bool {
        self.beneficiary_name.is_some() && self.beneficiary_account.is_some()
    }
}

// ---------------------------------------------------------------------------
// API request / response envelopes
// ---------------------------------------------------------------------------

/// Inbound screening request accepted by the HTTP API.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScreeningRequest {
    /// The payment to screen.
    pub payment: Payment,
    /// Optional travel rule data — required for transactions above the threshold.
    pub travel_rule_data: Option<TravelRuleData>,
    /// Caller-specified timeout in milliseconds (default: 5000).
    pub timeout_ms: Option<u64>,
}

/// Outbound screening response returned by the HTTP API.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScreeningResponse {
    /// Whether the request was processed successfully.
    pub success: bool,
    /// The compliance result, present when `success` is `true`.
    pub result: Option<ComplianceResult>,
    /// Human-readable error message, present when `success` is `false`.
    pub error: Option<String>,
    /// Request identifier for tracing.
    pub request_id: Uuid,
}

/// Batch screening request.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchScreeningRequest {
    pub payments: Vec<ScreeningRequest>,
}

/// Batch screening response.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchScreeningResponse {
    pub results: Vec<ScreeningResponse>,
    pub total: usize,
    pub passed: usize,
    pub flagged: usize,
    pub blocked: usize,
}

// ---------------------------------------------------------------------------
// Hex serialization helper for Vec<u8>
// ---------------------------------------------------------------------------

mod hex_bytes {
    use serde::{self, Deserialize, Deserializer, Serializer};

    pub fn serialize<S>(bytes: &Vec<u8>, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&hex::encode(bytes))
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<Vec<u8>, D::Error>
    where
        D: Deserializer<'de>,
    {
        let s = String::deserialize(deserializer)?;
        hex::decode(&s).map_err(serde::de::Error::custom)
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aml_risk_level_from_score_boundaries() {
        assert_eq!(AMLRiskLevel::from_score(0), AMLRiskLevel::Low);
        assert_eq!(AMLRiskLevel::from_score(25), AMLRiskLevel::Low);
        assert_eq!(AMLRiskLevel::from_score(26), AMLRiskLevel::Medium);
        assert_eq!(AMLRiskLevel::from_score(50), AMLRiskLevel::Medium);
        assert_eq!(AMLRiskLevel::from_score(51), AMLRiskLevel::High);
        assert_eq!(AMLRiskLevel::from_score(75), AMLRiskLevel::High);
        assert_eq!(AMLRiskLevel::from_score(76), AMLRiskLevel::Critical);
        assert_eq!(AMLRiskLevel::from_score(100), AMLRiskLevel::Critical);
    }

    #[test]
    fn travel_rule_completeness() {
        let complete = TravelRuleData {
            originator_name: Some("Alice".into()),
            originator_account: Some("0xabc".into()),
            originator_address: Some("Dubai, UAE".into()),
            originator_id: Some("ID-123".into()),
            beneficiary_name: Some("Bob".into()),
            beneficiary_account: Some("0xdef".into()),
            beneficiary_institution: None,
        };
        assert!(complete.originator_complete());
        assert!(complete.beneficiary_complete());

        let incomplete = TravelRuleData {
            originator_name: Some("Alice".into()),
            originator_account: None,
            originator_address: None,
            originator_id: None,
            beneficiary_name: None,
            beneficiary_account: None,
            beneficiary_institution: None,
        };
        assert!(!incomplete.originator_complete());
        assert!(!incomplete.beneficiary_complete());
    }

    #[test]
    fn compliance_status_serialization_roundtrip() {
        let status = ComplianceStatus::Flagged;
        let json = serde_json::to_string(&status).unwrap();
        let back: ComplianceStatus = serde_json::from_str(&json).unwrap();
        assert_eq!(status, back);
    }

    #[test]
    fn risk_factor_labels_are_nonempty() {
        let factors = vec![
            RiskFactor::HighValueTransaction,
            RiskFactor::FrequentTransactions,
            RiskFactor::HighRiskJurisdiction,
            RiskFactor::NewCounterparty,
            RiskFactor::UnusualPattern,
            RiskFactor::StructuredTransactions,
            RiskFactor::RapidMovement,
        ];
        for f in factors {
            assert!(!f.label().is_empty());
        }
    }

    #[test]
    fn sanctions_list_display() {
        assert_eq!(SanctionsList::Ofac.to_string(), "OFAC");
        assert_eq!(SanctionsList::UaeCentralBank.to_string(), "UAE Central Bank");
    }

    #[test]
    fn sanctions_list_display_all_variants() {
        assert_eq!(SanctionsList::UnitedNations.to_string(), "UN");
        assert_eq!(SanctionsList::EuropeanUnion.to_string(), "EU");
    }

    #[test]
    fn aml_risk_level_from_score_max_value() {
        assert_eq!(AMLRiskLevel::from_score(255), AMLRiskLevel::Critical);
    }

    #[test]
    fn compliance_status_serialization_all_variants() {
        for status in [ComplianceStatus::Passed, ComplianceStatus::Flagged, ComplianceStatus::Blocked] {
            let json = serde_json::to_string(&status).unwrap();
            let back: ComplianceStatus = serde_json::from_str(&json).unwrap();
            assert_eq!(status, back);
        }
    }

    #[test]
    fn entity_type_serialization_roundtrip() {
        for et in [EntityType::Individual, EntityType::Organization, EntityType::Vessel, EntityType::Aircraft, EntityType::Unknown] {
            let json = serde_json::to_string(&et).unwrap();
            let back: EntityType = serde_json::from_str(&json).unwrap();
            assert_eq!(et, back);
        }
    }

    #[test]
    fn risk_factor_label_uniqueness() {
        let factors = vec![
            RiskFactor::HighValueTransaction,
            RiskFactor::FrequentTransactions,
            RiskFactor::HighRiskJurisdiction,
            RiskFactor::NewCounterparty,
            RiskFactor::UnusualPattern,
            RiskFactor::StructuredTransactions,
            RiskFactor::RapidMovement,
        ];
        let labels: Vec<&str> = factors.iter().map(|f| f.label()).collect();
        let unique: std::collections::HashSet<&str> = labels.iter().cloned().collect();
        assert_eq!(labels.len(), unique.len(), "All risk factor labels should be unique");
    }

    #[test]
    fn test_payment_creates_valid_payment() {
        let p = Payment::test_payment("alice", "bob", 5000, "USD");
        assert_eq!(p.sender, "alice");
        assert_eq!(p.recipient, "bob");
        assert_eq!(p.amount, 5000);
        assert_eq!(p.currency, "USD");
        assert!(p.purpose_hash.is_none());
        assert!(p.metadata.is_empty());
    }

    #[test]
    fn travel_rule_originator_complete_requires_all_three() {
        // Missing account
        let data = TravelRuleData {
            originator_name: Some("Alice".into()),
            originator_account: None,
            originator_address: Some("Dubai".into()),
            originator_id: None,
            beneficiary_name: None,
            beneficiary_account: None,
            beneficiary_institution: None,
        };
        assert!(!data.originator_complete());

        // Missing address
        let data2 = TravelRuleData {
            originator_name: Some("Alice".into()),
            originator_account: Some("0xabc".into()),
            originator_address: None,
            originator_id: None,
            beneficiary_name: None,
            beneficiary_account: None,
            beneficiary_institution: None,
        };
        assert!(!data2.originator_complete());
    }

    #[test]
    fn travel_rule_beneficiary_complete_requires_both() {
        let data = TravelRuleData {
            originator_name: None,
            originator_account: None,
            originator_address: None,
            originator_id: None,
            beneficiary_name: Some("Bob".into()),
            beneficiary_account: None,
            beneficiary_institution: None,
        };
        assert!(!data.beneficiary_complete());
    }

    #[test]
    fn aml_risk_level_ordering() {
        assert!(AMLRiskLevel::Low < AMLRiskLevel::Medium);
        assert!(AMLRiskLevel::Medium < AMLRiskLevel::High);
        assert!(AMLRiskLevel::High < AMLRiskLevel::Critical);
    }

    #[test]
    fn payment_serialization_roundtrip() {
        let p = Payment::test_payment("alice", "bob", 5000, "USD");
        let json = serde_json::to_string(&p).unwrap();
        let back: Payment = serde_json::from_str(&json).unwrap();
        assert_eq!(back.sender, "alice");
        assert_eq!(back.recipient, "bob");
        assert_eq!(back.amount, 5000);
        assert_eq!(back.currency, "USD");
    }

    #[test]
    fn screening_request_serialization() {
        let req = ScreeningRequest {
            payment: Payment::test_payment("alice", "bob", 1000, "USD"),
            travel_rule_data: None,
            timeout_ms: Some(3000),
        };
        let json = serde_json::to_string(&req).unwrap();
        let back: ScreeningRequest = serde_json::from_str(&json).unwrap();
        assert_eq!(back.timeout_ms, Some(3000));
    }

    #[test]
    fn sanctions_list_all_variants_serialization() {
        for list in [SanctionsList::Ofac, SanctionsList::UaeCentralBank, SanctionsList::UnitedNations, SanctionsList::EuropeanUnion] {
            let json = serde_json::to_string(&list).unwrap();
            let back: SanctionsList = serde_json::from_str(&json).unwrap();
            assert_eq!(list, back);
        }
    }

    // -----------------------------------------------------------------------
    // Cover lines 333, 337-338: hex_bytes serialize/deserialize roundtrip
    // -----------------------------------------------------------------------

    #[test]
    fn compliance_result_serialization_roundtrip() {
        let result = ComplianceResult {
            payment_id: Uuid::new_v4(),
            sanctions_clear: true,
            aml_risk_score: 42,
            travel_rule_compliant: true,
            status: ComplianceStatus::Passed,
            attestation: vec![0xde, 0xad, 0xbe, 0xef],
            screening_duration_ms: 123,
            risk_factors: vec![RiskFactor::HighValueTransaction],
            screened_at: Utc::now(),
        };
        let json = serde_json::to_string(&result).unwrap();
        // Verify attestation is hex-encoded
        assert!(json.contains("deadbeef"));

        let back: ComplianceResult = serde_json::from_str(&json).unwrap();
        assert_eq!(back.attestation, vec![0xde, 0xad, 0xbe, 0xef]);
        assert_eq!(back.aml_risk_score, 42);
        assert_eq!(back.status, ComplianceStatus::Passed);
    }

    #[test]
    fn compliance_result_hex_bytes_empty_attestation() {
        let result = ComplianceResult {
            payment_id: Uuid::new_v4(),
            sanctions_clear: true,
            aml_risk_score: 0,
            travel_rule_compliant: true,
            status: ComplianceStatus::Passed,
            attestation: vec![],
            screening_duration_ms: 0,
            risk_factors: vec![],
            screened_at: Utc::now(),
        };
        let json = serde_json::to_string(&result).unwrap();
        let back: ComplianceResult = serde_json::from_str(&json).unwrap();
        assert!(back.attestation.is_empty());
    }
}
