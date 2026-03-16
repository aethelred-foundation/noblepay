import { renderHook, act } from '@testing-library/react';
import { useInvoices } from '@/hooks/useInvoices';

describe('useInvoices', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns loading state initially', () => {
    const { result } = renderHook(() => useInvoices());

    expect(result.current.isLoading).toBe(true);
    expect(result.current.invoices).toEqual([]);
    expect(result.current.financingRequests).toEqual([]);
    expect(result.current.creditScore).toBeNull();
    expect(result.current.analytics).toBeNull();
  });

  it('loads mock data after timeout', () => {
    const { result } = renderHook(() => useInvoices());

    act(() => {
      jest.advanceTimersByTime(600);
    });

    expect(result.current.isLoading).toBe(false);
    expect(result.current.invoices.length).toBe(4);
    expect(result.current.financingRequests.length).toBe(1);
    expect(result.current.creditScore).not.toBeNull();
    expect(result.current.analytics).not.toBeNull();
  });

  it('invoices have correct structure', () => {
    const { result } = renderHook(() => useInvoices());

    act(() => {
      jest.advanceTimersByTime(600);
    });

    const invoice = result.current.invoices[0];
    expect(invoice).toHaveProperty('id');
    expect(invoice).toHaveProperty('invoiceNumber');
    expect(invoice).toHaveProperty('issuer');
    expect(invoice).toHaveProperty('issuerName');
    expect(invoice).toHaveProperty('payer');
    expect(invoice).toHaveProperty('payerName');
    expect(invoice).toHaveProperty('amount');
    expect(invoice).toHaveProperty('currency');
    expect(invoice).toHaveProperty('status');
    expect(invoice).toHaveProperty('issuedAt');
    expect(invoice).toHaveProperty('dueAt');
    expect(invoice).toHaveProperty('description');
    expect(invoice).toHaveProperty('tokenized');
  });

  it('includes invoices of various statuses', () => {
    const { result } = renderHook(() => useInvoices());

    act(() => {
      jest.advanceTimersByTime(600);
    });

    const statuses = result.current.invoices.map((i) => i.status);
    expect(statuses).toContain('Issued');
    expect(statuses).toContain('Financed');
    expect(statuses).toContain('Overdue');
    expect(statuses).toContain('Paid');
  });

  it('financing requests have correct structure', () => {
    const { result } = renderHook(() => useInvoices());

    act(() => {
      jest.advanceTimersByTime(600);
    });

    const req = result.current.financingRequests[0];
    expect(req).toHaveProperty('id');
    expect(req).toHaveProperty('invoiceId');
    expect(req).toHaveProperty('invoiceNumber');
    expect(req).toHaveProperty('borrower');
    expect(req).toHaveProperty('requestedAmount');
    expect(req).toHaveProperty('approvedAmount');
    expect(req).toHaveProperty('advanceRate');
    expect(req).toHaveProperty('interestRate');
    expect(req).toHaveProperty('fee');
    expect(req).toHaveProperty('status');
    expect(req).toHaveProperty('creditScore');
  });

  it('credit score has correct structure', () => {
    const { result } = renderHook(() => useInvoices());

    act(() => {
      jest.advanceTimersByTime(600);
    });

    const cs = result.current.creditScore!;
    expect(cs.score).toBe(742);
    expect(cs.grade).toBe('AA');
    expect(cs.maxFinancingAmount).toBe(2_000_000);
    expect(cs.maxAdvanceRate).toBe(85);
    expect(cs.onTimePaymentRate).toBeCloseTo(95.8, 1);
    expect(cs.defaultCount).toBe(0);
  });

  it('analytics has correct structure with monthly data', () => {
    const { result } = renderHook(() => useInvoices());

    act(() => {
      jest.advanceTimersByTime(600);
    });

    const analytics = result.current.analytics!;
    expect(analytics.totalIssued).toBe(47);
    expect(analytics.totalOutstanding).toBe(505_000);
    expect(analytics.totalOverdue).toBe(75_000);
    expect(analytics.monthlyVolume.length).toBe(6);
    expect(analytics.monthlyVolume[0]).toHaveProperty('month');
    expect(analytics.monthlyVolume[0]).toHaveProperty('issued');
    expect(analytics.monthlyVolume[0]).toHaveProperty('paid');
    expect(analytics.monthlyVolume[0]).toHaveProperty('financed');
  });

  it('createInvoice adds a new invoice', () => {
    const { result } = renderHook(() => useInvoices());

    act(() => {
      jest.advanceTimersByTime(600);
    });

    const initialCount = result.current.invoices.length;

    act(() => {
      result.current.createInvoice({
        payerAddress: '0xpayer',
        payerName: 'Test Payer',
        amount: 50_000,
        currency: 'USDC',
        dueInDays: 30,
        description: 'Test invoice',
      });
    });

    expect(result.current.invoices.length).toBe(initialCount + 1);
    const newInvoice = result.current.invoices[0]; // prepended
    expect(newInvoice.status).toBe('Draft');
    expect(newInvoice.amount).toBe(50_000);
    expect(newInvoice.currency).toBe('USDC');
    expect(newInvoice.payerName).toBe('Test Payer');
    expect(newInvoice.description).toBe('Test invoice');
    expect(newInvoice.tokenized).toBe(false);
    expect(newInvoice.invoiceNumber).toMatch(/^NP-2026-/);
    expect(newInvoice.daysUntilDue).toBe(30);
  });

  it('requestFinancing adds a new financing request', () => {
    const { result } = renderHook(() => useInvoices());

    act(() => {
      jest.advanceTimersByTime(600);
    });

    const initialCount = result.current.financingRequests.length;

    act(() => {
      result.current.requestFinancing('inv-001', 200_000);
    });

    expect(result.current.financingRequests.length).toBe(initialCount + 1);
    const newReq = result.current.financingRequests[0]; // prepended
    expect(newReq.invoiceId).toBe('inv-001');
    expect(newReq.requestedAmount).toBe(200_000);
    expect(newReq.status).toBe('Pending');
    expect(newReq.creditScore).toBe(742);
    expect(newReq.advanceRate).toBe(85);
    expect(newReq.fee).toBeCloseTo(1000, 0);
  });

  it('requestFinancing does nothing for unknown invoice', () => {
    const { result } = renderHook(() => useInvoices());

    act(() => {
      jest.advanceTimersByTime(600);
    });

    const initialCount = result.current.financingRequests.length;

    act(() => {
      result.current.requestFinancing('inv-nonexistent', 100_000);
    });

    expect(result.current.financingRequests.length).toBe(initialCount);
  });

  it('tokenizeInvoice marks invoice as tokenized', () => {
    const { result } = renderHook(() => useInvoices());

    act(() => {
      jest.advanceTimersByTime(600);
    });

    // inv-003 is not tokenized
    expect(result.current.invoices.find((i) => i.id === 'inv-003')?.tokenized).toBe(false);

    act(() => {
      result.current.tokenizeInvoice('inv-003');
    });

    const updated = result.current.invoices.find((i) => i.id === 'inv-003');
    expect(updated?.tokenized).toBe(true);
    expect(updated?.tokenId).toBeDefined();
  });

  it('tokenizeInvoice does not affect other invoices', () => {
    const { result } = renderHook(() => useInvoices());

    act(() => {
      jest.advanceTimersByTime(600);
    });

    act(() => {
      result.current.tokenizeInvoice('inv-003');
    });

    // inv-001 should remain the same
    const inv1 = result.current.invoices.find((i) => i.id === 'inv-001');
    expect(inv1?.tokenized).toBe(true);
    expect(inv1?.tokenId).toBe('1001');
  });

  it('cleans up timer on unmount', () => {
    const clearTimeoutSpy = jest.spyOn(global, 'clearTimeout');
    const { unmount } = renderHook(() => useInvoices());

    unmount();

    expect(clearTimeoutSpy).toHaveBeenCalled();
    clearTimeoutSpy.mockRestore();
  });
});
