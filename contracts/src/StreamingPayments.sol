// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title StreamingPayments
 * @author Aethelred Team
 * @notice Per-second payment streaming with cliff periods for the NoblePay platform.
 *         Supports continuous salary disbursement, vesting-style cliff unlocks,
 *         batch payroll creation, and fine-grained stream lifecycle management.
 *
 * @dev Architecture overview:
 *
 * ┌───────────────────────────────────────────────────────────────────┐
 * │                    STREAMING PAYMENTS                             │
 * ├───────────────────────────────────────────────────────────────────┤
 * │  ┌─────────────────┐  ┌──────────────────┐  ┌────────────────┐  │
 * │  │  Stream Mgmt     │  │  Cliff Engine     │  │  Withdrawals   │  │
 * │  │  ──────────────  │  │  ──────────────── │  │  ────────────  │  │
 * │  │  • create        │  │  • cliff period   │  │  • per-second  │  │
 * │  │  • pause/resume  │  │  • unlock calc    │  │  • batch claim │  │
 * │  │  • cancel        │  │  • partial vest   │  │  • auto-sweep  │  │
 * │  └─────────────────┘  └──────────────────┘  └────────────────┘  │
 * │  ┌─────────────────┐  ┌──────────────────┐                      │
 * │  │  Batch Payroll   │  │  Balance Calc     │                      │
 * │  │  ──────────────  │  │  ──────────────── │                      │
 * │  │  • multi-stream  │  │  • withdrawable   │                      │
 * │  │  • same sender   │  │  • remaining      │                      │
 * │  │  • gas-efficient │  │  • rate tracking  │                      │
 * │  └─────────────────┘  └──────────────────┘                      │
 * └───────────────────────────────────────────────────────────────────┘
 *
 * Trust model:
 *   - Senders deposit the full stream amount upfront into escrow.
 *   - Recipients can withdraw accrued funds at any time.
 *   - Stream admins can pause streams in emergencies; cancellation
 *     returns unvested funds to the sender.
 */
contract StreamingPayments is AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ──────────────────────────────────────────────────────────────
    // Roles
    // ──────────────────────────────────────────────────────────────

    bytes32 public constant STREAM_ADMIN_ROLE = keccak256("STREAM_ADMIN_ROLE");

    // ──────────────────────────────────────────────────────────────
    // Enums
    // ──────────────────────────────────────────────────────────────

    /// @notice Lifecycle status of a payment stream.
    enum StreamStatus {
        ACTIVE,
        PAUSED,
        CANCELLED,
        COMPLETED
    }

    // ──────────────────────────────────────────────────────────────
    // Structs
    // ──────────────────────────────────────────────────────────────

    /// @notice Core payment stream record.
    struct Stream {
        address sender;
        address recipient;
        address token;
        uint256 totalAmount;
        uint256 withdrawnAmount;
        uint256 ratePerSecond;
        uint256 startTime;
        uint256 endTime;
        uint256 cliffEndTime;            // No withdrawals allowed before cliff
        uint256 lastWithdrawTime;
        uint256 pausedAt;                // Timestamp when paused (0 if active)
        uint256 totalPausedDuration;     // Accumulated paused time
        StreamStatus status;
    }

    // ──────────────────────────────────────────────────────────────
    // Constants
    // ──────────────────────────────────────────────────────────────

    /// @notice Minimum stream duration: 1 hour.
    uint256 public constant MIN_STREAM_DURATION = 1 hours;

    /// @notice Maximum cliff period: 365 days.
    uint256 public constant MAX_CLIFF_PERIOD = 365 days;

    /// @notice Maximum batch size for payroll creation.
    uint256 public constant MAX_BATCH_SIZE = 50;

    // ──────────────────────────────────────────────────────────────
    // State
    // ──────────────────────────────────────────────────────────────

    /// @notice Monotonically increasing stream nonce.
    uint256 public streamNonce;

    /// @notice Stream records keyed by stream ID.
    mapping(bytes32 => Stream) public streams;

    /// @notice Sender address => array of stream IDs they created.
    mapping(address => bytes32[]) public senderStreams;

    /// @notice Recipient address => array of stream IDs they receive.
    mapping(address => bytes32[]) public recipientStreams;

    /// @notice Total value locked per token across all active streams.
    mapping(address => uint256) public totalValueLocked;

    // ──────────────────────────────────────────────────────────────
    // Events
    // ──────────────────────────────────────────────────────────────

    event StreamCreated(
        bytes32 indexed streamId,
        address indexed sender,
        address indexed recipient,
        address token,
        uint256 totalAmount,
        uint256 ratePerSecond,
        uint256 startTime,
        uint256 endTime,
        uint256 cliffEndTime
    );
    event StreamPaused(bytes32 indexed streamId, uint256 pausedAt);
    event StreamResumed(bytes32 indexed streamId, uint256 resumedAt, uint256 pausedDuration);
    event StreamCancelled(
        bytes32 indexed streamId,
        uint256 recipientAmount,
        uint256 senderRefund,
        uint256 cancelledAt
    );
    event StreamCompleted(bytes32 indexed streamId, uint256 completedAt);
    event Withdrawal(
        bytes32 indexed streamId,
        address indexed recipient,
        uint256 amount,
        uint256 timestamp
    );
    event BatchStreamsCreated(
        address indexed sender,
        uint256 streamCount,
        uint256 totalAmount
    );

    // ──────────────────────────────────────────────────────────────
    // Errors
    // ──────────────────────────────────────────────────────────────

    error ZeroAddress();
    error ZeroAmount();
    error InvalidRecipient();
    error StreamNotFound();
    error StreamNotActive();
    error StreamNotPaused();
    error StreamAlreadyPaused();
    error InvalidDuration(uint256 provided, uint256 minimum);
    error CliffTooLong(uint256 provided, uint256 maximum);
    error CliffExceedsDuration();
    error NothingToWithdraw();
    error CliffNotReached(uint256 cliffEnd, uint256 currentTime);
    error Unauthorized();
    error BatchTooLarge(uint256 provided, uint256 maximum);
    error ArrayLengthMismatch();
    error InsufficientDeposit(uint256 required, uint256 provided);

    // ──────────────────────────────────────────────────────────────
    // Constructor
    // ──────────────────────────────────────────────────────────────

    /**
     * @notice Deploys the StreamingPayments contract.
     * @param _admin Admin address with full control.
     */
    constructor(address _admin) {
        if (_admin == address(0)) revert ZeroAddress();

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(STREAM_ADMIN_ROLE, _admin);
    }

    // ──────────────────────────────────────────────────────────────
    // External — Stream Creation
    // ──────────────────────────────────────────────────────────────

    /**
     * @notice Creates a new payment stream with an optional cliff period.
     * @param _recipient    Address receiving the streamed funds.
     * @param _token        ERC20 token to stream.
     * @param _totalAmount  Total amount to stream over the full duration.
     * @param _duration     Stream duration in seconds.
     * @param _cliffPeriod  Cliff period in seconds (0 for no cliff).
     * @return streamId     Unique stream identifier.
     */
    function createStream(
        address _recipient,
        address _token,
        uint256 _totalAmount,
        uint256 _duration,
        uint256 _cliffPeriod
    ) external whenNotPaused nonReentrant returns (bytes32 streamId) {
        if (_recipient == address(0)) revert ZeroAddress();
        if (_recipient == msg.sender) revert InvalidRecipient();
        if (_token == address(0)) revert ZeroAddress();
        if (_totalAmount == 0) revert ZeroAmount();
        if (_duration < MIN_STREAM_DURATION) revert InvalidDuration(_duration, MIN_STREAM_DURATION);
        if (_cliffPeriod > MAX_CLIFF_PERIOD) revert CliffTooLong(_cliffPeriod, MAX_CLIFF_PERIOD);
        if (_cliffPeriod >= _duration) revert CliffExceedsDuration();

        uint256 ratePerSecond = _totalAmount / _duration;
        require(ratePerSecond > 0, "StreamingPayments: rate too low");

        // Escrow the full stream amount
        IERC20(_token).safeTransferFrom(msg.sender, address(this), _totalAmount);

        uint256 startTime = block.timestamp;
        uint256 endTime = startTime + _duration;
        uint256 cliffEndTime = startTime + _cliffPeriod;

        streamId = keccak256(
            abi.encodePacked(msg.sender, _recipient, _token, _totalAmount, streamNonce++)
        );

        streams[streamId] = Stream({
            sender: msg.sender,
            recipient: _recipient,
            token: _token,
            totalAmount: _totalAmount,
            withdrawnAmount: 0,
            ratePerSecond: ratePerSecond,
            startTime: startTime,
            endTime: endTime,
            cliffEndTime: cliffEndTime,
            lastWithdrawTime: startTime,
            pausedAt: 0,
            totalPausedDuration: 0,
            status: StreamStatus.ACTIVE
        });

        senderStreams[msg.sender].push(streamId);
        recipientStreams[_recipient].push(streamId);
        totalValueLocked[_token] += _totalAmount;

        emit StreamCreated(
            streamId, msg.sender, _recipient, _token,
            _totalAmount, ratePerSecond, startTime, endTime, cliffEndTime
        );
    }

    /**
     * @notice Creates multiple streams in a single transaction for payroll.
     * @param _recipients   Array of recipient addresses.
     * @param _token        ERC20 token to stream (same for all).
     * @param _amounts      Array of total amounts per stream.
     * @param _duration     Stream duration in seconds (same for all).
     * @param _cliffPeriod  Cliff period in seconds (same for all).
     * @return streamIds    Array of created stream identifiers.
     */
    function createBatchStreams(
        address[] calldata _recipients,
        address _token,
        uint256[] calldata _amounts,
        uint256 _duration,
        uint256 _cliffPeriod
    ) external whenNotPaused nonReentrant returns (bytes32[] memory streamIds) {
        uint256 count = _recipients.length;
        if (count == 0) revert ZeroAmount();
        if (count > MAX_BATCH_SIZE) revert BatchTooLarge(count, MAX_BATCH_SIZE);
        if (count != _amounts.length) revert ArrayLengthMismatch();
        if (_token == address(0)) revert ZeroAddress();
        if (_duration < MIN_STREAM_DURATION) revert InvalidDuration(_duration, MIN_STREAM_DURATION);
        if (_cliffPeriod > MAX_CLIFF_PERIOD) revert CliffTooLong(_cliffPeriod, MAX_CLIFF_PERIOD);
        if (_cliffPeriod >= _duration) revert CliffExceedsDuration();

        // Calculate and transfer total amount upfront
        uint256 totalRequired;
        for (uint256 i; i < count;) {
            totalRequired += _amounts[i];
            unchecked { ++i; }
        }
        IERC20(_token).safeTransferFrom(msg.sender, address(this), totalRequired);
        totalValueLocked[_token] += totalRequired;

        streamIds = new bytes32[](count);
        uint256 startTime = block.timestamp;
        uint256 endTime = startTime + _duration;
        uint256 cliffEndTime = startTime + _cliffPeriod;

        for (uint256 i; i < count;) {
            if (_recipients[i] == address(0)) revert ZeroAddress();
            if (_recipients[i] == msg.sender) revert InvalidRecipient();
            if (_amounts[i] == 0) revert ZeroAmount();

            uint256 rate = _amounts[i] / _duration;
            require(rate > 0, "StreamingPayments: rate too low");

            bytes32 sid = keccak256(
                abi.encodePacked(msg.sender, _recipients[i], _token, _amounts[i], streamNonce++)
            );
            streamIds[i] = sid;

            streams[sid] = Stream({
                sender: msg.sender,
                recipient: _recipients[i],
                token: _token,
                totalAmount: _amounts[i],
                withdrawnAmount: 0,
                ratePerSecond: rate,
                startTime: startTime,
                endTime: endTime,
                cliffEndTime: cliffEndTime,
                lastWithdrawTime: startTime,
                pausedAt: 0,
                totalPausedDuration: 0,
                status: StreamStatus.ACTIVE
            });

            senderStreams[msg.sender].push(sid);
            recipientStreams[_recipients[i]].push(sid);

            emit StreamCreated(
                sid, msg.sender, _recipients[i], _token,
                _amounts[i], rate, startTime, endTime, cliffEndTime
            );

            unchecked { ++i; }
        }

        emit BatchStreamsCreated(msg.sender, count, totalRequired);
    }

    // ──────────────────────────────────────────────────────────────
    // External — Stream Lifecycle
    // ──────────────────────────────────────────────────────────────

    /**
     * @notice Pauses an active stream. Only sender or admin may pause.
     * @param _streamId Stream to pause.
     */
    function pauseStream(bytes32 _streamId) external whenNotPaused {
        Stream storage s = streams[_streamId];
        if (s.sender == address(0)) revert StreamNotFound();
        if (s.status != StreamStatus.ACTIVE) revert StreamNotActive();
        if (msg.sender != s.sender && !hasRole(STREAM_ADMIN_ROLE, msg.sender)) revert Unauthorized();

        s.status = StreamStatus.PAUSED;
        s.pausedAt = block.timestamp;

        emit StreamPaused(_streamId, block.timestamp);
    }

    /**
     * @notice Resumes a paused stream. Only sender or admin may resume.
     * @param _streamId Stream to resume.
     */
    function resumeStream(bytes32 _streamId) external whenNotPaused {
        Stream storage s = streams[_streamId];
        if (s.sender == address(0)) revert StreamNotFound();
        if (s.status != StreamStatus.PAUSED) revert StreamNotPaused();
        if (msg.sender != s.sender && !hasRole(STREAM_ADMIN_ROLE, msg.sender)) revert Unauthorized();

        uint256 pausedDuration = block.timestamp - s.pausedAt;
        s.totalPausedDuration += pausedDuration;
        s.endTime += pausedDuration; // Extend end time by paused duration
        s.cliffEndTime += pausedDuration; // Extend cliff if still relevant
        s.pausedAt = 0;
        s.status = StreamStatus.ACTIVE;

        emit StreamResumed(_streamId, block.timestamp, pausedDuration);
    }

    /**
     * @notice Cancels a stream. Accrued funds go to recipient, remainder to sender.
     * @param _streamId Stream to cancel.
     */
    function cancelStream(bytes32 _streamId) external whenNotPaused nonReentrant {
        Stream storage s = streams[_streamId];
        if (s.sender == address(0)) revert StreamNotFound();
        if (s.status == StreamStatus.CANCELLED || s.status == StreamStatus.COMPLETED) {
            revert StreamNotActive();
        }
        if (msg.sender != s.sender && !hasRole(STREAM_ADMIN_ROLE, msg.sender)) revert Unauthorized();

        uint256 recipientAmount = _withdrawableBalance(_streamId);
        uint256 senderRefund = s.totalAmount - s.withdrawnAmount - recipientAmount;

        s.status = StreamStatus.CANCELLED;
        totalValueLocked[s.token] -= (s.totalAmount - s.withdrawnAmount);

        // Transfer accrued amount to recipient
        if (recipientAmount > 0) {
            IERC20(s.token).safeTransfer(s.recipient, recipientAmount);
        }

        // Refund remaining to sender
        if (senderRefund > 0) {
            IERC20(s.token).safeTransfer(s.sender, senderRefund);
        }

        emit StreamCancelled(_streamId, recipientAmount, senderRefund, block.timestamp);
    }

    // ──────────────────────────────────────────────────────────────
    // External — Withdrawals
    // ──────────────────────────────────────────────────────────────

    /**
     * @notice Withdraws all accrued funds from a stream.
     * @param _streamId Stream to withdraw from.
     */
    function withdraw(bytes32 _streamId) external whenNotPaused nonReentrant {
        Stream storage s = streams[_streamId];
        if (s.sender == address(0)) revert StreamNotFound();
        if (s.status != StreamStatus.ACTIVE) revert StreamNotActive();
        if (msg.sender != s.recipient) revert Unauthorized();

        // Enforce cliff
        if (block.timestamp < s.cliffEndTime) {
            revert CliffNotReached(s.cliffEndTime, block.timestamp);
        }

        uint256 amount = _withdrawableBalance(_streamId);
        if (amount == 0) revert NothingToWithdraw();

        s.withdrawnAmount += amount;
        s.lastWithdrawTime = block.timestamp;
        totalValueLocked[s.token] -= amount;

        // Check if stream is fully vested
        if (s.withdrawnAmount >= s.totalAmount) {
            s.status = StreamStatus.COMPLETED;
            emit StreamCompleted(_streamId, block.timestamp);
        }

        IERC20(s.token).safeTransfer(s.recipient, amount);

        emit Withdrawal(_streamId, s.recipient, amount, block.timestamp);
    }

    // ──────────────────────────────────────────────────────────────
    // View Functions
    // ──────────────────────────────────────────────────────────────

    /// @notice Returns the full stream record.
    function getStream(bytes32 _streamId) external view returns (Stream memory) {
        return streams[_streamId];
    }

    /// @notice Returns the withdrawable balance for a stream.
    function withdrawableBalance(bytes32 _streamId) external view returns (uint256) {
        return _withdrawableBalance(_streamId);
    }

    /// @notice Returns the remaining unvested amount in a stream.
    function remainingBalance(bytes32 _streamId) external view returns (uint256) {
        Stream storage s = streams[_streamId];
        return s.totalAmount - s.withdrawnAmount;
    }

    /// @notice Returns the number of streams created by a sender.
    function getSenderStreamCount(address _sender) external view returns (uint256) {
        return senderStreams[_sender].length;
    }

    /// @notice Returns the number of streams a recipient is receiving.
    function getRecipientStreamCount(address _recipient) external view returns (uint256) {
        return recipientStreams[_recipient].length;
    }

    /// @notice Returns the effective elapsed time accounting for pauses.
    function getEffectiveElapsed(bytes32 _streamId) external view returns (uint256) {
        return _effectiveElapsed(streams[_streamId]);
    }

    // ──────────────────────────────────────────────────────────────
    // Admin
    // ──────────────────────────────────────────────────────────────

    /// @notice Emergency pause — halts all stream operations.
    function pause() external onlyRole(STREAM_ADMIN_ROLE) {
        _pause();
    }

    /// @notice Resume operations after emergency.
    function unpause() external onlyRole(STREAM_ADMIN_ROLE) {
        _unpause();
    }

    // ──────────────────────────────────────────────────────────────
    // Internal
    // ──────────────────────────────────────────────────────────────

    /**
     * @dev Calculates the withdrawable balance for a stream, accounting for
     *      cliff periods, pause durations, and previously withdrawn amounts.
     * @param _streamId Stream to calculate.
     * @return amount   Withdrawable token amount.
     */
    function _withdrawableBalance(bytes32 _streamId) internal view returns (uint256 amount) {
        Stream storage s = streams[_streamId];

        if (s.status == StreamStatus.CANCELLED || s.status == StreamStatus.COMPLETED) {
            return 0;
        }

        // Before cliff, nothing is withdrawable
        if (block.timestamp < s.cliffEndTime) {
            return 0;
        }

        uint256 elapsed = _effectiveElapsed(s);
        uint256 totalDuration = s.endTime - s.startTime - s.totalPausedDuration;

        uint256 earned;
        if (elapsed >= totalDuration) {
            earned = s.totalAmount;
        } else {
            earned = s.ratePerSecond * elapsed;
            // Cap at total amount to handle rounding
            if (earned > s.totalAmount) {
                earned = s.totalAmount;
            }
        }

        amount = earned > s.withdrawnAmount ? earned - s.withdrawnAmount : 0;
    }

    /**
     * @dev Calculates effective elapsed time excluding paused periods.
     * @param s Stream storage reference.
     * @return Effective elapsed seconds.
     */
    function _effectiveElapsed(Stream storage s) internal view returns (uint256) {
        uint256 currentTime = block.timestamp;

        // If paused, use the pause timestamp as current
        if (s.status == StreamStatus.PAUSED && s.pausedAt > 0) {
            currentTime = s.pausedAt;
        }

        if (currentTime <= s.startTime) return 0;

        uint256 rawElapsed = currentTime - s.startTime;
        uint256 effectivePausedDuration = s.totalPausedDuration;

        // If currently paused, add current pause duration
        if (s.status == StreamStatus.PAUSED && s.pausedAt > 0) {
            // Already using pausedAt as currentTime, so no extra adjustment needed
        }

        return rawElapsed > effectivePausedDuration ? rawElapsed - effectivePausedDuration : 0;
    }
}
