/**
 * Liquidity page — real-data page states.
 *
 * The global wagmi mock returns usePublicClient() === undefined, so the
 * chain hooks stay in their empty (not-loading) state; these tests pin the
 * page's structure and its honest empty states rather than fabricated data.
 */

import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";

jest.mock("@/contexts/AppContext", () => ({
  useApp: () => ({
    wallet: {
      connected: true,
      address: "0x1234567890abcdef1234567890abcdef12345678",
      isConnecting: false,
      isWrongNetwork: false,
      chainId: 7332,
    },
    connectWallet: jest.fn(),
    disconnectWallet: jest.fn(),
    addNotification: jest.fn(),
  }),
}));

jest.mock("@/components/SEOHead", () => ({
  SEOHead: ({ title }: { title: string }) => (
    <div data-testid="seo-head">{title}</div>
  ),
}));

jest.mock("@/components/SharedComponents", () => ({
  TopNav: () => <nav data-testid="top-nav">TopNav</nav>,
  Footer: () => <footer data-testid="footer">Footer</footer>,
}));

jest.mock("@/components/PagePrimitives", () => ({
  GlassCard: ({ children, className }: any) => (
    <div className={className}>{children}</div>
  ),
  CopyButton: () => <button>Copy</button>,
}));

import LiquidityPage from "../../pages/liquidity";

describe("LiquidityPage", () => {
  it("renders the header and live-data framing", () => {
    render(<LiquidityPage />);
    expect(screen.getByText("Liquidity Pools")).toBeInTheDocument();
    expect(
      screen.getByText(/Live pool reserves, utilization, and your on-chain LP positions/),
    ).toBeInTheDocument();
  });

  it("shows the pools and positions tabs with live counts", () => {
    render(<LiquidityPage />);
    expect(screen.getByText("Pools (0)")).toBeInTheDocument();
    expect(screen.getByText("My Positions (0)")).toBeInTheDocument();
  });

  it("shows the honest empty state when the contract has no pools", () => {
    render(<LiquidityPage />);
    expect(screen.getByText("No pools yet")).toBeInTheDocument();
    expect(
      screen.getByText(/Pools appear here as soon as the pool admin creates them on-chain/),
    ).toBeInTheDocument();
  });

  it("disables Add Liquidity while there are no pools to deposit into", () => {
    render(<LiquidityPage />);
    const btn = screen.getByText("Add Liquidity").closest("button")!;
    expect(btn).toBeDisabled();
  });

  it("shows the positions empty state for a connected wallet", () => {
    render(<LiquidityPage />);
    fireEvent.click(screen.getByText("My Positions (0)"));
    expect(screen.getByText("No active positions")).toBeInTheDocument();
    expect(screen.getByText(/Open one with Add Liquidity/)).toBeInTheDocument();
  });

  it("never renders fabricated pool metrics", () => {
    render(<LiquidityPage />);
    // Regression guard for the previous mock page: no invented volume/APY copy.
    expect(screen.queryByText(/24h Volume/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/APY/)).not.toBeInTheDocument();
  });
});
