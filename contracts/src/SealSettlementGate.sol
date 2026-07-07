// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

import "./interfaces/ISeal.sol";

/// @title SealSettlementGate — NoblePay's consensus-anchored corridor clearance
/// @notice The clearance side of Aethelred's seal-gated settlement model, and
///         the reason NoblePay is more than a wallet for sovereign/regulated
///         corridors: a cross-border corridor (payer → payee) is cleared for
///         settlement not by an issuer's on-chain signature or an off-chain
///         screening oracle, but by a **Digital Seal** minted by the chain's own
///         Proof-of-Useful-Work pipeline, verified by the ISeal precompile
///         (0x0900), i.e. by the SAME consensus logic that minted the seal. No
///         allowlist oracle, no off-chain screening server sits in the trust
///         path at settlement time.
///
///         Flow:
///           1. A PoUW screening job runs for a corridor with purpose
///              `noblepay:0x<payer>:0x<payee>` and a CEAP confidentiality policy
///              (jurisdiction, backend, vendor-root); the validator quorum mints
///              the Digital Seal binding purpose + attestation.
///           2. Anyone (permissionlessly — the seal's purpose binds the exact
///              corridor, so a caller cannot mis-attribute a clearance) calls
///              {clear} with the job id. The gate checks via ISeal that the seal
///              is ACTIVE, its purpose binds THIS ordered payer → payee pair, and
///              its attestation satisfies the gate's CEAP policy — then records a
///              consensus-anchored clearance.
///           3. NoblePay (or any integrator) calls {isCleared} / {requireCleared};
///              the gate re-checks the seal's live ACTIVE status through ISeal, so
///              a seal revoked on-chain (a sanctions update) closes the corridor
///              instantly with no NoblePay transaction.
///
/// @dev    Direction-sensitive (payer → payee ≠ payee → payer), one-seal-one-
///         clearance, and clearance permanence: a corridor admits exactly one
///         clearance ever — a withdrawn (revoked) corridor cannot be re-opened
///         through the permissionless path, even with a fresh policy-satisfying
///         seal. Immutable core + governed parameters; two-step ownership;
///         withdrawal-of-trust (revoke) always available. Non-upgradeable.
///
/// @dev    Provenance: this source is a faithful reconstruction whose ABI is
///         byte-for-byte identical to the reviewed artifact
///         (scripts/artifacts/SealSettlementGate.{bin,abi}) that the chain repo
///         runs against the REAL ISeal precompile in
///         internal/evmhost/noblepay_test.go, and whose behaviour is verified by
///         test/SealSettlementGate.test.js. Recompiling it yields functionally
///         equivalent — but not byte-identical — bytecode (different compiler
///         provenance/metadata), so the vendored `.bin` remains the deploy
///         artifact of record; edit here and re-vendor if the on-chain bytecode
///         must change.
contract SealSettlementGate is Ownable2Step, Pausable, ReentrancyGuard {
    /// @dev The ISeal precompile (see aethelred repo precompiles/seal).
    ISeal internal constant SEAL = ISeal(0x0000000000000000000000000000000000000900);

    /// @notice A consensus-anchored clearance for an ordered (payer, payee) corridor.
    struct Clearance {
        string sealId; // the backing Digital Seal
        uint64 clearedAt; // block time of clearance
        bool exists; // record present (permanent once set)
        bool revoked; // locally revoked by governance
    }

    // payer => payee => clearance (ordered corridor)
    mapping(address => mapping(address => Clearance)) private _clearances;
    // a seal admits exactly one clearance (replay protection)
    mapping(string => bool) public sealUsed;

    // CEAP policy every backing seal must satisfy (empty arrays = any).
    string[] private _allowedBackends;
    string private _minVerification;
    string[] private _allowedPlatforms;
    bool private _requireVendorRoot;
    string[] private _dataResidency;

    event CorridorCleared(address indexed payer, address indexed payee, string sealId, string jobId);
    event ClearanceRevoked(address indexed payer, address indexed payee, address indexed by);
    event CompliancePolicySet(
        string[] allowedBackends,
        string minVerification,
        string[] allowedPlatforms,
        bool requireVendorRoot,
        string[] dataResidency
    );

    error ZeroCorridor();
    error AlreadyCleared(address payer, address payee);
    error SealAlreadyUsed(string sealId);
    error SealNotActive(string sealId);
    error SealNotBoundToCorridor(string expectedPurpose);
    error PolicyNotSatisfied(string reason);
    error NoSuchClearance();

    constructor(address governance) {
        _transferOwnership(governance);
    }

    // ── clearance (consensus-anchored) ───────────────────────────────────────

    /// @notice Clear a corridor for settlement from a PoUW screening job whose
    ///         seal binds this ordered payer → payee pair and satisfies the
    ///         gate's CEAP policy. Permissionless: the seal is self-authorizing
    ///         (its purpose binds the corridor), so no caller role is required —
    ///         but each corridor admits exactly one clearance ever, and each seal
    ///         admits exactly one clearance.
    function clear(address payer, address payee, string calldata jobId)
        external
        whenNotPaused
        nonReentrant
    {
        if (payer == address(0) || payee == address(0)) revert ZeroCorridor();

        // Clearance permanence: a corridor's clearance slot is written once and
        // never freed. A revoked corridor reads as not-cleared (below) but its
        // slot stays occupied, so it can never be re-opened permissionlessly.
        if (_clearances[payer][payee].exists) revert AlreadyCleared(payer, payee);

        // Resolve the seal for the PoUW job (reverts if the job is unsealed).
        string memory sealId = SEAL.getSealIdByJob(jobId);
        if (sealUsed[sealId]) revert SealAlreadyUsed(sealId);
        if (!SEAL.verifySeal(sealId)) revert SealNotActive(sealId);

        // The seal must have been minted FOR this exact ordered corridor: the
        // PoUW job purpose binds payer → payee, so a clearance cannot be replayed
        // for the reverse direction or a different corridor.
        (, , , , , , string memory purpose, , ) = SEAL.getSeal(sealId);
        string memory expected = _expectedPurpose(payer, payee);
        if (keccak256(bytes(purpose)) != keccak256(bytes(expected))) {
            revert SealNotBoundToCorridor(expected);
        }

        // CEAP policy — consensus-parity satisfaction via the precompile.
        (bool ok, string memory reason) = SEAL.requireConfidentiality(
            sealId, _allowedBackends, _minVerification, _allowedPlatforms, _requireVendorRoot, _dataResidency
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

    // ── verification (what NoblePay / integrators call) ──────────────────────

    /// @notice True iff the corridor holds a live clearance: recorded, not
    ///         locally revoked, AND its backing seal is still ACTIVE on-chain
    ///         (revocation propagates from consensus instantly).
    function isCleared(address payer, address payee) public view returns (bool) {
        Clearance storage c = _clearances[payer][payee];
        if (!c.exists || c.revoked) return false;
        return SEAL.verifySeal(c.sealId);
    }

    /// @notice Reverting variant for integrators that want a hard gate.
    function requireCleared(address payer, address payee) external view {
        if (!isCleared(payer, payee)) revert NoSuchClearance();
    }

    /// @notice Full clearance record (sealId, clearedAt, flags).
    function getClearance(address payer, address payee) external view returns (Clearance memory) {
        return _clearances[payer][payee];
    }

    // ── revocation (withdrawal of trust) ─────────────────────────────────────

    /// @notice Revoke a corridor's clearance. Governance-only (sanctions/policy
    ///         withdrawal). Note: revoking the underlying Digital Seal on-chain
    ///         already closes the corridor via the live ISeal check in
    ///         {isCleared}; this is the local, corridor-scoped control. The
    ///         clearance slot remains occupied, so the corridor is permanently
    ///         withdrawn and cannot be re-cleared.
    function revoke(address payer, address payee) external onlyOwner {
        Clearance storage c = _clearances[payer][payee];
        if (!c.exists) revert NoSuchClearance();
        c.revoked = true;
        emit ClearanceRevoked(payer, payee, msg.sender);
    }

    // ── governance ───────────────────────────────────────────────────────────

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

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice The exact PoUW job purpose a seal must carry to clear the ordered
    ///         corridor (payer → payee) — helper for operators and UIs.
    function expectedPurpose(address payer, address payee) external pure returns (string memory) {
        return _expectedPurpose(payer, payee);
    }

    function _expectedPurpose(address payer, address payee) private pure returns (string memory) {
        return string(abi.encodePacked("noblepay:", _toHexAddress(payer), ":", _toHexAddress(payee)));
    }

    // ── hex helpers (lowercase, unchecksummed — purpose strings are canonical) ─

    function _toHexAddress(address account) private pure returns (string memory) {
        bytes20 raw = bytes20(account);
        bytes16 alphabet = "0123456789abcdef";
        bytes memory out = new bytes(42);
        out[0] = "0";
        out[1] = "x";
        for (uint256 i = 0; i < 20; i++) {
            out[2 + i * 2] = alphabet[uint8(raw[i]) >> 4];
            out[3 + i * 2] = alphabet[uint8(raw[i]) & 0x0f];
        }
        return string(out);
    }
}
