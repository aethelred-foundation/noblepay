import { Interface } from "ethers";
import {
  CanonicalContractExecutionError,
  resolveCanonicalContractExecution,
} from "../../lib/canonical-contract-execution";

const TARGET = "0x1111111111111111111111111111111111111111";
const SAFE = "0x2222222222222222222222222222222222222222";
const RELAYER = "0x3333333333333333333333333333333333333333";
const OTHER = "0x4444444444444444444444444444444444444444";
const CALL_DATA = "0x12345678";

const safeInterface = new Interface([
  "function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) payable returns (bool success)",
]);

function safeData(
  overrides: {
    to?: string;
    value?: bigint;
    operation?: number;
    data?: string;
  } = {},
) {
  return safeInterface.encodeFunctionData("execTransaction", [
    overrides.to || TARGET,
    overrides.value || 0n,
    overrides.data || CALL_DATA,
    overrides.operation || 0,
    0n,
    0n,
    0n,
    "0x0000000000000000000000000000000000000000",
    "0x0000000000000000000000000000000000000000",
    "0x1234",
  ]);
}

describe("resolveCanonicalContractExecution", () => {
  const provider: any = {
    getCode: jest.fn().mockResolvedValue("0x6001600055"),
  };

  beforeEach(() => jest.clearAllMocks());

  it("accepts an exact zero-value direct EOA call", async () => {
    await expect(
      resolveCanonicalContractExecution({
        provider,
        blockNumber: 99,
        targetContract: TARGET,
        expectedActor: RELAYER,
        transaction: {
          to: TARGET,
          from: RELAYER,
          data: CALL_DATA,
          value: 0n,
        },
      }),
    ).resolves.toEqual({
      actor: RELAYER,
      callData: CALL_DATA,
      kind: "EOA_DIRECT",
    });
    expect(provider.getCode).not.toHaveBeenCalled();
  });

  it("accepts a standard Safe CALL and attributes it to the Safe", async () => {
    await expect(
      resolveCanonicalContractExecution({
        provider,
        blockNumber: 99,
        targetContract: TARGET,
        expectedActor: SAFE,
        transaction: {
          to: SAFE,
          from: RELAYER,
          data: safeData(),
          value: 0n,
        },
      }),
    ).resolves.toEqual({
      actor: SAFE,
      callData: CALL_DATA,
      kind: "SAFE_CALL",
    });
    expect(provider.getCode).toHaveBeenCalledWith(SAFE, 99);
  });

  it.each([
    ["top-level native value", { transactionValue: 1n }],
    ["wrong expected Safe", { expectedActor: OTHER }],
    ["wrong inner target", { to: OTHER }],
    ["inner native value", { value: 1n }],
    ["delegatecall", { operation: 1 }],
  ])("rejects %s", async (_label, mutation) => {
    const value = mutation as {
      transactionValue?: bigint;
      expectedActor?: string;
      to?: string;
      value?: bigint;
      operation?: number;
    };
    await expect(
      resolveCanonicalContractExecution({
        provider,
        blockNumber: 99,
        targetContract: TARGET,
        expectedActor: value.expectedActor || SAFE,
        transaction: {
          to: SAFE,
          from: RELAYER,
          data: safeData(value),
          value: value.transactionValue || 0n,
        },
      }),
    ).rejects.toBeInstanceOf(CanonicalContractExecutionError);
  });

  it("rejects an undeployed indirect actor and an EOA actor mismatch", async () => {
    provider.getCode.mockResolvedValueOnce("0x");
    await expect(
      resolveCanonicalContractExecution({
        provider,
        blockNumber: 99,
        targetContract: TARGET,
        expectedActor: SAFE,
        transaction: {
          to: SAFE,
          from: RELAYER,
          data: safeData(),
          value: 0n,
        },
      }),
    ).rejects.toBeInstanceOf(CanonicalContractExecutionError);

    await expect(
      resolveCanonicalContractExecution({
        provider,
        blockNumber: 99,
        targetContract: TARGET,
        expectedActor: SAFE,
        transaction: {
          to: TARGET,
          from: RELAYER,
          data: CALL_DATA,
          value: 0n,
        },
      }),
    ).rejects.toBeInstanceOf(CanonicalContractExecutionError);
  });
});
