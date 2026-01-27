// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title L2SenderProxy
/// @notice Minimal proxy that executes calls on behalf of an L2 address
/// @dev Deployed via CREATE2 with deterministic address based on L2 address
///
/// IMPORTANT: If ETH is sent to the proxy address BEFORE deployment (when it's still an EOA),
/// that ETH will be held by the proxy once deployed. The original sender can call
/// refundPreDeploymentFunds() to get it back.
contract L2SenderProxy {
    /// @notice The NativeRollupCore contract that controls this proxy
    address public immutable nativeRollup;

    /// @notice The L2 address this proxy represents
    address public immutable l2Address;

    /// @notice Balance at deployment time (funds sent before proxy existed)
    uint256 public immutable preDeploymentBalance;

    /// @notice Amount of pre-deployment funds that have been refunded
    uint256 public refundedAmount;

    error OnlyNativeRollup();
    error RefundFailed();
    error NoFundsToRefund();

    constructor(address _nativeRollup, address _l2Address) {
        nativeRollup = _nativeRollup;
        l2Address = _l2Address;
        // Record any ETH that was sent to this address before deployment
        preDeploymentBalance = address(this).balance;
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

    /// @notice Refund ETH that was sent to this address before the proxy was deployed
    /// @dev Anyone can call this - the funds are sent to the caller
    ///      This is safe because pre-deployment funds were never "registered" and
    ///      cannot be processed as legitimate L1→L2 transfers
    /// @param to Address to send the refund to
    function refundPreDeploymentFunds(address payable to) external {
        uint256 availableRefund = preDeploymentBalance - refundedAmount;
        if (availableRefund == 0) revert NoFundsToRefund();

        refundedAmount = preDeploymentBalance; // Prevent reentrancy

        (bool success, ) = to.call{value: availableRefund}("");
        if (!success) revert RefundFailed();
    }

    /// @notice Handle ETH transfers (no calldata)
    /// @dev Forwards to handleIncomingCall which will revert if not pre-registered
    receive() external payable {
        // Forward the ETH transfer to NativeRollupCore
        // This will revert with IncomingCallNotRegistered if not pre-announced
        INativeRollupCore(nativeRollup).handleIncomingCall{value: msg.value}(l2Address, "");
    }

    /// @notice Handle incoming calls to this L2 address
    /// @dev Forwards the call (and value) to NativeRollupCore.handleIncomingCall()
    ///      Will revert with IncomingCallNotRegistered if the call wasn't pre-announced
    /// @return The pre-registered return value
    fallback(bytes calldata) external payable returns (bytes memory) {
        // Forward the incoming call and value to NativeRollupCore
        // This will revert with IncomingCallNotRegistered if not pre-announced
        return INativeRollupCore(nativeRollup).handleIncomingCall{value: msg.value}(l2Address, msg.data);
    }
}

/// @notice Interface for NativeRollupCore incoming call handling
interface INativeRollupCore {
    function handleIncomingCall(
        address l2Address,
        bytes calldata callData
    ) external payable returns (bytes memory);
}
