import { formatBaseUnits, groupDigits } from "@/lib/fixed-point";

describe("groupDigits", () => {
  it("groups the integer part only", () => {
    expect(groupDigits("1234567.891")).toBe("1,234,567.891");
  });

  it("leaves short values alone", () => {
    expect(groupDigits("42")).toBe("42");
  });

  it("keeps the sign outside the grouping", () => {
    expect(groupDigits("-1234567")).toBe("-1,234,567");
  });
});

describe("formatBaseUnits", () => {
  it("scales an 18-decimal balance", () => {
    expect(formatBaseUnits("5000000000000000000", 18)).toBe("5");
  });

  it("keeps a fractional part and trims trailing zeros", () => {
    expect(formatBaseUnits("1500000000000000000", 18)).toBe("1.5");
  });

  it("handles values below one unit", () => {
    expect(formatBaseUnits("27230000", 8)).toBe("0.2723");
  });

  it("survives a value beyond Number.MAX_SAFE_INTEGER", () => {
    // The entire reason these stay strings. Through a float this loses its
    // low-order digits silently.
    const raw = "115792089237316195423570985008687907853269984665640564039457";
    expect(formatBaseUnits(raw, 0)).toBe(
      "115,792,089,237,316,195,423,570,985,008,687,907,853,269,984,665,640,564,039,457",
    );
  });

  it("does not render a non-zero dust amount as zero", () => {
    // 5e10 wei of an 18-decimal asset is 0.00000005 — real, but it truncates
    // away at six places. Showing "0" for a live balance is a lie about funds
    // that exist.
    expect(formatBaseUnits("50000000000", 18)).toBe("<0.000001");
  });

  it("renders an exact zero as zero", () => {
    expect(formatBaseUnits("0", 18)).toBe("0");
  });

  it("truncates rather than rounds", () => {
    // Rounding up would display more than the account holds. On a treasury
    // screen that is the wrong direction to be wrong in.
    expect(formatBaseUnits("1999999999999999999", 18, 2)).toBe("1.99");
  });

  it("groups large scaled values", () => {
    expect(formatBaseUnits("1234567000000000000000000", 18)).toBe("1,234,567");
  });

  it("passes through a non-numeric string unchanged", () => {
    expect(formatBaseUnits("not-a-number", 18)).toBe("not-a-number");
  });

  it("handles zero decimals", () => {
    expect(formatBaseUnits("4242", 0)).toBe("4,242");
  });
});
