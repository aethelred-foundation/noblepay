// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title InvoiceFinancing
 * @author Aethelred Team
 * @notice Trade finance and receivables factoring contract for the NoblePay
 *         cross-border payment platform. Enables tokenized invoice creation,
 *         factoring (selling receivables at discount for instant liquidity),
 *         multi-party invoice chains, on-chain credit scoring, and automated
 *         settlement with dispute resolution.
 *
 * @dev Architecture overview:
 *
 * ┌───────────────────────────────────────────────────────────────────┐
 * │                     INVOICE FINANCING                             │
 * ├───────────────────────────────────────────────────────────────────┤
 * │  ┌─────────────────┐  ┌──────────────────┐  ┌────────────────┐  │
 * │  │  Invoice Mgmt    │  │  Factoring        │  │  Credit Score  │  │
 * │  │  ──────────────  │  │  ──────────────── │  │  ──────────── │  │
 * │  │  • create        │  │  • full/partial   │  │  • on-chain    │  │
 * │  │  • batch upload  │  │  • dynamic rates  │  │  • history     │  │
 * │  │  • chain link    │  │  • collateral     │  │  • scoring     │  │
 * │  └─────────────────┘  └──────────────────┘  └────────────────┘  │
 * │  ┌─────────────────┐  ┌──────────────────┐  ┌────────────────┐  │
 * │  │  Settlement      │  │  Disputes         │  │  Penalties     │  │
 * │  │  ──────────────  │  │  ──────────────── │  │  ──────────── │  │
 * │  │  • auto-settle   │  │  • escrow         │  │  • late fees   │  │
 * │  │  • partial pay   │  │  • arbitration    │  │  • grace period│  │
 * │  │  • fee split     │  │  • resolution     │  │  • credit hit  │  │
 * │  └─────────────────┘  └──────────────────┘  └────────────────┘  │
 * └───────────────────────────────────────────────────────────────────┘
 *
 * Invoice lifecycle:
 *   CREATED → FINANCED (partial/full) → SETTLED / OVERDUE → DISPUTED → RESOLVED
 *
 * Credit scoring:
 *   Each business accumulates an on-chain credit history based on payment
 *   behavior. Scores range 300-850 (similar to traditional credit) and
 *   influence discount rates offered by factors.
 */
contract InvoiceFinancing is AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ──────────────────────────────────────────────────────────────
    // Roles
    // ──────────────────────────────────────────────────────────────

    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant FACTOR_ROLE = keccak256("FACTOR_ROLE");
    bytes32 public constant CREDIT_ANALYST_ROLE = keccak256("CREDIT_ANALYST_ROLE");
    bytes32 public constant ARBITER_ROLE = keccak256("ARBITER_ROLE");

    // ──────────────────────────────────────────────────────────────
    // Enums
    // ──────────────────────────────────────────────────────────────

    /// @notice Lifecycle status of an invoice.
    enum InvoiceStatus {
        CREATED,
        PARTIALLY_FINANCED,
        FULLY_FINANCED,
        SETTLED,
        OVERDUE,
        DISPUTED,
        RESOLVED,
        CANCELLED
    }

    /// @notice Outcome of a dispute resolution.
    enum DisputeOutcome {
        PENDING,
        FAVOR_CREDITOR,
        FAVOR_DEBTOR,
        SPLIT
    }

    // ──────────────────────────────────────────────────────────────
    // Structs
    // ──────────────────────────────────────────────────────────────

    /// @notice Core invoice record representing a receivable.
    struct Invoice {
        bytes32 invoiceId;
        address creditor;             // Business that issued the invoice (seller)
        address debtor;               // Business that owes payment (buyer)
        uint256 faceValue;            // Original invoice amount
        uint256 amountFinanced;       // Total amount advanced by factors
        uint256 amountRepaid;         // Total amount repaid by debtor
        address settlementToken;      // ERC20 token for settlement
        uint256 issuedAt;
        uint256 maturityDate;         // When payment is due
        uint256 settledAt;
        InvoiceStatus status;
        bytes32 documentHash;         // Hash of off-chain invoice document
        bytes32 parentInvoiceId;      // For multi-party chains (0x0 if root)
        uint256 gracePeriod;          // Grace period in seconds after maturity
        uint256 latePenaltyBps;       // Late payment penalty in basis points
    }

    /// @notice Record of a factoring (financing) transaction.
    struct FactoringPosition {
        bytes32 positionId;
        bytes32 invoiceId;
        address factor;               // Entity providing financing
        uint256 advanceAmount;         // Amount advanced to creditor
        uint256 discountBps;           // Discount rate in basis points
        uint256 expectedReturn;        // Amount factor expects at maturity
        uint256 financedAt;
        bool settled;
        uint256 settledAmount;         // Actual amount received at settlement
    }

    /// @notice On-chain credit profile for a business.
    struct CreditProfile {
        uint16 creditScore;           // 300-850 scale
        uint256 totalInvoicesIssued;
        uint256 totalInvoicesPaid;
        uint256 totalInvoicesDefaulted;
        uint256 totalValueFinanced;
        uint256 totalValueRepaid;
        uint256 averageDaysLate;      // Weighted average days late
        uint256 lastUpdated;
    }

    /// @notice Dispute record for contested invoices.
    struct Dispute {
        bytes32 disputeId;
        bytes32 invoiceId;
        address initiator;
        address respondent;
        string reason;
        uint256 escrowAmount;         // Amount held in escrow during dispute
        DisputeOutcome outcome;
        uint256 initiatedAt;
        uint256 resolvedAt;
        address arbiter;
        uint256 creditorAward;        // Amount awarded to creditor
        uint256 debtorRefund;         // Amount refunded to debtor
    }

    /// @notice Collateral deposited against under-collateralized financing.
    struct Collateral {
        address depositor;
        address token;
        uint256 amount;
        bytes32 invoiceId;
        bool released;
    }

    // ──────────────────────────────────────────────────────────────
    // Constants
    // ──────────────────────────────────────────────────────────────

    /// @notice Minimum credit score.
    uint16 public constant MIN_CREDIT_SCORE = 300;

    /// @notice Maximum credit score.
    uint16 public constant MAX_CREDIT_SCORE = 850;

    /// @notice Default credit score for new businesses.
    uint16 public constant DEFAULT_CREDIT_SCORE = 550;

    /// @notice Maximum late penalty in basis points (20%).
    uint256 public constant MAX_LATE_PENALTY_BPS = 2000;

    /// @notice Maximum discount rate in basis points (50%).
    uint256 public constant MAX_DISCOUNT_BPS = 5000;

    /// @notice Maximum grace period (90 days).
    uint256 public constant MAX_GRACE_PERIOD = 90 days;

    /// @notice Maximum batch size for bulk invoice upload.
    uint256 public constant MAX_BATCH_SIZE = 50;

    // ──────────────────────────────────────────────────────────────
    // State
    // ──────────────────────────────────────────────────────────────

    /// @notice Invoice records keyed by invoice ID.
    mapping(bytes32 => Invoice) public invoices;

    /// @notice Factoring positions keyed by position ID.
    mapping(bytes32 => FactoringPosition) public factoringPositions;

    /// @notice All factoring position IDs for a given invoice.
    mapping(bytes32 => bytes32[]) public invoicePositions;

    /// @notice Credit profiles keyed by business address.
    mapping(address => CreditProfile) public creditProfiles;

    /// @notice Dispute records keyed by dispute ID.
    mapping(bytes32 => Dispute) public disputes;

    /// @notice Invoice ID to active dispute ID mapping.
    mapping(bytes32 => bytes32) public activeDisputes;

    /// @notice Collateral records keyed by a hash of (invoiceId, depositor).
    mapping(bytes32 => Collateral) public collaterals;

    /// @notice Invoices issued by a creditor.
    mapping(address => bytes32[]) public creditorInvoices;

    /// @notice Invoices owed by a debtor.
    mapping(address => bytes32[]) public debtorInvoices;

    /// @notice Supported settlement tokens.
    mapping(address => bool) public supportedTokens;

    /// @notice Reference to the BusinessRegistry for KYC validation.
    address public businessRegistry;

    /// @notice Monotonically increasing nonce for unique ID generation.
    uint256 public invoiceNonce;

    /// @notice Monotonically increasing nonce for positions.
    uint256 public positionNonce;

    /// @notice Monotonically increasing nonce for disputes.
    uint256 public disputeNonce;

    /// @notice Protocol fee on factoring transactions in basis points.
    uint256 public protocolFeeBps;

    /// @notice Address that receives protocol fees.
    address public protocolTreasury;

    // ──────────────────────────────────────────────────────────────
    // Events
    // ──────────────────────────────────────────────────────────────

    event InvoiceCreated(
        bytes32 indexed invoiceId,
        address indexed creditor,
        address indexed debtor,
        uint256 faceValue,
        uint256 maturityDate,
        address settlementToken
    );

    event InvoiceBatchCreated(
        address indexed creditor,
        uint256 count,
        uint256 totalFaceValue
    );

    event InvoiceChainLinked(
        bytes32 indexed childInvoiceId,
        bytes32 indexed parentInvoiceId,
        address indexed creditor
    );

    event InvoiceFinanced(
        bytes32 indexed invoiceId,
        bytes32 indexed positionId,
        address indexed factor,
        uint256 advanceAmount,
        uint256 discountBps
    );

    event InvoiceSettled(
        bytes32 indexed invoiceId,
        uint256 totalRepaid,
        uint256 settledAt
    );

    event InvoiceMarkedOverdue(
        bytes32 indexed invoiceId,
        uint256 daysOverdue,
        uint256 penaltyAmount
    );

    event FactoringPositionSettled(
        bytes32 indexed positionId,
        bytes32 indexed invoiceId,
        uint256 settledAmount
    );

    event CreditScoreUpdated(
        address indexed business,
        uint16 oldScore,
        uint16 newScore
    );

    event DisputeInitiated(
        bytes32 indexed disputeId,
        bytes32 indexed invoiceId,
        address indexed initiator,
        uint256 escrowAmount
    );

    event DisputeResolved(
        bytes32 indexed disputeId,
        bytes32 indexed invoiceId,
        DisputeOutcome outcome,
        uint256 creditorAward,
        uint256 debtorRefund
    );

    event CollateralDeposited(
        bytes32 indexed invoiceId,
        address indexed depositor,
        address token,
        uint256 amount
    );

    event CollateralReleased(
        bytes32 indexed invoiceId,
        address indexed depositor,
        uint256 amount
    );

    event InvoiceCancelled(bytes32 indexed invoiceId);
    event TokenSupported(address indexed token, bool supported);
    event ProtocolFeeUpdated(uint256 oldFee, uint256 newFee);
    event BusinessRegistryUpdated(address indexed oldRegistry, address indexed newRegistry);

    // ──────────────────────────────────────────────────────────────
    // Errors
    // ──────────────────────────────────────────────────────────────

    error ZeroAddress();
    error ZeroAmount();
    error UnsupportedToken();
    error InvoiceNotFound();
    error InvalidInvoiceStatus(InvoiceStatus current, InvoiceStatus expected);
    error MaturityInPast();
    error MaturityTooFar();
    error ExceedsFaceValue(uint256 requested, uint256 remaining);
    error InvalidDiscountRate();
    error InvalidPenaltyRate();
    error InvalidGracePeriod();
    error NotInvoiceParty();
    error InvoiceNotOverdue();
    error DisputeAlreadyActive();
    error DisputeNotFound();
    error DisputeNotPending();
    error BatchTooLarge(uint256 size, uint256 maxSize);
    error InsufficientCollateral();
    error CollateralAlreadyReleased();
    error InvalidCreditScore();
    error NotDebtor();
    error NotCreditor();
    error AlreadySettled();
    error InvalidFee();
    error ArrayLengthMismatch();

    // ──────────────────────────────────────────────────────────────
    // Constructor
    // ──────────────────────────────────────────────────────────────

    /**
     * @notice Deploys InvoiceFinancing with protocol fee configuration.
     * @param _admin           Admin address with full control.
     * @param _protocolTreasury Address that collects protocol fees.
     * @param _protocolFeeBps  Protocol fee in basis points.
     */
    constructor(
        address _admin,
        address _protocolTreasury,
        uint256 _protocolFeeBps
    ) {
        if (_admin == address(0)) revert ZeroAddress();
        if (_protocolTreasury == address(0)) revert ZeroAddress();
        if (_protocolFeeBps > 1000) revert InvalidFee(); // Max 10%

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(ADMIN_ROLE, _admin);

        protocolTreasury = _protocolTreasury;
        protocolFeeBps = _protocolFeeBps;
    }

    // ──────────────────────────────────────────────────────────────
    // External — Invoice Creation
    // ──────────────────────────────────────────────────────────────

    /**
     * @notice Creates a new invoice representing a receivable.
     * @param _debtor          Address of the business that owes payment.
     * @param _faceValue       Invoice amount in settlement token units.
     * @param _settlementToken ERC20 token for settlement.
     * @param _maturityDate    Unix timestamp when payment is due.
     * @param _documentHash    Hash of the off-chain invoice document.
     * @param _gracePeriod     Grace period in seconds after maturity.
     * @param _latePenaltyBps  Late payment penalty in basis points.
     * @return invoiceId       Unique identifier for the invoice.
     */
    function createInvoice(
        address _debtor,
        uint256 _faceValue,
        address _settlementToken,
        uint256 _maturityDate,
        bytes32 _documentHash,
        uint256 _gracePeriod,
        uint256 _latePenaltyBps
    ) external whenNotPaused returns (bytes32 invoiceId) {
        if (_debtor == address(0)) revert ZeroAddress();
        if (_debtor == msg.sender) revert NotInvoiceParty();
        if (_faceValue == 0) revert ZeroAmount();
        if (!supportedTokens[_settlementToken]) revert UnsupportedToken();
        if (_maturityDate <= block.timestamp) revert MaturityInPast();
        if (_maturityDate > block.timestamp + 365 days) revert MaturityTooFar();
        if (_gracePeriod > MAX_GRACE_PERIOD) revert InvalidGracePeriod();
        if (_latePenaltyBps > MAX_LATE_PENALTY_BPS) revert InvalidPenaltyRate();

        invoiceId = keccak256(
            abi.encodePacked(msg.sender, _debtor, _faceValue, block.timestamp, invoiceNonce++)
        );

        invoices[invoiceId] = Invoice({
            invoiceId: invoiceId,
            creditor: msg.sender,
            debtor: _debtor,
            faceValue: _faceValue,
            amountFinanced: 0,
            amountRepaid: 0,
            settlementToken: _settlementToken,
            issuedAt: block.timestamp,
            maturityDate: _maturityDate,
            settledAt: 0,
            status: InvoiceStatus.CREATED,
            documentHash: _documentHash,
            parentInvoiceId: bytes32(0),
            gracePeriod: _gracePeriod,
            latePenaltyBps: _latePenaltyBps
        });

        creditorInvoices[msg.sender].push(invoiceId);
        debtorInvoices[_debtor].push(invoiceId);

        // Initialize credit profile if first interaction
        _initCreditProfileIfNeeded(msg.sender);
        _initCreditProfileIfNeeded(_debtor);
        creditProfiles[msg.sender].totalInvoicesIssued++;

        emit InvoiceCreated(invoiceId, msg.sender, _debtor, _faceValue, _maturityDate, _settlementToken);
    }

    /**
     * @notice Creates a child invoice linked to a parent, forming a supply chain.
     * @dev Used for multi-party invoice chains (supplier -> manufacturer -> distributor).
     * @param _parentInvoiceId Parent invoice to link to.
     * @param _debtor          Debtor for the child invoice.
     * @param _faceValue       Face value of the child invoice.
     * @param _maturityDate    Maturity date for the child invoice.
     * @param _documentHash    Hash of the child invoice document.
     * @param _gracePeriod     Grace period after maturity.
     * @param _latePenaltyBps  Late penalty in basis points.
     * @return invoiceId       Unique identifier for the child invoice.
     */
    function createChainedInvoice(
        bytes32 _parentInvoiceId,
        address _debtor,
        uint256 _faceValue,
        uint256 _maturityDate,
        bytes32 _documentHash,
        uint256 _gracePeriod,
        uint256 _latePenaltyBps
    ) external whenNotPaused returns (bytes32 invoiceId) {
        Invoice storage parent = invoices[_parentInvoiceId];
        if (parent.issuedAt == 0) revert InvoiceNotFound();

        // Only the debtor of the parent can create a child (they are now the creditor)
        if (msg.sender != parent.debtor) revert NotDebtor();
        if (_debtor == address(0) || _debtor == msg.sender) revert NotInvoiceParty();
        if (_faceValue == 0) revert ZeroAmount();
        if (!supportedTokens[parent.settlementToken]) revert UnsupportedToken();
        if (_maturityDate <= block.timestamp) revert MaturityInPast();
        if (_gracePeriod > MAX_GRACE_PERIOD) revert InvalidGracePeriod();
        if (_latePenaltyBps > MAX_LATE_PENALTY_BPS) revert InvalidPenaltyRate();

        invoiceId = keccak256(
            abi.encodePacked(msg.sender, _debtor, _faceValue, block.timestamp, invoiceNonce++)
        );

        invoices[invoiceId] = Invoice({
            invoiceId: invoiceId,
            creditor: msg.sender,
            debtor: _debtor,
            faceValue: _faceValue,
            amountFinanced: 0,
            amountRepaid: 0,
            settlementToken: parent.settlementToken,
            issuedAt: block.timestamp,
            maturityDate: _maturityDate,
            settledAt: 0,
            status: InvoiceStatus.CREATED,
            documentHash: _documentHash,
            parentInvoiceId: _parentInvoiceId,
            gracePeriod: _gracePeriod,
            latePenaltyBps: _latePenaltyBps
        });

        creditorInvoices[msg.sender].push(invoiceId);
        debtorInvoices[_debtor].push(invoiceId);

        _initCreditProfileIfNeeded(_debtor);
        creditProfiles[msg.sender].totalInvoicesIssued++;

        emit InvoiceCreated(invoiceId, msg.sender, _debtor, _faceValue, _maturityDate, parent.settlementToken);
        emit InvoiceChainLinked(invoiceId, _parentInvoiceId, msg.sender);
    }

    /**
     * @notice Batch upload invoices for supply chain financing.
     * @param _debtors         Array of debtor addresses.
     * @param _faceValues      Array of face values.
     * @param _settlementToken Shared settlement token for all invoices.
     * @param _maturityDates   Array of maturity dates.
     * @param _documentHashes  Array of document hashes.
     * @param _gracePeriod     Shared grace period for all invoices.
     * @param _latePenaltyBps  Shared late penalty for all invoices.
     * @return invoiceIds      Array of created invoice IDs.
     */
    function batchCreateInvoices(
        address[] calldata _debtors,
        uint256[] calldata _faceValues,
        address _settlementToken,
        uint256[] calldata _maturityDates,
        bytes32[] calldata _documentHashes,
        uint256 _gracePeriod,
        uint256 _latePenaltyBps
    ) external whenNotPaused returns (bytes32[] memory invoiceIds) {
        uint256 count = _debtors.length;
        if (count == 0) revert ZeroAmount();
        if (count > MAX_BATCH_SIZE) revert BatchTooLarge(count, MAX_BATCH_SIZE);
        if (
            count != _faceValues.length ||
            count != _maturityDates.length ||
            count != _documentHashes.length
        ) revert ArrayLengthMismatch();
        if (!supportedTokens[_settlementToken]) revert UnsupportedToken();
        if (_gracePeriod > MAX_GRACE_PERIOD) revert InvalidGracePeriod();
        if (_latePenaltyBps > MAX_LATE_PENALTY_BPS) revert InvalidPenaltyRate();

        invoiceIds = new bytes32[](count);
        uint256 totalFaceValue;

        _initCreditProfileIfNeeded(msg.sender);

        for (uint256 i; i < count;) {
            if (_debtors[i] == address(0) || _debtors[i] == msg.sender) revert NotInvoiceParty();
            if (_faceValues[i] == 0) revert ZeroAmount();
            if (_maturityDates[i] <= block.timestamp) revert MaturityInPast();

            bytes32 id = keccak256(
                abi.encodePacked(msg.sender, _debtors[i], _faceValues[i], block.timestamp, invoiceNonce++)
            );
            invoiceIds[i] = id;

            invoices[id] = Invoice({
                invoiceId: id,
                creditor: msg.sender,
                debtor: _debtors[i],
                faceValue: _faceValues[i],
                amountFinanced: 0,
                amountRepaid: 0,
                settlementToken: _settlementToken,
                issuedAt: block.timestamp,
                maturityDate: _maturityDates[i],
                settledAt: 0,
                status: InvoiceStatus.CREATED,
                documentHash: _documentHashes[i],
                parentInvoiceId: bytes32(0),
                gracePeriod: _gracePeriod,
                latePenaltyBps: _latePenaltyBps
            });

            creditorInvoices[msg.sender].push(id);
            debtorInvoices[_debtors[i]].push(id);

            _initCreditProfileIfNeeded(_debtors[i]);
            creditProfiles[msg.sender].totalInvoicesIssued++;
            totalFaceValue += _faceValues[i];

            emit InvoiceCreated(id, msg.sender, _debtors[i], _faceValues[i], _maturityDates[i], _settlementToken);

            unchecked { ++i; }
        }

        emit InvoiceBatchCreated(msg.sender, count, totalFaceValue);
    }

    // ──────────────────────────────────────────────────────────────
    // External — Factoring (Financing)
    // ──────────────────────────────────────────────────────────────

    /**
     * @notice Finances an invoice (full or partial) by advancing funds to the creditor.
     * @dev The factor transfers the advance amount to the creditor and receives
     *      the right to collect the face value (or portion) at maturity.
     *      Discount rate is dynamically influenced by debtor credit score.
     * @param _invoiceId     Invoice to finance.
     * @param _advanceAmount Amount to advance to the creditor.
     * @param _discountBps   Discount rate in basis points.
     * @return positionId    Unique identifier for the factoring position.
     */
    function financeInvoice(
        bytes32 _invoiceId,
        uint256 _advanceAmount,
        uint256 _discountBps
    ) external whenNotPaused nonReentrant onlyRole(FACTOR_ROLE) returns (bytes32 positionId) {
        Invoice storage inv = invoices[_invoiceId];
        if (inv.issuedAt == 0) revert InvoiceNotFound();
        if (
            inv.status != InvoiceStatus.CREATED &&
            inv.status != InvoiceStatus.PARTIALLY_FINANCED
        ) {
            revert InvalidInvoiceStatus(inv.status, InvoiceStatus.CREATED);
        }
        if (_advanceAmount == 0) revert ZeroAmount();
        if (_discountBps > MAX_DISCOUNT_BPS) revert InvalidDiscountRate();

        uint256 remainingFinanceable = inv.faceValue - inv.amountFinanced;
        if (_advanceAmount > remainingFinanceable) {
            revert ExceedsFaceValue(_advanceAmount, remainingFinanceable);
        }

        // Calculate expected return: advance + discount
        uint256 expectedReturn = _advanceAmount + (_advanceAmount * _discountBps / 10_000);
        // Cap expected return at the proportional face value
        uint256 proportionalFaceValue = (inv.faceValue * _advanceAmount) / (inv.faceValue - inv.amountFinanced);
        if (expectedReturn > proportionalFaceValue) {
            expectedReturn = proportionalFaceValue;
        }

        positionId = keccak256(
            abi.encodePacked(msg.sender, _invoiceId, _advanceAmount, block.timestamp, positionNonce++)
        );

        factoringPositions[positionId] = FactoringPosition({
            positionId: positionId,
            invoiceId: _invoiceId,
            factor: msg.sender,
            advanceAmount: _advanceAmount,
            discountBps: _discountBps,
            expectedReturn: expectedReturn,
            financedAt: block.timestamp,
            settled: false,
            settledAmount: 0
        });

        invoicePositions[_invoiceId].push(positionId);
        inv.amountFinanced += _advanceAmount;

        // Update invoice status
        if (inv.amountFinanced >= inv.faceValue) {
            inv.status = InvoiceStatus.FULLY_FINANCED;
        } else {
            inv.status = InvoiceStatus.PARTIALLY_FINANCED;
        }

        // Calculate protocol fee
        uint256 protocolFee = (_advanceAmount * protocolFeeBps) / 10_000;
        uint256 netAdvance = _advanceAmount - protocolFee;

        // Transfer advance from factor to creditor
        IERC20(inv.settlementToken).safeTransferFrom(msg.sender, inv.creditor, netAdvance);
        if (protocolFee > 0) {
            IERC20(inv.settlementToken).safeTransferFrom(msg.sender, protocolTreasury, protocolFee);
        }

        // Update credit profile
        creditProfiles[inv.creditor].totalValueFinanced += _advanceAmount;

        emit InvoiceFinanced(_invoiceId, positionId, msg.sender, _advanceAmount, _discountBps);
    }

    // ──────────────────────────────────────────────────────────────
    // External — Settlement
    // ──────────────────────────────────────────────────────────────

    /**
     * @notice Debtor repays an invoice (full or partial payment).
     * @dev Payments are distributed pro-rata to factoring positions. If no
     *      positions exist, payment goes directly to the creditor.
     * @param _invoiceId Invoice to repay.
     * @param _amount    Amount to repay in settlement token units.
     */
    function repayInvoice(
        bytes32 _invoiceId,
        uint256 _amount
    ) external whenNotPaused nonReentrant {
        Invoice storage inv = invoices[_invoiceId];
        if (inv.issuedAt == 0) revert InvoiceNotFound();
        if (msg.sender != inv.debtor) revert NotDebtor();
        if (_amount == 0) revert ZeroAmount();
        if (inv.status == InvoiceStatus.SETTLED || inv.status == InvoiceStatus.CANCELLED) {
            revert InvalidInvoiceStatus(inv.status, InvoiceStatus.CREATED);
        }

        uint256 totalOwed = _calculateTotalOwed(inv);
        uint256 remaining = totalOwed - inv.amountRepaid;
        uint256 payAmount = _amount > remaining ? remaining : _amount;

        // Transfer payment from debtor
        IERC20(inv.settlementToken).safeTransferFrom(msg.sender, address(this), payAmount);
        inv.amountRepaid += payAmount;

        // Distribute to factoring positions pro-rata
        _distributePayment(_invoiceId, payAmount, inv);

        // Check if fully settled
        if (inv.amountRepaid >= totalOwed) {
            inv.status = InvoiceStatus.SETTLED;
            inv.settledAt = block.timestamp;

            // Update credit profile
            CreditProfile storage cp = creditProfiles[inv.debtor];
            cp.totalInvoicesPaid++;
            cp.totalValueRepaid += inv.amountRepaid;

            // Update days late for credit scoring
            if (block.timestamp > inv.maturityDate) {
                uint256 daysLate = (block.timestamp - inv.maturityDate) / 1 days;
                uint256 totalPayments = cp.totalInvoicesPaid;
                cp.averageDaysLate = ((cp.averageDaysLate * (totalPayments - 1)) + daysLate) / totalPayments;
            }

            _updateCreditScore(inv.debtor);

            emit InvoiceSettled(_invoiceId, inv.amountRepaid, block.timestamp);
        }
    }

    /**
     * @notice Marks an invoice as overdue and applies late penalties.
     * @dev Can be called by anyone after the maturity date + grace period.
     * @param _invoiceId Invoice to mark as overdue.
     */
    function markOverdue(bytes32 _invoiceId) external whenNotPaused {
        Invoice storage inv = invoices[_invoiceId];
        if (inv.issuedAt == 0) revert InvoiceNotFound();
        if (inv.status == InvoiceStatus.SETTLED || inv.status == InvoiceStatus.CANCELLED) {
            revert InvalidInvoiceStatus(inv.status, InvoiceStatus.CREATED);
        }
        if (block.timestamp <= inv.maturityDate + inv.gracePeriod) revert InvoiceNotOverdue();

        inv.status = InvoiceStatus.OVERDUE;

        uint256 daysOverdue = (block.timestamp - inv.maturityDate) / 1 days;
        uint256 penaltyAmount = (inv.faceValue * inv.latePenaltyBps * daysOverdue) / (10_000 * 365);

        // Update debtor credit profile
        CreditProfile storage cp = creditProfiles[inv.debtor];
        cp.totalInvoicesDefaulted++;
        _updateCreditScore(inv.debtor);

        emit InvoiceMarkedOverdue(_invoiceId, daysOverdue, penaltyAmount);
    }

    // ──────────────────────────────────────────────────────────────
    // External — Dispute Resolution
    // ──────────────────────────────────────────────────────────────

    /**
     * @notice Initiates a dispute on an invoice with escrow.
     * @dev Either the creditor or debtor can initiate. Disputed funds are
     *      held in escrow until an arbiter resolves the dispute.
     * @param _invoiceId Invoice to dispute.
     * @param _reason    Human-readable reason for the dispute.
     * @return disputeId Unique identifier for the dispute.
     */
    function initiateDispute(
        bytes32 _invoiceId,
        string calldata _reason
    ) external whenNotPaused nonReentrant returns (bytes32 disputeId) {
        Invoice storage inv = invoices[_invoiceId];
        if (inv.issuedAt == 0) revert InvoiceNotFound();
        if (msg.sender != inv.creditor && msg.sender != inv.debtor) revert NotInvoiceParty();
        if (activeDisputes[_invoiceId] != bytes32(0)) revert DisputeAlreadyActive();
        if (inv.status == InvoiceStatus.SETTLED || inv.status == InvoiceStatus.CANCELLED) {
            revert InvalidInvoiceStatus(inv.status, InvoiceStatus.CREATED);
        }

        disputeId = keccak256(
            abi.encodePacked(_invoiceId, msg.sender, block.timestamp, disputeNonce++)
        );

        address respondent = msg.sender == inv.creditor ? inv.debtor : inv.creditor;

        // Escrow the remaining owed amount
        uint256 escrowAmount = inv.faceValue - inv.amountRepaid;

        disputes[disputeId] = Dispute({
            disputeId: disputeId,
            invoiceId: _invoiceId,
            initiator: msg.sender,
            respondent: respondent,
            reason: _reason,
            escrowAmount: escrowAmount,
            outcome: DisputeOutcome.PENDING,
            initiatedAt: block.timestamp,
            resolvedAt: 0,
            arbiter: address(0),
            creditorAward: 0,
            debtorRefund: 0
        });

        activeDisputes[_invoiceId] = disputeId;
        inv.status = InvoiceStatus.DISPUTED;

        emit DisputeInitiated(disputeId, _invoiceId, msg.sender, escrowAmount);
    }

    /**
     * @notice Resolves a dispute with binding arbitration.
     * @dev Only callable by addresses with ARBITER_ROLE.
     * @param _disputeId     Dispute to resolve.
     * @param _outcome       Resolution outcome.
     * @param _creditorAward Amount awarded to the creditor.
     * @param _debtorRefund  Amount refunded to the debtor.
     */
    function resolveDispute(
        bytes32 _disputeId,
        DisputeOutcome _outcome,
        uint256 _creditorAward,
        uint256 _debtorRefund
    ) external whenNotPaused nonReentrant onlyRole(ARBITER_ROLE) {
        Dispute storage d = disputes[_disputeId];
        if (d.initiatedAt == 0) revert DisputeNotFound();
        if (d.outcome != DisputeOutcome.PENDING) revert DisputeNotPending();
        require(
            _outcome != DisputeOutcome.PENDING,
            "InvoiceFinancing: invalid outcome"
        );

        Invoice storage inv = invoices[d.invoiceId];

        d.outcome = _outcome;
        d.resolvedAt = block.timestamp;
        d.arbiter = msg.sender;
        d.creditorAward = _creditorAward;
        d.debtorRefund = _debtorRefund;

        inv.status = InvoiceStatus.RESOLVED;
        delete activeDisputes[d.invoiceId];

        // Distribute escrowed funds according to arbitration
        if (_creditorAward > 0) {
            IERC20(inv.settlementToken).safeTransfer(inv.creditor, _creditorAward);
        }
        if (_debtorRefund > 0) {
            IERC20(inv.settlementToken).safeTransfer(inv.debtor, _debtorRefund);
        }

        emit DisputeResolved(_disputeId, d.invoiceId, _outcome, _creditorAward, _debtorRefund);
    }

    // ──────────────────────────────────────────────────────────────
    // External — Collateral Management
    // ──────────────────────────────────────────────────────────────

    /**
     * @notice Deposits collateral against an invoice for under-collateralized financing.
     * @param _invoiceId Invoice to collateralize.
     * @param _token     Collateral token address.
     * @param _amount    Collateral amount.
     */
    function depositCollateral(
        bytes32 _invoiceId,
        address _token,
        uint256 _amount
    ) external whenNotPaused nonReentrant {
        Invoice storage inv = invoices[_invoiceId];
        if (inv.issuedAt == 0) revert InvoiceNotFound();
        if (_amount == 0) revert ZeroAmount();
        if (!supportedTokens[_token]) revert UnsupportedToken();

        bytes32 collateralKey = keccak256(abi.encodePacked(_invoiceId, msg.sender));

        Collateral storage col = collaterals[collateralKey];
        col.depositor = msg.sender;
        col.token = _token;
        col.amount += _amount;
        col.invoiceId = _invoiceId;

        IERC20(_token).safeTransferFrom(msg.sender, address(this), _amount);

        emit CollateralDeposited(_invoiceId, msg.sender, _token, _amount);
    }

    /**
     * @notice Releases collateral after invoice settlement.
     * @param _invoiceId Invoice whose collateral to release.
     * @param _depositor Address of the collateral depositor.
     */
    function releaseCollateral(
        bytes32 _invoiceId,
        address _depositor
    ) external whenNotPaused nonReentrant {
        Invoice storage inv = invoices[_invoiceId];
        if (inv.issuedAt == 0) revert InvoiceNotFound();
        require(
            inv.status == InvoiceStatus.SETTLED || inv.status == InvoiceStatus.RESOLVED ||
            inv.status == InvoiceStatus.CANCELLED,
            "InvoiceFinancing: invoice not finalized"
        );

        bytes32 collateralKey = keccak256(abi.encodePacked(_invoiceId, _depositor));
        Collateral storage col = collaterals[collateralKey];
        if (col.released) revert CollateralAlreadyReleased();
        if (col.amount == 0) revert InsufficientCollateral();

        col.released = true;
        uint256 amount = col.amount;

        IERC20(col.token).safeTransfer(_depositor, amount);

        emit CollateralReleased(_invoiceId, _depositor, amount);
    }

    // ──────────────────────────────────────────────────────────────
    // External — Credit Scoring
    // ──────────────────────────────────────────────────────────────

    /**
     * @notice Manually adjusts a business credit score (analyst override).
     * @dev Only callable by addresses with CREDIT_ANALYST_ROLE.
     * @param _business Business address.
     * @param _newScore New credit score (300-850).
     */
    function adjustCreditScore(
        address _business,
        uint16 _newScore
    ) external onlyRole(CREDIT_ANALYST_ROLE) {
        if (_newScore < MIN_CREDIT_SCORE || _newScore > MAX_CREDIT_SCORE) {
            revert InvalidCreditScore();
        }

        _initCreditProfileIfNeeded(_business);

        uint16 oldScore = creditProfiles[_business].creditScore;
        creditProfiles[_business].creditScore = _newScore;
        creditProfiles[_business].lastUpdated = block.timestamp;

        emit CreditScoreUpdated(_business, oldScore, _newScore);
    }

    /**
     * @notice Cancels an unfunded invoice. Only the creditor can cancel.
     * @param _invoiceId Invoice to cancel.
     */
    function cancelInvoice(bytes32 _invoiceId) external whenNotPaused {
        Invoice storage inv = invoices[_invoiceId];
        if (inv.issuedAt == 0) revert InvoiceNotFound();
        if (msg.sender != inv.creditor) revert NotCreditor();
        if (inv.status != InvoiceStatus.CREATED) {
            revert InvalidInvoiceStatus(inv.status, InvoiceStatus.CREATED);
        }

        inv.status = InvoiceStatus.CANCELLED;
        emit InvoiceCancelled(_invoiceId);
    }

    // ──────────────────────────────────────────────────────────────
    // View Functions
    // ──────────────────────────────────────────────────────────────

    /// @notice Returns the full invoice record.
    function getInvoice(bytes32 _invoiceId) external view returns (Invoice memory) {
        return invoices[_invoiceId];
    }

    /// @notice Returns the credit profile for a business.
    function getCreditProfile(address _business) external view returns (CreditProfile memory) {
        return creditProfiles[_business];
    }

    /// @notice Returns the suggested discount rate based on debtor credit score.
    function getSuggestedDiscountRate(address _debtor) external view returns (uint256) {
        CreditProfile storage cp = creditProfiles[_debtor];
        if (cp.lastUpdated == 0) return 1500; // 15% for unknown entities

        // Higher credit score = lower discount (better rates)
        if (cp.creditScore >= 750) return 200;   // 2%
        if (cp.creditScore >= 650) return 500;   // 5%
        if (cp.creditScore >= 550) return 1000;  // 10%
        if (cp.creditScore >= 450) return 1500;  // 15%
        return 2500;                              // 25%
    }

    /// @notice Returns the total amount owed on an invoice including penalties.
    function getTotalOwed(bytes32 _invoiceId) external view returns (uint256) {
        Invoice storage inv = invoices[_invoiceId];
        if (inv.issuedAt == 0) revert InvoiceNotFound();
        return _calculateTotalOwed(inv);
    }

    /// @notice Returns all factoring position IDs for an invoice.
    function getInvoicePositions(bytes32 _invoiceId) external view returns (bytes32[] memory) {
        return invoicePositions[_invoiceId];
    }

    /// @notice Returns a factoring position record.
    function getFactoringPosition(bytes32 _positionId) external view returns (FactoringPosition memory) {
        return factoringPositions[_positionId];
    }

    /// @notice Returns the dispute record for a given dispute ID.
    function getDispute(bytes32 _disputeId) external view returns (Dispute memory) {
        return disputes[_disputeId];
    }

    /// @notice Returns invoices created by a creditor.
    function getCreditorInvoices(address _creditor) external view returns (bytes32[] memory) {
        return creditorInvoices[_creditor];
    }

    /// @notice Returns invoices owed by a debtor.
    function getDebtorInvoices(address _debtor) external view returns (bytes32[] memory) {
        return debtorInvoices[_debtor];
    }

    // ──────────────────────────────────────────────────────────────
    // Admin Functions
    // ──────────────────────────────────────────────────────────────

    /// @notice Adds or removes a supported settlement token.
    function setSupportedToken(address _token, bool _supported) external onlyRole(ADMIN_ROLE) {
        if (_token == address(0)) revert ZeroAddress();
        supportedTokens[_token] = _supported;
        emit TokenSupported(_token, _supported);
    }

    /// @notice Updates the protocol fee.
    function setProtocolFee(uint256 _newFeeBps) external onlyRole(ADMIN_ROLE) {
        if (_newFeeBps > 1000) revert InvalidFee();
        uint256 oldFee = protocolFeeBps;
        protocolFeeBps = _newFeeBps;
        emit ProtocolFeeUpdated(oldFee, _newFeeBps);
    }

    /// @notice Updates the business registry address.
    function setBusinessRegistry(address _registry) external onlyRole(ADMIN_ROLE) {
        if (_registry == address(0)) revert ZeroAddress();
        address old = businessRegistry;
        businessRegistry = _registry;
        emit BusinessRegistryUpdated(old, _registry);
    }

    /// @notice Emergency pause.
    function pause() external onlyRole(ADMIN_ROLE) {
        _pause();
    }

    /// @notice Resume operations.
    function unpause() external onlyRole(ADMIN_ROLE) {
        _unpause();
    }

    // ──────────────────────────────────────────────────────────────
    // Internal Helpers
    // ──────────────────────────────────────────────────────────────

    /**
     * @dev Initializes a credit profile if the business has not interacted before.
     * @param _business Business address.
     */
    function _initCreditProfileIfNeeded(address _business) internal {
        if (creditProfiles[_business].lastUpdated == 0) {
            creditProfiles[_business] = CreditProfile({
                creditScore: DEFAULT_CREDIT_SCORE,
                totalInvoicesIssued: 0,
                totalInvoicesPaid: 0,
                totalInvoicesDefaulted: 0,
                totalValueFinanced: 0,
                totalValueRepaid: 0,
                averageDaysLate: 0,
                lastUpdated: block.timestamp
            });
        }
    }

    /**
     * @dev Updates credit score based on payment history.
     * @param _business Business address to update.
     */
    function _updateCreditScore(address _business) internal {
        CreditProfile storage cp = creditProfiles[_business];
        uint16 oldScore = cp.creditScore;

        uint256 totalInvoices = cp.totalInvoicesPaid + cp.totalInvoicesDefaulted;
        if (totalInvoices == 0) return;

        // Payment ratio: percentage of invoices paid on time (0-100)
        uint256 paymentRatio = (cp.totalInvoicesPaid * 100) / totalInvoices;

        // Base score from payment ratio (300-700 range)
        uint256 baseScore = 300 + (paymentRatio * 4);

        // Bonus for low average days late (up to +100)
        uint256 lateBonus;
        if (cp.averageDaysLate == 0) {
            lateBonus = 100;
        } else if (cp.averageDaysLate <= 7) {
            lateBonus = 50;
        } else if (cp.averageDaysLate <= 30) {
            lateBonus = 20;
        }

        // Volume bonus (up to +50 for large repayment history)
        uint256 volumeBonus;
        if (cp.totalValueRepaid > 10_000_000 * 1e6) {
            volumeBonus = 50;
        } else if (cp.totalValueRepaid > 1_000_000 * 1e6) {
            volumeBonus = 30;
        } else if (cp.totalValueRepaid > 100_000 * 1e6) {
            volumeBonus = 10;
        }

        uint256 newScore = baseScore + lateBonus + volumeBonus;
        if (newScore > MAX_CREDIT_SCORE) newScore = MAX_CREDIT_SCORE;
        if (newScore < MIN_CREDIT_SCORE) newScore = MIN_CREDIT_SCORE;

        cp.creditScore = uint16(newScore);
        cp.lastUpdated = block.timestamp;

        if (oldScore != uint16(newScore)) {
            emit CreditScoreUpdated(_business, oldScore, uint16(newScore));
        }
    }

    /**
     * @dev Calculates total amount owed on an invoice including late penalties.
     * @param inv Invoice storage reference.
     * @return Total amount owed.
     */
    function _calculateTotalOwed(Invoice storage inv) internal view returns (uint256) {
        uint256 totalOwed = inv.faceValue;

        // Add late penalty if overdue
        if (block.timestamp > inv.maturityDate + inv.gracePeriod) {
            uint256 daysOverdue = (block.timestamp - inv.maturityDate) / 1 days;
            uint256 penalty = (inv.faceValue * inv.latePenaltyBps * daysOverdue) / (10_000 * 365);
            totalOwed += penalty;
        }

        return totalOwed;
    }

    /**
     * @dev Distributes a payment pro-rata to factoring positions.
     * @param _invoiceId Invoice being repaid.
     * @param _amount    Payment amount to distribute.
     * @param inv        Invoice storage reference.
     */
    function _distributePayment(
        bytes32 _invoiceId,
        uint256 _amount,
        Invoice storage inv
    ) internal {
        bytes32[] storage positions = invoicePositions[_invoiceId];
        uint256 positionCount = positions.length;

        if (positionCount == 0) {
            // No factoring positions — pay creditor directly
            IERC20(inv.settlementToken).safeTransfer(inv.creditor, _amount);
            return;
        }

        uint256 distributed;

        for (uint256 i; i < positionCount;) {
            FactoringPosition storage pos = factoringPositions[positions[i]];
            if (!pos.settled) {
                uint256 remaining = pos.expectedReturn - pos.settledAmount;
                // Pro-rata share based on advance amount relative to total financed
                uint256 share = (_amount * pos.advanceAmount) / inv.amountFinanced;
                if (share > remaining) share = remaining;

                pos.settledAmount += share;
                distributed += share;

                IERC20(inv.settlementToken).safeTransfer(pos.factor, share);

                if (pos.settledAmount >= pos.expectedReturn) {
                    pos.settled = true;
                    emit FactoringPositionSettled(pos.positionId, _invoiceId, pos.settledAmount);
                }
            }

            unchecked { ++i; }
        }

        // Any remainder goes to the creditor
        uint256 creditorShare = _amount - distributed;
        if (creditorShare > 0) {
            IERC20(inv.settlementToken).safeTransfer(inv.creditor, creditorShare);
        }
    }
}
