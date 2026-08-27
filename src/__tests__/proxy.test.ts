jest.mock("next/server", () => {
  class MockHeaders {
    private readonly values = new Map<string, string>();

    constructor(headers: Record<string, string> = {}) {
      for (const [name, value] of Object.entries(headers)) {
        this.values.set(name.toLowerCase(), value);
      }
    }

    get(name: string): string | null {
      return this.values.get(name.toLowerCase()) ?? null;
    }
  }

  class MockNextResponse {
    readonly status: number;
    readonly headers: MockHeaders;

    constructor(
      _body: unknown,
      init: { status?: number; headers?: Record<string, string> } = {},
    ) {
      this.status = init.status ?? 200;
      this.headers = new MockHeaders(init.headers);
    }

    static next() {
      return new MockNextResponse(null, {
        headers: { "x-middleware-next": "1" },
      });
    }
  }

  return { NextResponse: MockNextResponse };
});

import {
  config,
  isRoadmapPreviewEnvironment,
  proxy,
  roadmapPageResponse,
} from "../proxy";

const ROADMAP_MATCHERS = [
  "/treasury/:path*",
  "/liquidity/:path*",
  "/streaming/:path*",
  "/ai-compliance/:path*",
  "/invoice-financing/:path*",
  "/fx-hedging/:path*",
  "/cross-chain/:path*",
];

describe("roadmap page proxy", () => {
  it.each(["development", "test"])(
    "keeps roadmap previews available in %s",
    (environment) => {
      expect(isRoadmapPreviewEnvironment(environment)).toBe(true);
      const response = roadmapPageResponse(environment);
      expect(response.status).toBe(200);
      expect(response.headers.get("x-middleware-next")).toBe("1");
    },
  );

  it.each(["production", "staging", undefined])(
    "fails closed outside a preview environment (%s)",
    (environment) => {
      expect(isRoadmapPreviewEnvironment(environment)).toBe(false);
      const response = roadmapPageResponse(environment);
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    },
  );

  it("matches every roadmap page and nested path", () => {
    expect(config.matcher).toEqual(ROADMAP_MATCHERS);
  });

  it("uses the current test environment for the Next.js entrypoint", () => {
    const response = proxy({} as never);

    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });
});
