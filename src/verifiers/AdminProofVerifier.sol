// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Call, IProofVerifier} from "../interfaces/IProofVerifier.sol";

/// @title AdminProofVerifier
/// @notice Simple admin-key proof verifier for POC
/// @dev In production, replace with ZK verifier or TEE attestation verifier
contract AdminProofVerifier is IProofVerifier {
    address public admin;
    address public owner;

    error OnlyOwner();

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    constructor(address _admin, address _owner) {
        admin = _admin;
        owner = _owner;
    }

    /// @notice Verify a proof by checking admin signature
    function verifyProof(
        bytes32 prevBlockHash,
        bytes calldata callData,
        bytes32 resultBlockHash,
        Call[] calldata outgoingCalls,
        bytes[] calldata expectedResults,
        bytes calldata proof
    ) external view override returns (bool) {
        bytes32 messageHash = keccak256(abi.encode(
            prevBlockHash,
            keccak256(callData),
            resultBlockHash,
            _hashCalls(outgoingCalls),
            _hashResults(expectedResults)
        ));

        bytes32 ethSignedMessageHash = keccak256(abi.encodePacked(
            "\x19Ethereum Signed Message:\n32",
            messageHash
        ));

        address signer = _recoverSigner(ethSignedMessageHash, proof);
        return signer == admin;
    }

    /// @notice Update admin address
    function setAdmin(address _newAdmin) external onlyOwner {
        admin = _newAdmin;
    }

    /// @notice Transfer ownership
    function transferOwnership(address _newOwner) external onlyOwner {
        owner = _newOwner;
    }

    function _hashCalls(Call[] calldata calls) internal pure returns (bytes32) {
        bytes memory encoded;
        for (uint256 i = 0; i < calls.length; i++) {
            encoded = abi.encodePacked(
                encoded,
                calls[i].from,
                calls[i].target,
                calls[i].value,
                calls[i].gas,
                keccak256(calls[i].data)
            );
        }
        return keccak256(encoded);
    }

    function _hashResults(bytes[] calldata results) internal pure returns (bytes32) {
        bytes memory encoded;
        for (uint256 i = 0; i < results.length; i++) {
            encoded = abi.encodePacked(encoded, keccak256(results[i]));
        }
        return keccak256(encoded);
    }

    function _recoverSigner(bytes32 hash, bytes calldata signature) internal pure returns (address) {
        if (signature.length != 65) return address(0);

        bytes32 r;
        bytes32 s;
        uint8 v;

        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }

        if (v < 27) v += 27;

        return ecrecover(hash, v, r, s);
    }
}
