// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "../PaymentChannels.sol";

/**
 * @dev Test-only harness used to exercise upgrade/migration states that cannot
 *      be reached after the unresolved-HTLC close guard was introduced.
 */
contract PaymentChannelsTestHarness is PaymentChannels {
    constructor(address _admin, address _treasury, uint256 _feeBps)
        PaymentChannels(_admin, _treasury, _feeBps)
    {}

    function forceClosingStateForTest(
        bytes32 _channelId,
        uint256 _balanceA,
        uint256 _balanceB,
        uint256 _nonce,
        uint256 _expiresAt
    ) external {
        Channel storage ch = channels[_channelId];
        ch.status = ChannelStatus.CLOSING;
        ch.balanceA = _balanceA;
        ch.balanceB = _balanceB;
        ch.nonce = _nonce;

        disputes[_channelId] = ChannelDispute({
            channelId: _channelId,
            challenger: ch.partyA,
            challengeNonce: _nonce,
            challengeBalanceA: _balanceA,
            challengeBalanceB: _balanceB,
            initiatedAt: block.timestamp,
            expiresAt: _expiresAt,
            resolved: false
        });
    }
}
