// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.19;

import "../interfaces/ISealSettlementGate.sol";

/// @notice Deterministic test double. Never used by deployment scripts.
contract MockSealSettlementGate is ISealSettlementGate {
    mapping(address => mapping(address => bool)) public cleared;
    bool public allowAll;

    error CorridorNotCleared(address payer, address payee);

    constructor(bool _allowAll) {
        allowAll = _allowAll;
    }

    function setAllowAll(bool value) external {
        allowAll = value;
    }

    function setCleared(address payer, address payee, bool value) external {
        cleared[payer][payee] = value;
    }

    function requireCleared(address payer, address payee) external view {
        if (!allowAll && !cleared[payer][payee]) revert CorridorNotCleared(payer, payee);
    }
}
