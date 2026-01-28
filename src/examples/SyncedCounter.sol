// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title L1SyncedCounter
/// @notice L1 contract that stays in sync with its L2 counterpart
/// @dev Anyone can call setValue. If caller is NOT the L2 proxy, it syncs to L2.
///      IMPORTANT: Refuses to update state if sibling sync fails.
contract L1SyncedCounter {
    uint256 public value;
    address public l2Proxy;

    event ValueSet(uint256 newValue, address setter);

    error L2ProxyNotSet();
    error L2ProxyNotDeployed();
    error L2SyncFailed();

    function setL2Proxy(address _l2Proxy) external {
        l2Proxy = _l2Proxy;
    }

    /// @notice Set value - syncs to L2 unless called BY L2
    /// @dev Reverts if L2 proxy is not set or not deployed (no code)
    function setValue(uint256 _value) external returns (uint256) {
        if (l2Proxy == address(0)) revert L2ProxyNotSet();

        // If NOT called by L2 proxy, we need to sync to L2
        // Verify the proxy has code before attempting sync
        if (msg.sender != l2Proxy) {
            // Check that proxy has code (is deployed)
            uint256 codeSize;
            assembly {
                codeSize := extcodesize(sload(l2Proxy.slot))
            }
            if (codeSize == 0) revert L2ProxyNotDeployed();

            // Sync to L2 - must succeed or we revert
            (bool success,) = l2Proxy.call(
                abi.encodeCall(L2SyncedCounter.setValue, (_value))
            );
            if (!success) revert L2SyncFailed();
        }

        // Only update state AFTER successful sync (or if called by L2)
        value = _value;
        emit ValueSet(_value, msg.sender);

        return _value;
    }
}

/// @title L2SyncedCounter
/// @notice L2 contract that stays in sync with its L1 counterpart
/// @dev Anyone can call setValue. If caller is NOT the L1 contract's proxy, it syncs to L1.
///      IMPORTANT: Refuses to update state if sibling sync would fail.
contract L2SyncedCounter {
    uint256 public value;
    address public l1ContractProxy;  // The L1 contract's proxy on L2 (L1SenderProxyL2)
    address public l1Counter;        // The actual L1SyncedCounter address for outgoing calls

    event ValueSet(uint256 newValue, address setter);

    error L1CounterNotSet();
    error L1ContractProxyNotSet();
    error L1SyncFailed();

    /// @notice Set the L1 contract's proxy address on L2
    /// @dev This is the L1SenderProxyL2 that represents the L1 contract on L2
    ///      When L1 calls L2, msg.sender will be this proxy address
    function setL1ContractProxy(address _l1ContractProxy) external {
        l1ContractProxy = _l1ContractProxy;
    }

    /// @notice Set the L1 counter address for outgoing sync calls
    function setL1Counter(address _l1Counter) external {
        l1Counter = _l1Counter;
    }

    /// @notice Set value - syncs to L1 unless called BY L1's proxy
    /// @dev When called directly on L2, makes an outgoing call to L1
    ///      When called from L1 (via incoming call), msg.sender == l1ContractProxy, no sync needed
    ///      Reverts if sibling is not configured or sync fails
    function setValue(uint256 _value) external returns (uint256) {
        // If NOT called by L1 contract's proxy, we need to sync to L1
        if (msg.sender != l1ContractProxy) {
            if (l1Counter == address(0)) revert L1CounterNotSet();

            // Make outgoing call to L1 - this will be captured by the prover
            // and included in the OutgoingCall[] array
            (bool success,) = l1Counter.call(
                abi.encodeCall(L1SyncedCounter.setValue, (_value))
            );
            if (!success) revert L1SyncFailed();
        }

        // Only update state AFTER sync (or if called by L1)
        value = _value;
        emit ValueSet(_value, msg.sender);

        return _value;
    }
}
