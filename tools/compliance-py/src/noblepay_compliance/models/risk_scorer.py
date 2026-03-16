"""ML risk scoring model using gradient-boosted classifier."""

from __future__ import annotations

import pickle
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
from sklearn.ensemble import GradientBoostingClassifier
from sklearn.model_selection import cross_val_score
from sklearn.preprocessing import StandardScaler

from noblepay_compliance.utils.constants import (
    HIGH_RISK_THRESHOLD,
    LOW_RISK_THRESHOLD,
    MEDIUM_RISK_THRESHOLD,
    RISK_FEATURE_COLUMNS,
)


@dataclass
class RiskPrediction:
    """Result of a single risk prediction."""

    score: float
    label: str  # "low", "medium", "high"
    feature_importances: dict[str, float] = field(default_factory=dict)

    @staticmethod
    def label_from_score(score: float) -> str:
        if score >= HIGH_RISK_THRESHOLD:
            return "high"
        if score >= MEDIUM_RISK_THRESHOLD:
            return "medium"
        return "low"


class RiskScorer:
    """Gradient-boosted classifier for transaction risk scoring.

    The model predicts the probability that a transaction is suspicious /
    high-risk.  It wraps scikit-learn's ``GradientBoostingClassifier`` with
    standardised pre-processing and convenience helpers for training,
    prediction, and persistence.
    """

    def __init__(
        self,
        n_estimators: int = 200,
        max_depth: int = 4,
        learning_rate: float = 0.1,
        random_state: int = 42,
        feature_columns: list[str] | None = None,
    ) -> None:
        self.feature_columns = feature_columns or RISK_FEATURE_COLUMNS
        self.scaler = StandardScaler()
        self.model = GradientBoostingClassifier(
            n_estimators=n_estimators,
            max_depth=max_depth,
            learning_rate=learning_rate,
            random_state=random_state,
        )
        self._is_fitted: bool = False

    # ------------------------------------------------------------------
    # Training
    # ------------------------------------------------------------------

    def train(
        self,
        df: pd.DataFrame,
        label_column: str = "is_suspicious",
    ) -> dict[str, Any]:
        """Train the model on a labelled DataFrame.

        Returns a dict with training metrics (accuracy, cross-val scores).
        """
        X = df[self.feature_columns].values.astype(np.float64)
        y = df[label_column].values.astype(np.int64)

        X_scaled = self.scaler.fit_transform(X)
        self.model.fit(X_scaled, y)
        self._is_fitted = True

        cv_scores = cross_val_score(self.model, X_scaled, y, cv=min(5, len(y)), scoring="accuracy")
        return {
            "accuracy_mean": float(np.mean(cv_scores)),
            "accuracy_std": float(np.std(cv_scores)),
            "n_samples": len(y),
            "n_positive": int(y.sum()),
            "feature_importances": dict(zip(self.feature_columns, self.model.feature_importances_.tolist())),
        }

    # ------------------------------------------------------------------
    # Prediction
    # ------------------------------------------------------------------

    def predict(self, df: pd.DataFrame) -> list[RiskPrediction]:
        """Return a list of ``RiskPrediction`` for each row in *df*."""
        if not self._is_fitted:
            raise RuntimeError("Model has not been trained yet. Call train() first.")

        X = df[self.feature_columns].values.astype(np.float64)
        X_scaled = self.scaler.transform(X)
        probas = self.model.predict_proba(X_scaled)[:, 1]

        importances = dict(zip(self.feature_columns, self.model.feature_importances_.tolist()))
        results: list[RiskPrediction] = []
        for p in probas:
            score = float(p)
            results.append(RiskPrediction(
                score=score,
                label=RiskPrediction.label_from_score(score),
                feature_importances=importances,
            ))
        return results

    def predict_single(self, row: dict[str, Any]) -> RiskPrediction:
        """Predict risk for a single transaction dict."""
        df = pd.DataFrame([row])
        return self.predict(df)[0]

    # ------------------------------------------------------------------
    # Persistence
    # ------------------------------------------------------------------

    def save(self, path: str | Path) -> None:
        """Persist model + scaler to disk."""
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "wb") as f:
            pickle.dump({"model": self.model, "scaler": self.scaler, "features": self.feature_columns}, f)

    def load(self, path: str | Path) -> None:
        """Load a previously saved model."""
        with open(path, "rb") as f:
            data = pickle.load(f)  # noqa: S301
        self.model = data["model"]
        self.scaler = data["scaler"]
        self.feature_columns = data["features"]
        self._is_fitted = True

    @property
    def is_fitted(self) -> bool:
        return self._is_fitted
