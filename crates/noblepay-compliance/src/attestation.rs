//! TEE attestation generation and verification.
//!
//! Produces a cryptographic attestation proving that a compliance screening
//! computation was executed inside a genuine Trusted Execution Environment.
//!
//! Three backends are supported via feature flags:
//!
//! - **`mock-tee`** — deterministic SHA-3 based attestation for
//!   local development and CI.  Must be explicitly enabled.
//! - **`nitro`** — AWS Nitro Enclave attestation via the NSM (Nitro Security
//!   Module) device.
//! - **`sgx`** — Intel SGX remote attestation *(experimental)*.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha3::{Digest, Sha3_256};
use tracing::{debug, warn};
use uuid::Uuid;

use crate::ComplianceError;

// ---------------------------------------------------------------------------
// AttestationReport
// ---------------------------------------------------------------------------

/// A cryptographic attestation report proving that a computation ran inside a TEE.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttestationReport {
    /// Unique identifier for this attestation.
    pub id: Uuid,
    /// The TEE platform that produced this attestation.
    pub platform: TeePlatform,
    /// SHA-3-256 measurement of the enclave image / code identity.
    pub measurement: String,
    /// SHA-3-256 digest of the user data (compliance result) bound into the
    /// attestation.
    pub user_data_hash: String,
    /// When the attestation was generated.
    pub timestamp: DateTime<Utc>,
    /// Caller-supplied nonce to prevent replay.
    pub nonce: String,
    /// The raw attestation document bytes (hex-encoded).
    ///
    /// For mock mode this is a SHA-3 hash chain.  For Nitro this is the CBOR-
    /// encoded NSM attestation document.
    pub attestation_doc: String,
    /// Certificate chain for the TEE platform (empty in mock mode).
    pub certificate_chain: Vec<String>,
}

/// Supported TEE platforms.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum TeePlatform {
    /// Development / CI mock attestation.
    Mock,
    /// AWS Nitro Enclave.
    Nitro,
    /// Intel SGX.
    Sgx,
    /// No TEE platform detected. Attestation generation will fail closed.
    None,
}

impl std::fmt::Display for TeePlatform {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Mock => write!(f, "mock"),
            Self::Nitro => write!(f, "nitro"),
            Self::Sgx => write!(f, "sgx"),
            Self::None => write!(f, "none"),
        }
    }
}

// ---------------------------------------------------------------------------
// AttestationGenerator
// ---------------------------------------------------------------------------

/// Generates TEE attestations for compliance results.
///
/// The active backend is selected at compile time via feature flags.
#[derive(Clone)]
pub struct AttestationGenerator {
    /// A fixed measurement value representing the enclave code identity.
    /// In production this is derived from the enclave image hash.
    enclave_measurement: String,
    /// The active TEE platform.
    platform: TeePlatform,
}

impl AttestationGenerator {
    /// Create a generator for the compile-time-selected platform.
    pub fn new() -> Self {
        let platform = Self::detect_platform();
        let measurement = Self::compute_enclave_measurement();
        debug!(?platform, "attestation generator initialized");
        Self {
            enclave_measurement: measurement,
            platform,
        }
    }

    /// Returns the active TEE platform.
    pub fn platform(&self) -> TeePlatform {
        self.platform
    }

    /// Generate an attestation binding the given `user_data` into the report.
    ///
    /// `user_data` is typically the serialized [`ComplianceResult`] so that the
    /// on-chain verifier can confirm which result the TEE endorsed.
    pub fn generate_attestation(
        &self,
        user_data: &[u8],
        nonce: &str,
    ) -> Result<AttestationReport, ComplianceError> {
        let user_data_hash = sha3_hex(user_data);
        let timestamp = Utc::now();

        let attestation_doc = match self.platform {
            TeePlatform::Mock => self.generate_mock_attestation(user_data, nonce, &timestamp),
            TeePlatform::Nitro => self.generate_nitro_attestation(user_data, nonce, &timestamp)?,
            TeePlatform::Sgx => self.generate_sgx_attestation(user_data, nonce, &timestamp)?,
            TeePlatform::None => {
                return Err(ComplianceError::AttestationError(
                    "No TEE platform available — cannot generate attestation. \
                     Set REQUIRE_TEE=false or enable a TEE feature flag (mock-tee, nitro, sgx)."
                        .into(),
                ));
            }
        };

        let report = AttestationReport {
            id: Uuid::new_v4(),
            platform: self.platform,
            measurement: self.enclave_measurement.clone(),
            user_data_hash,
            timestamp,
            nonce: nonce.to_string(),
            attestation_doc,
            certificate_chain: Vec::new(),
        };

        debug!(
            attestation_id = %report.id,
            platform = %self.platform,
            "attestation generated"
        );

        Ok(report)
    }

    /// Verify that an attestation report is valid.
    ///
    /// - **Mock mode** (`mock-tee` feature): recomputes the hash chain.
    /// - **Nitro/SGX without `mock-tee`**: fails closed with an error indicating
    ///   that real verification is not yet implemented.
    /// - **Nitro/SGX with `mock-tee`**: allows through with a warning (test only).
    pub fn verify_attestation(
        &self,
        report: &AttestationReport,
        expected_user_data: &[u8],
    ) -> Result<bool, ComplianceError> {
        // Verify user data hash matches.
        let expected_hash = sha3_hex(expected_user_data);
        if report.user_data_hash != expected_hash {
            return Ok(false);
        }

        match report.platform {
            TeePlatform::Mock => {
                #[cfg(feature = "mock-tee")]
                {
                    warn!("TEE attestation verification is MOCKED - do not use in production");
                }
                let expected_doc = self.generate_mock_attestation(
                    expected_user_data,
                    &report.nonce,
                    &report.timestamp,
                );
                Ok(report.attestation_doc == expected_doc)
            }
            TeePlatform::Nitro => {
                #[cfg(feature = "mock-tee")]
                {
                    warn!("TEE attestation verification is MOCKED - do not use in production");
                    return Ok(true);
                }
                #[cfg(not(feature = "mock-tee"))]
                {
                    Err(ComplianceError::AttestationError(
                        "Nitro attestation verification not yet implemented - enable mock-tee for testing".into(),
                    ))
                }
            }
            TeePlatform::Sgx => {
                #[cfg(feature = "mock-tee")]
                {
                    warn!("TEE attestation verification is MOCKED - do not use in production");
                    return Ok(true);
                }
                #[cfg(not(feature = "mock-tee"))]
                {
                    Err(ComplianceError::AttestationError(
                        "SGX attestation verification not yet implemented - enable mock-tee for testing".into(),
                    ))
                }
            }
            TeePlatform::None => {
                Err(ComplianceError::AttestationError(
                    "No TEE platform available — cannot verify attestation".into(),
                ))
            }
        }
    }

    /// Return the raw attestation bytes for on-chain submission.
    pub fn attestation_to_bytes(report: &AttestationReport) -> Vec<u8> {
        // For on-chain verification the attestation document is the essential
        // piece.  We hex-decode it back to raw bytes.
        hex::decode(&report.attestation_doc).unwrap_or_default()
    }

    // -----------------------------------------------------------------------
    // Platform detection
    // -----------------------------------------------------------------------

    fn detect_platform() -> TeePlatform {
        #[cfg(feature = "nitro")]
        {
            return TeePlatform::Nitro;
        }
        #[cfg(feature = "sgx")]
        {
            return TeePlatform::Sgx;
        }
        #[cfg(feature = "mock-tee")]
        {
            warn!("TEE attestation is MOCKED — do not use in production");
            return TeePlatform::Mock;
        }

        // No TEE feature enabled.
        // In test mode, fall back to Mock so unit tests work without features.
        // In production (or when REQUIRE_TEE=true), return None so callers
        // fail closed — no silent fallback to mock attestation.
        #[allow(unreachable_code)]
        {
            if cfg!(test) {
                warn!("No TEE feature enabled — defaulting to Mock for test mode");
                TeePlatform::Mock
            } else if std::env::var("REQUIRE_TEE").unwrap_or_default() == "true" {
                warn!("REQUIRE_TEE=true but no TEE feature enabled — platform set to None (fail closed)");
                TeePlatform::None
            } else {
                warn!(
                    "No TEE feature enabled and REQUIRE_TEE is not set — defaulting to Mock. \
                     Set REQUIRE_TEE=true in production to enforce real TEE attestation."
                );
                TeePlatform::Mock
            }
        }
    }

    /// Compute a stable measurement representing the enclave code identity.
    fn compute_enclave_measurement() -> String {
        // In production the measurement is the hash of the signed enclave
        // image (EIF for Nitro, MRENCLAVE for SGX).  In dev we use a fixed
        // value derived from the crate version.
        let version = env!("CARGO_PKG_VERSION");
        sha3_hex(format!("noblepay-compliance-v{version}").as_bytes())
    }

    // -----------------------------------------------------------------------
    // Backend-specific generators
    // -----------------------------------------------------------------------

    /// Mock attestation: SHA-3 hash chain over (measurement || user_data || nonce || timestamp).
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

    /// Nitro attestation stub — awaiting real AWS Nitro NSM SDK integration.
    ///
    /// # Production integration TODO
    ///
    /// The real implementation must:
    ///   1. Open `/dev/nsm` (the Nitro Security Module device)
    ///   2. Build an NSM `Attestation` request with `user_data` and `nonce`
    ///   3. Call `ioctl()` to obtain the signed CBOR attestation document
    ///   4. Return the hex-encoded CBOR document
    ///
    /// Until the NSM SDK is integrated, this stub falls back to mock attestation
    /// generation when the `nitro` feature is enabled. **This is NOT a real
    /// Nitro attestation** — it will not pass on-chain verification against the
    /// AWS Nitro root certificate.
    fn generate_nitro_attestation(
        &self,
        user_data: &[u8],
        nonce: &str,
        timestamp: &DateTime<Utc>,
    ) -> Result<String, ComplianceError> {
        #[cfg(feature = "nitro")]
        {
            // STUB: Real NSM SDK integration pending.
            // This generates a mock hash-chain attestation, NOT a genuine Nitro
            // attestation document. It will NOT verify against AWS Nitro root CA.
            warn!(
                "Nitro attestation is a STUB using mock generation — \
                 real NSM /dev/nsm integration is not yet implemented"
            );
            Ok(self.generate_mock_attestation(user_data, nonce, timestamp))
        }
        #[cfg(not(feature = "nitro"))]
        {
            Err(ComplianceError::AttestationError(
                "Nitro attestation requires the 'nitro' feature flag".into(),
            ))
        }
    }

    /// SGX attestation stub — awaiting real Intel SGX SDK integration.
    ///
    /// # Production integration TODO
    ///
    /// The real implementation must:
    ///   1. Call `sgx_create_report()` to generate an SGX report
    ///   2. Use the quoting enclave to convert the report to a quote
    ///   3. Submit the quote to Intel Attestation Service (IAS) or DCAP
    ///   4. Return the hex-encoded quote with IAS response
    ///
    /// Until the SGX SDK is integrated, this stub falls back to mock attestation
    /// generation when the `sgx` feature is enabled. **This is NOT a real
    /// SGX attestation** — it will not pass remote attestation verification.
    fn generate_sgx_attestation(
        &self,
        user_data: &[u8],
        nonce: &str,
        timestamp: &DateTime<Utc>,
    ) -> Result<String, ComplianceError> {
        #[cfg(feature = "sgx")]
        {
            // STUB: Real SGX SDK integration pending.
            // This generates a mock hash-chain attestation, NOT a genuine SGX
            // quote. It will NOT verify against Intel Attestation Service.
            warn!(
                "SGX attestation is a STUB using mock generation — \
                 real SGX SDK integration is not yet implemented"
            );
            Ok(self.generate_mock_attestation(user_data, nonce, timestamp))
        }
        #[cfg(not(feature = "sgx"))]
        {
            Err(ComplianceError::AttestationError(
                "SGX attestation requires the 'sgx' feature flag".into(),
            ))
        }
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// SHA-3-256 hex digest of arbitrary bytes.
fn sha3_hex(data: &[u8]) -> String {
    let mut hasher = Sha3_256::new();
    hasher.update(data);
    hex::encode(hasher.finalize())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn test_nonce(label: &str) -> String {
        format!("{label}-{}", uuid::Uuid::new_v4())
    }

    fn test_attestation_doc(label: &str) -> String {
        let seed = format!("attestation-doc:{label}:{}", uuid::Uuid::new_v4());
        sha3_hex(seed.as_bytes())
    }

    #[test]
    fn mock_attestation_roundtrip() {
        let gen = AttestationGenerator::new();
        let user_data = b"test-compliance-result";
        let nonce = test_nonce("roundtrip");

        let report = gen.generate_attestation(user_data, &nonce).unwrap();
        assert_eq!(report.platform, TeePlatform::Mock);
        assert!(!report.attestation_doc.is_empty());
        assert!(!report.measurement.is_empty());
        assert_eq!(report.nonce, nonce);

        let valid = gen.verify_attestation(&report, user_data).unwrap();
        assert!(valid, "attestation should verify with correct user data");
    }

    #[test]
    fn attestation_verification_fails_with_wrong_data() {
        let gen = AttestationGenerator::new();
        let nonce = test_nonce("wrong-data");
        let report = gen
            .generate_attestation(b"original-data", &nonce)
            .unwrap();

        let valid = gen.verify_attestation(&report, b"tampered-data").unwrap();
        assert!(!valid, "attestation should not verify with wrong user data");
    }

    #[test]
    fn attestation_to_bytes_decodes_hex() {
        let gen = AttestationGenerator::new();
        let nonce = test_nonce("to-bytes");
        let report = gen.generate_attestation(b"data", &nonce).unwrap();
        let bytes = AttestationGenerator::attestation_to_bytes(&report);
        assert_eq!(bytes.len(), 32); // SHA3-256 output
    }

    #[test]
    fn enclave_measurement_is_stable() {
        let m1 = AttestationGenerator::compute_enclave_measurement();
        let m2 = AttestationGenerator::compute_enclave_measurement();
        assert_eq!(m1, m2, "measurement should be deterministic");
    }

    #[test]
    fn different_nonces_produce_different_attestations() {
        let gen = AttestationGenerator::new();
        let nonce_a = test_nonce("nonce-a");
        let nonce_b = test_nonce("nonce-b");
        let r1 = gen.generate_attestation(b"data", &nonce_a).unwrap();
        let r2 = gen.generate_attestation(b"data", &nonce_b).unwrap();
        assert_ne!(
            r1.attestation_doc, r2.attestation_doc,
            "different nonces must produce different attestations"
        );
    }

    #[test]
    fn tee_platform_display() {
        assert_eq!(TeePlatform::Mock.to_string(), "mock");
        assert_eq!(TeePlatform::Nitro.to_string(), "nitro");
        assert_eq!(TeePlatform::Sgx.to_string(), "sgx");
        assert_eq!(TeePlatform::None.to_string(), "none");
    }

    #[test]
    fn sha3_hex_known_vector() {
        // SHA3-256("") = a7ffc6f8bf1ed76651c14756a061d662f580ff4de43b49fa82d80a4b80f8434a
        let hash = sha3_hex(b"");
        assert_eq!(
            hash,
            "a7ffc6f8bf1ed76651c14756a061d662f580ff4de43b49fa82d80a4b80f8434a"
        );
    }

    // -----------------------------------------------------------------------
    // SHA-3 hex determinism
    // -----------------------------------------------------------------------

    #[test]
    fn sha3_hex_deterministic() {
        let h1 = sha3_hex(b"test data");
        let h2 = sha3_hex(b"test data");
        assert_eq!(h1, h2);
    }

    #[test]
    fn sha3_hex_different_inputs_different_hashes() {
        let h1 = sha3_hex(b"input A");
        let h2 = sha3_hex(b"input B");
        assert_ne!(h1, h2);
    }

    #[test]
    fn sha3_hex_output_is_64_chars() {
        let hash = sha3_hex(b"anything");
        assert_eq!(hash.len(), 64);
    }

    // -----------------------------------------------------------------------
    // Attestation report fields
    // -----------------------------------------------------------------------

    #[test]
    fn attestation_report_has_correct_platform() {
        let gen = AttestationGenerator::new();
        let nonce = test_nonce("platform");
        let report = gen.generate_attestation(b"data", &nonce).unwrap();
        // Without any TEE feature, falls back to Mock platform identity
        assert_eq!(report.platform, TeePlatform::Mock);
    }

    #[test]
    fn attestation_report_user_data_hash_matches() {
        let gen = AttestationGenerator::new();
        let data = b"my compliance result";
        let report = gen.generate_attestation(data, "n1").unwrap();
        let expected_hash = sha3_hex(data);
        assert_eq!(report.user_data_hash, expected_hash);
    }

    #[test]
    fn attestation_report_nonce_stored() {
        let gen = AttestationGenerator::new();
        let nonce = test_nonce("stored");
        let report = gen.generate_attestation(b"data", &nonce).unwrap();
        assert_eq!(report.nonce, nonce);
    }

    #[test]
    fn attestation_certificate_chain_empty_in_mock() {
        let gen = AttestationGenerator::new();
        let nonce = test_nonce("cert-chain");
        let report = gen.generate_attestation(b"data", &nonce).unwrap();
        assert!(report.certificate_chain.is_empty());
    }

    // -----------------------------------------------------------------------
    // Verify with same data succeeds, different data fails
    // -----------------------------------------------------------------------

    #[test]
    fn verify_attestation_with_same_data_succeeds() {
        let gen = AttestationGenerator::new();
        let data = b"test-result";
        let report = gen.generate_attestation(data, "n").unwrap();
        assert!(gen.verify_attestation(&report, data).unwrap());
    }

    #[test]
    fn verify_attestation_with_different_data_fails() {
        let gen = AttestationGenerator::new();
        let report = gen.generate_attestation(b"original", "n").unwrap();
        assert!(!gen.verify_attestation(&report, b"different").unwrap());
    }

    // -----------------------------------------------------------------------
    // Same data and nonce produce same attestation doc
    // -----------------------------------------------------------------------

    #[test]
    fn same_inputs_same_timestamp_produce_same_doc() {
        let gen = AttestationGenerator::new();
        let ts = Utc::now();
        let nonce = test_nonce("same-inputs");
        let doc1 = gen.generate_mock_attestation(b"data", &nonce, &ts);
        let doc2 = gen.generate_mock_attestation(b"data", &nonce, &ts);
        assert_eq!(doc1, doc2);
    }

    // -----------------------------------------------------------------------
    // attestation_to_bytes with empty doc
    // -----------------------------------------------------------------------

    #[test]
    fn attestation_to_bytes_invalid_hex_returns_empty() {
        let report = AttestationReport {
            id: uuid::Uuid::new_v4(),
            platform: TeePlatform::Mock,
            measurement: String::new(),
            user_data_hash: String::new(),
            timestamp: Utc::now(),
            nonce: String::new(),
            attestation_doc: "not-valid-hex!".to_string(),
            certificate_chain: vec![],
        };
        let bytes = AttestationGenerator::attestation_to_bytes(&report);
        assert!(bytes.is_empty(), "Invalid hex should return empty vec");
    }

    // -----------------------------------------------------------------------
    // TeePlatform Display all variants
    // -----------------------------------------------------------------------

    #[test]
    fn tee_platform_display_all() {
        assert_eq!(format!("{}", TeePlatform::Mock), "mock");
        assert_eq!(format!("{}", TeePlatform::Nitro), "nitro");
        assert_eq!(format!("{}", TeePlatform::Sgx), "sgx");
        assert_eq!(format!("{}", TeePlatform::None), "none");
    }

    // -----------------------------------------------------------------------
    // Cover Nitro/SGX attestation error paths (lines 251-252, 270-271)
    // -----------------------------------------------------------------------

    #[test]
    fn generate_nitro_attestation_errors_without_feature() {
        let gen = AttestationGenerator::new();
        let nonce = test_nonce("nitro-generate");
        let result = gen.generate_nitro_attestation(b"data", &nonce, &Utc::now());
        // Without the nitro feature, this should error
        #[cfg(not(feature = "nitro"))]
        assert!(result.is_err(), "Nitro attestation should fail without nitro feature");
        #[cfg(feature = "nitro")]
        assert!(result.is_ok());
    }

    #[test]
    fn generate_sgx_attestation_errors_without_feature() {
        let gen = AttestationGenerator::new();
        let nonce = test_nonce("sgx-generate");
        let result = gen.generate_sgx_attestation(b"data", &nonce, &Utc::now());
        #[cfg(not(feature = "sgx"))]
        assert!(result.is_err(), "SGX attestation should fail without sgx feature");
        #[cfg(feature = "sgx")]
        assert!(result.is_ok());
    }

    // -----------------------------------------------------------------------
    // Cover Nitro/SGX verify stubs (lines 165, 170)
    // and debug log line 132
    // -----------------------------------------------------------------------

    #[test]
    fn verify_attestation_with_nitro_platform_report() {
        let gen = AttestationGenerator::new();
        let data = b"some-data";
        // Create a report manually with Nitro platform
        let report = AttestationReport {
            id: uuid::Uuid::new_v4(),
            platform: TeePlatform::Nitro,
            measurement: gen.enclave_measurement.clone(),
            user_data_hash: sha3_hex(data),
            timestamp: Utc::now(),
            nonce: test_nonce("nitro-report"),
            attestation_doc: test_attestation_doc("nitro-report"),
            certificate_chain: Vec::new(),
        };
        let result = gen.verify_attestation(&report, data);
        // Without mock-tee: Nitro verify returns Err (fail closed)
        // With mock-tee: Nitro verify returns Ok(true) (mocked)
        #[cfg(not(feature = "mock-tee"))]
        assert!(result.is_err(), "Nitro verification should fail closed without mock-tee");
        #[cfg(feature = "mock-tee")]
        assert!(result.unwrap());
    }

    #[test]
    fn verify_attestation_with_sgx_platform_report() {
        let gen = AttestationGenerator::new();
        let data = b"some-data";
        let report = AttestationReport {
            id: uuid::Uuid::new_v4(),
            platform: TeePlatform::Sgx,
            measurement: gen.enclave_measurement.clone(),
            user_data_hash: sha3_hex(data),
            timestamp: Utc::now(),
            nonce: test_nonce("sgx-report"),
            attestation_doc: test_attestation_doc("sgx-report"),
            certificate_chain: Vec::new(),
        };
        let result = gen.verify_attestation(&report, data);
        // Without mock-tee: SGX verify returns Err (fail closed)
        // With mock-tee: SGX verify returns Ok(true) (mocked)
        #[cfg(not(feature = "mock-tee"))]
        assert!(result.is_err(), "SGX verification should fail closed without mock-tee");
        #[cfg(feature = "mock-tee")]
        assert!(result.unwrap());
    }

    #[test]
    fn verify_attestation_nitro_wrong_data_fails() {
        let gen = AttestationGenerator::new();
        let report = AttestationReport {
            id: uuid::Uuid::new_v4(),
            platform: TeePlatform::Nitro,
            measurement: gen.enclave_measurement.clone(),
            user_data_hash: sha3_hex(b"original-data"),
            timestamp: Utc::now(),
            nonce: test_nonce("nitro-wrong-data"),
            attestation_doc: test_attestation_doc("nitro-wrong-data"),
            certificate_chain: Vec::new(),
        };
        // Wrong data should fail the user_data_hash check before reaching platform match
        let result = gen.verify_attestation(&report, b"wrong-data").unwrap();
        assert!(!result);
    }

    // -----------------------------------------------------------------------
    // Cover generate_attestation debug log (line 132)
    // -----------------------------------------------------------------------

    #[test]
    fn generate_attestation_produces_valid_report() {
        let gen = AttestationGenerator::new();
        let nonce = test_nonce("valid-report");
        let report = gen.generate_attestation(b"compliance-data", &nonce).unwrap();
        assert_eq!(report.platform, TeePlatform::Mock);
        assert!(!report.attestation_doc.is_empty());
        assert!(!report.measurement.is_empty());
        assert_eq!(report.nonce, nonce);
        // The debug log on line 132 is executed during this call
    }

    // -----------------------------------------------------------------------
    // Cover detect_platform (exercised via new())
    // -----------------------------------------------------------------------

    #[test]
    fn detect_platform_returns_mock_by_default() {
        let gen = AttestationGenerator::new();
        assert_eq!(gen.platform, TeePlatform::Mock);
    }

    // -----------------------------------------------------------------------
    // Cover Nitro/SGX arms in generate_attestation (lines 114-115)
    // by creating generators with forced platform
    // -----------------------------------------------------------------------

    #[test]
    fn generate_attestation_with_nitro_platform_errors() {
        let gen = AttestationGenerator {
            enclave_measurement: AttestationGenerator::compute_enclave_measurement(),
            platform: TeePlatform::Nitro,
        };
        let nonce = test_nonce("forced-nitro");
        let result = gen.generate_attestation(b"test-data", &nonce);
        // Without nitro feature: generate_nitro_attestation returns Err
        // With nitro feature: it would succeed (falls back to mock)
        #[cfg(not(feature = "nitro"))]
        assert!(result.is_err());
        #[cfg(feature = "nitro")]
        assert!(result.is_ok());
    }

    #[test]
    fn generate_attestation_with_sgx_platform_errors() {
        let gen = AttestationGenerator {
            enclave_measurement: AttestationGenerator::compute_enclave_measurement(),
            platform: TeePlatform::Sgx,
        };
        let nonce = test_nonce("forced-sgx");
        let result = gen.generate_attestation(b"test-data", &nonce);
        #[cfg(not(feature = "sgx"))]
        assert!(result.is_err());
        #[cfg(feature = "sgx")]
        assert!(result.is_ok());
    }

    // -----------------------------------------------------------------------
    // NP-09: Fail-closed verification tests (without mock-tee feature)
    // -----------------------------------------------------------------------

    #[cfg(not(feature = "mock-tee"))]
    #[test]
    fn nitro_verification_fails_closed_without_mock_tee() {
        let gen = AttestationGenerator::new();
        let data = b"compliance-result";
        let report = AttestationReport {
            id: uuid::Uuid::new_v4(),
            platform: TeePlatform::Nitro,
            measurement: gen.enclave_measurement.clone(),
            user_data_hash: sha3_hex(data),
            timestamp: Utc::now(),
            nonce: test_nonce("nitro-fail-closed"),
            attestation_doc: test_attestation_doc("nitro-fail-closed"),
            certificate_chain: Vec::new(),
        };
        let result = gen.verify_attestation(&report, data);
        assert!(result.is_err());
        let err_msg = result.unwrap_err().to_string();
        assert!(
            err_msg.contains("Nitro attestation verification not yet implemented"),
            "Error should indicate Nitro verification is not implemented, got: {}",
            err_msg
        );
    }

    #[cfg(not(feature = "mock-tee"))]
    #[test]
    fn sgx_verification_fails_closed_without_mock_tee() {
        let gen = AttestationGenerator::new();
        let data = b"compliance-result";
        let report = AttestationReport {
            id: uuid::Uuid::new_v4(),
            platform: TeePlatform::Sgx,
            measurement: gen.enclave_measurement.clone(),
            user_data_hash: sha3_hex(data),
            timestamp: Utc::now(),
            nonce: test_nonce("sgx-fail-closed"),
            attestation_doc: test_attestation_doc("sgx-fail-closed"),
            certificate_chain: Vec::new(),
        };
        let result = gen.verify_attestation(&report, data);
        assert!(result.is_err());
        let err_msg = result.unwrap_err().to_string();
        assert!(
            err_msg.contains("SGX attestation verification not yet implemented"),
            "Error should indicate SGX verification is not implemented, got: {}",
            err_msg
        );
    }

    #[cfg(feature = "mock-tee")]
    #[test]
    fn nitro_verification_passes_with_mock_tee() {
        let gen = AttestationGenerator::new();
        let data = b"compliance-result";
        let report = AttestationReport {
            id: uuid::Uuid::new_v4(),
            platform: TeePlatform::Nitro,
            measurement: gen.enclave_measurement.clone(),
            user_data_hash: sha3_hex(data),
            timestamp: Utc::now(),
            nonce: test_nonce("nitro-mock"),
            attestation_doc: test_attestation_doc("nitro-mock"),
            certificate_chain: Vec::new(),
        };
        let result = gen.verify_attestation(&report, data).unwrap();
        assert!(result, "With mock-tee, Nitro verification should pass");
    }

    #[cfg(feature = "mock-tee")]
    #[test]
    fn sgx_verification_passes_with_mock_tee() {
        let gen = AttestationGenerator::new();
        let data = b"compliance-result";
        let report = AttestationReport {
            id: uuid::Uuid::new_v4(),
            platform: TeePlatform::Sgx,
            measurement: gen.enclave_measurement.clone(),
            user_data_hash: sha3_hex(data),
            timestamp: Utc::now(),
            nonce: test_nonce("sgx-mock"),
            attestation_doc: test_attestation_doc("sgx-mock"),
            certificate_chain: Vec::new(),
        };
        let result = gen.verify_attestation(&report, data).unwrap();
        assert!(result, "With mock-tee, SGX verification should pass");
    }

    // -----------------------------------------------------------------------
    // TeePlatform::None — fail-closed attestation tests
    // -----------------------------------------------------------------------

    #[test]
    fn none_platform_generate_attestation_fails() {
        let gen = AttestationGenerator {
            enclave_measurement: AttestationGenerator::compute_enclave_measurement(),
            platform: TeePlatform::None,
        };
        let nonce = test_nonce("none-generate");
        let result = gen.generate_attestation(b"data", &nonce);
        assert!(result.is_err(), "None platform must refuse to generate attestation");
        let err_msg = result.unwrap_err().to_string();
        assert!(
            err_msg.contains("No TEE platform available"),
            "Error should mention no TEE platform, got: {}",
            err_msg
        );
    }

    #[test]
    fn none_platform_verify_attestation_fails() {
        let gen = AttestationGenerator {
            enclave_measurement: AttestationGenerator::compute_enclave_measurement(),
            platform: TeePlatform::Mock, // use Mock to generate
        };
        let data = b"some-data";
        let report = AttestationReport {
            id: uuid::Uuid::new_v4(),
            platform: TeePlatform::None,
            measurement: gen.enclave_measurement.clone(),
            user_data_hash: sha3_hex(data),
            timestamp: Utc::now(),
            nonce: test_nonce("none-verify"),
            attestation_doc: test_attestation_doc("none-verify"),
            certificate_chain: Vec::new(),
        };
        let result = gen.verify_attestation(&report, data);
        assert!(result.is_err(), "None platform must refuse to verify attestation");
    }

    #[test]
    fn platform_accessor_returns_correct_value() {
        let gen = AttestationGenerator::new();
        // In test mode without features, should be Mock
        assert_eq!(gen.platform(), TeePlatform::Mock);
    }
}
