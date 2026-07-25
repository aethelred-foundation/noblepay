// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/interfaces/IERC3156FlashBorrower.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface ILiquidityPoolFlashLender {
    function flashLoan(
        bytes32 poolId,
        address token,
        uint256 amount,
        bytes calldata data
    ) external returns (bytes32 flashLoanId);
}

/**
 * @dev Test-only ERC-3156 receiver used to exercise LiquidityPool callbacks.
 */
contract MockFlashLoanReceiver is IERC3156FlashBorrower {
    enum Behavior {
        REPAY,
        UNDERPAY,
        REVERT_CALLBACK,
        INVALID_RETURN,
        REENTER
    }

    bytes32 private constant CALLBACK_SUCCESS =
        keccak256("ERC3156FlashBorrower.onFlashLoan");

    address public immutable lender;
    Behavior public behavior;
    bytes32 public pendingPoolId;

    address public lastInitiator;
    address public lastToken;
    uint256 public lastAmount;
    uint256 public lastFee;
    bytes32 public lastDataHash;
    bool public lastReentrySucceeded;
    bytes public lastReentryRevert;

    error CallbackRejected();
    error UnauthorizedLender(address caller);

    constructor(address _lender) {
        lender = _lender;
    }

    function setBehavior(Behavior _behavior) external {
        behavior = _behavior;
    }

    function requestFlashLoan(
        bytes32 _poolId,
        address _token,
        uint256 _amount,
        bytes calldata _data
    ) external returns (bytes32 flashLoanId) {
        pendingPoolId = _poolId;
        return ILiquidityPoolFlashLender(lender).flashLoan(
            _poolId,
            _token,
            _amount,
            _data
        );
    }

    function onFlashLoan(
        address _initiator,
        address _token,
        uint256 _amount,
        uint256 _fee,
        bytes calldata _data
    ) external override returns (bytes32) {
        if (msg.sender != lender) revert UnauthorizedLender(msg.sender);
        if (behavior == Behavior.REVERT_CALLBACK) revert CallbackRejected();

        lastInitiator = _initiator;
        lastToken = _token;
        lastAmount = _amount;
        lastFee = _fee;
        lastDataHash = keccak256(_data);

        if (behavior == Behavior.REENTER) {
            (lastReentrySucceeded, lastReentryRevert) = lender.call(
                abi.encodeWithSelector(
                    ILiquidityPoolFlashLender.flashLoan.selector,
                    pendingPoolId,
                    _token,
                    1,
                    bytes("")
                )
            );
        }

        uint256 repayment = _amount + _fee;
        if (behavior == Behavior.UNDERPAY) {
            repayment -= 1;
        }
        IERC20(_token).approve(lender, repayment);

        if (behavior == Behavior.INVALID_RETURN) return bytes32(0);
        return CALLBACK_SUCCESS;
    }
}
