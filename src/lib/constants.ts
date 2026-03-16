// ============================================================
// NoblePay Shared Constants
// Brand colors, chart palettes, status styles, compliance data
// ============================================================

/** Brand color palette */
export const BRAND = {
  NAME: 'NoblePay by Aethelred',
  red: '#DC2626',
  redDark: '#B91C1C',
  redLight: '#FEE2E2',
  redGlow: 'rgba(220, 38, 38, 0.15)',
  blue: '#0EA5E9',
  blueDark: '#0284C7',
  blueLight: '#E0F2FE',
  blueGlow: 'rgba(14, 165, 233, 0.15)',
} as const;

/** Chart color palette for multi-series visualizations */
export const CHART_COLORS = [
  '#DC2626', '#0EA5E9', '#10B981', '#F59E0B',
  '#8B5CF6', '#EC4899', '#06B6D4', '#F87171',
  '#34D399', '#FBBF24',
] as const;

// ============================================================
// Payment Status Styles
// ============================================================

/** Visual styles for each payment status */
export const PAYMENT_STATUS_STYLES = {
  Pending:   { bg: 'bg-amber-500/20', text: 'text-amber-400', border: 'border-amber-500/30', dot: 'bg-amber-400' },
  Screening: { bg: 'bg-blue-500/20', text: 'text-blue-400', border: 'border-blue-500/30', dot: 'bg-blue-400' },
  Passed:    { bg: 'bg-emerald-500/20', text: 'text-emerald-400', border: 'border-emerald-500/30', dot: 'bg-emerald-400' },
  Flagged:   { bg: 'bg-orange-500/20', text: 'text-orange-400', border: 'border-orange-500/30', dot: 'bg-orange-400' },
  Blocked:   { bg: 'bg-red-500/20', text: 'text-red-400', border: 'border-red-500/30', dot: 'bg-red-400' },
  Settled:   { bg: 'bg-emerald-500/20', text: 'text-emerald-400', border: 'border-emerald-500/30', dot: 'bg-emerald-400' },
  Refunded:  { bg: 'bg-slate-500/20', text: 'text-slate-400', border: 'border-slate-500/30', dot: 'bg-slate-400' },
} as const;

// ============================================================
// Compliance Status Styles
// ============================================================

/** Visual styles for compliance screening outcomes */
export const COMPLIANCE_STATUS_STYLES = {
  Clear:       { bg: 'bg-emerald-500/20', text: 'text-emerald-400', border: 'border-emerald-500/30', dot: 'bg-emerald-400' },
  Review:      { bg: 'bg-amber-500/20', text: 'text-amber-400', border: 'border-amber-500/30', dot: 'bg-amber-400' },
  Escalated:   { bg: 'bg-orange-500/20', text: 'text-orange-400', border: 'border-orange-500/30', dot: 'bg-orange-400' },
  Rejected:    { bg: 'bg-red-500/20', text: 'text-red-400', border: 'border-red-500/30', dot: 'bg-red-400' },
  Pending:     { bg: 'bg-slate-500/20', text: 'text-slate-400', border: 'border-slate-500/30', dot: 'bg-slate-400' },
  InProgress:  { bg: 'bg-blue-500/20', text: 'text-blue-400', border: 'border-blue-500/30', dot: 'bg-blue-400' },
} as const;

// ============================================================
// Risk Level Styles
// ============================================================

/** Visual styles for AML/sanctions risk levels */
export const RISK_LEVEL_STYLES = {
  Low:      { bg: 'bg-emerald-500/20', text: 'text-emerald-400', bar: 'bg-emerald-500', color: '#22c55e' },
  Medium:   { bg: 'bg-amber-500/20', text: 'text-amber-400', bar: 'bg-amber-500', color: '#f59e0b' },
  High:     { bg: 'bg-orange-500/20', text: 'text-orange-400', bar: 'bg-orange-500', color: '#f97316' },
  Critical: { bg: 'bg-red-500/20', text: 'text-red-400', bar: 'bg-red-500', color: '#ef4444' },
} as const;

// ============================================================
// Business Tiers
// ============================================================

/** Business tier definitions with daily and monthly payment limits (in USD) */
export const BUSINESS_TIERS = {
  STANDARD: {
    id: 0,
    label: 'Standard',
    dailyLimit: 50_000,
    monthlyLimit: 500_000,
    color: 'text-slate-400',
    bg: 'bg-slate-500/20',
    border: 'border-slate-500/30',
  },
  PREMIUM: {
    id: 1,
    label: 'Premium',
    dailyLimit: 250_000,
    monthlyLimit: 2_500_000,
    color: 'text-blue-400',
    bg: 'bg-blue-500/20',
    border: 'border-blue-500/30',
  },
  ENTERPRISE: {
    id: 2,
    label: 'Enterprise',
    dailyLimit: 2_000_000,
    monthlyLimit: 25_000_000,
    color: 'text-amber-400',
    bg: 'bg-amber-500/20',
    border: 'border-amber-500/30',
  },
} as const;

/** Reverse lookup: tier ID to tier metadata */
export const TIER_BY_ID: Record<number, (typeof BUSINESS_TIERS)[keyof typeof BUSINESS_TIERS]> = {
  0: BUSINESS_TIERS.STANDARD,
  1: BUSINESS_TIERS.PREMIUM,
  2: BUSINESS_TIERS.ENTERPRISE,
};

// ============================================================
// Supported Currencies
// ============================================================

export interface SupportedCurrency {
  symbol: string;
  name: string;
  decimals: number;
  /** Display format locale string (e.g. 'en-AE' for AED) */
  locale: string;
  /** ISO 4217 currency code or custom code */
  currencyCode: string;
  /** Path to token logo SVG */
  logoPath: string;
}

export const SUPPORTED_CURRENCIES: Record<string, SupportedCurrency> = {
  AET: {
    symbol: 'AET',
    name: 'Aethel Token',
    decimals: 18,
    locale: 'en-US',
    currencyCode: 'AET',
    logoPath: '/tokens/aet.svg',
  },
  USDC: {
    symbol: 'USDC',
    name: 'USD Coin',
    decimals: 6,
    locale: 'en-US',
    currencyCode: 'USD',
    logoPath: '/tokens/usdc.svg',
  },
  USDT: {
    symbol: 'USDT',
    name: 'Tether USD',
    decimals: 6,
    locale: 'en-US',
    currencyCode: 'USD',
    logoPath: '/tokens/usdt.svg',
  },
  AED: {
    symbol: 'AED',
    name: 'UAE Dirham',
    decimals: 2,
    locale: 'en-AE',
    currencyCode: 'AED',
    logoPath: '/tokens/aed.svg',
  },
} as const;

// ============================================================
// Jurisdiction Risk Map
// ============================================================

/**
 * Risk classification for common jurisdictions.
 * Used by the compliance engine for initial risk scoring.
 * ISO 3166-1 alpha-2 codes mapped to risk levels.
 */
export const JURISDICTION_RISK_MAP: Record<string, 'Low' | 'Medium' | 'High' | 'Critical'> = {
  // Low risk — well-regulated jurisdictions
  AE: 'Low',    // UAE
  US: 'Low',    // United States
  GB: 'Low',    // United Kingdom
  SG: 'Low',    // Singapore
  JP: 'Low',    // Japan
  CH: 'Low',    // Switzerland
  DE: 'Low',    // Germany
  FR: 'Low',    // France
  CA: 'Low',    // Canada
  AU: 'Low',    // Australia

  // Medium risk
  IN: 'Medium', // India
  BR: 'Medium', // Brazil
  TR: 'Medium', // Turkey
  ZA: 'Medium', // South Africa
  MX: 'Medium', // Mexico
  NG: 'Medium', // Nigeria
  TH: 'Medium', // Thailand
  PH: 'Medium', // Philippines
  EG: 'Medium', // Egypt

  // High risk — FATF grey list or elevated AML concerns
  PK: 'High',   // Pakistan
  MM: 'High',   // Myanmar
  VN: 'High',   // Vietnam
  BD: 'High',   // Bangladesh
  TZ: 'High',   // Tanzania
  JO: 'High',   // Jordan
  CM: 'High',   // Cameroon

  // Critical — FATF black list or sanctioned jurisdictions
  KP: 'Critical', // North Korea
  IR: 'Critical', // Iran
  SY: 'Critical', // Syria
  CU: 'Critical', // Cuba
  VE: 'Critical', // Venezuela (partial sanctions)
} as const;

// ============================================================
// Sanctions Lists
// ============================================================

/** Sanctions list identifiers used in compliance screening */
export const SANCTIONS_LISTS = {
  OFAC: {
    id: 'OFAC',
    name: 'OFAC SDN List',
    fullName: 'Office of Foreign Assets Control — Specially Designated Nationals',
    jurisdiction: 'US',
    updateFrequency: 'Daily',
  },
  UAE_CB: {
    id: 'UAE_CB',
    name: 'UAE Central Bank List',
    fullName: 'Central Bank of the UAE — Local Terrorist List',
    jurisdiction: 'AE',
    updateFrequency: 'Weekly',
  },
  UN: {
    id: 'UN',
    name: 'UN Consolidated List',
    fullName: 'United Nations Security Council Consolidated List',
    jurisdiction: 'International',
    updateFrequency: 'Weekly',
  },
  EU: {
    id: 'EU',
    name: 'EU Sanctions List',
    fullName: 'European Union Consolidated Financial Sanctions List',
    jurisdiction: 'EU',
    updateFrequency: 'Daily',
  },
} as const;

export type SanctionsListId = keyof typeof SANCTIONS_LISTS;
