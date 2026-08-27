// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.19;

/// @title ISealSettlementGate
/// @notice Minimal consensus-backed corridor gate consumed by NoblePay.
interface ISealSettlementGate {
    function requireCleared(address payer, address payee) external view;
}
