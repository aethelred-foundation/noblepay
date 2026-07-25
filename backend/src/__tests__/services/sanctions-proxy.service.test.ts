import { ComplianceService } from "../../services/compliance";

const URL = "https://compliance.aethelred.network";
const DIGEST = "a".repeat(64);

function metadata(timestamp = new Date().toISOString()) {
  return {
    total_entries: 19_002,
    last_updated: {
      OFAC: timestamp,
      "UAE Central Bank": timestamp,
      UN: timestamp,
      EU: timestamp,
    },
    source: "OFAC+UAE+UN+EU signed production feeds",
    dataset_generated_at: timestamp,
    dataset_digest: DIGEST,
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("ComplianceService sanctions proxy", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env.COMPLIANCE_API_URL = URL;
    process.env.COMPLIANCE_API_KEY = "s".repeat(32);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.COMPLIANCE_API_URL;
    delete process.env.COMPLIANCE_API_KEY;
  });

  it("returns only fresh metadata for all four required sanctions lists", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        jsonResponse({ status: "healthy", sanctions_lists: metadata() }),
      ) as any;
    const service = new ComplianceService({} as any, {} as any);
    const result = await service.getSanctionsStatus();
    expect(result.totalEntries).toBe(19_002);
    expect(result.listsLoaded).toEqual([
      "OFAC",
      "UAE Central Bank",
      "UN",
      "EU",
    ]);
    expect(result.datasetDigest).toBe(DIGEST);
    expect(global.fetch).toHaveBeenCalledWith(
      `${URL}/v1/health`,
      expect.objectContaining({ signal: expect.anything() }),
    );
  });

  it("fails closed when any required source is stale or missing", async () => {
    const stale = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const incomplete = metadata();
    incomplete.last_updated.OFAC = stale;
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        jsonResponse({ status: "healthy", sanctions_lists: incomplete }),
      ) as any;
    const service = new ComplianceService({} as any, {} as any);
    await expect(service.getSanctionsStatus()).rejects.toMatchObject({
      code: "SANCTIONS_DATASET_STALE",
      statusCode: 503,
    });
  });

  it("rechecks full health after an authenticated refresh before auditing", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse({ success: true }))
      .mockResolvedValueOnce(
        jsonResponse({ status: "healthy", sanctions_lists: metadata() }),
      ) as any;
    const audit = { createAuditEntry: jest.fn().mockResolvedValue({}) };
    const service = new ComplianceService({} as any, audit as any);
    const result = await service.updateSanctionsList("wallet:admin");
    expect(result.totalEntries).toBe(19_002);
    expect(global.fetch).toHaveBeenNthCalledWith(
      1,
      `${URL}/v1/sanctions/update`,
      expect.objectContaining({
        method: "POST",
        headers: { "X-API-Key": "s".repeat(32) },
      }),
    );
    expect(audit.createAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "SANCTIONS_UPDATED",
        actor: "wallet:admin",
      }),
    );
  });
});
