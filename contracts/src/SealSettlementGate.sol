// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

import "./interfaces/ISeal.sol";
import "./interfaces/IZeroIDRegistry.sol";

/**
 * @title SealSettlementGate — consensus-anchored corridor clearance
 * @author Aethelred Team
 * @notice The top assurance tier of NoblePay's compliance stack, and the
 *         reason NoblePay is the default cross-border settlement rail for
 *         sovereign and regulated clients: a corridor clearance of the highest
 *         tier is not a role-held TEE key's signature — it is anchored to a
 *         **Digital Seal** minted by the Aethelred validator quorum when a
 *         PoUW compliance job (the attested sanctions/AML/travel-rule
 *         screening for a payer→payee corridor, run under a CEAP
 *         confidentiality policy) completed. The clearance is verified by the
 *         ISeal precompile (0x0900) — the SAME consensus logic that minted the
 *         seal. Even a compromised TEE node key cannot move funds past this
 *         gate.
 *
 *         Flow:
 *           1. A PoUW screening job runs for a corridor with purpose
 *              `noblepay:0x<payer>:0x<payee>` and a CEAP policy (jurisdiction,
 *              backend, vendor-root); the validator quorum mints the Digital
 *              Seal binding purpose + attestation.
 *           2. Anyone (relayer, keeper, the payer) calls {clear} with the job
 *              id — the seal is self-authorizing because its purpose binds the
 *              exact corridor, so clearing is permissionless by design.
 *           3. NoblePay's settlement path calls {isCleared} /
 *              {requireCleared}; the gate re-checks the seal's live ACTIVE
 *              status through ISeal, so a seal revoked on-chain (e.g. a
 *              sanctions-list update) closes the corridor instantly — no
 *              NoblePay transaction, no oracle round-trip.
 *
 * @dev One corridor, one clearance, forever: {clear} refuses to overwrite an
 *      existing record (AlreadyCleared), so a governance revocation cannot be
 *      undone through the permissionless path by a second bound seal. A
 *      re-screened corridor after remediation is a governance decision, not a
 *      permissionless rewrite. Deliberately NOT upgradeable — the clearance
 *      record must not be admin-mutable. Uses Ownable2Step (the cross-dApp
 *      convention for Aethelred seal registries) rather than NoblePay's
 *      AccessControl roles: the gate has exactly one governance surface.
 */
contract SealSettlementGate is Ownable2Step, Pausable, ReentrancyGuard {
    // ──────────────────────────────────────────────────────────────
    // Constants
    // ──────────────────────────────────────────────────────────────

    /// @dev The ISeal precompile (see aethelred repo precompiles/seal). Only
    ///      real on Aethelred (EVM chain id 7332 / its production successor).
    ISeal internal constant SEAL = ISeal(0x0000000000000000000000000000000000000900);

    // ──────────────────────────────────────────────────────────────
    // Types
    // ──────────────────────────────────────────────────────────────

    /// @notice A consensus-anchored clearance for a payer→payee corridor.
    struct Clearance {
        string sealId; // the backing Digital Seal
        uint64 clearedAt; // block time of clearing
        bool exists; // record present
        bool revoked; // locally revoked by governance
    }

    // ──────────────────────────────────────────────────────────────
    // State
    // ──────────────────────────────────────────────────────────────

    // payer => payee => clearance
    mapping(address => mapping(address => Clearance)) private _clearances;
    // a seal admits exactly one clearance (replay protection)
    mapping(string => bool) public sealUsed;

    // ── ZeroID identity layer (optional; ecosystem responsibility matrix) ──
    // ZeroID — not NoblePay — is the canonical identity authority. When the
    // layer is on, BOTH corridor parties must hold registered, ACTIVE ZeroID
    // identities: enforced at clearance AND re-checked live in {isCleared},
    // so an identity suspension (e.g. a sanctions hit surfacing through
    // ZeroID) closes the corridor instantly, exactly like seal revocation.
    // Unlike seal/local revocation, identity REINSTATEMENT reopens the
    // corridor — the clearance record itself is never consumed by it.
    IZeroIDRegistry public identityRegistry;
    bool public identityRequired;

    // CEAP policy every backing seal must satisfy (empty arrays = any).
    string[] private _allowedBackends;
    string private _minVerification;
    string[] private _allowedPlatforms;
    bool private _requireVendorRoot;
    string[] private _dataResidency;

    // ──────────────────────────────────────────────────────────────
    // Events
    // ──────────────────────────────────────────────────────────────

    event CorridorCleared(
        address indexed payer, address indexed payee, string sealId, string jobId
    );
    event IdentityRegistrySet(address registry, bool required);
    event ClearanceRevoked(address indexed payer, address indexed payee, address indexed by);
    event CompliancePolicySet(
        string[] allowedBackends,
        string minVerification,
        string[] allowedPlatforms,
        bool requireVendorRoot,
        string[] dataResidency
    );

    // ──────────────────────────────────────────────────────────────
    // Errors
    // ──────────────────────────────────────────────────────────────

    error ZeroCorridor();
    error AlreadyCleared(address payer, address payee);
    error SealAlreadyUsed(string sealId);
    error SealNotActive(string sealId);
    error SealNotBoundToCorridor(string expectedPurpose);
    error PolicyNotSatisfied(string reason);
    error NoSuchClearance();
    error InvalidIdentityRegistry();
    error IdentityNotVerified(address party);

    constructor(address governance) {
        _transferOwnership(governance);
    }

    // ──────────────────────────────────────────────────────────────
    // Clearing (consensus-anchored issuance)
    // ──────────────────────────────────────────────────────────────

    /**
     * @notice Record a consensus-anchored clearance for the payer→payee
     *         corridor from the Digital Seal minted for `jobId`.
     *         Permissionless: the seal's purpose binds the exact corridor, so
     *         no caller can mis-attribute a clearance to a corridor the quorum
     *         did not screen. Each seal admits one clearance; each corridor
     *         admits one clearance record for its lifetime.
     */
    function clear(address payer, address payee, string calldata jobId)
        external
        whenNotPaused
        nonReentrant
    {
        if (payer == address(0) || payee == address(0)) revert ZeroCorridor();

        // ZeroID identity layer: both corridor parties must currently hold
        // registered, ACTIVE identities. Reverts name the failing party so
        // integrators and UIs can route the right onboarding flow.
        if (identityRequired) {
            if (!_identityActive(payer)) revert IdentityNotVerified(payer);
            if (!_identityActive(payee)) revert IdentityNotVerified(payee);
        }

        // One corridor, one clearance, forever. Without this guard a second
        // corridor-bound seal could overwrite the record — including rewriting
        // `revoked` back to false, silently undoing a governance revocation
        // through a permissionless call.
        if (_clearances[payer][payee].exists) revert AlreadyCleared(payer, payee);

        // Resolve the seal for the PoUW job (reverts if the job is unsealed).
        string memory sealId = SEAL.getSealIdByJob(jobId);
        if (sealUsed[sealId]) revert SealAlreadyUsed(sealId);
        if (!SEAL.verifySeal(sealId)) revert SealNotActive(sealId);

        // The seal must have been minted FOR this exact corridor: the PoUW job
        // purpose binds payer AND payee, so a clearance cannot be replayed
        // onto a different pair or direction (payer→payee != payee→payer).
        (, , , , , , string memory purpose, , ) = SEAL.getSeal(sealId);
        string memory expected =
            string.concat("noblepay:", _toHexAddress(payer), ":", _toHexAddress(payee));
        if (keccak256(bytes(purpose)) != keccak256(bytes(expected))) {
            revert SealNotBoundToCorridor(expected);
        }

        // CEAP policy — consensus-parity Satisfies via the precompile.
        (bool ok, string memory reason) = SEAL.requireConfidentiality(
            sealId,
            _allowedBackends,
            _minVerification,
            _allowedPlatforms,
            _requireVendorRoot,
            _dataResidency
        );
        if (!ok) revert PolicyNotSatisfied(reason);

        sealUsed[sealId] = true;
        _clearances[payer][payee] = Clearance({
            sealId: sealId,
            clearedAt: uint64(block.timestamp),
            exists: true,
            revoked: false
        });
        emit CorridorCleared(payer, payee, sealId, jobId);
    }

    // ──────────────────────────────────────────────────────────────
    // Verification (what NoblePay's settlement path calls)
    // ──────────────────────────────────────────────────────────────

    /**
     * @notice True iff the corridor carries a live consensus clearance:
     *         recorded, not locally revoked, AND its backing seal is still
     *         ACTIVE on-chain. Seal revocation (e.g. a sanctions-list update
     *         verified by the quorum) closes the corridor instantly.
     */
    function isCleared(address payer, address payee) public view returns (bool) {
        Clearance storage c = _clearances[payer][payee];
        if (!c.exists || c.revoked) return false;
        // Live ZeroID check: a suspended/revoked identity closes the corridor
        // instantly (fail-closed — a broken registry also reads as closed);
        // reinstatement in ZeroID reopens it without touching the record.
        if (identityRequired && (!_identityOk(payer) || !_identityOk(payee))) {
            return false;
        }
        return SEAL.verifySeal(c.sealId);
    }

    /// @notice Reverting variant for integrators that want a hard gate.
    function requireCleared(address payer, address payee) external view {
        if (!isCleared(payer, payee)) revert NoSuchClearance();
    }

    /// @notice Full clearance record (sealId, clearedAt, flags).
    function getClearance(address payer, address payee)
        external
        view
        returns (Clearance memory)
    {
        return _clearances[payer][payee];
    }

    // ──────────────────────────────────────────────────────────────
    // Revocation (withdrawal of trust)
    // ──────────────────────────────────────────────────────────────

    /**
     * @notice Locally revoke a corridor clearance (governance only) — one-way;
     *         combined with the AlreadyCleared guard, a revoked corridor stays
     *         closed at this tier permanently. Note: revoking the underlying
     *         Digital Seal on-chain already closes the corridor via the live
     *         ISeal check in {isCleared}; this is the local, corridor-scoped
     *         control for issues outside the seal's scope.
     */
    function revoke(address payer, address payee) external onlyOwner {
        Clearance storage c = _clearances[payer][payee];
        if (!c.exists) revert NoSuchClearance();
        c.revoked = true;
        emit ClearanceRevoked(payer, payee, msg.sender);
    }

    // ──────────────────────────────────────────────────────────────
    // Governance
    // ──────────────────────────────────────────────────────────────

    /// @notice Set the CEAP policy every backing seal must satisfy.
    function setCompliancePolicy(
        string[] calldata allowedBackends,
        string calldata minVerification,
        string[] calldata allowedPlatforms,
        bool requireVendorRoot,
        string[] calldata dataResidency
    ) external onlyOwner {
        _allowedBackends = allowedBackends;
        _minVerification = minVerification;
        _allowedPlatforms = allowedPlatforms;
        _requireVendorRoot = requireVendorRoot;
        _dataResidency = dataResidency;
        emit CompliancePolicySet(
            allowedBackends, minVerification, allowedPlatforms, requireVendorRoot, dataResidency
        );
    }

    /// @notice Current CEAP policy (for transparency / UIs).
    function compliancePolicy()
        external
        view
        returns (string[] memory, string memory, string[] memory, bool, string[] memory)
    {
        return (_allowedBackends, _minVerification, _allowedPlatforms, _requireVendorRoot, _dataResidency);
    }

    /**
     * @notice Wire (or unwire) the ZeroID identity registry and toggle the
     *         identity layer. ZeroID is the ecosystem's canonical identity
     *         authority — this gate consumes its status, it never issues or
     *         mutates identities.
     */
    function setIdentityRegistry(address registry, bool required) external onlyOwner {
        if (required && registry == address(0)) revert InvalidIdentityRegistry();
        identityRegistry = IZeroIDRegistry(registry);
        identityRequired = required;
        emit IdentityRegistrySet(registry, required);
    }

    /// @notice Pause clearing (verification reads stay live).
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ──────────────────────────────────────────────────────────────
    // Helpers
    // ──────────────────────────────────────────────────────────────

    /**
     * @notice The exact PoUW job purpose a seal must carry to clear the
     *         payer→payee corridor — helper for operators and UIs.
     */
    function expectedPurpose(address payer, address payee)
        external
        pure
        returns (string memory)
    {
        return string.concat("noblepay:", _toHexAddress(payer), ":", _toHexAddress(payee));
    }

    /// @dev Strict check used on the CLEAR path — a reverting registry
    ///      bubbles up (fail closed with the registry's own error).
    function _identityActive(address party) private view returns (bool) {
        bytes32 did = identityRegistry.resolveByController(party);
        return did != bytes32(0) && identityRegistry.isActiveIdentity(did);
    }

    /// @dev Non-reverting check used on the VIEW path — any registry failure
    ///      (broken upgrade, wrong address) reads as NOT verified, so the
    ///      corridor fails CLOSED without bricking settlement-path reads.
    function _identityOk(address party) private view returns (bool) {
        try identityRegistry.resolveByController(party) returns (bytes32 did) {
            if (did == bytes32(0)) return false;
            try identityRegistry.isActiveIdentity(did) returns (bool active) {
                return active;
            } catch {
                return false;
            }
        } catch {
            return false;
        }
    }

    // hex helper (lowercase, unchecksummed — purpose strings are canonical)

    function _toHexAddress(address account) private pure returns (string memory) {
        bytes20 value = bytes20(account);
        bytes16 alphabet = "0123456789abcdef";
        bytes memory out = new bytes(42);
        out[0] = "0";
        out[1] = "x";
        for (uint256 i = 0; i < 20; i++) {
            out[2 + i * 2] = alphabet[uint8(value[i]) >> 4];
            out[3 + i * 2] = alphabet[uint8(value[i]) & 0x0f];
        }
        return string(out);
    }
}
