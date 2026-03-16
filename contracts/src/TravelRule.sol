// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

/**
 * @title TravelRule
 * @author Aethelred Team
 * @notice FATF Travel Rule compliance contract for the NoblePay cross-border
 *         payment platform. Manages encrypted data sharing between originating
 *         and beneficiary VASPs (Virtual Asset Service Providers) with
 *         threshold-based requirements and 5-year data retention.
 *
 * @dev Privacy architecture:
 *      - No PII is stored in plaintext on-chain. All originator/beneficiary
 *        names are stored as keccak256 hashes of their encrypted form.
 *      - Full travel rule data is encrypted inside TEE enclaves and shared
 *        peer-to-peer between VASPs. Only the hash is recorded on-chain
 *        for auditability.
 *      - Data retention: encrypted records are retained for 5 years per
 *        FATF Recommendation 16. After expiry, on-chain records can be
 *        archived but encrypted off-chain copies must be preserved.
 *
 * ┌───────────────────────────────────────────────────────────────────┐
 * │                      TRAVEL RULE ENGINE                          │
 * ├───────────────────────────────────────────────────────────────────┤
 * │  ┌─────────────────┐  ┌──────────────────┐  ┌────────────────┐ │
 * │  │  Data Submit     │  │  Verification    │  │  VASP Sharing  │ │
 * │  │  ──────────────  │  │  ──────────────  │  │  ──────────── │ │
 * │  │  • TEE-only      │  │  • threshold     │  │  • encrypted   │ │
 * │  │  • hash-only     │  │  • completeness  │  │  • peer-to-peer│ │
 * │  │  • encrypted     │  │  • sanctions     │  │  • audit trail │ │
 * │  └─────────────────┘  └──────────────────┘  └────────────────┘ │
 * └───────────────────────────────────────────────────────────────────┘
 *
 * FATF Recommendation 16 thresholds:
 *   - Transactions >= $1,000 USD equivalent require full travel rule data
 *   - Below threshold: simplified due diligence only
 */
contract TravelRule is AccessControl, Pausable, ReentrancyGuard {

    // ──────────────────────────────────────────────────────────────
    // Roles
    // ──────────────────────────────────────────────────────────────

    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant TEE_NODE_ROLE = keccak256("TEE_NODE_ROLE");
    bytes32 public constant VASP_ROLE = keccak256("VASP_ROLE");

    // ──────────────────────────────────────────────────────────────
    // Enums
    // ──────────────────────────────────────────────────────────────

    /// @notice Status of a travel rule data submission.
    enum TravelRuleStatus {
        PENDING,
        VERIFIED,
        REJECTED,
        SHARED,
        EXPIRED
    }

    // ──────────────────────────────────────────────────────────────
    // Structs
    // ──────────────────────────────────────────────────────────────

    /**
     * @notice Travel rule data record (all PII fields are encrypted hashes).
     * @dev Follows FATF Recommendation 16 / IVMS 101 data model.
     */
    struct TravelRuleData {
        bytes32 originatorNameHash;       // keccak256(encrypted originator name)
        address originatorAddress;        // On-chain originator wallet
        bytes32 originatorInstitution;    // Hash of originating VASP identifier
        bytes32 beneficiaryNameHash;      // keccak256(encrypted beneficiary name)
        address beneficiaryAddress;       // On-chain beneficiary wallet
        bytes32 beneficiaryInstitution;   // Hash of beneficiary VASP identifier
        uint256 amount;                   // Transaction amount
        bytes3 currency;                  // ISO 4217 currency code
        uint256 timestamp;                // Submission timestamp
        TravelRuleStatus status;
        bytes32 paymentId;                // Reference to NoblePay payment
        bytes32 encryptedDataHash;        // Hash of full encrypted data blob
    }

    /// @notice VASP (Virtual Asset Service Provider) registration record.
    struct VASP {
        address wallet;
        bytes32 institutionHash;          // Hash of VASP legal name / LEI
        bytes encryptionPublicKey;        // Public key for encrypted data sharing
        bool active;
        uint256 registeredAt;
    }

    /// @notice Sharing record for inter-VASP data exchange.
    struct SharingRecord {
        bytes32 travelRuleId;
        address originatingVASP;
        address beneficiaryVASP;
        bytes32 sharedDataHash;           // Hash of the shared encrypted payload
        uint256 sharedAt;
        bool acknowledged;
    }

    // ──────────────────────────────────────────────────────────────
    // Constants
    // ──────────────────────────────────────────────────────────────

    /// @notice Travel rule threshold: $1,000 USD (6 decimals).
    uint256 public constant TRAVEL_RULE_THRESHOLD = 1_000 * 1e6;

    /// @notice Data retention period: 5 years (per FATF Rec. 16).
    uint256 public constant DATA_RETENTION_PERIOD = 5 * 365 days;

    /// @notice Maximum time for a VASP to acknowledge shared data.
    uint256 public constant ACKNOWLEDGEMENT_DEADLINE = 48 hours;

    // ──────────────────────────────────────────────────────────────
    // State
    // ──────────────────────────────────────────────────────────────

    /// @notice Travel rule records keyed by travel rule ID.
    mapping(bytes32 => TravelRuleData) public travelRuleRecords;

    /// @notice VASP records keyed by wallet address.
    mapping(address => VASP) public vasps;

    /// @notice Sharing records keyed by sharing ID.
    mapping(bytes32 => SharingRecord) public sharingRecords;

    /// @notice Payment ID to travel rule ID mapping.
    mapping(bytes32 => bytes32) public paymentToTravelRule;

    /// @notice Total travel rule submissions.
    uint256 public totalSubmissions;

    /// @notice Configurable travel rule threshold (can be updated by admin).
    uint256 public travelRuleThreshold;

    // ──────────────────────────────────────────────────────────────
    // Events
    // ──────────────────────────────────────────────────────────────

    event TravelRuleDataSubmitted(
        bytes32 indexed travelRuleId,
        bytes32 indexed paymentId,
        address indexed originatorAddress,
        uint256 amount,
        bytes3 currency
    );

    event TravelRuleVerified(bytes32 indexed travelRuleId, address verifiedBy);
    event TravelRuleRejected(bytes32 indexed travelRuleId, string reason);
    event TravelRuleShared(
        bytes32 indexed travelRuleId,
        bytes32 indexed sharingId,
        address indexed beneficiaryVASP
    );
    event TravelRuleAcknowledged(bytes32 indexed sharingId, address indexed beneficiaryVASP);
    event VASPRegistered(address indexed vasp, bytes32 institutionHash);
    event VASPDeactivated(address indexed vasp);
    event ThresholdUpdated(uint256 oldThreshold, uint256 newThreshold);

    // ──────────────────────────────────────────────────────────────
    // Errors
    // ──────────────────────────────────────────────────────────────

    error ZeroAddress();
    error ZeroAmount();
    error RecordNotFound();
    error VASPNotFound();
    error VASPAlreadyRegistered();
    error VASPNotActive();
    error InvalidStatus(TravelRuleStatus current, TravelRuleStatus expected);
    error BelowThreshold();
    error DataExpired();
    error SharingNotFound();
    error AlreadyAcknowledged();
    error AcknowledgementDeadlinePassed();
    error DuplicateSubmission();

    // ──────────────────────────────────────────────────────────────
    // Constructor
    // ──────────────────────────────────────────────────────────────

    /**
     * @notice Deploys the TravelRule contract.
     * @param _admin Admin address.
     */
    constructor(address _admin) {
        if (_admin == address(0)) revert ZeroAddress();

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(ADMIN_ROLE, _admin);

        travelRuleThreshold = TRAVEL_RULE_THRESHOLD;
    }

    // ──────────────────────────────────────────────────────────────
    // VASP Registration
    // ──────────────────────────────────────────────────────────────

    /**
     * @notice Registers a VASP for travel rule data exchange.
     * @param _institutionHash    Hash of the VASP's legal name or LEI.
     * @param _encryptionPubKey   Public key for encrypted data sharing.
     */
    function registerVASP(
        bytes32 _institutionHash,
        bytes calldata _encryptionPubKey
    ) external whenNotPaused {
        if (vasps[msg.sender].registeredAt != 0) revert VASPAlreadyRegistered();
        require(_encryptionPubKey.length > 0, "TravelRule: empty public key");

        vasps[msg.sender] = VASP({
            wallet: msg.sender,
            institutionHash: _institutionHash,
            encryptionPublicKey: _encryptionPubKey,
            active: true,
            registeredAt: block.timestamp
        });

        _grantRole(VASP_ROLE, msg.sender);

        emit VASPRegistered(msg.sender, _institutionHash);
    }

    /**
     * @notice Deactivates a VASP.
     * @param _vasp Address of the VASP to deactivate.
     */
    function deactivateVASP(address _vasp) external onlyRole(ADMIN_ROLE) {
        VASP storage v = vasps[_vasp];
        if (v.registeredAt == 0) revert VASPNotFound();

        v.active = false;
        _revokeRole(VASP_ROLE, _vasp);

        emit VASPDeactivated(_vasp);
    }

    // ──────────────────────────────────────────────────────────────
    // Travel Rule Data Submission (TEE-only)
    // ──────────────────────────────────────────────────────────────

    /**
     * @notice Submits travel rule data for a payment. Only callable by TEE nodes.
     * @dev All PII fields must be pre-encrypted inside the TEE enclave.
     *      Only hashes are stored on-chain.
     * @param _paymentId              Reference to the NoblePay payment.
     * @param _originatorNameHash     keccak256 of encrypted originator name.
     * @param _originatorAddress      On-chain originator wallet.
     * @param _originatorInstitution  Hash of originating VASP.
     * @param _beneficiaryNameHash    keccak256 of encrypted beneficiary name.
     * @param _beneficiaryAddress     On-chain beneficiary wallet.
     * @param _beneficiaryInstitution Hash of beneficiary VASP.
     * @param _amount                 Transaction amount.
     * @param _currency               ISO 4217 currency code.
     * @param _encryptedDataHash      Hash of full encrypted data blob.
     * @return travelRuleId           Unique identifier for this travel rule record.
     */
    function submitTravelRuleData(
        bytes32 _paymentId,
        bytes32 _originatorNameHash,
        address _originatorAddress,
        bytes32 _originatorInstitution,
        bytes32 _beneficiaryNameHash,
        address _beneficiaryAddress,
        bytes32 _beneficiaryInstitution,
        uint256 _amount,
        bytes3 _currency,
        bytes32 _encryptedDataHash
    ) external onlyRole(TEE_NODE_ROLE) whenNotPaused returns (bytes32 travelRuleId) {
        if (_originatorAddress == address(0)) revert ZeroAddress();
        if (_beneficiaryAddress == address(0)) revert ZeroAddress();
        if (_amount == 0) revert ZeroAmount();
        if (paymentToTravelRule[_paymentId] != bytes32(0)) revert DuplicateSubmission();

        travelRuleId = keccak256(
            abi.encodePacked(_paymentId, _originatorAddress, _beneficiaryAddress, block.timestamp)
        );

        travelRuleRecords[travelRuleId] = TravelRuleData({
            originatorNameHash: _originatorNameHash,
            originatorAddress: _originatorAddress,
            originatorInstitution: _originatorInstitution,
            beneficiaryNameHash: _beneficiaryNameHash,
            beneficiaryAddress: _beneficiaryAddress,
            beneficiaryInstitution: _beneficiaryInstitution,
            amount: _amount,
            currency: _currency,
            timestamp: block.timestamp,
            status: TravelRuleStatus.PENDING,
            paymentId: _paymentId,
            encryptedDataHash: _encryptedDataHash
        });

        paymentToTravelRule[_paymentId] = travelRuleId;
        totalSubmissions++;

        emit TravelRuleDataSubmitted(travelRuleId, _paymentId, _originatorAddress, _amount, _currency);
    }

    // ──────────────────────────────────────────────────────────────
    // Verification
    // ──────────────────────────────────────────────────────────────

    /**
     * @notice Verifies travel rule data completeness and compliance.
     * @dev Called by TEE nodes after validating the encrypted data off-chain.
     * @param _travelRuleId Record to verify.
     */
    function verifyTravelRuleCompliance(
        bytes32 _travelRuleId
    ) external onlyRole(TEE_NODE_ROLE) whenNotPaused {
        TravelRuleData storage record = travelRuleRecords[_travelRuleId];
        if (record.timestamp == 0) revert RecordNotFound();
        if (record.status != TravelRuleStatus.PENDING) {
            revert InvalidStatus(record.status, TravelRuleStatus.PENDING);
        }

        record.status = TravelRuleStatus.VERIFIED;

        emit TravelRuleVerified(_travelRuleId, msg.sender);
    }

    /**
     * @notice Rejects a travel rule submission that fails compliance checks.
     * @param _travelRuleId Record to reject.
     * @param _reason       Human-readable rejection reason.
     */
    function rejectTravelRuleData(
        bytes32 _travelRuleId,
        string calldata _reason
    ) external onlyRole(TEE_NODE_ROLE) whenNotPaused {
        TravelRuleData storage record = travelRuleRecords[_travelRuleId];
        if (record.timestamp == 0) revert RecordNotFound();
        if (record.status != TravelRuleStatus.PENDING) {
            revert InvalidStatus(record.status, TravelRuleStatus.PENDING);
        }

        record.status = TravelRuleStatus.REJECTED;

        emit TravelRuleRejected(_travelRuleId, _reason);
    }

    // ──────────────────────────────────────────────────────────────
    // Inter-VASP Data Sharing
    // ──────────────────────────────────────────────────────────────

    /**
     * @notice Shares verified travel rule data with the beneficiary VASP.
     * @dev The encrypted data is shared off-chain; this records the sharing
     *      event on-chain for auditability.
     * @param _travelRuleId   Record to share.
     * @param _beneficiaryVASP Address of the receiving VASP.
     * @param _sharedDataHash  Hash of the encrypted data payload shared.
     * @return sharingId       Unique sharing record identifier.
     */
    function shareWithReceivingInstitution(
        bytes32 _travelRuleId,
        address _beneficiaryVASP,
        bytes32 _sharedDataHash
    ) external onlyRole(VASP_ROLE) whenNotPaused returns (bytes32 sharingId) {
        TravelRuleData storage record = travelRuleRecords[_travelRuleId];
        if (record.timestamp == 0) revert RecordNotFound();
        if (record.status != TravelRuleStatus.VERIFIED) {
            revert InvalidStatus(record.status, TravelRuleStatus.VERIFIED);
        }

        VASP storage beneficiary = vasps[_beneficiaryVASP];
        if (beneficiary.registeredAt == 0) revert VASPNotFound();
        if (!beneficiary.active) revert VASPNotActive();

        sharingId = keccak256(
            abi.encodePacked(_travelRuleId, msg.sender, _beneficiaryVASP, block.timestamp)
        );

        sharingRecords[sharingId] = SharingRecord({
            travelRuleId: _travelRuleId,
            originatingVASP: msg.sender,
            beneficiaryVASP: _beneficiaryVASP,
            sharedDataHash: _sharedDataHash,
            sharedAt: block.timestamp,
            acknowledged: false
        });

        record.status = TravelRuleStatus.SHARED;

        emit TravelRuleShared(_travelRuleId, sharingId, _beneficiaryVASP);
    }

    /**
     * @notice Beneficiary VASP acknowledges receipt of shared travel rule data.
     * @param _sharingId Sharing record to acknowledge.
     */
    function acknowledgeTravelRuleData(bytes32 _sharingId) external onlyRole(VASP_ROLE) whenNotPaused {
        SharingRecord storage sharing = sharingRecords[_sharingId];
        if (sharing.sharedAt == 0) revert SharingNotFound();
        if (sharing.acknowledged) revert AlreadyAcknowledged();

        require(
            msg.sender == sharing.beneficiaryVASP,
            "TravelRule: not the beneficiary VASP"
        );

        if (block.timestamp > sharing.sharedAt + ACKNOWLEDGEMENT_DEADLINE) {
            revert AcknowledgementDeadlinePassed();
        }

        sharing.acknowledged = true;

        emit TravelRuleAcknowledged(_sharingId, msg.sender);
    }

    // ──────────────────────────────────────────────────────────────
    // View Functions
    // ──────────────────────────────────────────────────────────────

    /**
     * @notice Returns the travel rule status for a given record.
     * @param _travelRuleId Record to query.
     * @return Current travel rule status.
     */
    function getTravelRuleStatus(bytes32 _travelRuleId) external view returns (TravelRuleStatus) {
        TravelRuleData storage record = travelRuleRecords[_travelRuleId];
        if (record.timestamp == 0) revert RecordNotFound();
        return record.status;
    }

    /**
     * @notice Returns the full travel rule data for a record.
     * @param _travelRuleId Record to query.
     * @return TravelRuleData struct.
     */
    function getTravelRuleData(bytes32 _travelRuleId) external view returns (TravelRuleData memory) {
        return travelRuleRecords[_travelRuleId];
    }

    /**
     * @notice Returns the travel rule ID for a given payment.
     * @param _paymentId NoblePay payment ID.
     * @return Travel rule ID (bytes32(0) if none exists).
     */
    function getTravelRuleForPayment(bytes32 _paymentId) external view returns (bytes32) {
        return paymentToTravelRule[_paymentId];
    }

    /**
     * @notice Checks whether a transaction amount requires full travel rule data.
     * @param _amount Transaction amount (6-decimal precision).
     * @return True if full travel rule data is required.
     */
    function requiresFullTravelRuleData(uint256 _amount) external view returns (bool) {
        return _amount >= travelRuleThreshold;
    }

    /**
     * @notice Checks whether a travel rule record has expired (beyond retention period).
     * @param _travelRuleId Record to check.
     * @return True if the record has exceeded the 5-year retention period.
     */
    function isRecordExpired(bytes32 _travelRuleId) external view returns (bool) {
        TravelRuleData storage record = travelRuleRecords[_travelRuleId];
        if (record.timestamp == 0) revert RecordNotFound();
        return (block.timestamp > record.timestamp + DATA_RETENTION_PERIOD);
    }

    /**
     * @notice Returns VASP details.
     * @param _vasp VASP address to query.
     * @return VASP struct.
     */
    function getVASPDetails(address _vasp) external view returns (VASP memory) {
        return vasps[_vasp];
    }

    // ──────────────────────────────────────────────────────────────
    // Admin
    // ──────────────────────────────────────────────────────────────

    /**
     * @notice Updates the travel rule threshold amount.
     * @param _newThreshold New threshold in 6-decimal USD equivalent.
     */
    function updateThreshold(uint256 _newThreshold) external onlyRole(ADMIN_ROLE) {
        require(_newThreshold > 0, "TravelRule: zero threshold");
        uint256 old = travelRuleThreshold;
        travelRuleThreshold = _newThreshold;
        emit ThresholdUpdated(old, _newThreshold);
    }

    /// @notice Emergency pause.
    function pause() external onlyRole(ADMIN_ROLE) {
        _pause();
    }

    /// @notice Resume operations.
    function unpause() external onlyRole(ADMIN_ROLE) {
        _unpause();
    }
}
