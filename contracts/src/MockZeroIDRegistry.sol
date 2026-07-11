// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.19;

/**
 * @title MockZeroIDRegistry — test double for the ZeroID identity registry
 * @notice The minimal surface SealSettlementGate's identity layer consumes
 *         (resolveByController + isActiveIdentity). The REAL registry is
 *         ZeroID.sol in the zeroid repo; NoblePay deliberately consumes it
 *         rather than operating a parallel identity authority (see
 *         docs/ECOSYSTEM_RESPONSIBILITIES.md).
 */
contract MockZeroIDRegistry {
    mapping(address => bytes32) private _didOf;
    mapping(bytes32 => bool) private _activeOf;

    function setIdentity(address controller, bytes32 did, bool active) external {
        _didOf[controller] = did;
        _activeOf[did] = active;
    }

    function resolveByController(address controller) external view returns (bytes32) {
        return _didOf[controller];
    }

    function isActiveIdentity(bytes32 didHash) external view returns (bool) {
        return _activeOf[didHash];
    }
}
