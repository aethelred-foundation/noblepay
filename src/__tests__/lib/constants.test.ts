import {
  BRAND,
  CHART_COLORS,
  PAYMENT_STATUS_STYLES,
  COMPLIANCE_STATUS_STYLES,
  RISK_LEVEL_STYLES,
  BUSINESS_TIERS,
  TIER_BY_ID,
  SUPPORTED_CURRENCIES,
  JURISDICTION_RISK_MAP,
  SANCTIONS_LISTS,
} from "@/lib/constants";

const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;

describe("constants BRAND", () => {
  it("names the app", () => {
    expect(String(BRAND.NAME ?? "")).toMatch(/noble/i);
  });
});

describe("constants CHART_COLORS", () => {
  it("is a non-empty palette of valid hex colors", () => {
    expect(CHART_COLORS.length).toBeGreaterThan(0);
    for (const c of CHART_COLORS) expect(c).toMatch(HEX_COLOR);
  });

  it("has no duplicate colors", () => {
    expect(new Set(CHART_COLORS).size).toBe(CHART_COLORS.length);
  });
});

describe.each([
  ["PAYMENT_STATUS_STYLES", PAYMENT_STATUS_STYLES],
  ["COMPLIANCE_STATUS_STYLES", COMPLIANCE_STATUS_STYLES],
  ["RISK_LEVEL_STYLES", RISK_LEVEL_STYLES],
])("constants %s", (_name, styleMap) => {
  it("maps every key to Tailwind bg/text classes", () => {
    for (const style of Object.values(styleMap) as Array<
      Record<string, string>
    >) {
      expect(style.bg).toMatch(/^bg-/);
      expect(style.text).toMatch(/^text-/);
    }
  });
});

describe("constants BUSINESS_TIERS", () => {
  it("exposes Standard, Premium, and Enterprise tiers", () => {
    expect(Object.keys(BUSINESS_TIERS)).toEqual([
      "STANDARD",
      "PREMIUM",
      "ENTERPRISE",
    ]);
  });

  it("assigns unique sequential ids 0..2", () => {
    const ids = Object.values(BUSINESS_TIERS).map((t) => t.id);
    expect(ids).toEqual([0, 1, 2]);
  });

  it("has strictly increasing daily and monthly limits by tier", () => {
    const tiers = [
      BUSINESS_TIERS.STANDARD,
      BUSINESS_TIERS.PREMIUM,
      BUSINESS_TIERS.ENTERPRISE,
    ];
    for (let i = 1; i < tiers.length; i++) {
      expect(tiers[i].dailyLimit).toBeGreaterThan(tiers[i - 1].dailyLimit);
      expect(tiers[i].monthlyLimit).toBeGreaterThan(tiers[i - 1].monthlyLimit);
    }
  });

  it("keeps each tier daily limit below its monthly limit", () => {
    for (const tier of Object.values(BUSINESS_TIERS)) {
      expect(tier.dailyLimit).toBeLessThan(tier.monthlyLimit);
    }
  });
});

describe("constants TIER_BY_ID", () => {
  it.each([0, 1, 2])("reverse-maps id %d to the matching tier", (id) => {
    expect(TIER_BY_ID[id].id).toBe(id);
  });

  it("covers every tier exactly once", () => {
    expect(Object.keys(TIER_BY_ID)).toHaveLength(
      Object.keys(BUSINESS_TIERS).length,
    );
  });
});

describe("constants SUPPORTED_CURRENCIES", () => {
  it.each(Object.keys(SUPPORTED_CURRENCIES))(
    "%s carries a complete definition",
    (key) => {
      const c = SUPPORTED_CURRENCIES[key];
      expect(c.symbol).toBe(key);
      expect(c.name.length).toBeGreaterThan(0);
      expect(c.decimals).toBeGreaterThanOrEqual(0);
      expect(c.currencyCode.length).toBeGreaterThan(0);
      expect(c.logoPath).toMatch(/^\/tokens\/.+\.svg$/);
    },
  );

  it("uses the AED locale for the dirham", () => {
    expect(SUPPORTED_CURRENCIES.AED.locale).toBe("en-AE");
  });

  it("models stablecoins with 6 decimals", () => {
    expect(SUPPORTED_CURRENCIES.USDC.decimals).toBe(6);
    expect(SUPPORTED_CURRENCIES.USDT.decimals).toBe(6);
  });
});

describe("constants JURISDICTION_RISK_MAP", () => {
  it.each(["AE", "US", "GB", "SG", "CH"])("classifies %s as Low risk", (cc) => {
    expect(JURISDICTION_RISK_MAP[cc]).toBe("Low");
  });

  it.each(["KP", "IR", "SY", "CU"])("classifies %s as Critical risk", (cc) => {
    expect(JURISDICTION_RISK_MAP[cc]).toBe("Critical");
  });

  it("uses only the four defined risk levels", () => {
    const allowed = new Set(["Low", "Medium", "High", "Critical"]);
    for (const level of Object.values(JURISDICTION_RISK_MAP)) {
      expect(allowed.has(level)).toBe(true);
    }
  });

  it("keys are ISO 3166-1 alpha-2 codes", () => {
    for (const code of Object.keys(JURISDICTION_RISK_MAP)) {
      expect(code).toMatch(/^[A-Z]{2}$/);
    }
  });

  it("includes at least one jurisdiction at each risk level", () => {
    const levels = new Set(Object.values(JURISDICTION_RISK_MAP));
    expect(levels).toEqual(new Set(["Low", "Medium", "High", "Critical"]));
  });
});

describe("constants SANCTIONS_LISTS", () => {
  it.each(Object.keys(SANCTIONS_LISTS))(
    "%s has id/name/jurisdiction/updateFrequency",
    (key) => {
      const list = SANCTIONS_LISTS[key as keyof typeof SANCTIONS_LISTS];
      expect(list.id).toBe(key);
      expect(list.name.length).toBeGreaterThan(0);
      expect(list.fullName.length).toBeGreaterThan(0);
      // Jurisdiction is a country code (US, AE) or a bloc/body (EU, International)
      expect(list.jurisdiction.length).toBeGreaterThan(0);
      expect(list.updateFrequency.length).toBeGreaterThan(0);
    },
  );

  it("includes the OFAC SDN list", () => {
    expect(SANCTIONS_LISTS.OFAC.jurisdiction).toBe("US");
  });
});
