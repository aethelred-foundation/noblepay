import { renderHook, act, waitFor } from '@testing-library/react';
import { useAICompliance } from '@/hooks/useAICompliance';

describe('useAICompliance', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns loading state initially', () => {
    const { result } = renderHook(() => useAICompliance());

    expect(result.current.isLoading).toBe(true);
    expect(result.current.decisions).toEqual([]);
    expect(result.current.models).toEqual([]);
    expect(result.current.behavioralScores).toEqual([]);
    expect(result.current.networkAnalysis).toBeNull();
    expect(result.current.reports).toEqual([]);
  });

  it('loads mock data after timeout', async () => {
    const { result } = renderHook(() => useAICompliance());

    act(() => {
      jest.advanceTimersByTime(700);
    });

    expect(result.current.isLoading).toBe(false);
    expect(result.current.decisions.length).toBe(4);
    expect(result.current.models.length).toBe(4);
    expect(result.current.behavioralScores.length).toBe(2);
    expect(result.current.networkAnalysis).not.toBeNull();
    expect(result.current.reports.length).toBe(2);
  });

  it('returns decisions with correct structure', async () => {
    const { result } = renderHook(() => useAICompliance());

    act(() => {
      jest.advanceTimersByTime(700);
    });

    const decision = result.current.decisions[0];
    expect(decision).toHaveProperty('id');
    expect(decision).toHaveProperty('paymentId');
    expect(decision).toHaveProperty('modelId');
    expect(decision).toHaveProperty('modelVersion');
    expect(decision).toHaveProperty('outcome');
    expect(decision).toHaveProperty('confidence');
    expect(decision).toHaveProperty('confidenceLevel');
    expect(decision).toHaveProperty('riskScore');
    expect(decision).toHaveProperty('factors');
    expect(decision).toHaveProperty('latencyMs');
    expect(decision).toHaveProperty('decidedAt');
    expect(decision).toHaveProperty('appealed');
  });

  it('returns models with correct structure', async () => {
    const { result } = renderHook(() => useAICompliance());

    act(() => {
      jest.advanceTimersByTime(700);
    });

    const model = result.current.models[0];
    expect(model).toHaveProperty('id');
    expect(model).toHaveProperty('name');
    expect(model).toHaveProperty('version');
    expect(model).toHaveProperty('status');
    expect(model).toHaveProperty('accuracy');
    expect(model).toHaveProperty('falsePositiveRate');
    expect(model).toHaveProperty('falseNegativeRate');
    expect(model).toHaveProperty('totalDecisions');
    expect(model).toHaveProperty('avgLatencyMs');
  });

  it('returns network analysis with corridors', async () => {
    const { result } = renderHook(() => useAICompliance());

    act(() => {
      jest.advanceTimersByTime(700);
    });

    const analysis = result.current.networkAnalysis!;
    expect(analysis.totalCorridors).toBe(24);
    expect(analysis.highRiskCorridors).toBe(3);
    expect(analysis.networkRiskScore).toBe(28);
    expect(analysis.corridors.length).toBeGreaterThan(0);
    expect(analysis.corridors[0]).toHaveProperty('sourceJurisdiction');
    expect(analysis.corridors[0]).toHaveProperty('destJurisdiction');
    expect(analysis.corridors[0]).toHaveProperty('riskLevel');
  });

  it('appealDecision marks a decision as appealed', async () => {
    const { result } = renderHook(() => useAICompliance());

    act(() => {
      jest.advanceTimersByTime(700);
    });

    // dec-001 is not appealed initially
    expect(result.current.decisions.find((d) => d.id === 'dec-001')?.appealed).toBe(false);

    act(() => {
      result.current.appealDecision('dec-001');
    });

    const updated = result.current.decisions.find((d) => d.id === 'dec-001');
    expect(updated?.appealed).toBe(true);
    expect(updated?.appealOutcome).toBe('Pending');
  });

  it('appealDecision does not affect other decisions', async () => {
    const { result } = renderHook(() => useAICompliance());

    act(() => {
      jest.advanceTimersByTime(700);
    });

    act(() => {
      result.current.appealDecision('dec-001');
    });

    // dec-004 should remain unchanged
    const dec4 = result.current.decisions.find((d) => d.id === 'dec-004');
    expect(dec4?.appealed).toBe(false);
  });

  it('resolveAppeal updates the appeal outcome', async () => {
    const { result } = renderHook(() => useAICompliance());

    act(() => {
      jest.advanceTimersByTime(700);
    });

    // dec-002 has appealOutcome 'Pending'
    act(() => {
      result.current.resolveAppeal('dec-002', 'Overturned');
    });

    const updated = result.current.decisions.find((d) => d.id === 'dec-002');
    expect(updated?.appealOutcome).toBe('Overturned');
  });

  it('resolveAppeal with Upheld outcome', async () => {
    const { result } = renderHook(() => useAICompliance());

    act(() => {
      jest.advanceTimersByTime(700);
    });

    act(() => {
      result.current.resolveAppeal('dec-002', 'Upheld');
    });

    const updated = result.current.decisions.find((d) => d.id === 'dec-002');
    expect(updated?.appealOutcome).toBe('Upheld');
  });

  it('submitReport updates report status and adds filing reference', async () => {
    const { result } = renderHook(() => useAICompliance());

    act(() => {
      jest.advanceTimersByTime(700);
    });

    // rpt-002 is in Draft status
    expect(result.current.reports.find((r) => r.id === 'rpt-002')?.status).toBe('Draft');

    act(() => {
      result.current.submitReport('rpt-002');
    });

    const updated = result.current.reports.find((r) => r.id === 'rpt-002');
    expect(updated?.status).toBe('Submitted');
    expect(updated?.submittedAt).toBeGreaterThan(0);
    expect(updated?.filingReference).toBeDefined();
    expect(updated?.filingReference).toMatch(/^REF-/);
  });

  it('submitReport does not affect other reports', async () => {
    const { result } = renderHook(() => useAICompliance());

    act(() => {
      jest.advanceTimersByTime(700);
    });

    act(() => {
      result.current.submitReport('rpt-002');
    });

    const rpt1 = result.current.reports.find((r) => r.id === 'rpt-001');
    expect(rpt1?.status).toBe('Submitted');
    expect(rpt1?.filingReference).toBe('UAECB-2026-Q1-0042');
  });

  it('getBehavioralScore finds a score by address', async () => {
    const { result } = renderHook(() => useAICompliance());

    act(() => {
      jest.advanceTimersByTime(700);
    });

    const score = result.current.getBehavioralScore(
      '0x1234567890abcdef1234567890abcdef12345678',
    );
    expect(score).toBeDefined();
    expect(score?.score).toBe(87);
    expect(score?.trend).toBe('Improving');
  });

  it('getBehavioralScore returns undefined for unknown address', async () => {
    const { result } = renderHook(() => useAICompliance());

    act(() => {
      jest.advanceTimersByTime(700);
    });

    const score = result.current.getBehavioralScore('0xunknown');
    expect(score).toBeUndefined();
  });

  it('returns callback functions that are stable references', () => {
    const { result, rerender } = renderHook(() => useAICompliance());

    const firstAppeal = result.current.appealDecision;
    const firstResolve = result.current.resolveAppeal;
    const firstSubmit = result.current.submitReport;

    rerender();

    expect(result.current.appealDecision).toBe(firstAppeal);
    expect(result.current.resolveAppeal).toBe(firstResolve);
    expect(result.current.submitReport).toBe(firstSubmit);
  });

  it('cleans up timer on unmount', () => {
    const clearTimeoutSpy = jest.spyOn(global, 'clearTimeout');
    const { unmount } = renderHook(() => useAICompliance());

    unmount();

    expect(clearTimeoutSpy).toHaveBeenCalled();
    clearTimeoutSpy.mockRestore();
  });
});
