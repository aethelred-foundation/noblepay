import { expect, test } from "@playwright/test";

const ROADMAP_PAGE_PATHS = [
  "/treasury",
  "/liquidity",
  "/streaming",
  "/ai-compliance",
  "/invoice-financing",
  "/fx-hedging",
  "/cross-chain",
] as const;

test.beforeEach(async ({ page }) => {
  await page.route(
    "https://public-rpc.operator.example.com/**",
    async (route) => {
      const request = route.request().postDataJSON() as {
        id?: number;
        method?: string;
      };
      if (request.method !== "eth_getBlockByNumber") {
        await route.abort();
        return;
      }
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: request.id ?? 1,
          result: {
            number: "0x1",
            hash: `0x${"ab".repeat(32)}`,
          },
        }),
      });
    },
  );
});

test("production dashboard loads behind the wallet session gate", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Settlement overview" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Connect the business wallet" }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "NoblePay reads operational data only after a wallet is connected.",
    ),
  ).toBeVisible();
});

test("payments never exposes records or mutations without a wallet session", async ({
  page,
}) => {
  await page.goto("/payments");
  await expect(
    page.getByRole("heading", { name: "Payments", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Connect the business wallet" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "New payment" })).toHaveCount(
    0,
  );
  await expect(page.getByText("Payment ledger")).toHaveCount(0);
});

test("production responses emit restrictive security headers", async ({
  request,
}) => {
  const response = await request.get("/");
  expect(response.ok()).toBeTruthy();
  const headers = response.headers();
  expect(headers["strict-transport-security"]).toContain("max-age=63072000");
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["x-frame-options"]).toBe("DENY");
  expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");

  const csp = headers["content-security-policy"];
  const expectedApiOrigin =
    process.env.NOBLEPAY_E2E_EXPECTED_API_ORIGIN ??
    "https://noblepay-ci.example.com";
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).toContain("connect-src 'self'");
  expect(csp).toContain(expectedApiOrigin);
  expect(csp).toContain("wss://relay.walletconnect.org");
  const connectDirective =
    csp.split("; ").find((directive) => directive.startsWith("connect-src ")) ??
    "";
  expect(connectDirective.split(/\s+/)).not.toContain("http:");
  expect(connectDirective.split(/\s+/)).not.toContain("https:");
  expect(connectDirective.split(/\s+/)).not.toContain("ws:");
  expect(connectDirective.split(/\s+/)).not.toContain("wss:");
});

test("production does not expose roadmap pages", async ({ request }) => {
  for (const path of ROADMAP_PAGE_PATHS) {
    await test.step(path, async () => {
      const response = await request.get(path);
      expect(response.status()).toBe(404);
      expect(response.headers()["cache-control"]).toContain("no-store");
      expect(response.headers()["x-robots-tag"]).toBe("noindex, nofollow");
    });
  }
});

test("production sitemap does not advertise roadmap pages", async ({
  request,
}) => {
  const response = await request.get("/sitemap.xml");
  expect(response.ok()).toBeTruthy();
  const sitemap = await response.text();

  for (const path of ROADMAP_PAGE_PATHS) {
    expect(sitemap).not.toContain(`${path}</loc>`);
  }
});
