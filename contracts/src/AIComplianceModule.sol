// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

/**
 * @title AIComplianceModule
 * @author Aethelred Team
 * @notice On-chain AI compliance decision recording and appeals module for the
 *         NoblePay cross-border payment platform. Records AI-driven compliance
 *         decisions with confidence scores, supports human appeals and overrides,
 *         maintains a model registry, and provides a full audit trail.
 *
 * @dev Architecture overview:
 *
 * ┌───────────────────────────────────────────────────────────────────┐
 * │                    AI COMPLIANCE MODULE                            │
 * ├───────────────────────────────────────────────────────────────────┤
 * │  ┌─────────────────┐  ┌──────────────────┐  ┌────────────────┐  │
 * │  │  Decision Rec.   │  │  Appeal Engine   │  │  Model Registry │  │
 * │  │  ──────────────  │  │  ──────────────── │  │  ────────────  │  │
 * │  │  • record        │  │  • file appeal   │  │  • register     │  │
 * │  │  • confidence    │  │  • review        │  │  • deactivate   │  │
 * │  │  • auto-escalate │  │  • approve/deny  │  │  • version      │  │
 * │  └─────────────────┘  └──────────────────┘  └────────────────┘  │
 * │  ┌─────────────────┐  ┌──────────────────┐                      │
 * │  │  Human Override  │  │  Audit Trail     │                      │
 * │  │  ──────────────  │  │  ──────────────── │                      │
 * │  │  • officer ovrd  │  │  • decision log  │                      │
 * │  │  • reason hash   │  │  • appeal log    │                      │
 * │  │  • full audit    │  │  • override log  │                      │
 * │  └─────────────────┘  └──────────────────┘                      │
 * └───────────────────────────────────────────────────────────────────┘
 *
 * Trust model:
 *   - AI operators submit model decisions with confidence scores.
 *   - Low-confidence decisions are auto-escalated to compliance officers.
 *   - Compliance officers can override any AI decision with a reason hash.
 *   - All decisions, appeals, and overrides are immutably recorded for audit.
 *   - No PII is stored on-chain — only hashed references.
 */
contract AIComplianceModule is AccessControl, Pausable, ReentrancyGuard {

    // ──────────────────────────────────────────────────────────────
    // Roles
    // ──────────────────────────────────────────────────────────────

    bytes32 public constant AI_OPERATOR_ROLE = keccak256("AI_OPERATOR_ROLE");
    bytes32 public constant COMPLIANCE_OFFICER_ROLE = keccak256("COMPLIANCE_OFFICER_ROLE");

    // ──────────────────────────────────────────────────────────────
    // Enums
    // ──────────────────────────────────────────────────────────────

    /// @notice AI compliance decision outcome.
    enum DecisionOutcome {
        APPROVED,
        FLAGGED,
        REJECTED,
        ESCALATED
    }

    /// @notice Status of an appeal.
    enum AppealStatus {
        PENDING,
        UNDER_REVIEW,
        UPHELD,           // Original decision stands
        OVERTURNED,       // Decision reversed
        DISMISSED         // Appeal invalid / frivolous
    }

    /// @notice Model status in the registry.
    enum ModelStatus {
        ACTIVE,
        DEPRECATED,
        SUSPENDED
    }

    // ──────────────────────────────────────────────────────────────
    // Structs
    // ──────────────────────────────────────────────────────────────

    /// @notice AI compliance decision record.
    struct Decision {
        bytes32 subjectHash;             // Hash of the subject (transaction, entity)
        bytes32 modelId;                 // AI model that produced the decision
        DecisionOutcome outcome;
        uint8 confidenceScore;           // 0-100 scale
        bytes32 evidenceHash;            // Hash of supporting evidence
        bytes32 reasonHash;              // Hash of decision reasoning
        address operator;                // AI operator who submitted
        uint256 timestamp;
        bool overridden;
        bool appealed;
    }

    /// @notice Appeal against an AI decision.
    struct Appeal {
        bytes32 decisionId;
        address appellant;
        bytes32 groundsHash;             // Hash of appeal grounds document
        AppealStatus status;
        address reviewer;                // Compliance officer reviewing
        bytes32 reviewReasonHash;        // Hash of review reasoning
        DecisionOutcome revisedOutcome;  // New outcome if overturned
        uint256 filedAt;
        uint256 resolvedAt;
    }

    /// @notice Human override of an AI decision.
    struct Override {
        bytes32 decisionId;
        address officer;
        DecisionOutcome originalOutcome;
        DecisionOutcome newOutcome;
        bytes32 reasonHash;
        uint256 timestamp;
    }

    /// @notice Registered AI model metadata.
    struct AIModel {
        bytes32 modelId;
        string name;
        string version;
        bytes32 modelHash;               // Hash of the model artifact
        ModelStatus status;
        uint256 totalDecisions;
        uint256 totalAppeals;
        uint256 totalOverrides;
        uint256 registeredAt;
        address registeredBy;
    }

    // ──────────────────────────────────────────────────────────────
    // Constants
    // ──────────────────────────────────────────────────────────────

    /// @notice Confidence threshold below which decisions are auto-escalated.
    uint8 public constant AUTO_ESCALATION_THRESHOLD = 60;

    /// @notice Maximum appeal window: 30 days from decision.
    uint256 public constant APPEAL_WINDOW = 30 days;

    /// @notice Maximum time for appeal review: 14 days.
    uint256 public constant MAX_REVIEW_PERIOD = 14 days;

    // ──────────────────────────────────────────────────────────────
    // State
    // ──────────────────────────────────────────────────────────────

    /// @notice Monotonically increasing decision nonce.
    uint256 public decisionNonce;

    /// @notice Monotonically increasing appeal nonce.
    uint256 public appealNonce;

    /// @notice Monotonically increasing override nonce.
    uint256 public overrideNonce;

    /// @notice Configurable escalation threshold (can be updated by admin).
    uint8 public escalationThreshold;

    /// @notice Decision records keyed by decision ID.
    mapping(bytes32 => Decision) public decisions;

    /// @notice Appeal records keyed by appeal ID.
    mapping(bytes32 => Appeal) public appeals;

    /// @notice Override records keyed by override ID.
    mapping(bytes32 => Override) public overrides;

    /// @notice AI model records keyed by model ID.
    mapping(bytes32 => AIModel) public models;

    /// @notice Decision IDs per subject: subjectHash => decisionId[].
    mapping(bytes32 => bytes32[]) public subjectDecisions;

    /// @notice Appeal IDs per decision: decisionId => appealId[].
    mapping(bytes32 => bytes32[]) public decisionAppeals;

    /// @notice Override IDs per decision: decisionId => overrideId[].
    mapping(bytes32 => bytes32[]) public decisionOverrides;

    /// @notice All registered model IDs.
    bytes32[] public registeredModelIds;

    /// @notice Decisions pending escalation review.
    bytes32[] public escalationQueue;

    /// @notice Total decisions by outcome for analytics.
    mapping(DecisionOutcome => uint256) public outcomeCount;

    // ──────────────────────────────────────────────────────────────
    // Events
    // ──────────────────────────────────────────────────────────────

    event DecisionRecorded(
        bytes32 indexed decisionId,
        bytes32 indexed subjectHash,
        bytes32 indexed modelId,
        DecisionOutcome outcome,
        uint8 confidenceScore,
        address operator
    );
    event DecisionEscalated(
        bytes32 indexed decisionId,
        uint8 confidenceScore,
        uint8 threshold
    );
    event AppealFiled(
        bytes32 indexed appealId,
        bytes32 indexed decisionId,
        address indexed appellant,
        bytes32 groundsHash
    );
    event AppealReviewStarted(
        bytes32 indexed appealId,
        address indexed reviewer
    );
    event AppealResolved(
        bytes32 indexed appealId,
        bytes32 indexed decisionId,
        AppealStatus status,
        DecisionOutcome revisedOutcome
    );
    event DecisionOverridden(
        bytes32 indexed overrideId,
        bytes32 indexed decisionId,
        address indexed officer,
        DecisionOutcome originalOutcome,
        DecisionOutcome newOutcome
    );
    event ModelRegistered(
        bytes32 indexed modelId,
        string name,
        string version,
        address registeredBy
    );
    event ModelStatusUpdated(
        bytes32 indexed modelId,
        ModelStatus oldStatus,
        ModelStatus newStatus
    );
    event EscalationThresholdUpdated(
        uint8 oldThreshold,
        uint8 newThreshold
    );

    // ──────────────────────────────────────────────────────────────
    // Errors
    // ──────────────────────────────────────────────────────────────

    error ZeroAddress();
    error DecisionNotFound();
    error AppealNotFound();
    error ModelNotFound();
    error ModelNotActive();
    error ModelAlreadyExists();
    error InvalidConfidenceScore();
    error InvalidOutcome();
    error AppealWindowExpired(uint256 deadline, uint256 currentTime);
    error AppealAlreadyFiled();
    error AppealNotPending();
    error AppealNotUnderReview();
    error ReviewPeriodExpired(uint256 deadline, uint256 currentTime);
    error DecisionAlreadyOverridden();
    error InvalidThreshold();
    error Unauthorized();
    error SameOutcome();

    // ──────────────────────────────────────────────────────────────
    // Constructor
    // ──────────────────────────────────────────────────────────────

    /**
     * @notice Deploys the AIComplianceModule.
     * @param _admin Admin address with full control.
     */
    constructor(address _admin) {
        if (_admin == address(0)) revert ZeroAddress();

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(AI_OPERATOR_ROLE, _admin);
        _grantRole(COMPLIANCE_OFFICER_ROLE, _admin);

        escalationThreshold = AUTO_ESCALATION_THRESHOLD;
    }

    // ──────────────────────────────────────────────────────────────
    // External — Decision Recording
    // ──────────────────────────────────────────────────────────────

    /**
     * @notice Records an AI compliance decision. Auto-escalates if confidence
     *         is below the configured threshold.
     * @param _subjectHash     Hash of the subject being evaluated.
     * @param _modelId         AI model that produced the decision.
     * @param _outcome         Decision outcome (APPROVED, FLAGGED, REJECTED).
     * @param _confidenceScore Confidence score (0-100).
     * @param _evidenceHash    Hash of supporting evidence.
     * @param _reasonHash      Hash of decision reasoning.
     * @return decisionId      Unique decision identifier.
     */
    function recordDecision(
        bytes32 _subjectHash,
        bytes32 _modelId,
        DecisionOutcome _outcome,
        uint8 _confidenceScore,
        bytes32 _evidenceHash,
        bytes32 _reasonHash
    ) external whenNotPaused onlyRole(AI_OPERATOR_ROLE) returns (bytes32 decisionId) {
        if (_confidenceScore > 100) revert InvalidConfidenceScore();

        AIModel storage model = models[_modelId];
        if (model.registeredAt == 0) revert ModelNotFound();
        if (model.status != ModelStatus.ACTIVE) revert ModelNotActive();

        decisionId = keccak256(
            abi.encodePacked(_subjectHash, _modelId, block.timestamp, decisionNonce++)
        );

        // Auto-escalate low-confidence decisions
        DecisionOutcome finalOutcome = _outcome;
        if (_confidenceScore < escalationThreshold) {
            finalOutcome = DecisionOutcome.ESCALATED;
        }

        decisions[decisionId] = Decision({
            subjectHash: _subjectHash,
            modelId: _modelId,
            outcome: finalOutcome,
            confidenceScore: _confidenceScore,
            evidenceHash: _evidenceHash,
            reasonHash: _reasonHash,
            operator: msg.sender,
            timestamp: block.timestamp,
            overridden: false,
            appealed: false
        });

        subjectDecisions[_subjectHash].push(decisionId);
        model.totalDecisions++;
        outcomeCount[finalOutcome]++;

        emit DecisionRecorded(decisionId, _subjectHash, _modelId, finalOutcome, _confidenceScore, msg.sender);

        if (finalOutcome == DecisionOutcome.ESCALATED) {
            escalationQueue.push(decisionId);
            emit DecisionEscalated(decisionId, _confidenceScore, escalationThreshold);
        }
    }

    // ──────────────────────────────────────────────────────────────
    // External — Appeal Mechanism
    // ──────────────────────────────────────────────────────────────

    /**
     * @notice Files an appeal against an AI compliance decision.
     * @param _decisionId  Decision to appeal.
     * @param _groundsHash Hash of the appeal grounds document.
     * @return appealId    Unique appeal identifier.
     */
    function fileAppeal(
        bytes32 _decisionId,
        bytes32 _groundsHash
    ) external whenNotPaused returns (bytes32 appealId) {
        Decision storage d = decisions[_decisionId];
        if (d.timestamp == 0) revert DecisionNotFound();
        if (d.appealed) revert AppealAlreadyFiled();

        // Check appeal window
        uint256 deadline = d.timestamp + APPEAL_WINDOW;
        if (block.timestamp > deadline) {
            revert AppealWindowExpired(deadline, block.timestamp);
        }

        appealId = keccak256(
            abi.encodePacked(_decisionId, msg.sender, block.timestamp, appealNonce++)
        );

        appeals[appealId] = Appeal({
            decisionId: _decisionId,
            appellant: msg.sender,
            groundsHash: _groundsHash,
            status: AppealStatus.PENDING,
            reviewer: address(0),
            reviewReasonHash: bytes32(0),
            revisedOutcome: DecisionOutcome.APPROVED, // placeholder
            filedAt: block.timestamp,
            resolvedAt: 0
        });

        d.appealed = true;
        decisionAppeals[_decisionId].push(appealId);

        AIModel storage model = models[d.modelId];
        model.totalAppeals++;

        emit AppealFiled(appealId, _decisionId, msg.sender, _groundsHash);
    }

    /**
     * @notice Starts review of a pending appeal. Only compliance officers.
     * @param _appealId Appeal to review.
     */
    function startAppealReview(
        bytes32 _appealId
    ) external whenNotPaused onlyRole(COMPLIANCE_OFFICER_ROLE) {
        Appeal storage a = appeals[_appealId];
        if (a.filedAt == 0) revert AppealNotFound();
        if (a.status != AppealStatus.PENDING) revert AppealNotPending();

        a.status = AppealStatus.UNDER_REVIEW;
        a.reviewer = msg.sender;

        emit AppealReviewStarted(_appealId, msg.sender);
    }

    /**
     * @notice Resolves an appeal under review.
     * @param _appealId        Appeal to resolve.
     * @param _status          Resolution status (UPHELD, OVERTURNED, DISMISSED).
     * @param _revisedOutcome  New outcome if overturned.
     * @param _reviewReasonHash Hash of the review reasoning.
     */
    function resolveAppeal(
        bytes32 _appealId,
        AppealStatus _status,
        DecisionOutcome _revisedOutcome,
        bytes32 _reviewReasonHash
    ) external whenNotPaused onlyRole(COMPLIANCE_OFFICER_ROLE) {
        Appeal storage a = appeals[_appealId];
        if (a.filedAt == 0) revert AppealNotFound();
        if (a.status != AppealStatus.UNDER_REVIEW) revert AppealNotUnderReview();
        require(
            _status == AppealStatus.UPHELD ||
            _status == AppealStatus.OVERTURNED ||
            _status == AppealStatus.DISMISSED,
            "AIComplianceModule: invalid resolution status"
        );

        a.status = _status;
        a.reviewReasonHash = _reviewReasonHash;
        a.resolvedAt = block.timestamp;

        if (_status == AppealStatus.OVERTURNED) {
            a.revisedOutcome = _revisedOutcome;

            // Update the original decision
            Decision storage d = decisions[a.decisionId];
            d.outcome = _revisedOutcome;
            d.overridden = true;
        }

        emit AppealResolved(_appealId, a.decisionId, _status, _revisedOutcome);
    }

    // ──────────────────────────────────────────────────────────────
    // External — Human Override
    // ──────────────────────────────────────────────────────────────

    /**
     * @notice Allows a compliance officer to override any AI decision.
     * @param _decisionId Decision to override.
     * @param _newOutcome New decision outcome.
     * @param _reasonHash Hash of the override reasoning.
     * @return overrideId Unique override identifier.
     */
    function overrideDecision(
        bytes32 _decisionId,
        DecisionOutcome _newOutcome,
        bytes32 _reasonHash
    ) external whenNotPaused onlyRole(COMPLIANCE_OFFICER_ROLE) returns (bytes32 overrideId) {
        Decision storage d = decisions[_decisionId];
        if (d.timestamp == 0) revert DecisionNotFound();
        if (d.overridden) revert DecisionAlreadyOverridden();
        if (d.outcome == _newOutcome) revert SameOutcome();

        overrideId = keccak256(
            abi.encodePacked(_decisionId, msg.sender, block.timestamp, overrideNonce++)
        );

        DecisionOutcome originalOutcome = d.outcome;

        overrides[overrideId] = Override({
            decisionId: _decisionId,
            officer: msg.sender,
            originalOutcome: originalOutcome,
            newOutcome: _newOutcome,
            reasonHash: _reasonHash,
            timestamp: block.timestamp
        });

        d.outcome = _newOutcome;
        d.overridden = true;

        decisionOverrides[_decisionId].push(overrideId);

        AIModel storage model = models[d.modelId];
        model.totalOverrides++;

        // Update outcome counts
        if (outcomeCount[originalOutcome] > 0) {
            outcomeCount[originalOutcome]--;
        }
        outcomeCount[_newOutcome]++;

        emit DecisionOverridden(overrideId, _decisionId, msg.sender, originalOutcome, _newOutcome);
    }

    // ──────────────────────────────────────────────────────────────
    // External — Model Registry
    // ──────────────────────────────────────────────────────────────

    /**
     * @notice Registers a new AI model in the compliance registry.
     * @param _name      Human-readable model name.
     * @param _version   Model version string.
     * @param _modelHash Hash of the model artifact for provenance.
     * @return modelId   Unique model identifier.
     */
    function registerModel(
        string calldata _name,
        string calldata _version,
        bytes32 _modelHash
    ) external onlyRole(AI_OPERATOR_ROLE) returns (bytes32 modelId) {
        modelId = keccak256(abi.encodePacked(_name, _version, _modelHash));
        if (models[modelId].registeredAt != 0) revert ModelAlreadyExists();

        models[modelId] = AIModel({
            modelId: modelId,
            name: _name,
            version: _version,
            modelHash: _modelHash,
            status: ModelStatus.ACTIVE,
            totalDecisions: 0,
            totalAppeals: 0,
            totalOverrides: 0,
            registeredAt: block.timestamp,
            registeredBy: msg.sender
        });

        registeredModelIds.push(modelId);

        emit ModelRegistered(modelId, _name, _version, msg.sender);
    }

    /**
     * @notice Updates the status of a registered AI model.
     * @param _modelId  Model to update.
     * @param _status   New model status.
     */
    function updateModelStatus(
        bytes32 _modelId,
        ModelStatus _status
    ) external onlyRole(AI_OPERATOR_ROLE) {
        AIModel storage model = models[_modelId];
        if (model.registeredAt == 0) revert ModelNotFound();

        ModelStatus oldStatus = model.status;
        model.status = _status;

        emit ModelStatusUpdated(_modelId, oldStatus, _status);
    }

    // ──────────────────────────────────────────────────────────────
    // External — Configuration
    // ──────────────────────────────────────────────────────────────

    /**
     * @notice Updates the auto-escalation confidence threshold.
     * @param _newThreshold New threshold (0-100).
     */
    function setEscalationThreshold(
        uint8 _newThreshold
    ) external onlyRole(COMPLIANCE_OFFICER_ROLE) {
        if (_newThreshold > 100) revert InvalidThreshold();

        uint8 old = escalationThreshold;
        escalationThreshold = _newThreshold;

        emit EscalationThresholdUpdated(old, _newThreshold);
    }

    // ──────────────────────────────────────────────────────────────
    // View Functions
    // ──────────────────────────────────────────────────────────────

    /// @notice Returns the full decision record.
    function getDecision(bytes32 _decisionId) external view returns (Decision memory) {
        return decisions[_decisionId];
    }

    /// @notice Returns the full appeal record.
    function getAppeal(bytes32 _appealId) external view returns (Appeal memory) {
        return appeals[_appealId];
    }

    /// @notice Returns the full override record.
    function getOverride(bytes32 _overrideId) external view returns (Override memory) {
        return overrides[_overrideId];
    }

    /// @notice Returns the full model record.
    function getModel(bytes32 _modelId) external view returns (AIModel memory) {
        return models[_modelId];
    }

    /// @notice Returns the number of decisions for a subject.
    function getSubjectDecisionCount(bytes32 _subjectHash) external view returns (uint256) {
        return subjectDecisions[_subjectHash].length;
    }

    /// @notice Returns the number of appeals for a decision.
    function getDecisionAppealCount(bytes32 _decisionId) external view returns (uint256) {
        return decisionAppeals[_decisionId].length;
    }

    /// @notice Returns the number of overrides for a decision.
    function getDecisionOverrideCount(bytes32 _decisionId) external view returns (uint256) {
        return decisionOverrides[_decisionId].length;
    }

    /// @notice Returns the number of registered models.
    function getRegisteredModelCount() external view returns (uint256) {
        return registeredModelIds.length;
    }

    /// @notice Returns the current escalation queue length.
    function getEscalationQueueLength() external view returns (uint256) {
        return escalationQueue.length;
    }

    /// @notice Returns the decision count for a given outcome type.
    function getOutcomeCount(DecisionOutcome _outcome) external view returns (uint256) {
        return outcomeCount[_outcome];
    }

    /**
     * @notice Returns the full audit trail for a decision: appeals and overrides.
     * @param _decisionId Decision to audit.
     * @return appealIds   Array of appeal IDs.
     * @return overrideIds Array of override IDs.
     */
    function getAuditTrail(
        bytes32 _decisionId
    ) external view returns (bytes32[] memory appealIds, bytes32[] memory overrideIds) {
        return (decisionAppeals[_decisionId], decisionOverrides[_decisionId]);
    }

    // ──────────────────────────────────────────────────────────────
    // Admin
    // ──────────────────────────────────────────────────────────────

    /// @notice Emergency pause — halts all compliance module operations.
    function pause() external onlyRole(COMPLIANCE_OFFICER_ROLE) {
        _pause();
    }

    /// @notice Resume operations after emergency.
    function unpause() external onlyRole(COMPLIANCE_OFFICER_ROLE) {
        _unpause();
    }
}
