/**
 * Contract ABI Exports for NoblePay Extended Modules
 *
 * Uses viem parseAbi-compatible string format for key function
 * signatures of the extended NoblePay protocol contracts.
 */

// ---------------------------------------------------------------------------
// LiquidityPool — Settlement liquidity management
// ---------------------------------------------------------------------------

export const LIQUIDITY_POOL_ABI = [
  'function addLiquidity(address tokenA, address tokenB, uint256 amountA, uint256 amountB, uint256 minLP) external returns (uint256 lpTokens)',
  'function removeLiquidity(uint256 lpTokens, uint256 minA, uint256 minB) external returns (uint256 amountA, uint256 amountB)',
  'function claimFees(address pool) external returns (uint256 feesClaimed)',
  'function getPoolReserves(address pool) external view returns (uint256 reserveA, uint256 reserveB)',
  'function getPoolInfo(address pool) external view returns (address tokenA, address tokenB, uint256 tvl, uint256 feeBps, bool active)',
  'function getLPPosition(address pool, address user) external view returns (uint256 lpTokens, uint256 share, uint256 unclaimedFees)',
  'function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minAmountOut) external returns (uint256 amountOut)',
  'event LiquidityAdded(address indexed pool, address indexed provider, uint256 amountA, uint256 amountB, uint256 lpTokens)',
  'event LiquidityRemoved(address indexed pool, address indexed provider, uint256 lpTokens)',
  'event Swap(address indexed pool, address indexed trader, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut)',
] as const;

// ---------------------------------------------------------------------------
// StreamingPayments — Continuous payment streams
// ---------------------------------------------------------------------------

export const STREAMING_PAYMENTS_ABI = [
  'function createStream(address recipient, address token, uint256 totalAmount, uint256 startTime, uint256 endTime, bool cancelable) external returns (bytes32 streamId)',
  'function cancelStream(bytes32 streamId) external',
  'function pauseStream(bytes32 streamId) external',
  'function resumeStream(bytes32 streamId) external',
  'function withdrawFromStream(bytes32 streamId, uint256 amount) external',
  'function getStream(bytes32 streamId) external view returns (address sender, address recipient, address token, uint256 totalAmount, uint256 streamedAmount, uint256 ratePerSecond, uint256 startTime, uint256 endTime, uint8 status)',
  'function getStreamBalance(bytes32 streamId) external view returns (uint256 withdrawable, uint256 remaining, uint256 deposited, uint256 withdrawn)',
  'event StreamCreated(bytes32 indexed streamId, address indexed sender, address indexed recipient, uint256 totalAmount, uint256 startTime, uint256 endTime)',
  'event StreamCancelled(bytes32 indexed streamId, uint256 refundedAmount)',
  'event StreamWithdrawal(bytes32 indexed streamId, address indexed recipient, uint256 amount)',
] as const;

// ---------------------------------------------------------------------------
// CrossChainRouter — Multi-chain transfer routing
// ---------------------------------------------------------------------------

export const CROSS_CHAIN_ROUTER_ABI = [
  'function initiateTransfer(uint256 destChainId, address recipient, address token, uint256 amount, bytes calldata routeData) external payable returns (bytes32 transferId)',
  'function completeTransfer(bytes32 transferId, bytes calldata proof) external',
  'function getTransferStatus(bytes32 transferId) external view returns (uint8 status, uint256 sourceChainId, uint256 destChainId, uint256 amount, address sender, address recipient)',
  'function getRouteQuote(uint256 sourceChainId, uint256 destChainId, address token, uint256 amount) external view returns (uint256 fee, uint256 estimatedTime, uint256 slippageBps)',
  'function getSupportedChains() external view returns (uint256[] memory chainIds)',
  'function getRelayNodeStatus(bytes32 nodeId) external view returns (bool active, uint256 stakedCollateral, uint256 totalRelayed, uint256 successRate)',
  'event TransferInitiated(bytes32 indexed transferId, uint256 indexed destChainId, address indexed sender, uint256 amount)',
  'event TransferCompleted(bytes32 indexed transferId, address indexed recipient, uint256 amount)',
  'event TransferFailed(bytes32 indexed transferId, string reason)',
] as const;

// ---------------------------------------------------------------------------
// AIComplianceModule — AI-driven compliance decisions
// ---------------------------------------------------------------------------

export const AI_COMPLIANCE_MODULE_ABI = [
  'function getDecision(bytes32 decisionId) external view returns (bytes32 paymentId, uint8 outcome, uint256 confidence, uint256 riskScore, uint256 latencyMs, uint256 timestamp)',
  'function getModelInfo(bytes32 modelId) external view returns (string memory name, string memory version, uint8 status, uint256 accuracy, uint256 falsePositiveRate)',
  'function appealDecision(bytes32 decisionId, bytes calldata evidence) external returns (bytes32 appealId)',
  'function resolveAppeal(bytes32 appealId, bool upheld, bytes calldata reasoning) external',
  'function getBehavioralScore(address entity) external view returns (uint256 score, uint256 patternScore, uint256 counterpartyScore, uint256 volumeScore, uint256 geographicScore)',
  'function getCorridorRisk(bytes2 source, bytes2 dest) external view returns (uint8 riskLevel, uint256 riskScore, uint256 volume30d, uint256 flaggedCount)',
  'event DecisionMade(bytes32 indexed decisionId, bytes32 indexed paymentId, uint8 outcome, uint256 riskScore)',
  'event AppealFiled(bytes32 indexed appealId, bytes32 indexed decisionId, address indexed appellant)',
  'event AppealResolved(bytes32 indexed appealId, bool upheld)',
] as const;

// ---------------------------------------------------------------------------
// InvoiceFinancing — Trade finance and invoice tokenization
// ---------------------------------------------------------------------------

export const INVOICE_FINANCING_ABI = [
  'function createInvoice(address payer, uint256 amount, address token, uint256 dueDate, bytes32 documentHash) external returns (bytes32 invoiceId)',
  'function tokenizeInvoice(bytes32 invoiceId) external returns (uint256 tokenId)',
  'function requestFinancing(bytes32 invoiceId, uint256 amount) external returns (bytes32 requestId)',
  'function approveFinancing(bytes32 requestId, uint256 approvedAmount, uint256 interestRateBps) external',
  'function repayFinancing(bytes32 requestId, uint256 amount) external',
  'function getInvoice(bytes32 invoiceId) external view returns (address issuer, address payer, uint256 amount, address token, uint8 status, uint256 dueDate, bool tokenized)',
  'function getCreditScore(address business) external view returns (uint256 score, uint256 maxFinancing, uint256 maxAdvanceRateBps, uint256 baseInterestRateBps)',
  'event InvoiceCreated(bytes32 indexed invoiceId, address indexed issuer, address indexed payer, uint256 amount)',
  'event InvoiceTokenized(bytes32 indexed invoiceId, uint256 indexed tokenId)',
  'event FinancingRequested(bytes32 indexed requestId, bytes32 indexed invoiceId, uint256 amount)',
  'event FinancingApproved(bytes32 indexed requestId, uint256 approvedAmount)',
] as const;

// ---------------------------------------------------------------------------
// FXHedgingVault — Foreign exchange hedging
// ---------------------------------------------------------------------------

export const FX_HEDGING_VAULT_ABI = [
  'function createHedge(bytes32 fromCurrency, bytes32 toCurrency, uint256 notionalAmount, uint256 durationSeconds) external payable returns (bytes32 hedgeId)',
  'function closeHedge(bytes32 hedgeId) external returns (int256 pnl)',
  'function getHedge(bytes32 hedgeId) external view returns (address owner, bytes32 fromCurrency, bytes32 toCurrency, uint256 notional, uint256 lockedRate, uint256 expiry, uint8 status)',
  'function getCurrentRate(bytes32 fromCurrency, bytes32 toCurrency) external view returns (uint256 rate, uint256 bid, uint256 ask)',
  'function getExposure(address user) external view returns (uint256 totalExposure, uint256 hedgedAmount, uint256 unhedgedAmount, uint256 valueAtRisk)',
  'event HedgeCreated(bytes32 indexed hedgeId, address indexed owner, bytes32 fromCurrency, bytes32 toCurrency, uint256 notional, uint256 lockedRate)',
  'event HedgeClosed(bytes32 indexed hedgeId, int256 pnl)',
  'event HedgeLiquidated(bytes32 indexed hedgeId, uint256 collateralSeized)',
] as const;

// ---------------------------------------------------------------------------
// MultiSigTreasury — DAO treasury with multi-sig governance
// ---------------------------------------------------------------------------

export const MULTI_SIG_TREASURY_ABI = [
  'function createProposal(string calldata title, address recipient, uint256 amount, address token, string calldata description) external returns (bytes32 proposalId)',
  'function voteOnProposal(bytes32 proposalId, bool support) external',
  'function executeProposal(bytes32 proposalId) external',
  'function cancelProposal(bytes32 proposalId) external',
  'function getProposal(bytes32 proposalId) external view returns (address proposer, address recipient, uint256 amount, address token, uint8 status, uint256 votesFor, uint256 votesAgainst, uint256 deadline)',
  'function getTreasuryBalance(address token) external view returns (uint256 balance)',
  'function getSpendingPolicy() external view returns (uint256 maxSingleTx, uint256 dailyLimit, uint256 monthlyLimit, uint256 requiredApprovals)',
  'function getApprovalThreshold(uint256 amount) external view returns (uint256 requiredSignatures, uint256 timelockDelay)',
  'event ProposalCreated(bytes32 indexed proposalId, address indexed proposer, uint256 amount)',
  'event ProposalExecuted(bytes32 indexed proposalId, address indexed executor)',
  'event ProposalVoted(bytes32 indexed proposalId, address indexed voter, bool support)',
] as const;

// ---------------------------------------------------------------------------
// PaymentChannels — Off-chain payment channels for high-frequency settlements
// ---------------------------------------------------------------------------

export const PAYMENT_CHANNELS_ABI = [
  'function openChannel(address counterparty, address token, uint256 deposit) external returns (bytes32 channelId)',
  'function closeChannel(bytes32 channelId, uint256 finalBalanceA, uint256 finalBalanceB, bytes calldata signatureA, bytes calldata signatureB) external',
  'function disputeChannel(bytes32 channelId, uint256 claimedBalanceA, uint256 claimedBalanceB, bytes calldata proof) external',
  'function topUpChannel(bytes32 channelId, uint256 amount) external',
  'function getChannel(bytes32 channelId) external view returns (address partyA, address partyB, address token, uint256 depositA, uint256 depositB, uint8 status, uint256 openedAt)',
  'function getChannelBalance(bytes32 channelId) external view returns (uint256 balanceA, uint256 balanceB, uint256 nonce)',
  'event ChannelOpened(bytes32 indexed channelId, address indexed partyA, address indexed partyB, uint256 deposit)',
  'event ChannelClosed(bytes32 indexed channelId, uint256 finalBalanceA, uint256 finalBalanceB)',
  'event ChannelDisputed(bytes32 indexed channelId, address indexed disputant)',
] as const;
