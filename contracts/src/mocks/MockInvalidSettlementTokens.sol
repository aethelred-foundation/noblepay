// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/** @dev Test-only contract that exposes metadata but no ERC20 accounting API. */
contract MockMetadataOnlyToken {
    function decimals() external pure returns (uint8) {
        return 6;
    }
}

/** @dev Test-only contract that omits `balanceOf` from an otherwise plausible facade. */
contract MockMissingBalanceToken {
    function decimals() external pure returns (uint8) {
        return 6;
    }

    function totalSupply() external pure returns (uint256) {
        return 0;
    }
}
