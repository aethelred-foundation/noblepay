import { Interface, JsonRpcProvider, getAddress } from "ethers";

const SAFE_EXECUTION_INTERFACE = new Interface([
  "function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) payable returns (bool success)",
]);

export interface CanonicalExecutionTransaction {
  to: string | null;
  from: string;
  data: string;
  value: bigint;
}

export interface CanonicalContractExecution {
  actor: string;
  callData: string;
  kind: "EOA_DIRECT" | "SAFE_CALL";
}

/**
 * Classify an already-canonical transaction as either a strict EOA call to the
 * target or a strict top-level Safe execution by the expected contract wallet.
 * Arbitrary relays, modules, delegatecalls, value transfers and wrong inner
 * targets are rejected.
 */
export async function resolveCanonicalContractExecution(input: {
  provider: JsonRpcProvider;
  transaction: CanonicalExecutionTransaction;
  blockNumber: number;
  targetContract: string;
  expectedActor?: string;
}): Promise<CanonicalContractExecution> {
  const target = getAddress(input.targetContract);
  const expectedActor = input.expectedActor
    ? getAddress(input.expectedActor)
    : null;
  if (!input.transaction.to || input.transaction.value !== 0n) {
    throw new CanonicalContractExecutionError(
      "Canonical contract execution must be a zero-value transaction",
    );
  }

  const topLevelTarget = getAddress(input.transaction.to);
  if (topLevelTarget === target) {
    const actor = getAddress(input.transaction.from);
    if (expectedActor && actor !== expectedActor) {
      throw new CanonicalContractExecutionError(
        "Direct transaction sender does not match the expected actor",
      );
    }
    return {
      actor,
      callData: input.transaction.data,
      kind: "EOA_DIRECT",
    };
  }

  const actor = topLevelTarget;
  if (expectedActor && actor !== expectedActor) {
    throw new CanonicalContractExecutionError(
      "Contract-wallet transaction target does not match the expected actor",
    );
  }
  let code: string;
  try {
    code = await input.provider.getCode(actor, input.blockNumber);
  } catch (error) {
    throw new CanonicalContractExecutionError(
      "Unable to verify contract-wallet bytecode at the canonical block",
      error,
    );
  }
  if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(code)) {
    throw new CanonicalContractExecutionError(
      "Indirect execution requires a deployed contract wallet",
    );
  }

  let safeCall;
  try {
    safeCall = SAFE_EXECUTION_INTERFACE.parseTransaction({
      data: input.transaction.data,
      value: input.transaction.value,
    });
  } catch {
    safeCall = null;
  }
  if (
    !safeCall ||
    safeCall.name !== "execTransaction" ||
    getAddress(safeCall.args.to as string) !== target ||
    BigInt(safeCall.args.value) !== 0n ||
    Number(safeCall.args.operation) !== 0
  ) {
    throw new CanonicalContractExecutionError(
      "Contract wallet must execute a zero-value Safe CALL to the intended contract",
    );
  }
  return {
    actor,
    callData: safeCall.args.data as string,
    kind: "SAFE_CALL",
  };
}

export class CanonicalContractExecutionError extends Error {
  constructor(message: string, options?: unknown) {
    super(message);
    this.name = "CanonicalContractExecutionError";
    if (options !== undefined)
      (this as Error & { cause?: unknown }).cause = options;
  }
}
