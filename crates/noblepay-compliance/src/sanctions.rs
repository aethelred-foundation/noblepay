//! Sanctions screening engine with multi-list fuzzy entity matching.
//!
//! The [`SanctionsDatabase`] maintains an in-memory index of entries from OFAC,
//! UAE Central Bank, UN, and EU consolidated sanctions lists.  All lookups use
//! case-insensitive fuzzy matching (Levenshtein distance) so that minor name
//! transliteration differences do not cause false negatives.
//!
//! The database is thread-safe (`Arc<RwLock<...>>`) and supports hot-reload of
//! individual lists without blocking concurrent reads.

use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

use chrono::{DateTime, Utc};
use tracing::{info, warn};

use crate::types::{
    EntityType, SanctionsCheckResult, SanctionsEntry, SanctionsList, SanctionsMatchDetail,
};
use crate::ComplianceError;

/// Minimum similarity threshold (0.0–1.0) for a fuzzy match to be considered a hit.
const FUZZY_MATCH_THRESHOLD: f64 = 0.80;

/// A thread-safe, multi-list sanctions database with fuzzy matching.
#[derive(Clone)]
pub struct SanctionsDatabase {
    /// Entries indexed by list source.
    lists: Arc<RwLock<HashMap<SanctionsList, Vec<SanctionsEntry>>>>,
    /// Timestamp of the last successful update per list.
    last_updated: Arc<RwLock<HashMap<SanctionsList, DateTime<Utc>>>>,
}

impl SanctionsDatabase {
    /// Create a new, empty sanctions database.
    pub fn new() -> Self {
        Self {
            lists: Arc::new(RwLock::new(HashMap::new())),
            last_updated: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Initialize with built-in placeholder entries for all four lists.
    ///
    /// In production these would be fetched from upstream feeds; the built-in
    /// entries exist so that the engine is functional immediately after startup.
    pub async fn with_default_lists() -> Self {
        let db = Self::new();
        db.load_ofac_list().await;
        db.load_uae_list().await;
        db.load_un_list().await;
        db.load_eu_list().await;
        db
    }

    // -----------------------------------------------------------------------
    // List loaders
    // -----------------------------------------------------------------------

    /// Load OFAC SDN list entries.
    pub async fn load_ofac_list(&self) {
        let entries = vec![
            SanctionsEntry {
                entity_name: "BLOCKED PERSON ALPHA".into(),
                entity_type: EntityType::Individual,
                list_source: SanctionsList::Ofac,
                aliases: vec!["ALPHA PERSON".into(), "A. PERSON".into()],
                addresses: vec!["0xdead0001".into()],
                id_numbers: vec!["PASS-001".into()],
            },
            SanctionsEntry {
                entity_name: "SANCTIONED CORP ONE".into(),
                entity_type: EntityType::Organization,
                list_source: SanctionsList::Ofac,
                aliases: vec!["SC ONE".into()],
                addresses: vec!["0xdead0002".into()],
                id_numbers: vec!["REG-001".into()],
            },
        ];
        self.upsert_list(SanctionsList::Ofac, entries).await;
        info!("loaded OFAC SDN list ({} entries)", 2);
    }

    /// Load UAE Central Bank sanctions list entries.
    pub async fn load_uae_list(&self) {
        let entries = vec![SanctionsEntry {
            entity_name: "UAE BLOCKED ENTITY".into(),
            entity_type: EntityType::Organization,
            list_source: SanctionsList::UaeCentralBank,
            aliases: vec!["UBE".into()],
            addresses: vec!["0xdead0003".into()],
            id_numbers: vec!["UAE-ID-001".into()],
        }];
        self.upsert_list(SanctionsList::UaeCentralBank, entries).await;
        info!("loaded UAE Central Bank list");
    }

    /// Load United Nations Security Council consolidated list entries.
    pub async fn load_un_list(&self) {
        let entries = vec![SanctionsEntry {
            entity_name: "UN SANCTIONED ENTITY".into(),
            entity_type: EntityType::Individual,
            list_source: SanctionsList::UnitedNations,
            aliases: vec!["USE".into(), "U.N. SANCTIONED".into()],
            addresses: vec![],
            id_numbers: vec!["UN-REF-001".into()],
        }];
        self.upsert_list(SanctionsList::UnitedNations, entries).await;
        info!("loaded UN consolidated list");
    }

    /// Load European Union consolidated sanctions list entries.
    pub async fn load_eu_list(&self) {
        let entries = vec![SanctionsEntry {
            entity_name: "EU BLOCKED PERSON".into(),
            entity_type: EntityType::Individual,
            list_source: SanctionsList::EuropeanUnion,
            aliases: vec!["EBP".into()],
            addresses: vec!["0xdead0004".into()],
            id_numbers: vec![],
        }];
        self.upsert_list(SanctionsList::EuropeanUnion, entries).await;
        info!("loaded EU consolidated list");
    }

    /// Replace all entries for a given list atomically.
    pub async fn upsert_list(&self, list: SanctionsList, entries: Vec<SanctionsEntry>) {
        let mut lists = self.lists.write().await;
        lists.insert(list, entries);
        let mut timestamps = self.last_updated.write().await;
        timestamps.insert(list, Utc::now());
    }

    /// Total number of entries across all lists.
    pub async fn total_entries(&self) -> usize {
        let lists = self.lists.read().await;
        lists.values().map(|v| v.len()).sum()
    }

    /// Returns the last-update timestamp for each loaded list.
    pub async fn list_freshness(&self) -> HashMap<SanctionsList, DateTime<Utc>> {
        self.last_updated.read().await.clone()
    }

    // -----------------------------------------------------------------------
    // Entity screening
    // -----------------------------------------------------------------------

    /// Screen an entity (name, addresses, ID numbers) against all loaded lists.
    ///
    /// Returns a [`SanctionsCheckResult`] containing the best match score and
    /// details of any entries that exceeded the fuzzy-match threshold.
    pub async fn check_entity(
        &self,
        name: &str,
        addresses: &[String],
        id_numbers: &[String],
    ) -> Result<SanctionsCheckResult, ComplianceError> {
        let lists = self.lists.read().await;
        let mut matched_entries: Vec<SanctionsMatchDetail> = Vec::new();
        let mut best_score: f64 = 0.0;

        for entries in lists.values() {
            for entry in entries {
                // --- Name matching (fuzzy) ---
                let name_sim = self.best_name_similarity(name, entry);
                if name_sim >= FUZZY_MATCH_THRESHOLD {
                    best_score = best_score.max(name_sim);
                    matched_entries.push(SanctionsMatchDetail {
                        entry: entry.clone(),
                        matched_field: "name".into(),
                        query_value: name.to_string(),
                        similarity: name_sim,
                    });
                    continue; // no need to check address/id for this entry
                }

                // --- Address matching (exact, case-insensitive) ---
                if let Some(addr_match) = self.match_addresses(addresses, entry) {
                    best_score = best_score.max(1.0);
                    matched_entries.push(addr_match);
                    continue;
                }

                // --- ID number matching (exact) ---
                if let Some(id_match) = self.match_id_numbers(id_numbers, entry) {
                    best_score = best_score.max(1.0);
                    matched_entries.push(id_match);
                }
            }
        }

        if !matched_entries.is_empty() {
            warn!(
                entity = name,
                matches = matched_entries.len(),
                best_score,
                "sanctions match found"
            );
        }

        Ok(SanctionsCheckResult {
            is_match: !matched_entries.is_empty(),
            match_score: best_score,
            matched_entries,
        })
    }

    // -----------------------------------------------------------------------
    // Private helpers
    // -----------------------------------------------------------------------

    /// Compute the best fuzzy similarity between a query name and the entry's
    /// primary name + all aliases.
    fn best_name_similarity(&self, query: &str, entry: &SanctionsEntry) -> f64 {
        let query_lower = query.to_lowercase();
        let mut best = normalized_levenshtein(&query_lower, &entry.entity_name.to_lowercase());

        for alias in &entry.aliases {
            let sim = normalized_levenshtein(&query_lower, &alias.to_lowercase());
            if sim > best {
                best = sim;
            }
        }
        best
    }

    /// Check whether any of the provided addresses match the entry (case-insensitive).
    fn match_addresses(
        &self,
        query_addrs: &[String],
        entry: &SanctionsEntry,
    ) -> Option<SanctionsMatchDetail> {
        for qa in query_addrs {
            let qa_lower = qa.to_lowercase();
            for ea in &entry.addresses {
                if qa_lower == ea.to_lowercase() {
                    return Some(SanctionsMatchDetail {
                        entry: entry.clone(),
                        matched_field: "address".into(),
                        query_value: qa.clone(),
                        similarity: 1.0,
                    });
                }
            }
        }
        None
    }

    /// Check whether any of the provided ID numbers match the entry (exact).
    fn match_id_numbers(
        &self,
        query_ids: &[String],
        entry: &SanctionsEntry,
    ) -> Option<SanctionsMatchDetail> {
        for qi in query_ids {
            for ei in &entry.id_numbers {
                if qi == ei {
                    return Some(SanctionsMatchDetail {
                        entry: entry.clone(),
                        matched_field: "id_number".into(),
                        query_value: qi.clone(),
                        similarity: 1.0,
                    });
                }
            }
        }
        None
    }
}

// ---------------------------------------------------------------------------
// Levenshtein distance
// ---------------------------------------------------------------------------

/// Compute the Levenshtein edit distance between two strings.
fn levenshtein(a: &str, b: &str) -> usize {
    let a_len = a.chars().count();
    let b_len = b.chars().count();

    if a_len == 0 {
        return b_len;
    }
    if b_len == 0 {
        return a_len;
    }

    let mut prev_row: Vec<usize> = (0..=b_len).collect();
    let mut curr_row = vec![0; b_len + 1];

    for (i, ca) in a.chars().enumerate() {
        curr_row[0] = i + 1;
        for (j, cb) in b.chars().enumerate() {
            let cost = if ca == cb { 0 } else { 1 };
            curr_row[j + 1] = (prev_row[j + 1] + 1)
                .min(curr_row[j] + 1)
                .min(prev_row[j] + cost);
        }
        std::mem::swap(&mut prev_row, &mut curr_row);
    }

    prev_row[b_len]
}

/// Normalized Levenshtein similarity in the range `[0.0, 1.0]` where `1.0`
/// indicates an exact match.
fn normalized_levenshtein(a: &str, b: &str) -> f64 {
    let max_len = a.chars().count().max(b.chars().count());
    if max_len == 0 {
        return 1.0;
    }
    1.0 - (levenshtein(a, b) as f64 / max_len as f64)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn levenshtein_identical_strings() {
        assert_eq!(levenshtein("hello", "hello"), 0);
        assert_eq!(normalized_levenshtein("hello", "hello"), 1.0);
    }

    #[test]
    fn levenshtein_empty_strings() {
        assert_eq!(levenshtein("", ""), 0);
        assert_eq!(levenshtein("abc", ""), 3);
        assert_eq!(levenshtein("", "xyz"), 3);
    }

    #[test]
    fn levenshtein_known_distances() {
        assert_eq!(levenshtein("kitten", "sitting"), 3);
        assert_eq!(levenshtein("saturday", "sunday"), 3);
    }

    #[test]
    fn normalized_similarity_ranges() {
        let sim = normalized_levenshtein("test", "tset");
        assert!(sim > 0.0 && sim < 1.0);
    }

    #[tokio::test]
    async fn check_entity_exact_name_match() {
        let db = SanctionsDatabase::with_default_lists().await;
        let result = db
            .check_entity("BLOCKED PERSON ALPHA", &[], &[])
            .await
            .unwrap();
        assert!(result.is_match);
        assert_eq!(result.match_score, 1.0);
    }

    #[tokio::test]
    async fn check_entity_fuzzy_name_match() {
        let db = SanctionsDatabase::with_default_lists().await;
        // Minor variation should still match.
        let result = db
            .check_entity("BLOCKED PERSN ALPHA", &[], &[])
            .await
            .unwrap();
        assert!(result.is_match);
        assert!(result.match_score >= FUZZY_MATCH_THRESHOLD);
    }

    #[tokio::test]
    async fn check_entity_no_match() {
        let db = SanctionsDatabase::with_default_lists().await;
        let result = db
            .check_entity("TOTALLY CLEAN PERSON", &[], &[])
            .await
            .unwrap();
        assert!(!result.is_match);
    }

    #[tokio::test]
    async fn check_entity_address_match() {
        let db = SanctionsDatabase::with_default_lists().await;
        let result = db
            .check_entity("Unknown", &["0xdead0001".to_string()], &[])
            .await
            .unwrap();
        assert!(result.is_match);
        assert_eq!(result.matched_entries[0].matched_field, "address");
    }

    #[tokio::test]
    async fn check_entity_id_match() {
        let db = SanctionsDatabase::with_default_lists().await;
        let result = db
            .check_entity("Unknown", &[], &["PASS-001".to_string()])
            .await
            .unwrap();
        assert!(result.is_match);
        assert_eq!(result.matched_entries[0].matched_field, "id_number");
    }

    #[tokio::test]
    async fn total_entries_across_lists() {
        let db = SanctionsDatabase::with_default_lists().await;
        assert!(db.total_entries().await >= 4);
    }

    #[tokio::test]
    async fn list_freshness_populated() {
        let db = SanctionsDatabase::with_default_lists().await;
        let freshness = db.list_freshness().await;
        assert!(freshness.contains_key(&SanctionsList::Ofac));
        assert!(freshness.contains_key(&SanctionsList::UaeCentralBank));
        assert!(freshness.contains_key(&SanctionsList::UnitedNations));
        assert!(freshness.contains_key(&SanctionsList::EuropeanUnion));
    }

    // -----------------------------------------------------------------------
    // Empty database
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn empty_database_has_zero_entries() {
        let db = SanctionsDatabase::new();
        assert_eq!(db.total_entries().await, 0);
    }

    #[tokio::test]
    async fn empty_database_returns_no_match() {
        let db = SanctionsDatabase::new();
        let result = db.check_entity("anyone", &[], &[]).await.unwrap();
        assert!(!result.is_match);
        assert_eq!(result.match_score, 0.0);
        assert!(result.matched_entries.is_empty());
    }

    // -----------------------------------------------------------------------
    // Alias matching
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn check_entity_alias_match() {
        let db = SanctionsDatabase::with_default_lists().await;
        let result = db.check_entity("ALPHA PERSON", &[], &[]).await.unwrap();
        assert!(result.is_match, "Should match on alias 'ALPHA PERSON'");
    }

    // -----------------------------------------------------------------------
    // Case-insensitive matching
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn check_entity_case_insensitive() {
        let db = SanctionsDatabase::with_default_lists().await;
        let result = db
            .check_entity("blocked person alpha", &[], &[])
            .await
            .unwrap();
        assert!(result.is_match, "Should match case-insensitively");
    }

    // -----------------------------------------------------------------------
    // Address case-insensitive matching
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn check_entity_address_case_insensitive() {
        let db = SanctionsDatabase::with_default_lists().await;
        let result = db
            .check_entity("Unknown", &["0xDEAD0001".to_string()], &[])
            .await
            .unwrap();
        assert!(result.is_match, "Address matching should be case-insensitive");
    }

    // -----------------------------------------------------------------------
    // No match for unrelated strings
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn completely_different_name_no_match() {
        let db = SanctionsDatabase::with_default_lists().await;
        let result = db
            .check_entity("JOHN SMITH LEGITIMATE BUSINESS", &[], &[])
            .await
            .unwrap();
        assert!(!result.is_match);
    }

    // -----------------------------------------------------------------------
    // Upsert replaces list
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn upsert_replaces_existing_list() {
        let db = SanctionsDatabase::new();
        // Insert 2 entries
        db.upsert_list(SanctionsList::Ofac, vec![
            SanctionsEntry {
                entity_name: "ENTRY ONE".into(),
                entity_type: EntityType::Individual,
                list_source: SanctionsList::Ofac,
                aliases: vec![],
                addresses: vec![],
                id_numbers: vec![],
            },
            SanctionsEntry {
                entity_name: "ENTRY TWO".into(),
                entity_type: EntityType::Individual,
                list_source: SanctionsList::Ofac,
                aliases: vec![],
                addresses: vec![],
                id_numbers: vec![],
            },
        ]).await;
        assert_eq!(db.total_entries().await, 2);

        // Replace with 1 entry
        db.upsert_list(SanctionsList::Ofac, vec![
            SanctionsEntry {
                entity_name: "ENTRY THREE".into(),
                entity_type: EntityType::Organization,
                list_source: SanctionsList::Ofac,
                aliases: vec![],
                addresses: vec![],
                id_numbers: vec![],
            },
        ]).await;
        assert_eq!(db.total_entries().await, 1);

        // Old entries should not match
        let result = db.check_entity("ENTRY ONE", &[], &[]).await.unwrap();
        assert!(!result.is_match);

        // New entry should match
        let result = db.check_entity("ENTRY THREE", &[], &[]).await.unwrap();
        assert!(result.is_match);
    }

    // -----------------------------------------------------------------------
    // Levenshtein edge cases
    // -----------------------------------------------------------------------

    #[test]
    fn normalized_levenshtein_both_empty() {
        assert_eq!(normalized_levenshtein("", ""), 1.0);
    }

    #[test]
    fn normalized_levenshtein_one_empty() {
        assert_eq!(normalized_levenshtein("abc", ""), 0.0);
        assert_eq!(normalized_levenshtein("", "abc"), 0.0);
    }

    // -----------------------------------------------------------------------
    // Multiple lists match
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn check_entity_across_multiple_lists() {
        let db = SanctionsDatabase::with_default_lists().await;
        // BLOCKED PERSON ALPHA is on OFAC, check it matches
        let result = db.check_entity("BLOCKED PERSON ALPHA", &[], &[]).await.unwrap();
        assert!(result.is_match);
        // Verify it's from OFAC
        assert!(result.matched_entries.iter().any(|m| m.entry.list_source == SanctionsList::Ofac));
    }

    #[tokio::test]
    async fn check_entity_un_list() {
        let db = SanctionsDatabase::with_default_lists().await;
        let result = db.check_entity("UN SANCTIONED ENTITY", &[], &[]).await.unwrap();
        assert!(result.is_match);
    }

    #[tokio::test]
    async fn check_entity_eu_list() {
        let db = SanctionsDatabase::with_default_lists().await;
        let result = db.check_entity("EU BLOCKED PERSON", &[], &[]).await.unwrap();
        assert!(result.is_match);
    }

    #[tokio::test]
    async fn check_entity_uae_list() {
        let db = SanctionsDatabase::with_default_lists().await;
        let result = db.check_entity("UAE BLOCKED ENTITY", &[], &[]).await.unwrap();
        assert!(result.is_match);
    }

    // -----------------------------------------------------------------------
    // Cover lines 197, 199: warn log for matches (exercised via match path)
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn check_entity_match_produces_correct_match_count() {
        let db = SanctionsDatabase::with_default_lists().await;
        let result = db
            .check_entity("BLOCKED PERSON ALPHA", &[], &[])
            .await
            .unwrap();
        assert!(result.is_match);
        assert!(result.matched_entries.len() >= 1);
        assert!(result.match_score > 0.0);
    }

    #[tokio::test]
    async fn check_entity_multiple_match_fields() {
        let db = SanctionsDatabase::with_default_lists().await;
        // Match by both name and address
        let result = db
            .check_entity("BLOCKED PERSON ALPHA", &["0xdead0001".to_string()], &["PASS-001".to_string()])
            .await
            .unwrap();
        assert!(result.is_match);
        // Name match should be found; address/ID won't be checked since name matched first (continue)
        assert!(result.match_score >= 1.0);
    }
}
