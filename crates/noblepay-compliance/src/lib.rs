//! # NoblePay TEE Compliance Engine
//!
//! Privacy-preserving compliance infrastructure for enterprise payment screening.
//! Runs inside AWS Nitro Enclaves to ensure that sensitive counterparty data never
//! leaves the trusted execution environment in plaintext.
//!
//! ## Architecture
//!
//! The engine is composed of eight independent subsystems orchestrated by
//! [`engine::ComplianceEngine`]:
//!
//! 1. **Sanctions Screening** ([`sanctions`]) — multi-list fuzzy entity matching
//!    against OFAC, UAE Central Bank, UN, and EU consolidated lists.
//! 2. **AML Risk Scoring** ([`aml`]) — weighted composite scoring across velocity,
//!    geography, amount, counterparty, and pattern factors.
//! 3. **Travel Rule Verification** ([`travel_rule`]) — FATF / IVMS101 completeness
//!    checks with encrypted VASP-to-VASP data packaging.
//! 4. **TEE Attestation** ([`attestation`]) — cryptographic proof that the
//!    compliance computation ran inside a genuine enclave.
//! 5. **ML Risk Scoring** ([`ml_risk`]) — ensemble random-forest model with feature
//!    importance analysis and confidence calibration.
//! 6. **Behavioral Analytics** ([`behavioral`]) — entity profiling with anomaly
//!    detection across amount, temporal, dormancy, and currency dimensions.
//! 7. **Graph Analysis** ([`graph_analysis`]) — transaction network analysis with
//!    community detection, cycle detection, and suspicious pattern recognition.
//! 8. **Corridor Analysis** ([`corridor_analysis`]) — jurisdiction-pair risk scoring
//!    with typology matching and regulatory requirement mapping.
//!
//! ## Feature Flags
//!
//! | Flag       | Description                                      |
//! |------------|--------------------------------------------------|
//! | `mock-tee` | Deterministic mock attestation (must opt-in)    |
//! | `nitro`    | AWS Nitro Enclave attestation via NSM device      |
//! | `sgx`      | Intel SGX attestation (experimental)              |
//!
//! ## Quick Start
//!
//! ```rust,no_run
//! use noblepay_compliance::engine::ComplianceEngine;
//! use noblepay_compliance::types::Payment;
//!
//! #[tokio::main]
//! async fn main() {
//!     let engine = ComplianceEngine::new().await;
//!     // screen a payment ...
//! }
//! ```

pub mod aml;
pub mod attestation;
pub mod behavioral;
pub mod corridor_analysis;
pub mod engine;
pub mod graph_analysis;
pub mod ml_risk;
pub mod sanctions;
pub mod server;
pub mod travel_rule;
pub mod types;

// Re-export the most commonly used items at the crate root for ergonomic imports.
pub use engine::ComplianceEngine;
pub use types::{
    AMLRiskLevel, ComplianceResult, ComplianceStatus, Payment, RiskFactor, ScreeningRequest,
    ScreeningResponse,
};

/// Crate-level error type that unifies all subsystem errors.
#[derive(Debug, thiserror::Error)]
pub enum ComplianceError {
    #[error("sanctions screening failed: {0}")]
    SanctionsError(String),

    #[error("AML risk scoring failed: {0}")]
    AmlError(String),

    #[error("travel rule verification failed: {0}")]
    TravelRuleError(String),

    #[error("attestation generation failed: {0}")]
    AttestationError(String),

    #[error("ML risk scoring failed: {0}")]
    MLRiskError(String),

    #[error("behavioral analysis failed: {0}")]
    BehavioralError(String),

    #[error("graph analysis failed: {0}")]
    GraphAnalysisError(String),

    #[error("corridor analysis failed: {0}")]
    CorridorAnalysisError(String),

    #[error("screening timed out after {0}ms")]
    Timeout(u64),

    #[error("sanctions list update failed for {list}: {reason}")]
    ListUpdateError { list: String, reason: String },

    #[error("serialization error: {0}")]
    SerializationError(#[from] serde_json::Error),

    #[error("internal error: {0}")]
    Internal(#[from] anyhow::Error),
}

/// Convenience alias used throughout the crate.
pub type Result<T> = std::result::Result<T, ComplianceError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_display_messages_are_human_readable() {
        let err = ComplianceError::Timeout(5000);
        assert_eq!(err.to_string(), "screening timed out after 5000ms");

        let err = ComplianceError::SanctionsError("list unavailable".into());
        assert!(err.to_string().contains("sanctions screening failed"));
    }

    #[test]
    fn result_alias_works_with_question_mark() {
        fn inner() -> Result<u32> {
            Ok(42)
        }
        assert_eq!(inner().unwrap(), 42);
    }

    #[test]
    fn re_exports_are_accessible() {
        // Verify that key types are re-exported at the crate root.
        let _status = ComplianceStatus::Passed;
        let _level = AMLRiskLevel::Low;
    }

    #[test]
    fn all_error_variants_display() {
        let errors: Vec<ComplianceError> = vec![
            ComplianceError::SanctionsError("test".into()),
            ComplianceError::AmlError("test".into()),
            ComplianceError::TravelRuleError("test".into()),
            ComplianceError::AttestationError("test".into()),
            ComplianceError::MLRiskError("test".into()),
            ComplianceError::BehavioralError("test".into()),
            ComplianceError::GraphAnalysisError("test".into()),
            ComplianceError::CorridorAnalysisError("test".into()),
            ComplianceError::Timeout(5000),
            ComplianceError::ListUpdateError {
                list: "OFAC".into(),
                reason: "network error".into(),
            },
        ];
        for err in &errors {
            let msg = err.to_string();
            assert!(!msg.is_empty(), "Error display should not be empty");
        }
    }

    #[test]
    fn error_from_serde_json() {
        let bad_json = "not valid json";
        let serde_err: std::result::Result<serde_json::Value, _> = serde_json::from_str(bad_json);
        let compliance_err: ComplianceError = serde_err.unwrap_err().into();
        let msg = compliance_err.to_string();
        assert!(msg.contains("serialization error"));
    }

    #[test]
    fn result_alias_propagates_error() {
        fn failing() -> Result<()> {
            Err(ComplianceError::Timeout(100))
        }
        let result = failing();
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(matches!(err, ComplianceError::Timeout(100)));
    }

    #[test]
    fn timeout_error_contains_duration() {
        let err = ComplianceError::Timeout(3000);
        assert!(err.to_string().contains("3000"));
    }

    #[test]
    fn list_update_error_contains_list_name() {
        let err = ComplianceError::ListUpdateError {
            list: "EU".into(),
            reason: "connection refused".into(),
        };
        let msg = err.to_string();
        assert!(msg.contains("EU"));
        assert!(msg.contains("connection refused"));
    }
}
