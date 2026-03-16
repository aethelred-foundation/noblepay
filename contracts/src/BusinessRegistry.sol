// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/security/Pausable.sol";

/**
 * @title BusinessRegistry
 * @author Aethelred Team
 * @notice UAE-focused business registration and KYC contract for the NoblePay
 *         cross-border payment platform. Manages business onboarding, tiered
 *         volume limits, license validation, and annual re-verification.
 *
 * @dev Business lifecycle:
 *
 *   ┌────────────┐    verify()     ┌────────────┐   suspend()   ┌────────────┐
 *   │  PENDING   │ ──────────────▸ │  VERIFIED  │ ────────────▸ │ SUSPENDED  │
 *   └────────────┘                 └────────────┘               └────────────┘
 *                                       │    ▲                       │
 *                                       │    │  reinstate()          │
 *                                       │    └───────────────────────┘
 *                                       │
 *                                  revoke()
 *                                       │
 *                                       ▼
 *                                 ┌────────────┐
 *                                 │  REVOKED   │
 *                                 └────────────┘
 *
 * UAE License format:
 *   - Free zone licenses: 6+ digit numeric (e.g., DMCC, DIFC, ADGM)
 *   - Mainland DED licenses: 6+ digit numeric with optional prefix
 *   - Validated via length and format checks on-chain; full validation
 *     is performed off-chain by the verifier.
 *
 * Tier limits (USD equivalent, 6-decimal precision):
 *   - STANDARD:   $50K/day   |  $500K/month
 *   - PREMIUM:    $500K/day  |  $5M/month
 *   - ENTERPRISE: $5M/day    |  $50M/month
 */
contract BusinessRegistry is AccessControl, Pausable {

    // ──────────────────────────────────────────────────────────────
    // Roles
    // ──────────────────────────────────────────────────────────────

    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant VERIFIER_ROLE = keccak256("VERIFIER_ROLE");

    // ──────────────────────────────────────────────────────────────
    // Enums
    // ──────────────────────────────────────────────────────────────

    /// @notice KYC verification status.
    enum KYCStatus {
        PENDING,
        VERIFIED,
        SUSPENDED,
        REVOKED
    }

    /// @notice Business tier determining volume limits and fee discounts.
    enum BusinessTier {
        STANDARD,
        PREMIUM,
        ENTERPRISE
    }

    /// @notice Jurisdiction classification.
    enum Jurisdiction {
        UAE,
        INTERNATIONAL
    }

    // ──────────────────────────────────────────────────────────────
    // Structs
    // ──────────────────────────────────────────────────────────────

    /// @notice Full business registration record.
    struct Business {
        address wallet;
        string licenseNumber;         // UAE trade license number
        string businessName;
        Jurisdiction jurisdiction;
        KYCStatus kycStatus;
        BusinessTier tier;
        uint256 registeredAt;
        uint256 lastVerified;
        address complianceOfficer;    // Designated compliance contact
    }

    // ──────────────────────────────────────────────────────────────
    // Constants
    // ──────────────────────────────────────────────────────────────

    /// @notice Annual re-verification interval (365 days).
    uint256 public constant REVERIFICATION_INTERVAL = 365 days;

    /// @notice Minimum license number length for UAE businesses.
    uint256 public constant MIN_LICENSE_LENGTH = 6;

    /// @notice Maximum license number length.
    uint256 public constant MAX_LICENSE_LENGTH = 20;

    // ──────────────────────────────────────────────────────────────
    // State
    // ──────────────────────────────────────────────────────────────

    /// @notice Business records keyed by wallet address.
    mapping(address => Business) public businesses;

    /// @notice License number to wallet mapping (prevents duplicate registrations).
    mapping(bytes32 => address) public licenseToWallet;

    /// @notice Total number of registered businesses.
    uint256 public totalBusinesses;

    /// @notice Total number of verified businesses.
    uint256 public verifiedBusinessCount;

    /// @notice Reference to the NoblePay core contract for syncing.
    address public noblePayContract;

    // ──────────────────────────────────────────────────────────────
    // Events
    // ──────────────────────────────────────────────────────────────

    event BusinessRegistered(
        address indexed wallet,
        string licenseNumber,
        string businessName,
        Jurisdiction jurisdiction
    );

    event BusinessVerified(address indexed wallet, address indexed verifier, uint256 verifiedAt);
    event BusinessSuspended(address indexed wallet, string reason);
    event BusinessReinstated(address indexed wallet, address indexed reinstatedBy);
    event BusinessRevoked(address indexed wallet, string reason);
    event TierUpgraded(address indexed wallet, BusinessTier oldTier, BusinessTier newTier);
    event ComplianceOfficerUpdated(address indexed wallet, address indexed oldOfficer, address indexed newOfficer);
    event NoblePayContractUpdated(address indexed oldContract, address indexed newContract);

    // ──────────────────────────────────────────────────────────────
    // Errors
    // ──────────────────────────────────────────────────────────────

    error ZeroAddress();
    error BusinessAlreadyRegistered();
    error BusinessNotFound();
    error LicenseAlreadyRegistered();
    error InvalidLicenseNumber();
    error InvalidBusinessName();
    error InvalidKYCStatus(KYCStatus current, KYCStatus expected);
    error CannotDowngradeTier();
    error AlreadyAtMaxTier();
    error ReverificationNotDue();
    error ReverificationOverdue();

    // ──────────────────────────────────────────────────────────────
    // Constructor
    // ──────────────────────────────────────────────────────────────

    /**
     * @notice Deploys the BusinessRegistry.
     * @param _admin Admin address with full control.
     */
    constructor(address _admin) {
        if (_admin == address(0)) revert ZeroAddress();

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(ADMIN_ROLE, _admin);
        _grantRole(VERIFIER_ROLE, _admin);
    }

    // ──────────────────────────────────────────────────────────────
    // Business Registration
    // ──────────────────────────────────────────────────────────────

    /**
     * @notice Registers a new business on the NoblePay platform.
     * @param _licenseNumber     UAE trade license number or international equivalent.
     * @param _businessName      Legal name of the business entity.
     * @param _jurisdiction      UAE or INTERNATIONAL.
     * @param _complianceOfficer Address of the business's designated compliance officer.
     */
    function registerBusiness(
        string calldata _licenseNumber,
        string calldata _businessName,
        Jurisdiction _jurisdiction,
        address _complianceOfficer
    ) external whenNotPaused {
        if (businesses[msg.sender].registeredAt != 0) revert BusinessAlreadyRegistered();
        if (_complianceOfficer == address(0)) revert ZeroAddress();

        // Validate license number format
        _validateLicenseNumber(_licenseNumber, _jurisdiction);

        // Validate business name
        if (bytes(_businessName).length == 0) revert InvalidBusinessName();

        // Check for duplicate license
        bytes32 licenseHash = keccak256(abi.encodePacked(_licenseNumber));
        if (licenseToWallet[licenseHash] != address(0)) revert LicenseAlreadyRegistered();

        businesses[msg.sender] = Business({
            wallet: msg.sender,
            licenseNumber: _licenseNumber,
            businessName: _businessName,
            jurisdiction: _jurisdiction,
            kycStatus: KYCStatus.PENDING,
            tier: BusinessTier.STANDARD,
            registeredAt: block.timestamp,
            lastVerified: 0,
            complianceOfficer: _complianceOfficer
        });

        licenseToWallet[licenseHash] = msg.sender;
        totalBusinesses++;

        emit BusinessRegistered(msg.sender, _licenseNumber, _businessName, _jurisdiction);
    }

    // ──────────────────────────────────────────────────────────────
    // Verification (Verifier-only)
    // ──────────────────────────────────────────────────────────────

    /**
     * @notice Verifies a business's KYC documentation.
     * @dev Only callable by addresses with VERIFIER_ROLE. Also handles
     *      annual re-verification.
     * @param _business Address of the business to verify.
     */
    function verifyBusiness(address _business) external onlyRole(VERIFIER_ROLE) whenNotPaused {
        Business storage biz = businesses[_business];
        if (biz.registeredAt == 0) revert BusinessNotFound();

        require(
            biz.kycStatus == KYCStatus.PENDING || biz.kycStatus == KYCStatus.VERIFIED,
            "BusinessRegistry: invalid status for verification"
        );

        if (biz.kycStatus == KYCStatus.PENDING) {
            verifiedBusinessCount++;
        }

        biz.kycStatus = KYCStatus.VERIFIED;
        biz.lastVerified = block.timestamp;

        emit BusinessVerified(_business, msg.sender, block.timestamp);
    }

    /**
     * @notice Suspends a business, preventing it from initiating payments.
     * @param _business Address of the business to suspend.
     * @param _reason   Human-readable reason for suspension.
     */
    function suspendBusiness(
        address _business,
        string calldata _reason
    ) external onlyRole(VERIFIER_ROLE) whenNotPaused {
        Business storage biz = businesses[_business];
        if (biz.registeredAt == 0) revert BusinessNotFound();
        if (biz.kycStatus != KYCStatus.VERIFIED) {
            revert InvalidKYCStatus(biz.kycStatus, KYCStatus.VERIFIED);
        }

        biz.kycStatus = KYCStatus.SUSPENDED;
        verifiedBusinessCount--;

        emit BusinessSuspended(_business, _reason);
    }

    /**
     * @notice Reinstates a previously suspended business.
     * @param _business Address of the business to reinstate.
     */
    function reinstateBusiness(address _business) external onlyRole(VERIFIER_ROLE) whenNotPaused {
        Business storage biz = businesses[_business];
        if (biz.registeredAt == 0) revert BusinessNotFound();
        if (biz.kycStatus != KYCStatus.SUSPENDED) {
            revert InvalidKYCStatus(biz.kycStatus, KYCStatus.SUSPENDED);
        }

        biz.kycStatus = KYCStatus.VERIFIED;
        biz.lastVerified = block.timestamp;
        verifiedBusinessCount++;

        emit BusinessReinstated(_business, msg.sender);
    }

    /**
     * @notice Permanently revokes a business registration.
     * @param _business Address of the business to revoke.
     * @param _reason   Human-readable reason for revocation.
     */
    function revokeBusiness(
        address _business,
        string calldata _reason
    ) external onlyRole(ADMIN_ROLE) {
        Business storage biz = businesses[_business];
        if (biz.registeredAt == 0) revert BusinessNotFound();

        if (biz.kycStatus == KYCStatus.VERIFIED) {
            verifiedBusinessCount--;
        }

        biz.kycStatus = KYCStatus.REVOKED;

        emit BusinessRevoked(_business, _reason);
    }

    // ──────────────────────────────────────────────────────────────
    // Tier Management
    // ──────────────────────────────────────────────────────────────

    /**
     * @notice Upgrades a business to a higher tier.
     * @param _business Address of the business.
     * @param _newTier  Target tier (must be higher than current).
     */
    function upgradeTier(
        address _business,
        BusinessTier _newTier
    ) external onlyRole(ADMIN_ROLE) whenNotPaused {
        Business storage biz = businesses[_business];
        if (biz.registeredAt == 0) revert BusinessNotFound();
        if (biz.kycStatus != KYCStatus.VERIFIED) {
            revert InvalidKYCStatus(biz.kycStatus, KYCStatus.VERIFIED);
        }
        if (_newTier == BusinessTier.ENTERPRISE && biz.tier == BusinessTier.ENTERPRISE) {
            revert AlreadyAtMaxTier();
        }
        if (uint8(_newTier) <= uint8(biz.tier)) revert CannotDowngradeTier();

        BusinessTier oldTier = biz.tier;
        biz.tier = _newTier;

        emit TierUpgraded(_business, oldTier, _newTier);
    }

    // ──────────────────────────────────────────────────────────────
    // Compliance Officer Management
    // ──────────────────────────────────────────────────────────────

    /**
     * @notice Updates the designated compliance officer for a business.
     * @dev Only the business wallet itself or an admin can update this.
     * @param _newOfficer New compliance officer address.
     */
    function updateComplianceOfficer(address _newOfficer) external whenNotPaused {
        if (_newOfficer == address(0)) revert ZeroAddress();

        Business storage biz = businesses[msg.sender];
        if (biz.registeredAt == 0) revert BusinessNotFound();

        address oldOfficer = biz.complianceOfficer;
        biz.complianceOfficer = _newOfficer;

        emit ComplianceOfficerUpdated(msg.sender, oldOfficer, _newOfficer);
    }

    // ──────────────────────────────────────────────────────────────
    // View Functions
    // ──────────────────────────────────────────────────────────────

    /**
     * @notice Returns the full business record for an address.
     * @param _business Address to query.
     * @return Business struct with all fields.
     */
    function getBusinessDetails(address _business) external view returns (Business memory) {
        return businesses[_business];
    }

    /**
     * @notice Checks whether a business is verified and active.
     * @param _business Address to check.
     * @return True if verified and re-verification is not overdue.
     */
    function isBusinessActive(address _business) external view returns (bool) {
        Business storage biz = businesses[_business];
        if (biz.kycStatus != KYCStatus.VERIFIED) return false;
        if (biz.lastVerified + REVERIFICATION_INTERVAL < block.timestamp) return false;
        return true;
    }

    /**
     * @notice Checks whether a business needs annual re-verification.
     * @param _business Address to check.
     * @return True if re-verification is due.
     */
    function needsReverification(address _business) external view returns (bool) {
        Business storage biz = businesses[_business];
        if (biz.kycStatus != KYCStatus.VERIFIED) return false;
        return (biz.lastVerified + REVERIFICATION_INTERVAL <= block.timestamp);
    }

    /**
     * @notice Returns the business tier for an address.
     * @param _business Address to query.
     * @return Business tier enum value.
     */
    function getBusinessTier(address _business) external view returns (BusinessTier) {
        return businesses[_business].tier;
    }

    // ──────────────────────────────────────────────────────────────
    // Admin
    // ──────────────────────────────────────────────────────────────

    /// @notice Sets the NoblePay core contract address for cross-contract sync.
    function setNoblePayContract(address _noblepay) external onlyRole(ADMIN_ROLE) {
        if (_noblepay == address(0)) revert ZeroAddress();
        address old = noblePayContract;
        noblePayContract = _noblepay;
        emit NoblePayContractUpdated(old, _noblepay);
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
    // Internal
    // ──────────────────────────────────────────────────────────────

    /**
     * @dev Validates a business license number format.
     *      UAE licenses must be 6-20 characters. International licenses
     *      have more relaxed validation (non-empty, within length bounds).
     * @param _license     License number string.
     * @param _jurisdiction Business jurisdiction.
     */
    function _validateLicenseNumber(
        string calldata _license,
        Jurisdiction _jurisdiction
    ) internal pure {
        uint256 len = bytes(_license).length;
        if (len < MIN_LICENSE_LENGTH || len > MAX_LICENSE_LENGTH) {
            revert InvalidLicenseNumber();
        }

        // UAE-specific validation: must contain only alphanumeric characters and hyphens
        if (_jurisdiction == Jurisdiction.UAE) {
            bytes memory b = bytes(_license);
            for (uint256 i; i < len;) {
                bytes1 c = b[i];
                bool isAlphanumeric = (c >= 0x30 && c <= 0x39) || // 0-9
                                      (c >= 0x41 && c <= 0x5A) || // A-Z
                                      (c >= 0x61 && c <= 0x7A) || // a-z
                                      c == 0x2D;                  // hyphen
                if (!isAlphanumeric) revert InvalidLicenseNumber();
                unchecked { ++i; }
            }
        }
    }
}
