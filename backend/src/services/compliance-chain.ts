import {
  Interface,
  JsonRpcProvider,
  getAddress,
  keccak256,
  toUtf8Bytes,
} from "ethers";
import {
  ConfigurationError,
  loadNoblePayChainConfiguration,
  NoblePayChainConfiguration,
  noblePayNetworkIdentityMatches,
} from "../lib/production-config";
import {
  assertCanonicalChainSnapshot,
  CanonicalTransactionError,
  getCanonicalTransaction,
} from "../lib/canonical-chain-transaction";

const COMPLIANCE_INTERFACE = new Interface([
  "function submitComplianceResult(bytes32 _paymentId,bool _sanctionsClear,uint8 _amlRiskScore,bool _travelRuleOk,bytes32 _investigationHash,bytes _attestation)",
  "function hasRole(bytes32 role,address account) view returns (bool)",
  "event PaymentCleared(bytes32 indexed paymentId,uint8 amlRiskScore)",
  "event PaymentFlagged(bytes32 indexed paymentId,uint8 amlRiskScore,bytes32 investigationHash)",
  "event PaymentBlocked(bytes32 indexed paymentId,bytes32 investigationHash)",
]);
const TEE_NODE_ROLE = keccak256(toUtf8Bytes("TEE_NODE_ROLE"));

export interface ExpectedComplianceSubmission {
  txHash: string;
  paymentId: string;
  sanctionsClear: boolean;
  amlRiskScore: number;
  travelRuleCompliant: boolean;
  investigationHash: string;
  attestation: string;
}

export interface VerifiedComplianceSubmission {
  txHash: string;
  blockNumber: bigint;
  confirmations: number;
  signer: string;
  disposition: "PASSED" | "UNDER_REVIEW" | "FAILED";
}

export interface ComplianceSubmissionVerifier {
  verify(
    input: ExpectedComplianceSubmission,
  ): Promise<VerifiedComplianceSubmission>;
}

function normalizedHex(value: string, bytes?: number): string {
  const prefixed = value.startsWith("0x") ? value : `0x${value}`;
  const expected = bytes ? bytes * 2 : undefined;
  if (
    !/^0x(?:[a-fA-F0-9]{2})+$/.test(prefixed) ||
    (expected && prefixed.length !== expected + 2)
  ) {
    throw new ComplianceVerificationError(
      "INVALID_COMPLIANCE_EVIDENCE",
      "Compliance evidence is not valid hex data",
    );
  }
  return prefixed.toLowerCase();
}

export class EthersComplianceSubmissionVerifier implements ComplianceSubmissionVerifier {
  private provider: JsonRpcProvider | null;

  constructor(
    provider?: JsonRpcProvider,
    private readonly configurationLoader: () => NoblePayChainConfiguration = loadNoblePayChainConfiguration,
  ) {
    this.provider = provider || null;
  }

  async verify(
    input: ExpectedComplianceSubmission,
  ): Promise<VerifiedComplianceSubmission> {
    let config: NoblePayChainConfiguration;
    try {
      config = this.configurationLoader();
    } catch (error) {
      const message =
        error instanceof ConfigurationError
          ? error.message
          : "Invalid chain configuration";
      throw new ComplianceVerificationError(
        "CHAIN_MISCONFIGURED",
        message,
        503,
      );
    }
    if (!/^0x[a-fA-F0-9]{64}$/.test(input.txHash)) {
      throw new ComplianceVerificationError(
        "INVALID_SUBMISSION_TX",
        "Compliance submission transaction hash is invalid",
      );
    }
    if (!/^0x[a-fA-F0-9]{64}$/.test(input.paymentId)) {
      throw new ComplianceVerificationError(
        "INVALID_PAYMENT_ID",
        "On-chain payment ID is invalid",
      );
    }
    if (
      !Number.isInteger(input.amlRiskScore) ||
      input.amlRiskScore < 0 ||
      input.amlRiskScore > 100
    ) {
      throw new ComplianceVerificationError(
        "INVALID_COMPLIANCE_RESULT",
        "AML risk score is outside 0-100",
      );
    }
    const investigationHash = normalizedHex(input.investigationHash, 32);
    const attestation = normalizedHex(input.attestation);
    if (attestation === "0x") {
      throw new ComplianceVerificationError(
        "INVALID_COMPLIANCE_EVIDENCE",
        "TEE attestation must not be empty",
      );
    }

    const provider =
      this.provider || (this.provider = new JsonRpcProvider(config.rpcUrl));
    let network;
    let anchorBlock;
    try {
      [network, anchorBlock] = await Promise.all([
        provider.getNetwork(),
        provider.getBlock(config.networkAnchorBlock),
      ]);
    } catch {
      throw new ComplianceVerificationError(
        "CHAIN_RPC_UNAVAILABLE",
        "Unable to verify the compliance submission with the configured chain",
        503,
      );
    }
    if (!noblePayNetworkIdentityMatches(config, network, anchorBlock)) {
      throw new ComplianceVerificationError(
        "CHAIN_MISMATCH",
        "Configured RPC returned an unexpected chain",
        503,
      );
    }

    let canonical;
    try {
      canonical = await getCanonicalTransaction(
        provider,
        input.txHash,
        config.minimumConfirmations,
      );
    } catch (error) {
      if (!(error instanceof CanonicalTransactionError)) throw error;
      switch (error.reason) {
        case "NOT_MINED":
          throw new ComplianceVerificationError(
            "SUBMISSION_NOT_MINED",
            "Compliance submission has not been mined",
            409,
          );
        case "HASH_MISMATCH":
          throw new ComplianceVerificationError(
            "SUBMISSION_HASH_MISMATCH",
            "RPC returned a different transaction",
            422,
          );
        case "REVERTED":
          throw new ComplianceVerificationError(
            "SUBMISSION_REVERTED",
            "Compliance submission reverted on-chain",
            422,
          );
        case "INSUFFICIENT_CONFIRMATIONS":
          throw new ComplianceVerificationError(
            "INSUFFICIENT_CONFIRMATIONS",
            `Compliance submission requires ${config.minimumConfirmations} confirmations`,
            409,
          );
        case "CANONICAL_MISMATCH":
          throw new ComplianceVerificationError(
            "SUBMISSION_CANONICAL_MISMATCH",
            "Compliance submission receipt is not in the canonical chain",
            422,
          );
        case "BLOCK_NOT_FOUND":
        case "RPC_UNAVAILABLE":
          throw new ComplianceVerificationError(
            "CHAIN_RPC_UNAVAILABLE",
            "Unable to verify the compliance submission with the configured chain",
            503,
          );
      }
    }
    const { receipt, transaction, confirmations } = canonical;
    if (
      !transaction.to ||
      getAddress(transaction.to) !== config.contractAddress
    ) {
      throw new ComplianceVerificationError(
        "WRONG_CONTRACT",
        "Compliance result was not submitted directly to NoblePay",
        422,
      );
    }
    if (transaction.value !== 0n) {
      throw new ComplianceVerificationError(
        "INVALID_SUBMISSION_VALUE",
        "Compliance submission must not transfer value",
        422,
      );
    }

    let decoded;
    try {
      decoded = COMPLIANCE_INTERFACE.parseTransaction({
        data: transaction.data,
        value: transaction.value,
      });
    } catch {
      decoded = null;
    }
    if (!decoded || decoded.name !== "submitComplianceResult") {
      throw new ComplianceVerificationError(
        "INVALID_COMPLIANCE_CALL",
        "Transaction is not submitComplianceResult",
        422,
      );
    }
    const decodedPaymentId = String(decoded.args[0]).toLowerCase();
    const decodedSanctions = Boolean(decoded.args[1]);
    const decodedRisk = Number(decoded.args[2]);
    const decodedTravelRule = Boolean(decoded.args[3]);
    const decodedInvestigationHash = String(decoded.args[4]).toLowerCase();
    const decodedAttestation = String(decoded.args[5]).toLowerCase();
    if (
      decodedPaymentId !== input.paymentId.toLowerCase() ||
      decodedSanctions !== input.sanctionsClear ||
      decodedRisk !== input.amlRiskScore ||
      decodedTravelRule !== input.travelRuleCompliant ||
      decodedInvestigationHash !== investigationHash ||
      decodedAttestation !== attestation
    ) {
      throw new ComplianceVerificationError(
        "COMPLIANCE_RESULT_MISMATCH",
        "On-chain compliance calldata does not match the service result",
        422,
      );
    }

    const roleCall = COMPLIANCE_INTERFACE.encodeFunctionData("hasRole", [
      TEE_NODE_ROLE,
      transaction.from,
    ]);
    try {
      const rawRole = await provider.call({
        to: config.contractAddress,
        data: roleCall,
        blockTag: receipt.blockNumber,
      });
      const [authorized] = COMPLIANCE_INTERFACE.decodeFunctionResult(
        "hasRole",
        rawRole,
      );
      if (authorized !== true) throw new Error("unauthorized");
    } catch {
      throw new ComplianceVerificationError(
        "UNAUTHORIZED_COMPLIANCE_SIGNER",
        "Compliance transaction signer did not hold TEE_NODE_ROLE at the confirmed block",
        422,
      );
    }

    const disposition: VerifiedComplianceSubmission["disposition"] =
      !input.sanctionsClear
        ? "FAILED"
        : input.amlRiskScore > 70 || !input.travelRuleCompliant
          ? "UNDER_REVIEW"
          : "PASSED";
    const expectedEvent =
      disposition === "PASSED"
        ? "PaymentCleared"
        : disposition === "UNDER_REVIEW"
          ? "PaymentFlagged"
          : "PaymentBlocked";
    const matchingEvents = receipt.logs.flatMap((log) => {
      let address: string;
      try {
        address = getAddress(log.address);
      } catch {
        return [];
      }
      if (address !== config.contractAddress) return [];
      try {
        const parsed = COMPLIANCE_INTERFACE.parseLog({
          topics: [...log.topics],
          data: log.data,
        });
        if (
          !parsed ||
          parsed.name !== expectedEvent ||
          String(parsed.args[0]).toLowerCase() !== input.paymentId.toLowerCase()
        ) {
          return [];
        }
        if (
          expectedEvent === "PaymentCleared" ||
          expectedEvent === "PaymentFlagged"
        ) {
          if (Number(parsed.args[1]) !== input.amlRiskScore) return [];
        }
        if (
          expectedEvent === "PaymentFlagged" &&
          String(parsed.args[2]).toLowerCase() !== investigationHash
        )
          return [];
        if (
          expectedEvent === "PaymentBlocked" &&
          String(parsed.args[1]).toLowerCase() !== investigationHash
        )
          return [];
        return [parsed];
      } catch {
        return [];
      }
    });
    if (matchingEvents.length !== 1) {
      throw new ComplianceVerificationError(
        "COMPLIANCE_EVENT_MISMATCH",
        "Receipt does not contain exactly one matching NoblePay compliance event",
        422,
      );
    }

    try {
      await assertCanonicalChainSnapshot(
        provider,
        config,
        receipt.blockNumber,
        receipt.blockHash,
        input.txHash,
        config.minimumConfirmations,
      );
    } catch (error) {
      if (
        error instanceof CanonicalTransactionError &&
        error.reason === "INSUFFICIENT_CONFIRMATIONS"
      ) {
        throw new ComplianceVerificationError(
          "INSUFFICIENT_CONFIRMATIONS",
          `Compliance submission requires ${config.minimumConfirmations} confirmations`,
          409,
        );
      }
      if (
        error instanceof CanonicalTransactionError &&
        error.reason === "RPC_UNAVAILABLE"
      ) {
        throw new ComplianceVerificationError(
          "CHAIN_RPC_UNAVAILABLE",
          "Unable to perform the final compliance chain identity check",
          503,
        );
      }
      throw new ComplianceVerificationError(
        "SUBMISSION_CANONICAL_MISMATCH",
        "Compliance evidence changed before it could be accepted",
        422,
      );
    }

    return {
      txHash: input.txHash.toLowerCase(),
      blockNumber: BigInt(receipt.blockNumber),
      confirmations,
      signer: getAddress(transaction.from),
      disposition,
    };
  }
}

export class ComplianceVerificationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode = 422,
  ) {
    super(message);
    this.name = "ComplianceVerificationError";
  }
}
