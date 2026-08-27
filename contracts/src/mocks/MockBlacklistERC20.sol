// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Test-only six-decimal token that models stablecoin address blocklisting.
contract MockBlacklistERC20 is ERC20 {
    mapping(address => bool) public blacklisted;

    error BlacklistedAddress(address account);

    constructor() ERC20("Blacklist USD", "bUSD") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setBlacklisted(address account, bool blocked) external {
        blacklisted[account] = blocked;
    }

    function _beforeTokenTransfer(
        address from,
        address to,
        uint256 amount
    ) internal override {
        if (from != address(0) && blacklisted[from]) {
            revert BlacklistedAddress(from);
        }
        if (to != address(0) && blacklisted[to]) {
            revert BlacklistedAddress(to);
        }
        super._beforeTokenTransfer(from, to, amount);
    }
}
