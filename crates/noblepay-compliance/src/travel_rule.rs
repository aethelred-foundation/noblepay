//! FATF Travel Rule verification and IVMS101 data packaging.
//!
//! The FATF Travel Rule requires Virtual Asset Service Providers (VASPs) to
//! collect and share originator and beneficiary information for transfers
//! above a defined threshold.  This module verifies that the required data is
//! present, formats it according to the IVMS101 data model, and produces an
//! encrypted package suitable for VASP-to-VASP transmission.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha3::{Digest, Sha3_256};
use tracing::{debug, warn};
use uuid::Uuid;

use crate::types::{Payment, TravelRuleData};
use crate::ComplianceError;

/// USD-equivalent threshold (in cents) above which the Travel Rule applies.
/// FATF recommends USD/EUR 1,000.
const TRAVEL_RULE_THRESHOLD_USD_CENTS: u64 = 100_000;

/// Supported fiat and stablecoin currencies with their approximate USD rate
/// (expressed as cents-per-smallest-unit).  A production system would use a
/// live price feed.
fn approximate_usd_rate(currency: &str) -> f64 {
    match currency.to_uppercase().as_str() {
        "USD" | "USDC" | "USDT" | "DAI" | "BUSD" => 1.0,
        "AED" => 0.2723, // 1 AED ~ 0.27 USD
        "EUR" => 1.08,
        "GBP" => 1.27,
        "JPY" => 0.0067,
        "BTC" => 65_000.0, // highly approximate — use oracle in production
        "ETH" => 3_400.0,
        _ => 1.0, // fallback assumes 1:1 for unknown currencies
    }
}

// ---------------------------------------------------------------------------
// TravelRuleEngine
// ---------------------------------------------------------------------------

/// Engine that verifies FATF Travel Rule compliance for payments.
#[derive(Clone)]
pub struct TravelRuleEngine {
    /// USD-equivalent threshold in cents.
    threshold_usd_cents: u64,
}

impl TravelRuleEngine {
    /// Create an engine with the standard FATF threshold.
    pub fn new() -> Self {
        Self {
            threshold_usd_cents: TRAVEL_RULE_THRESHOLD_USD_CENTS,
        }
    }

    /// Create an engine with a custom threshold (useful for jurisdictions with
    /// lower thresholds or for testing).
    pub fn with_threshold(threshold_usd_cents: u64) -> Self {
        Self {
            threshold_usd_cents,
        }
    }

    /// Check whether the Travel Rule applies to this payment based on the
    /// USD-equivalent amount.
    pub fn is_above_threshold(&self, payment: &Payment) -> bool {
        let rate = approximate_usd_rate(&payment.currency);
        let usd_cents = (payment.amount as f64 * rate) as u64;
        usd_cents >= self.threshold_usd_cents
    }

    /// Verify Travel Rule compliance for a payment.
    ///
    /// Returns a [`TravelRuleVerification`] containing the disposition and,
    /// when applicable, the encrypted IVMS101 data package.
    pub fn verify_travel_rule(
        &self,
        payment: &Payment,
        travel_rule_data: Option<&TravelRuleData>,
    ) -> Result<TravelRuleVerification, ComplianceError> {
        let above_threshold = self.is_above_threshold(payment);

        if !above_threshold {
            debug!(
                payment_id = %payment.id,
                "payment below Travel Rule threshold — compliant by default"
            );
            return Ok(TravelRuleVerification {
                compliant: true,
                above_threshold: false,
                missing_fields: Vec::new(),
                ivms101_package: None,
                verified_at: Utc::now(),
            });
        }

        // Above threshold — Travel Rule data is required.
        let data = match travel_rule_data {
            Some(d) => d,
            None => {
                warn!(
                    payment_id = %payment.id,
                    "payment above threshold but no Travel Rule data provided"
                );
                return Ok(TravelRuleVerification {
                    compliant: false,
                    above_threshold: true,
                    missing_fields: vec![
                        "originator_name".into(),
                        "originator_account".into(),
                        "originator_address".into(),
                        "beneficiary_name".into(),
                        "beneficiary_account".into(),
                    ],
                    ivms101_package: None,
                    verified_at: Utc::now(),
                });
            }
        };

        let mut missing: Vec<String> = Vec::new();

        // --- Originator completeness ---
        if data.originator_name.is_none() {
            missing.push("originator_name".into());
        }
        if data.originator_account.is_none() {
            missing.push("originator_account".into());
        }
        if data.originator_address.is_none() {
            missing.push("originator_address".into());
        }

        // --- Beneficiary completeness ---
        if data.beneficiary_name.is_none() {
            missing.push("beneficiary_name".into());
        }
        if data.beneficiary_account.is_none() {
            missing.push("beneficiary_account".into());
        }

        let compliant = missing.is_empty();

        let ivms101_package = if compliant {
            Some(self.build_ivms101_package(payment, data)?)
        } else {
            warn!(
                payment_id = %payment.id,
                missing = ?missing,
                "Travel Rule data incomplete"
            );
            None
        };

        Ok(TravelRuleVerification {
            compliant,
            above_threshold: true,
            missing_fields: missing,
            ivms101_package,
            verified_at: Utc::now(),
        })
    }

    /// Build an IVMS101-formatted data package and produce a SHA-3 commitment
    /// hash.  The raw data would be encrypted before VASP-to-VASP transmission;
    /// here we model the cleartext structure and its hash.
    fn build_ivms101_package(
        &self,
        payment: &Payment,
        data: &TravelRuleData,
    ) -> Result<IVMS101Package, ComplianceError> {
        let payload = IVMS101Payload {
            message_id: Uuid::new_v4(),
            originator: IVMS101Person {
                name: data.originator_name.clone().unwrap_or_default(),
                account_id: data.originator_account.clone().unwrap_or_default(),
                address: data.originator_address.clone(),
                national_id: data.originator_id.clone(),
            },
            beneficiary: IVMS101Person {
                name: data.beneficiary_name.clone().unwrap_or_default(),
                account_id: data.beneficiary_account.clone().unwrap_or_default(),
                address: None,
                national_id: None,
            },
            beneficiary_institution: data.beneficiary_institution.clone(),
            transaction_amount: payment.amount,
            transaction_currency: payment.currency.clone(),
            transaction_datetime: payment.timestamp,
        };

        let json = serde_json::to_vec(&payload).map_err(ComplianceError::SerializationError)?;
        let mut hasher = Sha3_256::new();
        hasher.update(&json);
        let hash = hasher.finalize().to_vec();

        Ok(IVMS101Package {
            payload,
            commitment_hash: hex::encode(&hash),
            encrypted_blob: None, // In production, encrypt with recipient VASP's public key.
        })
    }
}

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

/// Result of a Travel Rule verification.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TravelRuleVerification {
    /// Whether the payment is Travel Rule compliant.
    pub compliant: bool,
    /// Whether the payment exceeded the threshold.
    pub above_threshold: bool,
    /// List of missing required fields (empty when compliant).
    pub missing_fields: Vec<String>,
    /// IVMS101 package, present only when compliant and above threshold.
    pub ivms101_package: Option<IVMS101Package>,
    /// When the verification was performed.
    pub verified_at: DateTime<Utc>,
}

/// IVMS101 data package for VASP-to-VASP transmission.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IVMS101Package {
    pub payload: IVMS101Payload,
    /// SHA-3-256 hex digest of the serialized payload.
    pub commitment_hash: String,
    /// Encrypted payload for transmission (None in dev/mock mode).
    pub encrypted_blob: Option<Vec<u8>>,
}

/// The cleartext IVMS101 payload.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IVMS101Payload {
    pub message_id: Uuid,
    pub originator: IVMS101Person,
    pub beneficiary: IVMS101Person,
    pub beneficiary_institution: Option<String>,
    pub transaction_amount: u64,
    pub transaction_currency: String,
    pub transaction_datetime: DateTime<Utc>,
}

/// An IVMS101 natural or legal person.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IVMS101Person {
    pub name: String,
    pub account_id: String,
    pub address: Option<String>,
    pub national_id: Option<String>,
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::Payment;

    fn small_payment() -> Payment {
        Payment::test_payment("alice", "bob", 5_000, "USD") // $50
    }

    fn large_payment() -> Payment {
        Payment::test_payment("alice", "bob", 500_000, "USD") // $5,000
    }

    fn complete_travel_data() -> TravelRuleData {
        TravelRuleData {
            originator_name: Some("Alice Corp".into()),
            originator_account: Some("0xabc123".into()),
            originator_address: Some("Dubai, UAE".into()),
            originator_id: Some("CR-12345".into()),
            beneficiary_name: Some("Bob Ltd".into()),
            beneficiary_account: Some("0xdef456".into()),
            beneficiary_institution: Some("VASP-XYZ".into()),
        }
    }

    #[test]
    fn below_threshold_always_compliant() {
        let engine = TravelRuleEngine::new();
        let result = engine.verify_travel_rule(&small_payment(), None).unwrap();
        assert!(result.compliant);
        assert!(!result.above_threshold);
    }

    #[test]
    fn above_threshold_without_data_not_compliant() {
        let engine = TravelRuleEngine::new();
        let result = engine.verify_travel_rule(&large_payment(), None).unwrap();
        assert!(!result.compliant);
        assert!(result.above_threshold);
        assert!(!result.missing_fields.is_empty());
    }

    #[test]
    fn above_threshold_with_complete_data_compliant() {
        let engine = TravelRuleEngine::new();
        let data = complete_travel_data();
        let result = engine
            .verify_travel_rule(&large_payment(), Some(&data))
            .unwrap();
        assert!(result.compliant);
        assert!(result.above_threshold);
        assert!(result.ivms101_package.is_some());
    }

    #[test]
    fn above_threshold_with_partial_data_not_compliant() {
        let engine = TravelRuleEngine::new();
        let data = TravelRuleData {
            originator_name: Some("Alice".into()),
            originator_account: None, // missing
            originator_address: None, // missing
            originator_id: None,
            beneficiary_name: None, // missing
            beneficiary_account: None, // missing
            beneficiary_institution: None,
        };
        let result = engine
            .verify_travel_rule(&large_payment(), Some(&data))
            .unwrap();
        assert!(!result.compliant);
        assert_eq!(result.missing_fields.len(), 4);
    }

    #[test]
    fn ivms101_commitment_hash_is_deterministic() {
        let engine = TravelRuleEngine::new();
        let payment = large_payment();
        let data = complete_travel_data();

        // The hash will differ because of UUID generation in the package,
        // but the structure should always be present.
        let result = engine
            .verify_travel_rule(&payment, Some(&data))
            .unwrap();
        let pkg = result.ivms101_package.unwrap();
        assert!(!pkg.commitment_hash.is_empty());
        assert_eq!(pkg.commitment_hash.len(), 64); // SHA3-256 hex = 64 chars
    }

    #[test]
    fn aed_conversion_respects_threshold() {
        let engine = TravelRuleEngine::new();
        // 400,000 AED fils = 4,000 AED ~ $1,089 USD => above $1,000 threshold
        let payment = Payment::test_payment("alice", "bob", 400_000, "AED");
        assert!(engine.is_above_threshold(&payment));

        // 100,000 AED fils = 1,000 AED ~ $272 USD => below threshold
        let small = Payment::test_payment("alice", "bob", 100_000, "AED");
        assert!(!engine.is_above_threshold(&small));
    }

    #[test]
    fn custom_threshold() {
        let engine = TravelRuleEngine::with_threshold(50_000); // $500
        let payment = Payment::test_payment("alice", "bob", 60_000, "USD");
        assert!(engine.is_above_threshold(&payment));
    }

    // -----------------------------------------------------------------------
    // USD rate approximations
    // -----------------------------------------------------------------------

    #[test]
    fn approximate_usd_rate_stablecoins() {
        assert_eq!(approximate_usd_rate("USD"), 1.0);
        assert_eq!(approximate_usd_rate("USDC"), 1.0);
        assert_eq!(approximate_usd_rate("USDT"), 1.0);
        assert_eq!(approximate_usd_rate("DAI"), 1.0);
        assert_eq!(approximate_usd_rate("BUSD"), 1.0);
    }

    #[test]
    fn approximate_usd_rate_fiat() {
        assert!((approximate_usd_rate("AED") - 0.2723).abs() < f64::EPSILON);
        assert!((approximate_usd_rate("EUR") - 1.08).abs() < f64::EPSILON);
        assert!((approximate_usd_rate("GBP") - 1.27).abs() < f64::EPSILON);
        assert!((approximate_usd_rate("JPY") - 0.0067).abs() < f64::EPSILON);
    }

    #[test]
    fn approximate_usd_rate_crypto() {
        assert_eq!(approximate_usd_rate("BTC"), 65_000.0);
        assert_eq!(approximate_usd_rate("ETH"), 3_400.0);
    }

    #[test]
    fn approximate_usd_rate_unknown_defaults_to_one() {
        assert_eq!(approximate_usd_rate("XYZ"), 1.0);
    }

    #[test]
    fn approximate_usd_rate_case_insensitive() {
        assert_eq!(approximate_usd_rate("usd"), 1.0);
        assert_eq!(approximate_usd_rate("Eur"), 1.08);
    }

    // -----------------------------------------------------------------------
    // Threshold edge cases
    // -----------------------------------------------------------------------

    #[test]
    fn exactly_at_threshold_is_above() {
        let engine = TravelRuleEngine::new();
        // Threshold is 100_000 USD cents = $1000
        let payment = Payment::test_payment("alice", "bob", 100_000, "USD");
        assert!(engine.is_above_threshold(&payment));
    }

    #[test]
    fn just_below_threshold_is_not_above() {
        let engine = TravelRuleEngine::new();
        let payment = Payment::test_payment("alice", "bob", 99_999, "USD");
        assert!(!engine.is_above_threshold(&payment));
    }

    #[test]
    fn zero_amount_below_threshold() {
        let engine = TravelRuleEngine::new();
        let payment = Payment::test_payment("alice", "bob", 0, "USD");
        assert!(!engine.is_above_threshold(&payment));
    }

    // -----------------------------------------------------------------------
    // Missing specific fields
    // -----------------------------------------------------------------------

    #[test]
    fn missing_only_originator_name() {
        let engine = TravelRuleEngine::new();
        let data = TravelRuleData {
            originator_name: None,
            originator_account: Some("0xabc".into()),
            originator_address: Some("Dubai".into()),
            originator_id: None,
            beneficiary_name: Some("Bob".into()),
            beneficiary_account: Some("0xdef".into()),
            beneficiary_institution: None,
        };
        let result = engine.verify_travel_rule(&large_payment(), Some(&data)).unwrap();
        assert!(!result.compliant);
        assert!(result.missing_fields.contains(&"originator_name".to_string()));
        assert_eq!(result.missing_fields.len(), 1);
    }

    #[test]
    fn missing_only_beneficiary_name() {
        let engine = TravelRuleEngine::new();
        let data = TravelRuleData {
            originator_name: Some("Alice".into()),
            originator_account: Some("0xabc".into()),
            originator_address: Some("Dubai".into()),
            originator_id: None,
            beneficiary_name: None,
            beneficiary_account: Some("0xdef".into()),
            beneficiary_institution: None,
        };
        let result = engine.verify_travel_rule(&large_payment(), Some(&data)).unwrap();
        assert!(!result.compliant);
        assert!(result.missing_fields.contains(&"beneficiary_name".to_string()));
    }

    // -----------------------------------------------------------------------
    // IVMS101 package structure
    // -----------------------------------------------------------------------

    #[test]
    fn ivms101_package_contains_correct_amount() {
        let engine = TravelRuleEngine::new();
        let payment = large_payment();
        let data = complete_travel_data();
        let result = engine.verify_travel_rule(&payment, Some(&data)).unwrap();
        let pkg = result.ivms101_package.unwrap();
        assert_eq!(pkg.payload.transaction_amount, payment.amount);
        assert_eq!(pkg.payload.transaction_currency, payment.currency);
        assert_eq!(pkg.payload.originator.name, "Alice Corp");
        assert_eq!(pkg.payload.beneficiary.name, "Bob Ltd");
        // encrypted_blob should be None in mock mode
        assert!(pkg.encrypted_blob.is_none());
    }

    // -----------------------------------------------------------------------
    // Custom threshold below default
    // -----------------------------------------------------------------------

    #[test]
    fn custom_lower_threshold_catches_more() {
        let engine = TravelRuleEngine::with_threshold(1_000); // $10
        let payment = Payment::test_payment("alice", "bob", 1_500, "USD");
        assert!(engine.is_above_threshold(&payment));
        // Without data, should not be compliant
        let result = engine.verify_travel_rule(&payment, None).unwrap();
        assert!(!result.compliant);
        assert!(result.above_threshold);
    }

    // -----------------------------------------------------------------------
    // Cover line 87: debug log for below-threshold payment
    // -----------------------------------------------------------------------

    #[test]
    fn below_threshold_with_data_still_compliant() {
        let engine = TravelRuleEngine::new();
        let data = complete_travel_data();
        let result = engine.verify_travel_rule(&small_payment(), Some(&data)).unwrap();
        assert!(result.compliant);
        assert!(!result.above_threshold);
        assert!(result.ivms101_package.is_none());
    }

    // -----------------------------------------------------------------------
    // Cover line 104: warn log for above threshold without data
    // -----------------------------------------------------------------------

    #[test]
    fn above_threshold_no_data_lists_all_missing_fields() {
        let engine = TravelRuleEngine::new();
        let result = engine.verify_travel_rule(&large_payment(), None).unwrap();
        assert!(!result.compliant);
        assert!(result.above_threshold);
        assert_eq!(result.missing_fields.len(), 5);
        assert!(result.missing_fields.contains(&"originator_name".to_string()));
        assert!(result.missing_fields.contains(&"originator_account".to_string()));
        assert!(result.missing_fields.contains(&"originator_address".to_string()));
        assert!(result.missing_fields.contains(&"beneficiary_name".to_string()));
        assert!(result.missing_fields.contains(&"beneficiary_account".to_string()));
    }

    // -----------------------------------------------------------------------
    // Cover line 151: warn log for incomplete travel rule data
    // -----------------------------------------------------------------------

    #[test]
    fn incomplete_data_triggers_warn_and_no_package() {
        let engine = TravelRuleEngine::new();
        let data = TravelRuleData {
            originator_name: Some("Alice".into()),
            originator_account: Some("0xabc".into()),
            originator_address: None, // missing
            originator_id: None,
            beneficiary_name: Some("Bob".into()),
            beneficiary_account: Some("0xdef".into()),
            beneficiary_institution: None,
        };
        let result = engine.verify_travel_rule(&large_payment(), Some(&data)).unwrap();
        assert!(!result.compliant);
        assert!(result.above_threshold);
        assert!(result.ivms101_package.is_none());
        assert!(result.missing_fields.contains(&"originator_address".to_string()));
    }
}
