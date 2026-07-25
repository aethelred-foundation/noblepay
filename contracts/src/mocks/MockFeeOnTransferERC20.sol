// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @dev Test-only six-decimal token that can burn a configurable transfer fee.
 *      It proves channel accounting rejects tokens whose observed escrow delta
 *      differs from the amount requested by the caller.
 */
contract MockFeeOnTransferERC20 is ERC20 {
    uint256 public feeBps;

    constructor() ERC20("Fee USDC", "fUSDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function setFeeBps(uint256 _feeBps) external {
        require(_feeBps <= 10_000, "fee too high");
        feeBps = _feeBps;
    }

    function mint(address _to, uint256 _amount) external {
        _mint(_to, _amount);
    }

    function _transfer(address _from, address _to, uint256 _amount) internal override {
        uint256 fee = (_amount * feeBps) / 10_000;
        super._transfer(_from, _to, _amount - fee);
        if (fee != 0) _burn(_from, fee);
    }
}
