// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Represents an outgoing L1 call triggered by L2 execution
/// @dev Each call includes its expected post-call L2 state hash for synchronous composability
struct OutgoingCall {
    address from;              // L2 contract address initiating the call
    address target;            // L1 contract to call
    uint256 value;             // ETH value to send
    uint256 gas;               // Gas limit for the call
    bytes data;                // Calldata
    bytes32 postCallStateHash; // Expected L2 state hash AFTER this call completes
}

/// @notice Interface for proof verification
/// @dev Proof must cover entire state transition chain:
///      prevBlockHash → preOutgoingCallsStateHash → call[0].postCallStateHash → ... → finalStateHash
interface IProofVerifier {
    function verifyProof(
        bytes32 prevBlockHash,
        bytes calldata rlpEncodedTx,
        bytes32 preOutgoingCallsStateHash,
        OutgoingCall[] calldata outgoingCalls,
        bytes[] calldata expectedResults,
        bytes32 finalStateHash,
        bytes calldata proof
    ) external view returns (bool);
}
