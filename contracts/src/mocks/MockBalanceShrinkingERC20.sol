// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @dev Test-only six-decimal token that can shrink the recipient's existing
 *      balance during a transfer, modelling a negative-rebase accounting edge.
 */
contract MockBalanceShrinkingERC20 is ERC20 {
    uint256 public recipientShrinkBps;

    constructor() ERC20("Shrinking USDC", "sUSDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function setRecipientShrinkBps(uint256 _shrinkBps) external {
        require(_shrinkBps <= 10_000, "shrink too high");
        recipientShrinkBps = _shrinkBps;
    }

    function mint(address _to, uint256 _amount) external {
        _mint(_to, _amount);
    }

    function _transfer(address _from, address _to, uint256 _amount) internal override {
        uint256 shrink = (balanceOf(_to) * recipientShrinkBps) / 10_000;
        if (shrink != 0) _burn(_to, shrink);
        super._transfer(_from, _to, _amount);
    }
}
