/**
 * AI Compliance Hooks — Custom React hooks for NoblePay AI-driven compliance.
 *
 * Provides typed hooks for AI decision monitoring, model performance,
 * behavioral scoring, corridor risk, and appeal management.
 */

import { useState, useEffect, useCallback } from 'react';
import type {
  AIDecision,
  AIModel,
  BehavioralScore,
  CorridorRisk,
  NetworkAnalysis,
  RegulatoryReport,
} from '@/types/compliance';

// ---------------------------------------------------------------------------
// Mock Data
// ---------------------------------------------------------------------------

const MOCK_DECISIONS: AIDecision[] = [
  {
    id: 'dec-001',
    paymentId: '0xpay001',
    modelId: 'aml-v3',
    modelVersion: '3.2.1',
    outcome: 'Approve',
    confidence: 97,
    confidenceLevel: 'High',
    riskScore: 8,
    factors: ['Low jurisdiction risk', 'Known counterparty', 'Normal transaction pattern'],
    latencyMs: 42,
    decidedAt: Date.now() - 300_000,
    appealed: false,
  },
  {
    id: 'dec-002',
    paymentId: '0xpay002',
    modelId: 'aml-v3',
    modelVersion: '3.2.1',
    outcome: 'Flag',
    confidence: 72,
    confidenceLevel: 'Medium',
    riskScore: 65,
    factors: ['High-risk corridor', 'Unusual amount', 'New counterparty'],
    latencyMs: 38,
    decidedAt: Date.now() - 600_000,
    appealed: true,
    appealOutcome: 'Pending',
  },
  {
    id: 'dec-003',
    paymentId: '0xpay003',
    modelId: 'sanctions-v2',
    modelVersion: '2.1.0',
    outcome: 'Block',
    confidence: 95,
    confidenceLevel: 'High',
    riskScore: 92,
    factors: ['Sanctions list proximity', 'Blocked jurisdiction', 'Pattern anomaly'],
    latencyMs: 55,
    decidedAt: Date.now() - 1_800_000,
    appealed: true,
    appealOutcome: 'Upheld',
  },
  {
    id: 'dec-004',
    paymentId: '0xpay004',
    modelId: 'behavioral-v1',
    modelVersion: '1.4.2',
    outcome: 'Review',
    confidence: 58,
    confidenceLevel: 'Low',
    riskScore: 45,
    factors: ['Unusual time-of-day', 'Amount deviation from pattern', 'New geography'],
    latencyMs: 31,
    decidedAt: Date.now() - 120_000,
    appealed: false,
  },
];

const MOCK_MODELS: AIModel[] = [
  {
    id: 'aml-v3',
    name: 'AML Detection Engine',
    version: '3.2.1',
    status: 'Active',
    accuracy: 97.2,
    falsePositiveRate: 2.1,
    falseNegativeRate: 0.3,
    totalDecisions: 142_500,
    avgLatencyMs: 40,
    lastTrained: Date.now() - 7 * 86_400_000,
    deployedAt: Date.now() - 14 * 86_400_000,
  },
  {
    id: 'sanctions-v2',
    name: 'Sanctions Screening Model',
    version: '2.1.0',
    status: 'Active',
    accuracy: 99.1,
    falsePositiveRate: 0.8,
    falseNegativeRate: 0.05,
    totalDecisions: 142_500,
    avgLatencyMs: 52,
    lastTrained: Date.now() - 3 * 86_400_000,
    deployedAt: Date.now() - 10 * 86_400_000,
  },
  {
    id: 'behavioral-v1',
    name: 'Behavioral Analysis Engine',
    version: '1.4.2',
    status: 'Active',
    accuracy: 91.5,
    falsePositiveRate: 5.2,
    falseNegativeRate: 1.1,
    totalDecisions: 89_300,
    avgLatencyMs: 33,
    lastTrained: Date.now() - 2 * 86_400_000,
    deployedAt: Date.now() - 5 * 86_400_000,
  },
  {
    id: 'aml-v4',
    name: 'AML Detection Engine v4',
    version: '4.0.0-beta',
    status: 'Shadow',
    accuracy: 98.1,
    falsePositiveRate: 1.4,
    falseNegativeRate: 0.2,
    totalDecisions: 42_100,
    avgLatencyMs: 35,
    lastTrained: Date.now() - 1 * 86_400_000,
    deployedAt: Date.now() - 3 * 86_400_000,
  },
];

const MOCK_BEHAVIORAL_SCORES: BehavioralScore[] = [
  {
    address: '0x1234567890abcdef1234567890abcdef12345678',
    score: 87,
    trend: 'Improving',
    patternScore: 92,
    counterpartyScore: 85,
    volumeScore: 88,
    geographicScore: 78,
    temporalScore: 90,
    dataPoints: 1_245,
    updatedAt: Date.now() - 3_600_000,
  },
  {
    address: '0xabcdef1234567890abcdef1234567890abcdef12',
    score: 45,
    trend: 'Declining',
    patternScore: 38,
    counterpartyScore: 52,
    volumeScore: 42,
    geographicScore: 35,
    temporalScore: 60,
    dataPoints: 312,
    updatedAt: Date.now() - 7_200_000,
  },
];

const MOCK_NETWORK_ANALYSIS: NetworkAnalysis = {
  totalCorridors: 24,
  highRiskCorridors: 3,
  networkRiskScore: 28,
  totalFlagged30d: 47,
  corridors: [
    { sourceJurisdiction: 'AE', destJurisdiction: 'PK', riskLevel: 'High', riskScore: 72, volume30d: 1_200_000, flaggedCount30d: 12, flagRate: 8.3, activeAlerts: 2, assessedAt: Date.now() - 3_600_000 },
    { sourceJurisdiction: 'AE', destJurisdiction: 'US', riskLevel: 'Low', riskScore: 12, volume30d: 8_500_000, flaggedCount30d: 3, flagRate: 0.4, activeAlerts: 0, assessedAt: Date.now() - 3_600_000 },
    { sourceJurisdiction: 'AE', destJurisdiction: 'GB', riskLevel: 'Low', riskScore: 15, volume30d: 5_200_000, flaggedCount30d: 2, flagRate: 0.5, activeAlerts: 0, assessedAt: Date.now() - 3_600_000 },
    { sourceJurisdiction: 'AE', destJurisdiction: 'IN', riskLevel: 'Medium', riskScore: 42, volume30d: 3_100_000, flaggedCount30d: 8, flagRate: 3.2, activeAlerts: 1, assessedAt: Date.now() - 3_600_000 },
    { sourceJurisdiction: 'SG', destJurisdiction: 'AE', riskLevel: 'Low', riskScore: 18, volume30d: 2_800_000, flaggedCount30d: 1, flagRate: 0.3, activeAlerts: 0, assessedAt: Date.now() - 3_600_000 },
    { sourceJurisdiction: 'US', destJurisdiction: 'IR', riskLevel: 'Critical', riskScore: 95, volume30d: 0, flaggedCount30d: 0, flagRate: 0, activeAlerts: 5, assessedAt: Date.now() - 3_600_000 },
  ],
  analyzedAt: Date.now() - 3_600_000,
};

const MOCK_REPORTS: RegulatoryReport[] = [
  {
    id: 'rpt-001',
    type: 'AML_QUARTERLY',
    regulator: 'UAE Central Bank',
    jurisdiction: 'AE',
    status: 'Submitted',
    periodStart: Date.now() - 90 * 86_400_000,
    periodEnd: Date.now(),
    transactionCount: 14_250,
    totalVolume: 85_000_000,
    suspiciousActivityCount: 12,
    generatedAt: Date.now() - 2 * 86_400_000,
    submittedAt: Date.now() - 1 * 86_400_000,
    filingReference: 'UAECB-2026-Q1-0042',
  },
  {
    id: 'rpt-002',
    type: 'SAR',
    regulator: 'FinCEN',
    jurisdiction: 'US',
    status: 'Draft',
    periodStart: Date.now() - 30 * 86_400_000,
    periodEnd: Date.now(),
    transactionCount: 1,
    totalVolume: 250_000,
    suspiciousActivityCount: 1,
    generatedAt: Date.now() - 3_600_000,
    submittedAt: 0,
  },
];

// ---------------------------------------------------------------------------
// useAICompliance — decisions, models, behavioral scores, network analysis
// ---------------------------------------------------------------------------

export function useAICompliance() {
  const [decisions, setDecisions] = useState<AIDecision[]>([]);
  const [models, setModels] = useState<AIModel[]>([]);
  const [behavioralScores, setBehavioralScores] = useState<BehavioralScore[]>([]);
  const [networkAnalysis, setNetworkAnalysis] = useState<NetworkAnalysis | null>(null);
  const [reports, setReports] = useState<RegulatoryReport[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDecisions(MOCK_DECISIONS);
      setModels(MOCK_MODELS);
      setBehavioralScores(MOCK_BEHAVIORAL_SCORES);
      setNetworkAnalysis(MOCK_NETWORK_ANALYSIS);
      setReports(MOCK_REPORTS);
      setIsLoading(false);
    }, 600);
    return () => clearTimeout(timer);
  }, []);

  const appealDecision = useCallback((decisionId: string) => {
    setDecisions((prev) =>
      prev.map((d) =>
        d.id === decisionId
          ? { ...d, appealed: true, appealOutcome: 'Pending' as const }
          : d,
      ),
    );
  }, []);

  const resolveAppeal = useCallback(
    (decisionId: string, outcome: 'Upheld' | 'Overturned') => {
      setDecisions((prev) =>
        prev.map((d) =>
          d.id === decisionId ? { ...d, appealOutcome: outcome } : d,
        ),
      );
    },
    [],
  );

  const submitReport = useCallback((reportId: string) => {
    setReports((prev) =>
      prev.map((r) =>
        r.id === reportId
          ? {
              ...r,
              status: 'Submitted' as const,
              submittedAt: Date.now(),
              filingReference: `REF-${String(Date.now()).slice(-8)}`,
            }
          : r,
      ),
    );
  }, []);

  const getBehavioralScore = useCallback(
    (address: string): BehavioralScore | undefined => {
      return behavioralScores.find((s) => s.address === address);
    },
    [behavioralScores],
  );

  return {
    decisions,
    models,
    behavioralScores,
    networkAnalysis,
    reports,
    isLoading,
    appealDecision,
    resolveAppeal,
    submitReport,
    getBehavioralScore,
  };
}
