// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title L2SenderProxy
/// @notice Minimal proxy that executes calls on behalf of an L2 address
/// @dev Deployed via CREATE2 with deterministic address based on L2 address
contract L2SenderProxy {
    /// @notice The NativeRollupCore contract that controls this proxy
    address public immutable nativeRollup;

    /// @notice The L2 address this proxy represents
    address public immutable l2Address;

    error OnlyNativeRollup();

    constructor(address _nativeRollup, address _l2Address) {
        nativeRollup = _nativeRollup;
        l2Address = _l2Address;
    }

    /// @notice Execute a call on behalf of the L2 address
    /// @dev Only callable by NativeRollupCore
    /// @param target The L1 contract to call
    /// @param data The calldata
    /// @return success Whether the call succeeded
    /// @return result The return data
    function execute(
        address target,
        bytes calldata data
    ) external payable returns (bool success, bytes memory result) {
        if (msg.sender != nativeRollup) revert OnlyNativeRollup();

        (success, result) = target.call{value: msg.value}(data);
    }

    /// @notice Allow receiving ETH
    receive() external payable {}

    /// @notice Handle incoming calls to this L2 address
    /// @dev Forwards the call to NativeRollupCore.handleIncomingCall()
    /// @return The pre-registered return value
    fallback(bytes calldata) external payable returns (bytes memory) {
        // Forward the incoming call to NativeRollupCore
        return INativeRollupCore(nativeRollup).handleIncomingCall(l2Address, msg.data);
    }
}

/// @notice Interface for NativeRollupCore incoming call handling
interface INativeRollupCore {
    function handleIncomingCall(
        address l2Address,
        bytes calldata callData
    ) external returns (bytes memory);
}
