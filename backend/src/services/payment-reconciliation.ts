import {
  Interface,
  JsonRpcProvider,
  formatUnits,
  getAddress,
  toUtf8String,
} from "ethers";
import { Payment, Prisma, PrismaClient } from "@prisma/client";
import { logger } from "../lib/logger";
import { paymentAmount, paymentTotal } from "../lib/metrics";
import {
  assertCanonicalChainSnapshot,
  CanonicalTransactionError,
  getCanonicalTransaction,
} from "../lib/canonical-chain-transaction";
import {
  CanonicalContractExecutionError,
  resolveCanonicalContractExecution,
} from "../lib/canonical-contract-execution";
import { AuditService } from "./audit";
import { PaymentError } from "./payment";
import {
  loadNoblePayChainConfiguration,
  noblePayNetworkIdentityMatches,
} from "../lib/production-config";

const PAYMENT_INTERFACE = new Interface([
  "function initiatePayment(address _recipient,uint256 _amount,address _token,bytes32 _purposeHash,bytes3 _currencyCode) payable returns (bytes32 paymentId)",
  "function initiatePaymentBatch(address[] _recipients,uint256[] _amounts,address[] _tokens,bytes32[] _purposeHashes,bytes3[] _currencyCodes) payable returns (bytes32 batchId)",
  "function settlePayment(bytes32 _paymentId)",
  "function cancelPayment(bytes32 _paymentId)",
  "function refundPayment(bytes32 _paymentId)",
  "function executeSettlementRecovery(bytes32 _paymentId)",
  "function getPayment(bytes32 _paymentId) view returns ((address sender,address recipient,uint256 amount,address token,bytes32 purposeHash,uint8 status,bytes teeAttestation,uint256 createdAt,uint256 settledAt,bytes3 currencyCode))",
  "function batches(bytes32 _batchId) view returns (bytes32 batchId,address initiator,uint256 totalAmount,uint256 createdAt,bool processed)",
  "function getBatchPaymentIds(bytes32 _batchId) view returns (bytes32[] paymentIds)",
  "event PaymentInitiated(bytes32 indexed paymentId,address indexed sender,address indexed recipient,uint256 amount,address token,bytes3 currencyCode)",
  "event BatchProcessed(bytes32 indexed batchId,uint256 paymentCount,uint256 totalAmount)",
  "event PaymentSettled(bytes32 indexed paymentId,uint256 settledAt,uint256 feeCollected)",
  "event PaymentRefunded(bytes32 indexed paymentId,uint256 refundedAt)",
  "event SettlementRecoveryExecuted(bytes32 indexed paymentId,address indexed executedBy,uint256 refundedAt)",
]);

interface TokenConfiguration {
  currency: string;
  currencyCode: string;
  decimals: number;
}

interface ReconciliationConfiguration {
  rpcUrl: string;
  chainId: bigint;
  networkAnchorBlock: bigint;
  networkAnchorHash: string;
  contractAddress: string;
  minimumConfirmations: number;
  tokens: Map<string, TokenConfiguration>;
}

export interface ReconcilePaymentInput {
  txHash: string;
  paymentId?: string;
  recipient: string;
  amount: string;
  currency: string;
  purposeHash: string;
}

export interface ReconciledPaymentResult {
  payment: Payment;
  replayed: boolean;
  confirmations: number;
  chainId: string;
}

export type PaymentLifecycleAction = "settle" | "cancel" | "refund";
export type PaymentLifecycleMethod =
  | "settlePayment"
  | "cancelPayment"
  | "refundPayment"
  | "executeSettlementRecovery";

export interface ReconciledLifecycleResult extends ReconciledPaymentResult {
  action: PaymentLifecycleAction;
  method: PaymentLifecycleMethod;
  txHash: string;
}

export class PaymentReconciliationService {
  private provider: JsonRpcProvider | null = null;

  constructor(
    private prisma: PrismaClient,
    private auditService: AuditService,
    provider?: JsonRpcProvider,
  ) {
    this.provider = provider || null;
  }

  async reconcile(
    input: ReconcilePaymentInput,
    businessId: string,
  ): Promise<ReconciledPaymentResult> {
    const config = this.loadConfiguration();
    const provider =
      this.provider || (this.provider = new JsonRpcProvider(config.rpcUrl));

    let network;
    let anchorBlock;
    try {
      [network, anchorBlock] = await Promise.all([
        provider.getNetwork(),
        provider.getBlock(config.networkAnchorBlock),
      ]);
    } catch (error) {
      logger.error("Payment reconciliation RPC request failed", {
        error: (error as Error).message,
      });
      throw new PaymentError(
        "CHAIN_RPC_UNAVAILABLE",
        "Unable to verify the transaction with the configured chain RPC",
        503,
      );
    }

    if (!noblePayNetworkIdentityMatches(config, network, anchorBlock)) {
      throw new PaymentError(
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
          throw new PaymentError(
            "TRANSACTION_NOT_MINED",
            "Transaction is unknown or has not been mined",
            409,
          );
        case "HASH_MISMATCH":
          throw new PaymentError(
            "TRANSACTION_HASH_MISMATCH",
            "RPC returned a different transaction",
            422,
          );
        case "REVERTED":
          throw new PaymentError(
            "TRANSACTION_REVERTED",
            "Transaction reverted on-chain",
            422,
          );
        case "INSUFFICIENT_CONFIRMATIONS":
          throw new PaymentError(
            "INSUFFICIENT_CONFIRMATIONS",
            `Transaction requires ${config.minimumConfirmations} confirmations`,
            409,
          );
        case "CANONICAL_MISMATCH":
          throw new PaymentError(
            "TRANSACTION_CANONICAL_MISMATCH",
            "Payment receipt is not in the canonical chain",
            422,
          );
        case "BLOCK_NOT_FOUND":
          throw new PaymentError(
            "BLOCK_NOT_FOUND",
            "Unable to verify transaction block",
            503,
          );
        case "RPC_UNAVAILABLE":
          throw new PaymentError(
            "CHAIN_RPC_UNAVAILABLE",
            "Unable to verify the transaction with the configured chain RPC",
            503,
          );
      }
    }
    const { receipt, transaction, block, confirmations } = canonical;
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
    });
    if (!business)
      throw new PaymentError("BUSINESS_NOT_FOUND", "Business not found", 404);
    if (business.kycStatus !== "VERIFIED") {
      throw new PaymentError("KYC_REQUIRED", "Business must be verified", 403);
    }
    let execution;
    try {
      execution = await resolveCanonicalContractExecution({
        provider,
        transaction,
        blockNumber: receipt.blockNumber,
        targetContract: config.contractAddress,
        expectedActor: business.address,
      });
    } catch (error) {
      if (!(error instanceof CanonicalContractExecutionError)) throw error;
      throw new PaymentError("INVALID_PAYMENT_EXECUTION", error.message, 422);
    }

    let submittedCall;
    try {
      submittedCall = PAYMENT_INTERFACE.parseTransaction({
        data: execution.callData,
        value: 0n,
      });
    } catch {
      submittedCall = null;
    }
    if (
      !submittedCall ||
      !["initiatePayment", "initiatePaymentBatch"].includes(submittedCall.name)
    ) {
      throw new PaymentError(
        "INVALID_PAYMENT_CALL",
        "Transaction calldata is not a supported NoblePay payment initiation",
        422,
      );
    }
    const isBatch = submittedCall.name === "initiatePaymentBatch";

    const events = receipt.logs.flatMap((log) => {
      if (getAddress(log.address) !== config.contractAddress) return [];
      try {
        const parsed = PAYMENT_INTERFACE.parseLog({
          topics: [...log.topics],
          data: log.data,
        });
        if (!parsed || parsed.name !== "PaymentInitiated") return [];
        return [
          {
            paymentId: parsed.args.paymentId as string,
            sender: getAddress(parsed.args.sender as string),
            recipient: getAddress(parsed.args.recipient as string),
            amount: parsed.args.amount as bigint,
            token: getAddress(parsed.args.token as string),
            currencyCode: this.decodeCurrencyCode(
              parsed.args.currencyCode as string,
            ),
          },
        ];
      } catch {
        return [];
      }
    });

    if (events.length === 0) {
      throw new PaymentError(
        "PAYMENT_EVENT_NOT_FOUND",
        "Receipt does not contain the requested NoblePay PaymentInitiated event",
        422,
      );
    }
    let event = events[0];
    let callPurposeHash: string;
    let batchId: string | null = null;
    if (!isBatch) {
      if (events.length !== 1) {
        throw new PaymentError(
          "AMBIGUOUS_PAYMENT_EVENT",
          "A single-payment transaction must emit exactly one PaymentInitiated event",
          422,
        );
      }
      if (
        input.paymentId &&
        input.paymentId.toLowerCase() !== event.paymentId.toLowerCase()
      ) {
        throw new PaymentError(
          "PAYMENT_CLAIM_MISMATCH",
          "Submitted payment identifier does not match the verified on-chain transaction",
          422,
        );
      }
      const callRecipient = getAddress(submittedCall.args._recipient as string);
      const callAmount = submittedCall.args._amount as bigint;
      const callToken = getAddress(submittedCall.args._token as string);
      callPurposeHash = (
        submittedCall.args._purposeHash as string
      ).toLowerCase();
      const callCurrencyCode = this.decodeCurrencyCode(
        submittedCall.args._currencyCode as string,
      );
      if (
        callRecipient !== event.recipient ||
        callAmount !== event.amount ||
        callToken !== event.token ||
        callCurrencyCode !== event.currencyCode
      ) {
        throw new PaymentError(
          "PAYMENT_EVENT_MISMATCH",
          "Payment event does not match the submitted contract call",
          422,
        );
      }
    } else {
      if (!input.paymentId) {
        throw new PaymentError(
          "BATCH_PAYMENT_ID_REQUIRED",
          "A batch reconciliation must identify the individual paymentId",
          422,
        );
      }
      const recipients = submittedCall.args._recipients as readonly string[];
      const amounts = submittedCall.args._amounts as readonly bigint[];
      const tokens = submittedCall.args._tokens as readonly string[];
      const purposeHashes = submittedCall.args
        ._purposeHashes as readonly string[];
      const currencyCodes = submittedCall.args
        ._currencyCodes as readonly string[];
      const count = recipients.length;
      if (
        count === 0 ||
        amounts.length !== count ||
        tokens.length !== count ||
        purposeHashes.length !== count ||
        currencyCodes.length !== count ||
        events.length !== count
      ) {
        throw new PaymentError(
          "BATCH_EVENT_MISMATCH",
          "Batch calldata and PaymentInitiated event counts do not match",
          422,
        );
      }
      for (let index = 0; index < count; index += 1) {
        const candidate = events[index];
        if (
          candidate.sender !== getAddress(business.address) ||
          getAddress(recipients[index]) !== candidate.recipient ||
          amounts[index] !== candidate.amount ||
          getAddress(tokens[index]) !== candidate.token ||
          this.decodeCurrencyCode(currencyCodes[index]) !==
            candidate.currencyCode
        ) {
          throw new PaymentError(
            "BATCH_EVENT_MISMATCH",
            "A batch PaymentInitiated event does not match its calldata entry",
            422,
          );
        }
      }
      if (
        new Set(events.map((candidate) => candidate.paymentId.toLowerCase()))
          .size !== count
      ) {
        throw new PaymentError(
          "BATCH_EVENT_MISMATCH",
          "Batch payment identifiers are not unique",
          422,
        );
      }
      const selectedIndex = events.findIndex(
        (candidate) =>
          candidate.paymentId.toLowerCase() === input.paymentId!.toLowerCase(),
      );
      if (selectedIndex < 0) {
        throw new PaymentError(
          "BATCH_PAYMENT_NOT_FOUND",
          "The requested paymentId was not created by this batch transaction",
          422,
        );
      }
      event = events[selectedIndex];
      callPurposeHash = purposeHashes[selectedIndex].toLowerCase();

      const batchEvents = receipt.logs.flatMap((log) => {
        if (getAddress(log.address) !== config.contractAddress) return [];
        try {
          const parsed = PAYMENT_INTERFACE.parseLog({
            topics: [...log.topics],
            data: log.data,
          });
          return parsed?.name === "BatchProcessed" ? [parsed] : [];
        } catch {
          return [];
        }
      });
      const expectedTotal = amounts.reduce((sum, amount) => sum + amount, 0n);
      if (
        batchEvents.length !== 1 ||
        (batchEvents[0].args.paymentCount as bigint) !== BigInt(count) ||
        (batchEvents[0].args.totalAmount as bigint) !== expectedTotal
      ) {
        throw new PaymentError(
          "BATCH_EVENT_MISMATCH",
          "Receipt does not contain exactly one matching BatchProcessed event",
          422,
        );
      }
      batchId = String(batchEvents[0].args.batchId).toLowerCase();
    }

    if (event.sender !== getAddress(business.address)) {
      throw new PaymentError(
        "PAYMENT_SENDER_MISMATCH",
        "Payment event sender does not match the authenticated business wallet",
        403,
      );
    }
    const tokenConfig = config.tokens.get(event.token.toLowerCase());
    if (!tokenConfig || tokenConfig.currencyCode !== event.currencyCode) {
      throw new PaymentError(
        "UNSUPPORTED_TOKEN_EVENT",
        "Payment token or emitted currency code is not in the backend allowlist",
        422,
      );
    }
    if (event.amount <= 0n) {
      throw new PaymentError(
        "INVALID_PAYMENT_EVENT",
        "Payment amount must be positive",
        422,
      );
    }

    if (batchId) {
      try {
        const [encodedBatch, encodedPaymentIds] = await Promise.all([
          provider.call({
            to: config.contractAddress,
            data: PAYMENT_INTERFACE.encodeFunctionData("batches", [batchId]),
            blockTag: receipt.blockNumber,
          }),
          provider.call({
            to: config.contractAddress,
            data: PAYMENT_INTERFACE.encodeFunctionData("getBatchPaymentIds", [
              batchId,
            ]),
            blockTag: receipt.blockNumber,
          }),
        ]);
        const batchState = PAYMENT_INTERFACE.decodeFunctionResult(
          "batches",
          encodedBatch,
        );
        const [statePaymentIds] = PAYMENT_INTERFACE.decodeFunctionResult(
          "getBatchPaymentIds",
          encodedPaymentIds,
        );
        const eventPaymentIds = events.map((candidate) =>
          candidate.paymentId.toLowerCase(),
        );
        const onchainPaymentIds = (statePaymentIds as readonly string[]).map(
          (paymentId) => paymentId.toLowerCase(),
        );
        if (
          String(batchState.batchId).toLowerCase() !== batchId ||
          getAddress(batchState.initiator as string) !==
            getAddress(business.address) ||
          (batchState.totalAmount as bigint) !==
            events.reduce((sum, candidate) => sum + candidate.amount, 0n) ||
          Number(batchState.createdAt) !== block.timestamp ||
          batchState.processed !== true ||
          JSON.stringify(onchainPaymentIds) !== JSON.stringify(eventPaymentIds)
        ) {
          throw new Error("batch state mismatch");
        }
      } catch {
        throw new PaymentError(
          "BATCH_STATE_MISMATCH",
          "NoblePay batch state at the confirmed block does not match its receipt",
          422,
        );
      }
    }
    const amount = formatUnits(event.amount, tokenConfig.decimals);
    if (
      getAddress(input.recipient) !== event.recipient ||
      !new Prisma.Decimal(input.amount).equals(new Prisma.Decimal(amount)) ||
      input.currency.toUpperCase() !== tokenConfig.currency ||
      input.purposeHash.toLowerCase() !== callPurposeHash
    ) {
      throw new PaymentError(
        "PAYMENT_CLAIM_MISMATCH",
        "Submitted payment details do not match the verified on-chain transaction",
        422,
      );
    }
    try {
      const encodedState = await provider.call({
        to: config.contractAddress,
        data: PAYMENT_INTERFACE.encodeFunctionData("getPayment", [
          event.paymentId,
        ]),
        blockTag: receipt.blockNumber,
      });
      const [state] = PAYMENT_INTERFACE.decodeFunctionResult(
        "getPayment",
        encodedState,
      );
      if (
        getAddress(state.sender as string) !== event.sender ||
        getAddress(state.recipient as string) !== event.recipient ||
        BigInt(state.amount) !== event.amount ||
        getAddress(state.token as string) !== event.token ||
        String(state.purposeHash).toLowerCase() !== callPurposeHash ||
        Number(state.status) !== 0 ||
        Number(state.createdAt) !== block.timestamp ||
        BigInt(state.settledAt) !== 0n ||
        this.decodeCurrencyCode(state.currencyCode as string) !==
          event.currencyCode
      ) {
        throw new Error("payment state mismatch");
      }
    } catch {
      throw new PaymentError(
        "PAYMENT_STATE_MISMATCH",
        "NoblePay payment state at the confirmed block does not match its receipt and calldata",
        422,
      );
    }
    await this.assertStillCanonical(
      provider,
      config,
      receipt.blockNumber,
      receipt.blockHash,
      receipt.hash,
    );
    const transactionHash = receipt.hash.toLowerCase();
    const idempotencyKey = `chain:${config.chainId.toString()}:${event.paymentId.toLowerCase()}`;

    const result = await this.withSerializableRetry(() =>
      this.prisma.$transaction(
        async (database) => {
          await database.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${businessId}))`;
          const existing = await database.payment.findUnique({
            where: { paymentId: event.paymentId },
          });
          if (existing) {
            const exactMatch =
              existing.businessId === businessId &&
              existing.txHash?.toLowerCase() === transactionHash &&
              existing.sender.toLowerCase() === event.sender.toLowerCase() &&
              existing.recipient.toLowerCase() ===
                event.recipient.toLowerCase() &&
              existing.amount.equals(new Prisma.Decimal(amount)) &&
              existing.currency === tokenConfig.currency &&
              existing.purposeHash?.toLowerCase() === callPurposeHash;
            if (!exactMatch) {
              throw new PaymentError(
                "PAYMENT_RECONCILIATION_CONFLICT",
                "On-chain payment is already associated with different persisted data",
                409,
              );
            }
            return { payment: existing, replayed: true };
          }

          const payment = await database.payment.create({
            data: {
              paymentId: event.paymentId,
              sender: event.sender,
              recipient: event.recipient,
              amount: new Prisma.Decimal(amount),
              currency: tokenConfig.currency,
              purposeHash: callPurposeHash,
              status: "PENDING",
              businessId,
              idempotencyKey,
              txHash: transactionHash,
              blockNumber: BigInt(receipt.blockNumber),
              initiatedAt: new Date(block.timestamp * 1000),
            },
          });
          await this.auditService.createAuditEntryInTransaction(database, {
            businessId,
            eventType: "PAYMENT_CREATED",
            actor: event.sender,
            description: `On-chain payment ${event.paymentId} reconciled from transaction ${transactionHash}`,
            severity: "INFO",
            blockNumber: BigInt(receipt.blockNumber),
            txHash: transactionHash,
            metadata: {
              paymentId: event.paymentId,
              recipient: event.recipient,
              amount,
              currency: tokenConfig.currency,
              token: event.token,
              chainId: config.chainId.toString(),
            },
          });
          return { payment, replayed: false };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );

    if (!result.replayed) {
      paymentTotal.inc({ status: "PENDING", currency: tokenConfig.currency });
      paymentAmount.observe({ currency: tokenConfig.currency }, Number(amount));
    }
    logger.info("On-chain payment reconciled", {
      paymentId: event.paymentId,
      businessId,
      chainId: config.chainId.toString(),
      replayed: result.replayed,
    });

    return {
      ...result,
      confirmations,
      chainId: config.chainId.toString(),
    };
  }

  /** Mirror a lifecycle transition only after proving the exact NoblePay transaction. */
  async reconcileLifecycle(
    paymentIdentifier: string,
    action: PaymentLifecycleAction,
    txHash: string,
    businessId: string,
  ): Promise<ReconciledLifecycleResult> {
    const config = this.loadConfiguration();
    const provider =
      this.provider || (this.provider = new JsonRpcProvider(config.rpcUrl));
    const payment = await this.prisma.payment.findFirst({
      where: {
        businessId,
        ...(paymentIdentifier.startsWith("0x")
          ? { paymentId: paymentIdentifier.toLowerCase() }
          : { id: paymentIdentifier }),
      },
    });
    if (!payment)
      throw new PaymentError("PAYMENT_NOT_FOUND", "Payment not found", 404);

    let network;
    let anchorBlock;
    try {
      [network, anchorBlock] = await Promise.all([
        provider.getNetwork(),
        provider.getBlock(config.networkAnchorBlock),
      ]);
    } catch {
      throw new PaymentError(
        "CHAIN_RPC_UNAVAILABLE",
        "Unable to verify lifecycle transaction",
        503,
      );
    }
    if (!noblePayNetworkIdentityMatches(config, network, anchorBlock)) {
      throw new PaymentError(
        "CHAIN_MISMATCH",
        "Configured RPC returned an unexpected chain",
        503,
      );
    }

    let canonical;
    try {
      canonical = await getCanonicalTransaction(
        provider,
        txHash,
        config.minimumConfirmations,
      );
    } catch (error) {
      if (!(error instanceof CanonicalTransactionError)) throw error;
      switch (error.reason) {
        case "NOT_MINED":
          throw new PaymentError(
            "TRANSACTION_NOT_MINED",
            "Lifecycle transaction has not been mined",
            409,
          );
        case "HASH_MISMATCH":
          throw new PaymentError(
            "TRANSACTION_HASH_MISMATCH",
            "RPC returned a different transaction",
            422,
          );
        case "REVERTED":
          throw new PaymentError(
            "TRANSACTION_REVERTED",
            "Lifecycle transaction reverted on-chain",
            422,
          );
        case "INSUFFICIENT_CONFIRMATIONS":
          throw new PaymentError(
            "INSUFFICIENT_CONFIRMATIONS",
            `Lifecycle transaction requires ${config.minimumConfirmations} confirmations`,
            409,
          );
        case "CANONICAL_MISMATCH":
          throw new PaymentError(
            "TRANSACTION_CANONICAL_MISMATCH",
            "Lifecycle receipt is not in the canonical chain",
            422,
          );
        case "BLOCK_NOT_FOUND":
          throw new PaymentError(
            "BLOCK_NOT_FOUND",
            "Unable to verify lifecycle transaction block",
            503,
          );
        case "RPC_UNAVAILABLE":
          throw new PaymentError(
            "CHAIN_RPC_UNAVAILABLE",
            "Unable to verify lifecycle transaction",
            503,
          );
      }
    }
    const {
      receipt,
      transaction,
      block: lifecycleBlock,
      confirmations,
    } = canonical;
    let execution;
    try {
      execution = await resolveCanonicalContractExecution({
        provider,
        transaction,
        blockNumber: receipt.blockNumber,
        targetContract: config.contractAddress,
        ...(action === "cancel" ? { expectedActor: payment.sender } : {}),
      });
    } catch (error) {
      if (!(error instanceof CanonicalContractExecutionError)) throw error;
      throw new PaymentError("INVALID_LIFECYCLE_EXECUTION", error.message, 422);
    }
    let submittedCall;
    try {
      submittedCall = PAYMENT_INTERFACE.parseTransaction({
        data: execution.callData,
        value: 0n,
      });
    } catch {
      submittedCall = null;
    }
    const expectedMethods: PaymentLifecycleMethod[] =
      action === "settle"
        ? ["settlePayment"]
        : action === "cancel"
          ? ["cancelPayment"]
          : ["refundPayment", "executeSettlementRecovery"];
    if (
      !submittedCall ||
      !expectedMethods.includes(submittedCall.name as PaymentLifecycleMethod)
    ) {
      throw new PaymentError(
        "INVALID_LIFECYCLE_CALL",
        `Transaction calldata is not an allowed NoblePay ${action} method`,
        422,
      );
    }
    const lifecycleMethod = submittedCall.name as PaymentLifecycleMethod;
    if (
      String(submittedCall.args[0]).toLowerCase() !==
      payment.paymentId.toLowerCase()
    ) {
      throw new PaymentError(
        "PAYMENT_CLAIM_MISMATCH",
        "Lifecycle transaction targets another payment",
        422,
      );
    }
    const expectedEvent =
      action === "settle" ? "PaymentSettled" : "PaymentRefunded";
    const matchingEvents = receipt.logs.flatMap((log) => {
      try {
        if (getAddress(log.address) !== config.contractAddress) return [];
        const parsed = PAYMENT_INTERFACE.parseLog({
          topics: [...log.topics],
          data: log.data,
        });
        if (
          !parsed ||
          parsed.name !== expectedEvent ||
          String(parsed.args[0]).toLowerCase() !==
            payment.paymentId.toLowerCase()
        )
          return [];
        return [parsed];
      } catch {
        return [];
      }
    });
    if (matchingEvents.length !== 1) {
      throw new PaymentError(
        "LIFECYCLE_EVENT_MISMATCH",
        `Receipt does not contain exactly one matching ${expectedEvent} event`,
        422,
      );
    }
    const transitionTimestamp = Number(matchingEvents[0].args[1]);
    if (lifecycleMethod === "executeSettlementRecovery") {
      const recoveryEvents = receipt.logs.flatMap((log) => {
        try {
          if (getAddress(log.address) !== config.contractAddress) return [];
          const parsed = PAYMENT_INTERFACE.parseLog({
            topics: [...log.topics],
            data: log.data,
          });
          if (
            !parsed ||
            parsed.name !== "SettlementRecoveryExecuted" ||
            String(parsed.args.paymentId).toLowerCase() !==
              payment.paymentId.toLowerCase()
          )
            return [];
          return [parsed];
        } catch {
          return [];
        }
      });
      if (
        recoveryEvents.length !== 1 ||
        getAddress(recoveryEvents[0].args.executedBy) !== execution.actor ||
        Number(recoveryEvents[0].args.refundedAt) !== transitionTimestamp
      ) {
        throw new PaymentError(
          "LIFECYCLE_EVENT_MISMATCH",
          "Receipt does not prove exactly one matching settlement recovery execution",
          422,
        );
      }
    }
    if (
      !Number.isSafeInteger(transitionTimestamp) ||
      transitionTimestamp <= 0 ||
      transitionTimestamp !== lifecycleBlock.timestamp
    ) {
      throw new PaymentError(
        "LIFECYCLE_EVENT_MISMATCH",
        "Lifecycle event timestamp does not match its confirmed block",
        422,
      );
    }

    try {
      const stateCall = PAYMENT_INTERFACE.encodeFunctionData("getPayment", [
        payment.paymentId,
      ]);
      const rawState = await provider.call({
        to: config.contractAddress,
        data: stateCall,
        blockTag: receipt.blockNumber,
      });
      const [state] = PAYMENT_INTERFACE.decodeFunctionResult(
        "getPayment",
        rawState,
      );
      const expectedStatus = action === "settle" ? 4 : 5;
      const stateToken = getAddress(state.token as string);
      const tokenConfig = config.tokens.get(stateToken.toLowerCase());
      const stateCreatedAt = Number(state.createdAt);
      const stateSettledAt = BigInt(state.settledAt);
      if (
        getAddress(state.sender) !== getAddress(payment.sender) ||
        getAddress(state.recipient) !== getAddress(payment.recipient) ||
        !tokenConfig ||
        tokenConfig.currency !== payment.currency ||
        !payment.amount.equals(
          new Prisma.Decimal(
            formatUnits(BigInt(state.amount), tokenConfig.decimals),
          ),
        ) ||
        !payment.purposeHash ||
        String(state.purposeHash).toLowerCase() !==
          payment.purposeHash.toLowerCase() ||
        this.decodeCurrencyCode(state.currencyCode as string) !==
          tokenConfig.currencyCode ||
        Number(state.status) !== expectedStatus ||
        !Number.isSafeInteger(stateCreatedAt) ||
        stateCreatedAt !== Math.floor(payment.initiatedAt.getTime() / 1000) ||
        stateSettledAt !==
          (action === "settle" ? BigInt(transitionTimestamp) : 0n)
      ) {
        throw new Error("state mismatch");
      }
    } catch {
      throw new PaymentError(
        "LIFECYCLE_STATE_MISMATCH",
        "NoblePay state at the confirmed block does not match the requested lifecycle transition",
        422,
      );
    }
    await this.assertStillCanonical(
      provider,
      config,
      receipt.blockNumber,
      receipt.blockHash,
      receipt.hash,
    );

    const normalizedTxHash = receipt.hash.toLowerCase();
    const finalStatus: Payment["status"] =
      action === "settle"
        ? "SETTLED"
        : action === "cancel"
          ? "CANCELLED"
          : "REFUNDED";
    const eventType =
      action === "settle"
        ? "PAYMENT_SETTLED"
        : action === "cancel"
          ? "PAYMENT_CANCELLED"
          : "PAYMENT_REFUNDED";
    const result = await this.withSerializableRetry(() =>
      this.prisma.$transaction(
        async (database) => {
          await database.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${businessId}))`;
          const priorAudit = await database.auditLog.findFirst({
            where: { businessId, txHash: normalizedTxHash, eventType },
          });
          const current = await database.payment.findFirst({
            where: { id: payment.id, businessId },
          });
          if (!current)
            throw new PaymentError(
              "PAYMENT_NOT_FOUND",
              "Payment not found",
              404,
            );
          if (priorAudit) {
            if (current.status !== finalStatus) {
              throw new PaymentError(
                "LIFECYCLE_RECONCILIATION_CONFLICT",
                "Lifecycle audit and payment state conflict",
                409,
              );
            }
            return { payment: current, replayed: true };
          }

          const transitionTime = new Date(transitionTimestamp * 1000);
          const updated = await database.payment.update({
            where: { id: current.id },
            data: {
              status: finalStatus,
              ...(action === "settle"
                ? { settledAt: transitionTime }
                : { refundedAt: transitionTime }),
            },
          });
          await this.auditService.createAuditEntryInTransaction(database, {
            businessId,
            eventType,
            actor: execution.actor,
            description: `Verified NoblePay ${lifecycleMethod} transaction for payment ${payment.paymentId}`,
            severity: "INFO",
            blockNumber: BigInt(receipt.blockNumber),
            txHash: normalizedTxHash,
            metadata: {
              paymentId: payment.paymentId,
              action,
              method: lifecycleMethod,
              chainId: config.chainId.toString(),
              confirmations,
            },
          });
          return { payment: updated, replayed: false };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );

    return {
      ...result,
      action,
      method: lifecycleMethod,
      txHash: normalizedTxHash,
      confirmations,
      chainId: config.chainId.toString(),
    };
  }

  private async assertStillCanonical(
    provider: JsonRpcProvider,
    config: ReconciliationConfiguration,
    blockNumber: number,
    blockHash: string | null | undefined,
    transactionHash: string,
  ): Promise<void> {
    try {
      await assertCanonicalChainSnapshot(
        provider,
        config,
        blockNumber,
        blockHash,
        transactionHash,
        config.minimumConfirmations,
      );
    } catch (error) {
      if (
        error instanceof CanonicalTransactionError &&
        error.reason === "INSUFFICIENT_CONFIRMATIONS"
      ) {
        throw new PaymentError(
          "INSUFFICIENT_CONFIRMATIONS",
          `Transaction requires ${config.minimumConfirmations} confirmations`,
          409,
        );
      }
      if (
        error instanceof CanonicalTransactionError &&
        error.reason === "RPC_UNAVAILABLE"
      ) {
        throw new PaymentError(
          "CHAIN_RPC_UNAVAILABLE",
          "Unable to perform the final payment chain check",
          503,
        );
      }
      throw new PaymentError(
        "TRANSACTION_CANONICAL_MISMATCH",
        "Chain identity or transaction block changed during reconciliation",
        422,
      );
    }
  }

  private loadConfiguration(): ReconciliationConfiguration {
    try {
      const loaded = loadNoblePayChainConfiguration();
      const tokens = new Map<string, TokenConfiguration>();
      for (const token of loaded.tokens) {
        tokens.set(token.address.toLowerCase(), {
          currency: token.currency,
          currencyCode: token.currencyCode,
          decimals: token.decimals,
        });
      }
      return {
        rpcUrl: loaded.rpcUrl,
        chainId: loaded.chainId,
        networkAnchorBlock: loaded.networkAnchorBlock,
        networkAnchorHash: loaded.networkAnchorHash,
        contractAddress: loaded.contractAddress,
        minimumConfirmations: loaded.minimumConfirmations,
        tokens,
      };
    } catch (error) {
      throw new PaymentError(
        "RECONCILIATION_MISCONFIGURED",
        (error as Error).message ||
          "On-chain reconciliation configuration is invalid",
        503,
      );
    }
  }

  private decodeCurrencyCode(value: string): string {
    try {
      const decoded = toUtf8String(value).replace(/\0/g, "").toUpperCase();
      if (!/^[A-Z0-9]{3}$/.test(decoded))
        throw new Error("Invalid currency code");
      return decoded;
    } catch {
      throw new PaymentError(
        "INVALID_PAYMENT_EVENT",
        "Payment event currency code is invalid",
        422,
      );
    }
  }

  private async withSerializableRetry<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await operation();
      } catch (error) {
        const retryable =
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2034";
        if (!retryable || attempt === 2) throw error;
      }
    }
    throw new Error("Unreachable serializable retry state");
  }
}
