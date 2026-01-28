// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title CallLogger
/// @notice Minimal contract that calls a target and stores the raw return data
contract CallLogger {
    struct CallResult {
        bool success;
        bytes returnData;
    }

    mapping(uint256 => CallResult) public results;
    uint256 public callCount;

    function makeCall(address target, bytes calldata data) external returns (bool success, bytes memory returnData) {
        (success, returnData) = target.call(data);
        results[callCount] = CallResult(success, returnData);
        callCount++;
    }

    function getResult(uint256 index) external view returns (bool success, bytes memory returnData) {
        CallResult storage r = results[index];
        return (r.success, r.returnData);
    }
}
