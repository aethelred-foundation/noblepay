import { Interface, Wallet } from "ethers";
import { ConfigurationError } from "../../lib/production-config";
import {
  ComplianceVerificationError,
  EthersComplianceSubmissionVerifier,
  ExpectedComplianceSubmission,
} from "../../services/compliance-chain";

const CONTRACT = "0x1111111111111111111111111111111111111111";
const REGISTRY = "0x2222222222222222222222222222222222222222";
const OTHER_CONTRACT = "0x3333333333333333333333333333333333333333";
const PAYMENT_ID = `0x${"ab".repeat(32)}`;
const OTHER_PAYMENT_ID = `0x${"aa".repeat(32)}`;
const TX_HASH = `0x${"cd".repeat(32)}`;
const OTHER_TX_HASH = `0x${"cc".repeat(32)}`;
const BLOCK_HASH = `0x${"bc".repeat(32)}`;
const INVESTIGATION = `0x${"ef".repeat(32)}`;
const OTHER_INVESTIGATION = `0x${"ee".repeat(32)}`;
const ATTESTATION = "0x1234";
const iface = new Interface([
  "function submitComplianceResult(bytes32,bool,uint8,bool,bytes32,bytes)",
  "function hasRole(bytes32,address) view returns (bool)",
  "event PaymentCleared(bytes32 indexed paymentId,uint8 amlRiskScore)",
  "event PaymentFlagged(bytes32 indexed paymentId,uint8 amlRiskScore,bytes32 investigationHash)",
  "event PaymentBlocked(bytes32 indexed paymentId,bytes32 investigationHash)",
]);

const validInput: ExpectedComplianceSubmission = {
  txHash: TX_HASH,
  paymentId: PAYMENT_ID,
  sanctionsClear: true,
  amlRiskScore: 25,
  travelRuleCompliant: true,
  investigationHash: INVESTIGATION,
  attestation: ATTESTATION,
};

function dispositionFor(input: ExpectedComplianceSubmission) {
  if (!input.sanctionsClear) return "FAILED" as const;
  if (input.amlRiskScore > 70 || !input.travelRuleCompliant)
    return "UNDER_REVIEW" as const;
  return "PASSED" as const;
}

function complianceEvent(input: ExpectedComplianceSubmission) {
  const disposition = dispositionFor(input);
  const eventName =
    disposition === "PASSED"
      ? "PaymentCleared"
      : disposition === "UNDER_REVIEW"
        ? "PaymentFlagged"
        : "PaymentBlocked";
  const values =
    eventName === "PaymentCleared"
      ? [input.paymentId, input.amlRiskScore]
      : eventName === "PaymentFlagged"
        ? [input.paymentId, input.amlRiskScore, input.investigationHash]
        : [input.paymentId, input.investigationHash];
  return iface.encodeEventLog(iface.getEvent(eventName)!, values);
}

function fixture(inputOverrides: Partial<ExpectedComplianceSubmission> = {}) {
  const input = { ...validInput, ...inputOverrides };
  const signer = Wallet.createRandom().address;
  const callData = iface.encodeFunctionData("submitComplianceResult", [
    input.paymentId,
    input.sanctionsClear,
    input.amlRiskScore,
    input.travelRuleCompliant,
    input.investigationHash.startsWith("0x")
      ? input.investigationHash
      : `0x${input.investigationHash}`,
    input.attestation.startsWith("0x")
      ? input.attestation
      : `0x${input.attestation}`,
  ]);
  const event = complianceEvent({
    ...input,
    investigationHash: input.investigationHash.startsWith("0x")
      ? input.investigationHash
      : `0x${input.investigationHash}`,
  });
  const receipt = {
    hash: TX_HASH,
    status: 1,
    blockNumber: 100,
    blockHash: BLOCK_HASH,
    logs: [{ address: CONTRACT, ...event }],
    confirmations: jest.fn().mockResolvedValue(3),
  };
  const transaction = {
    hash: TX_HASH,
    blockNumber: 100,
    blockHash: BLOCK_HASH,
    to: CONTRACT,
    from: signer,
    data: callData,
    value: 0n,
  };
  const provider: any = {
    getNetwork: jest.fn().mockResolvedValue({ chainId: 7332n }),
    getTransactionReceipt: jest.fn().mockResolvedValue(receipt),
    getTransaction: jest.fn().mockResolvedValue(transaction),
    getBlock: jest
      .fn()
      .mockImplementation((blockTag: string | bigint) =>
        Promise.resolve(
          blockTag === 1n
            ? { number: 1, hash: `0x${"ab".repeat(32)}` }
            : { number: 100, hash: BLOCK_HASH },
        ),
      ),
    call: jest
      .fn()
      .mockResolvedValue(iface.encodeFunctionResult("hasRole", [true])),
  };
  const configurationLoader = jest.fn(() => ({
    rpcUrl: "https://rpc.aethelred.network/",
    chainId: 7332n,
    networkAnchorBlock: 1n,
    networkAnchorHash: `0x${"ab".repeat(32)}`,
    contractAddress: CONTRACT,
    registryContractAddress: REGISTRY,
    minimumConfirmations: 2,
    tokens: [],
  }));
  const service = new EthersComplianceSubmissionVerifier(
    provider,
    configurationLoader,
  );
  return {
    input,
    provider,
    receipt,
    transaction,
    service,
    signer,
    configurationLoader,
  };
}

async function expectCode(
  service: EthersComplianceSubmissionVerifier,
  input: ExpectedComplianceSubmission,
  code: string,
  statusCode = 422,
) {
  await expect(service.verify(input)).rejects.toMatchObject({
    code,
    statusCode,
  });
}

describe("compliance submission receipt verification", () => {
  it("accepts only an authorized confirmed direct call with an exact event", async () => {
    const { provider, service, signer, input } = fixture();
    await expect(service.verify(input)).resolves.toMatchObject({
      txHash: TX_HASH,
      blockNumber: 100n,
      confirmations: 3,
      signer,
      disposition: "PASSED",
    });
    expect(provider.call).toHaveBeenCalledWith(
      expect.objectContaining({ blockTag: 100 }),
    );
  });

  it("normalizes unprefixed mixed-case evidence before comparing it to calldata", async () => {
    const { service, input } = fixture({
      investigationHash: INVESTIGATION.slice(2).toUpperCase(),
      attestation: ATTESTATION.slice(2).toUpperCase(),
    });
    await expect(service.verify(input)).resolves.toMatchObject({
      disposition: "PASSED",
    });
  });

  it.each([
    ["transaction hash", { txHash: "0x1234" }, "INVALID_SUBMISSION_TX"],
    ["payment id", { paymentId: "0x1234" }, "INVALID_PAYMENT_ID"],
    ["fractional risk", { amlRiskScore: 25.5 }, "INVALID_COMPLIANCE_RESULT"],
    ["negative risk", { amlRiskScore: -1 }, "INVALID_COMPLIANCE_RESULT"],
    ["risk above 100", { amlRiskScore: 101 }, "INVALID_COMPLIANCE_RESULT"],
    [
      "odd-length investigation hash",
      { investigationHash: "abc" },
      "INVALID_COMPLIANCE_EVIDENCE",
    ],
    [
      "short investigation hash",
      { investigationHash: "0x1234" },
      "INVALID_COMPLIANCE_EVIDENCE",
    ],
    ["empty attestation", { attestation: "0x" }, "INVALID_COMPLIANCE_EVIDENCE"],
    [
      "non-hex attestation",
      { attestation: "0xgg" },
      "INVALID_COMPLIANCE_EVIDENCE",
    ],
  ])(
    "rejects malformed %s before making an RPC request",
    async (_label, overrides, code) => {
      // Build the provider from a valid fixture because malformed BytesLike values
      // cannot be ABI-encoded. Only the submitted claim is changed.
      const { service, provider, input } = fixture();
      await expectCode(
        service,
        { ...input, ...(overrides as object) },
        code as string,
      );
      expect(provider.getNetwork).not.toHaveBeenCalled();
    },
  );

  it("preserves configuration diagnostics and fails closed on unknown loader errors", async () => {
    const known = new EthersComplianceSubmissionVerifier(undefined, () => {
      throw new ConfigurationError(
        "NOBLEPAY_CHAIN_ID must be a positive integer",
      );
    });
    await expect(known.verify(validInput)).rejects.toMatchObject({
      code: "CHAIN_MISCONFIGURED",
      message: "NOBLEPAY_CHAIN_ID must be a positive integer",
      statusCode: 503,
    });

    const unknown = new EthersComplianceSubmissionVerifier(undefined, () => {
      throw new Error("secret internal detail");
    });
    await expect(unknown.verify(validInput)).rejects.toMatchObject({
      code: "CHAIN_MISCONFIGURED",
      message: "Invalid chain configuration",
      statusCode: 503,
    });
  });

  it("maps unavailable RPC reads to a retryable service error", async () => {
    const { service, provider, input } = fixture();
    provider.getNetwork.mockRejectedValueOnce(new Error("rpc offline"));
    await expectCode(service, input, "CHAIN_RPC_UNAVAILABLE", 503);
  });

  it("rejects an orphaned compliance receipt before accepting its evidence", async () => {
    const { service, provider, input } = fixture();
    provider.getBlock.mockImplementation((blockTag: string | bigint) =>
      Promise.resolve(
        blockTag === 1n
          ? { number: 1, hash: `0x${"ab".repeat(32)}` }
          : { number: 100, hash: `0x${"de".repeat(32)}` },
      ),
    );
    await expectCode(service, input, "SUBMISSION_CANONICAL_MISMATCH", 422);
    expect(provider.call).not.toHaveBeenCalled();
  });

  it("rejects immutable-anchor drift during the final pre-acceptance check", async () => {
    const { service, provider, input } = fixture();
    let anchorReads = 0;
    provider.getBlock.mockImplementation((blockTag: string | bigint) => {
      if (blockTag === 1n) {
        anchorReads += 1;
        return Promise.resolve({
          number: 1,
          hash:
            anchorReads === 1 ? `0x${"ab".repeat(32)}` : `0x${"de".repeat(32)}`,
        });
      }
      return Promise.resolve({ number: 100, hash: BLOCK_HASH });
    });

    await expectCode(service, input, "SUBMISSION_CANONICAL_MISMATCH", 422);
    expect(provider.call).toHaveBeenCalledTimes(1);
  });

  it("rejects a receipt reorg during the final pre-acceptance check", async () => {
    const { service, provider, input, receipt } = fixture();
    provider.getTransactionReceipt
      .mockResolvedValueOnce(receipt)
      .mockResolvedValueOnce(receipt)
      .mockResolvedValueOnce({
        ...receipt,
        blockHash: `0x${"de".repeat(32)}`,
      });

    await expectCode(service, input, "SUBMISSION_CANONICAL_MISMATCH", 422);
  });

  it("rejects a late confirmation-depth drop after all pinned evidence reads", async () => {
    const { service, provider, input, receipt } = fixture();
    receipt.confirmations
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(1);

    await expectCode(service, input, "INSUFFICIENT_CONFIRMATIONS", 409);

    expect(receipt.confirmations).toHaveBeenCalledTimes(3);
    expect(provider.call).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      "wrong chain",
      (f: ReturnType<typeof fixture>) =>
        f.provider.getNetwork.mockResolvedValue({ chainId: 1n }),
      "CHAIN_MISMATCH",
      503,
    ],
    [
      "same-chain-id wrong anchor",
      (f: ReturnType<typeof fixture>) =>
        f.provider.getBlock.mockResolvedValue({
          number: 1,
          hash: `0x${"cd".repeat(32)}`,
        }),
      "CHAIN_MISMATCH",
      503,
    ],
    [
      "missing receipt",
      (f: ReturnType<typeof fixture>) =>
        f.provider.getTransactionReceipt.mockResolvedValue(null),
      "SUBMISSION_NOT_MINED",
      409,
    ],
    [
      "missing transaction",
      (f: ReturnType<typeof fixture>) =>
        f.provider.getTransaction.mockResolvedValue(null),
      "SUBMISSION_NOT_MINED",
      409,
    ],
    [
      "receipt hash mismatch",
      (f: ReturnType<typeof fixture>) => {
        f.receipt.hash = OTHER_TX_HASH;
      },
      "SUBMISSION_HASH_MISMATCH",
      422,
    ],
    [
      "transaction hash mismatch",
      (f: ReturnType<typeof fixture>) => {
        f.transaction.hash = OTHER_TX_HASH;
      },
      "SUBMISSION_HASH_MISMATCH",
      422,
    ],
    [
      "reverted receipt",
      (f: ReturnType<typeof fixture>) => {
        f.receipt.status = 0;
      },
      "SUBMISSION_REVERTED",
      422,
    ],
    [
      "contract creation transaction",
      (f: ReturnType<typeof fixture>) => {
        f.transaction.to = null as any;
      },
      "WRONG_CONTRACT",
      422,
    ],
    [
      "wrong contract",
      (f: ReturnType<typeof fixture>) => {
        f.transaction.to = OTHER_CONTRACT;
      },
      "WRONG_CONTRACT",
      422,
    ],
    [
      "native value",
      (f: ReturnType<typeof fixture>) => {
        f.transaction.value = 1n;
      },
      "INVALID_SUBMISSION_VALUE",
      422,
    ],
    [
      "too few confirmations",
      (f: ReturnType<typeof fixture>) =>
        f.receipt.confirmations.mockResolvedValue(1),
      "INSUFFICIENT_CONFIRMATIONS",
      409,
    ],
    [
      "invalid calldata",
      (f: ReturnType<typeof fixture>) => {
        f.transaction.data = "0x12345678";
      },
      "INVALID_COMPLIANCE_CALL",
      422,
    ],
    [
      "different method",
      (f: ReturnType<typeof fixture>) => {
        f.transaction.data = iface.encodeFunctionData("hasRole", [
          `0x${"00".repeat(32)}`,
          f.signer,
        ]);
      },
      "INVALID_COMPLIANCE_CALL",
      422,
    ],
  ])("rejects %s", async (_label, mutate, code, statusCode) => {
    const current = fixture();
    (mutate as (fixtureValue: ReturnType<typeof fixture>) => void)(current);
    await expectCode(
      current.service,
      current.input,
      code as string,
      statusCode as number,
    );
  });

  it.each([
    ["payment id", { paymentId: OTHER_PAYMENT_ID }],
    ["sanctions outcome", { sanctionsClear: false }],
    ["risk score", { amlRiskScore: 26 }],
    ["travel-rule outcome", { travelRuleCompliant: false }],
    ["investigation hash", { investigationHash: OTHER_INVESTIGATION }],
    ["attestation", { attestation: "0x5678" }],
  ])(
    "rejects a claim whose %s differs from the verified calldata",
    async (_label, overrides) => {
      const { service, input } = fixture();
      await expectCode(
        service,
        { ...input, ...(overrides as object) },
        "COMPLIANCE_RESULT_MISMATCH",
      );
    },
  );

  it("rejects an unauthorized signer and a role-state RPC failure", async () => {
    const unauthorized = fixture();
    unauthorized.provider.call.mockResolvedValue(
      iface.encodeFunctionResult("hasRole", [false]),
    );
    await expectCode(
      unauthorized.service,
      unauthorized.input,
      "UNAUTHORIZED_COMPLIANCE_SIGNER",
    );

    const unavailable = fixture();
    unavailable.provider.call.mockRejectedValue(new Error("state unavailable"));
    await expectCode(
      unavailable.service,
      unavailable.input,
      "UNAUTHORIZED_COMPLIANCE_SIGNER",
    );
  });

  it.each([
    ["high risk", { amlRiskScore: 71 }, "UNDER_REVIEW"],
    ["travel-rule failure", { travelRuleCompliant: false }, "UNDER_REVIEW"],
    ["sanctions match", { sanctionsClear: false }, "FAILED"],
  ])(
    "accepts the exact event for %s",
    async (_label, overrides, disposition) => {
      const { service, input } = fixture(
        overrides as Partial<ExpectedComplianceSubmission>,
      );
      await expect(service.verify(input)).resolves.toMatchObject({
        disposition,
      });
    },
  );

  it("rejects logs that are not one exact canonical disposition event", async () => {
    const cases: Array<(current: ReturnType<typeof fixture>) => void> = [
      (current) => {
        current.receipt.logs = [];
      },
      (current) => {
        current.receipt.logs[0].address = "not-an-address";
      },
      (current) => {
        current.receipt.logs[0].address = OTHER_CONTRACT;
      },
      (current) => {
        current.receipt.logs[0] = {
          address: CONTRACT,
          topics: ["0x1234"],
          data: "0x",
        } as any;
      },
      (current) => {
        const wrong = iface.encodeEventLog(iface.getEvent("PaymentCleared")!, [
          OTHER_PAYMENT_ID,
          25,
        ]);
        current.receipt.logs[0] = { address: CONTRACT, ...wrong };
      },
      (current) => {
        const wrong = iface.encodeEventLog(iface.getEvent("PaymentCleared")!, [
          PAYMENT_ID,
          26,
        ]);
        current.receipt.logs[0] = { address: CONTRACT, ...wrong };
      },
      (current) => {
        current.receipt.logs.push({ ...current.receipt.logs[0] });
      },
    ];

    for (const mutate of cases) {
      const current = fixture();
      mutate(current);
      await expectCode(
        current.service,
        current.input,
        "COMPLIANCE_EVENT_MISMATCH",
      );
    }
  });

  it("binds flagged and blocked events to the exact investigation hash", async () => {
    const flagged = fixture({ amlRiskScore: 71 });
    const wrongFlagged = iface.encodeEventLog(
      iface.getEvent("PaymentFlagged")!,
      [PAYMENT_ID, 71, OTHER_INVESTIGATION],
    );
    flagged.receipt.logs[0] = { address: CONTRACT, ...wrongFlagged };
    await expectCode(
      flagged.service,
      flagged.input,
      "COMPLIANCE_EVENT_MISMATCH",
    );

    const blocked = fixture({ sanctionsClear: false });
    const wrongBlocked = iface.encodeEventLog(
      iface.getEvent("PaymentBlocked")!,
      [PAYMENT_ID, OTHER_INVESTIGATION],
    );
    blocked.receipt.logs[0] = { address: CONTRACT, ...wrongBlocked };
    await expectCode(
      blocked.service,
      blocked.input,
      "COMPLIANCE_EVENT_MISMATCH",
    );
  });

  it("exposes stable error metadata for API mapping", () => {
    const error = new ComplianceVerificationError("CODE", "message");
    expect(error).toMatchObject({
      name: "ComplianceVerificationError",
      code: "CODE",
      statusCode: 422,
    });
  });
});
