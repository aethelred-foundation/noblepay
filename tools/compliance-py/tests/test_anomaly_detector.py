"""Tests for the Isolation Forest anomaly detector."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from noblepay_compliance.models.anomaly_detector import AnomalyDetector, AnomalyResult
from noblepay_compliance.utils.constants import RISK_FEATURE_COLUMNS


class TestAnomalyDetector:
    def _make_normal_df(self, rng: np.random.Generator, n: int = 200) -> pd.DataFrame:
        data: dict[str, np.ndarray] = {}
        for col in RISK_FEATURE_COLUMNS:
            if col.startswith("is_"):
                data[col] = rng.integers(0, 2, size=n).astype(np.float64)
            elif col == "hour_of_day":
                data[col] = rng.integers(0, 24, size=n).astype(np.float64)
            else:
                data[col] = rng.normal(1000, 100, size=n)
        return pd.DataFrame(data)

    def test_fit_returns_stats(self, rng: np.random.Generator):
        df = self._make_normal_df(rng)
        detector = AnomalyDetector(n_estimators=50)
        stats = detector.fit(df)
        assert stats["n_samples"] == 200
        assert detector.is_fitted

    def test_detect_returns_results(self, rng: np.random.Generator):
        df = self._make_normal_df(rng)
        detector = AnomalyDetector(n_estimators=50, contamination=0.05)
        detector.fit(df)
        results = detector.detect(df)
        assert len(results) == len(df)
        for r in results:
            assert isinstance(r, AnomalyResult)
            assert 0.0 <= r.anomaly_score <= 1.0

    def test_detect_before_fit_raises(self, rng: np.random.Generator):
        df = self._make_normal_df(rng)
        detector = AnomalyDetector()
        with pytest.raises(RuntimeError, match="not been fitted"):
            detector.detect(df)

    def test_outliers_detected(self, rng: np.random.Generator):
        df = self._make_normal_df(rng, n=300)
        detector = AnomalyDetector(n_estimators=100, contamination=0.1)
        detector.fit(df)

        # Create extreme outlier
        outlier = {col: 99999.0 for col in RISK_FEATURE_COLUMNS}
        result = detector.detect_single(outlier)
        assert result.is_anomaly or result.anomaly_score > 0.3  # should be flagged or high score

    def test_detect_single(self, rng: np.random.Generator):
        df = self._make_normal_df(rng)
        detector = AnomalyDetector(n_estimators=50)
        detector.fit(df)
        row = df.iloc[0].to_dict()
        result = detector.detect_single(row)
        assert isinstance(result, AnomalyResult)

    def test_detect_identical_scores_branch(self, rng: np.random.Generator):
        """When all rows are identical, decision_function returns the same score
        for every row, so max_s == min_s and normalised should be all zeros."""
        df = self._make_normal_df(rng, n=100)
        detector = AnomalyDetector(n_estimators=50)
        detector.fit(df)
        # Create a DataFrame where all rows are identical
        single_row = df.iloc[[0]]
        identical_df = pd.concat([single_row] * 5, ignore_index=True)
        results = detector.detect(identical_df)
        assert len(results) == 5
        for r in results:
            assert r.anomaly_score == 0.0

    def test_custom_feature_columns(self, rng: np.random.Generator):
        """Test constructor with custom feature_columns."""
        cols = ["amount_usd", "sender_risk_score"]
        detector = AnomalyDetector(n_estimators=20, feature_columns=cols)
        assert detector.feature_columns == cols
        n = 100
        df = pd.DataFrame({
            "amount_usd": rng.normal(1000, 100, size=n),
            "sender_risk_score": rng.uniform(0, 1, size=n),
        })
        stats = detector.fit(df)
        assert stats["n_samples"] == n
        results = detector.detect(df)
        assert len(results) == n

    def test_is_fitted_false_initially(self):
        detector = AnomalyDetector()
        assert detector.is_fitted is False
