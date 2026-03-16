// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/**
 * @title PaymentChannels
 * @author Aethelred Team
 * @notice High-frequency settlement channel contract for the NoblePay cross-border
 *         payment platform. Enables bi-directional payment channels for high-volume
 *         B2B payments with off-chain signing and on-chain settlement, dispute
 *         resolution, multi-hop routing, and HTLC conditional payments.
 *
 * @dev Architecture overview:
 *
 * ┌───────────────────────────────────────────────────────────────────┐
 * │                     PAYMENT CHANNELS                              │
 * ├───────────────────────────────────────────────────────────────────┤
 * │  ┌─────────────────┐  ┌──────────────────┐  ┌────────────────┐  │
 * │  │  Channel Mgmt    │  │  Settlement       │  │  Disputes      │  │
 * │  │  ──────────────  │  │  ──────────────── │  │  ──────────── │  │
 * │  │  • open          │  │  • cooperative     │  │  • challenge   │  │
 * │  │  • fund          │  │  • unilateral      │  │  • respond     │  │
 * │  │  • close         │  │  • off-chain sign  │  │  • timeout     │  │
 * │  │  • batch ops     │  │  • on-chain final  │  │  • slash       │  │
 * │  └─────────────────┘  └──────────────────┘  └────────────────┘  │
 * │  ┌─────────────────┐  ┌──────────────────┐  ┌────────────────┐  │
 * │  │  Routing          │  │  HTLC             │  │  Watchtowers   │  │
 * │  │  ──────────────  │  │  ──────────────── │  │  ──────────── │  │
 * │  │  • multi-hop     │  │  • hash locks     │  │  • register    │  │
 * │  │  • intermediary  │  │  • time locks     │  │  • monitor     │  │
 * │  │  • fees          │  │  • conditional     │  │  • bounty      │  │
 * │  │  • path finding  │  │  • atomic swap     │  │  • alert       │  │
 * │  └─────────────────┘  └──────────────────┘  └────────────────┘  │
 * └───────────────────────────────────────────────────────────────────┘
 *
 * Channel lifecycle:
 *   OPEN -> FUNDED -> ACTIVE -> (DISPUTE_PERIOD ->) CLOSED
 *
 * Off-chain payment protocol:
 *   1. Parties exchange signed state updates off-chain
 *   2. Each state has a monotonically increasing nonce
 *   3. Either party can submit the latest state to close cooperatively
 *   4. Disputes use the challenge-response pattern with timeouts
 *   5. HTLCs enable conditional multi-hop payments
 */
contract PaymentChannels is AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using ECDSA for bytes32;

    // ──────────────────────────────────────────────────────────────
    // Roles
    // ──────────────────────────────────────────────────────────────

    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant ROUTER_ROLE = keccak256("ROUTER_ROLE");
    bytes32 public constant WATCHTOWER_ROLE = keccak256("WATCHTOWER_ROLE");

    // ──────────────────────────────────────────────────────────────
    // Enums
    // ──────────────────────────────────────────────────────────────

    /// @notice Lifecycle status of a payment channel.
    enum ChannelStatus {
        OPEN,
        FUNDED,
        ACTIVE,
        CLOSING,
        DISPUTE,
        CLOSED
    }

    /// @notice Status of an HTLC (Hash Time-Locked Contract).
    enum HTLCStatus {
        ACTIVE,
        CLAIMED,
        REFUNDED,
        EXPIRED
    }

    // ──────────────────────────────────────────────────────────────
    // Structs
    // ──────────────────────────────────────────────────────────────

    /// @notice Bi-directional payment channel between two parties.
    struct Channel {
        bytes32 channelId;
        address partyA;              // Channel opener
        address partyB;              // Channel counterparty
        address token;               // ERC20 settlement token
        uint256 depositA;            // Party A's total deposit
        uint256 depositB;            // Party B's total deposit
        uint256 balanceA;            // Party A's current balance
        uint256 balanceB;            // Party B's current balance
        ChannelStatus status;
        uint256 nonce;               // Latest agreed state nonce
        uint256 openedAt;
        uint256 closingAt;           // When closing was initiated
        uint256 closedAt;
        uint256 challengePeriod;     // Duration of dispute window
        uint256 routingFeeBps;       // Fee charged if used as routing hop
    }

    /// @notice Dispute record for a channel.
    struct ChannelDispute {
        bytes32 channelId;
        address challenger;          // Party that initiated the dispute
        uint256 challengeNonce;      // State nonce submitted by challenger
        uint256 challengeBalanceA;   // Challenger's claimed balance A
        uint256 challengeBalanceB;   // Challenger's claimed balance B
        uint256 initiatedAt;
        uint256 expiresAt;           // Deadline for counter-challenge
        bool resolved;
    }

    /// @notice Hash Time-Locked Contract for conditional payments.
    struct HTLC {
        bytes32 htlcId;
        bytes32 channelId;
        address sender;
        address receiver;
        uint256 amount;
        bytes32 hashLock;            // keccak256(preimage)
        uint256 timelock;            // Expiry timestamp
        HTLCStatus status;
        uint256 createdAt;
    }

    /// @notice Registered watchtower for channel monitoring.
    struct Watchtower {
        address operator;
        uint256 stake;               // Staked collateral
        uint256 bountyBps;           // Bounty rate in basis points
        uint256 channelsMonitored;
        uint256 disputesRaised;
        bool active;
        uint256 registeredAt;
    }

    /// @notice Multi-hop routing path record.
    struct RoutingPath {
        bytes32 pathId;
        bytes32[] channelIds;        // Ordered list of channels in the path
        address[] intermediaries;    // Routing nodes
        uint256 totalFees;           // Sum of routing fees
        uint256 amount;              // Payment amount
        uint256 createdAt;
        bool completed;
    }

    // ──────────────────────────────────────────────────────────────
    // Constants
    // ──────────────────────────────────────────────────────────────

    /// @notice Default challenge period for disputes (24 hours).
    uint256 public constant DEFAULT_CHALLENGE_PERIOD = 24 hours;

    /// @notice Minimum challenge period (1 hour).
    uint256 public constant MIN_CHALLENGE_PERIOD = 1 hours;

    /// @notice Maximum challenge period (7 days).
    uint256 public constant MAX_CHALLENGE_PERIOD = 7 days;

    /// @notice Minimum HTLC timelock (1 hour).
    uint256 public constant MIN_HTLC_TIMELOCK = 1 hours;

    /// @notice Maximum HTLC timelock (30 days).
    uint256 public constant MAX_HTLC_TIMELOCK = 30 days;

    /// @notice Maximum routing fee in basis points (5%).
    uint256 public constant MAX_ROUTING_FEE_BPS = 500;

    /// @notice Maximum hops in a routing path.
    uint256 public constant MAX_ROUTING_HOPS = 5;

    /// @notice Minimum watchtower stake.
    uint256 public constant MIN_WATCHTOWER_STAKE = 1 ether;

    /// @notice Maximum batch operation size.
    uint256 public constant MAX_BATCH_SIZE = 20;

    // ──────────────────────────────────────────────────────────────
    // State
    // ──────────────────────────────────────────────────────────────

    /// @notice Channel records keyed by channel ID.
    mapping(bytes32 => Channel) public channels;

    /// @notice Dispute records keyed by channel ID.
    mapping(bytes32 => ChannelDispute) public disputes;

    /// @notice HTLC records keyed by HTLC ID.
    mapping(bytes32 => HTLC) public htlcs;

    /// @notice Active HTLCs per channel.
    mapping(bytes32 => bytes32[]) public channelHTLCs;

    /// @notice Watchtower records keyed by operator address.
    mapping(address => Watchtower) public watchtowers;

    /// @notice Watchtower assignments: channelId => watchtower addresses.
    mapping(bytes32 => address[]) public channelWatchtowers;

    /// @notice Routing path records keyed by path ID.
    mapping(bytes32 => RoutingPath) public routingPaths;

    /// @notice Channels per address (for both parties).
    mapping(address => bytes32[]) public userChannels;

    /// @notice Supported settlement tokens.
    mapping(address => bool) public supportedTokens;

    /// @notice KYC-verified parties (integration with NoblePay compliance).
    mapping(address => bool) public kycVerified;

    /// @notice Channel nonce for unique ID generation.
    uint256 public channelNonce;

    /// @notice HTLC nonce.
    uint256 public htlcNonce;

    /// @notice Routing path nonce.
    uint256 public routingNonce;

    /// @notice Protocol fee on channel closings in basis points.
    uint256 public protocolFeeBps;

    /// @notice Protocol treasury.
    address public protocolTreasury;

    /// @notice NoblePay core contract reference.
    address public noblePayContract;

    // ──────────────────────────────────────────────────────────────
    // Events
    // ──────────────────────────────────────────────────────────────

    event ChannelOpened(
        bytes32 indexed channelId,
        address indexed partyA,
        address indexed partyB,
        address token,
        uint256 depositA,
        uint256 challengePeriod
    );

    event ChannelFunded(
        bytes32 indexed channelId,
        address indexed funder,
        uint256 amount,
        uint256 totalDeposit
    );

    event ChannelActivated(bytes32 indexed channelId);

    event ChannelCooperativeClose(
        bytes32 indexed channelId,
        uint256 finalBalanceA,
        uint256 finalBalanceB,
        uint256 nonce
    );

    event ChannelUnilateralClose(
        bytes32 indexed channelId,
        address indexed initiator,
        uint256 claimedBalanceA,
        uint256 claimedBalanceB,
        uint256 nonce
    );

    event ChannelClosed(
        bytes32 indexed channelId,
        uint256 finalBalanceA,
        uint256 finalBalanceB
    );

    event DisputeInitiated(
        bytes32 indexed channelId,
        address indexed challenger,
        uint256 nonce,
        uint256 expiresAt
    );

    event DisputeCountered(
        bytes32 indexed channelId,
        address indexed responder,
        uint256 higherNonce
    );

    event DisputeResolved(
        bytes32 indexed channelId,
        uint256 finalBalanceA,
        uint256 finalBalanceB
    );

    event HTLCCreated(
        bytes32 indexed htlcId,
        bytes32 indexed channelId,
        address indexed sender,
        uint256 amount,
        bytes32 hashLock,
        uint256 timelock
    );

    event HTLCClaimed(
        bytes32 indexed htlcId,
        bytes32 preimage
    );

    event HTLCRefunded(bytes32 indexed htlcId);

    event WatchtowerRegistered(
        address indexed operator,
        uint256 stake,
        uint256 bountyBps
    );

    event WatchtowerDeregistered(address indexed operator, uint256 stakeReturned);

    event WatchtowerAssigned(
        bytes32 indexed channelId,
        address indexed watchtower
    );

    event RoutingPathCreated(
        bytes32 indexed pathId,
        uint256 hops,
        uint256 amount,
        uint256 totalFees
    );

    event RoutingPathCompleted(bytes32 indexed pathId);

    event ChannelBatchOpened(uint256 count);
    event KYCStatusUpdated(address indexed party, bool verified);
    event TokenSupported(address indexed token, bool supported);

    // ──────────────────────────────────────────────────────────────
    // Errors
    // ──────────────────────────────────────────────────────────────

    error ZeroAddress();
    error ZeroAmount();
    error UnsupportedToken();
    error ChannelNotFound();
    error InvalidChannelStatus(ChannelStatus current);
    error NotChannelParty();
    error InsufficientDeposit();
    error InvalidSignature();
    error NonceTooLow(uint256 provided, uint256 current);
    error ChallengePeriodActive();
    error ChallengePeriodExpired();
    error ChallengeNotExpired();
    error InvalidChallengePeriod();
    error HTLCNotFound();
    error HTLCExpired();
    error HTLCNotExpired();
    error InvalidPreimage();
    error InvalidHTLCStatus(HTLCStatus current);
    error InvalidTimelock();
    error WatchtowerNotFound();
    error WatchtowerAlreadyRegistered();
    error InsufficientStake();
    error RoutingPathTooLong();
    error KYCRequired();
    error InvalidBalances();
    error BatchTooLarge();
    error ChannelAlreadyExists();
    error InvalidFee();

    // ──────────────────────────────────────────────────────────────
    // Modifiers
    // ──────────────────────────────────────────────────────────────

    /// @notice Requires both parties to be KYC-verified.
    modifier onlyKYCVerified(address _partyA, address _partyB) {
        if (!kycVerified[_partyA]) revert KYCRequired();
        if (!kycVerified[_partyB]) revert KYCRequired();
        _;
    }

    /// @notice Restricts to channel participants.
    modifier onlyChannelParty(bytes32 _channelId) {
        Channel storage ch = channels[_channelId];
        if (msg.sender != ch.partyA && msg.sender != ch.partyB) revert NotChannelParty();
        _;
    }

    // ──────────────────────────────────────────────────────────────
    // Constructor
    // ──────────────────────────────────────────────────────────────

    /**
     * @notice Deploys PaymentChannels.
     * @param _admin           Admin address.
     * @param _protocolTreasury Treasury for protocol fees.
     * @param _protocolFeeBps  Protocol fee in basis points.
     */
    constructor(
        address _admin,
        address _protocolTreasury,
        uint256 _protocolFeeBps
    ) {
        if (_admin == address(0)) revert ZeroAddress();
        if (_protocolTreasury == address(0)) revert ZeroAddress();
        if (_protocolFeeBps > 500) revert InvalidFee();

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(ADMIN_ROLE, _admin);

        protocolTreasury = _protocolTreasury;
        protocolFeeBps = _protocolFeeBps;
    }

    // ──────────────────────────────────────────────────────────────
    // External — Channel Lifecycle
    // ──────────────────────────────────────────────────────────────

    /**
     * @notice Opens a new bi-directional payment channel.
     * @param _partyB          Counterparty address.
     * @param _token           ERC20 settlement token.
     * @param _depositAmount   Initial deposit from party A.
     * @param _challengePeriod Dispute challenge window in seconds.
     * @param _routingFeeBps   Fee for routing through this channel.
     * @return channelId       Unique channel identifier.
     */
    function openChannel(
        address _partyB,
        address _token,
        uint256 _depositAmount,
        uint256 _challengePeriod,
        uint256 _routingFeeBps
    ) external whenNotPaused nonReentrant onlyKYCVerified(msg.sender, _partyB) returns (bytes32 channelId) {
        if (_partyB == address(0) || _partyB == msg.sender) revert ZeroAddress();
        if (!supportedTokens[_token]) revert UnsupportedToken();
        if (_depositAmount == 0) revert ZeroAmount();
        _validateChannelParams(_challengePeriod, _routingFeeBps);

        channelId = keccak256(
            abi.encodePacked(msg.sender, _partyB, _token, block.timestamp, channelNonce++)
        );

        channels[channelId] = Channel({
            channelId: channelId,
            partyA: msg.sender,
            partyB: _partyB,
            token: _token,
            depositA: _depositAmount,
            depositB: 0,
            balanceA: _depositAmount,
            balanceB: 0,
            status: ChannelStatus.OPEN,
            nonce: 0,
            openedAt: block.timestamp,
            closingAt: 0,
            closedAt: 0,
            challengePeriod: _challengePeriod,
            routingFeeBps: _routingFeeBps
        });

        userChannels[msg.sender].push(channelId);
        userChannels[_partyB].push(channelId);

        IERC20(_token).safeTransferFrom(msg.sender, address(this), _depositAmount);

        emit ChannelOpened(channelId, msg.sender, _partyB, _token, _depositAmount, _challengePeriod);
    }

    /**
     * @notice Funds a channel (counterparty deposit or top-up).
     * @param _channelId Channel to fund.
     * @param _amount    Amount to deposit.
     */
    function fundChannel(
        bytes32 _channelId,
        uint256 _amount
    ) external whenNotPaused nonReentrant onlyChannelParty(_channelId) {
        Channel storage ch = channels[_channelId];
        if (ch.status != ChannelStatus.OPEN && ch.status != ChannelStatus.FUNDED && ch.status != ChannelStatus.ACTIVE) {
            revert InvalidChannelStatus(ch.status);
        }
        if (_amount == 0) revert ZeroAmount();

        if (msg.sender == ch.partyA) {
            ch.depositA += _amount;
            ch.balanceA += _amount;
        } else {
            ch.depositB += _amount;
            ch.balanceB += _amount;
        }

        // Activate if both parties have funded
        if (ch.status == ChannelStatus.OPEN && ch.depositB > 0) {
            ch.status = ChannelStatus.FUNDED;
            emit ChannelActivated(_channelId);
        }

        if (ch.status == ChannelStatus.FUNDED) {
            ch.status = ChannelStatus.ACTIVE;
        }

        IERC20(ch.token).safeTransferFrom(msg.sender, address(this), _amount);

        uint256 totalDeposit = msg.sender == ch.partyA ? ch.depositA : ch.depositB;
        emit ChannelFunded(_channelId, msg.sender, _amount, totalDeposit);
    }

    /**
     * @notice Cooperatively closes a channel with both parties' signatures.
     * @dev Both parties sign the final state off-chain. Either party submits
     *      it on-chain for immediate settlement (no challenge period).
     * @param _channelId    Channel to close.
     * @param _finalBalanceA Agreed final balance for party A.
     * @param _finalBalanceB Agreed final balance for party B.
     * @param _nonce         State nonce (must be higher than current).
     * @param _signatureA    Party A's signature of the final state.
     * @param _signatureB    Party B's signature of the final state.
     */
    function cooperativeClose(
        bytes32 _channelId,
        uint256 _finalBalanceA,
        uint256 _finalBalanceB,
        uint256 _nonce,
        bytes calldata _signatureA,
        bytes calldata _signatureB
    ) external whenNotPaused nonReentrant onlyChannelParty(_channelId) {
        Channel storage ch = channels[_channelId];
        if (ch.status != ChannelStatus.ACTIVE && ch.status != ChannelStatus.FUNDED) {
            revert InvalidChannelStatus(ch.status);
        }
        if (_nonce <= ch.nonce) revert NonceTooLow(_nonce, ch.nonce);

        uint256 totalDeposit = ch.depositA + ch.depositB;
        if (_finalBalanceA + _finalBalanceB != totalDeposit) revert InvalidBalances();

        // Verify both signatures
        bytes32 stateHash = keccak256(
            abi.encodePacked(_channelId, _finalBalanceA, _finalBalanceB, _nonce, "CLOSE")
        );
        bytes32 ethSignedHash = stateHash.toEthSignedMessageHash();

        address signerA = ethSignedHash.recover(_signatureA);
        address signerB = ethSignedHash.recover(_signatureB);

        if (signerA != ch.partyA) revert InvalidSignature();
        if (signerB != ch.partyB) revert InvalidSignature();

        _settleChannel(ch, _finalBalanceA, _finalBalanceB, _nonce);

        emit ChannelCooperativeClose(_channelId, _finalBalanceA, _finalBalanceB, _nonce);
    }

    /**
     * @notice Initiates a unilateral close with the latest known state.
     * @dev Starts the challenge period. The counterparty can dispute with
     *      a higher-nonce state during the challenge window.
     * @param _channelId    Channel to close.
     * @param _balanceA     Claimed balance for party A.
     * @param _balanceB     Claimed balance for party B.
     * @param _nonce        State nonce.
     * @param _signature    Counterparty's signature of this state.
     */
    function initiateUnilateralClose(
        bytes32 _channelId,
        uint256 _balanceA,
        uint256 _balanceB,
        uint256 _nonce,
        bytes calldata _signature
    ) external whenNotPaused onlyChannelParty(_channelId) {
        Channel storage ch = channels[_channelId];
        if (ch.status != ChannelStatus.ACTIVE && ch.status != ChannelStatus.FUNDED) {
            revert InvalidChannelStatus(ch.status);
        }
        if (_nonce <= ch.nonce) revert NonceTooLow(_nonce, ch.nonce);

        uint256 totalDeposit = ch.depositA + ch.depositB;
        if (_balanceA + _balanceB != totalDeposit) revert InvalidBalances();

        // Verify counterparty's signature
        bytes32 stateHash = keccak256(
            abi.encodePacked(_channelId, _balanceA, _balanceB, _nonce, "STATE")
        );
        bytes32 ethSignedHash = stateHash.toEthSignedMessageHash();
        address signer = ethSignedHash.recover(_signature);

        address counterparty = msg.sender == ch.partyA ? ch.partyB : ch.partyA;
        if (signer != counterparty) revert InvalidSignature();

        ch.status = ChannelStatus.CLOSING;
        ch.closingAt = block.timestamp;
        ch.balanceA = _balanceA;
        ch.balanceB = _balanceB;
        ch.nonce = _nonce;

        // Create dispute record
        disputes[_channelId] = ChannelDispute({
            channelId: _channelId,
            challenger: msg.sender,
            challengeNonce: _nonce,
            challengeBalanceA: _balanceA,
            challengeBalanceB: _balanceB,
            initiatedAt: block.timestamp,
            expiresAt: block.timestamp + ch.challengePeriod,
            resolved: false
        });

        emit ChannelUnilateralClose(_channelId, msg.sender, _balanceA, _balanceB, _nonce);
        emit DisputeInitiated(_channelId, msg.sender, _nonce, block.timestamp + ch.challengePeriod);
    }

    /**
     * @notice Counters a unilateral close with a higher-nonce state.
     * @param _channelId    Channel being disputed.
     * @param _balanceA     Correct balance for party A.
     * @param _balanceB     Correct balance for party B.
     * @param _nonce        Higher nonce than the challenger's.
     * @param _signature    Other party's signature of this state.
     */
    function counterDispute(
        bytes32 _channelId,
        uint256 _balanceA,
        uint256 _balanceB,
        uint256 _nonce,
        bytes calldata _signature
    ) external whenNotPaused onlyChannelParty(_channelId) {
        Channel storage ch = channels[_channelId];
        if (ch.status != ChannelStatus.CLOSING) revert InvalidChannelStatus(ch.status);

        ChannelDispute storage d = disputes[_channelId];
        if (block.timestamp > d.expiresAt) revert ChallengePeriodExpired();
        if (_nonce <= d.challengeNonce) revert NonceTooLow(_nonce, d.challengeNonce);

        uint256 totalDeposit = ch.depositA + ch.depositB;
        if (_balanceA + _balanceB != totalDeposit) revert InvalidBalances();

        // Verify signature
        bytes32 stateHash = keccak256(
            abi.encodePacked(_channelId, _balanceA, _balanceB, _nonce, "STATE")
        );
        bytes32 ethSignedHash = stateHash.toEthSignedMessageHash();
        address signer = ethSignedHash.recover(_signature);

        address counterparty = msg.sender == ch.partyA ? ch.partyB : ch.partyA;
        if (signer != counterparty) revert InvalidSignature();

        // Update dispute with higher nonce state
        d.challengeNonce = _nonce;
        d.challengeBalanceA = _balanceA;
        d.challengeBalanceB = _balanceB;
        d.challenger = msg.sender;
        d.expiresAt = block.timestamp + ch.challengePeriod; // Reset challenge period

        ch.balanceA = _balanceA;
        ch.balanceB = _balanceB;
        ch.nonce = _nonce;

        emit DisputeCountered(_channelId, msg.sender, _nonce);
    }

    /**
     * @notice Finalizes a unilateral close after the challenge period expires.
     * @param _channelId Channel to finalize.
     */
    function finalizeClose(
        bytes32 _channelId
    ) external whenNotPaused nonReentrant {
        Channel storage ch = channels[_channelId];
        if (ch.status != ChannelStatus.CLOSING) revert InvalidChannelStatus(ch.status);

        ChannelDispute storage d = disputes[_channelId];
        if (block.timestamp < d.expiresAt) revert ChallengeNotExpired();

        d.resolved = true;

        _settleChannel(ch, d.challengeBalanceA, d.challengeBalanceB, d.challengeNonce);

        emit DisputeResolved(_channelId, d.challengeBalanceA, d.challengeBalanceB);
    }

    // ──────────────────────────────────────────────────────────────
    // External — HTLC (Hash Time-Locked Contracts)
    // ──────────────────────────────────────────────────────────────

    /**
     * @notice Creates an HTLC for a conditional payment within a channel.
     * @dev Used for multi-hop routing: the sender locks funds that can only
     *      be claimed by revealing the preimage of the hash lock.
     * @param _channelId Channel containing the HTLC.
     * @param _amount    Amount locked in the HTLC.
     * @param _hashLock  keccak256 of the secret preimage.
     * @param _timelock  Expiry timestamp for the HTLC.
     * @return htlcId    Unique HTLC identifier.
     */
    function createHTLC(
        bytes32 _channelId,
        uint256 _amount,
        bytes32 _hashLock,
        uint256 _timelock
    ) external whenNotPaused onlyChannelParty(_channelId) returns (bytes32 htlcId) {
        Channel storage ch = channels[_channelId];
        if (ch.status != ChannelStatus.ACTIVE) revert InvalidChannelStatus(ch.status);
        if (_amount == 0) revert ZeroAmount();
        if (_timelock < block.timestamp + MIN_HTLC_TIMELOCK) revert InvalidTimelock();
        if (_timelock > block.timestamp + MAX_HTLC_TIMELOCK) revert InvalidTimelock();

        // Verify sender has sufficient balance in the channel
        uint256 senderBalance = msg.sender == ch.partyA ? ch.balanceA : ch.balanceB;
        if (_amount > senderBalance) revert InsufficientDeposit();

        // Lock funds
        if (msg.sender == ch.partyA) {
            ch.balanceA -= _amount;
        } else {
            ch.balanceB -= _amount;
        }

        address receiver = msg.sender == ch.partyA ? ch.partyB : ch.partyA;

        htlcId = keccak256(
            abi.encodePacked(_channelId, msg.sender, _amount, _hashLock, block.timestamp, htlcNonce++)
        );

        htlcs[htlcId] = HTLC({
            htlcId: htlcId,
            channelId: _channelId,
            sender: msg.sender,
            receiver: receiver,
            amount: _amount,
            hashLock: _hashLock,
            timelock: _timelock,
            status: HTLCStatus.ACTIVE,
            createdAt: block.timestamp
        });

        channelHTLCs[_channelId].push(htlcId);

        emit HTLCCreated(htlcId, _channelId, msg.sender, _amount, _hashLock, _timelock);
    }

    /**
     * @notice Claims an HTLC by revealing the preimage.
     * @param _htlcId   HTLC to claim.
     * @param _preimage Secret preimage whose hash matches the hash lock.
     */
    function claimHTLC(
        bytes32 _htlcId,
        bytes32 _preimage
    ) external whenNotPaused {
        HTLC storage h = htlcs[_htlcId];
        if (h.createdAt == 0) revert HTLCNotFound();
        if (h.status != HTLCStatus.ACTIVE) revert InvalidHTLCStatus(h.status);
        if (block.timestamp > h.timelock) revert HTLCExpired();
        if (keccak256(abi.encodePacked(_preimage)) != h.hashLock) revert InvalidPreimage();

        h.status = HTLCStatus.CLAIMED;

        // Credit receiver's channel balance
        Channel storage ch = channels[h.channelId];
        if (h.receiver == ch.partyA) {
            ch.balanceA += h.amount;
        } else {
            ch.balanceB += h.amount;
        }

        emit HTLCClaimed(_htlcId, _preimage);
    }

    /**
     * @notice Refunds an expired HTLC back to the sender.
     * @param _htlcId HTLC to refund.
     */
    function refundHTLC(bytes32 _htlcId) external whenNotPaused {
        HTLC storage h = htlcs[_htlcId];
        if (h.createdAt == 0) revert HTLCNotFound();
        if (h.status != HTLCStatus.ACTIVE) revert InvalidHTLCStatus(h.status);
        if (block.timestamp <= h.timelock) revert HTLCNotExpired();

        h.status = HTLCStatus.REFUNDED;

        // Return funds to sender's channel balance
        Channel storage ch = channels[h.channelId];
        if (h.sender == ch.partyA) {
            ch.balanceA += h.amount;
        } else {
            ch.balanceB += h.amount;
        }

        emit HTLCRefunded(_htlcId);
    }

    // ──────────────────────────────────────────────────────────────
    // External — Multi-Hop Routing
    // ──────────────────────────────────────────────────────────────

    /**
     * @notice Registers a multi-hop routing path through intermediary channels.
     * @dev Called by routing nodes to establish a payment path. Each hop
     *      has an associated channel and routing fee.
     * @param _channelIds     Ordered array of channel IDs forming the path.
     * @param _intermediaries Addresses of routing nodes.
     * @param _amount         Payment amount.
     * @return pathId         Unique path identifier.
     */
    function registerRoutingPath(
        bytes32[] calldata _channelIds,
        address[] calldata _intermediaries,
        uint256 _amount
    ) external whenNotPaused onlyRole(ROUTER_ROLE) returns (bytes32 pathId) {
        if (_channelIds.length == 0) revert ZeroAmount();
        if (_channelIds.length > MAX_ROUTING_HOPS) revert RoutingPathTooLong();
        require(
            _channelIds.length == _intermediaries.length + 1,
            "PaymentChannels: invalid path structure"
        );

        uint256 totalFees;
        for (uint256 i; i < _channelIds.length;) {
            Channel storage ch = channels[_channelIds[i]];
            if (ch.openedAt == 0) revert ChannelNotFound();
            if (ch.status != ChannelStatus.ACTIVE) revert InvalidChannelStatus(ch.status);
            totalFees += (_amount * ch.routingFeeBps) / 10_000;

            unchecked { ++i; }
        }

        pathId = keccak256(
            abi.encodePacked(msg.sender, _amount, block.timestamp, routingNonce++)
        );

        routingPaths[pathId] = RoutingPath({
            pathId: pathId,
            channelIds: _channelIds,
            intermediaries: _intermediaries,
            totalFees: totalFees,
            amount: _amount,
            createdAt: block.timestamp,
            completed: false
        });

        emit RoutingPathCreated(pathId, _channelIds.length, _amount, totalFees);
    }

    /**
     * @notice Marks a routing path as completed.
     * @param _pathId Path to mark as completed.
     */
    function completeRoutingPath(bytes32 _pathId) external onlyRole(ROUTER_ROLE) {
        RoutingPath storage path = routingPaths[_pathId];
        require(path.createdAt > 0, "PaymentChannels: path not found");
        require(!path.completed, "PaymentChannels: already completed");

        path.completed = true;
        emit RoutingPathCompleted(_pathId);
    }

    // ──────────────────────────────────────────────────────────────
    // External — Watchtower Management
    // ──────────────────────────────────────────────────────────────

    /**
     * @notice Registers as a watchtower for channel monitoring.
     * @param _bountyBps Bounty rate in basis points for successful disputes.
     */
    function registerWatchtower(
        uint256 _bountyBps
    ) external payable whenNotPaused nonReentrant {
        if (watchtowers[msg.sender].registeredAt != 0) revert WatchtowerAlreadyRegistered();
        if (msg.value < MIN_WATCHTOWER_STAKE) revert InsufficientStake();
        if (_bountyBps > MAX_ROUTING_FEE_BPS) revert InvalidFee();

        watchtowers[msg.sender] = Watchtower({
            operator: msg.sender,
            stake: msg.value,
            bountyBps: _bountyBps,
            channelsMonitored: 0,
            disputesRaised: 0,
            active: true,
            registeredAt: block.timestamp
        });

        _grantRole(WATCHTOWER_ROLE, msg.sender);

        emit WatchtowerRegistered(msg.sender, msg.value, _bountyBps);
    }

    /**
     * @notice Deregisters a watchtower and returns stake.
     */
    function deregisterWatchtower() external nonReentrant {
        Watchtower storage wt = watchtowers[msg.sender];
        if (wt.registeredAt == 0) revert WatchtowerNotFound();

        uint256 stakeToReturn = wt.stake;
        wt.active = false;
        wt.stake = 0;

        _revokeRole(WATCHTOWER_ROLE, msg.sender);

        if (stakeToReturn > 0) {
            (bool ok, ) = msg.sender.call{value: stakeToReturn}("");
            require(ok, "PaymentChannels: stake return failed");
        }

        emit WatchtowerDeregistered(msg.sender, stakeToReturn);
    }

    /**
     * @notice Assigns a watchtower to monitor a channel.
     * @param _channelId  Channel to monitor.
     * @param _watchtower Watchtower address.
     */
    function assignWatchtower(
        bytes32 _channelId,
        address _watchtower
    ) external onlyChannelParty(_channelId) whenNotPaused {
        if (channels[_channelId].openedAt == 0) revert ChannelNotFound();
        Watchtower storage wt = watchtowers[_watchtower];
        if (!wt.active) revert WatchtowerNotFound();

        channelWatchtowers[_channelId].push(_watchtower);
        wt.channelsMonitored++;

        emit WatchtowerAssigned(_channelId, _watchtower);
    }

    // ──────────────────────────────────────────────────────────────
    // External — Batch Operations
    // ──────────────────────────────────────────────────────────────

    /**
     * @notice Opens multiple channels in a single transaction.
     * @param _counterparties Array of counterparty addresses.
     * @param _token          Shared settlement token.
     * @param _deposits       Array of initial deposits.
     * @param _challengePeriod Shared challenge period.
     * @param _routingFeeBps  Shared routing fee.
     * @return channelIds     Array of created channel IDs.
     */
    function batchOpenChannels(
        address[] calldata _counterparties,
        address _token,
        uint256[] calldata _deposits,
        uint256 _challengePeriod,
        uint256 _routingFeeBps
    ) external whenNotPaused nonReentrant returns (bytes32[] memory channelIds) {
        uint256 count = _counterparties.length;
        if (count == 0) revert ZeroAmount();
        if (count > MAX_BATCH_SIZE) revert BatchTooLarge();
        require(count == _deposits.length, "PaymentChannels: array mismatch");
        if (!supportedTokens[_token]) revert UnsupportedToken();
        _validateChannelParams(_challengePeriod, _routingFeeBps);

        channelIds = new bytes32[](count);
        uint256 totalDeposit;

        for (uint256 i; i < count;) {
            if (!kycVerified[msg.sender] || !kycVerified[_counterparties[i]]) revert KYCRequired();
            if (_deposits[i] == 0) revert ZeroAmount();

            bytes32 id = keccak256(
                abi.encodePacked(msg.sender, _counterparties[i], _token, block.timestamp, channelNonce++)
            );
            channelIds[i] = id;

            channels[id] = Channel({
                channelId: id,
                partyA: msg.sender,
                partyB: _counterparties[i],
                token: _token,
                depositA: _deposits[i],
                depositB: 0,
                balanceA: _deposits[i],
                balanceB: 0,
                status: ChannelStatus.OPEN,
                nonce: 0,
                openedAt: block.timestamp,
                closingAt: 0,
                closedAt: 0,
                challengePeriod: _challengePeriod,
                routingFeeBps: _routingFeeBps
            });

            userChannels[msg.sender].push(id);
            userChannels[_counterparties[i]].push(id);
            totalDeposit += _deposits[i];

            emit ChannelOpened(id, msg.sender, _counterparties[i], _token, _deposits[i], _challengePeriod);

            unchecked { ++i; }
        }

        IERC20(_token).safeTransferFrom(msg.sender, address(this), totalDeposit);

        emit ChannelBatchOpened(count);
    }

    // ──────────────────────────────────────────────────────────────
    // View Functions
    // ──────────────────────────────────────────────────────────────

    /// @notice Returns a channel record.
    function getChannel(bytes32 _channelId) external view returns (Channel memory) {
        return channels[_channelId];
    }

    /// @notice Returns the dispute record for a channel.
    function getDispute(bytes32 _channelId) external view returns (ChannelDispute memory) {
        return disputes[_channelId];
    }

    /// @notice Returns an HTLC record.
    function getHTLC(bytes32 _htlcId) external view returns (HTLC memory) {
        return htlcs[_htlcId];
    }

    /// @notice Returns all HTLC IDs for a channel.
    function getChannelHTLCs(bytes32 _channelId) external view returns (bytes32[] memory) {
        return channelHTLCs[_channelId];
    }

    /// @notice Returns all channel IDs for a user.
    function getUserChannels(address _user) external view returns (bytes32[] memory) {
        return userChannels[_user];
    }

    /// @notice Returns a watchtower record.
    function getWatchtower(address _operator) external view returns (Watchtower memory) {
        return watchtowers[_operator];
    }

    /// @notice Returns assigned watchtowers for a channel.
    function getChannelWatchtowers(bytes32 _channelId) external view returns (address[] memory) {
        return channelWatchtowers[_channelId];
    }

    /// @notice Returns a routing path record.
    function getRoutingPath(bytes32 _pathId) external view returns (RoutingPath memory) {
        return routingPaths[_pathId];
    }

    /// @notice Computes the state hash for off-chain signing.
    function computeStateHash(
        bytes32 _channelId,
        uint256 _balanceA,
        uint256 _balanceB,
        uint256 _nonce,
        string calldata _type
    ) external pure returns (bytes32) {
        return keccak256(
            abi.encodePacked(_channelId, _balanceA, _balanceB, _nonce, _type)
        );
    }

    // ──────────────────────────────────────────────────────────────
    // Admin Functions
    // ──────────────────────────────────────────────────────────────

    /// @notice Updates KYC verification status for a party.
    function setKYCStatus(address _party, bool _verified) external onlyRole(ADMIN_ROLE) {
        if (_party == address(0)) revert ZeroAddress();
        kycVerified[_party] = _verified;
        emit KYCStatusUpdated(_party, _verified);
    }

    /// @notice Batch updates KYC verification status.
    function batchSetKYCStatus(
        address[] calldata _parties,
        bool[] calldata _statuses
    ) external onlyRole(ADMIN_ROLE) {
        require(_parties.length == _statuses.length, "PaymentChannels: array mismatch");
        for (uint256 i; i < _parties.length;) {
            if (_parties[i] == address(0)) revert ZeroAddress();
            kycVerified[_parties[i]] = _statuses[i];
            emit KYCStatusUpdated(_parties[i], _statuses[i]);
            unchecked { ++i; }
        }
    }

    /// @notice Adds or removes a supported settlement token.
    function setSupportedToken(address _token, bool _supported) external onlyRole(ADMIN_ROLE) {
        if (_token == address(0)) revert ZeroAddress();
        supportedTokens[_token] = _supported;
        emit TokenSupported(_token, _supported);
    }

    /// @notice Sets the NoblePay contract reference.
    function setNoblePayContract(address _noblepay) external onlyRole(ADMIN_ROLE) {
        if (_noblepay == address(0)) revert ZeroAddress();
        noblePayContract = _noblepay;
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
     * @dev Validates channel parameters shared by openChannel and batchOpenChannels.
     * @param _challengePeriod Dispute challenge window in seconds.
     * @param _routingFeeBps   Fee for routing through this channel.
     */
    function _validateChannelParams(uint256 _challengePeriod, uint256 _routingFeeBps) internal pure {
        if (_challengePeriod < MIN_CHALLENGE_PERIOD || _challengePeriod > MAX_CHALLENGE_PERIOD) {
            revert InvalidChallengePeriod();
        }
        if (_routingFeeBps > MAX_ROUTING_FEE_BPS) revert InvalidFee();
    }

    /**
     * @dev Settles a channel by transferring final balances to both parties.
     * @param ch             Channel storage reference.
     * @param _finalBalanceA Final balance for party A.
     * @param _finalBalanceB Final balance for party B.
     * @param _nonce         Final state nonce.
     */
    function _settleChannel(
        Channel storage ch,
        uint256 _finalBalanceA,
        uint256 _finalBalanceB,
        uint256 _nonce
    ) internal {
        ch.status = ChannelStatus.CLOSED;
        ch.closedAt = block.timestamp;
        ch.balanceA = _finalBalanceA;
        ch.balanceB = _finalBalanceB;
        ch.nonce = _nonce;

        // Apply protocol fee
        uint256 totalFee;
        uint256 feeA;
        uint256 feeB;

        if (protocolFeeBps > 0) {
            feeA = (_finalBalanceA * protocolFeeBps) / 10_000;
            feeB = (_finalBalanceB * protocolFeeBps) / 10_000;
            totalFee = feeA + feeB;
        }

        uint256 payA = _finalBalanceA - feeA;
        uint256 payB = _finalBalanceB - feeB;

        if (payA > 0) {
            IERC20(ch.token).safeTransfer(ch.partyA, payA);
        }
        if (payB > 0) {
            IERC20(ch.token).safeTransfer(ch.partyB, payB);
        }
        if (totalFee > 0) {
            IERC20(ch.token).safeTransfer(protocolTreasury, totalFee);
        }

        emit ChannelClosed(ch.channelId, _finalBalanceA, _finalBalanceB);
    }

    /// @notice Allows the contract to receive native tokens for watchtower stakes.
    receive() external payable {}
}
