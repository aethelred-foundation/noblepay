//! Test-only attestation support for the local compliance reference service.
//!
//! Production attestation is intentionally not advertised by this crate. A
//! production NoblePay deployment must point the backend and gateway at an
//! independently audited compliance service that generates and verifies real
//! hardware attestations. The `mock-tee` feature exists only for tests and
//! local development; normal builds have no attestation platform and fail
//! closed.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha3::{Digest, Sha3_256};
use tracing::debug;
#[cfg(any(test, feature = "mock-tee"))]
use tracing::warn;
use uuid::Uuid;

use crate::ComplianceError;

/// Attestation returned by the test compliance API.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttestationReport {
    pub id: Uuid,
    pub platform: TeePlatform,
    pub measurement: String,
    pub user_data_hash: String,
    pub timestamp: DateTime<Utc>,
    pub nonce: String,
    pub attestation_doc: String,
    pub certificate_chain: Vec<String>,
}

/// Platforms available in this crate. `Mock` is compiled for tests only;
/// `None` is the fail-closed state of every normal build.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum TeePlatform {
    Mock,
    None,
}

impl std::fmt::Display for TeePlatform {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Mock => write!(formatter, "mock"),
            Self::None => write!(formatter, "none"),
        }
    }
}

#[derive(Clone)]
pub struct AttestationGenerator {
    #[cfg(any(test, feature = "mock-tee"))]
    enclave_measurement: String,
    platform: TeePlatform,
}

impl Default for AttestationGenerator {
    fn default() -> Self {
        Self::new()
    }
}

impl AttestationGenerator {
    pub fn new() -> Self {
        let platform = Self::detect_platform();
        debug!(?platform, "attestation generator initialized");
        Self {
            #[cfg(any(test, feature = "mock-tee"))]
            enclave_measurement: sha3_hex(
                format!("noblepay-compliance-test-v{}", env!("CARGO_PKG_VERSION")).as_bytes(),
            ),
            platform,
        }
    }

    pub fn platform(&self) -> TeePlatform {
        self.platform
    }

    pub fn generate_attestation(
        &self,
        _user_data: &[u8],
        _nonce: &str,
    ) -> Result<AttestationReport, ComplianceError> {
        match self.platform {
            TeePlatform::Mock => {
                #[cfg(any(test, feature = "mock-tee"))]
                {
                    let timestamp = Utc::now();
                    Ok(AttestationReport {
                        id: Uuid::new_v4(),
                        platform: TeePlatform::Mock,
                        measurement: self.enclave_measurement.clone(),
                        user_data_hash: sha3_hex(_user_data),
                        timestamp,
                        nonce: _nonce.to_string(),
                        attestation_doc: self
                            .generate_mock_attestation(_user_data, _nonce, &timestamp),
                        certificate_chain: Vec::new(),
                    })
                }
                #[cfg(not(any(test, feature = "mock-tee")))]
                {
                    Err(ComplianceError::AttestationError(
                        "mock attestation generation is absent from production builds".into(),
                    ))
                }
            }
            TeePlatform::None => Err(ComplianceError::AttestationError(
                "no attestation provider is compiled; use an audited external compliance service"
                    .into(),
            )),
        }
    }

    pub fn verify_attestation(
        &self,
        report: &AttestationReport,
        expected_user_data: &[u8],
    ) -> Result<bool, ComplianceError> {
        if report.user_data_hash != sha3_hex(expected_user_data) {
            return Ok(false);
        }

        match report.platform {
            TeePlatform::Mock => {
                #[cfg(any(test, feature = "mock-tee"))]
                {
                    warn!("test-only mock attestation verification in use");
                    let expected = self.generate_mock_attestation(
                        expected_user_data,
                        &report.nonce,
                        &report.timestamp,
                    );
                    Ok(report.attestation_doc == expected)
                }
                #[cfg(not(any(test, feature = "mock-tee")))]
                {
                    Err(ComplianceError::AttestationError(
                        "mock attestation verification is absent from production builds".into(),
                    ))
                }
            }
            TeePlatform::None => Err(ComplianceError::AttestationError(
                "no attestation verifier is compiled; use an audited external compliance service"
                    .into(),
            )),
        }
    }

    pub fn attestation_to_bytes(report: &AttestationReport) -> Vec<u8> {
        hex::decode(&report.attestation_doc).unwrap_or_default()
    }

    fn detect_platform() -> TeePlatform {
        #[cfg(feature = "mock-tee")]
        {
            warn!("test-only mock attestation is enabled");
            return TeePlatform::Mock;
        }
        #[allow(unreachable_code)]
        if cfg!(test) {
            TeePlatform::Mock
        } else {
            TeePlatform::None
        }
    }

    #[cfg(any(test, feature = "mock-tee"))]
    fn generate_mock_attestation(
        &self,
        user_data: &[u8],
        nonce: &str,
        timestamp: &DateTime<Utc>,
    ) -> String {
        let mut hasher = Sha3_256::new();
        hasher.update(self.enclave_measurement.as_bytes());
        hasher.update(user_data);
        hasher.update(nonce.as_bytes());
        hasher.update(timestamp.to_rfc3339().as_bytes());
        hex::encode(hasher.finalize())
    }
}

fn sha3_hex(data: &[u8]) -> String {
    hex::encode(Sha3_256::digest(data))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mock_round_trip_and_tamper_detection() {
        let generator = AttestationGenerator::new();
        let report = generator
            .generate_attestation(b"screening", "nonce")
            .unwrap();
        assert_eq!(report.platform, TeePlatform::Mock);
        assert!(generator.verify_attestation(&report, b"screening").unwrap());
        assert!(!generator.verify_attestation(&report, b"different").unwrap());

        let mut tampered = report;
        tampered.attestation_doc = "00".repeat(32);
        assert!(!generator
            .verify_attestation(&tampered, b"screening")
            .unwrap());
    }

    #[test]
    fn no_platform_fails_closed() {
        let generator = AttestationGenerator {
            enclave_measurement: String::new(),
            platform: TeePlatform::None,
        };
        assert!(generator
            .generate_attestation(b"screening", "nonce")
            .is_err());
        let report = AttestationReport {
            id: Uuid::new_v4(),
            platform: TeePlatform::None,
            measurement: String::new(),
            user_data_hash: sha3_hex(b"screening"),
            timestamp: Utc::now(),
            nonce: "nonce".into(),
            attestation_doc: String::new(),
            certificate_chain: Vec::new(),
        };
        assert!(generator.verify_attestation(&report, b"screening").is_err());
    }

    #[test]
    fn raw_bytes_decode_is_bounded_by_valid_hex() {
        let mut report = AttestationGenerator::new()
            .generate_attestation(b"screening", "nonce")
            .unwrap();
        assert!(!AttestationGenerator::attestation_to_bytes(&report).is_empty());
        report.attestation_doc = "not-hex".into();
        assert!(AttestationGenerator::attestation_to_bytes(&report).is_empty());
    }

    #[test]
    fn platform_labels_are_explicit() {
        assert_eq!(TeePlatform::Mock.to_string(), "mock");
        assert_eq!(TeePlatform::None.to_string(), "none");
    }
}
