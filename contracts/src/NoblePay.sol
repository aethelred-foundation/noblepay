// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/access/AccessControlEnumerable.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import "./interfaces/IBusinessRegistry.sol";
import "./interfaces/ISealSettlementGate.sol";

/**
 * @title NoblePay
 * @author Aethelred Team
 * @notice Core cross-border payment contract for the NoblePay platform.
 *         Escrows governance-approved 6-decimal USD-denominated ERC20 stablecoins
 *         with authorized off-chain compliance screening, FATF Travel Rule
 *         integration, and UAE regulatory compliance. Native AET is deliberately
 *         excluded until a trustworthy price-normalization mechanism is deployed.
 *
 * @dev Architecture overview:
 *
 * ┌───────────────────────────────────────────────────────────────────┐
 * │                         NOBLEPAY CORE                            │
 * ├───────────────────────────────────────────────────────────────────┤
 * │  ┌─────────────┐  ┌──────────────────┐  ┌─────────────────┐    │
 * │  │  Payments    │  │  Compliance Gate  │  │  Settlement     │    │
 * │  │  ──────────  │  │  ──────────────── │  │  ────────────── │    │
 * │  │  • initiate  │  │  • governed result│  │  • ERC20 xfer   │    │
 * │  │  • batch     │  │  • AML scoring    │  │  • fee snapshot │    │
 * │  │  • cancel    │  │  • sanctions      │  │  • fee split    │    │
 * │  └─────────────┘  └──────────────────┘  └─────────────────┘    │
 * │  ┌─────────────┐  ┌──────────────────┐  ┌─────────────────┐    │
 * │  │  Rate Limit  │  │  Fee Engine       │  │  Circuit Break  │    │
 * │  │  ──────────  │  │  ──────────────── │  │  ────────────── │    │
 * │  │  • daily vol │  │  • base + pct     │  │  • emergency    │    │
 * │  │  • monthly   │  │  • treasury       │  │  • pause/unpause│    │
 * │  │  • tier caps │  │  • tier discount  │  │  • admin only   │    │
 * │  └─────────────┘  └──────────────────┘  └─────────────────┘    │
 * └───────────────────────────────────────────────────────────────────┘
 *
 * Trust model:
 *   - Compliance decisions are submitted by addresses granted TEE_NODE_ROLE.
 *     This contract treats their attestation bytes as opaque audit evidence; it
 *     does not call ComplianceOracle or verify hardware signatures on-chain.
 *   - Governance must grant TEE_NODE_ROLE only to an independently audited
 *     off-chain verifier and must revoke it if that verifier is compromised.
 *   - A purpose hash is a public commitment to caller-provided text; hashing
 *     alone does not make a low-entropy purpose confidential. Any travel-rule
 *     payload stored by companion contracts requires separate encryption.
 *   - Settlement is atomic and rechecks the configured Seal corridor gate
 *     immediately before funds move.
 */
contract NoblePay is AccessControlEnumerable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ──────────────────────────────────────────────────────────────
    // Roles
    // ──────────────────────────────────────────────────────────────

    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant TEE_NODE_ROLE = keccak256("TEE_NODE_ROLE");
    bytes32 public constant COMPLIANCE_OFFICER_ROLE = keccak256("COMPLIANCE_OFFICER_ROLE");
    bytes32 public constant TREASURY_ROLE = keccak256("TREASURY_ROLE");

    // ──────────────────────────────────────────────────────────────
    // Enums
    // ──────────────────────────────────────────────────────────────

    /// @notice Lifecycle status of a payment.
    enum ComplianceStatus {
        PENDING,
        PASSED,
        FLAGGED,
        BLOCKED,
        SETTLED,
        REFUNDED
    }

    /// @notice Business tier determines volume limits and fee discounts.
    enum BusinessTier {
        STANDARD,
        PREMIUM,
        ENTERPRISE
    }

    // ──────────────────────────────────────────────────────────────
    // Structs
    // ──────────────────────────────────────────────────────────────

    /// @notice Core payment record stored on-chain.
    struct Payment {
        address sender;
        address recipient;
        uint256 amount;
        address token;                // approved 6-decimal USD stablecoin
        bytes32 purposeHash;          // public keccak256 commitment supplied by caller
        ComplianceStatus status;
        bytes teeAttestation;         // Opaque evidence supplied by the authorized verifier
        uint256 createdAt;
        uint256 settledAt;
        bytes3 currencyCode;          // ISO 4217 code (e.g., "AED", "USD")
    }

    /// @notice Result submitted by an authorized off-chain compliance verifier.
    struct ComplianceResult {
        bool sanctionsClear;
        uint8 amlRiskScore;           // 0-100 scale
        bool travelRuleCompliant;
        bytes32 investigationHash;    // hash of detailed report held in TEE
    }

    /// @notice Batch payment wrapper for bulk processing.
    struct PaymentBatch {
        bytes32 batchId;
        bytes32[] paymentIds;
        address initiator;
        uint256 totalAmount;
        uint256 createdAt;
        bool processed;
    }

    /// @notice Governed, time-delayed request to recover PASSED escrow when
    ///         the immutable Seal settlement gate is still unavailable.
    struct SettlementRecoveryRequest {
        uint64 executeAfter;
        uint64 expiresAt;
        address requestedBy;
    }

    // ──────────────────────────────────────────────────────────────
    // Fee configuration
    // ──────────────────────────────────────────────────────────────

    /// @notice Base fee in 6-decimal stablecoin units charged per payment.
    uint256 public baseFee;

    /// @notice Percentage fee in basis points (1 bp = 0.01%).
    uint256 public percentageFee;

    /// @notice Maximum percentage fee cap (500 bp = 5%).
    uint256 public constant MAX_PERCENTAGE_FEE = 500;

    /// @notice Mandatory notice period before a failed-settlement recovery can execute.
    uint256 public constant SETTLEMENT_RECOVERY_DELAY = 2 days;

    /// @notice Bounded execution window prevents an unavailable-gate request
    ///         from remaining executable indefinitely after its notice period.
    uint256 public constant SETTLEMENT_RECOVERY_WINDOW = 2 days;

    /// @notice Address that receives collected fees.
    address public treasury;

    // ──────────────────────────────────────────────────────────────
    // Volume limits (approved USD stablecoins, 6-decimal precision)
    // ──────────────────────────────────────────────────────────────

    /// @dev Daily limits per tier in the required 6-decimal stablecoin unit.
    uint256 public constant STANDARD_DAILY_LIMIT = 50_000 * 1e6;
    uint256 public constant PREMIUM_DAILY_LIMIT = 500_000 * 1e6;
    uint256 public constant ENTERPRISE_DAILY_LIMIT = 5_000_000 * 1e6;

    uint256 public constant STANDARD_MONTHLY_LIMIT = 500_000 * 1e6;
    uint256 public constant PREMIUM_MONTHLY_LIMIT = 5_000_000 * 1e6;
    uint256 public constant ENTERPRISE_MONTHLY_LIMIT = 50_000_000 * 1e6;

    // ──────────────────────────────────────────────────────────────
    // State
    // ──────────────────────────────────────────────────────────────

    /// @notice Monotonically increasing payment nonce.
    uint256 public paymentNonce;

    /// @notice Monotonically increasing batch nonce.
    uint256 public batchNonce;

    /// @notice Reference to the BusinessRegistry contract for tier lookups.
    address public businessRegistry;

    /// @notice Consensus-backed corridor clearance gate used at settlement.
    address public sealSettlementGate;

    /// @notice True after the immutable production trust dependencies are set.
    bool public trustConfigured;

    /// @notice Supported ERC20 tokens (token address => supported flag).
    mapping(address => bool) public supportedTokens;

    /// @notice Payment records keyed by payment ID.
    mapping(bytes32 => Payment) public payments;

    /// @notice Immutable fee amount captured when each payment is initiated.
    mapping(bytes32 => uint256) public paymentFees;

    /// @notice Pending settlement-recovery request for each PASSED payment.
    mapping(bytes32 => SettlementRecoveryRequest) public settlementRecoveryRequests;

    /// @notice Compliance results keyed by payment ID.
    mapping(bytes32 => ComplianceResult) public complianceResults;

    /// @notice Batch records keyed by batch ID.
    mapping(bytes32 => PaymentBatch) public batches;

    /// @notice Daily volume tracking: business address => day => volume.
    mapping(address => mapping(uint256 => uint256)) public dailyVolume;

    /// @notice Monthly volume tracking: business address => month => volume.
    mapping(address => mapping(uint256 => uint256)) public monthlyVolume;

    /// @notice Registered business addresses (mirrors BusinessRegistry).
    mapping(address => bool) public registeredBusinesses;

    /// @notice Business tier mapping (mirrors BusinessRegistry).
    mapping(address => BusinessTier) public businessTiers;

    // ──────────────────────────────────────────────────────────────
    // Events
    // ──────────────────────────────────────────────────────────────

    event PaymentInitiated(
        bytes32 indexed paymentId,
        address indexed sender,
        address indexed recipient,
        uint256 amount,
        address token,
        bytes3 currencyCode
    );

    event PaymentCleared(bytes32 indexed paymentId, uint8 amlRiskScore);
    event PaymentFlagged(bytes32 indexed paymentId, uint8 amlRiskScore, bytes32 investigationHash);
    event PaymentBlocked(bytes32 indexed paymentId, bytes32 investigationHash);
    event PaymentSettled(bytes32 indexed paymentId, uint256 settledAt, uint256 feeCollected);
    event PaymentRefunded(bytes32 indexed paymentId, uint256 refundedAt);
    event SettlementRecoveryRequested(
        bytes32 indexed paymentId,
        address indexed requestedBy,
        uint256 executeAfter,
        uint256 expiresAt
    );
    event SettlementRecoveryExecuted(bytes32 indexed paymentId, address indexed executedBy, uint256 refundedAt);
    event PaymentFeeSnapshotted(bytes32 indexed paymentId, uint256 feeAmount);
    event BatchProcessed(bytes32 indexed batchId, uint256 paymentCount, uint256 totalAmount);
    event TokenSupported(address indexed token, bool supported);
    event FeeUpdated(uint256 baseFee, uint256 percentageFee);
    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);
    event BusinessSynced(address indexed business, BusinessTier tier, bool registered);
    event TrustConfigured(address indexed businessRegistry, address indexed sealSettlementGate);

    // ──────────────────────────────────────────────────────────────
    // Errors
    // ──────────────────────────────────────────────────────────────

    error NotRegisteredBusiness();
    error UnsupportedToken();
    error ZeroAmount();
    error ZeroAddress();
    error InvalidRecipient();
    error PaymentNotFound();
    error InvalidPaymentStatus(ComplianceStatus current, ComplianceStatus expected);
    error DailyLimitExceeded(uint256 requested, uint256 remaining);
    error MonthlyLimitExceeded(uint256 requested, uint256 remaining);
    error InvalidRiskScore();
    error InvalidFee();
    error BatchEmpty();
    error BatchNotFound();
    error NativePaymentsDisabled();
    error UnexpectedNativeValue(uint256 provided);
    error InvalidTokenContract(address token);
    error InvalidTokenDecimals(address token, uint8 decimals);
    error FeeNotLessThanAmount(uint256 fee, uint256 amount);
    error NonExactTokenTransfer(address token, uint256 expected, uint256 received);
    error TrustNotConfigured();
    error TrustAlreadyConfigured();
    error InvalidTrustContract(address target);
    error InvalidBusinessTier(uint8 tier);
    error SettlementStillAvailable();
    error SettlementRecoveryAlreadyRequested(uint256 expiresAt);
    error SettlementRecoveryNotRequested();
    error SettlementRecoveryDelayNotElapsed(uint256 executeAfter);
    error SettlementRecoveryRequestExpired(uint256 expiresAt);
    error SettlementRecoveryRequiresActiveSender();

    // ──────────────────────────────────────────────────────────────
    // Modifiers
    // ──────────────────────────────────────────────────────────────

    /// @notice Restricts to registered businesses only.
    modifier onlyRegistered() {
        if (!trustConfigured) revert TrustNotConfigured();
        if (!IBusinessRegistry(businessRegistry).isBusinessActive(msg.sender)) {
            revert NotRegisteredBusiness();
        }
        _;
    }

    /// @notice Restricts to verified TEE nodes.
    modifier onlyTEENode() {
        _checkRole(TEE_NODE_ROLE);
        _;
    }

    /// @notice Restricts to compliance officers.
    modifier onlyComplianceOfficer() {
        _checkRole(COMPLIANCE_OFFICER_ROLE);
        _;
    }

    // ──────────────────────────────────────────────────────────────
    // Constructor
    // ──────────────────────────────────────────────────────────────

    /**
     * @notice Deploys NoblePay with initial fee configuration and treasury.
     * @param _admin         Admin address with full control.
     * @param _treasury      Address that collects payment fees.
     * @param _baseFee       Flat fee per payment in 6-decimal stablecoin units.
     * @param _percentageFee Percentage fee in basis points.
     */
    constructor(
        address _admin,
        address _treasury,
        uint256 _baseFee,
        uint256 _percentageFee
    ) {
        if (_admin == address(0)) revert ZeroAddress();
        if (_treasury == address(0)) revert ZeroAddress();
        if (_percentageFee > MAX_PERCENTAGE_FEE) revert InvalidFee();

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(ADMIN_ROLE, _admin);
        _grantRole(TREASURY_ROLE, _admin);

        treasury = _treasury;
        baseFee = _baseFee;
        percentageFee = _percentageFee;
    }

    // ──────────────────────────────────────────────────────────────
    // External — Payment initiation
    // ──────────────────────────────────────────────────────────────

    /**
     * @notice Initiates a single cross-border payment.
     * @param _recipient     Beneficiary address.
     * @param _amount        Payment amount in 6-decimal stablecoin units.
     * @param _token         Governance-approved 6-decimal USD stablecoin address.
     * @param _purposeHash   Public keccak256 commitment supplied by the caller.
     * @param _currencyCode  ISO 4217 currency code (3 bytes).
     * @return paymentId     Unique identifier for the payment.
     */
    function initiatePayment(
        address _recipient,
        uint256 _amount,
        address _token,
        bytes32 _purposeHash,
        bytes3 _currencyCode
    ) external payable whenNotPaused onlyRegistered nonReentrant returns (bytes32 paymentId) {
        if (_recipient == address(0)) revert ZeroAddress();
        if (_recipient == msg.sender) revert InvalidRecipient();
        if (_amount == 0) revert ZeroAmount();
        if (msg.value != 0) revert UnexpectedNativeValue(msg.value);

        if (_token == address(0)) revert NativePaymentsDisabled();
        if (!supportedTokens[_token]) revert UnsupportedToken();

        uint256 fee = _calculateFee(_amount);
        if (fee >= _amount) revert FeeNotLessThanAmount(fee, _amount);

        // Enforce volume limits
        _enforceVolumeLimits(msg.sender, _amount);

        // Generate unique payment ID
        paymentId = keccak256(abi.encodePacked(msg.sender, _recipient, _amount, block.timestamp, paymentNonce++));

        _escrowExact(_token, msg.sender, _amount);

        // Record payment
        payments[paymentId] = Payment({
            sender: msg.sender,
            recipient: _recipient,
            amount: _amount,
            token: _token,
            purposeHash: _purposeHash,
            status: ComplianceStatus.PENDING,
            teeAttestation: "",
            createdAt: block.timestamp,
            settledAt: 0,
            currencyCode: _currencyCode
        });
        paymentFees[paymentId] = fee;

        emit PaymentInitiated(paymentId, msg.sender, _recipient, _amount, _token, _currencyCode);
        emit PaymentFeeSnapshotted(paymentId, fee);
    }

    /**
     * @notice Initiates a batch of payments for bulk processing.
     * @param _recipients    Array of beneficiary addresses.
     * @param _amounts       Array of payment amounts.
     * @param _tokens        Array of token addresses.
     * @param _purposeHashes Array of purpose hashes.
     * @param _currencyCodes Array of ISO 4217 currency codes.
     * @return batchId       Unique batch identifier.
     */
    function initiatePaymentBatch(
        address[] calldata _recipients,
        uint256[] calldata _amounts,
        address[] calldata _tokens,
        bytes32[] calldata _purposeHashes,
        bytes3[] calldata _currencyCodes
    ) external payable whenNotPaused onlyRegistered nonReentrant returns (bytes32 batchId) {
        uint256 count = _recipients.length;
        if (count == 0) revert BatchEmpty();
        if (msg.value != 0) revert UnexpectedNativeValue(msg.value);
        require(
            count == _amounts.length &&
            count == _tokens.length &&
            count == _purposeHashes.length &&
            count == _currencyCodes.length,
            "NoblePay: array length mismatch"
        );

        batchId = keccak256(abi.encodePacked(msg.sender, block.timestamp, batchNonce++));

        bytes32[] memory paymentIds = new bytes32[](count);
        uint256 totalAmount;

        for (uint256 i; i < count;) {
            if (_recipients[i] == address(0)) revert ZeroAddress();
            if (_recipients[i] == msg.sender) revert InvalidRecipient();
            if (_amounts[i] == 0) revert ZeroAmount();
            if (_tokens[i] == address(0)) revert NativePaymentsDisabled();
            if (!supportedTokens[_tokens[i]]) revert UnsupportedToken();

            uint256 fee = _calculateFee(_amounts[i]);
            if (fee >= _amounts[i]) revert FeeNotLessThanAmount(fee, _amounts[i]);

            bytes32 pid = keccak256(
                abi.encodePacked(msg.sender, _recipients[i], _amounts[i], block.timestamp, paymentNonce++)
            );
            paymentIds[i] = pid;

            _escrowExact(_tokens[i], msg.sender, _amounts[i]);

            payments[pid] = Payment({
                sender: msg.sender,
                recipient: _recipients[i],
                amount: _amounts[i],
                token: _tokens[i],
                purposeHash: _purposeHashes[i],
                status: ComplianceStatus.PENDING,
                teeAttestation: "",
                createdAt: block.timestamp,
                settledAt: 0,
                currencyCode: _currencyCodes[i]
            });
            paymentFees[pid] = fee;

            totalAmount += _amounts[i];

            emit PaymentInitiated(pid, msg.sender, _recipients[i], _amounts[i], _tokens[i], _currencyCodes[i]);
            emit PaymentFeeSnapshotted(pid, fee);

            unchecked { ++i; }
        }

        _enforceVolumeLimits(msg.sender, totalAmount);

        batches[batchId] = PaymentBatch({
            batchId: batchId,
            paymentIds: paymentIds,
            initiator: msg.sender,
            totalAmount: totalAmount,
            createdAt: block.timestamp,
            processed: true
        });

        emit BatchProcessed(batchId, count, totalAmount);
    }

    // ──────────────────────────────────────────────────────────────
    // External — Compliance (authorized verifier only)
    // ──────────────────────────────────────────────────────────────

    /**
     * @notice Submits a compliance result from an authorized off-chain verifier.
     * @dev Only callable by addresses with TEE_NODE_ROLE. The role name is retained
     *      for ABI compatibility. `_attestation` is stored as opaque evidence and is
     *      not parsed or cryptographically validated by this contract.
     * @param _paymentId       Payment to update.
     * @param _sanctionsClear  Whether the payment clears sanctions screening.
     * @param _amlRiskScore    AML risk score (0-100).
     * @param _travelRuleOk    Whether FATF Travel Rule requirements are met.
     * @param _investigationHash Hash of the full investigation report.
     * @param _attestation     Opaque evidence supplied by the authorized verifier.
     */
    function submitComplianceResult(
        bytes32 _paymentId,
        bool _sanctionsClear,
        uint8 _amlRiskScore,
        bool _travelRuleOk,
        bytes32 _investigationHash,
        bytes calldata _attestation
    ) external onlyTEENode whenNotPaused {
        Payment storage p = payments[_paymentId];
        if (p.sender == address(0)) revert PaymentNotFound();
        if (p.status != ComplianceStatus.PENDING) {
            revert InvalidPaymentStatus(p.status, ComplianceStatus.PENDING);
        }
        if (_amlRiskScore > 100) revert InvalidRiskScore();

        complianceResults[_paymentId] = ComplianceResult({
            sanctionsClear: _sanctionsClear,
            amlRiskScore: _amlRiskScore,
            travelRuleCompliant: _travelRuleOk,
            investigationHash: _investigationHash
        });

        p.teeAttestation = _attestation;

        // Determine status based on compliance outcome
        if (!_sanctionsClear) {
            p.status = ComplianceStatus.BLOCKED;
            emit PaymentBlocked(_paymentId, _investigationHash);
        } else if (_amlRiskScore > 70 || !_travelRuleOk) {
            p.status = ComplianceStatus.FLAGGED;
            emit PaymentFlagged(_paymentId, _amlRiskScore, _investigationHash);
        } else {
            p.status = ComplianceStatus.PASSED;
            emit PaymentCleared(_paymentId, _amlRiskScore);
        }
    }

    // ──────────────────────────────────────────────────────────────
    // External — Settlement & Refund
    // ──────────────────────────────────────────────────────────────

    /**
     * @notice Starts a governed recovery notice for a PASSED payment whose
     *         sender is still active but whose Seal corridor cannot currently settle.
     * @dev A live, settleable corridor can never enter recovery. Expired
     *      requests may be replaced, ensuring every execution has a recent
     *      notice period instead of relying on an indefinitely stale approval.
     * @param _paymentId Payment whose escrow may need to be returned.
     */
    function requestSettlementRecovery(bytes32 _paymentId)
        external
        onlyComplianceOfficer
    {
        Payment storage p = payments[_paymentId];
        if (p.sender == address(0)) revert PaymentNotFound();
        if (p.status != ComplianceStatus.PASSED) {
            revert InvalidPaymentStatus(p.status, ComplianceStatus.PASSED);
        }
        if (!IBusinessRegistry(businessRegistry).isBusinessActive(p.sender)) {
            revert SettlementRecoveryRequiresActiveSender();
        }
        if (_settlementAvailable(p.sender, p.recipient)) {
            revert SettlementStillAvailable();
        }

        SettlementRecoveryRequest storage existing = settlementRecoveryRequests[_paymentId];
        if (existing.executeAfter != 0 && block.timestamp <= existing.expiresAt) {
            revert SettlementRecoveryAlreadyRequested(existing.expiresAt);
        }

        uint64 executeAfter = uint64(block.timestamp + SETTLEMENT_RECOVERY_DELAY);
        uint64 expiresAt = uint64(uint256(executeAfter) + SETTLEMENT_RECOVERY_WINDOW);
        settlementRecoveryRequests[_paymentId] = SettlementRecoveryRequest({
            executeAfter: executeAfter,
            expiresAt: expiresAt,
            requestedBy: msg.sender
        });

        emit SettlementRecoveryRequested(_paymentId, msg.sender, executeAfter, expiresAt);
    }

    /**
     * @notice Returns a PASSED payment's exact escrow to its sender after the
     *         governed notice period, but only while settlement is still impossible.
     * @dev The same non-reverting static check as {settlePayment}'s live gate is
     *      repeated immediately before effects. Restored clearance therefore
     *      makes execution fail, while a paused, revoked, or missing clearance
     *      remains recoverable. State and request invalidation precede transfer.
     * @param _paymentId Payment to recover.
     */
    function executeSettlementRecovery(bytes32 _paymentId)
        external
        onlyComplianceOfficer
        nonReentrant
    {
        Payment storage p = payments[_paymentId];
        if (p.sender == address(0)) revert PaymentNotFound();
        if (p.status != ComplianceStatus.PASSED) {
            revert InvalidPaymentStatus(p.status, ComplianceStatus.PASSED);
        }

        SettlementRecoveryRequest memory request = settlementRecoveryRequests[_paymentId];
        if (request.executeAfter == 0) revert SettlementRecoveryNotRequested();
        if (block.timestamp < request.executeAfter) {
            revert SettlementRecoveryDelayNotElapsed(request.executeAfter);
        }
        if (block.timestamp > request.expiresAt) {
            revert SettlementRecoveryRequestExpired(request.expiresAt);
        }
        if (!IBusinessRegistry(businessRegistry).isBusinessActive(p.sender)) {
            revert SettlementRecoveryRequiresActiveSender();
        }
        if (_settlementAvailable(p.sender, p.recipient)) {
            revert SettlementStillAvailable();
        }

        delete settlementRecoveryRequests[_paymentId];
        p.status = ComplianceStatus.REFUNDED;

        IERC20(p.token).safeTransfer(p.sender, p.amount);

        emit SettlementRecoveryExecuted(_paymentId, msg.sender, block.timestamp);
        emit PaymentRefunded(_paymentId, block.timestamp);
    }

    /**
     * @notice Settles a cleared payment, transferring funds to the recipient.
     * @param _paymentId Payment to settle.
     */
    function settlePayment(bytes32 _paymentId) external nonReentrant whenNotPaused {
        Payment storage p = payments[_paymentId];
        if (p.sender == address(0)) revert PaymentNotFound();
        if (p.status != ComplianceStatus.PASSED) {
            revert InvalidPaymentStatus(p.status, ComplianceStatus.PASSED);
        }

        // Re-evaluate both trust dependencies immediately before any state or
        // balance mutation. Registry suspension/expiry, gate pause, or seal
        // revocation therefore closes settlement after screening has passed.
        if (!IBusinessRegistry(businessRegistry).isBusinessActive(p.sender)) {
            revert NotRegisteredBusiness();
        }
        ISealSettlementGate(sealSettlementGate).requireCleared(p.sender, p.recipient);

        delete settlementRecoveryRequests[_paymentId];
        p.status = ComplianceStatus.SETTLED;
        p.settledAt = block.timestamp;

        uint256 fee = paymentFees[_paymentId];
        uint256 netAmount = p.amount - fee;

        IERC20(p.token).safeTransfer(p.recipient, netAmount);
        if (fee > 0) {
            IERC20(p.token).safeTransfer(treasury, fee);
        }

        emit PaymentSettled(_paymentId, block.timestamp, fee);
    }

    /**
     * @notice Refunds a blocked, flagged, or no-longer-settleable payment.
     * @dev BLOCKED refunds are permissionless. FLAGGED refunds require a
     *      compliance officer. A compliance officer may also recover PASSED
     *      escrow only after the live registry marks its sender inactive.
     * @param _paymentId Payment to refund.
     */
    function refundPayment(bytes32 _paymentId) external nonReentrant {
        Payment storage p = payments[_paymentId];
        if (p.sender == address(0)) revert PaymentNotFound();

        bool officer = hasRole(COMPLIANCE_OFFICER_ROLE, msg.sender);
        bool inactivePassed = p.status == ComplianceStatus.PASSED &&
            officer &&
            !IBusinessRegistry(businessRegistry).isBusinessActive(p.sender);
        bool canRefund = p.status == ComplianceStatus.BLOCKED ||
            (p.status == ComplianceStatus.FLAGGED && officer) ||
            inactivePassed;
        require(canRefund, "NoblePay: cannot refund this payment");

        delete settlementRecoveryRequests[_paymentId];
        p.status = ComplianceStatus.REFUNDED;

        IERC20(p.token).safeTransfer(p.sender, p.amount);

        emit PaymentRefunded(_paymentId, block.timestamp);
    }

    /**
     * @notice Cancels a PENDING payment. Only the original sender may cancel.
     * @param _paymentId Payment to cancel.
     */
    function cancelPayment(bytes32 _paymentId) external nonReentrant {
        Payment storage p = payments[_paymentId];
        if (p.sender == address(0)) revert PaymentNotFound();
        require(p.sender == msg.sender, "NoblePay: not payment sender");
        if (p.status != ComplianceStatus.PENDING) {
            revert InvalidPaymentStatus(p.status, ComplianceStatus.PENDING);
        }

        p.status = ComplianceStatus.REFUNDED;

        IERC20(p.token).safeTransfer(p.sender, p.amount);

        emit PaymentRefunded(_paymentId, block.timestamp);
    }

    // ──────────────────────────────────────────────────────────────
    // Admin functions
    // ──────────────────────────────────────────────────────────────

    /// @notice Atomically and permanently configures NoblePay's production
    ///         trust dependencies. There is deliberately no update path: a
    ///         migration requires a new NoblePay deployment and explicit
    ///         operational cut-over.
    function configureTrust(address _businessRegistry, address _sealSettlementGate)
        external
        onlyRole(ADMIN_ROLE)
    {
        if (trustConfigured) revert TrustAlreadyConfigured();
        if (_businessRegistry == address(0) || _businessRegistry.code.length == 0) {
            revert InvalidTrustContract(_businessRegistry);
        }
        if (_sealSettlementGate == address(0) || _sealSettlementGate.code.length == 0) {
            revert InvalidTrustContract(_sealSettlementGate);
        }

        businessRegistry = _businessRegistry;
        sealSettlementGate = _sealSettlementGate;
        trustConfigured = true;

        emit TrustConfigured(_businessRegistry, _sealSettlementGate);
    }

    /// @notice Adds or removes a supported 6-decimal USD-denominated ERC20 token.
    /// @dev Decimal validation is on-chain; governance is responsible for verifying
    ///      the token's issuer, USD denomination, upgrade controls, and transfer semantics.
    function setSupportedToken(address _token, bool _supported) external onlyRole(ADMIN_ROLE) {
        if (_token == address(0)) revert ZeroAddress();
        if (_supported) {
            if (_token.code.length == 0) revert InvalidTokenContract(_token);
            uint8 decimals = IERC20Metadata(_token).decimals();
            if (decimals != 6) revert InvalidTokenDecimals(_token, decimals);
        }
        supportedTokens[_token] = _supported;
        emit TokenSupported(_token, _supported);
    }

    /// @notice Updates the fee structure.
    function setFees(uint256 _baseFee, uint256 _percentageFee) external onlyRole(ADMIN_ROLE) {
        if (_percentageFee > MAX_PERCENTAGE_FEE) revert InvalidFee();
        baseFee = _baseFee;
        percentageFee = _percentageFee;
        emit FeeUpdated(_baseFee, _percentageFee);
    }

    /// @notice Updates the treasury address.
    function setTreasury(address _newTreasury) external onlyRole(TREASURY_ROLE) {
        if (_newTreasury == address(0)) revert ZeroAddress();
        address old = treasury;
        treasury = _newTreasury;
        emit TreasuryUpdated(old, _newTreasury);
    }

    /// @notice Syncs a business registration from the BusinessRegistry contract.
    function syncBusiness(
        address _business,
        BusinessTier _tier,
        bool _registered
    ) external onlyRole(ADMIN_ROLE) {
        // Retained for ABI compatibility and historical UI reads only. Payment
        // authorization and tiers are always sourced live from BusinessRegistry.
        registeredBusinesses[_business] = _registered;
        businessTiers[_business] = _tier;
        emit BusinessSynced(_business, _tier, _registered);
    }

    /// @notice Emergency pause — circuit breaker.
    function pause() external onlyRole(ADMIN_ROLE) {
        _pause();
    }

    /// @notice Resume operations after emergency.
    function unpause() external onlyRole(ADMIN_ROLE) {
        _unpause();
    }

    // ──────────────────────────────────────────────────────────────
    // View functions
    // ──────────────────────────────────────────────────────────────

    /// @notice Returns the full payment record.
    function getPayment(bytes32 _paymentId) external view returns (Payment memory) {
        return payments[_paymentId];
    }

    /// @notice Returns the immutable payment identifiers created atomically by a batch.
    function getBatchPaymentIds(bytes32 _batchId) external view returns (bytes32[] memory) {
        if (batches[_batchId].initiator == address(0)) revert BatchNotFound();
        return batches[_batchId].paymentIds;
    }

    /// @notice Returns the compliance result for a payment.
    function getComplianceResult(bytes32 _paymentId) external view returns (ComplianceResult memory) {
        return complianceResults[_paymentId];
    }

    /// @notice Returns daily volume limit for a given tier.
    function getDailyLimit(BusinessTier _tier) public pure returns (uint256) {
        if (_tier == BusinessTier.ENTERPRISE) return ENTERPRISE_DAILY_LIMIT;
        if (_tier == BusinessTier.PREMIUM) return PREMIUM_DAILY_LIMIT;
        return STANDARD_DAILY_LIMIT;
    }

    /// @notice Returns monthly volume limit for a given tier.
    function getMonthlyLimit(BusinessTier _tier) public pure returns (uint256) {
        if (_tier == BusinessTier.ENTERPRISE) return ENTERPRISE_MONTHLY_LIMIT;
        if (_tier == BusinessTier.PREMIUM) return PREMIUM_MONTHLY_LIMIT;
        return STANDARD_MONTHLY_LIMIT;
    }

    // ──────────────────────────────────────────────────────────────
    // Internal helpers
    // ──────────────────────────────────────────────────────────────

    /**
     * @dev Enforces daily and monthly volume limits based on business tier.
     * @param _business Business address.
     * @param _amount   Payment amount to validate.
     */
    function _enforceVolumeLimits(address _business, uint256 _amount) internal {
        if (!trustConfigured) revert TrustNotConfigured();
        uint8 rawTier = IBusinessRegistry(businessRegistry).getBusinessTier(_business);
        if (rawTier > uint8(BusinessTier.ENTERPRISE)) revert InvalidBusinessTier(rawTier);
        BusinessTier tier = BusinessTier(rawTier);

        // Daily limit check
        uint256 today = block.timestamp / 1 days;
        uint256 newDaily = dailyVolume[_business][today] + _amount;
        uint256 dailyLimit = getDailyLimit(tier);
        if (newDaily > dailyLimit) {
            revert DailyLimitExceeded(_amount, dailyLimit - dailyVolume[_business][today]);
        }
        dailyVolume[_business][today] = newDaily;

        // Monthly limit check
        uint256 month = block.timestamp / 30 days;
        uint256 newMonthly = monthlyVolume[_business][month] + _amount;
        uint256 monthLimit = getMonthlyLimit(tier);
        if (newMonthly > monthLimit) {
            revert MonthlyLimitExceeded(_amount, monthLimit - monthlyVolume[_business][month]);
        }
        monthlyVolume[_business][month] = newMonthly;
    }

    /**
     * @dev Calculates the total fee for a payment amount.
     * @param _amount Payment amount.
     * @return Total fee (baseFee + percentage).
     */
    function _calculateFee(uint256 _amount) internal view returns (uint256) {
        return baseFee + (_amount * percentageFee / 10_000);
    }

    /// @dev Executes the exact gate call used by settlement without propagating
    ///      a gate revert. A successful call means settlement is available; any
    ///      failure (missing/revoked clearance, gate pause, or missing gate code)
    ///      keeps recovery eligible. Treating malformed trust code as unavailable
    ///      can only return escrow to its original sender after governance delay.
    function _settlementGateAllows(address _sender, address _recipient) internal view returns (bool) {
        address gate = sealSettlementGate;
        if (gate.code.length == 0) return false;
        (bool success, ) = gate.staticcall(
            abi.encodeCall(ISealSettlementGate.requireCleared, (_sender, _recipient))
        );
        return success;
    }

    /// @dev Recovery must model the exact availability of {settlePayment}, not
    ///      only the external gate. A NoblePay emergency pause disables normal
    ///      settlement, so a still-cleared corridor remains recoverable after
    ///      the governed delay. If governance unpauses before execution, the
    ///      live gate is rechecked and restored availability cancels recovery.
    function _settlementAvailable(address _sender, address _recipient) internal view returns (bool) {
        return !paused() && _settlementGateAllows(_sender, _recipient);
    }

    function _escrowExact(address _token, address _from, uint256 _amount) internal {
        IERC20 token = IERC20(_token);
        uint256 beforeBalance = token.balanceOf(address(this));
        token.safeTransferFrom(_from, address(this), _amount);
        uint256 received = token.balanceOf(address(this)) - beforeBalance;
        if (received != _amount) revert NonExactTokenTransfer(_token, _amount, received);
    }

    /// @notice Rejects direct native transfers; NoblePay's production release is
    ///         scoped to approved 6-decimal USD stablecoins.
    receive() external payable {
        revert UnexpectedNativeValue(msg.value);
    }
}
