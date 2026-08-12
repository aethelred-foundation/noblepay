/**
 * Formatting for on-chain fixed-point amounts.
 *
 * Chain values arrive as decimal strings because they are uint256 and routinely
 * exceed Number.MAX_SAFE_INTEGER — a wei balance passes 2^53 at nine AETHEL.
 * These helpers format straight from the string, so a value is never widened
 * into a float on its way to the screen.
 *
 * This deliberately does not use viem's formatUnits. Not because that function
 * is wrong, but because the natural call site is
 * `Number(formatUnits(value, decimals))`, which converts back to a float and
 * reintroduces exactly the precision loss the string representation exists to
 * avoid. Keeping the whole path in strings removes the temptation.
 */

/** Insert thousands separators into the integer part of a decimal string. */
export function groupDigits(value: string): string {
  const negative = value.startsWith("-");
  const body = negative ? value.slice(1) : value;
  const [whole, fraction] = body.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const out = fraction ? `${grouped}.${fraction}` : grouped;
  return negative ? `-${out}` : out;
}

/**
 * Render a base-unit integer string as a decimal string.
 *
 * @param raw       integer in base units, e.g. "5000000000000000000"
 * @param decimals  places the contract scales by, e.g. 18
 * @param maxFractionDigits  places to show; the rest are truncated, not
 *   rounded. Rounding a balance upward can display more than the account
 *   holds, which on a treasury screen is the wrong direction to be wrong in.
 */
export function formatBaseUnits(
  raw: string,
  decimals: number,
  maxFractionDigits = 6,
): string {
  if (!/^-?\d+$/.test(raw)) return raw;

  const negative = raw.startsWith("-");
  const digits = negative ? raw.slice(1) : raw;

  if (decimals <= 0) {
    return `${negative ? "-" : ""}${groupDigits(digits)}`;
  }

  const padded = digits.padStart(decimals + 1, "0");
  const whole = padded.slice(0, padded.length - decimals);
  const fractionFull = padded.slice(padded.length - decimals);

  const fraction = fractionFull.slice(0, maxFractionDigits).replace(/0+$/, "");
  const body = fraction ? `${whole}.${fraction}` : whole;

  // A non-zero amount that truncates to zero must not read as zero: dust is
  // not nothing, and on a balance sheet the difference matters.
  if (body.replace(/[0.]/g, "") === "" && digits.replace(/0/g, "") !== "") {
    const smallest = maxFractionDigits > 0
      ? `0.${"0".repeat(maxFractionDigits - 1)}1`
      : "1";
    return `${negative ? "-" : ""}<${smallest}`;
  }

  return `${negative ? "-" : ""}${groupDigits(body)}`;
}
