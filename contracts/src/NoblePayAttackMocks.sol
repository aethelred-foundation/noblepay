// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.19;

interface INoblePayAttack {
    function settlePayment(bytes32 paymentId) external;
    function refundPayment(bytes32 paymentId) external;
    function cancelPayment(bytes32 paymentId) external;
}

/**
 * @title MaliciousNativeReceiver
 * @notice Attack fixture proving NoblePay's ReentrancyGuard actually guards the
 *         native-settlement path: settlePayment sends `netAmount` to the payment
 *         recipient via a low-level call, handing this contract execution
 *         control MID-SETTLEMENT. When armed, it re-enters NoblePay
 *         (settlePayment of a *second* funded payment) from inside receive() —
 *         a real cross-payment reentrancy attempt that must revert with
 *         "ReentrancyGuard: reentrant call".
 */
contract MaliciousNativeReceiver {
    INoblePayAttack public noblepay;
    bytes32 public reentryTarget;
    uint8 public mode; // 0 = settle, 1 = refund, 2 = cancel
    bool public armed;

    function arm(address _noblepay, bytes32 _reentryTarget, uint8 _mode) external {
        noblepay = INoblePayAttack(_noblepay);
        reentryTarget = _reentryTarget;
        mode = _mode;
        armed = true;
    }

    receive() external payable {
        if (armed) {
            armed = false; // single attempt; avoid infinite loops
            if (mode == 0) {
                noblepay.settlePayment(reentryTarget);
            } else if (mode == 1) {
                noblepay.refundPayment(reentryTarget);
            } else {
                noblepay.cancelPayment(reentryTarget);
            }
        }
    }
}

interface INoblePaySettle {
    function settlePayment(bytes32 paymentId) external;
}

/**
 * @title ReentrantSealGate
 * @notice A malicious drop-in for SealSettlementGate. Its isCleared tries to
 *         re-enter NoblePay.settlePayment while pretending to answer the
 *         clearance query. Because the ISealSettlementGate interface declares
 *         isCleared as `view`, NoblePay invokes it via STATICCALL — so this
 *         state-changing re-entry attempt reverts at the EVM level, proving the
 *         gate boundary cannot be used to reenter settlement even if governance
 *         wired a hostile gate.
 */
contract ReentrantSealGate {
    INoblePaySettle public noblepay;
    bytes32 public reentryTarget;

    function arm(address _noblepay, bytes32 _reentryTarget) external {
        noblepay = INoblePaySettle(_noblepay);
        reentryTarget = _reentryTarget;
    }

    function isCleared(address, address) external returns (bool) {
        // State-changing call from within a staticcall context → reverts.
        noblepay.settlePayment(reentryTarget);
        return true;
    }

    function requireCleared(address, address) external view {}
}
