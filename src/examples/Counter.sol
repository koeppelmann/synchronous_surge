// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract Counter {
    uint256 public counter;
    address public lastCaller;

    /// @notice Returns the current counter value, then increments it by 1
    function get() external returns (uint256) {
        lastCaller = msg.sender;

        uint256 current = counter;
        counter = current + 1;
        return current;
    }
}
