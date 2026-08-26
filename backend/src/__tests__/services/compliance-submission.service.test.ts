import { Prisma } from "@prisma/client";
import { Interface } from "ethers";
import { logger } from "../../lib/logger";
import { ComplianceService } from "../../services/compliance";
import {
  ComplianceVerificationError,
  EthersComplianceSubmissionVerifier,
} from "../../services/compliance-chain";

const CONTRACT = "0x1111111111111111111111111111111111111111";
const REGISTRY = "0x2222222222222222222222222222222222222222";
const TOKEN = "0x3333333333333333333333333333333333333333";
const PAYMENT_ID = `0x${"ab".repeat(32)}`;
const TX_HASH = `0x${"cd".repeat(32)}`;
const INVESTIGATION = `0x${"ef".repeat(32)}`;
const PAYMENT_DB_ID = "11111111-1111-4111-8111-111111111111";
const BLOCK_HASH = `0x${"bc".repeat(32)}`;
const complianceInterface = new Interface([
  "function submitComplianceResult(bytes32,bool,uint8,bool,bytes32,bytes)",
  "function hasRole(bytes32,address) view returns (bool)",
  "event PaymentCleared(bytes32 indexed paymentId,uint8 amlRiskScore)",
]);

function pendingIntent() {
  return {
    paymentId: PAYMENT_DB_ID,
    requestId: PAYMENT_DB_ID,
    state: "PENDING",
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("ComplianceService verified submission", () => {
  const originalFetch = global.fetch;
  const saved: NodeJS.ProcessEnv = {};
  beforeAll(() => {
    for (const key of [
      "COMPLIANCE_API_URL",
      "COMPLIANCE_API_KEY",
      "AETHELRED_RPC_URL",
      "NOBLEPAY_CHAIN_ID",
      "AETHELRED_NETWORK_ANCHOR_BLOCK",
      "AETHELRED_NETWORK_ANCHOR_HASH",
      "NOBLEPAY_CONTRACT_ADDRESS",
      "BUSINESS_REGISTRY_CONTRACT_ADDRESS",
      "NOBLEPAY_MIN_CONFIRMATIONS",
      "NOBLEPAY_TOKEN_CONFIG",
    ])
      saved[key] = process.env[key];
  });
  beforeEach(() => {
    process.env.COMPLIANCE_API_URL = "https://compliance.aethelred.network";
    process.env.COMPLIANCE_API_KEY = "k".repeat(32);
    process.env.AETHELRED_RPC_URL = "https://rpc.aethelred.network";
    process.env.NOBLEPAY_CHAIN_ID = "7332";
    process.env.AETHELRED_NETWORK_ANCHOR_BLOCK = "1";
    process.env.AETHELRED_NETWORK_ANCHOR_HASH = `0x${"ab".repeat(32)}`;
    process.env.NOBLEPAY_CONTRACT_ADDRESS = CONTRACT;
    process.env.BUSINESS_REGISTRY_CONTRACT_ADDRESS = REGISTRY;
    process.env.NOBLEPAY_MIN_CONFIRMATIONS = "2";
    process.env.NOBLEPAY_TOKEN_CONFIG = JSON.stringify({
      [TOKEN]: { currency: "USDC", currencyCode: "USD", decimals: 6 },
    });
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });
  afterAll(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("sends the real payment ID and exact integer amount, then commits only verified evidence", async () => {
    const payment: any = {
      id: PAYMENT_DB_ID,
      paymentId: PAYMENT_ID,
      businessId: "biz-1",
      sender: "0x4444444444444444444444444444444444444444",
      recipient: "0x5555555555555555555555555555555555555555",
      amount: new Prisma.Decimal("1.234567"),
      currency: "USDC",
      purposeHash: `0x${"12".repeat(32)}`,
      status: "PENDING",
      initiatedAt: new Date("2026-07-21T10:00:00.000Z"),
    };
    const created = {
      id: "screen-1",
      paymentId: PAYMENT_ID,
      sanctionsClear: true,
      amlRiskScore: 20,
      travelRuleCompliant: true,
      status: "PASSED",
      flagReason: null,
      investigationHash: INVESTIGATION,
      attestation: "0x1234",
      engineRequestId: "request",
      submissionTxHash: TX_HASH,
      submissionBlockNumber: 90n,
      screenedBy: "0x6666666666666666666666666666666666666666",
      screeningDuration: 10,
    };
    const transaction: any = {
      payment: {
        findFirst: jest.fn().mockResolvedValue(payment),
        update: jest.fn().mockResolvedValue({ ...payment, status: "APPROVED" }),
      },
      complianceScreening: {
        create: jest
          .fn()
          .mockImplementation(({ data }: any) => ({ ...created, ...data })),
        findUnique: jest.fn(),
      },
      complianceSubmissionIntent: {
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn(),
      },
    };
    const prisma: any = {
      payment: { findFirst: jest.fn().mockResolvedValue(payment) },
      complianceScreening: { count: jest.fn().mockResolvedValue(1) },
      complianceSubmissionIntent: {
        upsert: jest.fn().mockResolvedValue(pendingIntent()),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUnique: jest.fn(),
      },
      $transaction: jest.fn(async (callback: (db: any) => unknown) =>
        callback(transaction),
      ),
    };
    const audit: any = {
      createAuditEntryInTransaction: jest.fn().mockResolvedValue({}),
    };
    const verifier: any = {
      verify: jest.fn().mockResolvedValue({
        txHash: TX_HASH,
        blockNumber: 90n,
        confirmations: 3,
        signer: created.screenedBy,
        disposition: "PASSED",
      }),
    };
    global.fetch = jest.fn().mockImplementation(async (_url, options) => {
      const body = JSON.parse(options.body);
      return jsonResponse({
        success: true,
        request_id: body.request_id,
        payment_id: PAYMENT_ID,
        chain_id: "7332",
        contract_address: CONTRACT,
        submission_tx_hash: TX_HASH,
        result: {
          payment_id: PAYMENT_ID,
          sanctions_clear: true,
          aml_risk_score: 20,
          travel_rule_compliant: true,
          status: "Passed",
          attestation: "1234",
          investigation_hash: INVESTIGATION,
          risk_factors: [],
        },
      });
    }) as any;

    const service = new ComplianceService(prisma, audit, verifier);
    const result = await service.submitForScreening(
      {
        paymentId: payment.id,
        priority: "normal",
      },
      "biz-1",
    );

    const requestBody = JSON.parse(
      (global.fetch as jest.Mock).mock.calls[0][1].body,
    );
    expect(requestBody.payment.id).toBe(PAYMENT_ID);
    expect(requestBody.payment.amount).toBe("1234567");
    expect(typeof requestBody.payment.amount).toBe("string");
    expect(requestBody.chain_id).toBe("7332");
    expect(requestBody.request_id).toBe(PAYMENT_DB_ID);
    expect((global.fetch as jest.Mock).mock.calls[0][1].headers).toMatchObject({
      "X-Request-Id": PAYMENT_DB_ID,
      "Idempotency-Key": PAYMENT_DB_ID,
    });
    expect(verifier.verify).toHaveBeenCalledWith(
      expect.objectContaining({
        txHash: TX_HASH,
        paymentId: PAYMENT_ID,
        attestation: "1234",
      }),
    );
    expect(transaction.payment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "APPROVED",
          teeAttestation: "0x1234",
        }),
      }),
    );
    expect(audit.createAuditEntryInTransaction).toHaveBeenCalledWith(
      transaction,
      expect.objectContaining({ txHash: TX_HASH, blockNumber: 90n }),
    );
    expect(result.submissionTxHash).toBe(TX_HASH);
  });

  it("does not mutate payment state when on-chain verification fails", async () => {
    const payment: any = {
      id: PAYMENT_DB_ID,
      paymentId: PAYMENT_ID,
      sender: "0x4444444444444444444444444444444444444444",
      recipient: "0x5555555555555555555555555555555555555555",
      amount: new Prisma.Decimal("1"),
      currency: "USDC",
      purposeHash: null,
      status: "PENDING",
      initiatedAt: new Date(),
    };
    const prisma: any = {
      payment: { findFirst: jest.fn().mockResolvedValue(payment) },
      complianceSubmissionIntent: {
        upsert: jest.fn().mockResolvedValue(pendingIntent()),
      },
      $transaction: jest.fn(),
    };
    const verifier: any = {
      verify: jest.fn().mockRejectedValue(new Error("bad receipt")),
    };
    global.fetch = jest.fn().mockImplementation(async (_url, options) => {
      const body = JSON.parse(options.body);
      return jsonResponse({
        success: true,
        request_id: body.request_id,
        payment_id: PAYMENT_ID,
        chain_id: "7332",
        contract_address: CONTRACT,
        submission_tx_hash: TX_HASH,
        result: {
          payment_id: PAYMENT_ID,
          sanctions_clear: true,
          aml_risk_score: 20,
          travel_rule_compliant: true,
          status: "Passed",
          attestation: "1234",
          investigation_hash: INVESTIGATION,
        },
      });
    }) as any;
    const service = new ComplianceService(prisma, {} as any, verifier);
    await expect(
      service.submitForScreening(
        { paymentId: payment.id, priority: "normal" },
        "biz-1",
      ),
    ).rejects.toMatchObject({
      code: "COMPLIANCE_VERIFICATION_UNAVAILABLE",
      statusCode: 503,
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "before verified evidence is persisted",
      successfulVerifications: 1,
      evidencePersisted: false,
    },
    {
      label: "before the payment and screening transaction commits",
      successfulVerifications: 2,
      evidencePersisted: true,
    },
  ])(
    "rejects a late chain drift $label",
    async ({ successfulVerifications, evidencePersisted }) => {
      const payment: any = {
        id: PAYMENT_DB_ID,
        paymentId: PAYMENT_ID,
        businessId: "biz-1",
        sender: "0x4444444444444444444444444444444444444444",
        recipient: "0x5555555555555555555555555555555555555555",
        amount: new Prisma.Decimal("1"),
        currency: "USDC",
        purposeHash: null,
        status: "PENDING",
        initiatedAt: new Date(),
      };
      const updateMany = jest.fn().mockResolvedValue({ count: 1 });
      const prisma: any = {
        payment: { findFirst: jest.fn().mockResolvedValue(payment) },
        complianceSubmissionIntent: {
          upsert: jest.fn().mockResolvedValue(pendingIntent()),
          updateMany,
          findUnique: jest.fn(),
        },
        $transaction: jest.fn(),
      };
      const verified = {
        txHash: TX_HASH,
        blockNumber: 90n,
        confirmations: 3,
        signer: "0x6666666666666666666666666666666666666666",
        disposition: "PASSED",
      };
      const verify = jest.fn();
      for (let index = 0; index < successfulVerifications; index += 1) {
        verify.mockResolvedValueOnce(verified);
      }
      verify.mockRejectedValueOnce(
        new ComplianceVerificationError(
          "SUBMISSION_CANONICAL_MISMATCH",
          "Compliance evidence changed before it could be accepted",
          422,
        ),
      );
      global.fetch = jest.fn().mockImplementation(async (_url, options) => {
        const body = JSON.parse(options.body);
        return jsonResponse({
          success: true,
          request_id: body.request_id,
          payment_id: PAYMENT_ID,
          chain_id: "7332",
          contract_address: CONTRACT,
          submission_tx_hash: TX_HASH,
          result: {
            payment_id: PAYMENT_ID,
            sanctions_clear: true,
            aml_risk_score: 20,
            travel_rule_compliant: true,
            status: "Passed",
            attestation: "1234",
            investigation_hash: INVESTIGATION,
          },
        });
      }) as any;

      const service = new ComplianceService(prisma, {} as any, { verify });
      await expect(
        service.submitForScreening(
          { paymentId: payment.id, priority: "normal" },
          "biz-1",
        ),
      ).rejects.toMatchObject({
        code: "SUBMISSION_CANONICAL_MISMATCH",
        statusCode: 422,
      });

      expect(updateMany).toHaveBeenCalledTimes(evidencePersisted ? 1 : 0);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    },
  );

  it("does not advance PENDING evidence or open the final transaction after a late confirmation-depth drop", async () => {
    const payment: any = {
      id: PAYMENT_DB_ID,
      paymentId: PAYMENT_ID,
      businessId: "biz-1",
      sender: "0x4444444444444444444444444444444444444444",
      recipient: "0x5555555555555555555555555555555555555555",
      amount: new Prisma.Decimal("1"),
      currency: "USDC",
      purposeHash: null,
      status: "PENDING",
      initiatedAt: new Date(),
    };
    const intentUpdate = jest.fn().mockResolvedValue({ count: 1 });
    const prisma: any = {
      payment: { findFirst: jest.fn().mockResolvedValue(payment) },
      complianceSubmissionIntent: {
        upsert: jest.fn().mockResolvedValue(pendingIntent()),
        updateMany: intentUpdate,
        findUnique: jest.fn(),
      },
      $transaction: jest.fn(),
    };
    const signer = "0x6666666666666666666666666666666666666666";
    const event = complianceInterface.encodeEventLog(
      complianceInterface.getEvent("PaymentCleared")!,
      [PAYMENT_ID, 20],
    );
    const receipt: any = {
      hash: TX_HASH,
      status: 1,
      blockNumber: 90,
      blockHash: BLOCK_HASH,
      logs: [{ address: CONTRACT, ...event }],
      // The first complete verifier pass succeeds. On the immediate
      // pre-persistence revalidation, both canonical reads pass but the final
      // snapshot observes a shorter head and fails closed.
      confirmations: jest
        .fn()
        .mockResolvedValueOnce(3)
        .mockResolvedValueOnce(3)
        .mockResolvedValueOnce(3)
        .mockResolvedValueOnce(3)
        .mockResolvedValueOnce(3)
        .mockResolvedValueOnce(1),
    };
    const transaction: any = {
      hash: TX_HASH,
      blockNumber: 90,
      blockHash: BLOCK_HASH,
      to: CONTRACT,
      from: signer,
      data: complianceInterface.encodeFunctionData("submitComplianceResult", [
        PAYMENT_ID,
        true,
        20,
        true,
        INVESTIGATION,
        "0x1234",
      ]),
      value: 0n,
    };
    const provider: any = {
      getNetwork: jest.fn().mockResolvedValue({ chainId: 7332n }),
      getTransactionReceipt: jest.fn().mockResolvedValue(receipt),
      getTransaction: jest.fn().mockResolvedValue(transaction),
      getBlock: jest
        .fn()
        .mockImplementation((blockTag: number | bigint) =>
          Promise.resolve(
            blockTag === 1n
              ? { number: 1, hash: `0x${"ab".repeat(32)}` }
              : { number: 90, hash: BLOCK_HASH },
          ),
        ),
      call: jest
        .fn()
        .mockResolvedValue(
          complianceInterface.encodeFunctionResult("hasRole", [true]),
        ),
    };
    const verifier = new EthersComplianceSubmissionVerifier(provider, () => ({
      rpcUrl: "https://rpc.aethelred.network/",
      chainId: 7332n,
      networkAnchorBlock: 1n,
      networkAnchorHash: `0x${"ab".repeat(32)}`,
      contractAddress: CONTRACT,
      registryContractAddress: REGISTRY,
      minimumConfirmations: 2,
      tokens: [],
    }));
    global.fetch = jest.fn().mockImplementation(async (_url, options) => {
      const body = JSON.parse(options.body);
      return jsonResponse({
        success: true,
        request_id: body.request_id,
        payment_id: PAYMENT_ID,
        chain_id: "7332",
        contract_address: CONTRACT,
        submission_tx_hash: TX_HASH,
        result: {
          payment_id: PAYMENT_ID,
          sanctions_clear: true,
          aml_risk_score: 20,
          travel_rule_compliant: true,
          status: "Passed",
          attestation: "1234",
          investigation_hash: INVESTIGATION,
        },
      });
    }) as any;

    const service = new ComplianceService(prisma, {} as any, verifier);
    await expect(
      service.submitForScreening(
        { paymentId: payment.id, priority: "normal" },
        "biz-1",
      ),
    ).rejects.toMatchObject({
      code: "INSUFFICIENT_CONFIRMATIONS",
      statusCode: 409,
    });

    expect(receipt.confirmations).toHaveBeenCalledTimes(6);
    expect(intentUpdate).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("rejects an oversized verifier response before JSON parsing or chain verification", async () => {
    const payment: any = {
      id: PAYMENT_DB_ID,
      paymentId: PAYMENT_ID,
      sender: "0x4444444444444444444444444444444444444444",
      recipient: "0x5555555555555555555555555555555555555555",
      amount: new Prisma.Decimal("1"),
      currency: "USDC",
      purposeHash: null,
      status: "PENDING",
      initiatedAt: new Date(),
    };
    const prisma: any = {
      payment: { findFirst: jest.fn().mockResolvedValue(payment) },
      complianceSubmissionIntent: {
        upsert: jest.fn().mockResolvedValue(pendingIntent()),
      },
      $transaction: jest.fn(),
    };
    const verifier: any = { verify: jest.fn() };
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        new Response("x".repeat(1024 * 1024 + 1), { status: 200 }),
      ) as any;

    const service = new ComplianceService(prisma, {} as any, verifier);
    await expect(
      service.submitForScreening(
        { paymentId: payment.id, priority: "normal" },
        "biz-1",
      ),
    ).rejects.toMatchObject({
      code: "COMPLIANCE_SUBMISSION_UNAVAILABLE",
      statusCode: 503,
    });
    expect(verifier.verify).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("does not copy an operator error that may echo Travel Rule PII into logs", async () => {
    const echoedPrivateValue = "Private Originator Legal Name";
    const payment: any = {
      id: PAYMENT_DB_ID,
      paymentId: PAYMENT_ID,
      businessId: "biz-1",
      sender: "0x4444444444444444444444444444444444444444",
      recipient: "0x5555555555555555555555555555555555555555",
      amount: new Prisma.Decimal("1"),
      currency: "USDC",
      purposeHash: null,
      status: "PENDING",
      initiatedAt: new Date(),
    };
    const prisma: any = {
      payment: { findFirst: jest.fn().mockResolvedValue(payment) },
      complianceSubmissionIntent: {
        upsert: jest.fn().mockResolvedValue(pendingIntent()),
      },
      $transaction: jest.fn(),
    };
    global.fetch = jest.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          success: false,
          error: `invalid originator: ${echoedPrivateValue}`,
        }),
        {
          status: 422,
          headers: { "Content-Type": "application/json" },
        },
      ),
    ) as any;
    const errorLog = jest
      .spyOn(logger, "error")
      .mockImplementation(() => logger);
    try {
      const service = new ComplianceService(
        prisma,
        {} as any,
        { verify: jest.fn() } as any,
      );
      await expect(
        service.submitForScreening(
          { paymentId: payment.id, priority: "normal" },
          "biz-1",
        ),
      ).rejects.toMatchObject({
        code: "COMPLIANCE_SUBMISSION_UNAVAILABLE",
        statusCode: 503,
      });
      expect(JSON.stringify(errorLog.mock.calls)).not.toContain(
        echoedPrivateValue,
      );
    } finally {
      errorLog.mockRestore();
    }
  });

  it("recovers durable verified evidence after the final database transaction fails", async () => {
    const payment: any = {
      id: PAYMENT_DB_ID,
      paymentId: PAYMENT_ID,
      sender: "0x4444444444444444444444444444444444444444",
      recipient: "0x5555555555555555555555555555555555555555",
      amount: new Prisma.Decimal("2"),
      currency: "USDC",
      purposeHash: null,
      status: "PENDING",
      initiatedAt: new Date("2026-07-21T10:00:00.000Z"),
    };
    const signer = "0x6666666666666666666666666666666666666666";
    let intent: any = pendingIntent();
    const intentStore = {
      upsert: jest.fn().mockImplementation(async () => ({ ...intent })),
      updateMany: jest.fn().mockImplementation(async ({ data }: any) => {
        intent = { ...intent, ...data };
        return { count: 1 };
      }),
      findUnique: jest.fn().mockImplementation(async () => ({ ...intent })),
    };
    const created = {
      id: "screen-recovered",
      paymentId: PAYMENT_ID,
      sanctionsClear: true,
      amlRiskScore: 20,
      travelRuleCompliant: true,
      status: "PASSED",
      flagReason: null,
      screenedBy: signer,
      screeningDuration: 12,
      submissionTxHash: TX_HASH,
      submissionBlockNumber: 90n,
    };
    const transaction: any = {
      payment: {
        findFirst: jest.fn().mockResolvedValue(payment),
        update: jest.fn().mockResolvedValue({ ...payment, status: "APPROVED" }),
      },
      complianceScreening: {
        create: jest
          .fn()
          .mockImplementation(({ data }: any) => ({ ...created, ...data })),
        findUnique: jest.fn(),
      },
      complianceSubmissionIntent: {
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const prisma: any = {
      payment: { findFirst: jest.fn().mockResolvedValue(payment) },
      complianceScreening: { count: jest.fn().mockResolvedValue(1) },
      complianceSubmissionIntent: intentStore,
      $transaction: jest
        .fn()
        .mockRejectedValueOnce(new Error("database commit failed"))
        .mockImplementationOnce(async (callback: (db: any) => unknown) =>
          callback(transaction),
        ),
    };
    const audit: any = {
      createAuditEntryInTransaction: jest.fn().mockResolvedValue({}),
    };
    const verifier: any = {
      verify: jest.fn().mockResolvedValue({
        txHash: TX_HASH,
        blockNumber: 90n,
        confirmations: 3,
        signer,
        disposition: "PASSED",
      }),
    };
    global.fetch = jest.fn().mockImplementation(async (_url, options) => {
      const body = JSON.parse(options.body);
      return jsonResponse({
        success: true,
        request_id: body.request_id,
        payment_id: PAYMENT_ID,
        chain_id: "7332",
        contract_address: CONTRACT,
        submission_tx_hash: TX_HASH,
        result: {
          payment_id: PAYMENT_ID,
          sanctions_clear: true,
          aml_risk_score: 20,
          travel_rule_compliant: true,
          status: "Passed",
          attestation: "1234",
          investigation_hash: INVESTIGATION,
        },
      });
    }) as any;

    const service = new ComplianceService(prisma, audit, verifier);
    await expect(
      service.submitForScreening(
        { paymentId: payment.id, priority: "normal" },
        "biz-1",
      ),
    ).rejects.toThrow("database commit failed");

    expect(intent.state).toBe("VERIFIED");
    expect(intent.submissionTxHash).toBe(TX_HASH);
    expect(intentStore.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.$transaction.mock.invocationCallOrder[0],
    );

    await expect(
      service.submitForScreening(
        { paymentId: payment.id, priority: "normal" },
        "biz-1",
      ),
    ).resolves.toMatchObject({ submissionTxHash: TX_HASH, status: "PASSED" });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(verifier.verify).toHaveBeenCalledTimes(5);
    expect(transaction.complianceSubmissionIntent.update).toHaveBeenCalledWith({
      where: { paymentId: PAYMENT_DB_ID },
      data: { state: "COMPLETED", completedAt: expect.any(Date) },
    });
  });

  it("reuses the deterministic provider request after chain success but evidence persistence fails", async () => {
    const payment: any = {
      id: PAYMENT_DB_ID,
      paymentId: PAYMENT_ID,
      businessId: "biz-1",
      sender: "0x4444444444444444444444444444444444444444",
      recipient: "0x5555555555555555555555555555555555555555",
      amount: new Prisma.Decimal("3000"),
      currency: "USDC",
      purposeHash: null,
      status: "PENDING",
      initiatedAt: new Date("2026-07-21T10:00:00.000Z"),
    };
    const signer = "0x6666666666666666666666666666666666666666";
    let intent: any = pendingIntent();
    const intentStore = {
      upsert: jest.fn().mockImplementation(async () => ({ ...intent })),
      updateMany: jest
        .fn()
        .mockRejectedValueOnce(new Error("intent write failed"))
        .mockImplementationOnce(async ({ data }: any) => {
          intent = { ...intent, ...data };
          return { count: 1 };
        }),
      findUnique: jest.fn().mockImplementation(async () => ({ ...intent })),
    };
    const transaction: any = {
      payment: {
        findFirst: jest.fn().mockResolvedValue(payment),
        update: jest.fn().mockResolvedValue({ ...payment, status: "APPROVED" }),
      },
      complianceScreening: {
        create: jest
          .fn()
          .mockImplementation(({ data }: any) => ({ id: "screen-2", ...data })),
        findUnique: jest.fn(),
      },
      complianceSubmissionIntent: {
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      travelRuleRecord: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const prisma: any = {
      payment: { findFirst: jest.fn().mockResolvedValue(payment) },
      complianceScreening: { count: jest.fn().mockResolvedValue(1) },
      complianceSubmissionIntent: intentStore,
      $transaction: jest.fn(async (callback: (db: any) => unknown) =>
        callback(transaction),
      ),
    };
    const audit: any = {
      createAuditEntryInTransaction: jest.fn().mockResolvedValue({}),
    };
    const verifier: any = {
      verify: jest.fn().mockResolvedValue({
        txHash: TX_HASH,
        blockNumber: 90n,
        confirmations: 3,
        signer,
        disposition: "PASSED",
      }),
    };
    global.fetch = jest.fn().mockImplementation(async (_url, options) => {
      const body = JSON.parse(options.body);
      return jsonResponse({
        success: true,
        request_id: body.request_id,
        payment_id: PAYMENT_ID,
        chain_id: "7332",
        contract_address: CONTRACT,
        submission_tx_hash: TX_HASH,
        result: {
          payment_id: PAYMENT_ID,
          sanctions_clear: true,
          aml_risk_score: 20,
          travel_rule_compliant: true,
          status: "Passed",
          attestation: "1234",
          investigation_hash: INVESTIGATION,
        },
      });
    }) as any;

    const travelRuleData = {
      originator_name: "Acme Trading LLC",
      originator_account: "AE-001",
      originator_address: "Dubai, AE",
      beneficiary_name: "Beneficiary Ltd",
      beneficiary_account: "GB-002",
    };
    const payloadCommitment = `0x${"91".repeat(32)}`;
    const travelRuleService: any = {
      loadAuthorizedPayload: jest.fn().mockResolvedValue({
        required: true,
        recordId: "travel-1",
        payloadCommitment,
        data: travelRuleData,
      }),
      recordOutboundAttempt: jest.fn().mockResolvedValue(undefined),
    };
    const service = new ComplianceService(
      prisma,
      audit,
      verifier,
      travelRuleService,
    );
    await expect(
      service.submitForScreening(
        { paymentId: payment.id, priority: "normal" },
        "biz-1",
      ),
    ).rejects.toMatchObject({
      code: "COMPLIANCE_EVIDENCE_PERSIST_FAILED",
      statusCode: 503,
    });

    await expect(
      service.submitForScreening(
        { paymentId: payment.id, priority: "normal" },
        "biz-1",
      ),
    ).resolves.toMatchObject({ submissionTxHash: TX_HASH, status: "PASSED" });

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(travelRuleService.recordOutboundAttempt).toHaveBeenCalledTimes(2);
    expect(travelRuleService.recordOutboundAttempt).toHaveBeenCalledWith({
      paymentRecordId: PAYMENT_DB_ID,
      businessId: "biz-1",
      recordId: "travel-1",
      payloadCommitment,
      requestId: PAYMENT_DB_ID,
      destination: "https://compliance.aethelred.network",
    });
    expect(
      travelRuleService.recordOutboundAttempt.mock.invocationCallOrder[0],
    ).toBeLessThan((global.fetch as jest.Mock).mock.invocationCallOrder[0]);
    const requestIds = (global.fetch as jest.Mock).mock.calls.map(
      ([, options]) => JSON.parse(options.body).request_id,
    );
    expect(requestIds).toEqual([PAYMENT_DB_ID, PAYMENT_DB_ID]);
    const requestBodies = (global.fetch as jest.Mock).mock.calls.map(
      ([, options]) => JSON.parse(options.body),
    );
    expect(requestBodies[0]).toEqual(requestBodies[1]);
    expect(requestBodies[0]).toMatchObject({
      travel_rule_data: travelRuleData,
      travel_rule_required: true,
      travel_rule_payload_commitment: payloadCommitment,
    });
    for (const [, options] of (global.fetch as jest.Mock).mock.calls) {
      expect(options.headers["Idempotency-Key"]).toBe(PAYMENT_DB_ID);
    }
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(transaction.travelRuleRecord.updateMany).toHaveBeenCalledWith({
      where: {
        id: "travel-1",
        paymentId: PAYMENT_ID,
        payloadCommitment,
        shared: false,
      },
      data: {
        shared: true,
        sharedWith: ["https://compliance.aethelred.network"],
        sharedAt: expect.any(Date),
        submissionTxHash: TX_HASH,
        submissionBlockNumber: 90n,
      },
    });
  });

  /**
   * Evaluation mode must not make screening permissive.
   *
   * COMPLIANCE_EVALUATION_ACKNOWLEDGEMENT lets the process boot without an
   * audited compliance service. It must not, under any circumstances, let a
   * payment through unscreened. This is the test that says so.
   */
  it("still REFUSES to screen a payment in compliance evaluation mode", async () => {
    delete process.env.COMPLIANCE_API_URL;
    delete process.env.COMPLIANCE_API_KEY;
    process.env.COMPLIANCE_EVALUATION_ACKNOWLEDGEMENT =
      "acknowledge-evaluation-only-no-compliance-screening";
    process.env.NEXT_PUBLIC_CHAIN_ENV = "testnet";

    const payment: any = {
      id: PAYMENT_DB_ID,
      paymentId: PAYMENT_ID,
      businessId: "biz-1",
      sender: "0x4444444444444444444444444444444444444444",
      recipient: "0x5555555555555555555555555555555555555555",
      amount: new Prisma.Decimal("1.234567"),
      currency: "USDC",
      purposeHash: `0x${"12".repeat(32)}`,
      status: "PENDING",
    };
    const prisma: any = {
      payment: { findFirst: jest.fn().mockResolvedValue(payment) },
      complianceScreening: { count: jest.fn().mockResolvedValue(0) },
      complianceSubmissionIntent: {
        upsert: jest.fn(),
        updateMany: jest.fn(),
        findUnique: jest.fn(),
      },
      $transaction: jest.fn(),
    };
    global.fetch = jest.fn(async () => {
      throw new Error("no compliance request may be attempted");
    }) as any;

    const service = new ComplianceService(prisma, {} as any, {} as any);
    await expect(
      service.submitForScreening(
        { paymentId: payment.id, priority: "normal" },
        "biz-1",
      ),
    ).rejects.toMatchObject({
      code: "COMPLIANCE_SUBMISSION_NOT_CONFIGURED",
      statusCode: 501,
    });

    // Nothing was attempted and nothing was recorded: refused, not approved.
    expect(global.fetch).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();

    delete process.env.COMPLIANCE_EVALUATION_ACKNOWLEDGEMENT;
    delete process.env.NEXT_PUBLIC_CHAIN_ENV;
  });
});
