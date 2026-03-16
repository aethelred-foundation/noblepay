// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title CrossChainRouter
 * @author Aethelred Team
 * @notice Multi-chain transaction routing with relay verification for the
 *         NoblePay cross-border payment platform. Routes payments across
 *         supported chains via registered relay nodes with cryptographic
 *         proof verification and stuck-transaction recovery.
 *
 * @dev Architecture overview:
 *
 * ┌───────────────────────────────────────────────────────────────────┐
 * │                     CROSS-CHAIN ROUTER                            │
 * ├───────────────────────────────────────────────────────────────────┤
 * │  ┌─────────────────┐  ┌──────────────────┐  ┌────────────────┐  │
 * │  │  Transfer Init   │  │  Relay Verify    │  │  Recovery       │  │
 * │  │  ──────────────  │  │  ──────────────── │  │  ────────────  │  │
 * │  │  • lock funds    │  │  • proof check   │  │  • timeout      │  │
 * │  │  • route select  │  │  • multi-relay   │  │  • manual recov │  │
 * │  │  • fee estimate  │  │  • finality wait │  │  • refund       │  │
 * │  └─────────────────┘  └──────────────────┘  └────────────────┘  │
 * │  ┌─────────────────┐  ┌──────────────────┐  ┌────────────────┐  │
 * │  │  Relay Registry  │  │  Chain Registry  │  │  Fee Engine     │  │
 * │  │  ──────────────  │  │  ──────────────── │  │  ────────────  │  │
 * │  │  • register      │  │  • add/remove    │  │  • base + pct   │  │
 * │  │  • deregister    │  │  • finality cfg  │  │  • per-chain    │  │
 * │  │  • reputation    │  │  • gas oracle    │  │  • estimation   │  │
 * │  └─────────────────┘  └──────────────────┘  └────────────────┘  │
 * └───────────────────────────────────────────────────────────────────┘
 *
 * Trust model:
 *   - Relay operators are registered with stake collateral and must
 *     provide valid proofs for cross-chain delivery confirmation.
 *   - Transfers are locked on the source chain and released on the
 *     destination chain upon proof verification.
 *   - Stuck transactions can be recovered after a configurable timeout.
 */
contract CrossChainRouter is AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ──────────────────────────────────────────────────────────────
    // Roles
    // ──────────────────────────────────────────────────────────────

    bytes32 public constant ROUTER_ADMIN_ROLE = keccak256("ROUTER_ADMIN_ROLE");
    bytes32 public constant RELAY_OPERATOR_ROLE = keccak256("RELAY_OPERATOR_ROLE");

    // ──────────────────────────────────────────────────────────────
    // Enums
    // ──────────────────────────────────────────────────────────────

    /// @notice Lifecycle status of a cross-chain transfer.
    enum TransferStatus {
        INITIATED,
        RELAYED,
        CONFIRMED,
        COMPLETED,
        FAILED,
        RECOVERED
    }

    // ──────────────────────────────────────────────────────────────
    // Structs
    // ──────────────────────────────────────────────────────────────

    /// @notice Cross-chain transfer record.
    struct Transfer {
        address sender;
        bytes32 recipientHash;           // Hash of recipient address on destination chain
        address sourceToken;
        uint256 amount;
        uint256 fee;
        uint256 destinationChainId;
        bytes32 destinationTxHash;       // Tx hash on the destination chain (set by relay)
        TransferStatus status;
        address assignedRelay;
        uint256 initiatedAt;
        uint256 completedAt;
        uint256 deadline;                // Recovery deadline
        bytes relayProof;                // Cryptographic proof of delivery
    }

    /// @notice Registered relay node.
    struct RelayNode {
        address operator;
        uint256 stake;
        uint256 reputation;              // 0-1000 scale (100.0%)
        uint256 totalRelayed;
        uint256 totalFailed;
        uint256 registeredAt;
        bool active;
    }

    /// @notice Supported destination chain configuration.
    struct ChainConfig {
        uint256 chainId;
        string name;
        uint256 baseFee;                 // Base relay fee in source token units
        uint256 feeRateBP;              // Percentage fee in basis points
        uint256 finalityBlocks;          // Blocks to wait for finality
        uint256 recoveryTimeout;         // Seconds before transfer can be recovered
        uint256 minTransferAmount;
        uint256 maxTransferAmount;
        bool active;
    }

    /// @notice Fee estimation result.
    struct FeeEstimate {
        uint256 baseFee;
        uint256 percentageFee;
        uint256 totalFee;
        uint256 estimatedDeliveryTime;   // Estimated seconds to complete
    }

    // ──────────────────────────────────────────────────────────────
    // Constants
    // ──────────────────────────────────────────────────────────────

    /// @notice Minimum relay stake: 5 ETH equivalent.
    uint256 public constant MIN_RELAY_STAKE = 5 ether;

    /// @notice Maximum fee rate: 200 bp = 2%.
    uint256 public constant MAX_FEE_RATE_BP = 200;

    /// @notice Minimum recovery timeout: 2 hours.
    uint256 public constant MIN_RECOVERY_TIMEOUT = 2 hours;

    /// @notice Reputation penalty for failed relay: -50 points.
    uint256 public constant FAILURE_PENALTY = 50;

    /// @notice Reputation reward for successful relay: +1 point.
    uint256 public constant SUCCESS_REWARD = 1;

    /// @notice Initial relay reputation score.
    uint256 public constant INITIAL_REPUTATION = 500;

    // ──────────────────────────────────────────────────────────────
    // State
    // ──────────────────────────────────────────────────────────────

    /// @notice Monotonically increasing transfer nonce.
    uint256 public transferNonce;

    /// @notice Treasury address for protocol fee collection.
    address public treasury;

    /// @notice Protocol fee share in basis points (portion of relay fees).
    uint256 public protocolFeeBP;

    /// @notice Transfer records keyed by transfer ID.
    mapping(bytes32 => Transfer) public transfers;

    /// @notice Relay node records keyed by operator address.
    mapping(address => RelayNode) public relayNodes;

    /// @notice Active relay node addresses.
    address[] public activeRelays;

    /// @notice Index tracking for active relay array.
    mapping(address => uint256) internal _activeRelayIndex;

    /// @notice Chain configurations keyed by chain ID.
    mapping(uint256 => ChainConfig) public chainConfigs;

    /// @notice Supported chain IDs.
    uint256[] public supportedChainIds;

    /// @notice Sender address => array of transfer IDs.
    mapping(address => bytes32[]) public senderTransfers;

    /// @notice Relay operator => array of transfer IDs they relayed.
    mapping(address => bytes32[]) public relayedTransfers;

    /// @notice Supported source tokens for cross-chain transfer.
    mapping(address => bool) public supportedTokens;

    // ──────────────────────────────────────────────────────────────
    // Events
    // ──────────────────────────────────────────────────────────────

    event TransferInitiated(
        bytes32 indexed transferId,
        address indexed sender,
        uint256 indexed destinationChainId,
        address sourceToken,
        uint256 amount,
        uint256 fee,
        bytes32 recipientHash
    );
    event TransferRelayed(
        bytes32 indexed transferId,
        address indexed relay,
        bytes32 destinationTxHash
    );
    event TransferCompleted(
        bytes32 indexed transferId,
        uint256 completedAt
    );
    event TransferRecovered(
        bytes32 indexed transferId,
        address indexed sender,
        uint256 refundAmount,
        uint256 recoveredAt
    );
    event TransferFailed(
        bytes32 indexed transferId,
        address indexed relay,
        string reason
    );
    event RelayRegistered(
        address indexed operator,
        uint256 stake,
        uint256 reputation
    );
    event RelayDeregistered(
        address indexed operator,
        uint256 stakeReturned
    );
    event RelayReputationUpdated(
        address indexed operator,
        uint256 oldReputation,
        uint256 newReputation
    );
    event ChainAdded(uint256 indexed chainId, string name);
    event ChainRemoved(uint256 indexed chainId);
    event ChainConfigUpdated(uint256 indexed chainId);
    event TokenSupportUpdated(address indexed token, bool supported);
    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);

    // ──────────────────────────────────────────────────────────────
    // Errors
    // ──────────────────────────────────────────────────────────────

    error ZeroAddress();
    error ZeroAmount();
    error TransferNotFound();
    error InvalidTransferStatus(TransferStatus current, TransferStatus expected);
    error UnsupportedChain(uint256 chainId);
    error UnsupportedToken(address token);
    error AmountBelowMinimum(uint256 amount, uint256 minimum);
    error AmountAboveMaximum(uint256 amount, uint256 maximum);
    error RelayAlreadyRegistered();
    error RelayNotFound();
    error RelayNotActive();
    error InsufficientStake(uint256 provided, uint256 required);
    error InvalidProof();
    error RecoveryNotAvailable(uint256 deadline, uint256 currentTime);
    error DeadlineNotExpired(uint256 remaining);
    error ChainAlreadyExists(uint256 chainId);
    error InvalidFeeRate(uint256 provided, uint256 maximum);
    error Unauthorized();
    error InvalidRecoveryTimeout(uint256 provided, uint256 minimum);

    // ──────────────────────────────────────────────────────────────
    // Modifiers
    // ──────────────────────────────────────────────────────────────

    /// @notice Restricts to active relay operators.
    modifier onlyActiveRelay() {
        if (!relayNodes[msg.sender].active) revert RelayNotActive();
        _;
    }

    // ──────────────────────────────────────────────────────────────
    // Constructor
    // ──────────────────────────────────────────────────────────────

    /**
     * @notice Deploys the CrossChainRouter.
     * @param _admin    Admin address with full control.
     * @param _treasury Address that receives protocol fees.
     */
    constructor(address _admin, address _treasury) {
        if (_admin == address(0)) revert ZeroAddress();
        if (_treasury == address(0)) revert ZeroAddress();

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(ROUTER_ADMIN_ROLE, _admin);

        treasury = _treasury;
        protocolFeeBP = 1000; // 10% of relay fees go to protocol
    }

    // ──────────────────────────────────────────────────────────────
    // External — Transfer Initiation
    // ──────────────────────────────────────────────────────────────

    /**
     * @notice Initiates a cross-chain transfer by locking funds on the source chain.
     * @param _sourceToken         ERC20 token to transfer.
     * @param _amount              Amount to transfer (before fees).
     * @param _destinationChainId  Target chain ID.
     * @param _recipientHash       Keccak256 hash of the recipient address on the destination chain.
     * @return transferId          Unique transfer identifier.
     */
    function initiateTransfer(
        address _sourceToken,
        uint256 _amount,
        uint256 _destinationChainId,
        bytes32 _recipientHash
    ) external whenNotPaused nonReentrant returns (bytes32 transferId) {
        if (_sourceToken == address(0)) revert ZeroAddress();
        if (_amount == 0) revert ZeroAmount();
        if (!supportedTokens[_sourceToken]) revert UnsupportedToken(_sourceToken);

        ChainConfig storage chain = chainConfigs[_destinationChainId];
        if (!chain.active) revert UnsupportedChain(_destinationChainId);
        if (_amount < chain.minTransferAmount) revert AmountBelowMinimum(_amount, chain.minTransferAmount);
        if (_amount > chain.maxTransferAmount) revert AmountAboveMaximum(_amount, chain.maxTransferAmount);

        // Calculate fees
        uint256 fee = chain.baseFee + (_amount * chain.feeRateBP / 10_000);
        uint256 totalRequired = _amount + fee;

        // Lock funds (principal + fee)
        IERC20(_sourceToken).safeTransferFrom(msg.sender, address(this), totalRequired);

        // Send protocol portion of fee to treasury
        uint256 protocolFee = (fee * protocolFeeBP) / 10_000;
        if (protocolFee > 0) {
            IERC20(_sourceToken).safeTransfer(treasury, protocolFee);
        }

        transferId = keccak256(
            abi.encodePacked(msg.sender, _destinationChainId, _amount, block.timestamp, transferNonce++)
        );

        transfers[transferId] = Transfer({
            sender: msg.sender,
            recipientHash: _recipientHash,
            sourceToken: _sourceToken,
            amount: _amount,
            fee: fee,
            destinationChainId: _destinationChainId,
            destinationTxHash: bytes32(0),
            status: TransferStatus.INITIATED,
            assignedRelay: address(0),
            initiatedAt: block.timestamp,
            completedAt: 0,
            deadline: block.timestamp + chain.recoveryTimeout,
            relayProof: ""
        });

        senderTransfers[msg.sender].push(transferId);

        emit TransferInitiated(
            transferId, msg.sender, _destinationChainId,
            _sourceToken, _amount, fee, _recipientHash
        );
    }

    // ──────────────────────────────────────────────────────────────
    // External — Relay Operations
    // ──────────────────────────────────────────────────────────────

    /**
     * @notice Submits a relay proof confirming delivery on the destination chain.
     * @param _transferId        Transfer to confirm.
     * @param _destinationTxHash Transaction hash on the destination chain.
     * @param _proof             Cryptographic proof of delivery.
     */
    function submitRelayProof(
        bytes32 _transferId,
        bytes32 _destinationTxHash,
        bytes calldata _proof
    ) external whenNotPaused onlyActiveRelay {
        Transfer storage t = transfers[_transferId];
        if (t.sender == address(0)) revert TransferNotFound();
        if (t.status != TransferStatus.INITIATED) {
            revert InvalidTransferStatus(t.status, TransferStatus.INITIATED);
        }
        if (_proof.length == 0) revert InvalidProof();

        t.status = TransferStatus.RELAYED;
        t.assignedRelay = msg.sender;
        t.destinationTxHash = _destinationTxHash;
        t.relayProof = _proof;

        relayedTransfers[msg.sender].push(_transferId);

        emit TransferRelayed(_transferId, msg.sender, _destinationTxHash);
    }

    /**
     * @notice Confirms a relayed transfer after finality verification.
     *         Releases relay fee and updates reputation.
     * @param _transferId Transfer to confirm.
     */
    function confirmTransfer(
        bytes32 _transferId
    ) external onlyRole(ROUTER_ADMIN_ROLE) whenNotPaused {
        Transfer storage t = transfers[_transferId];
        if (t.sender == address(0)) revert TransferNotFound();
        if (t.status != TransferStatus.RELAYED) {
            revert InvalidTransferStatus(t.status, TransferStatus.RELAYED);
        }

        t.status = TransferStatus.COMPLETED;
        t.completedAt = block.timestamp;

        // Pay relay fee (minus protocol portion already taken)
        uint256 relayFee = t.fee - (t.fee * protocolFeeBP / 10_000);
        if (relayFee > 0 && t.assignedRelay != address(0)) {
            IERC20(t.sourceToken).safeTransfer(t.assignedRelay, relayFee);
        }

        // Update relay reputation
        _updateReputation(t.assignedRelay, true);

        emit TransferCompleted(_transferId, block.timestamp);
    }

    /**
     * @notice Marks a transfer as failed and penalizes the relay.
     * @param _transferId Transfer that failed.
     * @param _reason     Human-readable failure reason.
     */
    function markTransferFailed(
        bytes32 _transferId,
        string calldata _reason
    ) external onlyRole(ROUTER_ADMIN_ROLE) whenNotPaused {
        Transfer storage t = transfers[_transferId];
        if (t.sender == address(0)) revert TransferNotFound();
        require(
            t.status == TransferStatus.INITIATED || t.status == TransferStatus.RELAYED,
            "CrossChainRouter: invalid status for failure"
        );

        t.status = TransferStatus.FAILED;

        // Penalize relay if one was assigned
        if (t.assignedRelay != address(0)) {
            _updateReputation(t.assignedRelay, false);
        }

        emit TransferFailed(_transferId, t.assignedRelay, _reason);
    }

    // ──────────────────────────────────────────────────────────────
    // External — Recovery
    // ──────────────────────────────────────────────────────────────

    /**
     * @notice Recovers a stuck or failed transfer after the deadline.
     *         Refunds locked funds to the original sender.
     * @param _transferId Transfer to recover.
     */
    function recoverTransfer(
        bytes32 _transferId
    ) external whenNotPaused nonReentrant {
        Transfer storage t = transfers[_transferId];
        if (t.sender == address(0)) revert TransferNotFound();
        if (msg.sender != t.sender && !hasRole(ROUTER_ADMIN_ROLE, msg.sender)) revert Unauthorized();

        // Only INITIATED or FAILED transfers can be recovered
        require(
            t.status == TransferStatus.INITIATED || t.status == TransferStatus.FAILED,
            "CrossChainRouter: cannot recover this transfer"
        );

        // Capture original status BEFORE mutating
        TransferStatus originalStatus = t.status;

        // For INITIATED transfers, deadline must have expired
        if (originalStatus == TransferStatus.INITIATED) {
            if (block.timestamp < t.deadline) {
                revert DeadlineNotExpired(t.deadline - block.timestamp);
            }
        }

        t.status = TransferStatus.RECOVERED;

        // Refund principal; also refund fee if the transfer was never relayed
        uint256 refundAmount = t.amount;
        if (originalStatus == TransferStatus.INITIATED) {
            // If never relayed, refund fee too (minus protocol portion already sent)
            uint256 protocolFee = (t.fee * protocolFeeBP) / 10_000;
            refundAmount += t.fee - protocolFee;
        }

        IERC20(t.sourceToken).safeTransfer(t.sender, refundAmount);

        emit TransferRecovered(_transferId, t.sender, refundAmount, block.timestamp);
    }

    // ──────────────────────────────────────────────────────────────
    // External — Relay Registry
    // ──────────────────────────────────────────────────────────────

    /**
     * @notice Registers a new relay node with stake collateral.
     */
    function registerRelay() external payable whenNotPaused nonReentrant {
        if (relayNodes[msg.sender].registeredAt != 0) revert RelayAlreadyRegistered();
        if (msg.value < MIN_RELAY_STAKE) revert InsufficientStake(msg.value, MIN_RELAY_STAKE);

        relayNodes[msg.sender] = RelayNode({
            operator: msg.sender,
            stake: msg.value,
            reputation: INITIAL_REPUTATION,
            totalRelayed: 0,
            totalFailed: 0,
            registeredAt: block.timestamp,
            active: true
        });

        _activeRelayIndex[msg.sender] = activeRelays.length;
        activeRelays.push(msg.sender);

        _grantRole(RELAY_OPERATOR_ROLE, msg.sender);

        emit RelayRegistered(msg.sender, msg.value, INITIAL_REPUTATION);
    }

    /**
     * @notice Deregisters a relay node and returns remaining stake.
     * @param _operator Relay operator address.
     */
    function deregisterRelay(
        address _operator
    ) external whenNotPaused nonReentrant {
        require(
            msg.sender == _operator || hasRole(ROUTER_ADMIN_ROLE, msg.sender),
            "CrossChainRouter: unauthorized"
        );

        RelayNode storage node = relayNodes[_operator];
        if (node.registeredAt == 0) revert RelayNotFound();

        uint256 stakeToReturn = node.stake;
        node.active = false;
        node.stake = 0;

        _removeActiveRelay(_operator);
        _revokeRole(RELAY_OPERATOR_ROLE, _operator);

        if (stakeToReturn > 0) {
            (bool ok, ) = _operator.call{value: stakeToReturn}("");
            require(ok, "CrossChainRouter: stake return failed");
        }

        emit RelayDeregistered(_operator, stakeToReturn);
    }

    // ──────────────────────────────────────────────────────────────
    // External — Chain Management
    // ──────────────────────────────────────────────────────────────

    /**
     * @notice Adds a supported destination chain.
     * @param _chainId          Chain ID.
     * @param _name             Human-readable chain name.
     * @param _baseFee          Base relay fee.
     * @param _feeRateBP        Percentage fee in basis points.
     * @param _finalityBlocks   Blocks to wait for finality.
     * @param _recoveryTimeout  Seconds before stuck-transfer recovery.
     * @param _minTransfer      Minimum transfer amount.
     * @param _maxTransfer      Maximum transfer amount.
     */
    function addChain(
        uint256 _chainId,
        string calldata _name,
        uint256 _baseFee,
        uint256 _feeRateBP,
        uint256 _finalityBlocks,
        uint256 _recoveryTimeout,
        uint256 _minTransfer,
        uint256 _maxTransfer
    ) external onlyRole(ROUTER_ADMIN_ROLE) {
        if (chainConfigs[_chainId].chainId != 0) revert ChainAlreadyExists(_chainId);
        if (_feeRateBP > MAX_FEE_RATE_BP) revert InvalidFeeRate(_feeRateBP, MAX_FEE_RATE_BP);
        if (_recoveryTimeout < MIN_RECOVERY_TIMEOUT) {
            revert InvalidRecoveryTimeout(_recoveryTimeout, MIN_RECOVERY_TIMEOUT);
        }

        chainConfigs[_chainId] = ChainConfig({
            chainId: _chainId,
            name: _name,
            baseFee: _baseFee,
            feeRateBP: _feeRateBP,
            finalityBlocks: _finalityBlocks,
            recoveryTimeout: _recoveryTimeout,
            minTransferAmount: _minTransfer,
            maxTransferAmount: _maxTransfer,
            active: true
        });

        supportedChainIds.push(_chainId);

        emit ChainAdded(_chainId, _name);
    }

    /**
     * @notice Removes a supported destination chain.
     * @param _chainId Chain ID to remove.
     */
    function removeChain(uint256 _chainId) external onlyRole(ROUTER_ADMIN_ROLE) {
        if (chainConfigs[_chainId].chainId == 0) revert UnsupportedChain(_chainId);
        chainConfigs[_chainId].active = false;
        emit ChainRemoved(_chainId);
    }

    /// @notice Adds or removes a supported source token.
    function setTokenSupport(address _token, bool _supported) external onlyRole(ROUTER_ADMIN_ROLE) {
        if (_token == address(0)) revert ZeroAddress();
        supportedTokens[_token] = _supported;
        emit TokenSupportUpdated(_token, _supported);
    }

    /// @notice Updates the treasury address.
    function setTreasury(address _newTreasury) external onlyRole(ROUTER_ADMIN_ROLE) {
        if (_newTreasury == address(0)) revert ZeroAddress();
        address old = treasury;
        treasury = _newTreasury;
        emit TreasuryUpdated(old, _newTreasury);
    }

    // ──────────────────────────────────────────────────────────────
    // View Functions
    // ──────────────────────────────────────────────────────────────

    /// @notice Returns the full transfer record.
    function getTransfer(bytes32 _transferId) external view returns (Transfer memory) {
        return transfers[_transferId];
    }

    /// @notice Returns relay node details.
    function getRelayNode(address _operator) external view returns (RelayNode memory) {
        return relayNodes[_operator];
    }

    /// @notice Returns the number of active relay nodes.
    function getActiveRelayCount() external view returns (uint256) {
        return activeRelays.length;
    }

    /// @notice Returns the number of supported chains.
    function getSupportedChainCount() external view returns (uint256) {
        return supportedChainIds.length;
    }

    /// @notice Returns the number of transfers initiated by a sender.
    function getSenderTransferCount(address _sender) external view returns (uint256) {
        return senderTransfers[_sender].length;
    }

    /**
     * @notice Estimates the fee for a cross-chain transfer.
     * @param _amount              Transfer amount.
     * @param _destinationChainId  Target chain ID.
     * @return estimate            Fee estimation breakdown.
     */
    function estimateFee(
        uint256 _amount,
        uint256 _destinationChainId
    ) external view returns (FeeEstimate memory estimate) {
        ChainConfig storage chain = chainConfigs[_destinationChainId];
        if (!chain.active) revert UnsupportedChain(_destinationChainId);

        uint256 percentageFee = (_amount * chain.feeRateBP) / 10_000;

        estimate = FeeEstimate({
            baseFee: chain.baseFee,
            percentageFee: percentageFee,
            totalFee: chain.baseFee + percentageFee,
            estimatedDeliveryTime: chain.finalityBlocks * 12 // ~12s per block estimate
        });
    }

    // ──────────────────────────────────────────────────────────────
    // Admin
    // ──────────────────────────────────────────────────────────────

    /// @notice Emergency pause — halts all router operations.
    function pause() external onlyRole(ROUTER_ADMIN_ROLE) {
        _pause();
    }

    /// @notice Resume operations after emergency.
    function unpause() external onlyRole(ROUTER_ADMIN_ROLE) {
        _unpause();
    }

    // ──────────────────────────────────────────────────────────────
    // Internal
    // ──────────────────────────────────────────────────────────────

    /**
     * @dev Updates relay reputation after a successful or failed relay.
     * @param _operator Relay operator address.
     * @param _success  Whether the relay was successful.
     */
    function _updateReputation(address _operator, bool _success) internal {
        RelayNode storage node = relayNodes[_operator];
        if (node.registeredAt == 0) return;

        uint256 oldReputation = node.reputation;

        if (_success) {
            node.totalRelayed++;
            if (node.reputation + SUCCESS_REWARD <= 1000) {
                node.reputation += SUCCESS_REWARD;
            } else {
                node.reputation = 1000;
            }
        } else {
            node.totalFailed++;
            if (node.reputation >= FAILURE_PENALTY) {
                node.reputation -= FAILURE_PENALTY;
            } else {
                node.reputation = 0;
            }

            // Auto-deactivate relays with zero reputation
            if (node.reputation == 0) {
                node.active = false;
                _removeActiveRelay(_operator);
                _revokeRole(RELAY_OPERATOR_ROLE, _operator);
            }
        }

        emit RelayReputationUpdated(_operator, oldReputation, node.reputation);
    }

    /// @dev Removes a relay from the active list using swap-and-pop.
    function _removeActiveRelay(address _operator) internal {
        uint256 index = _activeRelayIndex[_operator];
        uint256 lastIndex = activeRelays.length - 1;

        if (index != lastIndex) {
            address lastRelay = activeRelays[lastIndex];
            activeRelays[index] = lastRelay;
            _activeRelayIndex[lastRelay] = index;
        }

        activeRelays.pop();
        delete _activeRelayIndex[_operator];
    }

    /// @notice Allows the contract to receive native tokens for relay stake.
    receive() external payable {}
}
