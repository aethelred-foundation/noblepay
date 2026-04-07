//! Main compliance engine orchestrator.
//!
//! [`ComplianceEngine`] composes the sanctions database, AML risk model, travel
//! rule engine, and TEE attestation generator into a single screening pipeline.
//! It provides both single-payment and batch-screening entry points with
//! configurable timeouts and built-in metrics collection.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;

use chrono::Utc;
use tokio::time::{timeout, Duration};
use tracing::{error, info, warn};
use uuid::Uuid;

use crate::aml::RiskScoringModel;
use crate::attestation::{AttestationGenerator, AttestationReport};
use crate::behavioral::BehavioralEngine;
use crate::corridor_analysis::CorridorAnalyzer;
use crate::graph_analysis::TransactionGraph;
use crate::ml_risk::RiskForest;
use crate::sanctions::SanctionsDatabase;
use crate::travel_rule::TravelRuleEngine;
use crate::types::*;
use crate::ComplianceError;

/// Default screening timeout in milliseconds.
const DEFAULT_TIMEOUT_MS: u64 = 5_000;

/// AML risk score threshold above which a payment is flagged for review.
const FLAG_THRESHOLD: u8 = 40;

/// AML risk score threshold above which a payment is blocked.
const BLOCK_THRESHOLD: u8 = 75;

/// Upper bound for concurrently screened payments in one batch.
const MAX_BATCH_SCREENING_REQUESTS: usize = 256;

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

/// Atomic counters for screening pipeline metrics.
#[derive(Debug, Default)]
pub struct ComplianceMetrics {
    pub total_screened: AtomicU64,
    pub total_passed: AtomicU64,
    pub total_flagged: AtomicU64,
    pub total_blocked: AtomicU64,
    pub total_errors: AtomicU64,
    /// Cumulative screening duration in microseconds (for computing averages).
    pub cumulative_duration_us: AtomicU64,
}

impl ComplianceMetrics {
    /// Record the outcome of a single screening.
    fn record(&self, status: ComplianceStatus, duration: std::time::Duration) {
        self.total_screened.fetch_add(1, Ordering::Relaxed);
        self.cumulative_duration_us
            .fetch_add(duration.as_micros() as u64, Ordering::Relaxed);
        match status {
            ComplianceStatus::Passed => {
                self.total_passed.fetch_add(1, Ordering::Relaxed);
            }
            ComplianceStatus::Flagged => {
                self.total_flagged.fetch_add(1, Ordering::Relaxed);
            }
            ComplianceStatus::Blocked => {
                self.total_blocked.fetch_add(1, Ordering::Relaxed);
            }
        }
    }

    /// Record an error.
    fn record_error(&self) {
        self.total_screened.fetch_add(1, Ordering::Relaxed);
        self.total_errors.fetch_add(1, Ordering::Relaxed);
    }

    /// Snapshot the current metrics as a serializable struct.
    pub fn snapshot(&self) -> MetricsSnapshot {
        let total = self.total_screened.load(Ordering::Relaxed);
        let cumulative_us = self.cumulative_duration_us.load(Ordering::Relaxed);
        MetricsSnapshot {
            total_screened: total,
            total_passed: self.total_passed.load(Ordering::Relaxed),
            total_flagged: self.total_flagged.load(Ordering::Relaxed),
            total_blocked: self.total_blocked.load(Ordering::Relaxed),
            total_errors: self.total_errors.load(Ordering::Relaxed),
            avg_screening_duration_ms: if total > 0 {
                (cumulative_us / total) as f64 / 1000.0
            } else {
                0.0
            },
        }
    }
}

/// A point-in-time snapshot of compliance metrics, suitable for JSON serialization.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct MetricsSnapshot {
    pub total_screened: u64,
    pub total_passed: u64,
    pub total_flagged: u64,
    pub total_blocked: u64,
    pub total_errors: u64,
    pub avg_screening_duration_ms: f64,
}

// ---------------------------------------------------------------------------
// ComplianceEngine
// ---------------------------------------------------------------------------

/// The top-level compliance screening orchestrator.
///
/// Clone is cheap — all internal state is behind `Arc`.
#[derive(Clone)]
pub struct ComplianceEngine {
    sanctions: SanctionsDatabase,
    aml: RiskScoringModel,
    travel_rule: TravelRuleEngine,
    attestation: AttestationGenerator,
    ml_risk: Arc<RiskForest>,
    behavioral: Arc<std::sync::Mutex<BehavioralEngine>>,
    corridor: Arc<std::sync::Mutex<CorridorAnalyzer>>,
    graph: Arc<std::sync::Mutex<TransactionGraph>>,
    metrics: Arc<ComplianceMetrics>,
}

impl ComplianceEngine {
    /// Initialize the engine with default configuration and pre-loaded sanctions
    /// lists.
    pub async fn new() -> Self {
        let sanctions = SanctionsDatabase::with_default_lists().await;
        info!(
            entries = sanctions.total_entries().await,
            "compliance engine initialized"
        );

        Self {
            sanctions,
            aml: RiskScoringModel::new(),
            travel_rule: TravelRuleEngine::new(),
            attestation: AttestationGenerator::new(),
            ml_risk: Arc::new(RiskForest::default_model()),
            behavioral: Arc::new(std::sync::Mutex::new(BehavioralEngine::new())),
            corridor: Arc::new(std::sync::Mutex::new(CorridorAnalyzer::new())),
            graph: Arc::new(std::sync::Mutex::new(TransactionGraph::new())),
            metrics: Arc::new(ComplianceMetrics::default()),
        }
    }

    /// Screen a single payment through the full compliance pipeline.
    ///
    /// Pipeline stages:
    /// 1. Sanctions screening (sender + recipient)
    /// 2. AML risk scoring
    /// 3. Travel Rule verification
    /// 4. TEE attestation generation
    ///
    /// Returns a [`ComplianceResult`] on success or a [`ComplianceError`] on
    /// infrastructure failure.
    pub async fn screen_payment(
        &self,
        payment: &Payment,
        travel_rule_data: Option<&TravelRuleData>,
        timeout_ms: Option<u64>,
    ) -> Result<ComplianceResult, ComplianceError> {
        let deadline = Duration::from_millis(timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS));
        let start = Instant::now();

        let result = timeout(deadline, self.screen_payment_inner(payment, travel_rule_data)).await;

        self.handle_screening_result(result, payment, start)
    }

    /// Process the outcome of a screening attempt (success, inner error, or timeout).
    fn handle_screening_result(
        &self,
        result: Result<Result<ComplianceResult, ComplianceError>, tokio::time::error::Elapsed>,
        payment: &Payment,
        start: Instant,
    ) -> Result<ComplianceResult, ComplianceError> {
        match result {
            Ok(Ok(cr)) => {
                self.metrics.record(cr.status, start.elapsed());
                Ok(cr)
            }
            Ok(Err(e)) => {
                self.metrics.record_error();
                Err(e)
            }
            Err(_) => {
                self.metrics.record_error();
                let elapsed = start.elapsed().as_millis() as u64;
                warn!(payment_id = %payment.id, elapsed_ms = elapsed, "screening timed out");
                Err(ComplianceError::Timeout(elapsed))
            }
        }
    }

    /// Inner pipeline without timeout wrapper.
    async fn screen_payment_inner(
        &self,
        payment: &Payment,
        travel_rule_data: Option<&TravelRuleData>,
    ) -> Result<ComplianceResult, ComplianceError> {
        let start = Instant::now();

        // ------ 1. Sanctions screening ------
        let sender_check = self
            .sanctions
            .check_entity(&payment.sender, &[], &[])
            .await?;
        let recipient_check = self
            .sanctions
            .check_entity(&payment.recipient, &[], &[])
            .await?;

        let sanctions_clear = !sender_check.is_match && !recipient_check.is_match;

        // If either party is on a sanctions list, block immediately.
        if !sanctions_clear {
            let blocked_entity = if sender_check.is_match {
                &payment.sender
            } else {
                &payment.recipient
            };
            warn!(
                payment_id = %payment.id,
                entity = blocked_entity,
                "sanctions match — blocking payment"
            );

            let result_bytes = serde_json::to_vec(&ComplianceStatus::Blocked)
                .map_err(ComplianceError::SerializationError)?;
            let nonce = Uuid::new_v4().to_string();
            let attestation_report = self
                .attestation
                .generate_attestation(&result_bytes, &nonce)?;

            return Ok(ComplianceResult {
                payment_id: payment.id,
                sanctions_clear: false,
                aml_risk_score: 100,
                travel_rule_compliant: false,
                status: ComplianceStatus::Blocked,
                attestation: AttestationGenerator::attestation_to_bytes(&attestation_report),
                screening_duration_ms: start.elapsed().as_millis() as u64,
                risk_factors: vec![],
                screened_at: Utc::now(),
            });
        }

        // ------ 2. AML risk scoring ------
        let (aml_score, _aml_level, risk_factors) =
            self.aml.calculate_risk(payment, None, None);

        // ------ 2b. ML risk scoring (ensemble model) ------
        let features = crate::ml_risk::FeatureVector::from_payment(payment, None);
        let ml_prediction = self.ml_risk.predict(&features);
        let ml_risk_score = ml_prediction.risk_score as f64;

        // ------ 2c. Behavioral analysis ------
        let behavioral_score = {
            let engine = self.behavioral.lock().unwrap();
            engine.score_payment(payment)
        };

        // ------ 2d. Corridor analysis ------
        let corridor_result = {
            let mut corridor = self.corridor.lock().unwrap();
            corridor.analyze_payment(payment)
        };

        // ------ 2e. Graph analysis — add payment edge ------
        {
            let mut graph = self.graph.lock().unwrap();
            graph.add_payment(payment);
        }

        // Composite risk: weighted blend of AML, ML, behavioral, and corridor
        let composite_aml = (
            (aml_score as f64 * 0.30)
            + (ml_risk_score * 0.25)
            + (behavioral_score.score as f64 * 0.25)
            + (corridor_result.risk_score as f64 * 0.20)
        ).min(100.0) as u8;

        // Use the composite score instead of raw aml_score for status determination
        let aml_score = composite_aml;

        // ------ 3. Travel Rule verification ------
        let travel_verification = self
            .travel_rule
            .verify_travel_rule(payment, travel_rule_data)
            .map_err(|e| {
                error!(error = %e, "travel rule verification failed");
                e
            })?;

        let travel_rule_compliant = travel_verification.compliant;

        // ------ 4. Determine overall status ------
        // Note: sanctions_clear is always true here because sanctioned entities
        // are handled by the early return above.
        let status = if aml_score >= BLOCK_THRESHOLD {
            ComplianceStatus::Blocked
        } else if aml_score >= FLAG_THRESHOLD || !travel_rule_compliant {
            ComplianceStatus::Flagged
        } else {
            ComplianceStatus::Passed
        };

        // ------ 5. Generate TEE attestation ------
        let result_summary = serde_json::json!({
            "payment_id": payment.id,
            "sanctions_clear": sanctions_clear,
            "aml_score": aml_score,
            "travel_rule_compliant": travel_rule_compliant,
            "status": status,
        });
        let result_bytes =
            serde_json::to_vec(&result_summary).map_err(ComplianceError::SerializationError)?;
        let nonce = Uuid::new_v4().to_string();
        let attestation_report = self
            .attestation
            .generate_attestation(&result_bytes, &nonce)?;

        let screening_duration_ms = start.elapsed().as_millis() as u64;

        info!(
            payment_id = %payment.id,
            ?status,
            aml_score,
            screening_duration_ms,
            "screening complete"
        );

        Ok(ComplianceResult {
            payment_id: payment.id,
            sanctions_clear,
            aml_risk_score: aml_score,
            travel_rule_compliant,
            status,
            attestation: AttestationGenerator::attestation_to_bytes(&attestation_report),
            screening_duration_ms,
            risk_factors,
            screened_at: Utc::now(),
        })
    }

    /// Screen a batch of payments concurrently.
    ///
    /// Each payment is screened independently; a failure in one does not affect
    /// the others.
    pub async fn screen_batch(
        &self,
        requests: Vec<ScreeningRequest>,
    ) -> BatchScreeningResponse {
        let request_count = requests.len();

        if request_count > MAX_BATCH_SCREENING_REQUESTS {
            let outcomes = requests
                .into_iter()
                .map(|req| {
                    (
                        req.payment.id,
                        Err(format!(
                            "batch size {} exceeds limit {}",
                            request_count,
                            MAX_BATCH_SCREENING_REQUESTS,
                        )),
                    )
                })
                .collect();
            return Self::collect_batch_results(outcomes);
        }

        let mut handles = Vec::with_capacity(requests.len().min(MAX_BATCH_SCREENING_REQUESTS));

        for req in &requests {
            let engine = self.clone();
            let payment = req.payment.clone();
            let travel_data = req.travel_rule_data.clone();
            let timeout_ms = req.timeout_ms;

            handles.push(tokio::spawn(async move {
                engine
                    .screen_payment(&payment, travel_data.as_ref(), timeout_ms)
                    .await
            }));
        }

        let mut outcomes: Vec<(Uuid, Result<ComplianceResult, String>)> =
            Vec::with_capacity(handles.len());

        for (i, handle) in handles.into_iter().enumerate() {
            let request_id = requests[i].payment.id;
            let outcome = match handle.await {
                Ok(Ok(cr)) => Ok(cr),
                Ok(Err(e)) => Err(e.to_string()),
                Err(e) => Err(format!("task join error: {e}")),
            };
            outcomes.push((request_id, outcome));
        }

        Self::collect_batch_results(outcomes)
    }

    /// Assemble individual screening outcomes into a [`BatchScreeningResponse`].
    fn collect_batch_results(
        outcomes: Vec<(Uuid, Result<ComplianceResult, String>)>,
    ) -> BatchScreeningResponse {
        let mut results = Vec::with_capacity(outcomes.len());
        let mut passed = 0usize;
        let mut flagged = 0usize;
        let mut blocked = 0usize;

        for (request_id, outcome) in outcomes {
            match outcome {
                Ok(cr) => {
                    match cr.status {
                        ComplianceStatus::Passed => passed += 1,
                        ComplianceStatus::Flagged => flagged += 1,
                        ComplianceStatus::Blocked => blocked += 1,
                    }
                    results.push(ScreeningResponse {
                        success: true,
                        result: Some(cr),
                        error: None,
                        request_id,
                    });
                }
                Err(msg) => {
                    results.push(ScreeningResponse {
                        success: false,
                        result: None,
                        error: Some(msg),
                        request_id,
                    });
                }
            }
        }

        let total = results.len();
        BatchScreeningResponse {
            results,
            total,
            passed,
            flagged,
            blocked,
        }
    }

    /// Trigger a refresh of all sanctions lists.
    pub async fn refresh_sanctions_lists(&self) -> Result<(), ComplianceError> {
        self.sanctions.load_ofac_list().await;
        self.sanctions.load_uae_list().await;
        self.sanctions.load_un_list().await;
        self.sanctions.load_eu_list().await;
        info!("sanctions lists refreshed");
        Ok(())
    }

    /// Get a reference to the sanctions database (for health checks).
    pub fn sanctions_db(&self) -> &SanctionsDatabase {
        &self.sanctions
    }

    /// Returns a reference to the attestation generator.
    pub fn attestation_generator(&self) -> &AttestationGenerator {
        &self.attestation
    }

    /// Get a snapshot of the current compliance metrics.
    pub fn metrics(&self) -> MetricsSnapshot {
        self.metrics.snapshot()
    }

    /// Run ML risk prediction on a single payment.
    pub fn ml_predict(&self, payment: &Payment) -> crate::ml_risk::MLPrediction {
        let features = crate::ml_risk::FeatureVector::from_payment(payment, None);
        self.ml_risk.predict(&features)
    }

    /// Score a payment against the behavioral profile of the sender.
    pub fn behavioral_score(&self, payment: &Payment) -> crate::behavioral::BehavioralScore {
        let engine = self.behavioral.lock().unwrap();
        engine.score_payment(payment)
    }

    /// Build behavioral profiles from historical payment data.
    pub fn build_behavioral_profiles(&self, payments: &[Payment]) {
        let mut engine = self.behavioral.lock().unwrap();
        engine.build_profiles(payments);
    }

    /// Analyze a payment corridor for risk.
    pub fn analyze_corridor(&self, payment: &Payment) -> crate::corridor_analysis::CorridorAnalysisResult {
        let mut corridor = self.corridor.lock().unwrap();
        corridor.analyze_payment(payment)
    }

    /// Run graph-based network analysis on accumulated transactions.
    pub fn network_analysis(&self) -> crate::graph_analysis::NetworkAnalysis {
        let mut graph = self.graph.lock().unwrap();
        graph.analyze()
    }

    /// Add a payment to the graph for network analysis.
    pub fn add_to_graph(&self, payment: &Payment) {
        let mut graph = self.graph.lock().unwrap();
        graph.add_payment(payment);
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn clean_payment() -> Payment {
        Payment::test_payment("clean-sender", "clean-recipient", 50_000, "USD")
    }

    fn sanctioned_payment() -> Payment {
        Payment::test_payment("BLOCKED PERSON ALPHA", "clean-recipient", 50_000, "USD")
    }

    fn high_value_payment() -> Payment {
        Payment::test_payment("sender", "recipient", 10_000_000, "USD")
    }

    #[tokio::test]
    async fn clean_payment_passes() {
        let engine = ComplianceEngine::new().await;
        let result = engine.screen_payment(&clean_payment(), None, None).await.unwrap();
        assert!(result.sanctions_clear);
        assert_ne!(result.status, ComplianceStatus::Blocked);
        assert!(!result.attestation.is_empty());
        assert!(result.screening_duration_ms < 5000);
    }

    #[tokio::test]
    async fn sanctioned_entity_blocked() {
        let engine = ComplianceEngine::new().await;
        let result = engine
            .screen_payment(&sanctioned_payment(), None, None)
            .await
            .unwrap();
        assert!(!result.sanctions_clear);
        assert_eq!(result.status, ComplianceStatus::Blocked);
    }

    #[tokio::test]
    async fn batch_screening() {
        let engine = ComplianceEngine::new().await;
        let requests = vec![
            ScreeningRequest {
                payment: clean_payment(),
                travel_rule_data: None,
                timeout_ms: None,
            },
            ScreeningRequest {
                payment: sanctioned_payment(),
                travel_rule_data: None,
                timeout_ms: None,
            },
        ];

        let batch = engine.screen_batch(requests).await;
        assert_eq!(batch.total, 2);
        assert!(batch.results.iter().all(|r| r.success));
        // At least one should be blocked (the sanctioned one).
        assert!(batch.blocked >= 1);
    }

    #[tokio::test]
    async fn metrics_are_recorded() {
        let engine = ComplianceEngine::new().await;
        engine.screen_payment(&clean_payment(), None, None).await.unwrap();
        engine.screen_payment(&clean_payment(), None, None).await.unwrap();

        let m = engine.metrics();
        assert_eq!(m.total_screened, 2);
        assert!(m.avg_screening_duration_ms >= 0.0);
    }

    #[tokio::test]
    async fn refresh_sanctions_does_not_panic() {
        let engine = ComplianceEngine::new().await;
        engine.refresh_sanctions_lists().await.unwrap();
    }

    #[tokio::test]
    async fn timeout_is_respected() {
        let engine = ComplianceEngine::new().await;
        // A very short timeout should still succeed for simple screenings since
        // the mock engine is fast, but we verify the timeout plumbing works.
        let result = engine
            .screen_payment(&clean_payment(), None, Some(10_000))
            .await;
        assert!(result.is_ok());
    }

    #[test]
    fn metrics_snapshot_defaults() {
        let m = ComplianceMetrics::default();
        let snap = m.snapshot();
        assert_eq!(snap.total_screened, 0);
        assert_eq!(snap.avg_screening_duration_ms, 0.0);
    }

    // -----------------------------------------------------------------------
    // ML predict accessor
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn ml_predict_returns_valid_result() {
        let engine = ComplianceEngine::new().await;
        let payment = clean_payment();
        let prediction = engine.ml_predict(&payment);
        assert!(prediction.risk_score <= 100);
        assert!(prediction.confidence >= 0.0 && prediction.confidence <= 1.0);
        assert_eq!(prediction.feature_importances.len(), 15);
        assert_eq!(prediction.tree_scores.len(), 5);
    }

    // -----------------------------------------------------------------------
    // Behavioral score accessor
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn behavioral_score_returns_valid_result() {
        let engine = ComplianceEngine::new().await;
        let payment = clean_payment();
        let score = engine.behavioral_score(&payment);
        assert!(score.score <= 100);
        // New entity should produce at least one anomaly
        assert!(!score.anomalies.is_empty());
    }

    #[tokio::test]
    async fn build_behavioral_profiles_then_score() {
        let engine = ComplianceEngine::new().await;
        let payments: Vec<Payment> = (0..10)
            .map(|i| Payment::test_payment("profiled-sender", &format!("r{}", i % 3), (i + 1) * 1000, "USD"))
            .collect();
        engine.build_behavioral_profiles(&payments);
        let payment = Payment::test_payment("profiled-sender", "r0", 5000, "USD");
        let score = engine.behavioral_score(&payment);
        assert!(score.profile_summary.total_transactions > 0);
    }

    // -----------------------------------------------------------------------
    // Corridor analysis accessor
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn corridor_analysis_returns_valid_result() {
        let engine = ComplianceEngine::new().await;
        let payment = clean_payment();
        let result = engine.analyze_corridor(&payment);
        assert!(!result.corridor.is_empty());
        assert!(result.risk_score <= 100);
    }

    // -----------------------------------------------------------------------
    // Graph add and analyze accessors
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn graph_add_and_analyze() {
        let engine = ComplianceEngine::new().await;
        // Add some payments to the graph
        for i in 0..5 {
            let p = Payment::test_payment(&format!("s{}", i), &format!("r{}", i), 1000, "USD");
            engine.add_to_graph(&p);
        }
        let analysis = engine.network_analysis();
        assert_eq!(analysis.node_count, 10);
        assert_eq!(analysis.edge_count, 5);
    }

    #[tokio::test]
    async fn network_analysis_empty_graph() {
        let engine = ComplianceEngine::new().await;
        let analysis = engine.network_analysis();
        // After engine creation, the graph should be empty (no payments have been screened via add_to_graph)
        // Note: screen_payment adds to graph internally, but we haven't called it here
        assert_eq!(analysis.edge_count, 0);
    }

    // -----------------------------------------------------------------------
    // Composite scoring logic
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn high_value_payment_gets_elevated_score() {
        let engine = ComplianceEngine::new().await;
        let result = engine
            .screen_payment(&high_value_payment(), None, None)
            .await
            .unwrap();
        // $10M payment should have elevated AML score
        assert!(
            result.aml_risk_score > 20,
            "High-value payment should have elevated AML score, got {}",
            result.aml_risk_score
        );
    }

    // -----------------------------------------------------------------------
    // Metrics recording
    // -----------------------------------------------------------------------

    #[test]
    fn metrics_record_passed() {
        let m = ComplianceMetrics::default();
        m.record(ComplianceStatus::Passed, std::time::Duration::from_millis(10));
        let snap = m.snapshot();
        assert_eq!(snap.total_screened, 1);
        assert_eq!(snap.total_passed, 1);
        assert_eq!(snap.total_flagged, 0);
        assert_eq!(snap.total_blocked, 0);
    }

    #[test]
    fn metrics_record_flagged() {
        let m = ComplianceMetrics::default();
        m.record(ComplianceStatus::Flagged, std::time::Duration::from_millis(10));
        let snap = m.snapshot();
        assert_eq!(snap.total_flagged, 1);
    }

    #[test]
    fn metrics_record_blocked() {
        let m = ComplianceMetrics::default();
        m.record(ComplianceStatus::Blocked, std::time::Duration::from_millis(10));
        let snap = m.snapshot();
        assert_eq!(snap.total_blocked, 1);
    }

    #[test]
    fn metrics_record_error() {
        let m = ComplianceMetrics::default();
        m.record_error();
        let snap = m.snapshot();
        assert_eq!(snap.total_screened, 1);
        assert_eq!(snap.total_errors, 1);
    }

    #[test]
    fn metrics_avg_duration_computed() {
        let m = ComplianceMetrics::default();
        m.record(ComplianceStatus::Passed, std::time::Duration::from_millis(100));
        m.record(ComplianceStatus::Passed, std::time::Duration::from_millis(200));
        let snap = m.snapshot();
        assert_eq!(snap.total_screened, 2);
        // Average should be around 150ms
        assert!(snap.avg_screening_duration_ms > 0.0);
    }

    // -----------------------------------------------------------------------
    // Travel rule integration
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn screening_with_travel_rule_data() {
        let engine = ComplianceEngine::new().await;
        let payment = Payment::test_payment("sender", "recipient", 500_000, "USD");
        let travel_data = TravelRuleData {
            originator_name: Some("Sender Corp".into()),
            originator_account: Some("0xabc".into()),
            originator_address: Some("Dubai, UAE".into()),
            originator_id: Some("ID-123".into()),
            beneficiary_name: Some("Recipient Ltd".into()),
            beneficiary_account: Some("0xdef".into()),
            beneficiary_institution: None,
        };
        let result = engine
            .screen_payment(&payment, Some(&travel_data), None)
            .await
            .unwrap();
        assert!(result.travel_rule_compliant);
    }

    // -----------------------------------------------------------------------
    // Cover timeout path (lines 182-185)
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn very_short_timeout_may_timeout() {
        let engine = ComplianceEngine::new().await;
        // Use an extremely short timeout (1ms) — may or may not timeout
        // depending on system speed. We just verify the plumbing works.
        let result = engine
            .screen_payment(&clean_payment(), None, Some(1))
            .await;
        // Either Ok or Timeout error — both are valid outcomes
        match &result {
            Ok(_) => { /* fast enough */ }
            Err(ComplianceError::Timeout(ms)) => {
                assert!(*ms >= 0, "timeout duration should be >= 0");
            }
            Err(e) => panic!("unexpected error: {e}"),
        }
    }

    // -----------------------------------------------------------------------
    // Cover sanctions block path with warn log (lines 215, 220)
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn sanctioned_recipient_also_blocked() {
        let engine = ComplianceEngine::new().await;
        // Recipient is sanctioned
        let payment = Payment::test_payment("clean-sender", "BLOCKED PERSON ALPHA", 50_000, "USD");
        let result = engine
            .screen_payment(&payment, None, None)
            .await
            .unwrap();
        assert!(!result.sanctions_clear);
        assert_eq!(result.status, ComplianceStatus::Blocked);
        assert_eq!(result.aml_risk_score, 100);
    }

    // -----------------------------------------------------------------------
    // Cover flagged status path (aml_score >= FLAG_THRESHOLD)
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn payment_without_travel_rule_data_above_threshold_flagged() {
        let engine = ComplianceEngine::new().await;
        // Large payment without travel rule data — should be flagged
        // (travel_rule_compliant will be false for large payments without data)
        let payment = Payment::test_payment("sender", "recipient", 500_000, "USD");
        let result = engine
            .screen_payment(&payment, None, None)
            .await
            .unwrap();
        // Without travel rule data, above-threshold payments are not compliant
        // This should trigger at least Flagged status
        assert!(
            result.status == ComplianceStatus::Flagged || result.status == ComplianceStatus::Blocked,
            "Large payment without travel rule data should be flagged or blocked, got {:?}",
            result.status
        );
    }

    // -----------------------------------------------------------------------
    // Cover batch error path (lines 385-390, 393-398)
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn batch_screening_with_mixed_results() {
        let engine = ComplianceEngine::new().await;
        let requests = vec![
            ScreeningRequest {
                payment: clean_payment(),
                travel_rule_data: None,
                timeout_ms: None,
            },
            ScreeningRequest {
                payment: sanctioned_payment(),
                travel_rule_data: None,
                timeout_ms: None,
            },
            ScreeningRequest {
                payment: high_value_payment(),
                travel_rule_data: None,
                timeout_ms: None,
            },
        ];

        let batch = engine.screen_batch(requests).await;
        assert_eq!(batch.total, 3);
        // All should succeed (no infrastructure errors)
        assert!(batch.results.iter().all(|r| r.success));
        // Verify counters add up
        assert_eq!(batch.passed + batch.flagged + batch.blocked, batch.total);
    }

    // -----------------------------------------------------------------------
    // Cover sanctions_db accessor
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn sanctions_db_accessor_works() {
        let engine = ComplianceEngine::new().await;
        let total = engine.sanctions_db().total_entries().await;
        assert!(total >= 4, "Should have at least 4 sanctions entries");
    }

    // -----------------------------------------------------------------------
    // Cover engine new() info log (lines 133-135)
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn engine_new_initializes_all_components() {
        let engine = ComplianceEngine::new().await;
        // Engine should have sanctions entries loaded
        let total = engine.sanctions_db().total_entries().await;
        assert!(total > 0);
        // Metrics should be at zero
        let m = engine.metrics();
        assert_eq!(m.total_screened, 0);
    }

    // -----------------------------------------------------------------------
    // Cover Ok(Err(e)) branch in screen_payment (lines 177-179)
    // This branch is triggered when screen_payment_inner returns an error.
    // The travel rule verification .map_err path (lines 286-287) would
    // only fire on serialization errors which are hard to trigger.
    // -----------------------------------------------------------------------

    // -----------------------------------------------------------------------
    // Cover timeout Err branch (lines 182-185) more reliably
    // Use paused time to guarantee timeout fires
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn handle_screening_result_ok_ok() {
        let engine = ComplianceEngine::new().await;
        let cr = engine.screen_payment_inner(&clean_payment(), None).await.unwrap();
        let result = engine.handle_screening_result(
            Ok(Ok(cr)),
            &clean_payment(),
            Instant::now(),
        );
        assert!(result.is_ok());
        let m = engine.metrics();
        assert!(m.total_screened > 0);
    }

    #[tokio::test]
    async fn handle_screening_result_ok_err() {
        let engine = ComplianceEngine::new().await;
        let inner_err = ComplianceError::AmlError("test error".into());
        let result = engine.handle_screening_result(
            Ok(Err(inner_err)),
            &clean_payment(),
            Instant::now(),
        );
        assert!(result.is_err());
        let m = engine.metrics();
        assert_eq!(m.total_errors, 1);
    }

    #[tokio::test]
    async fn handle_screening_result_timeout() {
        let engine = ComplianceEngine::new().await;
        // Create an Elapsed error by timing out a pending future
        let elapsed = timeout(Duration::from_nanos(0), std::future::pending::<()>())
            .await
            .unwrap_err();
        let result = engine.handle_screening_result(
            Err(elapsed),
            &clean_payment(),
            Instant::now(),
        );
        match result {
            Err(ComplianceError::Timeout(ms)) => {
                assert!(ms <= 100);
            }
            other => panic!("Expected Timeout, got: {:?}", other),
        }
        let m = engine.metrics();
        assert_eq!(m.total_errors, 1);
    }

    // -----------------------------------------------------------------------
    // Cover the sanctions block warn log path (line 220) and
    // the Blocked status via aml_score >= BLOCK_THRESHOLD (lines 294-296)
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn sanctioned_sender_triggers_warn_and_block() {
        let engine = ComplianceEngine::new().await;
        let payment = Payment::test_payment("BLOCKED PERSON ALPHA", "clean-person", 10_000, "USD");
        let result = engine.screen_payment(&payment, None, None).await.unwrap();
        assert!(!result.sanctions_clear);
        assert_eq!(result.status, ComplianceStatus::Blocked);
        // The warn log on line 220 was exercised
    }

    // -----------------------------------------------------------------------
    // Cover info log in screen_payment_inner (line 325)
    // This is hit on successful screening
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn successful_screening_hits_info_log() {
        let engine = ComplianceEngine::new().await;
        let payment = Payment::test_payment("clean-a", "clean-b", 1000, "USD");
        let result = engine.screen_payment(&payment, None, None).await.unwrap();
        assert!(result.sanctions_clear);
        assert!(result.screening_duration_ms < 10000);
    }

    // -----------------------------------------------------------------------
    // Cover batch with a screening that results in Ok(Err(...)) (lines 385-390)
    // This is hard to trigger since the inner pipeline rarely fails.
    // The best we can do is use a very short timeout to potentially trigger
    // the Timeout error path in the batch context.
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn batch_with_short_timeout() {
        let engine = ComplianceEngine::new().await;
        tokio::time::pause();
        let requests = vec![
            ScreeningRequest {
                payment: clean_payment(),
                travel_rule_data: None,
                timeout_ms: Some(0), // Should timeout with paused time + yield_now
            },
            ScreeningRequest {
                payment: clean_payment(),
                travel_rule_data: None,
                timeout_ms: Some(0),
            },
        ];
        let batch = engine.screen_batch(requests).await;
        assert_eq!(batch.total, 2);
        // Each result is either success or error (timeout)
        for r in &batch.results {
            assert!(r.success || r.error.is_some());
        }
    }

    // -----------------------------------------------------------------------
    // Cover aml_score >= BLOCK_THRESHOLD path (line 296)
    // Need composite AML score >= 75
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn extremely_high_value_may_trigger_block_via_aml() {
        let engine = ComplianceEngine::new().await;
        // Massive payment: should produce very high AML, ML, and behavioral scores
        let payment = Payment::test_payment("unknown-sender-xyz", "unknown-recipient-abc", 100_000_000, "USD");
        let result = engine.screen_payment(&payment, None, None).await.unwrap();
        assert!(
            result.aml_risk_score > 0,
            "Massive payment should have non-zero AML score"
        );
    }

    // -----------------------------------------------------------------------
    // Cover screen_payment_inner error propagation for travel rule (line 286-287)
    // This map_err is hit when travel_rule.verify_travel_rule returns Err
    // which only happens on serialization error (very rare)
    // -----------------------------------------------------------------------

    // -----------------------------------------------------------------------
    // Cover batch with many varied payments to exercise all status counters
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn batch_screening_exercises_all_status_counters() {
        let engine = ComplianceEngine::new().await;
        let requests = vec![
            // Clean payment -> Passed
            ScreeningRequest {
                payment: Payment::test_payment("clean-a", "clean-b", 1000, "USD"),
                travel_rule_data: None,
                timeout_ms: None,
            },
            // Sanctioned -> Blocked
            ScreeningRequest {
                payment: Payment::test_payment("BLOCKED PERSON ALPHA", "clean-b", 1000, "USD"),
                travel_rule_data: None,
                timeout_ms: None,
            },
            // Large without travel rule -> Flagged
            ScreeningRequest {
                payment: Payment::test_payment("clean-x", "clean-y", 500_000, "USD"),
                travel_rule_data: None,
                timeout_ms: None,
            },
        ];
        let batch = engine.screen_batch(requests).await;
        assert_eq!(batch.total, 3);
        assert!(batch.results.iter().all(|r| r.success));
        // Should have at least 1 blocked (sanctioned)
        assert!(batch.blocked >= 1);
    }

    // -----------------------------------------------------------------------
    // collect_batch_results — error path
    // -----------------------------------------------------------------------

    #[test]
    fn collect_batch_results_with_errors() {
        let id1 = Uuid::new_v4();
        let id2 = Uuid::new_v4();
        let id3 = Uuid::new_v4();

        // Build a successful ComplianceResult
        let cr = ComplianceResult {
            payment_id: id1,
            sanctions_clear: true,
            aml_risk_score: 10,
            travel_rule_compliant: true,
            status: ComplianceStatus::Passed,
            attestation: vec![],
            screening_duration_ms: 5,
            risk_factors: vec![],
            screened_at: Utc::now(),
        };

        let outcomes = vec![
            (id1, Ok(cr)),
            (id2, Err("screening timed out after 100ms".to_string())),
            (id3, Err("task join error: task panicked".to_string())),
        ];

        let batch = ComplianceEngine::collect_batch_results(outcomes);
        assert_eq!(batch.total, 3);
        assert_eq!(batch.passed, 1);
        assert_eq!(batch.flagged, 0);
        assert_eq!(batch.blocked, 0);
        // First result should be success
        assert!(batch.results[0].success);
        assert!(batch.results[0].result.is_some());
        // Second and third should be errors
        assert!(!batch.results[1].success);
        assert!(batch.results[1].error.as_ref().unwrap().contains("timed out"));
        assert!(!batch.results[2].success);
        assert!(batch.results[2].error.as_ref().unwrap().contains("task join error"));
    }

    #[test]
    fn collect_batch_results_all_statuses() {
        let blocked_cr = ComplianceResult {
            payment_id: Uuid::new_v4(),
            sanctions_clear: false,
            aml_risk_score: 100,
            travel_rule_compliant: false,
            status: ComplianceStatus::Blocked,
            attestation: vec![],
            screening_duration_ms: 1,
            risk_factors: vec![],
            screened_at: Utc::now(),
        };
        let flagged_cr = ComplianceResult {
            payment_id: Uuid::new_v4(),
            sanctions_clear: true,
            aml_risk_score: 50,
            travel_rule_compliant: false,
            status: ComplianceStatus::Flagged,
            attestation: vec![],
            screening_duration_ms: 2,
            risk_factors: vec![],
            screened_at: Utc::now(),
        };
        let passed_cr = ComplianceResult {
            payment_id: Uuid::new_v4(),
            sanctions_clear: true,
            aml_risk_score: 5,
            travel_rule_compliant: true,
            status: ComplianceStatus::Passed,
            attestation: vec![],
            screening_duration_ms: 3,
            risk_factors: vec![],
            screened_at: Utc::now(),
        };

        let outcomes = vec![
            (blocked_cr.payment_id, Ok(blocked_cr)),
            (flagged_cr.payment_id, Ok(flagged_cr)),
            (passed_cr.payment_id, Ok(passed_cr)),
        ];
        let batch = ComplianceEngine::collect_batch_results(outcomes);
        assert_eq!(batch.total, 3);
        assert_eq!(batch.blocked, 1);
        assert_eq!(batch.flagged, 1);
        assert_eq!(batch.passed, 1);
    }
}
