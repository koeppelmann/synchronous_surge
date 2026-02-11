// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title LoggerWithStorage
/// @notice Calls arbitrary contracts, logs the results, and stores call history
contract LoggerWithStorage {
    struct CallRecord {
        address target;
        bytes callData;
        bytes returnData;
        bool success;
    }

    /// @notice Array of all recorded calls
    CallRecord[] public calls;

    event CallExecuted(
        uint256 indexed callIndex,
        address indexed target,
        bytes callData,
        bool success,
        bytes returnData
    );

    /// @notice Call a contract, log and store the result
    /// @param target The contract to call
    /// @param callData The calldata to send
    /// @return success Whether the call succeeded
    /// @return returnData The return data from the call
    function logCall(address target, bytes calldata callData)
        external
        returns (bool success, bytes memory returnData)
    {
        (success, returnData) = target.call(callData);

        uint256 callIndex = calls.length;
        calls.push(CallRecord({
            target: target,
            callData: callData,
            returnData: returnData,
            success: success
        }));

        emit CallExecuted(callIndex, target, callData, success, returnData);
    }

    /// @notice Call a contract with value, log and store the result
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

        uint256 callIndex = calls.length;
        calls.push(CallRecord({
            target: target,
            callData: callData,
            returnData: returnData,
            success: success
        }));

        emit CallExecuted(callIndex, target, callData, success, returnData);
    }

    /// @notice Get the total number of recorded calls
    /// @return The number of calls
    function getCallCount() external view returns (uint256) {
        return calls.length;
    }

    /// @notice Get a specific call record
    /// @param index The index of the call
    /// @return target The target address
    /// @return callData The calldata sent
    /// @return returnData The return data received
    /// @return success Whether the call succeeded
    function getCall(uint256 index)
        external
        view
        returns (
            address target,
            bytes memory callData,
            bytes memory returnData,
            bool success
        )
    {
        require(index < calls.length, "Index out of bounds");
        CallRecord storage record = calls[index];
        return (record.target, record.callData, record.returnData, record.success);
    }
}
