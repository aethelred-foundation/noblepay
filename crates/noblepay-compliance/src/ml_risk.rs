//! Machine Learning Risk Scoring Engine
//!
//! A pure-Rust implementation of a decision tree ensemble (simplified random forest)
//! for transaction risk scoring inside TEE environments. The engine extracts features
//! from payment data and produces calibrated risk scores with per-feature explanations.
//!
//! ## Design Principles
//!
//! - **No external dependencies**: All ML logic is implemented in pure Rust to minimize
//!   the TEE attack surface.
//! - **Deterministic**: Given the same model weights and input, the output is identical
//!   across runs — critical for attestation reproducibility.
//! - **Explainable**: Every score includes feature-level contribution breakdowns for
//!   regulatory audit trails.

use std::collections::HashMap;
use std::sync::Arc;

use chrono::{DateTime, Datelike, Timelike, Utc};
use serde::{Deserialize, Serialize};
use tracing::{info, warn};

use crate::types::Payment;

// ---------------------------------------------------------------------------
// Feature definitions
// ---------------------------------------------------------------------------

/// Features extracted from a payment for ML scoring.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FeatureVector {
    /// Normalized transaction amount (log-scaled).
    pub amount_log: f64,
    /// Amount relative to historical average for this entity.
    pub amount_deviation: f64,
    /// Number of transactions in the last 24 hours.
    pub velocity_24h: f64,
    /// Number of transactions in the last 7 days.
    pub velocity_7d: f64,
    /// Number of unique counterparties in last 30 days.
    pub counterparty_diversity: f64,
    /// Jurisdiction risk score (0.0 = low, 1.0 = critical).
    pub jurisdiction_risk: f64,
    /// Hour of day (normalized 0.0–1.0).
    pub time_of_day: f64,
    /// Day of week (normalized 0.0–1.0).
    pub day_of_week: f64,
    /// Whether the counterparty is new (0 or 1).
    pub is_new_counterparty: f64,
    /// Account age in days (normalized).
    pub account_age: f64,
    /// Transaction frequency deviation from baseline.
    pub frequency_deviation: f64,
    /// Amount just below reporting threshold indicator.
    pub structuring_indicator: f64,
    /// Round amount indicator (amounts like 10000, 50000).
    pub round_amount: f64,
    /// Cross-border indicator (0 or 1).
    pub cross_border: f64,
    /// Currency risk factor.
    pub currency_risk: f64,
}

impl FeatureVector {
    /// Extract features from a payment and optional historical context.
    pub fn from_payment(
        payment: &Payment,
        history: Option<&EntityHistory>,
    ) -> Self {
        let amount = payment.amount as f64;
        let amount_log = (amount + 1.0).ln();

        let hist = history.cloned().unwrap_or_default();

        let amount_deviation = if hist.avg_amount > 0.0 {
            (amount - hist.avg_amount).abs() / hist.avg_amount.max(1.0)
        } else {
            0.5
        };

        let jurisdiction_risk = Self::jurisdiction_risk_score(&payment.currency);
        let timestamp = payment.timestamp;
        let hour = timestamp.hour() as f64;
        let weekday = timestamp.weekday().num_days_from_monday() as f64;

        let structuring = Self::structuring_score(amount);
        let round = if amount % 1000.0 == 0.0 && amount >= 5000.0 { 1.0 } else { 0.0 };

        Self {
            amount_log,
            amount_deviation,
            velocity_24h: hist.tx_count_24h as f64,
            velocity_7d: hist.tx_count_7d as f64,
            counterparty_diversity: hist.unique_counterparties as f64 / 20.0,
            jurisdiction_risk,
            time_of_day: hour / 24.0,
            day_of_week: weekday / 7.0,
            is_new_counterparty: if hist.is_known_counterparty { 0.0 } else { 1.0 },
            account_age: (hist.account_age_days as f64 / 365.0).min(1.0),
            frequency_deviation: hist.frequency_deviation,
            structuring_indicator: structuring,
            round_amount: round,
            cross_border: if hist.is_cross_border { 1.0 } else { 0.0 },
            currency_risk: Self::currency_risk_score(&payment.currency),
        }
    }

    /// Convert to a flat array for tree evaluation.
    pub fn to_array(&self) -> [f64; 15] {
        [
            self.amount_log, self.amount_deviation, self.velocity_24h,
            self.velocity_7d, self.counterparty_diversity, self.jurisdiction_risk,
            self.time_of_day, self.day_of_week, self.is_new_counterparty,
            self.account_age, self.frequency_deviation, self.structuring_indicator,
            self.round_amount, self.cross_border, self.currency_risk,
        ]
    }

    fn jurisdiction_risk_score(currency: &str) -> f64 {
        match currency {
            "USD" | "EUR" | "GBP" | "SGD" | "AED" => 0.1,
            "USDC" | "USDT" => 0.15,
            "AET" => 0.2,
            "INR" | "BRL" | "TRY" => 0.4,
            "PKR" | "VND" | "NGN" => 0.65,
            _ => 0.5,
        }
    }

    fn currency_risk_score(currency: &str) -> f64 {
        match currency {
            "USD" | "EUR" | "GBP" => 0.05,
            "AED" | "SGD" => 0.1,
            "USDC" | "USDT" => 0.15,
            "AET" => 0.25,
            _ => 0.4,
        }
    }

    fn structuring_score(amount: f64) -> f64 {
        let thresholds = [9900.0, 14900.0, 49900.0, 54900.0, 99900.0];
        for &threshold in &thresholds {
            if (amount - threshold).abs() < 200.0 {
                return 0.9;
            }
        }
        0.0
    }
}

/// Historical context for an entity used in feature extraction.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct EntityHistory {
    pub avg_amount: f64,
    pub tx_count_24h: u32,
    pub tx_count_7d: u32,
    pub unique_counterparties: u32,
    pub account_age_days: u32,
    pub is_known_counterparty: bool,
    pub is_cross_border: bool,
    pub frequency_deviation: f64,
}

// ---------------------------------------------------------------------------
// Decision Tree
// ---------------------------------------------------------------------------

/// A single decision tree node.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum TreeNode {
    /// Internal split node.
    Split {
        feature_index: usize,
        threshold: f64,
        left: Box<TreeNode>,
        right: Box<TreeNode>,
    },
    /// Leaf node with a risk score.
    Leaf {
        score: f64,
        samples: u32,
    },
}

impl TreeNode {
    /// Evaluate this tree on a feature vector.
    pub fn predict(&self, features: &[f64; 15]) -> f64 {
        match self {
            TreeNode::Split { feature_index, threshold, left, right } => {
                if features[*feature_index] <= *threshold {
                    left.predict(features)
                } else {
                    right.predict(features)
                }
            }
            TreeNode::Leaf { score, .. } => *score,
        }
    }
}

// ---------------------------------------------------------------------------
// Random Forest Ensemble
// ---------------------------------------------------------------------------

/// A simplified random forest ensemble for risk scoring.
#[derive(Debug, Clone)]
pub struct RiskForest {
    pub trees: Vec<TreeNode>,
    pub feature_names: Vec<String>,
    pub version: String,
    pub trained_at: DateTime<Utc>,
}

impl RiskForest {
    /// Create a new forest with pre-trained trees.
    pub fn default_model() -> Self {
        let feature_names: Vec<String> = vec![
            "amount_log", "amount_deviation", "velocity_24h", "velocity_7d",
            "counterparty_diversity", "jurisdiction_risk", "time_of_day",
            "day_of_week", "is_new_counterparty", "account_age",
            "frequency_deviation", "structuring_indicator", "round_amount",
            "cross_border", "currency_risk",
        ].into_iter().map(String::from).collect();

        // Pre-trained decision trees (simplified for TEE deployment)
        let trees = vec![
            Self::build_tree_1(),
            Self::build_tree_2(),
            Self::build_tree_3(),
            Self::build_tree_4(),
            Self::build_tree_5(),
        ];

        Self {
            trees,
            feature_names,
            version: "4.0.3".to_string(),
            trained_at: Utc::now(),
        }
    }

    /// Predict risk score (0.0–1.0) with feature importances.
    pub fn predict(&self, features: &FeatureVector) -> MLPrediction {
        let arr = features.to_array();
        let mut scores: Vec<f64> = Vec::with_capacity(self.trees.len());

        for tree in &self.trees {
            scores.push(tree.predict(&arr));
        }

        let avg_score = scores.iter().sum::<f64>() / scores.len() as f64;
        let calibrated = Self::calibrate(avg_score);

        // Calculate feature importances via perturbation
        let importances = self.feature_importances(features, calibrated);

        // Confidence based on tree agreement
        let variance = scores.iter()
            .map(|s| (s - avg_score).powi(2))
            .sum::<f64>() / scores.len() as f64;
        let confidence = (1.0 - variance.sqrt()).max(0.0).min(1.0);

        MLPrediction {
            risk_score: (calibrated * 100.0).min(100.0).max(0.0) as u8,
            confidence,
            feature_importances: importances,
            model_version: self.version.clone(),
            tree_scores: scores,
        }
    }

    /// Batch predict for throughput optimization.
    pub fn predict_batch(&self, features: &[FeatureVector]) -> Vec<MLPrediction> {
        features.iter().map(|f| self.predict(f)).collect()
    }

    /// Calibrate raw score to a probability using sigmoid.
    fn calibrate(raw: f64) -> f64 {
        1.0 / (1.0 + (-5.0 * (raw - 0.5)).exp())
    }

    /// Calculate per-feature importance via simple perturbation.
    fn feature_importances(
        &self,
        features: &FeatureVector,
        base_score: f64,
    ) -> Vec<FeatureImportance> {
        let arr = features.to_array();
        let mut importances = Vec::with_capacity(15);

        for i in 0..15 {
            let mut perturbed = arr;
            perturbed[i] = 0.0; // Zero out feature

            let perturbed_scores: Vec<f64> = self.trees.iter()
                .map(|t| t.predict(&perturbed))
                .collect();
            let perturbed_avg = perturbed_scores.iter().sum::<f64>() / perturbed_scores.len() as f64;
            let perturbed_calibrated = Self::calibrate(perturbed_avg);

            let impact = (base_score - perturbed_calibrated).abs();

            importances.push(FeatureImportance {
                feature: self.feature_names[i].clone(),
                importance: impact,
                value: arr[i],
                contribution: if base_score > perturbed_calibrated {
                    "increases_risk"
                } else {
                    "decreases_risk"
                }.to_string(),
            });
        }

        importances.sort_by(|a, b| b.importance.partial_cmp(&a.importance).unwrap_or(std::cmp::Ordering::Equal));
        importances
    }

    // Pre-trained trees (simplified representations)
    fn build_tree_1() -> TreeNode {
        TreeNode::Split {
            feature_index: 0, // amount_log
            threshold: 9.2,   // ~$10K
            left: Box::new(TreeNode::Split {
                feature_index: 5, // jurisdiction_risk
                threshold: 0.3,
                left: Box::new(TreeNode::Leaf { score: 0.1, samples: 5000 }),
                right: Box::new(TreeNode::Leaf { score: 0.35, samples: 1200 }),
            }),
            right: Box::new(TreeNode::Split {
                feature_index: 8, // is_new_counterparty
                threshold: 0.5,
                left: Box::new(TreeNode::Leaf { score: 0.3, samples: 2000 }),
                right: Box::new(TreeNode::Split {
                    feature_index: 11, // structuring
                    threshold: 0.5,
                    left: Box::new(TreeNode::Leaf { score: 0.5, samples: 800 }),
                    right: Box::new(TreeNode::Leaf { score: 0.85, samples: 200 }),
                }),
            }),
        }
    }

    fn build_tree_2() -> TreeNode {
        TreeNode::Split {
            feature_index: 2, // velocity_24h
            threshold: 5.0,
            left: Box::new(TreeNode::Split {
                feature_index: 14, // currency_risk
                threshold: 0.2,
                left: Box::new(TreeNode::Leaf { score: 0.08, samples: 4000 }),
                right: Box::new(TreeNode::Leaf { score: 0.25, samples: 1500 }),
            }),
            right: Box::new(TreeNode::Split {
                feature_index: 10, // frequency_deviation
                threshold: 2.0,
                left: Box::new(TreeNode::Leaf { score: 0.4, samples: 1000 }),
                right: Box::new(TreeNode::Leaf { score: 0.75, samples: 500 }),
            }),
        }
    }

    fn build_tree_3() -> TreeNode {
        TreeNode::Split {
            feature_index: 13, // cross_border
            threshold: 0.5,
            left: Box::new(TreeNode::Split {
                feature_index: 1, // amount_deviation
                threshold: 2.0,
                left: Box::new(TreeNode::Leaf { score: 0.12, samples: 3500 }),
                right: Box::new(TreeNode::Leaf { score: 0.45, samples: 800 }),
            }),
            right: Box::new(TreeNode::Split {
                feature_index: 5, // jurisdiction_risk
                threshold: 0.5,
                left: Box::new(TreeNode::Leaf { score: 0.3, samples: 1500 }),
                right: Box::new(TreeNode::Leaf { score: 0.7, samples: 700 }),
            }),
        }
    }

    fn build_tree_4() -> TreeNode {
        TreeNode::Split {
            feature_index: 9, // account_age
            threshold: 0.08,  // ~30 days
            left: Box::new(TreeNode::Split {
                feature_index: 0, // amount_log
                threshold: 8.5,
                left: Box::new(TreeNode::Leaf { score: 0.35, samples: 600 }),
                right: Box::new(TreeNode::Leaf { score: 0.7, samples: 300 }),
            }),
            right: Box::new(TreeNode::Split {
                feature_index: 4, // counterparty_diversity
                threshold: 0.8,
                left: Box::new(TreeNode::Leaf { score: 0.15, samples: 4500 }),
                right: Box::new(TreeNode::Leaf { score: 0.55, samples: 400 }),
            }),
        }
    }

    fn build_tree_5() -> TreeNode {
        TreeNode::Split {
            feature_index: 6, // time_of_day
            threshold: 0.25,  // 6 AM
            left: Box::new(TreeNode::Split {
                feature_index: 12, // round_amount
                threshold: 0.5,
                left: Box::new(TreeNode::Leaf { score: 0.2, samples: 800 }),
                right: Box::new(TreeNode::Leaf { score: 0.55, samples: 200 }),
            }),
            right: Box::new(TreeNode::Split {
                feature_index: 3, // velocity_7d
                threshold: 20.0,
                left: Box::new(TreeNode::Leaf { score: 0.12, samples: 5000 }),
                right: Box::new(TreeNode::Leaf { score: 0.6, samples: 600 }),
            }),
        }
    }
}

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

/// The result of an ML risk prediction.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MLPrediction {
    /// Composite risk score 0–100.
    pub risk_score: u8,
    /// Model confidence in the prediction (0.0–1.0).
    pub confidence: f64,
    /// Per-feature importance breakdown.
    pub feature_importances: Vec<FeatureImportance>,
    /// Model version that produced this prediction.
    pub model_version: String,
    /// Individual tree scores for ensemble transparency.
    pub tree_scores: Vec<f64>,
}

/// Importance of a single feature in the prediction.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FeatureImportance {
    /// Feature name.
    pub feature: String,
    /// Absolute importance (0.0–1.0).
    pub importance: f64,
    /// Raw feature value.
    pub value: f64,
    /// Whether this feature increases or decreases risk.
    pub contribution: String,
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_model_loads() {
        let forest = RiskForest::default_model();
        assert_eq!(forest.trees.len(), 5);
        assert_eq!(forest.feature_names.len(), 15);
    }

    #[test]
    fn low_risk_payment_scores_low() {
        let forest = RiskForest::default_model();
        let payment = Payment::test_payment("alice", "bob", 1000, "USD");
        let features = FeatureVector::from_payment(&payment, None);
        let prediction = forest.predict(&features);
        assert!(prediction.risk_score < 50, "Low-value USD payment should score < 50, got {}", prediction.risk_score);
    }

    #[test]
    fn high_value_new_counterparty_scores_higher() {
        let forest = RiskForest::default_model();
        let payment = Payment::test_payment("sender", "new-recipient", 500_000, "AET");
        let history = EntityHistory {
            avg_amount: 5000.0,
            tx_count_24h: 0,
            tx_count_7d: 1,
            unique_counterparties: 1,
            account_age_days: 10,
            is_known_counterparty: false,
            is_cross_border: true,
            frequency_deviation: 3.0,
        };
        let features = FeatureVector::from_payment(&payment, Some(&history));
        let prediction = forest.predict(&features);
        assert!(prediction.risk_score > 30, "High-value cross-border payment should score > 30");
    }

    #[test]
    fn feature_importances_are_populated() {
        let forest = RiskForest::default_model();
        let payment = Payment::test_payment("test", "test2", 50000, "USD");
        let features = FeatureVector::from_payment(&payment, None);
        let prediction = forest.predict(&features);
        assert_eq!(prediction.feature_importances.len(), 15);
    }

    #[test]
    fn batch_prediction_works() {
        let forest = RiskForest::default_model();
        let payments: Vec<FeatureVector> = (0..10)
            .map(|i| {
                let p = Payment::test_payment("s", "r", (i + 1) * 1000, "USD");
                FeatureVector::from_payment(&p, None)
            })
            .collect();
        let results = forest.predict_batch(&payments);
        assert_eq!(results.len(), 10);
    }

    #[test]
    fn calibration_sigmoid_is_bounded() {
        assert!(RiskForest::calibrate(0.0) > 0.0);
        assert!(RiskForest::calibrate(1.0) < 1.0);
        assert!((RiskForest::calibrate(0.5) - 0.5).abs() < 0.01);
    }

    // -----------------------------------------------------------------------
    // FeatureVector::from_payment edge cases
    // -----------------------------------------------------------------------

    #[test]
    fn feature_vector_no_history_uses_defaults() {
        let payment = Payment::test_payment("alice", "bob", 5000, "USD");
        let fv = FeatureVector::from_payment(&payment, None);
        // No history → amount_deviation defaults to 0.5
        assert!((fv.amount_deviation - 0.5).abs() < f64::EPSILON);
        // No history → new counterparty
        assert!((fv.is_new_counterparty - 1.0).abs() < f64::EPSILON);
        // No history → not cross-border
        assert!((fv.cross_border - 0.0).abs() < f64::EPSILON);
        // velocity fields should be 0
        assert!((fv.velocity_24h - 0.0).abs() < f64::EPSILON);
        assert!((fv.velocity_7d - 0.0).abs() < f64::EPSILON);
    }

    #[test]
    fn feature_vector_with_known_counterparty_history() {
        let payment = Payment::test_payment("alice", "bob", 10000, "EUR");
        let history = EntityHistory {
            avg_amount: 10000.0,
            tx_count_24h: 3,
            tx_count_7d: 15,
            unique_counterparties: 5,
            account_age_days: 365,
            is_known_counterparty: true,
            is_cross_border: false,
            frequency_deviation: 1.0,
        };
        let fv = FeatureVector::from_payment(&payment, Some(&history));
        // Known counterparty → 0.0
        assert!((fv.is_new_counterparty - 0.0).abs() < f64::EPSILON);
        // Amount matches avg → deviation should be 0.0
        assert!((fv.amount_deviation - 0.0).abs() < f64::EPSILON);
        // Account age 365 days / 365 = 1.0, clamped to 1.0
        assert!((fv.account_age - 1.0).abs() < f64::EPSILON);
        // velocity_24h = 3.0
        assert!((fv.velocity_24h - 3.0).abs() < f64::EPSILON);
        // velocity_7d = 15.0
        assert!((fv.velocity_7d - 15.0).abs() < f64::EPSILON);
        // counterparty_diversity = 5/20 = 0.25
        assert!((fv.counterparty_diversity - 0.25).abs() < f64::EPSILON);
        // frequency_deviation = 1.0
        assert!((fv.frequency_deviation - 1.0).abs() < f64::EPSILON);
    }

    #[test]
    fn feature_vector_cross_border_flag() {
        let payment = Payment::test_payment("alice", "bob", 1000, "USD");
        let history = EntityHistory {
            is_cross_border: true,
            ..EntityHistory::default()
        };
        let fv = FeatureVector::from_payment(&payment, Some(&history));
        assert!((fv.cross_border - 1.0).abs() < f64::EPSILON);
    }

    #[test]
    fn feature_vector_account_age_capped_at_one() {
        let payment = Payment::test_payment("alice", "bob", 1000, "USD");
        let history = EntityHistory {
            account_age_days: 1000, // > 365
            ..EntityHistory::default()
        };
        let fv = FeatureVector::from_payment(&payment, Some(&history));
        assert!((fv.account_age - 1.0).abs() < f64::EPSILON);
    }

    // -----------------------------------------------------------------------
    // Structuring score thresholds
    // -----------------------------------------------------------------------

    #[test]
    fn structuring_score_near_thresholds() {
        // Amounts near each threshold should score 0.9
        assert!((FeatureVector::structuring_score(9900.0) - 0.9).abs() < f64::EPSILON);
        assert!((FeatureVector::structuring_score(14900.0) - 0.9).abs() < f64::EPSILON);
        assert!((FeatureVector::structuring_score(49900.0) - 0.9).abs() < f64::EPSILON);
        assert!((FeatureVector::structuring_score(54900.0) - 0.9).abs() < f64::EPSILON);
        assert!((FeatureVector::structuring_score(99900.0) - 0.9).abs() < f64::EPSILON);
    }

    #[test]
    fn structuring_score_within_200_range() {
        // Just inside the 200 range
        assert!((FeatureVector::structuring_score(9800.0) - 0.9).abs() < f64::EPSILON);
        assert!((FeatureVector::structuring_score(10000.0) - 0.9).abs() < f64::EPSILON);
        // 10099 is within 200 of 9900: |10099 - 9900| = 199 < 200
        assert!((FeatureVector::structuring_score(10099.0) - 0.9).abs() < f64::EPSILON);
    }

    #[test]
    fn structuring_score_outside_range_is_zero() {
        assert!((FeatureVector::structuring_score(5000.0) - 0.0).abs() < f64::EPSILON);
        assert!((FeatureVector::structuring_score(20000.0) - 0.0).abs() < f64::EPSILON);
        assert!((FeatureVector::structuring_score(0.0) - 0.0).abs() < f64::EPSILON);
    }

    // -----------------------------------------------------------------------
    // Currency and jurisdiction risk scores
    // -----------------------------------------------------------------------

    #[test]
    fn jurisdiction_risk_score_known_currencies() {
        assert!((FeatureVector::jurisdiction_risk_score("USD") - 0.1).abs() < f64::EPSILON);
        assert!((FeatureVector::jurisdiction_risk_score("EUR") - 0.1).abs() < f64::EPSILON);
        assert!((FeatureVector::jurisdiction_risk_score("USDC") - 0.15).abs() < f64::EPSILON);
        assert!((FeatureVector::jurisdiction_risk_score("USDT") - 0.15).abs() < f64::EPSILON);
        assert!((FeatureVector::jurisdiction_risk_score("AET") - 0.2).abs() < f64::EPSILON);
        assert!((FeatureVector::jurisdiction_risk_score("INR") - 0.4).abs() < f64::EPSILON);
        assert!((FeatureVector::jurisdiction_risk_score("PKR") - 0.65).abs() < f64::EPSILON);
    }

    #[test]
    fn jurisdiction_risk_score_unknown_currency_defaults() {
        assert!((FeatureVector::jurisdiction_risk_score("XYZ") - 0.5).abs() < f64::EPSILON);
    }

    #[test]
    fn currency_risk_score_known_currencies() {
        assert!((FeatureVector::currency_risk_score("USD") - 0.05).abs() < f64::EPSILON);
        assert!((FeatureVector::currency_risk_score("GBP") - 0.05).abs() < f64::EPSILON);
        assert!((FeatureVector::currency_risk_score("AED") - 0.1).abs() < f64::EPSILON);
        assert!((FeatureVector::currency_risk_score("SGD") - 0.1).abs() < f64::EPSILON);
        assert!((FeatureVector::currency_risk_score("USDC") - 0.15).abs() < f64::EPSILON);
        assert!((FeatureVector::currency_risk_score("AET") - 0.25).abs() < f64::EPSILON);
    }

    #[test]
    fn currency_risk_score_unknown_defaults() {
        assert!((FeatureVector::currency_risk_score("UNKNOWN") - 0.4).abs() < f64::EPSILON);
    }

    // -----------------------------------------------------------------------
    // Batch with empty input
    // -----------------------------------------------------------------------

    #[test]
    fn batch_prediction_empty_input() {
        let forest = RiskForest::default_model();
        let results = forest.predict_batch(&[]);
        assert!(results.is_empty());
    }

    // -----------------------------------------------------------------------
    // Calibration boundaries
    // -----------------------------------------------------------------------

    #[test]
    fn calibration_extreme_values() {
        // Very negative raw score → close to 0
        let low = RiskForest::calibrate(-10.0);
        assert!(low < 0.01, "calibrate(-10) should be near 0, got {}", low);
        // Very positive raw score → close to 1
        let high = RiskForest::calibrate(10.0);
        assert!(high > 0.99, "calibrate(10) should be near 1, got {}", high);
    }

    #[test]
    fn calibration_is_monotonic() {
        let mut prev = RiskForest::calibrate(-5.0);
        for i in -4..=5 {
            let curr = RiskForest::calibrate(i as f64);
            assert!(curr >= prev, "calibrate should be monotonically increasing");
            prev = curr;
        }
    }

    // -----------------------------------------------------------------------
    // to_array and round-trip
    // -----------------------------------------------------------------------

    #[test]
    fn to_array_length_is_fifteen() {
        let payment = Payment::test_payment("a", "b", 1000, "USD");
        let fv = FeatureVector::from_payment(&payment, None);
        let arr = fv.to_array();
        assert_eq!(arr.len(), 15);
    }

    // -----------------------------------------------------------------------
    // Round amount indicator
    // -----------------------------------------------------------------------

    #[test]
    fn round_amount_indicator() {
        let payment_round = Payment::test_payment("a", "b", 10000, "USD");
        let fv = FeatureVector::from_payment(&payment_round, None);
        assert!((fv.round_amount - 1.0).abs() < f64::EPSILON);

        let payment_non_round = Payment::test_payment("a", "b", 10001, "USD");
        let fv2 = FeatureVector::from_payment(&payment_non_round, None);
        assert!((fv2.round_amount - 0.0).abs() < f64::EPSILON);

        // Below 5000 → not round
        let payment_small = Payment::test_payment("a", "b", 4000, "USD");
        let fv3 = FeatureVector::from_payment(&payment_small, None);
        assert!((fv3.round_amount - 0.0).abs() < f64::EPSILON);
    }

    // -----------------------------------------------------------------------
    // TreeNode predict
    // -----------------------------------------------------------------------

    #[test]
    fn tree_leaf_returns_score() {
        let leaf = TreeNode::Leaf { score: 0.42, samples: 100 };
        let features = [0.0; 15];
        assert!((leaf.predict(&features) - 0.42).abs() < f64::EPSILON);
    }

    #[test]
    fn tree_split_goes_left_when_below_threshold() {
        let tree = TreeNode::Split {
            feature_index: 0,
            threshold: 5.0,
            left: Box::new(TreeNode::Leaf { score: 0.1, samples: 10 }),
            right: Box::new(TreeNode::Leaf { score: 0.9, samples: 10 }),
        };
        let mut features = [0.0; 15];
        features[0] = 3.0; // below threshold
        assert!((tree.predict(&features) - 0.1).abs() < f64::EPSILON);
    }

    #[test]
    fn tree_split_goes_right_when_above_threshold() {
        let tree = TreeNode::Split {
            feature_index: 0,
            threshold: 5.0,
            left: Box::new(TreeNode::Leaf { score: 0.1, samples: 10 }),
            right: Box::new(TreeNode::Leaf { score: 0.9, samples: 10 }),
        };
        let mut features = [0.0; 15];
        features[0] = 7.0; // above threshold
        assert!((tree.predict(&features) - 0.9).abs() < f64::EPSILON);
    }

    // -----------------------------------------------------------------------
    // Model version
    // -----------------------------------------------------------------------

    #[test]
    fn prediction_includes_model_version() {
        let forest = RiskForest::default_model();
        let payment = Payment::test_payment("a", "b", 1000, "USD");
        let fv = FeatureVector::from_payment(&payment, None);
        let prediction = forest.predict(&fv);
        assert_eq!(prediction.model_version, "4.0.3");
    }

    #[test]
    fn prediction_risk_score_within_bounds() {
        let forest = RiskForest::default_model();
        for amount in [0, 100, 10000, 100000, 1000000, 10000000] {
            let payment = Payment::test_payment("a", "b", amount, "USD");
            let fv = FeatureVector::from_payment(&payment, None);
            let prediction = forest.predict(&fv);
            assert!(prediction.risk_score <= 100, "risk_score should be <= 100");
            assert!(prediction.confidence >= 0.0 && prediction.confidence <= 1.0);
        }
    }

    #[test]
    fn prediction_tree_scores_has_five_elements() {
        let forest = RiskForest::default_model();
        let payment = Payment::test_payment("a", "b", 1000, "USD");
        let fv = FeatureVector::from_payment(&payment, None);
        let prediction = forest.predict(&fv);
        assert_eq!(prediction.tree_scores.len(), 5);
    }
}
