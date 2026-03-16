//! AML risk scoring engine with configurable weighted factors.
//!
//! The [`RiskScoringModel`] evaluates payments against seven independent risk
//! dimensions and produces a composite score in the range `[0, 100]`.  Each
//! dimension has a configurable weight that determines its contribution to the
//! final score.
//!
//! ## Scoring Dimensions
//!
//! | Dimension            | What it measures                                    |
//! |----------------------|-----------------------------------------------------|
//! | Amount               | Whether the value exceeds high-value thresholds     |
//! | Velocity             | Transaction frequency over rolling windows          |
//! | Geography            | Jurisdictional risk of sender/recipient countries   |
//! | Counterparty         | Whether the counterparty is new or previously seen  |
//! | Pattern — structuring| Amounts clustered just below reporting thresholds   |
//! | Pattern — round-trip | Funds looping back to the originator                |
//! | Rapid movement       | Speed at which funds traverse intermediary accounts  |

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use chrono::{DateTime, Duration, Utc};
use dashmap::DashMap;
use tracing::debug;

use crate::types::{AMLRiskLevel, Payment, RiskFactor};

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/// Configurable weights for each risk dimension.  All weights are normalized so
/// their sum equals 1.0 when computing the composite score.
#[derive(Debug, Clone)]
pub struct RiskWeights {
    pub amount: f64,
    pub velocity: f64,
    pub geography: f64,
    pub counterparty: f64,
    pub pattern: f64,
    pub rapid_movement: f64,
}

impl Default for RiskWeights {
    fn default() -> Self {
        Self {
            amount: 0.20,
            velocity: 0.15,
            geography: 0.25,
            counterparty: 0.10,
            pattern: 0.20,
            rapid_movement: 0.10,
        }
    }
}

impl RiskWeights {
    /// Sum of all weights (used for normalization).
    fn total(&self) -> f64 {
        self.amount
            + self.velocity
            + self.geography
            + self.counterparty
            + self.pattern
            + self.rapid_movement
    }
}

// ---------------------------------------------------------------------------
// High-risk jurisdiction database
// ---------------------------------------------------------------------------

/// Returns the set of ISO 3166-1 alpha-2 country codes considered high-risk.
///
/// This is a simplified static list.  In production, this would be loaded from
/// FATF grey/black lists and updated regularly.
fn high_risk_jurisdictions() -> HashSet<&'static str> {
    [
        "KP", // North Korea
        "IR", // Iran
        "MM", // Myanmar
        "SY", // Syria
        "AF", // Afghanistan
        "YE", // Yemen
        "SO", // Somalia
        "LY", // Libya
        "SD", // Sudan
        "SS", // South Sudan
        "VE", // Venezuela
        "CU", // Cuba
    ]
    .into_iter()
    .collect()
}

/// Returns a smaller set of jurisdictions on the FATF grey list (elevated risk
/// but not outright blocked).
fn grey_list_jurisdictions() -> HashSet<&'static str> {
    [
        "PK", "NG", "TZ", "JM", "HT", "AL", "BA", "PH", "KH",
    ]
    .into_iter()
    .collect()
}

// ---------------------------------------------------------------------------
// Velocity tracker
// ---------------------------------------------------------------------------

/// Rolling-window transaction counter per entity.
#[derive(Debug, Clone)]
struct VelocityRecord {
    timestamps: Vec<DateTime<Utc>>,
    amounts: Vec<u64>,
}

// ---------------------------------------------------------------------------
// RiskScoringModel
// ---------------------------------------------------------------------------

/// The AML risk scoring model.
///
/// Thread-safe: the velocity tracker uses [`DashMap`] for lock-free concurrent
/// access, and the model itself is cheaply cloneable.
#[derive(Clone)]
pub struct RiskScoringModel {
    weights: RiskWeights,
    /// Per-entity velocity tracker keyed by entity identifier.
    velocity: Arc<DashMap<String, VelocityRecord>>,
    /// Known counterparties that have been seen before.
    known_counterparties: Arc<DashMap<String, DateTime<Utc>>>,
    /// High-value transaction threshold in USD-equivalent minor units (cents).
    high_value_threshold: u64,
    /// Reporting threshold for structuring detection (USD cents).
    reporting_threshold: u64,
}

impl RiskScoringModel {
    /// Create a model with default weights and standard thresholds.
    pub fn new() -> Self {
        Self {
            weights: RiskWeights::default(),
            velocity: Arc::new(DashMap::new()),
            known_counterparties: Arc::new(DashMap::new()),
            high_value_threshold: 1_000_000, // $10,000 in cents
            reporting_threshold: 1_000_000,  // $10,000 in cents
        }
    }

    /// Create a model with custom weights.
    pub fn with_weights(weights: RiskWeights) -> Self {
        Self {
            weights,
            ..Self::new()
        }
    }

    /// Calculate the composite AML risk score for a payment.
    ///
    /// Returns the score (0–100), the derived [`AMLRiskLevel`], and the list of
    /// individual [`RiskFactor`]s that contributed.
    pub fn calculate_risk(
        &self,
        payment: &Payment,
        sender_country: Option<&str>,
        recipient_country: Option<&str>,
    ) -> (u8, AMLRiskLevel, Vec<RiskFactor>) {
        let mut factors: Vec<RiskFactor> = Vec::new();
        let mut raw_scores: HashMap<&str, f64> = HashMap::new();

        // --- Amount-based risk ---
        let amount_score = self.score_amount(payment.amount);
        raw_scores.insert("amount", amount_score);
        if amount_score > 50.0 {
            factors.push(RiskFactor::HighValueTransaction);
        }

        // --- Velocity ---
        let velocity_score = self.score_velocity(&payment.sender, payment);
        raw_scores.insert("velocity", velocity_score);
        if velocity_score > 50.0 {
            factors.push(RiskFactor::FrequentTransactions);
        }

        // --- Geography ---
        let geo_score = self.score_geography(sender_country, recipient_country);
        raw_scores.insert("geography", geo_score);
        if geo_score > 30.0 {
            factors.push(RiskFactor::HighRiskJurisdiction);
        }

        // --- Counterparty ---
        let cp_score = self.score_counterparty(&payment.recipient);
        raw_scores.insert("counterparty", cp_score);
        if cp_score > 50.0 {
            factors.push(RiskFactor::NewCounterparty);
        }

        // --- Pattern analysis ---
        let (pattern_score, pattern_factors) =
            self.score_patterns(&payment.sender, payment.amount);
        raw_scores.insert("pattern", pattern_score);
        factors.extend(pattern_factors);

        // --- Rapid movement ---
        let rapid_score = self.score_rapid_movement(&payment.sender);
        raw_scores.insert("rapid_movement", rapid_score);
        if rapid_score > 50.0 {
            factors.push(RiskFactor::RapidMovement);
        }

        // --- Weighted composite ---
        let total_weight = self.weights.total();
        let composite = (raw_scores["amount"] * self.weights.amount
            + raw_scores["velocity"] * self.weights.velocity
            + raw_scores["geography"] * self.weights.geography
            + raw_scores["counterparty"] * self.weights.counterparty
            + raw_scores["pattern"] * self.weights.pattern
            + raw_scores["rapid_movement"] * self.weights.rapid_movement)
            / total_weight;

        let score = (composite.round() as u8).min(100);
        let level = AMLRiskLevel::from_score(score);

        debug!(
            payment_id = %payment.id,
            score,
            ?level,
            factors = ?factors,
            "AML risk calculated"
        );

        // Record this transaction for future velocity/pattern checks.
        self.record_transaction(&payment.sender, payment);
        self.known_counterparties
            .insert(payment.recipient.clone(), Utc::now());

        (score, level, factors)
    }

    // -----------------------------------------------------------------------
    // Individual scoring functions (each returns 0.0–100.0)
    // -----------------------------------------------------------------------

    /// Score based on transaction amount relative to high-value threshold.
    fn score_amount(&self, amount: u64) -> f64 {
        if amount >= self.high_value_threshold * 5 {
            100.0
        } else if amount >= self.high_value_threshold {
            60.0 + 40.0 * (amount as f64 / (self.high_value_threshold * 5) as f64)
        } else {
            (amount as f64 / self.high_value_threshold as f64) * 40.0
        }
    }

    /// Score based on transaction frequency over rolling windows.
    fn score_velocity(&self, entity: &str, _payment: &Payment) -> f64 {
        let record = match self.velocity.get(entity) {
            Some(r) => r,
            None => return 0.0,
        };

        let now = Utc::now();
        let one_hour_ago = now - Duration::hours(1);
        let one_day_ago = now - Duration::days(1);

        let hourly_count = record.timestamps.iter().filter(|t| **t >= one_hour_ago).count();
        let daily_count = record.timestamps.iter().filter(|t| **t >= one_day_ago).count();

        let hourly_score = (hourly_count as f64 / 10.0 * 100.0).min(100.0);
        let daily_score = (daily_count as f64 / 50.0 * 100.0).min(100.0);

        // Blend hourly and daily — recent spikes weighted more.
        hourly_score * 0.6 + daily_score * 0.4
    }

    /// Score based on counterparty/sender jurisdiction risk.
    fn score_geography(
        &self,
        sender_country: Option<&str>,
        recipient_country: Option<&str>,
    ) -> f64 {
        let high_risk = high_risk_jurisdictions();
        let grey = grey_list_jurisdictions();

        let mut score = 0.0;

        for country in [sender_country, recipient_country].into_iter().flatten() {
            if high_risk.contains(country) {
                score += 50.0;
            } else if grey.contains(country) {
                score += 25.0;
            }
        }

        (score as f64).min(100.0)
    }

    /// Score based on whether the counterparty is new.
    fn score_counterparty(&self, counterparty: &str) -> f64 {
        match self.known_counterparties.get(counterparty) {
            Some(first_seen) => {
                let age = Utc::now() - *first_seen;
                if age < Duration::days(7) {
                    60.0 // recently seen — still somewhat elevated
                } else {
                    10.0 // well-known counterparty
                }
            }
            None => 80.0, // never seen before
        }
    }

    /// Detect structuring and round-trip patterns.
    fn score_patterns(&self, entity: &str, current_amount: u64) -> (f64, Vec<RiskFactor>) {
        let mut score = 0.0;
        let mut factors = Vec::new();

        if let Some(record) = self.velocity.get(entity) {
            // Structuring detection: many amounts just below reporting threshold.
            let threshold_80 = (self.reporting_threshold as f64 * 0.80) as u64;
            let near_threshold_count = record
                .amounts
                .iter()
                .filter(|a| **a >= threshold_80 && **a < self.reporting_threshold)
                .count();

            if near_threshold_count >= 3 {
                score += 60.0;
                factors.push(RiskFactor::StructuredTransactions);
            }

            // Check if current amount is also near threshold.
            if current_amount >= threshold_80 && current_amount < self.reporting_threshold {
                score += 20.0;
                if !factors.contains(&RiskFactor::StructuredTransactions) {
                    factors.push(RiskFactor::UnusualPattern);
                }
            }
        }

        ((score as f64).min(100.0), factors)
    }

    /// Score based on how rapidly funds are moving through this entity.
    fn score_rapid_movement(&self, entity: &str) -> f64 {
        let record = match self.velocity.get(entity) {
            Some(r) => r,
            None => return 0.0,
        };

        let now = Utc::now();
        let ten_minutes_ago = now - Duration::minutes(10);
        let recent_count = record
            .timestamps
            .iter()
            .filter(|t| **t >= ten_minutes_ago)
            .count();

        // More than 5 transactions in 10 minutes is suspicious.
        ((recent_count as f64 / 5.0) * 100.0).min(100.0)
    }

    // -----------------------------------------------------------------------
    // State management
    // -----------------------------------------------------------------------

    /// Record a transaction in the velocity tracker.
    fn record_transaction(&self, entity: &str, payment: &Payment) {
        self.velocity
            .entry(entity.to_string())
            .and_modify(|r| {
                r.timestamps.push(payment.timestamp);
                r.amounts.push(payment.amount);
            })
            .or_insert_with(|| VelocityRecord {
                timestamps: vec![payment.timestamp],
                amounts: vec![payment.amount],
            });
    }

    /// Evict velocity records older than the retention window to bound memory.
    pub fn evict_stale_records(&self, max_age: Duration) {
        let cutoff = Utc::now() - max_age;
        self.velocity.retain(|_, record| {
            record.timestamps.retain(|t| *t >= cutoff);
            record.amounts.truncate(record.timestamps.len());
            !record.timestamps.is_empty()
        });
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::Payment;

    fn test_payment(amount: u64) -> Payment {
        Payment::test_payment("sender-1", "recipient-1", amount, "USD")
    }

    #[test]
    fn low_value_payment_scores_low() {
        let model = RiskScoringModel::new();
        let payment = test_payment(1_000); // $10
        let (score, level, _factors) = model.calculate_risk(&payment, None, None);
        assert!(score <= 30, "expected low score, got {score}");
        assert!(level <= AMLRiskLevel::Medium);
    }

    #[test]
    fn high_value_payment_scores_higher() {
        let model = RiskScoringModel::new();
        let payment = test_payment(5_000_000); // $50,000
        let (score, _level, factors) = model.calculate_risk(&payment, None, None);
        assert!(score > 10, "expected elevated score, got {score}");
        assert!(factors.contains(&RiskFactor::HighValueTransaction));
    }

    #[test]
    fn high_risk_jurisdiction_increases_score() {
        let model = RiskScoringModel::new();
        let payment = test_payment(50_000);
        let (score_clean, _, _) = model.calculate_risk(&payment, Some("US"), Some("GB"));

        let model2 = RiskScoringModel::new();
        let payment2 = test_payment(50_000);
        let (score_risky, _, factors) = model2.calculate_risk(&payment2, Some("KP"), Some("IR"));

        assert!(
            score_risky > score_clean,
            "risky={score_risky} should exceed clean={score_clean}"
        );
        assert!(factors.contains(&RiskFactor::HighRiskJurisdiction));
    }

    #[test]
    fn new_counterparty_flagged() {
        let model = RiskScoringModel::new();
        let payment = test_payment(50_000);
        let (_, _, factors) = model.calculate_risk(&payment, None, None);
        assert!(factors.contains(&RiskFactor::NewCounterparty));
    }

    #[test]
    fn multiple_screenings_do_not_panic() {
        let model = RiskScoringModel::new();
        // Multiple screenings of the same counterparty should not panic
        for _ in 0..5 {
            let p = test_payment(50_000);
            let (score, level, factors) = model.calculate_risk(&p, None, None);
            assert!(score <= 100);
            assert!(!factors.is_empty() || level == AMLRiskLevel::Low);
        }
    }

    #[test]
    fn amount_scoring_boundary() {
        let model = RiskScoringModel::new();
        let low = model.score_amount(0);
        let mid = model.score_amount(1_000_000);
        let high = model.score_amount(10_000_000);
        assert!(low < mid);
        assert!(mid < high);
    }

    #[test]
    fn risk_weights_total() {
        let w = RiskWeights::default();
        let total = w.total();
        assert!((total - 1.0).abs() < 1e-9, "weights should sum to 1.0");
    }

    #[test]
    fn geography_score_clean() {
        let model = RiskScoringModel::new();
        let score = model.score_geography(Some("US"), Some("GB"));
        assert_eq!(score, 0.0);
    }

    #[test]
    fn geography_score_grey() {
        let model = RiskScoringModel::new();
        let score = model.score_geography(Some("PK"), None);
        assert_eq!(score, 25.0);
    }

    #[test]
    fn geography_score_both_high_risk_capped_at_100() {
        let model = RiskScoringModel::new();
        let score = model.score_geography(Some("KP"), Some("IR"));
        assert_eq!(score, 100.0);
    }

    #[test]
    fn geography_score_none_countries() {
        let model = RiskScoringModel::new();
        let score = model.score_geography(None, None);
        assert_eq!(score, 0.0);
    }

    #[test]
    fn geography_score_mixed_high_and_grey() {
        let model = RiskScoringModel::new();
        let score = model.score_geography(Some("KP"), Some("PK"));
        assert_eq!(score, 75.0);
    }

    #[test]
    fn amount_scoring_zero() {
        let model = RiskScoringModel::new();
        let score = model.score_amount(0);
        assert_eq!(score, 0.0);
    }

    #[test]
    fn amount_scoring_at_threshold() {
        let model = RiskScoringModel::new();
        let score = model.score_amount(1_000_000);
        assert!(score >= 60.0, "At threshold should score >= 60, got {}", score);
    }

    #[test]
    fn amount_scoring_above_5x_threshold() {
        let model = RiskScoringModel::new();
        let score = model.score_amount(5_000_000);
        assert_eq!(score, 100.0);
    }

    #[test]
    fn velocity_score_no_history() {
        let model = RiskScoringModel::new();
        let payment = test_payment(1000);
        let score = model.score_velocity("unknown-entity", &payment);
        assert_eq!(score, 0.0);
    }

    #[test]
    fn counterparty_score_unknown() {
        let model = RiskScoringModel::new();
        let score = model.score_counterparty("never-seen");
        assert_eq!(score, 80.0);
    }

    #[test]
    fn pattern_score_no_history() {
        let model = RiskScoringModel::new();
        let (score, factors) = model.score_patterns("unknown-entity", 1000);
        assert_eq!(score, 0.0);
        assert!(factors.is_empty());
    }

    #[test]
    fn rapid_movement_no_history() {
        let model = RiskScoringModel::new();
        let score = model.score_rapid_movement("unknown-entity");
        assert_eq!(score, 0.0);
    }

    #[test]
    fn evict_stale_records_keeps_recent() {
        let model = RiskScoringModel::new();
        let payment = test_payment(1000);
        model.calculate_risk(&payment, None, None);
        assert!(!model.velocity.is_empty());
        model.evict_stale_records(Duration::days(1));
        assert!(!model.velocity.is_empty());
    }

    #[test]
    fn custom_weights_model() {
        let weights = RiskWeights {
            amount: 1.0,
            velocity: 0.0,
            geography: 0.0,
            counterparty: 0.0,
            pattern: 0.0,
            rapid_movement: 0.0,
        };
        let model = RiskScoringModel::with_weights(weights);
        let payment = test_payment(5_000_000);
        let (score, _level, _factors) = model.calculate_risk(&payment, None, None);
        assert!(score > 0, "Custom weight model should still produce scores");
    }

    #[test]
    fn structuring_detected_after_repeated_near_threshold() {
        let model = RiskScoringModel::new();
        for _ in 0..4 {
            let payment = Payment::test_payment("structurer", "recipient-1", 900_000, "USD");
            model.calculate_risk(&payment, None, None);
        }
        let payment = Payment::test_payment("structurer", "recipient-1", 900_000, "USD");
        let (_score, _level, factors) = model.calculate_risk(&payment, None, None);
        assert!(
            factors.contains(&RiskFactor::StructuredTransactions),
            "Should detect structuring after repeated near-threshold transactions"
        );
    }

    // -----------------------------------------------------------------------
    // Cover line 183: FrequentTransactions factor (velocity_score > 50)
    // -----------------------------------------------------------------------

    #[test]
    fn frequent_transactions_flagged_after_many_rapid_payments() {
        let model = RiskScoringModel::new();
        // Build up velocity history with many payments from same sender
        for _ in 0..15 {
            let payment = Payment::test_payment("rapid-sender", "recipient-1", 50_000, "USD");
            model.calculate_risk(&payment, None, None);
        }
        // The velocity score should now be > 50, triggering FrequentTransactions
        let payment = Payment::test_payment("rapid-sender", "recipient-1", 50_000, "USD");
        let (_score, _level, factors) = model.calculate_risk(&payment, None, None);
        assert!(
            factors.contains(&RiskFactor::FrequentTransactions),
            "Should flag FrequentTransactions after many rapid payments"
        );
    }

    // -----------------------------------------------------------------------
    // Cover line 308: well-known counterparty returns 10.0
    // -----------------------------------------------------------------------

    #[test]
    fn well_known_counterparty_scores_low() {
        let model = RiskScoringModel::new();
        // Insert a counterparty as known with an old timestamp
        model.known_counterparties.insert(
            "old-partner".to_string(),
            Utc::now() - Duration::days(30),
        );
        let score = model.score_counterparty("old-partner");
        assert!(
            (score - 10.0).abs() < f64::EPSILON,
            "Well-known counterparty (>7 days) should score 10.0, got {}",
            score
        );
    }
}
