"""Tests for fuzzy sanctions matching."""

from __future__ import annotations

import pytest

from noblepay_compliance.models.sanctions_matcher import (
    SanctionsEntry,
    SanctionsHit,
    SanctionsMatcher,
)


class TestSanctionsMatcher:
    def test_exact_match(self, sanctions_entries):
        matcher = SanctionsMatcher(threshold=85)
        matcher.load_entries(sanctions_entries)
        hits = matcher.screen("John Doe")
        assert any(h.is_match for h in hits)
        assert any(h.matched_name == "John Doe" for h in hits)

    def test_fuzzy_match(self, sanctions_entries):
        matcher = SanctionsMatcher(threshold=80)
        matcher.load_entries(sanctions_entries)
        hits = matcher.screen("Jon Doe")
        # Should still find a close match
        assert len(hits) > 0
        best = hits[0]
        assert best.score > 70

    def test_alias_match(self, sanctions_entries):
        matcher = SanctionsMatcher(threshold=85)
        matcher.load_entries(sanctions_entries)
        hits = matcher.screen("Johnny Doe")
        assert any(h.is_match for h in hits)

    def test_no_match(self, sanctions_entries):
        matcher = SanctionsMatcher(threshold=95)
        matcher.load_entries(sanctions_entries)
        result = matcher.is_sanctioned("Completely Different Name XYZ123")
        assert result is False

    def test_is_sanctioned_true(self, sanctions_entries):
        matcher = SanctionsMatcher(threshold=85)
        matcher.load_entries(sanctions_entries)
        assert matcher.is_sanctioned("John Doe") is True

    def test_batch_screening(self, sanctions_entries):
        matcher = SanctionsMatcher(threshold=85)
        matcher.load_entries(sanctions_entries)
        results = matcher.screen_batch(["John Doe", "Unknown Person"], top_k=2)
        assert "John Doe" in results
        assert "Unknown Person" in results
        assert len(results["John Doe"]) <= 2

    def test_entry_count(self, sanctions_entries):
        matcher = SanctionsMatcher()
        matcher.load_entries(sanctions_entries)
        assert matcher.entry_count == 4
        assert matcher.name_count > 4  # includes aliases

    def test_add_entry(self, sanctions_entries):
        matcher = SanctionsMatcher()
        matcher.load_entries(sanctions_entries)
        old_count = matcher.entry_count
        matcher.add_entry(SanctionsEntry(name="New Person", source="TEST"))
        assert matcher.entry_count == old_count + 1

    def test_empty_list(self):
        matcher = SanctionsMatcher()
        hits = matcher.screen("Anyone")
        assert hits == []

    def test_normalisation(self, sanctions_entries):
        matcher = SanctionsMatcher(threshold=85)
        matcher.load_entries(sanctions_entries)
        # Case-insensitive + whitespace-collapsed
        hits = matcher.screen("  JOHN   DOE  ")
        assert any(h.is_match for h in hits)

    def test_empty_query(self, sanctions_entries):
        """An empty or whitespace-only query should return no hits."""
        matcher = SanctionsMatcher(threshold=85)
        matcher.load_entries(sanctions_entries)
        hits = matcher.screen("")
        assert hits == []
        hits2 = matcher.screen("   ")
        assert hits2 == []

    def test_load_entries_replaces_previous(self, sanctions_entries):
        """Loading new entries replaces the old list entirely."""
        matcher = SanctionsMatcher()
        matcher.load_entries(sanctions_entries)
        assert matcher.entry_count == 4
        new_entries = [SanctionsEntry(name="New Person", source="TEST")]
        matcher.load_entries(new_entries)
        assert matcher.entry_count == 1
