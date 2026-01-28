// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {L1SyncedCounter, L2SyncedCounter} from "./SyncedCounter.sol";

/// @title SyncDemo
/// @notice Demonstrates synchronous L1↔L2 composability
/// @dev Shows that L1 can read L2 state, modify it, and read the updated state
///      all within a single L1 transaction.
///
/// Expected behavior:
///   - If L2SyncedCounter.value() is 42 and we call setValue(66):
///     - valueBefore = 42 (old L2 value, read before update)
///     - valueSet = 66 (the value we set)
///     - valueAfter = 66 (new L2 value, read after update - proves sync happened)
///
/// This demonstrates that L1 can synchronously observe L2 state changes
/// that were triggered by L1 actions, all within a single transaction.
contract SyncDemo {
    /// @notice The L2 counter's proxy on L1 (L2SenderProxy)
    /// @dev This proxy routes calls to NativeRollupCore.handleIncomingCall()
    ///      which returns pre-registered responses
    address public l2CounterProxy;

    /// @notice The L1SyncedCounter contract address
    /// @dev When we call setValue() on this, it syncs to L2 via its l2Proxy
    address public l1Counter;

    /// @notice Value read from L2 BEFORE the update
    uint256 public valueBefore;

    /// @notice The value that was set
    uint256 public valueSet;

    /// @notice Value read from L2 AFTER the update
    uint256 public valueAfter;

    /// @notice Emitted when setValue completes successfully
    /// @param valueBefore The L2 value before the update
    /// @param valueSet The value that was set
    /// @param valueAfter The L2 value after the update
    event SyncDemoExecuted(
        uint256 valueBefore,
        uint256 valueSet,
        uint256 valueAfter
    );

    error L2ProxyNotSet();
    error L1CounterNotSet();
    error ReadL2Failed();
    error SetValueFailed();
    error SyncVerificationFailed(uint256 expected, uint256 actual);

    /// @notice Initialize the demo contract with required addresses
    /// @param _l2CounterProxy The L2SyncedCounter's proxy on L1 (L2SenderProxy address)
    /// @param _l1Counter The L1SyncedCounter address
    function initialize(address _l2CounterProxy, address _l1Counter) external {
        l2CounterProxy = _l2CounterProxy;
        l1Counter = _l1Counter;
    }

    /// @notice Read the current value from L2SyncedCounter via its proxy
    /// @dev The proxy routes to NativeRollupCore.handleIncomingCall()
    ///      which returns the pre-registered return value
    /// @return The current value on L2
    function _readL2Value() internal returns (uint256) {
        // Call value() on the L2 counter's proxy
        // The proxy's fallback forwards to handleIncomingCall()
        // which looks up the registered response and returns it
        (bool success, bytes memory result) = l2CounterProxy.call(
            abi.encodeWithSignature("value()")
        );

        if (!success) {
            revert ReadL2Failed();
        }

        return abi.decode(result, (uint256));
    }

    /// @notice Demonstrate synchronous L1↔L2 composability
    /// @param newValue The value to set
    /// @dev Flow:
    ///      1. Read L2SyncedCounter.value() via proxy → returns old value
    ///      2. Call L1SyncedCounter.setValue(newValue) → this syncs to L2
    ///      3. Read L2SyncedCounter.value() via proxy → returns new value
    ///
    /// The magic: Step 2 triggers L1SyncedCounter to call its l2Proxy with setValue().
    /// That call goes through handleIncomingCall() which updates l2BlockHash.
    /// So when Step 3 reads, it uses the NEW l2BlockHash and gets the updated value.
    function setValue(uint256 newValue) external {
        if (l2CounterProxy == address(0)) revert L2ProxyNotSet();
        if (l1Counter == address(0)) revert L1CounterNotSet();

        // Step 1: Read the current value from L2
        // This uses the CURRENT l2BlockHash to look up the registered response
        valueBefore = _readL2Value();

        // Step 2: Set the value on L1 (which syncs to L2)
        // L1SyncedCounter.setValue() calls its l2Proxy.setValue()
        // That triggers handleIncomingCall() which:
        //   - Looks up the registered response for (L2Counter, currentHash, setValue(newValue))
        //   - Updates l2BlockHash to the new state hash
        //   - Returns the pre-registered return value
        valueSet = newValue;

        (bool success, ) = l1Counter.call(
            abi.encodeWithSignature("setValue(uint256)", newValue)
        );

        if (!success) {
            revert SetValueFailed();
        }

        // Step 3: Read the new value from L2
        // Now l2BlockHash has been updated by the sync in Step 2
        // So this uses the NEW l2BlockHash to look up a DIFFERENT registered response
        // That response contains the updated value
        valueAfter = _readL2Value();

        // Verify the sync worked - valueAfter should equal what we set
        if (valueAfter != newValue) {
            revert SyncVerificationFailed(newValue, valueAfter);
        }

        emit SyncDemoExecuted(valueBefore, valueSet, valueAfter);
    }

    /// @notice Read-only function to get all stored values
    /// @return _valueBefore The value before the last update
    /// @return _valueSet The value that was set
    /// @return _valueAfter The value after the update
    function getValues() external view returns (uint256 _valueBefore, uint256 _valueSet, uint256 _valueAfter) {
        return (valueBefore, valueSet, valueAfter);
    }
}
