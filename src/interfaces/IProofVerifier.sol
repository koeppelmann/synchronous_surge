// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Represents an outgoing L1 call triggered by L2 execution
struct Call {
    address from;    // L2 contract address initiating the call
    address target;  // L1 contract to call
    uint256 value;   // ETH value to send
    uint256 gas;     // Gas limit for the call
    bytes data;      // Calldata
}

/// @notice Interface for proof verification
interface IProofVerifier {
    function verifyProof(
        bytes32 prevBlockHash,
        bytes calldata callData,
        bytes32 resultBlockHash,
        Call[] calldata outgoingCalls,
        bytes[] calldata expectedResults,
        bytes calldata proof
    ) external view returns (bool);
}
