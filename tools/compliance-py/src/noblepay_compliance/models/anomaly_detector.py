"""Transaction anomaly detection using Isolation Forest."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np
import pandas as pd
from sklearn.ensemble import IsolationForest
from sklearn.preprocessing import StandardScaler

from noblepay_compliance.utils.constants import RISK_FEATURE_COLUMNS


@dataclass
class AnomalyResult:
    """Result for a single observation."""

    is_anomaly: bool
    anomaly_score: float  # higher = more anomalous (0..1 normalised)


class AnomalyDetector:
    """Unsupervised anomaly detector based on Isolation Forest.

    Learns normal transaction patterns and flags outliers.
    """

    def __init__(
        self,
        contamination: float = 0.05,
        n_estimators: int = 200,
        random_state: int = 42,
        feature_columns: list[str] | None = None,
    ) -> None:
        self.feature_columns = feature_columns or RISK_FEATURE_COLUMNS
        self.contamination = contamination
        self.scaler = StandardScaler()
        self.model = IsolationForest(
            contamination=contamination,
            n_estimators=n_estimators,
            random_state=random_state,
        )
        self._is_fitted: bool = False

    # ------------------------------------------------------------------
    # Training
    # ------------------------------------------------------------------

    def fit(self, df: pd.DataFrame) -> dict[str, Any]:
        """Fit the detector on (presumed-normal) transaction data.

        Returns basic statistics about the fitted model.
        """
        X = df[self.feature_columns].values.astype(np.float64)
        X_scaled = self.scaler.fit_transform(X)
        self.model.fit(X_scaled)
        self._is_fitted = True

        scores = self.model.decision_function(X_scaled)
        return {
            "n_samples": len(X),
            "score_mean": float(np.mean(scores)),
            "score_std": float(np.std(scores)),
            "contamination": self.contamination,
        }

    # ------------------------------------------------------------------
    # Detection
    # ------------------------------------------------------------------

    def detect(self, df: pd.DataFrame) -> list[AnomalyResult]:
        """Score each row; return ``AnomalyResult`` per transaction."""
        if not self._is_fitted:
            raise RuntimeError("Detector has not been fitted. Call fit() first.")

        X = df[self.feature_columns].values.astype(np.float64)
        X_scaled = self.scaler.transform(X)

        # decision_function: higher = more normal, lower = more anomalous
        raw_scores = self.model.decision_function(X_scaled)
        labels = self.model.predict(X_scaled)  # 1 = normal, -1 = anomaly

        # Normalise scores to 0..1 where 1 = most anomalous
        min_s, max_s = float(raw_scores.min()), float(raw_scores.max())
        if max_s == min_s:
            normalised = np.zeros_like(raw_scores)
        else:
            normalised = (max_s - raw_scores) / (max_s - min_s)

        results: list[AnomalyResult] = []
        for label, norm_score in zip(labels, normalised):
            results.append(AnomalyResult(
                is_anomaly=(label == -1),
                anomaly_score=float(norm_score),
            ))
        return results

    def detect_single(self, row: dict[str, Any]) -> AnomalyResult:
        """Detect anomaly for a single transaction dict."""
        df = pd.DataFrame([row])
        return self.detect(df)[0]

    @property
    def is_fitted(self) -> bool:
        return self._is_fitted
