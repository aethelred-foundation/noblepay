// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.19;

/// @title IBusinessRegistry
/// @notice Minimal fail-closed trust interface consumed by NoblePay.
interface IBusinessRegistry {
    function isBusinessActive(address business) external view returns (bool);

    /// @dev BusinessRegistry.BusinessTier is ABI-encoded as uint8.
    function getBusinessTier(address business) external view returns (uint8);
}
