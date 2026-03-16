import { renderHook, act } from '@testing-library/react';
import { useTreasury } from '@/hooks/useTreasury';

describe('useTreasury', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns loading state initially', () => {
    const { result } = renderHook(() => useTreasury());

    expect(result.current.isLoading).toBe(true);
    expect(result.current.overview).toBeNull();
    expect(result.current.proposals).toEqual([]);
    expect(result.current.policies).toEqual([]);
    expect(result.current.strategies).toEqual([]);
    expect(result.current.thresholds).toEqual([]);
  });

  it('loads mock data after timeout', () => {
    const { result } = renderHook(() => useTreasury());

    act(() => {
      jest.advanceTimersByTime(700);
    });

    expect(result.current.isLoading).toBe(false);
    expect(result.current.overview).not.toBeNull();
    expect(result.current.proposals.length).toBe(3);
    expect(result.current.policies.length).toBe(2);
    expect(result.current.strategies.length).toBe(3);
    expect(result.current.thresholds.length).toBe(4);
  });

  it('overview has correct structure', () => {
    const { result } = renderHook(() => useTreasury());

    act(() => {
      jest.advanceTimersByTime(700);
    });

    const overview = result.current.overview!;
    expect(overview.totalBalance).toBe(12_450_000);
    expect(overview.tokenBalances.length).toBe(3);
    expect(overview.activeProposals).toBe(3);
    expect(overview.monthlyYield).toBe(42_500);
    expect(overview.deployedInYield).toBe(5_000_000);
    expect(overview.monthlySpend).toBe(320_000);
    expect(overview.pendingApprovals).toBe(2);
  });

  it('overview token balances have correct structure', () => {
    const { result } = renderHook(() => useTreasury());

    act(() => {
      jest.advanceTimersByTime(700);
    });

    const tokenBalance = result.current.overview!.tokenBalances[0];
    expect(tokenBalance).toHaveProperty('symbol');
    expect(tokenBalance).toHaveProperty('amount');
    expect(tokenBalance).toHaveProperty('valueUsd');
  });

  it('proposals have correct structure', () => {
    const { result } = renderHook(() => useTreasury());

    act(() => {
      jest.advanceTimersByTime(700);
    });

    const proposal = result.current.proposals[0];
    expect(proposal).toHaveProperty('id');
    expect(proposal).toHaveProperty('title');
    expect(proposal).toHaveProperty('description');
    expect(proposal).toHaveProperty('proposer');
    expect(proposal).toHaveProperty('recipient');
    expect(proposal).toHaveProperty('amount');
    expect(proposal).toHaveProperty('tokenSymbol');
    expect(proposal).toHaveProperty('status');
    expect(proposal).toHaveProperty('votesFor');
    expect(proposal).toHaveProperty('votesAgainst');
    expect(proposal).toHaveProperty('quorum');
    expect(proposal).toHaveProperty('votingDeadline');
  });

  it('policies have correct structure', () => {
    const { result } = renderHook(() => useTreasury());

    act(() => {
      jest.advanceTimersByTime(700);
    });

    const policy = result.current.policies[0];
    expect(policy).toHaveProperty('id');
    expect(policy).toHaveProperty('name');
    expect(policy).toHaveProperty('description');
    expect(policy).toHaveProperty('maxSingleTx');
    expect(policy).toHaveProperty('dailyLimit');
    expect(policy).toHaveProperty('monthlyLimit');
    expect(policy).toHaveProperty('requiredApprovals');
    expect(policy).toHaveProperty('enforcement');
    expect(policy).toHaveProperty('active');
  });

  it('strategies have correct structure', () => {
    const { result } = renderHook(() => useTreasury());

    act(() => {
      jest.advanceTimersByTime(700);
    });

    const strategy = result.current.strategies[0];
    expect(strategy).toHaveProperty('id');
    expect(strategy).toHaveProperty('name');
    expect(strategy).toHaveProperty('description');
    expect(strategy).toHaveProperty('protocol');
    expect(strategy).toHaveProperty('allocated');
    expect(strategy).toHaveProperty('apy');
    expect(strategy).toHaveProperty('risk');
    expect(strategy).toHaveProperty('active');
    expect(strategy).toHaveProperty('earnedToDate');
  });

  it('thresholds have correct structure and tiers', () => {
    const { result } = renderHook(() => useTreasury());

    act(() => {
      jest.advanceTimersByTime(700);
    });

    const tiers = result.current.thresholds.map((t) => t.tier);
    expect(tiers).toEqual(['Low', 'Medium', 'High', 'Critical']);

    const lowThreshold = result.current.thresholds[0];
    expect(lowThreshold.minAmount).toBe(0);
    expect(lowThreshold.maxAmount).toBe(10_000);
    expect(lowThreshold.requiredSignatures).toBe(1);
    expect(lowThreshold.timelockDelay).toBe(0);

    const criticalThreshold = result.current.thresholds[3];
    expect(criticalThreshold.minAmount).toBe(1_000_000);
    expect(criticalThreshold.maxAmount).toBe(Infinity);
    expect(criticalThreshold.requiredSignatures).toBe(5);
  });

  it('voteOnProposal increments votesFor when supporting', () => {
    const { result } = renderHook(() => useTreasury());

    act(() => {
      jest.advanceTimersByTime(700);
    });

    const originalVotesFor = result.current.proposals[0].votesFor;
    const originalVotesAgainst = result.current.proposals[0].votesAgainst;

    act(() => {
      result.current.voteOnProposal('0xprop001', true);
    });

    const updated = result.current.proposals.find((p) => p.id === '0xprop001')!;
    expect(updated.votesFor).toBe(originalVotesFor + 100_000);
    expect(updated.votesAgainst).toBe(originalVotesAgainst);
  });

  it('voteOnProposal increments votesAgainst when opposing', () => {
    const { result } = renderHook(() => useTreasury());

    act(() => {
      jest.advanceTimersByTime(700);
    });

    const originalVotesFor = result.current.proposals[0].votesFor;
    const originalVotesAgainst = result.current.proposals[0].votesAgainst;

    act(() => {
      result.current.voteOnProposal('0xprop001', false);
    });

    const updated = result.current.proposals.find((p) => p.id === '0xprop001')!;
    expect(updated.votesFor).toBe(originalVotesFor);
    expect(updated.votesAgainst).toBe(originalVotesAgainst + 100_000);
  });

  it('voteOnProposal does not affect other proposals', () => {
    const { result } = renderHook(() => useTreasury());

    act(() => {
      jest.advanceTimersByTime(700);
    });

    const prop2Before = { ...result.current.proposals.find((p) => p.id === '0xprop002')! };

    act(() => {
      result.current.voteOnProposal('0xprop001', true);
    });

    const prop2After = result.current.proposals.find((p) => p.id === '0xprop002')!;
    expect(prop2After.votesFor).toBe(prop2Before.votesFor);
    expect(prop2After.votesAgainst).toBe(prop2Before.votesAgainst);
  });

  it('createProposal adds a new proposal in Draft status', () => {
    const { result } = renderHook(() => useTreasury());

    act(() => {
      jest.advanceTimersByTime(700);
    });

    const initialCount = result.current.proposals.length;

    act(() => {
      result.current.createProposal({
        title: 'Test Proposal',
        description: 'Test description',
        proposer: '0xproposer',
        recipient: '0xrecipient',
        amount: 100_000,
        tokenSymbol: 'USDC',
        quorum: 2_000_000,
        votingDeadline: Date.now() + 7 * 86_400_000,
      });
    });

    expect(result.current.proposals.length).toBe(initialCount + 1);
    const newProposal = result.current.proposals[0]; // prepended
    expect(newProposal.status).toBe('Draft');
    expect(newProposal.votesFor).toBe(0);
    expect(newProposal.votesAgainst).toBe(0);
    expect(newProposal.title).toBe('Test Proposal');
    expect(newProposal.amount).toBe(100_000);
    expect(newProposal.executedAt).toBe(0);
    expect(newProposal.id).toMatch(/^0xprop/);
  });

  it('cleans up timer on unmount', () => {
    const clearTimeoutSpy = jest.spyOn(global, 'clearTimeout');
    const { unmount } = renderHook(() => useTreasury());

    unmount();

    expect(clearTimeoutSpy).toHaveBeenCalled();
    clearTimeoutSpy.mockRestore();
  });
});
