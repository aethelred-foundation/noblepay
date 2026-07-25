import { Interface, Wallet } from "ethers";
import { Prisma } from "@prisma/client";
import {
  buildRegistrationCommitment,
  buildWalletChallengeMessage,
} from "../../lib/wallet-challenge";
import {
  BusinessRegistrationError,
  BusinessRegistrationService,
} from "../../services/business-registration";

const REGISTRY = "0x1111111111111111111111111111111111111111";
const OTHER_REGISTRY = "0x2222222222222222222222222222222222222222";
const OFFICER = "0x3333333333333333333333333333333333333333";
const OTHER_OFFICER = "0x4444444444444444444444444444444444444444";
const TX_HASH = `0x${"ab".repeat(32)}`;
const OTHER_TX_HASH = `0x${"ac".repeat(32)}`;
const BLOCK_HASH = `0x${"bc".repeat(32)}`;
const CHALLENGE_ID = "11111111-1111-4111-8111-111111111111";
const TIMESTAMP = 1_750_000_000;
const registry = new Interface([
  "function registerBusiness(string _licenseNumber,string _businessName,uint8 _jurisdiction,address _complianceOfficer)",
  "function getBusinessDetails(address _business) view returns ((address wallet,string licenseNumber,string businessName,uint8 jurisdiction,uint8 kycStatus,uint8 tier,uint256 registeredAt,uint256 lastVerified,address complianceOfficer))",
  "event BusinessRegistered(address indexed wallet,string licenseNumber,string businessName,uint8 jurisdiction)",
]);
const safe = new Interface([
  "function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) payable returns (bool success)",
]);
const eip1271 = new Interface([
  "function isValidSignature(bytes32 hash,bytes signature) view returns (bytes4 magicValue)",
]);

const originalEnvironment: Record<string, string | undefined> = {};
const environmentKeys = [
  "AETHELRED_RPC_URL",
  "NOBLEPAY_CHAIN_ID",
  "AETHELRED_NETWORK_ANCHOR_BLOCK",
  "AETHELRED_NETWORK_ANCHOR_HASH",
  "BUSINESS_REGISTRY_CONTRACT_ADDRESS",
  "NOBLEPAY_MIN_CONFIRMATIONS",
  "PUBLIC_ORIGIN",
];

function configureEnvironment() {
  process.env.AETHELRED_RPC_URL = "https://rpc.aethelred.network";
  process.env.NOBLEPAY_CHAIN_ID = "7332";
  process.env.AETHELRED_NETWORK_ANCHOR_BLOCK = "1";
  process.env.AETHELRED_NETWORK_ANCHOR_HASH = `0x${"ab".repeat(32)}`;
  process.env.BUSINESS_REGISTRY_CONTRACT_ADDRESS = REGISTRY;
  process.env.NOBLEPAY_MIN_CONFIRMATIONS = "2";
  process.env.PUBLIC_ORIGIN = "https://pay.aethelred.network";
}

async function fixture(overrides: Record<string, unknown> = {}) {
  const wallet = Wallet.createRandom();
  const input: any = {
    address: wallet.address,
    licenseNumber: "DMCC123456",
    businessName: "Acme Treasury",
    jurisdiction: "UAE",
    businessType: "LLC",
    complianceOfficer: OFFICER,
    contactEmail: "ops@acme.test",
    txHash: TX_HASH,
    challengeId: CHALLENGE_ID,
    signature: "",
    ...overrides,
  };
  const committedInput = {
    address: input.address,
    txHash: input.txHash,
    licenseNumber: input.licenseNumber,
    businessName: input.businessName,
    jurisdiction: input.jurisdiction,
    businessType: input.businessType,
    complianceOfficer: input.complianceOfficer,
    contactEmail: input.contactEmail,
  };
  const registrationCommitment = buildRegistrationCommitment(committedInput);
  const issuedAt = new Date();
  const message = buildWalletChallengeMessage({
    address: input.address,
    purpose: "registration",
    nonce: "0123456789abcdef0123456789abcdef",
    issuedAt,
    expiresAt: new Date(issuedAt.getTime() + 60_000),
    challengeId: CHALLENGE_ID,
    txHash: input.txHash,
    registrationCommitment,
  });
  input.signature = await wallet.signMessage(message);

  const event = registry.encodeEventLog(
    registry.getEvent("BusinessRegistered")!,
    [
      input.address,
      input.licenseNumber,
      input.businessName,
      input.jurisdiction === "UAE" ? 0 : 1,
    ],
  );
  const persistedBusiness: any = {
    id: "business-1",
    address: input.address,
    licenseNumber: input.licenseNumber,
    businessName: input.businessName,
    jurisdiction: input.jurisdiction,
    businessType: input.businessType,
    complianceOfficer: input.complianceOfficer,
    contactEmail: input.contactEmail,
    kycStatus: "PENDING",
    tier: "STANDARD",
    registeredAt: new Date(TIMESTAMP * 1000),
    lastVerified: null,
    dailyLimit: new Prisma.Decimal(50_000),
    monthlyLimit: new Prisma.Decimal(500_000),
    registrationTxHash: TX_HASH,
    registrationBlockNumber: 99n,
  };
  const challenge: any = {
    id: CHALLENGE_ID,
    address: input.address,
    nonce: "0123456789abcdef0123456789abcdef",
    message,
    purpose: "REGISTRATION",
    transactionHash: input.txHash,
    expiresAt: new Date(Date.now() + 60_000),
    usedAt: null,
  };
  const receipt: any = {
    hash: TX_HASH,
    status: 1,
    blockNumber: 99,
    blockHash: BLOCK_HASH,
    logs: [{ address: REGISTRY, ...event }],
    confirmations: jest.fn().mockResolvedValue(3),
  };
  const transaction: any = {
    hash: TX_HASH,
    blockNumber: 99,
    blockHash: BLOCK_HASH,
    to: REGISTRY,
    from: input.address,
    data: registry.encodeFunctionData("registerBusiness", [
      input.licenseNumber,
      input.businessName,
      input.jurisdiction === "UAE" ? 0 : 1,
      input.complianceOfficer,
    ]),
    value: 0n,
  };
  const database: any = {
    $executeRaw: jest.fn(),
    walletChallenge: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    business: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue(persistedBusiness),
    },
    aPIKey: {
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      create: jest.fn().mockResolvedValue({ id: "key-1" }),
    },
  };
  const prisma: any = {
    walletChallenge: { findUnique: jest.fn().mockResolvedValue(challenge) },
    $transaction: jest.fn(async (callback: (database: any) => unknown) =>
      callback(database),
    ),
  };
  const provider: any = {
    getNetwork: jest.fn().mockResolvedValue({ chainId: 7332n }),
    getCode: jest.fn().mockResolvedValue("0x"),
    getTransactionReceipt: jest.fn().mockResolvedValue(receipt),
    getTransaction: jest.fn().mockResolvedValue(transaction),
    getBlock: jest.fn().mockImplementation((blockTag: string | bigint) =>
      Promise.resolve(
        blockTag === 1n
          ? { number: 1, hash: `0x${"ab".repeat(32)}` }
          : {
              number: 99,
              hash: BLOCK_HASH,
              timestamp: TIMESTAMP,
            },
      ),
    ),
    call: jest
      .fn()
      .mockResolvedValue(
        registry.encodeFunctionResult("getBusinessDetails", [
          [
            input.address,
            input.licenseNumber,
            input.businessName,
            input.jurisdiction === "UAE" ? 0 : 1,
            0,
            0,
            TIMESTAMP,
            0,
            input.complianceOfficer,
          ],
        ]),
      ),
  };
  const audit: any = {
    createAuditEntryInTransaction: jest.fn().mockResolvedValue({}),
  };
  const service = new BusinessRegistrationService(prisma, audit, provider);
  return {
    wallet,
    input,
    committedInput,
    registrationCommitment,
    challenge,
    receipt,
    transaction,
    persistedBusiness,
    database,
    prisma,
    provider,
    audit,
    service,
  };
}

async function expectCode(
  current: Awaited<ReturnType<typeof fixture>>,
  code: string,
  statusCode?: number,
) {
  await expect(current.service.register(current.input)).rejects.toMatchObject({
    code,
    ...(statusCode === undefined ? {} : { statusCode }),
  });
}

describe("BusinessRegistrationService security binding and reconciliation", () => {
  beforeAll(() => {
    for (const key of environmentKeys)
      originalEnvironment[key] = process.env[key];
  });
  beforeEach(configureEnvironment);
  afterAll(() => {
    for (const [key, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("persists a fully committed, signed, confirmed registration", async () => {
    const current = await fixture();
    await expect(
      current.service.register(current.input),
    ).resolves.toMatchObject({
      business: { id: "business-1" },
      replayed: false,
      confirmations: 3,
      chainId: "7332",
      apiKey: expect.stringMatching(/^npk_[a-f0-9]{64}$/),
    });
    expect(current.provider.call).toHaveBeenCalledWith(
      expect.objectContaining({ blockTag: 99 }),
    );
    expect(current.database.business.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          registrationTxHash: TX_HASH,
          registrationBlockNumber: 99n,
        }),
      }),
    );
  });

  it("accepts an EIP-1271 Safe signature and canonical Safe registry call", async () => {
    const current = await fixture();
    const innerCall = current.transaction.data;
    current.provider.getCode.mockResolvedValue("0x6001600055");
    current.provider.send = jest
      .fn()
      .mockResolvedValue(
        eip1271.encodeFunctionResult("isValidSignature", ["0x1626ba7e"]),
      );
    current.transaction.to = current.input.address;
    current.transaction.from = OFFICER;
    current.transaction.data = safe.encodeFunctionData("execTransaction", [
      REGISTRY,
      0n,
      innerCall,
      0,
      0n,
      0n,
      0n,
      "0x0000000000000000000000000000000000000000",
      "0x0000000000000000000000000000000000000000",
      "0x1234",
    ]);

    await expect(
      current.service.register(current.input),
    ).resolves.toMatchObject({
      business: { id: "business-1" },
      replayed: false,
    });
    expect(current.provider.send).toHaveBeenCalledWith("eth_call", [
      expect.objectContaining({ to: current.input.address }),
      "0x63",
    ]);
    expect(current.provider.getCode).toHaveBeenCalledWith(
      current.input.address,
      99,
    );
  });

  it.each([
    ["licenseNumber", "DMCC123457"],
    ["businessName", "Attacker Treasury"],
    ["jurisdiction", "INTERNATIONAL"],
    ["businessType", "PLC"],
    ["complianceOfficer", OTHER_OFFICER],
    ["contactEmail", "attacker@acme.test"],
    ["txHash", OTHER_TX_HASH],
  ])(
    "rejects a valid signature replay with altered %s",
    async (field, value) => {
      const current = await fixture();
      current.input[field] = value;
      await expectCode(current, "INVALID_REGISTRATION_CHALLENGE", 401);
      expect(current.provider.getNetwork).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      "missing",
      (current: Awaited<ReturnType<typeof fixture>>) =>
        current.prisma.walletChallenge.findUnique.mockResolvedValue(null),
    ],
    [
      "wrong purpose",
      (current: Awaited<ReturnType<typeof fixture>>) => {
        current.challenge.purpose = "AUTHENTICATION";
      },
    ],
    [
      "used",
      (current: Awaited<ReturnType<typeof fixture>>) => {
        current.challenge.usedAt = new Date();
      },
    ],
    [
      "expired",
      (current: Awaited<ReturnType<typeof fixture>>) => {
        current.challenge.expiresAt = new Date(Date.now() - 1);
      },
    ],
    [
      "wrong address",
      (current: Awaited<ReturnType<typeof fixture>>) => {
        current.challenge.address = OTHER_OFFICER;
      },
    ],
    [
      "wrong transaction",
      (current: Awaited<ReturnType<typeof fixture>>) => {
        current.challenge.transactionHash = OTHER_TX_HASH;
      },
    ],
    [
      "wrong relying party",
      (current: Awaited<ReturnType<typeof fixture>>) => {
        current.challenge.message = current.challenge.message.replace(
          "pay.aethelred.network",
          "evil.example",
        );
      },
    ],
    [
      "duplicate commitment",
      (current: Awaited<ReturnType<typeof fixture>>) => {
        current.challenge.message += `\n- urn:noblepay:registration-commitment:${current.registrationCommitment}`;
      },
    ],
  ])(
    "rejects a %s challenge before signature or chain verification",
    async (_label, mutate) => {
      const current = await fixture();
      (mutate as (value: Awaited<ReturnType<typeof fixture>>) => void)(current);
      await expectCode(current, "INVALID_REGISTRATION_CHALLENGE", 401);
      expect(current.provider.getNetwork).not.toHaveBeenCalled();
    },
  );

  it("rejects malformed and wrong-wallet signatures", async () => {
    const malformed = await fixture();
    malformed.input.signature = "0x1234";
    await expectCode(malformed, "INVALID_SIGNATURE", 401);

    const wrongWallet = await fixture();
    wrongWallet.input.signature = await Wallet.createRandom().signMessage(
      wrongWallet.challenge.message,
    );
    await expectCode(wrongWallet, "INVALID_SIGNATURE", 401);
  });

  it.each([
    [
      "missing RPC URL",
      () => {
        delete process.env.AETHELRED_RPC_URL;
      },
      "REGISTRATION_NOT_CONFIGURED",
    ],
    [
      "missing registry",
      () => {
        delete process.env.BUSINESS_REGISTRY_CONTRACT_ADDRESS;
      },
      "REGISTRATION_NOT_CONFIGURED",
    ],
    [
      "missing chain",
      () => {
        delete process.env.NOBLEPAY_CHAIN_ID;
      },
      "REGISTRATION_NOT_CONFIGURED",
    ],
    [
      "non-HTTP RPC",
      () => {
        process.env.AETHELRED_RPC_URL = "ftp://rpc.example";
      },
      "REGISTRATION_MISCONFIGURED",
    ],
    [
      "zero chain",
      () => {
        process.env.NOBLEPAY_CHAIN_ID = "0";
      },
      "REGISTRATION_MISCONFIGURED",
    ],
    [
      "zero registry",
      () => {
        process.env.BUSINESS_REGISTRY_CONTRACT_ADDRESS =
          "0x0000000000000000000000000000000000000000";
      },
      "REGISTRATION_MISCONFIGURED",
    ],
    [
      "fractional confirmations",
      () => {
        process.env.NOBLEPAY_MIN_CONFIRMATIONS = "1.5";
      },
      "REGISTRATION_MISCONFIGURED",
    ],
    [
      "zero confirmations",
      () => {
        process.env.NOBLEPAY_MIN_CONFIRMATIONS = "0";
      },
      "REGISTRATION_MISCONFIGURED",
    ],
  ])("fails closed for %s", async (_label, mutate, code) => {
    const current = await fixture();
    (mutate as () => void)();
    await expectCode(current, code as string, 503);
  });

  it("maps an RPC outage to a retryable error", async () => {
    const current = await fixture();
    current.provider.getNetwork.mockRejectedValue(
      new Error("rpc password should not escape"),
    );
    await expectCode(current, "CHAIN_RPC_UNAVAILABLE", 503);
  });

  it("does not consume the challenge or persist when receipt and transaction blocks diverge", async () => {
    const current = await fixture();
    current.transaction.blockHash = `0x${"de".repeat(32)}`;
    await expectCode(current, "TRANSACTION_CANONICAL_MISMATCH", 422);
    expect(current.prisma.$transaction).not.toHaveBeenCalled();
    expect(current.database.walletChallenge.updateMany).not.toHaveBeenCalled();
    expect(current.database.business.create).not.toHaveBeenCalled();
  });

  it("does not consume the challenge or persist when final confirmation depth falls below policy", async () => {
    const current = await fixture();
    current.receipt.confirmations
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(1);

    await expectCode(current, "INSUFFICIENT_CONFIRMATIONS", 409);

    expect(current.receipt.confirmations).toHaveBeenCalledTimes(3);
    expect(current.provider.call).toHaveBeenCalledTimes(1);
    expect(current.prisma.$transaction).not.toHaveBeenCalled();
    expect(current.database.walletChallenge.updateMany).not.toHaveBeenCalled();
    expect(current.database.business.create).not.toHaveBeenCalled();
  });

  it.each([
    [
      "chain mismatch",
      (current: Awaited<ReturnType<typeof fixture>>) =>
        current.provider.getNetwork.mockResolvedValue({ chainId: 1n }),
      "CHAIN_MISMATCH",
      503,
    ],
    [
      "same-chain-id network anchor mismatch",
      (current: Awaited<ReturnType<typeof fixture>>) =>
        current.provider.getBlock.mockImplementation(
          (blockTag: string | bigint) =>
            Promise.resolve(
              blockTag === 1n
                ? { number: 1, hash: `0x${"cd".repeat(32)}` }
                : {
                    number: 99,
                    hash: BLOCK_HASH,
                    timestamp: TIMESTAMP,
                  },
            ),
        ),
      "CHAIN_MISMATCH",
      503,
    ],
    [
      "missing receipt",
      (current: Awaited<ReturnType<typeof fixture>>) =>
        current.provider.getTransactionReceipt.mockResolvedValue(null),
      "TRANSACTION_NOT_MINED",
      409,
    ],
    [
      "missing transaction",
      (current: Awaited<ReturnType<typeof fixture>>) =>
        current.provider.getTransaction.mockResolvedValue(null),
      "TRANSACTION_NOT_MINED",
      409,
    ],
    [
      "receipt hash mismatch",
      (current: Awaited<ReturnType<typeof fixture>>) => {
        current.receipt.hash = OTHER_TX_HASH;
      },
      "TRANSACTION_HASH_MISMATCH",
      422,
    ],
    [
      "transaction hash mismatch",
      (current: Awaited<ReturnType<typeof fixture>>) => {
        current.transaction.hash = OTHER_TX_HASH;
      },
      "TRANSACTION_HASH_MISMATCH",
      422,
    ],
    [
      "revert",
      (current: Awaited<ReturnType<typeof fixture>>) => {
        current.receipt.status = 0;
      },
      "TRANSACTION_REVERTED",
      422,
    ],
    [
      "contract creation",
      (current: Awaited<ReturnType<typeof fixture>>) => {
        current.transaction.to = null;
      },
      "WRONG_REGISTRY_CONTRACT",
      422,
    ],
    [
      "wrong registry",
      (current: Awaited<ReturnType<typeof fixture>>) => {
        current.transaction.to = OTHER_REGISTRY;
      },
      "WRONG_REGISTRY_CONTRACT",
      422,
    ],
    [
      "wrong sender",
      (current: Awaited<ReturnType<typeof fixture>>) => {
        current.transaction.from = OTHER_OFFICER;
      },
      "REGISTRATION_SENDER_MISMATCH",
      403,
    ],
    [
      "native value",
      (current: Awaited<ReturnType<typeof fixture>>) => {
        current.transaction.value = 1n;
      },
      "UNEXPECTED_NATIVE_VALUE",
      422,
    ],
    [
      "too few confirmations",
      (current: Awaited<ReturnType<typeof fixture>>) =>
        current.receipt.confirmations.mockResolvedValue(1),
      "INSUFFICIENT_CONFIRMATIONS",
      409,
    ],
    [
      "malformed calldata",
      (current: Awaited<ReturnType<typeof fixture>>) => {
        current.transaction.data = "0x12345678";
      },
      "INVALID_REGISTRATION_CALL",
      422,
    ],
    [
      "wrong calldata method",
      (current: Awaited<ReturnType<typeof fixture>>) => {
        current.transaction.data = registry.encodeFunctionData(
          "getBusinessDetails",
          [current.input.address],
        );
      },
      "INVALID_REGISTRATION_CALL",
      422,
    ],
  ])("rejects %s", async (_label, mutate, code, statusCode) => {
    const current = await fixture();
    (mutate as (value: Awaited<ReturnType<typeof fixture>>) => void)(current);
    await expectCode(current, code as string, statusCode as number);
  });

  it.each([
    ["license", ["OTHER123", "Acme Treasury", 0, OFFICER]],
    ["name", ["DMCC123456", "Other Treasury", 0, OFFICER]],
    ["jurisdiction", ["DMCC123456", "Acme Treasury", 1, OFFICER]],
    ["officer", ["DMCC123456", "Acme Treasury", 0, OTHER_OFFICER]],
  ])("rejects a %s mismatch in registration calldata", async (_label, args) => {
    const current = await fixture();
    current.transaction.data = registry.encodeFunctionData(
      "registerBusiness",
      args as any[],
    );
    await expectCode(current, "REGISTRATION_CLAIM_MISMATCH", 422);
  });

  it("requires one exact canonical registration event", async () => {
    const cases: Array<(current: Awaited<ReturnType<typeof fixture>>) => void> =
      [
        (current) => {
          current.receipt.logs = [];
        },
        (current) => {
          current.receipt.logs[0].address = OTHER_REGISTRY;
        },
        (current) => {
          current.receipt.logs[0] = {
            address: REGISTRY,
            topics: ["0x1234"],
            data: "0x",
          };
        },
        (current) => {
          current.receipt.logs.push({ ...current.receipt.logs[0] });
        },
      ];
    for (const mutate of cases) {
      const current = await fixture();
      mutate(current);
      await expectCode(current, "REGISTRATION_EVENT_INVALID", 422);
    }
  });

  it.each([
    ["wallet", [OTHER_OFFICER, "DMCC123456", "Acme Treasury", 0]],
    ["license", [expect.anything(), "OTHER123", "Acme Treasury", 0]],
    ["name", [expect.anything(), "DMCC123456", "Other Treasury", 0]],
    ["jurisdiction", [expect.anything(), "DMCC123456", "Acme Treasury", 1]],
  ])("rejects a %s mismatch in the emitted event", async (label) => {
    const current = await fixture();
    const values =
      label === "wallet"
        ? [
            OTHER_OFFICER,
            current.input.licenseNumber,
            current.input.businessName,
            0,
          ]
        : label === "license"
          ? [current.input.address, "OTHER123", current.input.businessName, 0]
          : label === "name"
            ? [
                current.input.address,
                current.input.licenseNumber,
                "Other Treasury",
                0,
              ]
            : [
                current.input.address,
                current.input.licenseNumber,
                current.input.businessName,
                1,
              ];
    const encoded = registry.encodeEventLog(
      registry.getEvent("BusinessRegistered")!,
      values,
    );
    current.receipt.logs = [{ address: REGISTRY, ...encoded }];
    await expectCode(current, "REGISTRATION_EVENT_MISMATCH", 422);
  });

  it("fails closed when the confirmed block or pinned registry state is unavailable", async () => {
    const noBlock = await fixture();
    noBlock.provider.getBlock.mockImplementation(
      (blockTag: string | bigint | number) =>
        Promise.resolve(
          blockTag === 1n
            ? { number: 1, hash: `0x${"ab".repeat(32)}` }
            : blockTag === "latest" || blockTag === 100
              ? {
                  number: 100,
                  hash: `0x${"cc".repeat(32)}`,
                  timestamp: TIMESTAMP + 1,
                }
              : null,
        ),
    );
    await expectCode(noBlock, "BLOCK_NOT_FOUND", 503);

    const noState = await fixture();
    noState.provider.call.mockRejectedValue(
      new Error("archive state unavailable"),
    );
    await expectCode(noState, "REGISTRATION_STATE_UNAVAILABLE", 503);
  });

  it.each([
    [
      "wallet",
      (state: any[]) => {
        state[0] = OTHER_OFFICER;
      },
    ],
    [
      "license",
      (state: any[]) => {
        state[1] = "OTHER123";
      },
    ],
    [
      "name",
      (state: any[]) => {
        state[2] = "Other Treasury";
      },
    ],
    [
      "jurisdiction",
      (state: any[]) => {
        state[3] = 1;
      },
    ],
    [
      "kyc",
      (state: any[]) => {
        state[4] = 1;
      },
    ],
    [
      "tier",
      (state: any[]) => {
        state[5] = 1;
      },
    ],
    [
      "registered timestamp",
      (state: any[]) => {
        state[6] = TIMESTAMP - 1;
      },
    ],
    [
      "last verified",
      (state: any[]) => {
        state[7] = 1;
      },
    ],
    [
      "officer",
      (state: any[]) => {
        state[8] = OTHER_OFFICER;
      },
    ],
  ])(
    "rejects a %s mismatch in pinned registry state",
    async (_label, mutate) => {
      const current = await fixture();
      const state: any[] = [
        current.input.address,
        current.input.licenseNumber,
        current.input.businessName,
        0,
        0,
        0,
        TIMESTAMP,
        0,
        current.input.complianceOfficer,
      ];
      (mutate as (stateValue: any[]) => void)(state);
      current.provider.call.mockResolvedValue(
        registry.encodeFunctionResult("getBusinessDetails", [state]),
      );
      await expectCode(current, "REGISTRATION_STATE_MISMATCH", 422);
    },
  );

  it("atomically rejects challenge-consumption races", async () => {
    const current = await fixture();
    current.database.walletChallenge.updateMany.mockResolvedValue({ count: 0 });
    await expectCode(current, "REGISTRATION_CHALLENGE_ALREADY_USED", 409);
    expect(current.database.business.create).not.toHaveBeenCalled();
  });

  it("allows an exact signed retry while rotating only the registration-issued API key", async () => {
    const current = await fixture();
    current.database.business.findFirst.mockResolvedValue(
      current.persistedBusiness,
    );
    const result = await current.service.register(current.input);
    expect(result.replayed).toBe(true);
    expect(current.database.aPIKey.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          businessId: "business-1",
          status: "ACTIVE",
        }),
        data: expect.objectContaining({ status: "REVOKED" }),
      }),
    );
    expect(current.database.business.create).not.toHaveBeenCalled();
    expect(current.audit.createAuditEntryInTransaction).toHaveBeenCalledWith(
      current.database,
      expect.objectContaining({
        eventType: "API_KEY_CREATED",
        metadata: { reason: "registration-retry" },
      }),
    );
  });

  it("rejects a transaction replay associated with a different off-chain profile", async () => {
    const current = await fixture();
    current.database.business.findFirst.mockResolvedValue({
      ...current.persistedBusiness,
      contactEmail: "different@acme.test",
    });
    await expectCode(current, "REGISTRATION_CONFLICT", 409);
    expect(current.database.aPIKey.create).not.toHaveBeenCalled();
  });

  it("supports the canonical international jurisdiction", async () => {
    const current = await fixture({ jurisdiction: "INTERNATIONAL" });
    await expect(
      current.service.register(current.input),
    ).resolves.toMatchObject({ replayed: false });
    expect(current.database.business.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ jurisdiction: "INTERNATIONAL" }),
      }),
    );
  });

  it("retries serializable conflicts twice but never hides a third conflict or unrelated error", async () => {
    const current = await fixture();
    const retryable = new Prisma.PrismaClientKnownRequestError(
      "serialization failure",
      {
        code: "P2034",
        clientVersion: "5.8.1",
      },
    );
    const succeeds = jest
      .fn()
      .mockRejectedValueOnce(retryable)
      .mockRejectedValueOnce(retryable)
      .mockResolvedValueOnce("ok");
    await expect(
      (current.service as any).withSerializableRetry(succeeds),
    ).resolves.toBe("ok");
    expect(succeeds).toHaveBeenCalledTimes(3);

    await expect(
      (current.service as any).withSerializableRetry(
        jest.fn().mockRejectedValue(new Error("fatal")),
      ),
    ).rejects.toThrow("fatal");
    await expect(
      (current.service as any).withSerializableRetry(
        jest.fn().mockRejectedValue(retryable),
      ),
    ).rejects.toMatchObject({ code: "P2034" });
  });

  it("exposes stable registration error metadata", () => {
    expect(new BusinessRegistrationError("CODE", "message", 409)).toMatchObject(
      {
        name: "BusinessRegistrationError",
        code: "CODE",
        statusCode: 409,
      },
    );
  });
});
