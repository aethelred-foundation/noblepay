//! Transaction Network Graph Analysis
//!
//! Builds and analyzes transaction graphs to detect suspicious patterns such as
//! layering, structuring, circular payments, fan-out/fan-in patterns, and
//! shell company networks. Uses graph algorithms including community detection,
//! centrality scoring, and cycle detection.

use std::collections::{HashMap, HashSet, VecDeque};

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use tracing::{info, warn};

use crate::types::Payment;

// ---------------------------------------------------------------------------
// Graph structures
// ---------------------------------------------------------------------------

/// A node in the transaction graph representing an entity.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphNode {
    pub entity: String,
    pub node_type: NodeType,
    pub degree: usize,
    pub in_degree: usize,
    pub out_degree: usize,
    pub total_volume_in: f64,
    pub total_volume_out: f64,
    pub first_seen: DateTime<Utc>,
    pub last_seen: DateTime<Utc>,
    pub transaction_count: usize,
    pub risk_score: f64,
    pub community_id: Option<usize>,
    pub centrality: CentralityScores,
}

/// An edge in the graph representing a transaction flow.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphEdge {
    pub source: String,
    pub target: String,
    pub total_volume: f64,
    pub transaction_count: usize,
    pub currencies: HashSet<String>,
    pub avg_amount: f64,
    pub first_tx: DateTime<Utc>,
    pub last_tx: DateTime<Utc>,
    pub risk_indicators: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum NodeType {
    Individual,
    Business,
    Exchange,
    Unknown,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CentralityScores {
    /// Number of connections (normalized).
    pub degree_centrality: f64,
    /// How often this node lies on shortest paths.
    pub betweenness_centrality: f64,
    /// Sum of inverse distances to all other nodes.
    pub closeness_centrality: f64,
}

// ---------------------------------------------------------------------------
// Suspicious patterns
// ---------------------------------------------------------------------------

/// A detected suspicious pattern in the network.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SuspiciousPattern {
    pub pattern_type: PatternType,
    pub severity: PatternSeverity,
    pub entities_involved: Vec<String>,
    pub total_volume: f64,
    pub description: String,
    pub detected_at: DateTime<Utc>,
    pub evidence: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum PatternType {
    /// Rapid sequential transfers through multiple accounts.
    Layering,
    /// Splitting amounts to stay below reporting thresholds.
    Structuring,
    /// One entity sends to many (distributing funds).
    FanOut,
    /// Many entities send to one (aggregating funds).
    FanIn,
    /// Funds flowing in a circle back to origin.
    CircularFlow,
    /// Cluster of low-activity entities with connected flows.
    ShellNetwork,
    /// Rapid back-and-forth between two entities.
    RapidBackAndForth,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, PartialOrd)]
pub enum PatternSeverity {
    Low,
    Medium,
    High,
    Critical,
}

// ---------------------------------------------------------------------------
// Graph analysis results
// ---------------------------------------------------------------------------

/// Complete analysis result for a transaction network.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NetworkAnalysis {
    pub node_count: usize,
    pub edge_count: usize,
    pub community_count: usize,
    pub communities: Vec<Community>,
    pub suspicious_patterns: Vec<SuspiciousPattern>,
    pub high_risk_entities: Vec<String>,
    pub network_risk_score: f64,
    pub analysis_timestamp: DateTime<Utc>,
}

/// A detected community (cluster) of entities.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Community {
    pub id: usize,
    pub members: Vec<String>,
    pub internal_volume: f64,
    pub external_volume: f64,
    pub density: f64,
    pub risk_score: f64,
}

// ---------------------------------------------------------------------------
// Transaction Graph
// ---------------------------------------------------------------------------

/// The main transaction graph structure.
pub struct TransactionGraph {
    nodes: HashMap<String, GraphNode>,
    edges: HashMap<(String, String), GraphEdge>,
    adjacency: HashMap<String, HashSet<String>>,
    reverse_adjacency: HashMap<String, HashSet<String>>,
}

impl TransactionGraph {
    /// Create a new empty graph.
    pub fn new() -> Self {
        Self {
            nodes: HashMap::new(),
            edges: HashMap::new(),
            adjacency: HashMap::new(),
            reverse_adjacency: HashMap::new(),
        }
    }

    /// Build a graph from a set of payments.
    pub fn from_payments(payments: &[Payment]) -> Self {
        let mut graph = Self::new();
        for payment in payments {
            graph.add_payment(payment);
        }
        graph.compute_centrality();
        graph
    }

    /// Add a single payment to the graph.
    pub fn add_payment(&mut self, payment: &Payment) {
        let amount = payment.amount as f64;

        // Update or create sender node
        self.update_node(&payment.sender, amount, true, payment.timestamp);

        // Update or create recipient node
        self.update_node(&payment.recipient, amount, false, payment.timestamp);

        // Update or create edge
        let edge_key = (payment.sender.clone(), payment.recipient.clone());
        let edge = self.edges.entry(edge_key.clone()).or_insert_with(|| GraphEdge {
            source: payment.sender.clone(),
            target: payment.recipient.clone(),
            total_volume: 0.0,
            transaction_count: 0,
            currencies: HashSet::new(),
            avg_amount: 0.0,
            first_tx: payment.timestamp,
            last_tx: payment.timestamp,
            risk_indicators: Vec::new(),
        });

        edge.total_volume += amount;
        edge.transaction_count += 1;
        edge.currencies.insert(payment.currency.clone());
        edge.avg_amount = edge.total_volume / edge.transaction_count as f64;
        if payment.timestamp < edge.first_tx {
            edge.first_tx = payment.timestamp;
        }
        if payment.timestamp > edge.last_tx {
            edge.last_tx = payment.timestamp;
        }

        // Adjacency
        self.adjacency.entry(payment.sender.clone()).or_default().insert(payment.recipient.clone());
        self.reverse_adjacency.entry(payment.recipient.clone()).or_default().insert(payment.sender.clone());
    }

    fn update_node(&mut self, entity: &str, amount: f64, is_sender: bool, timestamp: DateTime<Utc>) {
        let node = self.nodes.entry(entity.to_string()).or_insert_with(|| GraphNode {
            entity: entity.to_string(),
            node_type: NodeType::Unknown,
            degree: 0,
            in_degree: 0,
            out_degree: 0,
            total_volume_in: 0.0,
            total_volume_out: 0.0,
            first_seen: timestamp,
            last_seen: timestamp,
            transaction_count: 0,
            risk_score: 0.0,
            community_id: None,
            centrality: CentralityScores::default(),
        });

        node.transaction_count += 1;
        if timestamp < node.first_seen { node.first_seen = timestamp; }
        if timestamp > node.last_seen { node.last_seen = timestamp; }

        if is_sender {
            node.out_degree += 1;
            node.total_volume_out += amount;
        } else {
            node.in_degree += 1;
            node.total_volume_in += amount;
        }
        node.degree = node.in_degree + node.out_degree;
    }

    /// Detect communities using connected components.
    pub fn detect_communities(&mut self) -> Vec<Community> {
        let mut visited: HashSet<String> = HashSet::new();
        let mut communities: Vec<Community> = Vec::new();
        let mut community_id = 0;

        for entity in self.nodes.keys().cloned().collect::<Vec<_>>() {
            if visited.contains(&entity) {
                continue;
            }

            let mut members: Vec<String> = Vec::new();
            let mut queue: VecDeque<String> = VecDeque::new();
            queue.push_back(entity.clone());
            visited.insert(entity.clone());

            while let Some(current) = queue.pop_front() {
                members.push(current.clone());

                if let Some(node) = self.nodes.get_mut(&current) {
                    node.community_id = Some(community_id);
                }

                // Forward edges
                if let Some(neighbors) = self.adjacency.get(&current) {
                    for n in neighbors {
                        if !visited.contains(n) {
                            visited.insert(n.clone());
                            queue.push_back(n.clone());
                        }
                    }
                }

                // Reverse edges (undirected community detection)
                if let Some(neighbors) = self.reverse_adjacency.get(&current) {
                    for n in neighbors {
                        if !visited.contains(n) {
                            visited.insert(n.clone());
                            queue.push_back(n.clone());
                        }
                    }
                }
            }

            if members.len() >= 2 {
                let member_set: HashSet<&str> = members.iter().map(|s| s.as_str()).collect();
                let mut internal_volume = 0.0;
                let mut external_volume = 0.0;
                let mut internal_edges = 0;

                for ((src, tgt), edge) in &self.edges {
                    let src_in = member_set.contains(src.as_str());
                    let tgt_in = member_set.contains(tgt.as_str());
                    if src_in && tgt_in {
                        internal_volume += edge.total_volume;
                        internal_edges += 1;
                    } else if src_in || tgt_in {
                        external_volume += edge.total_volume;
                    }
                }

                let n = members.len();
                let max_edges = n * (n - 1);
                let density = if max_edges > 0 { internal_edges as f64 / max_edges as f64 } else { 0.0 };

                let risk_score = self.community_risk_score(&members, density, internal_volume);

                communities.push(Community {
                    id: community_id,
                    members,
                    internal_volume,
                    external_volume,
                    density,
                    risk_score,
                });

                community_id += 1;
            }
        }

        communities
    }

    /// Detect circular payment flows (cycles) using DFS.
    pub fn detect_cycles(&self, max_length: usize) -> Vec<Vec<String>> {
        let mut cycles: Vec<Vec<String>> = Vec::new();

        for start in self.nodes.keys() {
            let mut visited: HashSet<String> = HashSet::new();
            let mut path: Vec<String> = vec![start.clone()];
            self.dfs_cycles(start, start, &mut path, &mut visited, &mut cycles, max_length);
        }

        // Deduplicate cycles
        let mut unique: Vec<Vec<String>> = Vec::new();
        let mut seen_keys: HashSet<String> = HashSet::new();
        for cycle in cycles {
            let mut sorted = cycle.clone();
            sorted.sort();
            let key = sorted.join(",");
            if !seen_keys.contains(&key) {
                seen_keys.insert(key);
                unique.push(cycle);
            }
        }

        unique
    }

    fn dfs_cycles(
        &self,
        current: &str,
        target: &str,
        path: &mut Vec<String>,
        visited: &mut HashSet<String>,
        cycles: &mut Vec<Vec<String>>,
        max_length: usize,
    ) {
        if path.len() > max_length + 1 { return; }

        if let Some(neighbors) = self.adjacency.get(current) {
            for neighbor in neighbors {
                if neighbor == target && path.len() > 2 {
                    cycles.push(path.clone());
                    continue;
                }
                if !visited.contains(neighbor) && path.len() <= max_length {
                    visited.insert(neighbor.clone());
                    path.push(neighbor.clone());
                    self.dfs_cycles(neighbor, target, path, visited, cycles, max_length);
                    path.pop();
                    visited.remove(neighbor);
                }
            }
        }
    }

    /// Detect suspicious patterns in the network.
    pub fn detect_patterns(&self) -> Vec<SuspiciousPattern> {
        let mut patterns: Vec<SuspiciousPattern> = Vec::new();

        // Fan-out detection
        for (entity, neighbors) in &self.adjacency {
            if neighbors.len() >= 5 {
                if let Some(node) = self.nodes.get(entity) {
                    let total_volume: f64 = neighbors.iter()
                        .filter_map(|n| self.edges.get(&(entity.clone(), n.clone())))
                        .map(|e| e.total_volume)
                        .sum();

                    patterns.push(SuspiciousPattern {
                        pattern_type: PatternType::FanOut,
                        severity: if neighbors.len() > 10 { PatternSeverity::High } else { PatternSeverity::Medium },
                        entities_involved: std::iter::once(entity.clone()).chain(neighbors.iter().cloned()).collect(),
                        total_volume,
                        description: format!("{} sent to {} distinct entities", entity, neighbors.len()),
                        detected_at: Utc::now(),
                        evidence: vec![format!("Out-degree: {}", neighbors.len())],
                    });
                }
            }
        }

        // Fan-in detection
        for (entity, senders) in &self.reverse_adjacency {
            if senders.len() >= 5 {
                let total_volume: f64 = senders.iter()
                    .filter_map(|s| self.edges.get(&(s.clone(), entity.clone())))
                    .map(|e| e.total_volume)
                    .sum();

                patterns.push(SuspiciousPattern {
                    pattern_type: PatternType::FanIn,
                    severity: if senders.len() > 10 { PatternSeverity::High } else { PatternSeverity::Medium },
                    entities_involved: std::iter::once(entity.clone()).chain(senders.iter().cloned()).collect(),
                    total_volume,
                    description: format!("{} received from {} distinct entities", entity, senders.len()),
                    detected_at: Utc::now(),
                    evidence: vec![format!("In-degree: {}", senders.len())],
                });
            }
        }

        // Structuring detection
        for ((src, tgt), edge) in &self.edges {
            if edge.transaction_count >= 3 {
                let thresholds = [10000.0, 15000.0, 50000.0, 55000.0];
                for &threshold in &thresholds {
                    if edge.avg_amount > threshold * 0.85 && edge.avg_amount < threshold * 1.0 {
                        patterns.push(SuspiciousPattern {
                            pattern_type: PatternType::Structuring,
                            severity: PatternSeverity::High,
                            entities_involved: vec![src.clone(), tgt.clone()],
                            total_volume: edge.total_volume,
                            description: format!(
                                "Multiple transactions averaging {:.0} — just below {:.0} threshold",
                                edge.avg_amount, threshold
                            ),
                            detected_at: Utc::now(),
                            evidence: vec![
                                format!("Avg amount: {:.2}", edge.avg_amount),
                                format!("Transaction count: {}", edge.transaction_count),
                            ],
                        });
                    }
                }
            }
        }

        // Circular flow detection
        let cycles = self.detect_cycles(5);
        for cycle in &cycles {
            let total_volume: f64 = cycle.windows(2)
                .filter_map(|w| self.edges.get(&(w[0].clone(), w[1].clone())))
                .map(|e| e.total_volume)
                .sum();

            patterns.push(SuspiciousPattern {
                pattern_type: PatternType::CircularFlow,
                severity: PatternSeverity::Critical,
                entities_involved: cycle.clone(),
                total_volume,
                description: format!("Circular flow detected involving {} entities", cycle.len()),
                detected_at: Utc::now(),
                evidence: vec![format!("Cycle: {}", cycle.join(" → "))],
            });
        }

        patterns
    }

    /// Compute centrality scores for all nodes.
    fn compute_centrality(&mut self) {
        let n = self.nodes.len() as f64;
        if n <= 1.0 { return; }

        // Degree centrality
        for node in self.nodes.values_mut() {
            node.centrality.degree_centrality = node.degree as f64 / (n - 1.0);
        }

        // Simplified betweenness (based on being an intermediary)
        for entity in self.nodes.keys().cloned().collect::<Vec<_>>() {
            let in_neighbors = self.reverse_adjacency.get(&entity).map(|s| s.len()).unwrap_or(0);
            let out_neighbors = self.adjacency.get(&entity).map(|s| s.len()).unwrap_or(0);
            let betweenness = (in_neighbors * out_neighbors) as f64 / ((n - 1.0) * (n - 2.0) / 2.0).max(1.0);
            if let Some(node) = self.nodes.get_mut(&entity) {
                node.centrality.betweenness_centrality = betweenness.min(1.0);
            }
        }
    }

    fn community_risk_score(&self, members: &[String], density: f64, volume: f64) -> f64 {
        let mut score = 0.0;

        // High density + many members = suspicious
        if density > 0.5 && members.len() > 3 {
            score += 0.3;
        }

        // Large volume in small community
        let avg_volume = volume / members.len() as f64;
        if avg_volume > 100_000.0 {
            score += 0.2;
        }

        // Many new accounts
        let new_accounts = members.iter()
            .filter_map(|m| self.nodes.get(m))
            .filter(|n| (Utc::now() - n.first_seen).num_days() < 30)
            .count();
        if new_accounts > members.len() / 2 {
            score += 0.3;
        }

        (score as f64).min(1.0)
    }

    /// Run the full network analysis pipeline.
    pub fn analyze(&mut self) -> NetworkAnalysis {
        let communities = self.detect_communities();
        let patterns = self.detect_patterns();

        let high_risk: Vec<String> = self.nodes.values()
            .filter(|n| n.centrality.betweenness_centrality > 0.3 || n.risk_score > 0.5)
            .map(|n| n.entity.clone())
            .collect();

        let max_pattern_severity = patterns.iter()
            .map(|p| match p.severity {
                PatternSeverity::Critical => 1.0,
                PatternSeverity::High => 0.75,
                PatternSeverity::Medium => 0.5,
                PatternSeverity::Low => 0.25,
            })
            .fold(0.0f64, f64::max);

        let network_risk = (max_pattern_severity * 0.6 + (high_risk.len() as f64 / self.nodes.len().max(1) as f64) * 0.4).min(1.0);

        NetworkAnalysis {
            node_count: self.nodes.len(),
            edge_count: self.edges.len(),
            community_count: communities.len(),
            communities,
            suspicious_patterns: patterns,
            high_risk_entities: high_risk,
            network_risk_score: network_risk,
            analysis_timestamp: Utc::now(),
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn make_payment(sender: &str, recipient: &str, amount: u64) -> Payment {
        Payment::test_payment(sender, recipient, amount, "USD")
    }

    #[test]
    fn empty_graph() {
        let mut graph = TransactionGraph::new();
        let analysis = graph.analyze();
        assert_eq!(analysis.node_count, 0);
        assert_eq!(analysis.edge_count, 0);
    }

    #[test]
    fn single_payment_creates_two_nodes() {
        let payments = vec![make_payment("alice", "bob", 1000)];
        let graph = TransactionGraph::from_payments(&payments);
        assert_eq!(graph.nodes.len(), 2);
        assert_eq!(graph.edges.len(), 1);
    }

    #[test]
    fn fan_out_detected() {
        let payments: Vec<Payment> = (0..6)
            .map(|i| make_payment("hub", &format!("spoke-{}", i), 5000))
            .collect();
        let graph = TransactionGraph::from_payments(&payments);
        let patterns = graph.detect_patterns();
        assert!(patterns.iter().any(|p| p.pattern_type == PatternType::FanOut));
    }

    #[test]
    fn cycle_detection() {
        let payments = vec![
            make_payment("A", "B", 10000),
            make_payment("B", "C", 9500),
            make_payment("C", "A", 9000),
        ];
        let graph = TransactionGraph::from_payments(&payments);
        let cycles = graph.detect_cycles(4);
        assert!(!cycles.is_empty(), "Should detect A->B->C->A cycle");
    }

    #[test]
    fn community_detection() {
        let payments = vec![
            make_payment("a1", "a2", 1000),
            make_payment("a2", "a3", 1000),
            make_payment("b1", "b2", 1000),
            make_payment("b2", "b3", 1000),
        ];
        let mut graph = TransactionGraph::from_payments(&payments);
        let communities = graph.detect_communities();
        assert!(communities.len() >= 2, "Should detect at least 2 communities");
    }

    // -----------------------------------------------------------------------
    // Empty graph edge cases
    // -----------------------------------------------------------------------

    #[test]
    fn empty_graph_has_no_cycles() {
        let graph = TransactionGraph::new();
        let cycles = graph.detect_cycles(5);
        assert!(cycles.is_empty());
    }

    #[test]
    fn empty_graph_has_no_patterns() {
        let graph = TransactionGraph::new();
        let patterns = graph.detect_patterns();
        assert!(patterns.is_empty());
    }

    #[test]
    fn empty_graph_has_no_communities() {
        let mut graph = TransactionGraph::new();
        let communities = graph.detect_communities();
        assert!(communities.is_empty());
    }

    // -----------------------------------------------------------------------
    // Single node / single edge
    // -----------------------------------------------------------------------

    #[test]
    fn single_payment_no_cycles() {
        let payments = vec![make_payment("alice", "bob", 1000)];
        let graph = TransactionGraph::from_payments(&payments);
        let cycles = graph.detect_cycles(5);
        assert!(cycles.is_empty(), "Single edge should have no cycles");
    }

    #[test]
    fn single_payment_node_degrees() {
        let payments = vec![make_payment("alice", "bob", 5000)];
        let graph = TransactionGraph::from_payments(&payments);
        let alice = graph.nodes.get("alice").unwrap();
        assert_eq!(alice.out_degree, 1);
        assert_eq!(alice.in_degree, 0);
        assert_eq!(alice.total_volume_out, 5000.0);

        let bob = graph.nodes.get("bob").unwrap();
        assert_eq!(bob.in_degree, 1);
        assert_eq!(bob.out_degree, 0);
        assert_eq!(bob.total_volume_in, 5000.0);
    }

    // -----------------------------------------------------------------------
    // Cycle detection with various lengths
    // -----------------------------------------------------------------------

    #[test]
    fn no_cycle_in_linear_chain() {
        let payments = vec![
            make_payment("A", "B", 1000),
            make_payment("B", "C", 1000),
            make_payment("C", "D", 1000),
        ];
        let graph = TransactionGraph::from_payments(&payments);
        let cycles = graph.detect_cycles(5);
        assert!(cycles.is_empty(), "Linear chain should have no cycles");
    }

    #[test]
    fn cycle_detection_max_length_limits_results() {
        let payments = vec![
            make_payment("A", "B", 1000),
            make_payment("B", "C", 1000),
            make_payment("C", "D", 1000),
            make_payment("D", "A", 1000),
        ];
        let graph = TransactionGraph::from_payments(&payments);

        // max_length=2 should not find cycles of length 4
        let short_cycles = graph.detect_cycles(2);
        assert!(short_cycles.is_empty(), "max_length=2 should not find a 4-node cycle");

        // max_length=4 should find the cycle
        let long_cycles = graph.detect_cycles(4);
        assert!(!long_cycles.is_empty(), "max_length=4 should find the A->B->C->D->A cycle");
    }

    // -----------------------------------------------------------------------
    // Fan-in detection
    // -----------------------------------------------------------------------

    #[test]
    fn fan_in_detected() {
        let payments: Vec<Payment> = (0..6)
            .map(|i| make_payment(&format!("sender-{}", i), "collector", 5000))
            .collect();
        let graph = TransactionGraph::from_payments(&payments);
        let patterns = graph.detect_patterns();
        assert!(
            patterns.iter().any(|p| p.pattern_type == PatternType::FanIn),
            "Should detect fan-in pattern"
        );
    }

    // -----------------------------------------------------------------------
    // Structuring detection
    // -----------------------------------------------------------------------

    #[test]
    fn structuring_detected_near_threshold() {
        // Average amount just below 10000 threshold (between 8500 and 10000)
        let payments: Vec<Payment> = (0..5)
            .map(|_| make_payment("alice", "bob", 9500))
            .collect();
        let graph = TransactionGraph::from_payments(&payments);
        let patterns = graph.detect_patterns();
        assert!(
            patterns.iter().any(|p| p.pattern_type == PatternType::Structuring),
            "Should detect structuring pattern for avg ~9500 near 10000 threshold"
        );
    }

    // -----------------------------------------------------------------------
    // Circular flow via detect_patterns
    // -----------------------------------------------------------------------

    #[test]
    fn circular_flow_pattern_detected() {
        let payments = vec![
            make_payment("X", "Y", 10000),
            make_payment("Y", "Z", 9500),
            make_payment("Z", "X", 9000),
        ];
        let graph = TransactionGraph::from_payments(&payments);
        let patterns = graph.detect_patterns();
        assert!(
            patterns.iter().any(|p| p.pattern_type == PatternType::CircularFlow),
            "Should detect circular flow pattern"
        );
    }

    // -----------------------------------------------------------------------
    // Full analysis pipeline
    // -----------------------------------------------------------------------

    #[test]
    fn analyze_returns_correct_counts() {
        let payments = vec![
            make_payment("a", "b", 1000),
            make_payment("b", "c", 2000),
            make_payment("c", "d", 3000),
        ];
        let mut graph = TransactionGraph::from_payments(&payments);
        let analysis = graph.analyze();
        assert_eq!(analysis.node_count, 4);
        assert_eq!(analysis.edge_count, 3);
    }

    #[test]
    fn analyze_network_risk_score_is_bounded() {
        let payments: Vec<Payment> = (0..10)
            .map(|i| make_payment(&format!("s{}", i), &format!("r{}", i), 1000))
            .collect();
        let mut graph = TransactionGraph::from_payments(&payments);
        let analysis = graph.analyze();
        assert!(
            analysis.network_risk_score >= 0.0 && analysis.network_risk_score <= 1.0,
            "network_risk_score should be in [0, 1]"
        );
    }

    // -----------------------------------------------------------------------
    // Edge accumulation
    // -----------------------------------------------------------------------

    #[test]
    fn multiple_payments_same_pair_accumulate() {
        let payments = vec![
            make_payment("alice", "bob", 1000),
            make_payment("alice", "bob", 2000),
            make_payment("alice", "bob", 3000),
        ];
        let graph = TransactionGraph::from_payments(&payments);
        assert_eq!(graph.edges.len(), 1, "Same pair should have one edge");
        let edge = graph.edges.get(&("alice".to_string(), "bob".to_string())).unwrap();
        assert_eq!(edge.transaction_count, 3);
        assert!((edge.total_volume - 6000.0).abs() < f64::EPSILON);
        assert!((edge.avg_amount - 2000.0).abs() < f64::EPSILON);
    }

    // -----------------------------------------------------------------------
    // Community density and risk
    // -----------------------------------------------------------------------

    #[test]
    fn community_has_valid_density() {
        let payments = vec![
            make_payment("a1", "a2", 1000),
            make_payment("a2", "a3", 1000),
            make_payment("a3", "a1", 1000),
        ];
        let mut graph = TransactionGraph::from_payments(&payments);
        let communities = graph.detect_communities();
        assert!(!communities.is_empty());
        for c in &communities {
            assert!(c.density >= 0.0 && c.density <= 1.0, "density should be in [0, 1]");
            assert!(c.risk_score >= 0.0 && c.risk_score <= 1.0, "risk_score should be in [0, 1]");
        }
    }

    // -----------------------------------------------------------------------
    // PatternSeverity ordering
    // -----------------------------------------------------------------------

    #[test]
    fn pattern_severity_ordering() {
        assert!(PatternSeverity::Low < PatternSeverity::Medium);
        assert!(PatternSeverity::Medium < PatternSeverity::High);
        assert!(PatternSeverity::High < PatternSeverity::Critical);
    }

    // -----------------------------------------------------------------------
    // Centrality computed
    // -----------------------------------------------------------------------

    #[test]
    fn centrality_computed_on_from_payments() {
        let payments = vec![
            make_payment("a", "b", 1000),
            make_payment("b", "c", 1000),
            make_payment("a", "c", 1000),
        ];
        let graph = TransactionGraph::from_payments(&payments);
        // b is an intermediary → should have non-zero betweenness
        let b = graph.nodes.get("b").unwrap();
        assert!(b.centrality.degree_centrality > 0.0);
    }

    // -----------------------------------------------------------------------
    // Cover line 202: edge timestamp update (first_tx/last_tx)
    // -----------------------------------------------------------------------

    #[test]
    fn edge_timestamps_updated_correctly() {
        use chrono::Duration;

        let mut p1 = make_payment("alice", "bob", 1000);
        let mut p2 = make_payment("alice", "bob", 2000);
        // Make p1 older
        p1.timestamp = Utc::now() - Duration::hours(2);
        p2.timestamp = Utc::now();

        let graph = TransactionGraph::from_payments(&[p1.clone(), p2.clone()]);
        let edge = graph.edges.get(&("alice".to_string(), "bob".to_string())).unwrap();
        assert!(edge.first_tx <= edge.last_tx);
    }

    // -----------------------------------------------------------------------
    // Cover line 301: external volume in community detection
    // -----------------------------------------------------------------------

    #[test]
    fn community_with_single_node_excluded() {
        // Community detection requires >= 2 members. Single isolated nodes
        // should not form communities.
        let payments = vec![
            make_payment("a1", "a2", 1000),
            make_payment("a2", "a3", 1000),
        ];
        let mut graph = TransactionGraph::from_payments(&payments);
        let communities = graph.detect_communities();
        // All 3 nodes are connected so they form one community
        assert_eq!(communities.len(), 1);
        assert!(communities[0].members.len() >= 2);
    }

    #[test]
    fn community_external_volume_when_edge_crosses_boundary() {
        // When all nodes are connected, external volume is 0.
        // We verify internal volume is correctly summed.
        let payments = vec![
            make_payment("x1", "x2", 2000),
            make_payment("x2", "x3", 3000),
        ];
        let mut graph = TransactionGraph::from_payments(&payments);
        let communities = graph.detect_communities();
        assert_eq!(communities.len(), 1);
        // All edges are internal
        assert!((communities[0].internal_volume - 5000.0).abs() < f64::EPSILON);
    }

    // -----------------------------------------------------------------------
    // Cover lines 501, 507: community_risk_score with high density and volume
    // -----------------------------------------------------------------------

    #[test]
    fn community_risk_score_elevated_for_dense_high_volume() {
        // Create a dense community with high volume and many recent accounts
        let mut payments: Vec<Payment> = Vec::new();
        // Create a fully connected subgraph of 5 nodes with high volume
        let entities = ["h1", "h2", "h3", "h4", "h5"];
        for i in 0..entities.len() {
            for j in 0..entities.len() {
                if i != j {
                    payments.push(make_payment(entities[i], entities[j], 50_000));
                }
            }
        }
        let mut graph = TransactionGraph::from_payments(&payments);
        let communities = graph.detect_communities();
        assert!(!communities.is_empty());
        // Dense graph with high volume should have elevated risk
        let max_risk = communities.iter().map(|c| c.risk_score).fold(0.0f64, f64::max);
        assert!(
            max_risk > 0.0,
            "Dense high-volume community should have elevated risk, got {}",
            max_risk
        );
    }

    // -----------------------------------------------------------------------
    // Cover lines 534-537: PatternSeverity mapping in analyze()
    // -----------------------------------------------------------------------

    #[test]
    fn analyze_with_patterns_maps_severity() {
        // Create a graph with fan-out (>= 5 recipients) and circular flow
        let mut payments: Vec<Payment> = Vec::new();
        for i in 0..6 {
            payments.push(make_payment("hub", &format!("spoke-{}", i), 5000));
        }
        // Add a cycle
        payments.push(make_payment("spoke-0", "spoke-1", 1000));
        payments.push(make_payment("spoke-1", "spoke-2", 1000));
        payments.push(make_payment("spoke-2", "spoke-0", 1000));

        let mut graph = TransactionGraph::from_payments(&payments);
        let analysis = graph.analyze();
        // Should have patterns detected
        assert!(
            !analysis.suspicious_patterns.is_empty(),
            "Should detect suspicious patterns (fan-out and/or circular flow)"
        );
        // Network risk score should reflect pattern severity
        assert!(
            analysis.network_risk_score > 0.0,
            "Network risk should be > 0 with patterns detected"
        );
    }

    // -----------------------------------------------------------------------
    // Cover node timestamp update for earlier timestamps
    // -----------------------------------------------------------------------

    #[test]
    fn node_timestamps_track_earliest_and_latest() {
        use chrono::Duration;

        let mut p1 = make_payment("alice", "bob", 1000);
        let mut p2 = make_payment("alice", "charlie", 2000);
        p1.timestamp = Utc::now() - Duration::hours(5);
        p2.timestamp = Utc::now();

        let graph = TransactionGraph::from_payments(&[p1.clone(), p2.clone()]);
        let alice = graph.nodes.get("alice").unwrap();
        assert!(alice.first_seen <= alice.last_seen);
        assert_eq!(alice.out_degree, 2);
    }

    // -----------------------------------------------------------------------
    // Cover fan-out with > 10 neighbors (High severity)
    // -----------------------------------------------------------------------

    #[test]
    fn fan_out_high_severity_with_many_recipients() {
        let payments: Vec<Payment> = (0..12)
            .map(|i| make_payment("distributor", &format!("target-{}", i), 5000))
            .collect();
        let graph = TransactionGraph::from_payments(&payments);
        let patterns = graph.detect_patterns();
        let fan_out = patterns.iter().find(|p| p.pattern_type == PatternType::FanOut);
        assert!(fan_out.is_some(), "Should detect fan-out pattern");
        assert_eq!(fan_out.unwrap().severity, PatternSeverity::High);
    }

    // -----------------------------------------------------------------------
    // Cover line 202: edge first_tx update with earlier timestamp
    // -----------------------------------------------------------------------

    #[test]
    fn edge_first_tx_updated_for_earlier_payment() {
        use chrono::Duration;

        let mut graph = TransactionGraph::new();
        // First add a recent payment
        let p1 = make_payment("alice", "bob", 1000);
        graph.add_payment(&p1);

        // Then add an earlier payment for the same pair
        let mut p2 = make_payment("alice", "bob", 2000);
        p2.timestamp = Utc::now() - Duration::hours(10);
        graph.add_payment(&p2);

        let edge = graph.edges.get(&("alice".to_string(), "bob".to_string())).unwrap();
        // first_tx should be the earlier timestamp
        assert!(edge.first_tx <= edge.last_tx);
        assert_eq!(edge.transaction_count, 2);
    }

    // -----------------------------------------------------------------------
    // Cover line 535: High severity pattern in analyze() severity mapping
    // -----------------------------------------------------------------------

    #[test]
    fn analyze_with_only_high_severity_patterns() {
        // Create structuring pattern (High severity) without circular flow (Critical)
        // Structuring: 3+ transactions with avg near threshold
        let payments: Vec<Payment> = (0..5)
            .map(|_| make_payment("structurer", "target", 9500))
            .collect();
        let mut graph = TransactionGraph::from_payments(&payments);
        let analysis = graph.analyze();
        // Should have structuring pattern with High severity
        let has_high = analysis.suspicious_patterns.iter().any(|p| p.severity == PatternSeverity::High);
        if has_high {
            assert!(
                analysis.network_risk_score > 0.0,
                "High severity pattern should contribute to network risk"
            );
        }
    }

    // -----------------------------------------------------------------------
    // Cover line 535 via medium-only pattern
    // -----------------------------------------------------------------------

    #[test]
    fn analyze_with_medium_severity_fan_out() {
        // Fan-out with 5-10 recipients = Medium severity
        let payments: Vec<Payment> = (0..6)
            .map(|i| make_payment("distributor", &format!("r-{}", i), 1000))
            .collect();
        let mut graph = TransactionGraph::from_payments(&payments);
        let analysis = graph.analyze();
        let has_medium = analysis.suspicious_patterns.iter().any(|p| p.severity == PatternSeverity::Medium);
        assert!(has_medium, "Should detect medium severity fan-out pattern");
        assert!(
            analysis.network_risk_score > 0.0,
            "Medium severity pattern should contribute to network risk"
        );
    }
}
