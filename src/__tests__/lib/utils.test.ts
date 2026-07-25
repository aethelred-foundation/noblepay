import {
  formatNumber,
  formatFullNumber,
  truncateAddress,
  copyToClipboard,
  formatCurrency,
  formatDuration,
  getRiskColor,
  maskSensitiveData,
} from "@/lib/utils";

describe("formatNumber", () => {
  it("formats billions", () => {
    expect(formatNumber(2_500_000_000)).toBe("2.50B");
  });

  it("formats millions", () => {
    expect(formatNumber(1_500_000)).toBe("1.5M");
  });

  it("formats millions with custom decimals", () => {
    expect(formatNumber(1_500_000, 2)).toBe("1.50M");
  });

  it("formats thousands", () => {
    expect(formatNumber(5_000)).toBe("5.0K");
  });

  it("formats thousands with custom decimals", () => {
    expect(formatNumber(5_000, 2)).toBe("5.00K");
  });

  it("formats small numbers", () => {
    expect(formatNumber(42)).toBe("42");
  });

  it("formats small numbers with decimals", () => {
    expect(formatNumber(42, 2)).toBe("42.00");
  });
});

describe("formatFullNumber", () => {
  it("formats with locale separators", () => {
    const result = formatFullNumber(1234567);
    expect(result).toBe("1,234,567");
  });
});

describe("truncateAddress", () => {
  it("truncates a long address", () => {
    const addr = "0x1234567890abcdef1234567890abcdef12345678";
    expect(truncateAddress(addr)).toBe("0x12345678...345678");
  });

  it("returns short address unchanged", () => {
    expect(truncateAddress("0x1234")).toBe("0x1234");
  });

  it("respects custom start/end lengths", () => {
    const addr = "0x1234567890abcdef1234567890abcdef12345678";
    expect(truncateAddress(addr, 6, 4)).toBe("0x1234...5678");
  });
});

describe("copyToClipboard", () => {
  it("calls navigator.clipboard.writeText", async () => {
    const mockWriteText = jest.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText: mockWriteText } });
    await copyToClipboard("test");
    expect(mockWriteText).toHaveBeenCalledWith("test");
  });

  it("suppresses errors gracefully", async () => {
    const mockWriteText = jest.fn().mockRejectedValue(new Error("fail"));
    Object.assign(navigator, { clipboard: { writeText: mockWriteText } });
    // Should not throw
    await expect(copyToClipboard("test")).resolves.toBeUndefined();
  });
});

describe("formatCurrency", () => {
  it("formats AED", () => {
    const result = formatCurrency(1000, "AED");
    expect(result).toContain("AED");
    expect(result).toContain("1,000");
  });

  it("formats USD", () => {
    const result = formatCurrency(1000, "USD");
    expect(result).toBe("$1,000.00");
  });

  it("formats AET", () => {
    const result = formatCurrency(1.5, "AET");
    expect(result).toContain("AET");
    expect(result).toContain("1.5");
  });

  it("formats AETHEL same as AET", () => {
    const result = formatCurrency(1.5, "AETHEL");
    expect(result).toContain("AET");
  });

  it("formats USDC", () => {
    const result = formatCurrency(5000, "USDC");
    expect(result).toContain("USDC");
    expect(result).toContain("5,000");
  });

  it("formats USDT", () => {
    const result = formatCurrency(2500, "USDT");
    expect(result).toContain("USDT");
  });

  it("formats unknown currency", () => {
    const result = formatCurrency(100, "BTC");
    expect(result).toContain("BTC");
    expect(result).toContain("100");
  });

  it("uses default USD when no currency specified", () => {
    const result = formatCurrency(100);
    expect(result).toBe("$100.00");
  });

  it("respects custom decimals", () => {
    const result = formatCurrency(100.123, "USD", 3);
    expect(result).toBe("$100.123");
  });
});

describe("formatDuration", () => {
  it("formats milliseconds", () => {
    expect(formatDuration(500)).toBe("500ms");
  });

  it("formats seconds", () => {
    expect(formatDuration(1500)).toBe("1.5s");
  });

  it("formats minutes and seconds", () => {
    expect(formatDuration(150_000)).toBe("2m 30s");
  });

  it("formats hours and minutes", () => {
    expect(formatDuration(4_500_000)).toBe("1h 15m");
  });

  it("formats days and hours", () => {
    expect(formatDuration(183_600_000)).toBe("2d 3h");
  });
});

describe("getRiskColor", () => {
  it("returns emerald for low risk", () => {
    expect(getRiskColor(10)).toBe("#22c55e");
  });

  it("returns amber for medium risk", () => {
    expect(getRiskColor(35)).toBe("#f59e0b");
  });

  it("returns orange for high risk", () => {
    expect(getRiskColor(60)).toBe("#f97316");
  });

  it("returns red for critical risk", () => {
    expect(getRiskColor(90)).toBe("#ef4444");
  });

  it("returns emerald at boundary 25", () => {
    expect(getRiskColor(25)).toBe("#22c55e");
  });

  it("returns amber at boundary 50", () => {
    expect(getRiskColor(50)).toBe("#f59e0b");
  });

  it("returns orange at boundary 75", () => {
    expect(getRiskColor(75)).toBe("#f97316");
  });
});

describe("maskSensitiveData", () => {
  it("masks middle of a long string", () => {
    const result = maskSensitiveData("John Smith");
    expect(result).toBe("John**mith");
  });

  it("returns short strings unchanged", () => {
    expect(maskSensitiveData("Hi")).toBe("Hi");
  });

  it("respects custom visible start/end", () => {
    const result = maskSensitiveData("AE123456789", 2, 3);
    expect(result).toBe("AE******789");
  });

  it("respects custom mask character", () => {
    const result = maskSensitiveData("1234567890", 2, 2, "#");
    expect(result).toBe("12######90");
  });

  it("limits mask length to 6", () => {
    const result = maskSensitiveData("12345678901234567890", 2, 2);
    expect(result).toBe("12******90");
  });
});
