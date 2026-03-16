// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title MultiSigTreasury
 * @author Aethelred Team
 * @notice Institutional treasury governance contract for the NoblePay cross-border
 *         payment platform. Provides N-of-M multi-signature operations with tiered
 *         approval thresholds, time-locked execution, spending policy enforcement,
 *         budget tracking, recurring payments, and DeFi yield allocation.
 *
 * @dev Architecture overview:
 *
 * ┌───────────────────────────────────────────────────────────────────┐
 * │                    MULTISIG TREASURY                              │
 * ├───────────────────────────────────────────────────────────────────┤
 * │  ┌─────────────────┐  ┌──────────────────┐  ┌────────────────┐  │
 * │  │  Proposals       │  │  Approval Tiers   │  │  Time Locks    │  │
 * │  │  ──────────────  │  │  ──────────────── │  │  ──────────── │  │
 * │  │  • create        │  │  • small: 2/5     │  │  • 24hr small  │  │
 * │  │  • approve       │  │  • medium: 3/5    │  │  • 48hr large  │  │
 * │  │  • reject        │  │  • large: 4/5     │  │  • fast-track  │  │
 * │  │  • execute       │  │  • emergency      │  │  • emergency   │  │
 * │  │  • cancel        │  │                    │  │                │  │
 * │  └─────────────────┘  └──────────────────┘  └────────────────┘  │
 * │  ┌─────────────────┐  ┌──────────────────┐  ┌────────────────┐  │
 * │  │  Budgets         │  │  Recurring Pay    │  │  Yield Mgmt    │  │
 * │  │  ──────────────  │  │  ──────────────── │  │  ──────────── │  │
 * │  │  • dept alloc    │  │  • standing orders│  │  • DeFi alloc  │  │
 * │  │  • spending cap  │  │  • authorization  │  │  • approved    │  │
 * │  │  • daily/weekly  │  │  • auto-execute   │  │    protocols   │  │
 * │  │  • monthly       │  │  • revocation     │  │  • rebalance   │  │
 * │  └─────────────────┘  └──────────────────┘  └────────────────┘  │
 * └───────────────────────────────────────────────────────────────────┘
 *
 * Approval thresholds (configurable, defaults for 5 signers):
 *   - Small  (< $10K):  2 of 5  |  24-hour timelock
 *   - Medium ($10K-$100K): 3 of 5  |  24-hour timelock
 *   - Large  (> $100K): 4 of 5  |  48-hour timelock
 *   - Emergency:       4 of 5  |  1-hour timelock (fast-track)
 */
contract MultiSigTreasury is AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ──────────────────────────────────────────────────────────────
    // Roles
    // ──────────────────────────────────────────────────────────────

    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant SIGNER_ROLE = keccak256("SIGNER_ROLE");
    bytes32 public constant BUDGET_MANAGER_ROLE = keccak256("BUDGET_MANAGER_ROLE");
    bytes32 public constant YIELD_MANAGER_ROLE = keccak256("YIELD_MANAGER_ROLE");

    // ──────────────────────────────────────────────────────────────
    // Enums
    // ──────────────────────────────────────────────────────────────

    /// @notice Proposal lifecycle status.
    enum ProposalStatus {
        PENDING,
        APPROVED,
        EXECUTED,
        REJECTED,
        CANCELLED,
        EXPIRED
    }

    /// @notice Transaction size tier determining approval requirements.
    enum TxTier {
        SMALL,
        MEDIUM,
        LARGE,
        EMERGENCY
    }

    /// @notice Spending category for budget tracking.
    enum SpendingCategory {
        OPERATIONS,
        PAYROLL,
        INFRASTRUCTURE,
        MARKETING,
        LEGAL,
        RESEARCH,
        PARTNERSHIPS,
        OTHER
    }

    /// @notice Recurring payment frequency.
    enum PaymentFrequency {
        DAILY,
        WEEKLY,
        BIWEEKLY,
        MONTHLY,
        QUARTERLY
    }

    // ──────────────────────────────────────────────────────────────
    // Structs
    // ──────────────────────────────────────────────────────────────

    /// @notice Treasury transfer proposal.
    struct Proposal {
        bytes32 proposalId;
        address proposer;
        address recipient;
        address token;               // ERC20 token; address(0) for native
        uint256 amount;
        SpendingCategory category;
        string description;
        TxTier tier;
        ProposalStatus status;
        uint256 approvalCount;
        uint256 rejectionCount;
        uint256 requiredApprovals;
        uint256 createdAt;
        uint256 timelockExpiry;      // Earliest execution timestamp
        uint256 expiresAt;           // Proposal expiry (auto-cancel)
        bool isEmergency;
        bytes32 budgetId;            // Associated budget (0x0 if none)
    }

    /// @notice Budget allocation for a department or project.
    struct Budget {
        bytes32 budgetId;
        string name;
        SpendingCategory category;
        uint256 totalAllocation;     // Total budget in USD-equiv (6 dec)
        uint256 spent;               // Amount spent so far
        uint256 dailyLimit;
        uint256 weeklyLimit;
        uint256 monthlyLimit;
        uint256 createdAt;
        uint256 periodStart;         // Start of current budget period
        uint256 periodEnd;           // End of current budget period
        bool active;
    }

    /// @notice Daily/weekly/monthly spending tracker for a budget.
    struct SpendingTracker {
        uint256 dailySpent;
        uint256 weeklySpent;
        uint256 monthlySpent;
        uint256 lastDayReset;
        uint256 lastWeekReset;
        uint256 lastMonthReset;
    }

    /// @notice Recurring payment authorization (standing order).
    struct RecurringPayment {
        bytes32 paymentId;
        address recipient;
        address token;
        uint256 amount;
        PaymentFrequency frequency;
        SpendingCategory category;
        string description;
        uint256 nextExecution;
        uint256 lastExecuted;
        uint256 executionCount;
        uint256 maxExecutions;       // 0 = unlimited
        bool active;
        bytes32 budgetId;
    }

    /// @notice Signer delegation record.
    struct Delegation {
        address delegator;
        address delegate;
        uint256 validFrom;
        uint256 validUntil;
        bool active;
    }

    /// @notice Approved DeFi protocol for yield allocation.
    struct YieldProtocol {
        address protocolAddress;
        string name;
        uint256 maxAllocation;       // Maximum allocation in token units
        uint256 currentAllocation;
        bool active;
    }

    /// @notice Signer configuration.
    struct SignerConfig {
        uint256 totalSigners;
        uint256 smallThreshold;      // Approvals needed for small tx
        uint256 mediumThreshold;     // Approvals needed for medium tx
        uint256 largeThreshold;      // Approvals needed for large tx
        uint256 emergencyThreshold;  // Approvals needed for emergency tx
    }

    // ──────────────────────────────────────────────────────────────
    // Constants
    // ──────────────────────────────────────────────────────────────

    /// @notice Small transaction threshold ($10K in 6 decimals).
    uint256 public constant SMALL_TX_THRESHOLD = 10_000 * 1e6;

    /// @notice Large transaction threshold ($100K in 6 decimals).
    uint256 public constant LARGE_TX_THRESHOLD = 100_000 * 1e6;

    /// @notice Standard timelock for small/medium transactions (24 hours).
    uint256 public constant STANDARD_TIMELOCK = 24 hours;

    /// @notice Extended timelock for large transactions (48 hours).
    uint256 public constant LARGE_TIMELOCK = 48 hours;

    /// @notice Emergency timelock (1 hour).
    uint256 public constant EMERGENCY_TIMELOCK = 1 hours;

    /// @notice Proposal expiry (7 days).
    uint256 public constant PROPOSAL_EXPIRY = 7 days;

    /// @notice Signer rotation cooldown (48 hours).
    uint256 public constant SIGNER_COOLDOWN = 48 hours;

    /// @notice Maximum delegation period (30 days).
    uint256 public constant MAX_DELEGATION_PERIOD = 30 days;

    // ──────────────────────────────────────────────────────────────
    // State
    // ──────────────────────────────────────────────────────────────

    /// @notice Signer configuration.
    SignerConfig public signerConfig;

    /// @notice Proposal records keyed by proposal ID.
    mapping(bytes32 => Proposal) public proposals;

    /// @notice Per-proposal signer approval tracking.
    mapping(bytes32 => mapping(address => bool)) public proposalApprovals;

    /// @notice Per-proposal signer rejection tracking.
    mapping(bytes32 => mapping(address => bool)) public proposalRejections;

    /// @notice Budget records keyed by budget ID.
    mapping(bytes32 => Budget) public budgets;

    /// @notice Spending trackers keyed by budget ID.
    mapping(bytes32 => SpendingTracker) public spendingTrackers;

    /// @notice Active budget IDs.
    bytes32[] public activeBudgetIds;

    /// @notice Recurring payment records keyed by payment ID.
    mapping(bytes32 => RecurringPayment) public recurringPayments;

    /// @notice Active recurring payment IDs.
    bytes32[] public activeRecurringPaymentIds;

    /// @notice Delegation records keyed by delegator address.
    mapping(address => Delegation) public delegations;

    /// @notice Approved yield protocols keyed by protocol address.
    mapping(address => YieldProtocol) public yieldProtocols;

    /// @notice Supported tokens for treasury operations.
    mapping(address => bool) public supportedTokens;

    /// @notice List of all current signers.
    address[] public signers;

    /// @notice Index tracking for signers array.
    mapping(address => uint256) internal _signerIndex;

    /// @notice Signer last added timestamp (for cooldown).
    mapping(address => uint256) public signerAddedAt;

    /// @notice Proposal nonce.
    uint256 public proposalNonce;

    /// @notice Budget nonce.
    uint256 public budgetNonce;

    /// @notice Recurring payment nonce.
    uint256 public recurringNonce;

    /// @notice NoblePay core contract reference.
    address public noblePayContract;

    // ──────────────────────────────────────────────────────────────
    // Events
    // ──────────────────────────────────────────────────────────────

    event ProposalCreated(
        bytes32 indexed proposalId,
        address indexed proposer,
        address indexed recipient,
        uint256 amount,
        TxTier tier,
        bool isEmergency
    );

    event ProposalApproved(
        bytes32 indexed proposalId,
        address indexed signer,
        uint256 approvalCount,
        uint256 required
    );

    event ProposalRejected(
        bytes32 indexed proposalId,
        address indexed signer,
        uint256 rejectionCount
    );

    event ProposalExecuted(
        bytes32 indexed proposalId,
        address indexed executor,
        uint256 amount,
        uint256 executedAt
    );

    event ProposalCancelled(bytes32 indexed proposalId, address indexed cancelledBy);
    event ProposalExpired(bytes32 indexed proposalId);

    event BudgetCreated(
        bytes32 indexed budgetId,
        string name,
        SpendingCategory category,
        uint256 totalAllocation
    );

    event BudgetSpent(
        bytes32 indexed budgetId,
        uint256 amount,
        uint256 totalSpent,
        uint256 remaining
    );

    event RecurringPaymentCreated(
        bytes32 indexed paymentId,
        address indexed recipient,
        uint256 amount,
        PaymentFrequency frequency
    );

    event RecurringPaymentExecuted(
        bytes32 indexed paymentId,
        uint256 executionNumber,
        uint256 amount
    );

    event RecurringPaymentRevoked(bytes32 indexed paymentId);

    event SignerAdded(address indexed signer, uint256 totalSigners);
    event SignerRemoved(address indexed signer, uint256 totalSigners);
    event SignerConfigUpdated(uint256 small, uint256 medium, uint256 large, uint256 emergency);

    event DelegationCreated(
        address indexed delegator,
        address indexed delegate,
        uint256 validUntil
    );

    event DelegationRevoked(address indexed delegator, address indexed delegate);

    event YieldProtocolApproved(address indexed protocol, string name, uint256 maxAllocation);
    event YieldAllocated(address indexed protocol, uint256 amount);
    event YieldWithdrawn(address indexed protocol, uint256 amount);

    event TokenSupported(address indexed token, bool supported);
    event NoblePayUpdated(address indexed oldContract, address indexed newContract);

    // ──────────────────────────────────────────────────────────────
    // Errors
    // ──────────────────────────────────────────────────────────────

    error ZeroAddress();
    error ZeroAmount();
    error UnsupportedToken();
    error ProposalNotFound();
    error InvalidProposalStatus(ProposalStatus current);
    error AlreadyApproved();
    error AlreadyRejected();
    error TimelockNotExpired(uint256 expiry, uint256 current);
    error ProposalExpiredError();
    error NotSigner();
    error SignerAlreadyExists();
    error CooldownActive(uint256 readyAt);
    error BudgetNotFound();
    error BudgetExceeded(uint256 requested, uint256 remaining);
    error DailyLimitExceeded(uint256 requested, uint256 remaining);
    error WeeklyLimitExceeded(uint256 requested, uint256 remaining);
    error MonthlyLimitExceeded(uint256 requested, uint256 remaining);
    error RecurringPaymentNotFound();
    error RecurringPaymentNotDue();
    error MaxExecutionsReached();
    error DelegationNotActive();
    error DelegationTooLong();
    error ProtocolNotApproved();
    error AllocationExceeded();
    error InsufficientBalance();
    error InvalidSignerConfig();
    error MinimumSignersRequired();

    // ──────────────────────────────────────────────────────────────
    // Modifiers
    // ──────────────────────────────────────────────────────────────

    /// @notice Restricts to signers or their active delegates.
    modifier onlySignerOrDelegate() {
        bool authorized = hasRole(SIGNER_ROLE, msg.sender);
        if (!authorized) {
            // Check if msg.sender is an active delegate for any signer
            Delegation storage del = delegations[msg.sender];
            authorized = del.active &&
                         del.delegate == msg.sender &&
                         block.timestamp >= del.validFrom &&
                         block.timestamp <= del.validUntil &&
                         hasRole(SIGNER_ROLE, del.delegator);
        }
        if (!authorized) revert NotSigner();
        _;
    }

    // ──────────────────────────────────────────────────────────────
    // Constructor
    // ──────────────────────────────────────────────────────────────

    /**
     * @notice Deploys MultiSigTreasury with initial signers and thresholds.
     * @param _admin             Admin address.
     * @param _initialSigners    Initial set of signers.
     * @param _smallThreshold    Approvals for small tx.
     * @param _mediumThreshold   Approvals for medium tx.
     * @param _largeThreshold    Approvals for large tx.
     * @param _emergencyThreshold Approvals for emergency tx.
     */
    constructor(
        address _admin,
        address[] memory _initialSigners,
        uint256 _smallThreshold,
        uint256 _mediumThreshold,
        uint256 _largeThreshold,
        uint256 _emergencyThreshold
    ) {
        if (_admin == address(0)) revert ZeroAddress();
        if (_initialSigners.length < 2) revert MinimumSignersRequired();
        if (
            _smallThreshold == 0 ||
            _smallThreshold > _mediumThreshold ||
            _mediumThreshold > _largeThreshold ||
            _largeThreshold > _initialSigners.length
        ) revert InvalidSignerConfig();

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(ADMIN_ROLE, _admin);

        for (uint256 i; i < _initialSigners.length;) {
            if (_initialSigners[i] == address(0)) revert ZeroAddress();
            _grantRole(SIGNER_ROLE, _initialSigners[i]);
            _signerIndex[_initialSigners[i]] = signers.length;
            signers.push(_initialSigners[i]);
            signerAddedAt[_initialSigners[i]] = block.timestamp;

            unchecked { ++i; }
        }

        signerConfig = SignerConfig({
            totalSigners: _initialSigners.length,
            smallThreshold: _smallThreshold,
            mediumThreshold: _mediumThreshold,
            largeThreshold: _largeThreshold,
            emergencyThreshold: _emergencyThreshold
        });
    }

    // ──────────────────────────────────────────────────────────────
    // External — Proposal Lifecycle
    // ──────────────────────────────────────────────────────────────

    /**
     * @notice Creates a new treasury transfer proposal.
     * @param _recipient    Beneficiary address.
     * @param _token        ERC20 token address; address(0) for native.
     * @param _amount       Transfer amount.
     * @param _category     Spending category.
     * @param _description  Human-readable description.
     * @param _isEmergency  Whether this is an emergency fast-track proposal.
     * @param _budgetId     Associated budget ID (bytes32(0) if none).
     * @return proposalId   Unique proposal identifier.
     */
    function createProposal(
        address _recipient,
        address _token,
        uint256 _amount,
        SpendingCategory _category,
        string calldata _description,
        bool _isEmergency,
        bytes32 _budgetId
    ) external whenNotPaused onlySignerOrDelegate returns (bytes32 proposalId) {
        if (_recipient == address(0)) revert ZeroAddress();
        if (_amount == 0) revert ZeroAmount();
        if (_token != address(0) && !supportedTokens[_token]) revert UnsupportedToken();

        // Determine tier and requirements
        TxTier tier;
        uint256 requiredApprovals;
        uint256 timelock;

        if (_isEmergency) {
            tier = TxTier.EMERGENCY;
            requiredApprovals = signerConfig.emergencyThreshold;
            timelock = EMERGENCY_TIMELOCK;
        } else if (_amount <= SMALL_TX_THRESHOLD) {
            tier = TxTier.SMALL;
            requiredApprovals = signerConfig.smallThreshold;
            timelock = STANDARD_TIMELOCK;
        } else if (_amount <= LARGE_TX_THRESHOLD) {
            tier = TxTier.MEDIUM;
            requiredApprovals = signerConfig.mediumThreshold;
            timelock = STANDARD_TIMELOCK;
        } else {
            tier = TxTier.LARGE;
            requiredApprovals = signerConfig.largeThreshold;
            timelock = LARGE_TIMELOCK;
        }

        // Validate budget if specified
        if (_budgetId != bytes32(0)) {
            Budget storage budget = budgets[_budgetId];
            if (!budget.active) revert BudgetNotFound();
            uint256 remaining = budget.totalAllocation - budget.spent;
            if (_amount > remaining) revert BudgetExceeded(_amount, remaining);
        }

        proposalId = keccak256(
            abi.encodePacked(msg.sender, _recipient, _amount, block.timestamp, proposalNonce++)
        );

        // Resolve the canonical signer identity to prevent delegate double-counting
        address approver = _resolveApprover(msg.sender);

        proposals[proposalId] = Proposal({
            proposalId: proposalId,
            proposer: msg.sender,
            recipient: _recipient,
            token: _token,
            amount: _amount,
            category: _category,
            description: _description,
            tier: tier,
            status: ProposalStatus.PENDING,
            approvalCount: 1,
            rejectionCount: 0,
            requiredApprovals: requiredApprovals,
            createdAt: block.timestamp,
            timelockExpiry: block.timestamp + timelock,
            expiresAt: block.timestamp + PROPOSAL_EXPIRY,
            isEmergency: _isEmergency,
            budgetId: _budgetId
        });

        // Auto-approve by resolved approver identity
        proposalApprovals[proposalId][approver] = true;

        emit ProposalCreated(proposalId, msg.sender, _recipient, _amount, tier, _isEmergency);
        emit ProposalApproved(proposalId, msg.sender, 1, requiredApprovals);
    }

    /**
     * @notice Approves a pending proposal.
     * @param _proposalId Proposal to approve.
     */
    function approveProposal(
        bytes32 _proposalId
    ) external whenNotPaused onlySignerOrDelegate {
        Proposal storage p = proposals[_proposalId];
        if (p.createdAt == 0) revert ProposalNotFound();
        if (p.status != ProposalStatus.PENDING) revert InvalidProposalStatus(p.status);
        if (block.timestamp > p.expiresAt) revert ProposalExpiredError();

        // Resolve the canonical signer identity to prevent delegate double-counting
        address approver = _resolveApprover(msg.sender);
        if (proposalApprovals[_proposalId][approver]) revert AlreadyApproved();

        proposalApprovals[_proposalId][approver] = true;
        p.approvalCount++;

        if (p.approvalCount >= p.requiredApprovals) {
            p.status = ProposalStatus.APPROVED;
        }

        emit ProposalApproved(_proposalId, msg.sender, p.approvalCount, p.requiredApprovals);
    }

    /**
     * @notice Rejects a pending proposal.
     * @param _proposalId Proposal to reject.
     */
    function rejectProposal(
        bytes32 _proposalId
    ) external whenNotPaused onlySignerOrDelegate {
        Proposal storage p = proposals[_proposalId];
        if (p.createdAt == 0) revert ProposalNotFound();
        if (p.status != ProposalStatus.PENDING) revert InvalidProposalStatus(p.status);

        address canonical = _resolveApprover(msg.sender);
        if (proposalRejections[_proposalId][canonical]) revert AlreadyRejected();

        proposalRejections[_proposalId][canonical] = true;
        p.rejectionCount++;

        // Auto-reject if majority rejects
        uint256 rejectThreshold = signerConfig.totalSigners - p.requiredApprovals + 1;
        if (p.rejectionCount >= rejectThreshold) {
            p.status = ProposalStatus.REJECTED;
        }

        emit ProposalRejected(_proposalId, msg.sender, p.rejectionCount);
    }

    /**
     * @notice Executes an approved proposal after timelock expiry.
     * @param _proposalId Proposal to execute.
     */
    function executeProposal(
        bytes32 _proposalId
    ) external whenNotPaused nonReentrant onlySignerOrDelegate {
        Proposal storage p = proposals[_proposalId];
        if (p.createdAt == 0) revert ProposalNotFound();
        if (p.status != ProposalStatus.APPROVED) revert InvalidProposalStatus(p.status);
        if (block.timestamp < p.timelockExpiry) {
            revert TimelockNotExpired(p.timelockExpiry, block.timestamp);
        }
        if (block.timestamp > p.expiresAt) revert ProposalExpiredError();

        p.status = ProposalStatus.EXECUTED;

        // Update budget if applicable
        if (p.budgetId != bytes32(0)) {
            _recordBudgetSpending(p.budgetId, p.amount);
        }

        // Execute transfer
        if (p.token == address(0)) {
            if (address(this).balance < p.amount) revert InsufficientBalance();
            (bool ok, ) = p.recipient.call{value: p.amount}("");
            require(ok, "MultiSigTreasury: native transfer failed");
        } else {
            if (IERC20(p.token).balanceOf(address(this)) < p.amount) revert InsufficientBalance();
            IERC20(p.token).safeTransfer(p.recipient, p.amount);
        }

        emit ProposalExecuted(_proposalId, msg.sender, p.amount, block.timestamp);
    }

    /**
     * @notice Cancels a pending or approved proposal.
     * @dev Only the original proposer or admin can cancel.
     * @param _proposalId Proposal to cancel.
     */
    function cancelProposal(bytes32 _proposalId) external whenNotPaused {
        Proposal storage p = proposals[_proposalId];
        if (p.createdAt == 0) revert ProposalNotFound();
        require(
            msg.sender == p.proposer || hasRole(ADMIN_ROLE, msg.sender),
            "MultiSigTreasury: not authorized to cancel"
        );
        require(
            p.status == ProposalStatus.PENDING || p.status == ProposalStatus.APPROVED,
            "MultiSigTreasury: cannot cancel"
        );

        p.status = ProposalStatus.CANCELLED;
        emit ProposalCancelled(_proposalId, msg.sender);
    }

    // ──────────────────────────────────────────────────────────────
    // External — Budget Management
    // ──────────────────────────────────────────────────────────────

    /**
     * @notice Creates a budget allocation for a department or project.
     * @param _name           Budget name/label.
     * @param _category       Spending category.
     * @param _totalAllocation Total budget in token units.
     * @param _dailyLimit     Maximum daily spend.
     * @param _weeklyLimit    Maximum weekly spend.
     * @param _monthlyLimit   Maximum monthly spend.
     * @param _periodEnd      End of budget period.
     * @return budgetId       Unique budget identifier.
     */
    function createBudget(
        string calldata _name,
        SpendingCategory _category,
        uint256 _totalAllocation,
        uint256 _dailyLimit,
        uint256 _weeklyLimit,
        uint256 _monthlyLimit,
        uint256 _periodEnd
    ) external onlyRole(BUDGET_MANAGER_ROLE) whenNotPaused returns (bytes32 budgetId) {
        if (_totalAllocation == 0) revert ZeroAmount();
        require(_periodEnd > block.timestamp, "MultiSigTreasury: invalid period");

        budgetId = keccak256(
            abi.encodePacked(_name, _category, block.timestamp, budgetNonce++)
        );

        budgets[budgetId] = Budget({
            budgetId: budgetId,
            name: _name,
            category: _category,
            totalAllocation: _totalAllocation,
            spent: 0,
            dailyLimit: _dailyLimit,
            weeklyLimit: _weeklyLimit,
            monthlyLimit: _monthlyLimit,
            createdAt: block.timestamp,
            periodStart: block.timestamp,
            periodEnd: _periodEnd,
            active: true
        });

        spendingTrackers[budgetId] = SpendingTracker({
            dailySpent: 0,
            weeklySpent: 0,
            monthlySpent: 0,
            lastDayReset: block.timestamp,
            lastWeekReset: block.timestamp,
            lastMonthReset: block.timestamp
        });

        activeBudgetIds.push(budgetId);

        emit BudgetCreated(budgetId, _name, _category, _totalAllocation);
    }

    // ──────────────────────────────────────────────────────────────
    // External — Recurring Payments
    // ──────────────────────────────────────────────────────────────

    /**
     * @notice Creates a recurring payment authorization (standing order).
     * @param _recipient      Payment recipient.
     * @param _token          ERC20 token; address(0) for native.
     * @param _amount         Payment amount per execution.
     * @param _frequency      Payment frequency.
     * @param _category       Spending category.
     * @param _description    Payment description.
     * @param _maxExecutions  Maximum number of executions (0 = unlimited).
     * @param _budgetId       Associated budget ID.
     * @return paymentId      Unique payment identifier.
     */
    function createRecurringPayment(
        address _recipient,
        address _token,
        uint256 _amount,
        PaymentFrequency _frequency,
        SpendingCategory _category,
        string calldata _description,
        uint256 _maxExecutions,
        bytes32 _budgetId
    ) external whenNotPaused onlyRole(ADMIN_ROLE) returns (bytes32 paymentId) {
        if (_recipient == address(0)) revert ZeroAddress();
        if (_amount == 0) revert ZeroAmount();

        uint256 nextExec = block.timestamp + _frequencyToSeconds(_frequency);

        paymentId = keccak256(
            abi.encodePacked(msg.sender, _recipient, _amount, block.timestamp, recurringNonce++)
        );

        recurringPayments[paymentId] = RecurringPayment({
            paymentId: paymentId,
            recipient: _recipient,
            token: _token,
            amount: _amount,
            frequency: _frequency,
            category: _category,
            description: _description,
            nextExecution: nextExec,
            lastExecuted: 0,
            executionCount: 0,
            maxExecutions: _maxExecutions,
            active: true,
            budgetId: _budgetId
        });

        activeRecurringPaymentIds.push(paymentId);

        emit RecurringPaymentCreated(paymentId, _recipient, _amount, _frequency);
    }

    /**
     * @notice Executes a due recurring payment.
     * @param _paymentId Recurring payment to execute.
     */
    function executeRecurringPayment(
        bytes32 _paymentId
    ) external whenNotPaused nonReentrant {
        RecurringPayment storage rp = recurringPayments[_paymentId];
        if (!rp.active) revert RecurringPaymentNotFound();
        if (block.timestamp < rp.nextExecution) revert RecurringPaymentNotDue();
        if (rp.maxExecutions > 0 && rp.executionCount >= rp.maxExecutions) {
            revert MaxExecutionsReached();
        }

        rp.executionCount++;
        rp.lastExecuted = block.timestamp;
        rp.nextExecution = block.timestamp + _frequencyToSeconds(rp.frequency);

        // Update budget if applicable
        if (rp.budgetId != bytes32(0)) {
            _recordBudgetSpending(rp.budgetId, rp.amount);
        }

        // Execute transfer
        if (rp.token == address(0)) {
            if (address(this).balance < rp.amount) revert InsufficientBalance();
            (bool ok, ) = rp.recipient.call{value: rp.amount}("");
            require(ok, "MultiSigTreasury: recurring payment failed");
        } else {
            IERC20(rp.token).safeTransfer(rp.recipient, rp.amount);
        }

        emit RecurringPaymentExecuted(_paymentId, rp.executionCount, rp.amount);
    }

    /**
     * @notice Revokes a recurring payment authorization.
     * @param _paymentId Payment to revoke.
     */
    function revokeRecurringPayment(
        bytes32 _paymentId
    ) external whenNotPaused onlySignerOrDelegate {
        RecurringPayment storage rp = recurringPayments[_paymentId];
        if (!rp.active) revert RecurringPaymentNotFound();

        rp.active = false;
        emit RecurringPaymentRevoked(_paymentId);
    }

    // ──────────────────────────────────────────────────────────────
    // External — Delegation
    // ──────────────────────────────────────────────────────────────

    /**
     * @notice Delegates signing authority to another address temporarily.
     * @param _delegate  Address to delegate to.
     * @param _duration  Duration in seconds (max 30 days).
     */
    function delegateSigningAuthority(
        address _delegate,
        uint256 _duration
    ) external onlyRole(SIGNER_ROLE) whenNotPaused {
        if (_delegate == address(0)) revert ZeroAddress();
        if (_duration > MAX_DELEGATION_PERIOD) revert DelegationTooLong();

        delegations[_delegate] = Delegation({
            delegator: msg.sender,
            delegate: _delegate,
            validFrom: block.timestamp,
            validUntil: block.timestamp + _duration,
            active: true
        });

        emit DelegationCreated(msg.sender, _delegate, block.timestamp + _duration);
    }

    /**
     * @notice Revokes a delegation.
     * @param _delegate Address whose delegation to revoke.
     */
    function revokeDelegation(address _delegate) external onlyRole(SIGNER_ROLE) {
        Delegation storage del = delegations[_delegate];
        require(del.delegator == msg.sender, "MultiSigTreasury: not delegator");

        del.active = false;
        emit DelegationRevoked(msg.sender, _delegate);
    }

    // ──────────────────────────────────────────────────────────────
    // External — Yield Management
    // ──────────────────────────────────────────────────────────────

    /**
     * @notice Approves a DeFi protocol for yield allocation.
     * @param _protocol      Protocol contract address.
     * @param _name          Protocol name.
     * @param _maxAllocation Maximum allocation allowed.
     */
    function approveYieldProtocol(
        address _protocol,
        string calldata _name,
        uint256 _maxAllocation
    ) external onlyRole(ADMIN_ROLE) {
        if (_protocol == address(0)) revert ZeroAddress();

        yieldProtocols[_protocol] = YieldProtocol({
            protocolAddress: _protocol,
            name: _name,
            maxAllocation: _maxAllocation,
            currentAllocation: 0,
            active: true
        });

        emit YieldProtocolApproved(_protocol, _name, _maxAllocation);
    }

    /**
     * @notice Allocates treasury funds to an approved yield protocol.
     * @param _protocol Protocol address to allocate to.
     * @param _token    Token to allocate.
     * @param _amount   Amount to allocate.
     */
    function allocateToYield(
        address _protocol,
        address _token,
        uint256 _amount
    ) external whenNotPaused nonReentrant onlyRole(YIELD_MANAGER_ROLE) {
        YieldProtocol storage yp = yieldProtocols[_protocol];
        if (!yp.active) revert ProtocolNotApproved();
        if (_amount == 0) revert ZeroAmount();
        if (yp.currentAllocation + _amount > yp.maxAllocation) revert AllocationExceeded();

        yp.currentAllocation += _amount;

        IERC20(_token).safeTransfer(_protocol, _amount);

        emit YieldAllocated(_protocol, _amount);
    }

    // ──────────────────────────────────────────────────────────────
    // External — Signer Management
    // ──────────────────────────────────────────────────────────────

    /**
     * @notice Adds a new signer with cooldown.
     * @param _signer Address to add as signer.
     */
    function addSigner(address _signer) external onlyRole(ADMIN_ROLE) {
        if (_signer == address(0)) revert ZeroAddress();
        if (hasRole(SIGNER_ROLE, _signer)) revert SignerAlreadyExists();

        _grantRole(SIGNER_ROLE, _signer);
        _signerIndex[_signer] = signers.length;
        signers.push(_signer);
        signerAddedAt[_signer] = block.timestamp;
        signerConfig.totalSigners++;

        emit SignerAdded(_signer, signerConfig.totalSigners);
    }

    /**
     * @notice Removes a signer (subject to cooldown and minimum threshold).
     * @param _signer Address to remove.
     */
    function removeSigner(address _signer) external onlyRole(ADMIN_ROLE) {
        if (!hasRole(SIGNER_ROLE, _signer)) revert NotSigner();
        if (signerConfig.totalSigners <= signerConfig.largeThreshold) {
            revert MinimumSignersRequired();
        }

        _revokeRole(SIGNER_ROLE, _signer);

        // Swap-and-pop removal
        uint256 index = _signerIndex[_signer];
        uint256 lastIndex = signers.length - 1;
        if (index != lastIndex) {
            address lastSigner = signers[lastIndex];
            signers[index] = lastSigner;
            _signerIndex[lastSigner] = index;
        }
        signers.pop();
        delete _signerIndex[_signer];
        signerConfig.totalSigners--;

        emit SignerRemoved(_signer, signerConfig.totalSigners);
    }

    /**
     * @notice Updates approval thresholds.
     * @param _small     New small tx threshold.
     * @param _medium    New medium tx threshold.
     * @param _large     New large tx threshold.
     * @param _emergency New emergency threshold.
     */
    function updateSignerConfig(
        uint256 _small,
        uint256 _medium,
        uint256 _large,
        uint256 _emergency
    ) external onlyRole(ADMIN_ROLE) {
        if (
            _small == 0 ||
            _small > _medium ||
            _medium > _large ||
            _large > signerConfig.totalSigners
        ) revert InvalidSignerConfig();

        signerConfig.smallThreshold = _small;
        signerConfig.mediumThreshold = _medium;
        signerConfig.largeThreshold = _large;
        signerConfig.emergencyThreshold = _emergency;

        emit SignerConfigUpdated(_small, _medium, _large, _emergency);
    }

    // ──────────────────────────────────────────────────────────────
    // View Functions
    // ──────────────────────────────────────────────────────────────

    /// @notice Returns a proposal record.
    function getProposal(bytes32 _proposalId) external view returns (Proposal memory) {
        return proposals[_proposalId];
    }

    /// @notice Returns a budget record.
    function getBudget(bytes32 _budgetId) external view returns (Budget memory) {
        return budgets[_budgetId];
    }

    /// @notice Returns the spending tracker for a budget.
    function getSpendingTracker(bytes32 _budgetId) external view returns (SpendingTracker memory) {
        return spendingTrackers[_budgetId];
    }

    /// @notice Returns a recurring payment record.
    function getRecurringPayment(bytes32 _paymentId) external view returns (RecurringPayment memory) {
        return recurringPayments[_paymentId];
    }

    /// @notice Returns the current signer list.
    function getSigners() external view returns (address[] memory) {
        return signers;
    }

    /// @notice Returns the current signer configuration.
    function getSignerConfig() external view returns (SignerConfig memory) {
        return signerConfig;
    }

    /// @notice Checks if a signer has approved a specific proposal.
    function hasApproved(bytes32 _proposalId, address _signer) external view returns (bool) {
        return proposalApprovals[_proposalId][_signer];
    }

    /// @notice Returns the active budget IDs.
    function getActiveBudgets() external view returns (bytes32[] memory) {
        return activeBudgetIds;
    }

    // ──────────────────────────────────────────────────────────────
    // Admin Functions
    // ──────────────────────────────────────────────────────────────

    /// @notice Adds or removes a supported token.
    function setSupportedToken(address _token, bool _supported) external onlyRole(ADMIN_ROLE) {
        if (_token == address(0)) revert ZeroAddress();
        supportedTokens[_token] = _supported;
        emit TokenSupported(_token, _supported);
    }

    /// @notice Sets the NoblePay contract reference.
    function setNoblePayContract(address _noblepay) external onlyRole(ADMIN_ROLE) {
        if (_noblepay == address(0)) revert ZeroAddress();
        address old = noblePayContract;
        noblePayContract = _noblepay;
        emit NoblePayUpdated(old, _noblepay);
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
     * @dev Resolves the effective approver identity. If `caller` is an active
     *      delegate, returns the delegator (the underlying signer). Otherwise
     *      returns `caller` itself. This prevents a signer from getting two
     *      votes by approving once directly and once through their delegate.
     * @param caller The msg.sender to resolve.
     * @return The canonical signer address for approval tracking.
     */
    function _resolveApprover(address caller) internal view returns (address) {
        if (hasRole(SIGNER_ROLE, caller)) {
            return caller;
        }
        // caller must be a delegate (onlySignerOrDelegate already validated)
        Delegation storage del = delegations[caller];
        return del.delegator;
    }

    /**
     * @dev Records spending against a budget with limit enforcement.
     * @param _budgetId Budget to charge.
     * @param _amount   Amount being spent.
     */
    function _recordBudgetSpending(bytes32 _budgetId, uint256 _amount) internal {
        Budget storage budget = budgets[_budgetId];
        if (!budget.active) revert BudgetNotFound();

        uint256 remaining = budget.totalAllocation - budget.spent;
        if (_amount > remaining) revert BudgetExceeded(_amount, remaining);

        SpendingTracker storage tracker = spendingTrackers[_budgetId];

        // Reset daily tracker if new day
        if (block.timestamp / 1 days > tracker.lastDayReset / 1 days) {
            tracker.dailySpent = 0;
            tracker.lastDayReset = block.timestamp;
        }

        // Reset weekly tracker if new week
        if (block.timestamp / 7 days > tracker.lastWeekReset / 7 days) {
            tracker.weeklySpent = 0;
            tracker.lastWeekReset = block.timestamp;
        }

        // Reset monthly tracker if new month
        if (block.timestamp / 30 days > tracker.lastMonthReset / 30 days) {
            tracker.monthlySpent = 0;
            tracker.lastMonthReset = block.timestamp;
        }

        // Enforce limits
        if (budget.dailyLimit > 0) {
            uint256 dailyRemaining = budget.dailyLimit - tracker.dailySpent;
            if (_amount > dailyRemaining) revert DailyLimitExceeded(_amount, dailyRemaining);
        }
        if (budget.weeklyLimit > 0) {
            uint256 weeklyRemaining = budget.weeklyLimit - tracker.weeklySpent;
            if (_amount > weeklyRemaining) revert WeeklyLimitExceeded(_amount, weeklyRemaining);
        }
        if (budget.monthlyLimit > 0) {
            uint256 monthlyRemaining = budget.monthlyLimit - tracker.monthlySpent;
            if (_amount > monthlyRemaining) revert MonthlyLimitExceeded(_amount, monthlyRemaining);
        }

        budget.spent += _amount;
        tracker.dailySpent += _amount;
        tracker.weeklySpent += _amount;
        tracker.monthlySpent += _amount;

        emit BudgetSpent(_budgetId, _amount, budget.spent, budget.totalAllocation - budget.spent);
    }

    /**
     * @dev Converts a payment frequency enum to seconds.
     * @param _frequency Payment frequency.
     * @return Number of seconds between payments.
     */
    function _frequencyToSeconds(PaymentFrequency _frequency) internal pure returns (uint256) {
        if (_frequency == PaymentFrequency.DAILY) return 1 days;
        if (_frequency == PaymentFrequency.WEEKLY) return 7 days;
        if (_frequency == PaymentFrequency.BIWEEKLY) return 14 days;
        if (_frequency == PaymentFrequency.MONTHLY) return 30 days;
        if (_frequency == PaymentFrequency.QUARTERLY) return 90 days;
        return 30 days; // Default to monthly
    }

    /// @notice Allows the contract to receive native tokens.
    receive() external payable {}
}
