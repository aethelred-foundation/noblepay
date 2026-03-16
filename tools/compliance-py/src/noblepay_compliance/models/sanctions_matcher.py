"""Fuzzy name matching against sanctions lists using rapidfuzz."""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field

from rapidfuzz import fuzz, process

from noblepay_compliance.utils.constants import SANCTIONS_MATCH_THRESHOLD


@dataclass
class SanctionsHit:
    """A single match result against the sanctions list."""

    query_name: str
    matched_name: str
    score: float  # 0..100
    list_source: str  # e.g. "OFAC-SDN", "EU-SANCTIONS"
    is_match: bool  # True if score >= threshold


@dataclass
class SanctionsEntry:
    """An entry on a sanctions list."""

    name: str
    aliases: list[str] = field(default_factory=list)
    source: str = "UNKNOWN"
    entity_id: str = ""


class SanctionsMatcher:
    """Fuzzy sanctions-list screening engine.

    Loads a list of sanctioned names (with aliases) and provides fast
    fuzzy matching using token-sort ratio (Levenshtein-based).
    """

    def __init__(self, threshold: int = SANCTIONS_MATCH_THRESHOLD) -> None:
        self.threshold = threshold
        self._entries: list[SanctionsEntry] = []
        # Flattened lookup: normalised_name -> (original_name, source)
        self._names: list[str] = []
        self._name_to_source: dict[str, str] = {}
        self._name_to_original: dict[str, str] = {}

    # ------------------------------------------------------------------
    # List management
    # ------------------------------------------------------------------

    @staticmethod
    def _normalise(name: str) -> str:
        """Lower-case, strip accents, collapse whitespace."""
        name = unicodedata.normalize("NFKD", name)
        name = "".join(c for c in name if not unicodedata.combining(c))
        name = name.lower().strip()
        name = re.sub(r"\s+", " ", name)
        return name

    def load_entries(self, entries: list[SanctionsEntry]) -> None:
        """Load sanctions entries (replaces any previously loaded data)."""
        self._entries = list(entries)
        self._names.clear()
        self._name_to_source.clear()
        self._name_to_original.clear()

        for entry in entries:
            all_names = [entry.name] + entry.aliases
            for n in all_names:
                norm = self._normalise(n)
                if norm:
                    self._names.append(norm)
                    self._name_to_source[norm] = entry.source
                    self._name_to_original[norm] = n

    def add_entry(self, entry: SanctionsEntry) -> None:
        """Add a single entry to the loaded list."""
        self._entries.append(entry)
        for n in [entry.name] + entry.aliases:
            norm = self._normalise(n)
            if norm:
                self._names.append(norm)
                self._name_to_source[norm] = entry.source
                self._name_to_original[norm] = n

    # ------------------------------------------------------------------
    # Matching
    # ------------------------------------------------------------------

    def screen(self, name: str, top_k: int = 5) -> list[SanctionsHit]:
        """Screen *name* against the loaded sanctions list.

        Returns up to *top_k* results sorted by match score descending.
        """
        if not self._names:
            return []

        norm_query = self._normalise(name)
        if not norm_query:
            return []

        matches = process.extract(
            norm_query,
            self._names,
            scorer=fuzz.token_sort_ratio,
            limit=top_k,
        )

        results: list[SanctionsHit] = []
        for matched_norm, score, _idx in matches:
            results.append(SanctionsHit(
                query_name=name,
                matched_name=self._name_to_original.get(matched_norm, matched_norm),
                score=float(score),
                list_source=self._name_to_source.get(matched_norm, "UNKNOWN"),
                is_match=score >= self.threshold,
            ))

        return results

    def is_sanctioned(self, name: str) -> bool:
        """Quick boolean check — True if any hit meets the threshold."""
        hits = self.screen(name, top_k=1)
        return bool(hits and hits[0].is_match)

    def screen_batch(self, names: list[str], top_k: int = 3) -> dict[str, list[SanctionsHit]]:
        """Screen multiple names; returns a dict keyed by input name."""
        return {n: self.screen(n, top_k=top_k) for n in names}

    @property
    def entry_count(self) -> int:
        return len(self._entries)

    @property
    def name_count(self) -> int:
        return len(self._names)
