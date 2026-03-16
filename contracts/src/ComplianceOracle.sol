// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

/**
 * @title ComplianceOracle
 * @author Aethelred Team
 * @notice TEE-backed compliance oracle for the NoblePay cross-border payment system.
 *         Manages TEE node registration, attestation verification, sanctions list
 *         tracking, and risk threshold configuration.
 *
 * @dev TEE nodes run compliance screening inside Intel SGX / AWS Nitro enclaves.
 *      This contract verifies their attestations on-chain and stores only hashed
 *      compliance decisions — no PII is ever written to the blockchain.
 *
 * ┌───────────────────────────────────────────────────────────────────┐
 * │                     COMPLIANCE ORACLE                            │
 * ├───────────────────────────────────────────────────────────────────┤
 * │  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐    │
 * │  │  TEE Registry   │  │  Attestation   │  │  Risk Config   │    │
 * │  │  ────────────── │  │  ──────────── │  │  ──────────── │    │
 * │  │  • register     │  │  • verify     │  │  • thresholds  │    │
 * │  │  • deregister   │  │  • validate   │  │  • multi-sig   │    │
 * │  │  • heartbeat    │  │  • revoke     │  │  • update      │    │
 * │  │  • slashing     │  │  • history    │  │  • sanctions   │    │
 * │  └────────────────┘  └────────────────┘  └────────────────┘    │
 * └───────────────────────────────────────────────────────────────────┘
 *
 * Sanctions list sources:
 *   - OFAC (US Office of Foreign Assets Control)
 *   - UAE Central Bank sanctions list
 *   - United Nations Security Council consolidated list
 *   - European Union sanctions list
 */
contract ComplianceOracle is AccessControl, Pausable, ReentrancyGuard {

    // ──────────────────────────────────────────────────────────────
    // Roles
    // ──────────────────────────────────────────────────────────────

    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant TEE_MANAGER_ROLE = keccak256("TEE_MANAGER_ROLE");
    bytes32 public constant THRESHOLD_MANAGER_ROLE = keccak256("THRESHOLD_MANAGER_ROLE");

    // ──────────────────────────────────────────────────────────────
    // Enums
    // ──────────────────────────────────────────────────────────────

    /// @notice Health status of a TEE node.
    enum TEENodeStatus {
        INACTIVE,
        ACTIVE,
        SUSPENDED,
        SLASHED
    }

    /// @notice Sanctions list source identifiers.
    enum SanctionsSource {
        OFAC,
        UAE_CB,
        UN,
        EU
    }

    // ──────────────────────────────────────────────────────────────
    // Structs
    // ──────────────────────────────────────────────────────────────

    /// @notice On-chain record for a registered TEE node.
    struct TEENode {
        address operator;
        bytes enclavePublicKey;       // Public key of the TEE enclave
        bytes32 platformId;           // SGX MRSIGNER / Nitro PCR0
        TEENodeStatus status;
        uint256 stake;                // Staked collateral for slashing
        uint256 registeredAt;
        uint256 lastHeartbeat;
        uint256 totalScreenings;
        uint256 slashCount;
    }

    /// @notice Risk threshold configuration.
    struct RiskThresholds {
        uint8 lowMax;                 // Scores 0..lowMax are low risk
        uint8 mediumMax;              // Scores lowMax+1..mediumMax are medium risk
        // Scores mediumMax+1..100 are high risk
        uint256 lastUpdated;
        address updatedBy;
    }

    /// @notice Sanctions list metadata.
    struct SanctionsList {
        SanctionsSource source;
        bytes32 listHash;             // Merkle root of the sanctions list
        uint256 version;
        uint256 updatedAt;
        address updatedBy;
    }

    /// @notice Screening result stored on-chain (hash-only, no PII).
    struct ScreeningResult {
        bytes32 subjectHash;          // keccak256 of the screened subject identifier
        bytes32 resultHash;           // keccak256 of full screening report
        address teeNode;              // TEE node that performed the screening
        uint8 riskScore;
        bool sanctionsClear;
        uint256 timestamp;
    }

    // ──────────────────────────────────────────────────────────────
    // Configuration constants
    // ──────────────────────────────────────────────────────────────

    /// @notice Minimum stake required to register as a TEE node.
    uint256 public constant MIN_STAKE = 10 ether;

    /// @notice Maximum time between heartbeats before a node is considered offline.
    uint256 public constant HEARTBEAT_INTERVAL = 5 minutes;

    /// @notice Slash penalty for missing heartbeat (percentage of stake in bp).
    uint256 public constant HEARTBEAT_SLASH_BP = 500; // 5%

    /// @notice Maximum slashes before automatic deregistration.
    uint256 public constant MAX_SLASH_COUNT = 3;

    /// @notice Number of approvals required for threshold changes.
    uint256 public constant THRESHOLD_CHANGE_APPROVALS = 2;

    // ──────────────────────────────────────────────────────────────
    // State
    // ──────────────────────────────────────────────────────────────

    /// @notice Current risk thresholds.
    RiskThresholds public riskThresholds;

    /// @notice TEE nodes keyed by operator address.
    mapping(address => TEENode) public teeNodes;

    /// @notice Active TEE node addresses.
    address[] public activeTEENodes;

    /// @notice Index tracking for active TEE node array.
    mapping(address => uint256) internal _activeTEENodeIndex;

    /// @notice Sanctions lists keyed by source.
    mapping(SanctionsSource => SanctionsList) public sanctionsLists;

    /// @notice Screening results keyed by result hash.
    mapping(bytes32 => ScreeningResult) public screeningResults;

    /// @notice Verified attestation hashes (attestation hash => verified flag).
    mapping(bytes32 => bool) public verifiedAttestations;

    /// @notice Pending threshold change proposals.
    mapping(bytes32 => uint256) public thresholdChangeApprovals;

    /// @notice Per-address approval tracking for threshold changes.
    mapping(bytes32 => mapping(address => bool)) public thresholdChangeVotes;

    /// @notice Proposed threshold values keyed by proposal ID.
    struct ProposedThresholds {
        uint8 lowMax;
        uint8 mediumMax;
        bool exists;
    }
    mapping(bytes32 => ProposedThresholds) public proposedThresholds;

    // ──────────────────────────────────────────────────────────────
    // Events
    // ──────────────────────────────────────────────────────────────

    event TEENodeRegistered(address indexed operator, bytes32 platformId, uint256 stake);
    event TEENodeDeregistered(address indexed operator, uint256 stakeReturned);
    event TEENodeSuspended(address indexed operator, string reason);
    event TEENodeSlashed(address indexed operator, uint256 slashAmount, uint256 slashCount);
    event TEENodeHeartbeat(address indexed operator, uint256 timestamp);
    event SanctionsListUpdated(SanctionsSource indexed source, bytes32 listHash, uint256 version);
    event AttestationVerified(bytes32 indexed attestationHash, address indexed teeNode);
    event RiskThresholdUpdated(uint8 lowMax, uint8 mediumMax, address updatedBy);
    event ScreeningResultSubmitted(bytes32 indexed resultId, address indexed teeNode, uint8 riskScore);
    event ThresholdChangeProposed(bytes32 indexed proposalId, uint8 lowMax, uint8 mediumMax);
    event ThresholdChangeApproved(bytes32 indexed proposalId, address indexed approver);

    // ──────────────────────────────────────────────────────────────
    // Errors
    // ──────────────────────────────────────────────────────────────

    error InsufficientStake(uint256 provided, uint256 required);
    error NodeAlreadyRegistered();
    error NodeNotFound();
    error NodeNotActive();
    error InvalidThresholds();
    error InvalidRiskScore();
    error AlreadyVoted();
    error ZeroAddress();
    error InvalidAttestation();
    error ThresholdValuesMismatch();

    // ──────────────────────────────────────────────────────────────
    // Constructor
    // ──────────────────────────────────────────────────────────────

    /**
     * @notice Deploys the ComplianceOracle with default risk thresholds.
     * @param _admin Admin address.
     */
    constructor(address _admin) {
        if (_admin == address(0)) revert ZeroAddress();

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(ADMIN_ROLE, _admin);
        _grantRole(TEE_MANAGER_ROLE, _admin);
        _grantRole(THRESHOLD_MANAGER_ROLE, _admin);

        // Default thresholds: low < 30, medium 30-70, high > 70
        riskThresholds = RiskThresholds({
            lowMax: 29,
            mediumMax: 70,
            lastUpdated: block.timestamp,
            updatedBy: _admin
        });
    }

    // ──────────────────────────────────────────────────────────────
    // TEE Node Management
    // ──────────────────────────────────────────────────────────────

    /**
     * @notice Registers a new TEE node with stake collateral.
     * @param _enclavePublicKey Public key of the TEE enclave.
     * @param _platformId       Platform measurement (SGX MRSIGNER or Nitro PCR0).
     */
    function registerTEENode(
        bytes calldata _enclavePublicKey,
        bytes32 _platformId
    ) external payable whenNotPaused nonReentrant {
        if (teeNodes[msg.sender].registeredAt != 0) revert NodeAlreadyRegistered();
        if (msg.value < MIN_STAKE) revert InsufficientStake(msg.value, MIN_STAKE);

        teeNodes[msg.sender] = TEENode({
            operator: msg.sender,
            enclavePublicKey: _enclavePublicKey,
            platformId: _platformId,
            status: TEENodeStatus.ACTIVE,
            stake: msg.value,
            registeredAt: block.timestamp,
            lastHeartbeat: block.timestamp,
            totalScreenings: 0,
            slashCount: 0
        });

        _activeTEENodeIndex[msg.sender] = activeTEENodes.length;
        activeTEENodes.push(msg.sender);

        emit TEENodeRegistered(msg.sender, _platformId, msg.value);
    }

    /**
     * @notice Deregisters a TEE node and returns remaining stake.
     * @param _operator Address of the TEE node operator.
     */
    function deregisterTEENode(address _operator) external whenNotPaused nonReentrant {
        require(
            msg.sender == _operator || hasRole(TEE_MANAGER_ROLE, msg.sender),
            "ComplianceOracle: unauthorized"
        );

        TEENode storage node = teeNodes[_operator];
        if (node.registeredAt == 0) revert NodeNotFound();

        uint256 stakeToReturn = node.stake;
        node.status = TEENodeStatus.INACTIVE;
        node.stake = 0;

        _removeActiveNode(_operator);

        if (stakeToReturn > 0) {
            (bool ok, ) = _operator.call{value: stakeToReturn}("");
            require(ok, "ComplianceOracle: stake return failed");
        }

        emit TEENodeDeregistered(_operator, stakeToReturn);
    }

    /**
     * @notice TEE node sends a heartbeat to prove liveness.
     * @dev Must be called at least once per HEARTBEAT_INTERVAL.
     */
    function heartbeat() external whenNotPaused {
        TEENode storage node = teeNodes[msg.sender];
        if (node.registeredAt == 0) revert NodeNotFound();
        if (node.status != TEENodeStatus.ACTIVE) revert NodeNotActive();

        node.lastHeartbeat = block.timestamp;

        emit TEENodeHeartbeat(msg.sender, block.timestamp);
    }

    /**
     * @notice Slashes an offline TEE node that missed its heartbeat.
     * @param _operator Address of the TEE node to slash.
     */
    function slashOfflineNode(address _operator) external onlyRole(TEE_MANAGER_ROLE) nonReentrant {
        TEENode storage node = teeNodes[_operator];
        if (node.registeredAt == 0) revert NodeNotFound();
        if (node.status != TEENodeStatus.ACTIVE) revert NodeNotActive();

        require(
            block.timestamp > node.lastHeartbeat + HEARTBEAT_INTERVAL,
            "ComplianceOracle: node not offline"
        );

        uint256 slashAmount = (node.stake * HEARTBEAT_SLASH_BP) / 10_000;
        node.stake -= slashAmount;
        node.slashCount++;

        emit TEENodeSlashed(_operator, slashAmount, node.slashCount);

        // Auto-deregister after max slashes
        if (node.slashCount >= MAX_SLASH_COUNT) {
            node.status = TEENodeStatus.SLASHED;
            _removeActiveNode(_operator);

            uint256 remaining = node.stake;
            node.stake = 0;
            if (remaining > 0) {
                (bool ok, ) = _operator.call{value: remaining}("");
                require(ok, "ComplianceOracle: stake return failed");
            }
        }
    }

    // ──────────────────────────────────────────────────────────────
    // Attestation Verification
    // ──────────────────────────────────────────────────────────────

    /**
     * @notice Verifies a TEE attestation and records it on-chain.
     * @param _teeNode         Address of the TEE node.
     * @param _attestationData Raw attestation data from the enclave.
     * @param _expectedHash    Expected hash of the attestation content.
     * @return attestationHash Hash of the verified attestation.
     */
    function verifyAttestation(
        address _teeNode,
        bytes calldata _attestationData,
        bytes32 _expectedHash
    ) external onlyRole(TEE_MANAGER_ROLE) whenNotPaused returns (bytes32 attestationHash) {
        TEENode storage node = teeNodes[_teeNode];
        if (node.registeredAt == 0) revert NodeNotFound();
        if (node.status != TEENodeStatus.ACTIVE) revert NodeNotActive();

        // Compute attestation hash and verify integrity
        attestationHash = keccak256(abi.encodePacked(_teeNode, _attestationData, block.timestamp));

        // Verify the attestation content matches the expected hash
        bytes32 contentHash = keccak256(_attestationData);
        if (contentHash != _expectedHash) revert InvalidAttestation();

        verifiedAttestations[attestationHash] = true;

        emit AttestationVerified(attestationHash, _teeNode);
    }

    // ──────────────────────────────────────────────────────────────
    // Sanctions List Management
    // ──────────────────────────────────────────────────────────────

    /**
     * @notice Updates a sanctions list with a new Merkle root hash.
     * @param _source  Sanctions list source (OFAC, UAE_CB, UN, EU).
     * @param _listHash Merkle root of the updated sanctions list.
     */
    function updateSanctionsList(
        SanctionsSource _source,
        bytes32 _listHash
    ) external onlyRole(ADMIN_ROLE) whenNotPaused {
        SanctionsList storage list = sanctionsLists[_source];
        list.source = _source;
        list.listHash = _listHash;
        list.version++;
        list.updatedAt = block.timestamp;
        list.updatedBy = msg.sender;

        emit SanctionsListUpdated(_source, _listHash, list.version);
    }

    // ──────────────────────────────────────────────────────────────
    // Risk Threshold Management (Multi-sig)
    // ──────────────────────────────────────────────────────────────

    /**
     * @notice Proposes a risk threshold update. Requires multi-sig approval.
     * @param _lowMax    New upper bound for low risk (exclusive).
     * @param _mediumMax New upper bound for medium risk (inclusive).
     * @return proposalId Unique identifier for the proposal.
     */
    function proposeThresholdUpdate(
        uint8 _lowMax,
        uint8 _mediumMax
    ) external onlyRole(THRESHOLD_MANAGER_ROLE) returns (bytes32 proposalId) {
        if (_lowMax >= _mediumMax || _mediumMax > 100) revert InvalidThresholds();

        proposalId = keccak256(abi.encodePacked(_lowMax, _mediumMax, block.timestamp));

        thresholdChangeApprovals[proposalId] = 1;
        thresholdChangeVotes[proposalId][msg.sender] = true;

        // Store proposed values so approvers must match them exactly
        proposedThresholds[proposalId] = ProposedThresholds({
            lowMax: _lowMax,
            mediumMax: _mediumMax,
            exists: true
        });

        emit ThresholdChangeProposed(proposalId, _lowMax, _mediumMax);

        // If single approval is enough (edge case where THRESHOLD_CHANGE_APPROVALS == 1)
        if (THRESHOLD_CHANGE_APPROVALS <= 1) {
            _applyThresholds(proposalId);
        }
    }

    /**
     * @notice Approves a pending threshold change proposal.
     * @param _proposalId Proposal to approve.
     * @param _lowMax     Expected low-risk upper bound (for verification).
     * @param _mediumMax  Expected medium-risk upper bound (for verification).
     */
    function approveThresholdUpdate(
        bytes32 _proposalId,
        uint8 _lowMax,
        uint8 _mediumMax
    ) external onlyRole(THRESHOLD_MANAGER_ROLE) {
        if (thresholdChangeVotes[_proposalId][msg.sender]) revert AlreadyVoted();

        require(
            thresholdChangeApprovals[_proposalId] > 0,
            "ComplianceOracle: proposal not found"
        );

        // Verify caller-supplied values match the originally proposed values
        ProposedThresholds storage proposed = proposedThresholds[_proposalId];
        if (_lowMax != proposed.lowMax || _mediumMax != proposed.mediumMax) {
            revert ThresholdValuesMismatch();
        }

        thresholdChangeVotes[_proposalId][msg.sender] = true;
        thresholdChangeApprovals[_proposalId]++;

        emit ThresholdChangeApproved(_proposalId, msg.sender);

        if (thresholdChangeApprovals[_proposalId] >= THRESHOLD_CHANGE_APPROVALS) {
            _applyThresholds(_proposalId);
        }
    }

    // ──────────────────────────────────────────────────────────────
    // Screening Result Submission
    // ──────────────────────────────────────────────────────────────

    /**
     * @notice Submits a compliance screening result from a TEE node.
     * @param _subjectHash  Hash of the screened subject (no PII on-chain).
     * @param _resultHash   Hash of the full screening report.
     * @param _riskScore    Computed AML risk score (0-100).
     * @param _sanctionsClear Whether the subject clears all sanctions lists.
     * @return resultId     Unique identifier for the screening result.
     */
    function submitScreeningResult(
        bytes32 _subjectHash,
        bytes32 _resultHash,
        uint8 _riskScore,
        bool _sanctionsClear
    ) external whenNotPaused returns (bytes32 resultId) {
        TEENode storage node = teeNodes[msg.sender];
        if (node.registeredAt == 0) revert NodeNotFound();
        if (node.status != TEENodeStatus.ACTIVE) revert NodeNotActive();
        if (_riskScore > 100) revert InvalidRiskScore();

        resultId = keccak256(abi.encodePacked(msg.sender, _subjectHash, block.timestamp));

        screeningResults[resultId] = ScreeningResult({
            subjectHash: _subjectHash,
            resultHash: _resultHash,
            teeNode: msg.sender,
            riskScore: _riskScore,
            sanctionsClear: _sanctionsClear,
            timestamp: block.timestamp
        });

        node.totalScreenings++;

        emit ScreeningResultSubmitted(resultId, msg.sender, _riskScore);
    }

    // ──────────────────────────────────────────────────────────────
    // View Functions
    // ──────────────────────────────────────────────────────────────

    /// @notice Returns the current risk thresholds.
    function getRiskThresholds() external view returns (uint8 lowMax, uint8 mediumMax) {
        return (riskThresholds.lowMax, riskThresholds.mediumMax);
    }

    /// @notice Returns the number of active TEE nodes.
    function getActiveTEENodeCount() external view returns (uint256) {
        return activeTEENodes.length;
    }

    /// @notice Returns details for a specific TEE node.
    function getTEENode(address _operator) external view returns (TEENode memory) {
        return teeNodes[_operator];
    }

    /// @notice Returns the current version of a sanctions list.
    function getSanctionsListVersion(SanctionsSource _source) external view returns (uint256) {
        return sanctionsLists[_source].version;
    }

    /// @notice Checks whether an attestation has been verified.
    function isAttestationVerified(bytes32 _attestationHash) external view returns (bool) {
        return verifiedAttestations[_attestationHash];
    }

    /// @notice Classifies a risk score into low/medium/high.
    function classifyRisk(uint8 _score) external view returns (string memory) {
        if (_score <= riskThresholds.lowMax) return "LOW";
        if (_score <= riskThresholds.mediumMax) return "MEDIUM";
        return "HIGH";
    }

    // ──────────────────────────────────────────────────────────────
    // Admin
    // ──────────────────────────────────────────────────────────────

    /// @notice Emergency pause.
    function pause() external onlyRole(ADMIN_ROLE) {
        _pause();
    }

    /// @notice Resume operations.
    function unpause() external onlyRole(ADMIN_ROLE) {
        _unpause();
    }

    // ──────────────────────────────────────────────────────────────
    // Internal
    // ──────────────────────────────────────────────────────────────

    /// @dev Applies new risk thresholds after multi-sig approval using stored proposal values.
    function _applyThresholds(bytes32 _proposalId) internal {
        ProposedThresholds storage proposed = proposedThresholds[_proposalId];
        uint8 lowMax = proposed.lowMax;
        uint8 mediumMax = proposed.mediumMax;

        riskThresholds = RiskThresholds({
            lowMax: lowMax,
            mediumMax: mediumMax,
            lastUpdated: block.timestamp,
            updatedBy: msg.sender
        });

        emit RiskThresholdUpdated(lowMax, mediumMax, msg.sender);
    }

    /// @dev Removes a TEE node from the active list using swap-and-pop.
    function _removeActiveNode(address _operator) internal {
        uint256 index = _activeTEENodeIndex[_operator];
        uint256 lastIndex = activeTEENodes.length - 1;

        if (index != lastIndex) {
            address lastNode = activeTEENodes[lastIndex];
            activeTEENodes[index] = lastNode;
            _activeTEENodeIndex[lastNode] = index;
        }

        activeTEENodes.pop();
        delete _activeTEENodeIndex[_operator];
    }

    /// @notice Allows the contract to receive native tokens for stake deposits.
    receive() external payable {}
}
