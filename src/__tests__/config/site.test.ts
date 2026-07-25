jest.unmock("@/config/site");

const { resolvePublicSiteUrl } =
  jest.requireActual<typeof import("@/config/site")>("@/config/site");

describe("public site configuration", () => {
  it("uses the local frontend outside production", () => {
    expect(resolvePublicSiteUrl(undefined, "test")).toBe(
      "http://localhost:3008",
    );
  });

  it("requires an explicit HTTPS origin in production", () => {
    expect(
      resolvePublicSiteUrl("https://pay.operator.example/", "production"),
    ).toBe("https://pay.operator.example");
    expect(() => resolvePublicSiteUrl(undefined, "production")).toThrow(
      /required/,
    );
    expect(() =>
      resolvePublicSiteUrl("http://pay.operator.example", "production"),
    ).toThrow(/https/);
  });

  it.each([
    "not-a-url",
    "file:///tmp/site",
    "https://user:secret@pay.operator.example",
    "https://pay.operator.example/subpath",
    "https://pay.operator.example?tenant=one",
    "https://pay.operator.example/#fragment",
  ])("rejects an unsafe public origin %s", (value) => {
    expect(() => resolvePublicSiteUrl(value, "test")).toThrow(
      /NEXT_PUBLIC_SITE_URL/,
    );
  });
});
