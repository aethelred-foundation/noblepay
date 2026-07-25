// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/interfaces/IERC1271.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @notice Deterministic ERC-1271 test wallet. Never used by deployment scripts.
contract MockERC1271Wallet is IERC1271 {
    bytes4 private constant MAGIC_VALUE = IERC1271.isValidSignature.selector;

    address public immutable owner;

    error Unauthorized();
    error ExecutionFailed();

    constructor(address _owner) {
        owner = _owner;
    }

    function isValidSignature(
        bytes32 hash,
        bytes memory signature
    ) external view returns (bytes4) {
        (address recovered, ECDSA.RecoverError error) = ECDSA.tryRecover(hash, signature);
        return error == ECDSA.RecoverError.NoError && recovered == owner
            ? MAGIC_VALUE
            : bytes4(0xffffffff);
    }

    function execute(address target, bytes calldata data) external returns (bytes memory result) {
        if (msg.sender != owner) revert Unauthorized();
        (bool success, bytes memory returnData) = target.call(data);
        if (!success) {
            if (returnData.length == 0) revert ExecutionFailed();
            assembly {
                revert(add(returnData, 32), mload(returnData))
            }
        }
        return returnData;
    }
}
