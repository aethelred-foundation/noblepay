// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/access/AccessControlEnumerable.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

import "./interfaces/IBusinessRegistry.sol";

/**
 * @title PaymentChannels
 * @author Aethelred Team
 * @notice High-frequency settlement channel contract for the NoblePay cross-border
 *         payment platform. Enables bi-directional payment channels for high-volume
 *         B2B payments with off-chain signing and on-chain settlement, dispute
 *         resolution, guaranteed exits, and HTLC conditional payments.
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
 * │  │  Exit safety      │  │  HTLC             │  │  Live KYC      │  │
 * │  │  ──────────────  │  │  ──────────────── │  │  ──────────── │  │
 * │  │  • cancel open   │  │  • hash locks     │  │  • registry    │  │
 * │  │  • current state │  │  • time locks     │  │  • suspension  │  │
 * │  │  • challenge     │  │  • conditional     │  │  • revocation  │  │
 * │  │  • fee recovery  │  │  • atomic swap     │  │  • expiry      │  │
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
 *   5. HTLCs enable conditional payments without an unverified routing facade
 */
contract PaymentChannels is AccessControlEnumerable, Pausable, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    // ──────────────────────────────────────────────────────────────
    // Roles
    // ──────────────────────────────────────────────────────────────

    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant TREASURY_ROLE = keccak256("TREASURY_ROLE");

    /// @notice EIP-712 type hash used for every signed channel state.
    bytes32 public constant CHANNEL_STATE_TYPEHASH = keccak256(
        "ChannelState(bytes32 channelId,uint256 balanceA,uint256 balanceB,uint256 nonce,uint256 stateEpoch,bytes32 stateType)"
    );

    /// @notice Typed-state discriminator for cooperative closes.
    bytes32 public constant CLOSE_STATE_TYPE = keccak256("CLOSE");

    /// @notice Typed-state discriminator for unilateral closes and disputes.
    bytes32 public constant UPDATE_STATE_TYPE = keccak256("STATE");

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
        uint256 stateEpoch;          // Invalidates signatures across on-chain balance mutations
        uint256 openedAt;
        uint256 closingAt;           // When closing was initiated
        uint256 closedAt;
        uint256 challengePeriod;     // Duration of dispute window
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

    /// @notice Maximum protocol settlement fee in basis points (5%).
    uint256 public constant MAX_PROTOCOL_FEE_BPS = 500;

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

    /// @notice Total channel balance currently reserved by unresolved HTLCs.
    mapping(bytes32 => uint256) public activeHTLCLockedAmount;

    /// @notice Channels per address (for both parties).
    mapping(address => bytes32[]) public userChannels;

    /// @notice Supported settlement tokens.
    mapping(address => bool) public supportedTokens;

    /// @notice Immutable-after-configuration source of current business KYC status.
    IBusinessRegistry public businessRegistry;

    /// @notice Channel nonce for unique ID generation.
    uint256 public channelNonce;

    /// @notice HTLC nonce.
    uint256 public htlcNonce;

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

    event ChannelCancelled(
        bytes32 indexed channelId,
        address indexed opener,
        uint256 refundAmount
    );

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

    event ChannelCurrentStateClose(
        bytes32 indexed channelId,
        address indexed initiator,
        uint256 balanceA,
        uint256 balanceB,
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

    event ChannelBatchOpened(uint256 count);
    event BusinessRegistryConfigured(address indexed businessRegistry);
    event TokenSupported(address indexed token, bool supported);
    event ProtocolTreasuryUpdated(
        address indexed previousTreasury,
        address indexed newTreasury
    );
    event ProtocolFeeUpdated(uint256 previousFeeBps, uint256 newFeeBps);

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
    error KYCRequired();
    error InvalidBalances();
    error BatchTooLarge();
    error ChannelAlreadyExists();
    error InvalidFee();
    error InvalidSettlementToken(address token);
    error InvalidTokenDecimals(uint8 provided);
    error EscrowTransferMismatch(uint256 expected, uint256 received);
    error ActiveHTLCLock(bytes32 channelId, uint256 amount);
    error InvalidBusinessRegistry(address registry);
    error BusinessRegistryAlreadyConfigured();
    error NotChannelOpener();

    // ──────────────────────────────────────────────────────────────
    // Modifiers
    // ──────────────────────────────────────────────────────────────

    /// @notice Requires both parties to be currently active in BusinessRegistry.
    modifier onlyKYCVerified(address _partyA, address _partyB) {
        _requireLiveKYC(_partyA, _partyB);
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
    ) EIP712("NoblePay PaymentChannels", "1") {
        if (_admin == address(0)) revert ZeroAddress();
        if (_protocolTreasury == address(0)) revert ZeroAddress();
        if (_protocolFeeBps > MAX_PROTOCOL_FEE_BPS) revert InvalidFee();

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(ADMIN_ROLE, _admin);
        _grantRole(TREASURY_ROLE, _admin);

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
     * @return channelId       Unique channel identifier.
     */
    function openChannel(
        address _partyB,
        address _token,
        uint256 _depositAmount,
        uint256 _challengePeriod
    ) external whenNotPaused nonReentrant onlyKYCVerified(msg.sender, _partyB) returns (bytes32 channelId) {
        _validateCounterparty(msg.sender, _partyB);
        if (!supportedTokens[_token]) revert UnsupportedToken();
        if (_depositAmount == 0) revert ZeroAmount();
        _validateChallengePeriod(_challengePeriod);

        channelId = keccak256(
            abi.encode(
                block.chainid,
                address(this),
                msg.sender,
                _partyB,
                _token,
                block.timestamp,
                channelNonce++
            )
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
            stateEpoch: 0,
            openedAt: block.timestamp,
            closingAt: 0,
            closedAt: 0,
            challengePeriod: _challengePeriod
        });

        userChannels[msg.sender].push(channelId);
        userChannels[_partyB].push(channelId);

        _pullExactEscrow(IERC20(_token), msg.sender, _depositAmount);

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
        _requireLiveKYC(ch.partyA, ch.partyB);
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

        // A state may be signed with a future nonce and balances that anticipate this
        // deposit. Advancing the epoch makes every pre-funding signature unusable once
        // the channel's escrow and balances change.
        ch.stateEpoch++;

        // Activate if both parties have funded
        if (ch.status == ChannelStatus.OPEN && ch.depositB > 0) {
            ch.status = ChannelStatus.FUNDED;
            emit ChannelActivated(_channelId);
        }

        if (ch.status == ChannelStatus.FUNDED) {
            ch.status = ChannelStatus.ACTIVE;
        }

        _pullExactEscrow(IERC20(ch.token), msg.sender, _amount);

        uint256 totalDeposit = msg.sender == ch.partyA ? ch.depositA : ch.depositB;
        emit ChannelFunded(_channelId, msg.sender, _amount, totalDeposit);
    }

    /**
     * @notice Cancels a channel that the counterparty never funded and refunds
     *         every escrowed token to the opener without charging a protocol fee.
     * @dev This is an exit-only recovery path. It deliberately remains callable
     *      while paused and after either party loses KYC status. Effects precede
     *      the external transfer and `nonReentrant` prevents token callbacks from
     *      attempting a second refund.
     * @param _channelId Channel to cancel.
     */
    function cancelOpenChannel(bytes32 _channelId) external nonReentrant {
        Channel storage ch = channels[_channelId];
        if (ch.openedAt == 0) revert ChannelNotFound();
        if (msg.sender != ch.partyA) revert NotChannelOpener();
        if (ch.status != ChannelStatus.OPEN) revert InvalidChannelStatus(ch.status);

        // OPEN can include opener top-ups, but party B has never funded and no
        // off-chain/HTLC state can have consumed escrow in this lifecycle state.
        if (ch.depositB != 0 || ch.balanceB != 0 || ch.balanceA != ch.depositA) {
            revert InvalidBalances();
        }

        uint256 refundAmount = ch.balanceA;
        ch.status = ChannelStatus.CLOSED;
        ch.closedAt = block.timestamp;

        IERC20(ch.token).safeTransfer(ch.partyA, refundAmount);

        emit ChannelCancelled(_channelId, ch.partyA, refundAmount);
        emit ChannelClosed(_channelId, refundAmount, 0);
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
        _requireNoActiveHTLC(_channelId);
        if (_nonce <= ch.nonce) revert NonceTooLow(_nonce, ch.nonce);

        uint256 totalDeposit = ch.depositA + ch.depositB;
        if (_finalBalanceA + _finalBalanceB != totalDeposit) revert InvalidBalances();

        // Verify both EIP-712 signatures. The digest commits to this chain and deployment.
        bytes32 stateHash = _stateDigest(
            _channelId,
            _finalBalanceA,
            _finalBalanceB,
            _nonce,
            CLOSE_STATE_TYPE
        );

        if (!SignatureChecker.isValidSignatureNow(ch.partyA, stateHash, _signatureA)) {
            revert InvalidSignature();
        }
        if (!SignatureChecker.isValidSignatureNow(ch.partyB, stateHash, _signatureB)) {
            revert InvalidSignature();
        }

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
        _requireNoActiveHTLC(_channelId);
        if (_nonce <= ch.nonce) revert NonceTooLow(_nonce, ch.nonce);

        uint256 totalDeposit = ch.depositA + ch.depositB;
        if (_balanceA + _balanceB != totalDeposit) revert InvalidBalances();

        // Verify the counterparty's EIP-712 signature.
        bytes32 stateHash = _stateDigest(
            _channelId,
            _balanceA,
            _balanceB,
            _nonce,
            UPDATE_STATE_TYPE
        );
        address counterparty = msg.sender == ch.partyA ? ch.partyB : ch.partyA;
        if (!SignatureChecker.isValidSignatureNow(counterparty, stateHash, _signature)) {
            revert InvalidSignature();
        }

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
     * @notice Starts a unilateral close from the contract's canonical balances
     *         without requiring either party to have signed an off-chain state.
     * @dev This guarantees an ACTIVE channel can always make progress if a party
     *      refuses to produce the first signature. The normal challenge period
     *      applies, and either party may counter with a higher, jointly signed
     *      state. As an exit-only path it remains available while paused and
     *      after KYC suspension, revocation, or expiry.
     * @param _channelId Channel to close from its current on-chain balances.
     */
    function initiateCurrentStateClose(
        bytes32 _channelId
    ) external nonReentrant onlyChannelParty(_channelId) {
        Channel storage ch = channels[_channelId];
        if (ch.status != ChannelStatus.ACTIVE) revert InvalidChannelStatus(ch.status);
        _requireNoActiveHTLC(_channelId);

        ch.status = ChannelStatus.CLOSING;
        ch.closingAt = block.timestamp;

        uint256 expiresAt = block.timestamp + ch.challengePeriod;
        disputes[_channelId] = ChannelDispute({
            channelId: _channelId,
            challenger: msg.sender,
            challengeNonce: ch.nonce,
            challengeBalanceA: ch.balanceA,
            challengeBalanceB: ch.balanceB,
            initiatedAt: block.timestamp,
            expiresAt: expiresAt,
            resolved: false
        });

        emit ChannelCurrentStateClose(
            _channelId,
            msg.sender,
            ch.balanceA,
            ch.balanceB,
            ch.nonce
        );
        emit DisputeInitiated(_channelId, msg.sender, ch.nonce, expiresAt);
    }

    /**
     * @notice Counters a unilateral close with a higher-nonce state.
     * @param _channelId    Channel being disputed.
     * @param _balanceA     Correct balance for party A.
     * @param _balanceB     Correct balance for party B.
     * @param _nonce        Higher nonce than the challenger's.
     * @param _signature    Other party's signature of this state.
     * @dev Remains callable while paused so an emergency pause cannot consume
     *      the victim's challenge window and finalize a stale state.
     */
    function counterDispute(
        bytes32 _channelId,
        uint256 _balanceA,
        uint256 _balanceB,
        uint256 _nonce,
        bytes calldata _signature
    ) external onlyChannelParty(_channelId) {
        Channel storage ch = channels[_channelId];
        if (ch.status != ChannelStatus.CLOSING) revert InvalidChannelStatus(ch.status);

        ChannelDispute storage d = disputes[_channelId];
        if (block.timestamp > d.expiresAt) revert ChallengePeriodExpired();
        if (_nonce <= d.challengeNonce) revert NonceTooLow(_nonce, d.challengeNonce);

        uint256 totalDeposit = ch.depositA + ch.depositB;
        if (_balanceA + _balanceB != totalDeposit) revert InvalidBalances();

        // Verify the counterparty's EIP-712 signature.
        bytes32 stateHash = _stateDigest(
            _channelId,
            _balanceA,
            _balanceB,
            _nonce,
            UPDATE_STATE_TYPE
        );
        address counterparty = msg.sender == ch.partyA ? ch.partyB : ch.partyA;
        if (!SignatureChecker.isValidSignatureNow(counterparty, stateHash, _signature)) {
            revert InvalidSignature();
        }

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
    ) external nonReentrant {
        Channel storage ch = channels[_channelId];
        if (ch.status != ChannelStatus.CLOSING) revert InvalidChannelStatus(ch.status);
        _requireNoActiveHTLC(_channelId);

        ChannelDispute storage d = disputes[_channelId];
        // Counter-disputes are valid through `expiresAt`; settlement becomes
        // valid only in the first block strictly after it, eliminating the
        // equality-block race where both actions were previously executable.
        if (block.timestamp <= d.expiresAt) revert ChallengeNotExpired();

        d.resolved = true;

        _settleChannel(ch, d.challengeBalanceA, d.challengeBalanceB, d.challengeNonce);

        emit DisputeResolved(_channelId, d.challengeBalanceA, d.challengeBalanceB);
    }

    // ──────────────────────────────────────────────────────────────
    // External — HTLC (Hash Time-Locked Contracts)
    // ──────────────────────────────────────────────────────────────

    /**
     * @notice Creates an HTLC for a conditional payment within a channel.
     * @dev The sender locks funds that can only
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
        _requireLiveKYC(ch.partyA, ch.partyB);
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
        activeHTLCLockedAmount[_channelId] += _amount;
        ch.stateEpoch++;

        emit HTLCCreated(htlcId, _channelId, msg.sender, _amount, _hashLock, _timelock);
    }

    /**
     * @notice Claims an HTLC by revealing the preimage.
     * @param _htlcId   HTLC to claim.
     * @param _preimage Secret preimage whose hash matches the hash lock.
     * @dev Remains callable while paused because its absolute timelock continues
     *      to advance and the preimage holder must retain the full claim window.
     */
    function claimHTLC(
        bytes32 _htlcId,
        bytes32 _preimage
    ) external {
        HTLC storage h = htlcs[_htlcId];
        if (h.createdAt == 0) revert HTLCNotFound();
        if (h.status != HTLCStatus.ACTIVE) revert InvalidHTLCStatus(h.status);
        if (block.timestamp > h.timelock) revert HTLCExpired();
        if (keccak256(abi.encodePacked(_preimage)) != h.hashLock) revert InvalidPreimage();

        h.status = HTLCStatus.CLAIMED;
        activeHTLCLockedAmount[h.channelId] -= h.amount;

        // Credit receiver's channel balance
        Channel storage ch = channels[h.channelId];
        if (h.receiver == ch.partyA) {
            ch.balanceA += h.amount;
        } else {
            ch.balanceB += h.amount;
        }
        ch.stateEpoch++;

        emit HTLCClaimed(_htlcId, _preimage);
    }

    /**
     * @notice Refunds an expired HTLC back to the sender.
     * @param _htlcId HTLC to refund.
     * @dev Remains callable while paused so an expired conditional lock cannot
     *      strand channel funds until governance restores unrelated operations.
     */
    function refundHTLC(bytes32 _htlcId) external {
        HTLC storage h = htlcs[_htlcId];
        if (h.createdAt == 0) revert HTLCNotFound();
        if (h.status != HTLCStatus.ACTIVE) revert InvalidHTLCStatus(h.status);
        if (block.timestamp <= h.timelock) revert HTLCNotExpired();

        h.status = HTLCStatus.REFUNDED;
        activeHTLCLockedAmount[h.channelId] -= h.amount;

        // Return funds to sender's channel balance
        Channel storage ch = channels[h.channelId];
        if (h.sender == ch.partyA) {
            ch.balanceA += h.amount;
        } else {
            ch.balanceB += h.amount;
        }
        ch.stateEpoch++;

        emit HTLCRefunded(_htlcId);
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
     * @return channelIds     Array of created channel IDs.
     */
    function batchOpenChannels(
        address[] calldata _counterparties,
        address _token,
        uint256[] calldata _deposits,
        uint256 _challengePeriod
    ) external whenNotPaused nonReentrant returns (bytes32[] memory channelIds) {
        uint256 count = _counterparties.length;
        if (count == 0) revert ZeroAmount();
        if (count > MAX_BATCH_SIZE) revert BatchTooLarge();
        require(count == _deposits.length, "PaymentChannels: array mismatch");
        if (!supportedTokens[_token]) revert UnsupportedToken();
        _validateChallengePeriod(_challengePeriod);

        channelIds = new bytes32[](count);
        uint256 totalDeposit;

        if (!kycVerified(msg.sender)) revert KYCRequired();

        for (uint256 i; i < count;) {
            _validateCounterparty(msg.sender, _counterparties[i]);
            if (!kycVerified(_counterparties[i])) revert KYCRequired();
            if (_deposits[i] == 0) revert ZeroAmount();

            bytes32 id = keccak256(
                abi.encode(
                    block.chainid,
                    address(this),
                    msg.sender,
                    _counterparties[i],
                    _token,
                    block.timestamp,
                    channelNonce++
                )
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
                stateEpoch: 0,
                openedAt: block.timestamp,
                closingAt: 0,
                closedAt: 0,
                challengePeriod: _challengePeriod
            });

            userChannels[msg.sender].push(id);
            userChannels[_counterparties[i]].push(id);
            totalDeposit += _deposits[i];

            emit ChannelOpened(id, msg.sender, _counterparties[i], _token, _deposits[i], _challengePeriod);

            unchecked { ++i; }
        }

        _pullExactEscrow(IERC20(_token), msg.sender, totalDeposit);

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

    /// @notice Returns whether a party is verified, unsuspended, unrevoked, and
    ///         within BusinessRegistry's annual re-verification window.
    /// @dev Keeps the historical `kycVerified(address)` read selector while making
    ///      the result live and fail-closed rather than an administrator-maintained snapshot.
    function kycVerified(address _party) public view returns (bool) {
        IBusinessRegistry registry = businessRegistry;
        if (address(registry) == address(0) || address(registry).code.length == 0) return false;

        try registry.isBusinessActive(_party) returns (bool active) {
            return active;
        } catch {
            return false;
        }
    }

    /**
     * @notice Computes the final EIP-712 digest that wallets must sign for a channel state.
     * @dev The digest includes the EIP-712 domain (name `NoblePay PaymentChannels`, version
     *      `1`, current chain ID, and this contract as verifying contract). `_type` must be
     *      `CLOSE` for cooperative close or `STATE` for unilateral/dispute state updates.
     *      It also commits to the channel's current `stateEpoch`, so any signature produced
     *      before a funding/top-up or HTLC create, claim, or refund can never be replayed
     *      after that on-chain balance mutation.
     *      Callers should normally use `eth_signTypedData_v4`, not `personal_sign`.
     */
    function computeStateHash(
        bytes32 _channelId,
        uint256 _balanceA,
        uint256 _balanceB,
        uint256 _nonce,
        string calldata _type
    ) external view returns (bytes32) {
        return _stateDigest(
            _channelId,
            _balanceA,
            _balanceB,
            _nonce,
            keccak256(bytes(_type))
        );
    }

    // ──────────────────────────────────────────────────────────────
    // Admin Functions
    // ──────────────────────────────────────────────────────────────

    /// @notice Configures the canonical BusinessRegistry exactly once.
    /// @dev Channel entry and balance-increasing operations remain fail-closed until
    ///      this is configured. A registry migration requires a new PaymentChannels
    ///      deployment and explicit operational cut-over, matching NoblePay's trust model.
    function configureBusinessRegistry(address _registry) external onlyRole(ADMIN_ROLE) {
        if (address(businessRegistry) != address(0)) revert BusinessRegistryAlreadyConfigured();
        if (_registry == address(0) || _registry.code.length == 0) {
            revert InvalidBusinessRegistry(_registry);
        }

        // Probe the exact selector before making this trust dependency permanent.
        // A failed decode or revert identifies an ABI-incompatible target and avoids
        // irreversibly bricking all channel entry operations.
        try IBusinessRegistry(_registry).isBusinessActive(address(this)) returns (bool) {
            // Either true or false is a valid registry decision for this address.
        } catch {
            revert InvalidBusinessRegistry(_registry);
        }

        businessRegistry = IBusinessRegistry(_registry);
        emit BusinessRegistryConfigured(_registry);
    }

    /// @notice Adds or removes a supported settlement token.
    function setSupportedToken(address _token, bool _supported) external onlyRole(ADMIN_ROLE) {
        if (_token == address(0)) revert ZeroAddress();
        if (_supported) _validateSettlementToken(_token);
        supportedTokens[_token] = _supported;
        emit TokenSupported(_token, _supported);
    }

    /// @notice Sets the NoblePay contract reference.
    function setNoblePayContract(address _noblepay) external onlyRole(ADMIN_ROLE) {
        if (_noblepay == address(0)) revert ZeroAddress();
        noblePayContract = _noblepay;
    }

    /// @notice Rotates the fee beneficiary if the current treasury is unavailable
    ///         or blocked by a supported stablecoin.
    /// @dev Kept separate from operational administration through TREASURY_ROLE.
    ///      Rotation itself transfers no funds and is safe while paused.
    function setProtocolTreasury(
        address _newTreasury
    ) external onlyRole(TREASURY_ROLE) {
        if (_newTreasury == address(0)) revert ZeroAddress();
        address previousTreasury = protocolTreasury;
        protocolTreasury = _newTreasury;
        emit ProtocolTreasuryUpdated(previousTreasury, _newTreasury);
    }

    /// @notice Updates the bounded protocol settlement fee, including zero-fee
    ///         emergency recovery when no safe treasury can receive a token.
    /// @dev The 5% hard cap cannot be increased by governance. The dedicated
    ///      TREASURY_ROLE may invoke this while paused before settlement resumes.
    function setProtocolFeeBps(
        uint256 _newFeeBps
    ) external onlyRole(TREASURY_ROLE) {
        if (_newFeeBps > MAX_PROTOCOL_FEE_BPS) revert InvalidFee();
        uint256 previousFeeBps = protocolFeeBps;
        protocolFeeBps = _newFeeBps;
        emit ProtocolFeeUpdated(previousFeeBps, _newFeeBps);
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
     * @dev Validates the challenge period shared by openChannel and batchOpenChannels.
     * @param _challengePeriod Dispute challenge window in seconds.
     */
    function _validateChallengePeriod(uint256 _challengePeriod) internal pure {
        if (_challengePeriod < MIN_CHALLENGE_PERIOD || _challengePeriod > MAX_CHALLENGE_PERIOD) {
            revert InvalidChallengePeriod();
        }
    }

    /// @dev Enforces identical counterparty constraints for single and batch opening.
    function _validateCounterparty(address partyA, address partyB) internal pure {
        if (partyB == address(0) || partyB == partyA) revert ZeroAddress();
    }

    /// @dev Uses live registry state for both channel parties and fails closed on
    ///      an unconfigured, unavailable, or ABI-incompatible trust dependency.
    function _requireLiveKYC(address partyA, address partyB) internal view {
        if (!kycVerified(partyA) || !kycVerified(partyB)) revert KYCRequired();
    }

    /// @dev Builds the EIP-712 digest consumed by EOA and ERC-1271 signature checks.
    function _stateDigest(
        bytes32 _channelId,
        uint256 _balanceA,
        uint256 _balanceB,
        uint256 _nonce,
        bytes32 _stateType
    ) internal view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                CHANNEL_STATE_TYPEHASH,
                _channelId,
                _balanceA,
                _balanceB,
                _nonce,
                channels[_channelId].stateEpoch,
                _stateType
            )
        );
        return _hashTypedDataV4(structHash);
    }

    /// @dev Rejects EOAs, incomplete token facades, and non-six-decimal assets.
    function _validateSettlementToken(address _token) internal view {
        if (_token.code.length == 0) revert InvalidSettlementToken(_token);

        uint8 tokenDecimals;
        try IERC20Metadata(_token).decimals() returns (uint8 decimals_) {
            tokenDecimals = decimals_;
        } catch {
            revert InvalidSettlementToken(_token);
        }
        if (tokenDecimals != 6) revert InvalidTokenDecimals(tokenDecimals);

        try IERC20(_token).totalSupply() returns (uint256) {} catch {
            revert InvalidSettlementToken(_token);
        }
        try IERC20(_token).balanceOf(address(this)) returns (uint256) {} catch {
            revert InvalidSettlementToken(_token);
        }
    }

    /// @dev Pulls escrow only when this contract receives exactly the accounted amount.
    function _pullExactEscrow(IERC20 _token, address _from, uint256 _amount) internal {
        uint256 balanceBefore = _token.balanceOf(address(this));
        _token.safeTransferFrom(_from, address(this), _amount);
        uint256 balanceAfter = _token.balanceOf(address(this));
        uint256 received = balanceAfter >= balanceBefore ? balanceAfter - balanceBefore : 0;
        if (received != _amount) revert EscrowTransferMismatch(_amount, received);
    }

    /// @dev Settlement cannot account for funds still reserved by conditional transfers.
    function _requireNoActiveHTLC(bytes32 _channelId) internal view {
        uint256 lockedAmount = activeHTLCLockedAmount[_channelId];
        if (lockedAmount != 0) revert ActiveHTLCLock(_channelId, lockedAmount);
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

}
