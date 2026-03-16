"""Tests for the gradient-boosted risk scorer."""

from __future__ import annotations

import tempfile
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from noblepay_compliance.models.risk_scorer import RiskPrediction, RiskScorer


class TestRiskPrediction:
    def test_label_low(self):
        assert RiskPrediction.label_from_score(0.1) == "low"

    def test_label_medium(self):
        assert RiskPrediction.label_from_score(0.5) == "medium"

    def test_label_high(self):
        assert RiskPrediction.label_from_score(0.8) == "high"


class TestRiskScorer:
    def test_train_returns_metrics(self, training_df: pd.DataFrame):
        scorer = RiskScorer(n_estimators=20, max_depth=2)
        metrics = scorer.train(training_df)
        assert "accuracy_mean" in metrics
        assert metrics["n_samples"] == len(training_df)
        assert scorer.is_fitted

    def test_predict_returns_predictions(self, training_df: pd.DataFrame):
        scorer = RiskScorer(n_estimators=20, max_depth=2)
        scorer.train(training_df)
        preds = scorer.predict(training_df.head(5))
        assert len(preds) == 5
        for p in preds:
            assert 0.0 <= p.score <= 1.0
            assert p.label in ("low", "medium", "high")

    def test_predict_single(self, training_df: pd.DataFrame):
        scorer = RiskScorer(n_estimators=20, max_depth=2)
        scorer.train(training_df)
        row = training_df.iloc[0].to_dict()
        pred = scorer.predict_single(row)
        assert isinstance(pred, RiskPrediction)

    def test_predict_before_train_raises(self, training_df: pd.DataFrame):
        scorer = RiskScorer()
        with pytest.raises(RuntimeError, match="not been trained"):
            scorer.predict(training_df.head(1))

    def test_save_and_load(self, training_df: pd.DataFrame):
        scorer = RiskScorer(n_estimators=20, max_depth=2)
        scorer.train(training_df)
        preds_before = scorer.predict(training_df.head(3))

        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "model.pkl"
            scorer.save(path)

            scorer2 = RiskScorer()
            scorer2.load(path)
            preds_after = scorer2.predict(training_df.head(3))

        for a, b in zip(preds_before, preds_after):
            assert abs(a.score - b.score) < 1e-9

    def test_feature_importances_present(self, training_df: pd.DataFrame):
        scorer = RiskScorer(n_estimators=20, max_depth=2)
        scorer.train(training_df)
        preds = scorer.predict(training_df.head(1))
        assert len(preds[0].feature_importances) > 0

    def test_is_fitted_false_initially(self):
        scorer = RiskScorer()
        assert scorer.is_fitted is False

    def test_custom_feature_columns(self, rng):
        """Test scorer with custom feature columns."""
        cols = ["amount_usd", "sender_risk_score"]
        scorer = RiskScorer(n_estimators=10, max_depth=2, feature_columns=cols)
        assert scorer.feature_columns == cols


class TestRiskPredictionBoundaries:
    def test_label_at_high_threshold(self):
        from noblepay_compliance.utils.constants import HIGH_RISK_THRESHOLD
        assert RiskPrediction.label_from_score(HIGH_RISK_THRESHOLD) == "high"

    def test_label_at_medium_threshold(self):
        from noblepay_compliance.utils.constants import MEDIUM_RISK_THRESHOLD
        assert RiskPrediction.label_from_score(MEDIUM_RISK_THRESHOLD) == "medium"

    def test_label_just_below_medium(self):
        from noblepay_compliance.utils.constants import MEDIUM_RISK_THRESHOLD
        assert RiskPrediction.label_from_score(MEDIUM_RISK_THRESHOLD - 0.01) == "low"

    def test_label_at_zero(self):
        assert RiskPrediction.label_from_score(0.0) == "low"

    def test_label_at_one(self):
        assert RiskPrediction.label_from_score(1.0) == "high"
