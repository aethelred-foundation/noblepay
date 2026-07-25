// Shared display and data-protection helpers. Runtime identifiers and records
// must come from wallets, the chain, or the API; this module intentionally has
// no seeded/demo-data generators.

/**
 * Format a number with compact notation (K, M, B suffixes).
 * @param n - The number to format
 * @param decimals - Number of decimal places (defaults: B=2, M=1, K=1, else=0)
 */
export function formatNumber(n: number, decimals = 0): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000)
    return `${(n / 1_000_000).toFixed(decimals > 0 ? decimals : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(decimals > 0 ? decimals : 1)}K`;
  return n.toFixed(decimals).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * Format a number using locale-aware full formatting (e.g., 1,234,567).
 */
export function formatFullNumber(n: number): string {
  return n.toLocaleString("en-US");
}

/**
 * Truncate a long address/hash for display.
 * @param addr - The full address string
 * @param startLen - Characters to show at the start (default: 10)
 * @param endLen - Characters to show at the end (default: 6)
 */
export function truncateAddress(
  addr: string,
  startLen = 10,
  endLen = 6,
): string {
  if (addr.length <= startLen + endLen + 3) return addr;
  return `${addr.slice(0, startLen)}...${addr.slice(-endLen)}`;
}

/**
 * Copy text to clipboard with error suppression.
 */
export function copyToClipboard(text: string): Promise<void> {
  return navigator.clipboard.writeText(text).catch(() => {});
}

/**
 * Format a value with currency symbol and locale-appropriate separators.
 * Supports AED, USD, AETHEL, USDC, and USDT formatting.
 *
 * @param amount - The numeric amount to format
 * @param currency - Currency code (AED, USD, AETHEL, USDC, USDT; 'AET' accepted as a legacy alias)
 * @param decimals - Decimal places (default varies by currency)
 */
export function formatCurrency(
  amount: number,
  currency: string = "USD",
  decimals?: number,
): string {
  switch (currency.toUpperCase()) {
    case "AED":
      return `AED ${amount.toLocaleString("en-AE", {
        minimumFractionDigits: decimals ?? 2,
        maximumFractionDigits: decimals ?? 2,
      })}`;
    case "USD":
      return `$${amount.toLocaleString("en-US", {
        minimumFractionDigits: decimals ?? 2,
        maximumFractionDigits: decimals ?? 2,
      })}`;
    case "AET":
    case "AETHEL":
      return `${amount.toLocaleString("en-US", {
        minimumFractionDigits: decimals ?? 4,
        maximumFractionDigits: decimals ?? 4,
      })} AETHEL`;
    case "USDC":
      return `${amount.toLocaleString("en-US", {
        minimumFractionDigits: decimals ?? 2,
        maximumFractionDigits: decimals ?? 2,
      })} USDC`;
    case "USDT":
      return `${amount.toLocaleString("en-US", {
        minimumFractionDigits: decimals ?? 2,
        maximumFractionDigits: decimals ?? 2,
      })} USDT`;
    default:
      return `${amount.toLocaleString("en-US", {
        minimumFractionDigits: decimals ?? 2,
        maximumFractionDigits: decimals ?? 2,
      })} ${currency}`;
  }
}

/**
 * Format a duration in milliseconds to a human-readable string.
 * Examples: "1.2s", "45s", "2m 30s", "1h 15m", "2d 3h"
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;

  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m ${seconds % 60}s`;
}

/**
 * Map a risk score (0-100) to a color for visual indicators.
 * @param score - Risk score from 0 (low risk) to 100 (critical risk)
 * @returns Hex color string
 */
export function getRiskColor(score: number): string {
  if (score <= 25) return "#22c55e"; // emerald — low risk
  if (score <= 50) return "#f59e0b"; // amber — medium risk
  if (score <= 75) return "#f97316"; // orange — high risk
  return "#ef4444"; // red — critical risk
}

/**
 * Mask sensitive data for compliance display.
 * Shows first and last few characters with asterisks in between.
 *
 * @param data - The sensitive string to mask
 * @param visibleStart - Number of characters to show at start (default: 4)
 * @param visibleEnd - Number of characters to show at end (default: 4)
 * @param maskChar - Character to use for masking (default: '*')
 *
 * @example
 * maskSensitiveData('John Smith')        -> 'John**mith'
 * maskSensitiveData('AE123456789', 2, 3) -> 'AE******789'
 */
export function maskSensitiveData(
  data: string,
  visibleStart = 4,
  visibleEnd = 4,
  maskChar = "*",
): string {
  if (data.length <= visibleStart + visibleEnd) return data;
  const masked = maskChar.repeat(
    Math.min(data.length - visibleStart - visibleEnd, 6),
  );
  return `${data.slice(0, visibleStart)}${masked}${data.slice(-visibleEnd)}`;
}
