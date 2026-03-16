//! Behavioral Analytics Engine
//!
//! Profiles entity behavior over time and detects anomalies that may indicate
//! money laundering, fraud, or other financial crimes. Maintains rolling windows
//! of transaction metrics and scores deviations from established baselines.

use std::collections::HashMap;

use chrono::{DateTime, Datelike, Duration, Timelike, Utc};
use serde::{Deserialize, Serialize};
use tracing::{info, warn};

use crate::types::Payment;

// ---------------------------------------------------------------------------
// Behavioral profile
// ---------------------------------------------------------------------------

/// A behavioral profile for an entity built from transaction history.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BehavioralProfile {
    /// Entity identifier.
    pub entity: String,
    /// Average transaction amount over the profile window.
    pub avg_amount: f64,
    /// Standard deviation of transaction amounts.
    pub amount_stddev: f64,
    /// Median transaction amount.
    pub median_amount: f64,
    /// Average transactions per day.
    pub avg_daily_frequency: f64,
    /// Typical hours of activity (24-element histogram).
    pub hourly_pattern: [f64; 24],
    /// Typical days of activity (7-element histogram).
    pub daily_pattern: [f64; 7],
    /// Number of unique counterparties.
    pub unique_counterparties: usize,
    /// Currency distribution.
    pub currency_distribution: HashMap<String, f64>,
    /// Total volume processed.
    pub total_volume: f64,
    /// Total transactions in profile.
    pub total_transactions: usize,
    /// Profile creation date.
    pub profile_start: DateTime<Utc>,
    /// Last transaction date.
    pub last_transaction: DateTime<Utc>,
    /// Profile window in days.
    pub window_days: u32,
}

impl BehavioralProfile {
    /// Build a profile from a payment history.
    pub fn from_payments(entity: &str, payments: &[Payment], window_days: u32) -> Self {
        let cutoff = Utc::now() - Duration::days(window_days as i64);
        let relevant: Vec<&Payment> = payments
            .iter()
            .filter(|p| {
                (p.sender == entity || p.recipient == entity) && p.timestamp >= cutoff
            })
            .collect();

        if relevant.is_empty() {
            return Self::empty(entity, window_days);
        }

        let amounts: Vec<f64> = relevant.iter().map(|p| p.amount as f64).collect();
        let avg = amounts.iter().sum::<f64>() / amounts.len() as f64;
        let variance = amounts.iter().map(|a| (a - avg).powi(2)).sum::<f64>() / amounts.len() as f64;
        let stddev = variance.sqrt();

        let mut sorted_amounts = amounts.clone();
        sorted_amounts.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let median = if sorted_amounts.len() % 2 == 0 {
            (sorted_amounts[sorted_amounts.len() / 2 - 1] + sorted_amounts[sorted_amounts.len() / 2]) / 2.0
        } else {
            sorted_amounts[sorted_amounts.len() / 2]
        };

        let mut hourly_pattern = [0.0f64; 24];
        let mut daily_pattern = [0.0f64; 7];
        let mut counterparties: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut currency_counts: HashMap<String, usize> = HashMap::new();

        for p in &relevant {
            let hour = p.timestamp.hour() as usize;
            let day = p.timestamp.weekday().num_days_from_monday() as usize;
            hourly_pattern[hour] += 1.0;
            daily_pattern[day] += 1.0;

            let counterparty = if p.sender == entity { &p.recipient } else { &p.sender };
            counterparties.insert(counterparty.clone());
            *currency_counts.entry(p.currency.clone()).or_default() += 1;
        }

        // Normalize patterns
        let total_h: f64 = hourly_pattern.iter().sum();
        if total_h > 0.0 {
            for h in hourly_pattern.iter_mut() { *h /= total_h; }
        }
        let total_d: f64 = daily_pattern.iter().sum();
        if total_d > 0.0 {
            for d in daily_pattern.iter_mut() { *d /= total_d; }
        }

        let total = relevant.len() as f64;
        let currency_distribution: HashMap<String, f64> = currency_counts
            .into_iter()
            .map(|(c, n)| (c, n as f64 / total))
            .collect();

        let total_volume = amounts.iter().sum();
        let first_ts = relevant.iter().map(|p| p.timestamp).min().unwrap_or(Utc::now());
        let last_ts = relevant.iter().map(|p| p.timestamp).max().unwrap_or(Utc::now());
        let active_days = (last_ts - first_ts).num_days().max(1) as f64;

        Self {
            entity: entity.to_string(),
            avg_amount: avg,
            amount_stddev: stddev,
            median_amount: median,
            avg_daily_frequency: relevant.len() as f64 / active_days,
            hourly_pattern,
            daily_pattern,
            unique_counterparties: counterparties.len(),
            currency_distribution,
            total_volume,
            total_transactions: relevant.len(),
            profile_start: first_ts,
            last_transaction: last_ts,
            window_days,
        }
    }

    fn empty(entity: &str, window_days: u32) -> Self {
        Self {
            entity: entity.to_string(),
            avg_amount: 0.0,
            amount_stddev: 0.0,
            median_amount: 0.0,
            avg_daily_frequency: 0.0,
            hourly_pattern: [0.0; 24],
            daily_pattern: [0.0; 7],
            unique_counterparties: 0,
            currency_distribution: HashMap::new(),
            total_volume: 0.0,
            total_transactions: 0,
            profile_start: Utc::now(),
            last_transaction: Utc::now(),
            window_days,
        }
    }
}

// ---------------------------------------------------------------------------
// Anomaly detection
// ---------------------------------------------------------------------------

/// A detected behavioral anomaly.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BehavioralAnomaly {
    /// The anomaly type.
    pub anomaly_type: AnomalyType,
    /// Severity score (0.0–1.0).
    pub severity: f64,
    /// Entity exhibiting the anomaly.
    pub entity: String,
    /// Human-readable description.
    pub description: String,
    /// Observed value.
    pub observed: f64,
    /// Expected value (baseline).
    pub expected: f64,
    /// Number of standard deviations from the mean.
    pub z_score: f64,
    /// When the anomaly was detected.
    pub detected_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum AnomalyType {
    /// Transaction amount significantly deviates from historical baseline.
    AmountAnomaly,
    /// Transaction frequency spike or drop.
    VelocityAnomaly,
    /// Activity at unusual times.
    TemporalAnomaly,
    /// Sudden increase in counterparty diversity.
    CounterpartyAnomaly,
    /// Dormant account suddenly activated.
    DormantActivation,
    /// New currency used for the first time.
    CurrencyAnomaly,
    /// Geographic pattern shift.
    GeographicAnomaly,
}

/// Composite behavioral risk score.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BehavioralScore {
    /// Overall risk score (0–100).
    pub score: u8,
    /// Individual anomaly scores.
    pub anomalies: Vec<BehavioralAnomaly>,
    /// Whether the entity's behavior is within normal bounds.
    pub is_normal: bool,
    /// Entity profile summary.
    pub profile_summary: ProfileSummary,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfileSummary {
    pub entity: String,
    pub profile_age_days: i64,
    pub total_transactions: usize,
    pub avg_amount: f64,
    pub avg_daily_frequency: f64,
    pub unique_counterparties: usize,
}

// ---------------------------------------------------------------------------
// Behavioral Analysis Engine
// ---------------------------------------------------------------------------

/// The main behavioral analytics engine.
pub struct BehavioralEngine {
    /// Cached profiles per entity.
    profiles: HashMap<String, BehavioralProfile>,
    /// Z-score threshold for flagging anomalies.
    z_threshold: f64,
    /// Profile window in days.
    window_days: u32,
}

impl BehavioralEngine {
    /// Create a new engine with default configuration.
    pub fn new() -> Self {
        Self {
            profiles: HashMap::new(),
            z_threshold: 2.5,
            window_days: 90,
        }
    }

    /// Build profiles for all entities from historical payments.
    pub fn build_profiles(&mut self, payments: &[Payment]) {
        let mut entity_set: std::collections::HashSet<String> = std::collections::HashSet::new();
        for p in payments {
            entity_set.insert(p.sender.clone());
            entity_set.insert(p.recipient.clone());
        }

        for entity in &entity_set {
            let profile = BehavioralProfile::from_payments(entity, payments, self.window_days);
            self.profiles.insert(entity.clone(), profile);
        }

        info!(
            entities = entity_set.len(),
            window_days = self.window_days,
            "behavioral profiles built"
        );
    }

    /// Score a new payment against the entity's behavioral profile.
    pub fn score_payment(&self, payment: &Payment) -> BehavioralScore {
        let profile = self.profiles.get(&payment.sender);
        let mut anomalies: Vec<BehavioralAnomaly> = Vec::new();

        if let Some(profile) = profile {
            // Amount anomaly check
            if let Some(anomaly) = self.check_amount_anomaly(payment, profile) {
                anomalies.push(anomaly);
            }

            // Temporal anomaly check
            if let Some(anomaly) = self.check_temporal_anomaly(payment, profile) {
                anomalies.push(anomaly);
            }

            // Dormant account activation
            if let Some(anomaly) = self.check_dormant_activation(payment, profile) {
                anomalies.push(anomaly);
            }

            // Currency anomaly
            if let Some(anomaly) = self.check_currency_anomaly(payment, profile) {
                anomalies.push(anomaly);
            }
        } else {
            // No profile exists — new entity
            anomalies.push(BehavioralAnomaly {
                anomaly_type: AnomalyType::DormantActivation,
                severity: 0.3,
                entity: payment.sender.clone(),
                description: "No behavioral profile exists — new entity".to_string(),
                observed: 0.0,
                expected: 0.0,
                z_score: 0.0,
                detected_at: Utc::now(),
            });
        }

        let max_severity = anomalies.iter().map(|a| a.severity).fold(0.0f64, f64::max);
        let score = (max_severity * 100.0).min(100.0) as u8;

        let profile_summary = if let Some(p) = profile {
            ProfileSummary {
                entity: p.entity.clone(),
                profile_age_days: (Utc::now() - p.profile_start).num_days(),
                total_transactions: p.total_transactions,
                avg_amount: p.avg_amount,
                avg_daily_frequency: p.avg_daily_frequency,
                unique_counterparties: p.unique_counterparties,
            }
        } else {
            ProfileSummary {
                entity: payment.sender.clone(),
                profile_age_days: 0,
                total_transactions: 0,
                avg_amount: 0.0,
                avg_daily_frequency: 0.0,
                unique_counterparties: 0,
            }
        };

        BehavioralScore {
            score,
            anomalies,
            is_normal: score < 30,
            profile_summary,
        }
    }

    fn check_amount_anomaly(&self, payment: &Payment, profile: &BehavioralProfile) -> Option<BehavioralAnomaly> {
        if profile.amount_stddev == 0.0 || profile.total_transactions < 3 {
            return None;
        }

        let amount = payment.amount as f64;
        let z_score = (amount - profile.avg_amount).abs() / profile.amount_stddev;

        if z_score > self.z_threshold {
            let severity = (z_score / 5.0).min(1.0);
            Some(BehavioralAnomaly {
                anomaly_type: AnomalyType::AmountAnomaly,
                severity,
                entity: payment.sender.clone(),
                description: format!(
                    "Transaction amount {:.0} deviates {:.1} standard deviations from mean {:.0}",
                    amount, z_score, profile.avg_amount
                ),
                observed: amount,
                expected: profile.avg_amount,
                z_score,
                detected_at: Utc::now(),
            })
        } else {
            None
        }
    }

    fn check_temporal_anomaly(&self, payment: &Payment, profile: &BehavioralProfile) -> Option<BehavioralAnomaly> {
        let hour = payment.timestamp.hour() as usize;
        let hour_frequency = profile.hourly_pattern[hour];

        // If this hour has less than 2% of historical activity, flag it
        if hour_frequency < 0.02 && profile.total_transactions >= 10 {
            Some(BehavioralAnomaly {
                anomaly_type: AnomalyType::TemporalAnomaly,
                severity: 0.4,
                entity: payment.sender.clone(),
                description: format!(
                    "Transaction at unusual hour {} — only {:.1}% of historical activity at this time",
                    hour, hour_frequency * 100.0
                ),
                observed: hour as f64,
                expected: profile.hourly_pattern.iter()
                    .enumerate()
                    .max_by(|a, b| a.1.partial_cmp(b.1).unwrap_or(std::cmp::Ordering::Equal))
                    .map(|(h, _)| h as f64)
                    .unwrap_or(12.0),
                z_score: 0.0,
                detected_at: Utc::now(),
            })
        } else {
            None
        }
    }

    fn check_dormant_activation(&self, payment: &Payment, profile: &BehavioralProfile) -> Option<BehavioralAnomaly> {
        let days_since_last = (Utc::now() - profile.last_transaction).num_days();

        if days_since_last > 60 {
            let severity = (days_since_last as f64 / 180.0).min(0.8);
            Some(BehavioralAnomaly {
                anomaly_type: AnomalyType::DormantActivation,
                severity,
                entity: payment.sender.clone(),
                description: format!(
                    "Account reactivated after {} days of dormancy",
                    days_since_last
                ),
                observed: days_since_last as f64,
                expected: 0.0,
                z_score: 0.0,
                detected_at: Utc::now(),
            })
        } else {
            None
        }
    }

    fn check_currency_anomaly(&self, payment: &Payment, profile: &BehavioralProfile) -> Option<BehavioralAnomaly> {
        if !profile.currency_distribution.contains_key(&payment.currency) && profile.total_transactions >= 5 {
            Some(BehavioralAnomaly {
                anomaly_type: AnomalyType::CurrencyAnomaly,
                severity: 0.3,
                entity: payment.sender.clone(),
                description: format!(
                    "First transaction in {} — not seen in {} prior transactions",
                    payment.currency, profile.total_transactions
                ),
                observed: 0.0,
                expected: 1.0,
                z_score: 0.0,
                detected_at: Utc::now(),
            })
        } else {
            None
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_profile() {
        let profile = BehavioralProfile::from_payments("test", &[], 90);
        assert_eq!(profile.total_transactions, 0);
        assert_eq!(profile.avg_amount, 0.0);
    }

    #[test]
    fn profile_from_payments() {
        let payments: Vec<Payment> = (0..10)
            .map(|i| Payment::test_payment("alice", "bob", (i + 1) * 1000, "USD"))
            .collect();
        let profile = BehavioralProfile::from_payments("alice", &payments, 90);
        assert_eq!(profile.total_transactions, 10);
        assert!(profile.avg_amount > 0.0);
        assert!(profile.amount_stddev > 0.0);
    }

    #[test]
    fn behavioral_scoring() {
        let engine = BehavioralEngine::new();
        let payment = Payment::test_payment("unknown-entity", "bob", 50000, "USD");
        let score = engine.score_payment(&payment);
        // New entity should trigger anomaly
        assert!(!score.anomalies.is_empty());
    }

    // -----------------------------------------------------------------------
    // Amount anomaly detection
    // -----------------------------------------------------------------------

    #[test]
    fn amount_anomaly_detected_for_large_deviation() {
        let mut engine = BehavioralEngine::new();
        // Build a profile with varied small payments (need non-zero stddev)
        let payments: Vec<Payment> = (0..20)
            .map(|i| Payment::test_payment("sender", "bob", 800 + (i % 5) * 100, "USD"))
            .collect();
        engine.build_profiles(&payments);

        // Now send a much larger payment
        let large_payment = Payment::test_payment("sender", "bob", 100_000, "USD");
        let score = engine.score_payment(&large_payment);

        let has_amount_anomaly = score
            .anomalies
            .iter()
            .any(|a| a.anomaly_type == AnomalyType::AmountAnomaly);
        assert!(
            has_amount_anomaly,
            "Should detect amount anomaly for 100x deviation"
        );
    }

    #[test]
    fn no_amount_anomaly_for_normal_payment() {
        let mut engine = BehavioralEngine::new();
        // Build a profile with varied payments
        let payments: Vec<Payment> = (0..20)
            .map(|i| Payment::test_payment("sender", "bob", (i + 1) * 1000, "USD"))
            .collect();
        engine.build_profiles(&payments);

        // Payment within normal range
        let normal_payment = Payment::test_payment("sender", "bob", 10000, "USD");
        let score = engine.score_payment(&normal_payment);

        let has_amount_anomaly = score
            .anomalies
            .iter()
            .any(|a| a.anomaly_type == AnomalyType::AmountAnomaly);
        assert!(
            !has_amount_anomaly,
            "Should not detect amount anomaly for normal payment"
        );
    }

    #[test]
    fn amount_anomaly_skipped_with_few_transactions() {
        let mut engine = BehavioralEngine::new();
        // Only 2 transactions — below the minimum of 3
        let payments: Vec<Payment> = (0..2)
            .map(|_| Payment::test_payment("sender", "bob", 1000, "USD"))
            .collect();
        engine.build_profiles(&payments);

        let large_payment = Payment::test_payment("sender", "bob", 999_999, "USD");
        let score = engine.score_payment(&large_payment);

        let has_amount_anomaly = score
            .anomalies
            .iter()
            .any(|a| a.anomaly_type == AnomalyType::AmountAnomaly);
        assert!(
            !has_amount_anomaly,
            "Should not flag amount anomaly with fewer than 3 transactions"
        );
    }

    // -----------------------------------------------------------------------
    // Currency anomaly detection
    // -----------------------------------------------------------------------

    #[test]
    fn currency_anomaly_detected_for_new_currency() {
        let mut engine = BehavioralEngine::new();
        let payments: Vec<Payment> = (0..10)
            .map(|_| Payment::test_payment("sender", "bob", 1000, "USD"))
            .collect();
        engine.build_profiles(&payments);

        // Send in a new currency
        let eur_payment = Payment::test_payment("sender", "bob", 1000, "EUR");
        let score = engine.score_payment(&eur_payment);

        let has_currency_anomaly = score
            .anomalies
            .iter()
            .any(|a| a.anomaly_type == AnomalyType::CurrencyAnomaly);
        assert!(
            has_currency_anomaly,
            "Should detect currency anomaly for first EUR transaction"
        );
    }

    #[test]
    fn no_currency_anomaly_for_known_currency() {
        let mut engine = BehavioralEngine::new();
        let payments: Vec<Payment> = (0..10)
            .map(|_| Payment::test_payment("sender", "bob", 1000, "USD"))
            .collect();
        engine.build_profiles(&payments);

        let usd_payment = Payment::test_payment("sender", "bob", 2000, "USD");
        let score = engine.score_payment(&usd_payment);

        let has_currency_anomaly = score
            .anomalies
            .iter()
            .any(|a| a.anomaly_type == AnomalyType::CurrencyAnomaly);
        assert!(
            !has_currency_anomaly,
            "Should not detect currency anomaly for known currency"
        );
    }

    // -----------------------------------------------------------------------
    // Dormant activation (new entity path)
    // -----------------------------------------------------------------------

    #[test]
    fn new_entity_triggers_dormant_activation() {
        let engine = BehavioralEngine::new();
        let payment = Payment::test_payment("brand-new-entity", "recipient", 5000, "USD");
        let score = engine.score_payment(&payment);

        let has_dormant = score
            .anomalies
            .iter()
            .any(|a| a.anomaly_type == AnomalyType::DormantActivation);
        assert!(has_dormant, "New entity should trigger dormant activation anomaly");
        // Severity should be 0.3 for new entity path
        let dormant = score
            .anomalies
            .iter()
            .find(|a| a.anomaly_type == AnomalyType::DormantActivation)
            .unwrap();
        assert!((dormant.severity - 0.3).abs() < f64::EPSILON);
    }

    // -----------------------------------------------------------------------
    // Profile with single transaction
    // -----------------------------------------------------------------------

    #[test]
    fn profile_from_single_payment() {
        let payments = vec![Payment::test_payment("alice", "bob", 5000, "USD")];
        let profile = BehavioralProfile::from_payments("alice", &payments, 90);
        assert_eq!(profile.total_transactions, 1);
        assert!((profile.avg_amount - 5000.0).abs() < f64::EPSILON);
        assert!((profile.amount_stddev - 0.0).abs() < f64::EPSILON);
        assert!((profile.median_amount - 5000.0).abs() < f64::EPSILON);
        assert_eq!(profile.unique_counterparties, 1);
        assert!(profile.currency_distribution.contains_key("USD"));
    }

    // -----------------------------------------------------------------------
    // Engine with profiles pre-built, then scoring
    // -----------------------------------------------------------------------

    #[test]
    fn engine_scores_with_prebuilt_profiles() {
        let mut engine = BehavioralEngine::new();
        let payments: Vec<Payment> = (0..15)
            .map(|i| Payment::test_payment("alice", &format!("r{}", i % 3), (i + 1) * 1000, "USD"))
            .collect();
        engine.build_profiles(&payments);

        // Score a payment for an entity with a known profile
        let payment = Payment::test_payment("alice", "r0", 5000, "USD");
        let score = engine.score_payment(&payment);
        // With a known profile, is_normal depends on anomaly detection
        // but the profile_summary should be populated
        assert_eq!(score.profile_summary.entity, "alice");
        assert!(score.profile_summary.total_transactions > 0);
    }

    // -----------------------------------------------------------------------
    // BehavioralScore is_normal threshold
    // -----------------------------------------------------------------------

    #[test]
    fn behavioral_score_is_normal_when_below_30() {
        let mut engine = BehavioralEngine::new();
        // Build profile with consistent recent payments
        let payments: Vec<Payment> = (0..20)
            .map(|_| Payment::test_payment("stable", "bob", 1000, "USD"))
            .collect();
        engine.build_profiles(&payments);

        // Normal payment
        let payment = Payment::test_payment("stable", "bob", 1000, "USD");
        let score = engine.score_payment(&payment);
        // score < 30 → is_normal should be true
        if score.score < 30 {
            assert!(score.is_normal);
        }
    }

    // -----------------------------------------------------------------------
    // Profile excludes payments outside window
    // -----------------------------------------------------------------------

    #[test]
    fn profile_respects_window_days() {
        // All payments are created with Utc::now(), so they should be within any window
        let payments: Vec<Payment> = (0..5)
            .map(|_| Payment::test_payment("alice", "bob", 1000, "USD"))
            .collect();
        let profile = BehavioralProfile::from_payments("alice", &payments, 1);
        // Since payments are created now, they should be within even a 1-day window
        assert_eq!(profile.total_transactions, 5);
    }

    // -----------------------------------------------------------------------
    // Median calculation with even number of payments
    // -----------------------------------------------------------------------

    #[test]
    fn median_with_even_number_of_payments() {
        let payments: Vec<Payment> = vec![
            Payment::test_payment("alice", "bob", 1000, "USD"),
            Payment::test_payment("alice", "bob", 3000, "USD"),
            Payment::test_payment("alice", "bob", 5000, "USD"),
            Payment::test_payment("alice", "bob", 7000, "USD"),
        ];
        let profile = BehavioralProfile::from_payments("alice", &payments, 90);
        // Median of [1000, 3000, 5000, 7000] = (3000 + 5000) / 2 = 4000
        assert!((profile.median_amount - 4000.0).abs() < f64::EPSILON);
    }

    // -----------------------------------------------------------------------
    // AnomalyType variants are distinguishable
    // -----------------------------------------------------------------------

    #[test]
    fn anomaly_types_are_distinct() {
        let types = vec![
            AnomalyType::AmountAnomaly,
            AnomalyType::VelocityAnomaly,
            AnomalyType::TemporalAnomaly,
            AnomalyType::CounterpartyAnomaly,
            AnomalyType::DormantActivation,
            AnomalyType::CurrencyAnomaly,
            AnomalyType::GeographicAnomaly,
        ];
        // All should be distinct from each other
        for i in 0..types.len() {
            for j in (i + 1)..types.len() {
                assert_ne!(types[i], types[j]);
            }
        }
    }

    // -----------------------------------------------------------------------
    // Cover lines 259, 261: build_profiles info log
    // -----------------------------------------------------------------------

    #[test]
    fn build_profiles_with_multiple_entities() {
        let mut engine = BehavioralEngine::new();
        let payments: Vec<Payment> = vec![
            Payment::test_payment("alice", "bob", 1000, "USD"),
            Payment::test_payment("charlie", "dave", 2000, "EUR"),
            Payment::test_payment("alice", "charlie", 3000, "USD"),
        ];
        engine.build_profiles(&payments);
        // Verify profiles were built for all entities
        let p1 = Payment::test_payment("alice", "bob", 1000, "USD");
        let score = engine.score_payment(&p1);
        assert!(score.profile_summary.total_transactions > 0);
    }

    // -----------------------------------------------------------------------
    // Cover lines 370, 372-375, 377-382, 384: temporal anomaly detection
    // (requires profile with >= 10 transactions and activity concentrated
    // in specific hours, then transaction at unusual hour)
    // -----------------------------------------------------------------------

    #[test]
    fn temporal_anomaly_detected_for_unusual_hour() {
        use chrono::TimeZone;

        let mut engine = BehavioralEngine::new();
        // Create payments all at the same hour to concentrate the hourly pattern
        let mut payments: Vec<Payment> = Vec::new();
        for i in 0..15 {
            let mut p = Payment::test_payment("sender", &format!("r{}", i % 3), 1000 + i * 100, "USD");
            // All at the current hour, which will dominate the pattern
            payments.push(p);
        }
        engine.build_profiles(&payments);

        // Now create a payment at a very different hour by manipulating timestamp
        // The check_temporal_anomaly looks at payment.timestamp.hour()
        // Since all test_payments use Utc::now(), they'll all be in the same hour
        // We need a payment at a different hour
        let mut unusual_payment = Payment::test_payment("sender", "r0", 1000, "USD");
        // Set timestamp to 12 hours from now to be in a different hour
        unusual_payment.timestamp = Utc::now() + Duration::hours(12);
        let score = engine.score_payment(&unusual_payment);

        // The temporal anomaly check requires hour_frequency < 0.02 and total_transactions >= 10
        // With 15 transactions all at the same hour, other hours have 0% frequency
        let has_temporal = score
            .anomalies
            .iter()
            .any(|a| a.anomaly_type == AnomalyType::TemporalAnomaly);
        assert!(
            has_temporal,
            "Should detect temporal anomaly for activity at unusual hour"
        );
    }

    // -----------------------------------------------------------------------
    // Cover lines 395-402, 404-407: dormant account activation
    // (requires profile with last_transaction > 60 days ago)
    // -----------------------------------------------------------------------

    #[test]
    fn dormant_activation_detected_for_old_profile() {
        let mut engine = BehavioralEngine::new();

        // Create a profile with old timestamps (70 days ago - within 90-day window
        // but > 60 days dormancy threshold)
        let mut payments: Vec<Payment> = Vec::new();
        for i in 0..5 {
            let mut p = Payment::test_payment("dormant-sender", &format!("r{}", i), 1000, "USD");
            p.timestamp = Utc::now() - Duration::days(70);
            payments.push(p);
        }
        engine.build_profiles(&payments);

        // Now send a new payment - account was dormant for 70 days (> 60 threshold)
        let new_payment = Payment::test_payment("dormant-sender", "r0", 1000, "USD");
        let score = engine.score_payment(&new_payment);

        let has_dormant = score
            .anomalies
            .iter()
            .any(|a| a.anomaly_type == AnomalyType::DormantActivation);
        assert!(
            has_dormant,
            "Should detect dormant activation after 70 days of inactivity"
        );
    }

    // -----------------------------------------------------------------------
    // Cover line 278, 283: check_temporal_anomaly returns None when conditions
    // not met (no anomaly for few transactions)
    // -----------------------------------------------------------------------

    #[test]
    fn no_temporal_anomaly_with_few_transactions() {
        let mut engine = BehavioralEngine::new();
        // Only 5 transactions - below the minimum of 10 for temporal anomaly
        let payments: Vec<Payment> = (0..5)
            .map(|i| Payment::test_payment("sender", &format!("r{}", i), 1000, "USD"))
            .collect();
        engine.build_profiles(&payments);

        let mut payment = Payment::test_payment("sender", "r0", 1000, "USD");
        payment.timestamp = Utc::now() + Duration::hours(12);
        let score = engine.score_payment(&payment);

        let has_temporal = score
            .anomalies
            .iter()
            .any(|a| a.anomaly_type == AnomalyType::TemporalAnomaly);
        assert!(
            !has_temporal,
            "Should not detect temporal anomaly with fewer than 10 transactions"
        );
    }
}
