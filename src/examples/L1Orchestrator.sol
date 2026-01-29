// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./SyncedCounter.sol";

/// @title L1Orchestrator
/// @notice An L1 contract that orchestrates a complex cross-chain sequence:
///   1. Call setValue(number) on the L2 SyncedCounter (via its L2SenderProxy on L1)
///      - This implicitly triggers an outgoing L2→L1 call to L1SyncedCounter.setValue(number)
///      - After this: both L1 and L2 counters == number
///   2. Read the L1 SyncedCounter's value (which should now be `number`)
///   3. Call setValue(readValue + 1) on the L1 SyncedCounter
///      - This triggers an L1→L2 call to L2SyncedCounter.setValue(number + 1)
///      - After this: both L1 and L2 counters == number + 1
contract L1Orchestrator {
    address public l1SyncedCounter;
    address public l2SyncedCounterProxy; // L2SenderProxy for L2SyncedCounter on L1

    event OrchestratorExecuted(uint256 inputNumber, uint256 finalValue);

    error L1CounterNotSet();
    error L2ProxyNotSet();
    error SetValueFailed();
    error ReadValueFailed();

    function setAddresses(address _l1SyncedCounter, address _l2SyncedCounterProxy) external {
        l1SyncedCounter = _l1SyncedCounter;
        l2SyncedCounterProxy = _l2SyncedCounterProxy;
    }

    /// @notice Execute the orchestrated cross-chain sequence
    /// @param number The initial value to set
    /// @return finalValue The final value (should be number + 1)
    function execute(uint256 number) external returns (uint256 finalValue) {
        if (l1SyncedCounter == address(0)) revert L1CounterNotSet();
        if (l2SyncedCounterProxy == address(0)) revert L2ProxyNotSet();

        // Step 1: Call setValue(number) on the L2 SyncedCounter via its proxy
        // This goes: L1Orchestrator → L2SenderProxy → NativeRollupCore.handleIncomingCall
        // On L2: proxy for L1Orchestrator → L2SyncedCounter.setValue(number)
        // Since caller is NOT l1ContractProxy, L2SyncedCounter makes outgoing L1 call:
        //   L2SyncedCounter → L1SyncedCounter.setValue(number)
        // Result: both counters == number
        (bool success1,) = l2SyncedCounterProxy.call(
            abi.encodeCall(L2SyncedCounter.setValue, (number))
        );
        if (!success1) revert SetValueFailed();

        // Step 2: Read the L1 SyncedCounter's value (should now be `number`)
        uint256 currentValue = L1SyncedCounter(l1SyncedCounter).value();

        // Step 3: Call setValue(currentValue + 1) on the L1 SyncedCounter
        // This goes: L1Orchestrator → L1SyncedCounter.setValue(number + 1)
        // L1SyncedCounter calls l2Proxy → NativeRollupCore.handleIncomingCall
        // On L2: proxy for L1SyncedCounter → L2SyncedCounter.setValue(number + 1)
        // Since caller IS l1ContractProxy, L2SyncedCounter does NOT call back to L1
        // Result: both counters == number + 1
        finalValue = currentValue + 1;
        (bool success2,) = l1SyncedCounter.call(
            abi.encodeCall(L1SyncedCounter.setValue, (finalValue))
        );
        if (!success2) revert SetValueFailed();

        emit OrchestratorExecuted(number, finalValue);
        return finalValue;
    }
}
