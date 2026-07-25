// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.19;

import "../interfaces/IBusinessRegistry.sol";

/// @notice Deterministic test double. Never used by deployment scripts.
contract MockBusinessRegistry is IBusinessRegistry {
    struct Record {
        bool active;
        uint8 tier;
    }

    mapping(address => Record) public records;

    function setBusiness(address business, bool active, uint8 tier) external {
        records[business] = Record({active: active, tier: tier});
    }

    function isBusinessActive(address business) external view returns (bool) {
        return records[business].active;
    }

    function getBusinessTier(address business) external view returns (uint8) {
        return records[business].tier;
    }
}
