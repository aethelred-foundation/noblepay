// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title NoblePay
 * @author Aethelred Team
 * @notice Core cross-border payment contract for the NoblePay platform.
 *         Supports AET native token and ERC20 stablecoins (USDC/USDT) with
 *         TEE-backed compliance screening, FATF Travel Rule integration,
 *         and UAE regulatory compliance.
 *
 * @dev Architecture overview:
 *
 * ┌───────────────────────────────────────────────────────────────────┐
 * │                         NOBLEPAY CORE                            │
 * ├───────────────────────────────────────────────────────────────────┤
 * │  ┌─────────────┐  ┌──────────────────┐  ┌─────────────────┐    │
 * │  │  Payments    │  │  Compliance Gate  │  │  Settlement     │    │
 * │  │  ──────────  │  │  ──────────────── │  │  ────────────── │    │
 * │  │  • initiate  │  │  • TEE screening  │  │  • ERC20 xfer   │    │
 * │  │  • batch     │  │  • AML scoring    │  │  • native xfer  │    │
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
 *   - Compliance decisions are submitted exclusively by TEE nodes whose
 *     attestations have been verified by the ComplianceOracle contract.
 *   - PII never touches the chain; only hashed purpose codes and encrypted
 *     travel-rule data are stored on-chain.
 *   - Settlement is atomic: funds move only after compliance clearance.
 */
contract NoblePay is AccessControl, Pausable, ReentrancyGuard {
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
        address token;                // address(0) for native AET
        bytes32 purposeHash;          // keccak256 of encrypted purpose code
        ComplianceStatus status;
        bytes teeAttestation;         // TEE attestation for compliance proof
        uint256 createdAt;
        uint256 settledAt;
        bytes3 currencyCode;          // ISO 4217 code (e.g., "AED", "USD")
    }

    /// @notice Result of TEE-based compliance screening.
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

    // ──────────────────────────────────────────────────────────────
    // Fee configuration
    // ──────────────────────────────────────────────────────────────

    /// @notice Base fee in wei/smallest unit charged per payment.
    uint256 public baseFee;

    /// @notice Percentage fee in basis points (1 bp = 0.01%).
    uint256 public percentageFee;

    /// @notice Maximum percentage fee cap (500 bp = 5%).
    uint256 public constant MAX_PERCENTAGE_FEE = 500;

    /// @notice Address that receives collected fees.
    address public treasury;

    // ──────────────────────────────────────────────────────────────
    // Volume limits (in USD-equivalent, 6-decimal precision)
    // ──────────────────────────────────────────────────────────────

    /// @dev Daily limits per tier in smallest token unit (assuming 6 decimals).
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

    /// @notice Supported ERC20 tokens (token address => supported flag).
    mapping(address => bool) public supportedTokens;

    /// @notice Payment records keyed by payment ID.
    mapping(bytes32 => Payment) public payments;

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
    event BatchProcessed(bytes32 indexed batchId, uint256 paymentCount, uint256 totalAmount);
    event TokenSupported(address indexed token, bool supported);
    event FeeUpdated(uint256 baseFee, uint256 percentageFee);
    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);
    event BusinessSynced(address indexed business, BusinessTier tier, bool registered);

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
    error BatchAlreadyProcessed();
    error InsufficientPayment();

    // ──────────────────────────────────────────────────────────────
    // Modifiers
    // ──────────────────────────────────────────────────────────────

    /// @notice Restricts to registered businesses only.
    modifier onlyRegistered() {
        if (!registeredBusinesses[msg.sender]) revert NotRegisteredBusiness();
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
     * @param _baseFee       Flat fee per payment in wei.
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
     * @param _amount        Payment amount (token units or wei for native).
     * @param _token         ERC20 token address; address(0) for native AET.
     * @param _purposeHash   keccak256 hash of the encrypted payment purpose.
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

        // Validate token support
        if (_token != address(0) && !supportedTokens[_token]) revert UnsupportedToken();

        // Enforce volume limits
        _enforceVolumeLimits(msg.sender, _amount);

        // Generate unique payment ID
        paymentId = keccak256(abi.encodePacked(msg.sender, _recipient, _amount, block.timestamp, paymentNonce++));

        // Escrow funds
        if (_token == address(0)) {
            if (msg.value < _amount) revert InsufficientPayment();
        } else {
            IERC20(_token).safeTransferFrom(msg.sender, address(this), _amount);
        }

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

        emit PaymentInitiated(paymentId, msg.sender, _recipient, _amount, _token, _currencyCode);
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
        uint256 nativeRequired;

        for (uint256 i; i < count;) {
            if (_recipients[i] == address(0)) revert ZeroAddress();
            if (_amounts[i] == 0) revert ZeroAmount();

            bytes32 pid = keccak256(
                abi.encodePacked(msg.sender, _recipients[i], _amounts[i], block.timestamp, paymentNonce++)
            );
            paymentIds[i] = pid;

            if (_tokens[i] == address(0)) {
                nativeRequired += _amounts[i];
            } else {
                if (!supportedTokens[_tokens[i]]) revert UnsupportedToken();
                IERC20(_tokens[i]).safeTransferFrom(msg.sender, address(this), _amounts[i]);
            }

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

            totalAmount += _amounts[i];

            emit PaymentInitiated(pid, msg.sender, _recipients[i], _amounts[i], _tokens[i], _currencyCodes[i]);

            unchecked { ++i; }
        }

        if (msg.value < nativeRequired) revert InsufficientPayment();

        _enforceVolumeLimits(msg.sender, totalAmount);

        batches[batchId] = PaymentBatch({
            batchId: batchId,
            paymentIds: paymentIds,
            initiator: msg.sender,
            totalAmount: totalAmount,
            createdAt: block.timestamp,
            processed: false
        });

        emit BatchProcessed(batchId, count, totalAmount);
    }

    // ──────────────────────────────────────────────────────────────
    // External — Compliance (TEE-only)
    // ──────────────────────────────────────────────────────────────

    /**
     * @notice Submits a compliance screening result from a TEE node.
     * @dev Only callable by addresses with TEE_NODE_ROLE.
     * @param _paymentId       Payment to update.
     * @param _sanctionsClear  Whether the payment clears sanctions screening.
     * @param _amlRiskScore    AML risk score (0-100).
     * @param _travelRuleOk    Whether FATF Travel Rule requirements are met.
     * @param _investigationHash Hash of the full investigation report.
     * @param _attestation     TEE attestation bytes proving enclave execution.
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
     * @notice Settles a cleared payment, transferring funds to the recipient.
     * @param _paymentId Payment to settle.
     */
    function settlePayment(bytes32 _paymentId) external nonReentrant whenNotPaused {
        Payment storage p = payments[_paymentId];
        if (p.sender == address(0)) revert PaymentNotFound();
        if (p.status != ComplianceStatus.PASSED) {
            revert InvalidPaymentStatus(p.status, ComplianceStatus.PASSED);
        }

        p.status = ComplianceStatus.SETTLED;
        p.settledAt = block.timestamp;

        uint256 fee = _calculateFee(p.amount);
        uint256 netAmount = p.amount - fee;

        if (p.token == address(0)) {
            // Native AET transfer
            (bool ok, ) = p.recipient.call{value: netAmount}("");
            require(ok, "NoblePay: native transfer failed");
            if (fee > 0) {
                (bool feeOk, ) = treasury.call{value: fee}("");
                require(feeOk, "NoblePay: fee transfer failed");
            }
        } else {
            IERC20(p.token).safeTransfer(p.recipient, netAmount);
            if (fee > 0) {
                IERC20(p.token).safeTransfer(treasury, fee);
            }
        }

        emit PaymentSettled(_paymentId, block.timestamp, fee);
    }

    /**
     * @notice Refunds a blocked or flagged payment back to the sender.
     * @dev Callable by compliance officers for FLAGGED, or automatically for BLOCKED.
     * @param _paymentId Payment to refund.
     */
    function refundPayment(bytes32 _paymentId) external nonReentrant whenNotPaused {
        Payment storage p = payments[_paymentId];
        if (p.sender == address(0)) revert PaymentNotFound();

        // Only BLOCKED or FLAGGED payments can be refunded
        bool canRefund = p.status == ComplianceStatus.BLOCKED ||
            (p.status == ComplianceStatus.FLAGGED && hasRole(COMPLIANCE_OFFICER_ROLE, msg.sender));
        require(canRefund, "NoblePay: cannot refund this payment");

        p.status = ComplianceStatus.REFUNDED;

        if (p.token == address(0)) {
            (bool ok, ) = p.sender.call{value: p.amount}("");
            require(ok, "NoblePay: refund transfer failed");
        } else {
            IERC20(p.token).safeTransfer(p.sender, p.amount);
        }

        emit PaymentRefunded(_paymentId, block.timestamp);
    }

    /**
     * @notice Cancels a PENDING payment. Only the original sender may cancel.
     * @param _paymentId Payment to cancel.
     */
    function cancelPayment(bytes32 _paymentId) external nonReentrant whenNotPaused {
        Payment storage p = payments[_paymentId];
        if (p.sender == address(0)) revert PaymentNotFound();
        require(p.sender == msg.sender, "NoblePay: not payment sender");
        if (p.status != ComplianceStatus.PENDING) {
            revert InvalidPaymentStatus(p.status, ComplianceStatus.PENDING);
        }

        p.status = ComplianceStatus.REFUNDED;

        if (p.token == address(0)) {
            (bool ok, ) = p.sender.call{value: p.amount}("");
            require(ok, "NoblePay: cancel transfer failed");
        } else {
            IERC20(p.token).safeTransfer(p.sender, p.amount);
        }

        emit PaymentRefunded(_paymentId, block.timestamp);
    }

    // ──────────────────────────────────────────────────────────────
    // Admin functions
    // ──────────────────────────────────────────────────────────────

    /// @notice Adds or removes a supported ERC20 token.
    function setSupportedToken(address _token, bool _supported) external onlyRole(ADMIN_ROLE) {
        if (_token == address(0)) revert ZeroAddress();
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
        BusinessTier tier = businessTiers[_business];

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

    /// @notice Allows the contract to receive native AET.
    receive() external payable {}
}
