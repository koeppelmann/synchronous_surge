// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title L1SyncedCounter
/// @notice L1 contract that stays in sync with its L2 counterpart
/// @dev Anyone can call setValue. If caller is NOT the L2 proxy, it syncs to L2.
contract L1SyncedCounter {
    uint256 public value;
    address public l2Proxy;

    event ValueSet(uint256 newValue, address setter);

    error L2ProxyNotSet();
    error L2SyncFailed();

    function setL2Proxy(address _l2Proxy) external {
        l2Proxy = _l2Proxy;
    }

    /// @notice Set value - syncs to L2 unless called BY L2
    function setValue(uint256 _value) external returns (uint256) {
        if (l2Proxy == address(0)) revert L2ProxyNotSet();

        value = _value;
        emit ValueSet(_value, msg.sender);

        // If called by L2 proxy, no sync needed (it's already coming from L2)
        // Otherwise, sync to L2
        if (msg.sender != l2Proxy) {
            (bool success,) = l2Proxy.call(
                abi.encodeCall(L2SyncedCounter.setValue, (_value))
            );
            if (!success) revert L2SyncFailed();
        }

        return _value;
    }
}

/// @title L2SyncedCounter
/// @notice L2 contract that stays in sync with its L1 counterpart
/// @dev Anyone can call setValue. If caller is NOT the L1 contract, it syncs to L1.
contract L2SyncedCounter {
    uint256 public value;
    address public l1Contract;

    event ValueSet(uint256 newValue, address setter);

    function setL1Contract(address _l1Contract) external {
        l1Contract = _l1Contract;
    }

    /// @notice Set value - syncs to L1 unless called BY L1
    /// @dev When called directly on L2, the outgoing call to L1 is in OutgoingCall[]
    ///      When called from L1 (via incoming call), msg.sender == l1Contract, no sync needed
    function setValue(uint256 _value) external returns (uint256) {
        value = _value;
        emit ValueSet(_value, msg.sender);

        // If called by L1 contract, no sync needed (it's already coming from L1)
        // Otherwise, the L2 execution should include an outgoing call to L1
        // (handled by the prover including it in OutgoingCall[])

        return _value;
    }
}
