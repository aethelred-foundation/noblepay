// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.19;

/**
 * @title IZeroIDRegistry — the identity surface NoblePay consumes
 * @notice Minimal view surface of the ZeroID identity registry (ZeroID.sol in
 *         the zeroid repo). Per the ecosystem responsibility matrix, ZeroID is
 *         the canonical authority for DIDs, credential status and revocation —
 *         NoblePay consumes narrowly scoped presentations of it and does NOT
 *         operate a parallel identity authority.
 */
interface IZeroIDRegistry {
    /// @notice DID hash bound to a controller wallet (zero when unbound).
    function resolveByController(address controller) external view returns (bytes32 didHash);

    /// @notice True only while the identity's status is ACTIVE — suspension
    ///         and revocation in ZeroID reflect here immediately.
    function isActiveIdentity(bytes32 didHash) external view returns (bool);
}
