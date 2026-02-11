// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title Logger
/// @notice Calls arbitrary contracts and logs the results
contract Logger {
    event CallExecuted(
        address indexed target,
        bytes callData,
        bool success,
        bytes returnData
    );

    /// @notice Call a contract and log the result
    /// @param target The contract to call
    /// @param callData The calldata to send
    /// @return success Whether the call succeeded
    /// @return returnData The return data from the call
    function logCall(address target, bytes calldata callData)
        external
        returns (bool success, bytes memory returnData)
    {
        (success, returnData) = target.call(callData);

        emit CallExecuted(target, callData, success, returnData);
    }

    /// @notice Call a contract with value and log the result
    /// @param target The contract to call
    /// @param callData The calldata to send
    /// @return success Whether the call succeeded
    /// @return returnData The return data from the call
    function logCallWithValue(address target, bytes calldata callData)
        external
        payable
        returns (bool success, bytes memory returnData)
    {
        (success, returnData) = target.call{value: msg.value}(callData);

        emit CallExecuted(target, callData, success, returnData);
    }
}
