// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {NativeRollupCore} from "../src/NativeRollupCore.sol";
import {
    CommittedIncomingCallLoader
} from "../src/CommittedIncomingCallLoader.sol";
import {AdminProofVerifier} from "../src/verifiers/AdminProofVerifier.sol";
import {OutgoingCall} from "../src/interfaces/IProofVerifier.sol";

/// @title StaleCleanupAndCommitRevealTest
/// @notice Tests for stale incoming call cleanup and commit-reveal MEV protection
/// @dev These patterns are direction-agnostic: they apply identically to
///      L2→L1 execution buffers (sync-rollups) and L1→L2 response buffers (synchronous_surge).
contract StaleCleanupAndCommitRevealTest is Test {
    NativeRollupCore public rollup;
    CommittedIncomingCallLoader public loader;
    AdminProofVerifier public verifier;

    uint256 constant ADMIN_PK =
        0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef;
    address admin;
    address owner;
    address bob;

    address constant L2_CONTRACT = address(0xC0DE);

    bytes32 constant GENESIS_HASH = keccak256("genesis");
    bytes32 constant STATE_1 = keccak256("state1");

    function setUp() public {
        admin = vm.addr(ADMIN_PK);
        owner = address(this);
        bob = makeAddr("bob");

        verifier = new AdminProofVerifier(admin, owner);
        rollup = new NativeRollupCore(GENESIS_HASH, address(verifier), owner);
        loader = new CommittedIncomingCallLoader(address(rollup));

        vm.deal(address(rollup), 100 ether);
    }

    /*//////////////////////////////////////////////////////////////
                           HELPERS
    //////////////////////////////////////////////////////////////*/

    function _createSimpleResponse()
        internal
        pure
        returns (NativeRollupCore.IncomingCallResponse memory)
    {
        OutgoingCall[] memory calls = new OutgoingCall[](0);
        bytes[] memory results = new bytes[](0);
        return
            NativeRollupCore.IncomingCallResponse({
                preOutgoingCallsStateHash: STATE_1,
                outgoingCalls: calls,
                expectedResults: results,
                returnValue: abi.encode(42),
                finalStateHash: STATE_1
            });
    }

    function _signIncomingCallProof(
        address l2Address,
        bytes32 stateHash,
        bytes memory callData,
        NativeRollupCore.IncomingCallResponse memory response
    ) internal pure returns (bytes memory) {
        bytes32 messageHash = keccak256(
            abi.encode(
                l2Address,
                stateHash,
                keccak256(callData),
                response.preOutgoingCallsStateHash,
                _hashCalls(response.outgoingCalls),
                _hashResults(response.expectedResults),
                keccak256(response.returnValue),
                response.finalStateHash
            )
        );
        bytes32 ethSignedMessageHash = keccak256(
            abi.encodePacked("\x19Ethereum Signed Message:\n32", messageHash)
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            ADMIN_PK,
            ethSignedMessageHash
        );
        return abi.encodePacked(r, s, v);
    }

    function _hashCalls(
        OutgoingCall[] memory calls
    ) internal pure returns (bytes32) {
        bytes memory encoded;
        for (uint256 i = 0; i < calls.length; i++) {
            encoded = abi.encodePacked(
                encoded,
                calls[i].from,
                calls[i].target,
                calls[i].value,
                calls[i].gas,
                keccak256(calls[i].data),
                calls[i].postCallStateHash
            );
        }
        return keccak256(encoded);
    }

    function _hashResults(
        bytes[] memory results
    ) internal pure returns (bytes32) {
        bytes memory encoded;
        for (uint256 i = 0; i < results.length; i++) {
            encoded = abi.encodePacked(encoded, keccak256(results[i]));
        }
        return keccak256(encoded);
    }

    function _registerResponse() internal returns (bytes32 responseKey) {
        NativeRollupCore.IncomingCallResponse
            memory response = _createSimpleResponse();
        bytes memory callData = abi.encode("test call");
        bytes memory proof = _signIncomingCallProof(
            L2_CONTRACT,
            GENESIS_HASH,
            callData,
            response
        );

        rollup.registerIncomingCall(
            L2_CONTRACT,
            GENESIS_HASH,
            callData,
            response,
            proof
        );

        responseKey = rollup.getResponseKey(
            L2_CONTRACT,
            GENESIS_HASH,
            callData
        );
    }

    /*//////////////////////////////////////////////////////////////
                    STALE CLEANUP TESTS
    //////////////////////////////////////////////////////////////*/

    /// @notice Block is tracked when response is registered
    function test_RegistrationBlockTracked() public {
        vm.roll(100);
        bytes32 key = _registerResponse();
        assertEq(rollup.incomingCallRegisteredBlock(key), 100);
    }

    /// @notice Stale response is cleaned up after expiry
    function test_CleanupRemovesStaleResponse() public {
        bytes32 key = _registerResponse();
        assertTrue(rollup.incomingCallRegistered(key));

        vm.roll(block.number + 257);

        vm.prank(bob);
        rollup.cleanupStaleIncomingCall(key, 0);

        assertFalse(rollup.incomingCallRegistered(key));
    }

    /// @notice Cleanup emits StaleIncomingCallCleaned event
    function test_CleanupEmitsEvent() public {
        bytes32 key = _registerResponse();
        vm.roll(block.number + 257);

        vm.expectEmit(true, false, false, false);
        emit NativeRollupCore.StaleIncomingCallCleaned(key);
        rollup.cleanupStaleIncomingCall(key, 0);
    }

    /// @notice Cleanup reverts when response is not expired
    function test_CleanupRevertsIfNotExpired() public {
        bytes32 key = _registerResponse();
        vm.roll(block.number + 100); // only 100, need 256

        vm.expectRevert(NativeRollupCore.NotStale.selector);
        rollup.cleanupStaleIncomingCall(key, 0);
    }

    /// @notice Cleanup reverts on nonexistent key
    function test_CleanupRevertsOnNonexistentKey() public {
        bytes32 fakeKey = keccak256("fake");

        vm.expectRevert(NativeRollupCore.NotStale.selector);
        rollup.cleanupStaleIncomingCall(fakeKey, 0);
    }

    /// @notice Custom maxAge works
    function test_CleanupWithCustomMaxAge() public {
        bytes32 key = _registerResponse();
        vm.roll(block.number + 11);

        rollup.cleanupStaleIncomingCall(key, 10);
        assertFalse(rollup.incomingCallRegistered(key));
    }

    /// @notice Cleanup is permissionless
    function test_CleanupIsPermissionless() public {
        bytes32 key = _registerResponse();
        vm.roll(block.number + 257);

        address randomBot = makeAddr("cleanup_bot");
        vm.prank(randomBot);
        rollup.cleanupStaleIncomingCall(key, 0);

        assertFalse(rollup.incomingCallRegistered(key));
    }

    /*//////////////////////////////////////////////////////////////
                    COMMIT-REVEAL TESTS
    //////////////////////////////////////////////////////////////*/

    /// @notice Full commit-reveal lifecycle works
    function test_CommitRevealLifecycle() public {
        NativeRollupCore.IncomingCallResponse
            memory response = _createSimpleResponse();
        bytes memory callData = abi.encode("test call");
        bytes memory proof = _signIncomingCallProof(
            L2_CONTRACT,
            GENESIS_HASH,
            callData,
            response
        );
        bytes32 secret = keccak256("my_secret");

        // Compute commitment
        bytes32 commitHash = loader.makeCommitment(
            L2_CONTRACT,
            GENESIS_HASH,
            callData,
            response,
            proof,
            secret
        );

        // Commit
        loader.commit(commitHash);
        assertEq(loader.commitments(commitHash), block.number);

        // Advance past MIN_COMMITMENT_AGE
        vm.roll(block.number + 2);

        // Reveal
        loader.revealAndRegister(
            L2_CONTRACT,
            GENESIS_HASH,
            callData,
            response,
            proof,
            secret
        );

        // Verify registration happened
        bytes32 responseKey = rollup.getResponseKey(
            L2_CONTRACT,
            GENESIS_HASH,
            callData
        );
        assertTrue(rollup.incomingCallRegistered(responseKey));
    }

    /// @notice Reveal too early reverts
    function test_RevealTooEarlyReverts() public {
        NativeRollupCore.IncomingCallResponse
            memory response = _createSimpleResponse();
        bytes memory callData = abi.encode("test call");
        bytes memory proof = _signIncomingCallProof(
            L2_CONTRACT,
            GENESIS_HASH,
            callData,
            response
        );
        bytes32 secret = keccak256("my_secret");

        bytes32 commitHash = loader.makeCommitment(
            L2_CONTRACT,
            GENESIS_HASH,
            callData,
            response,
            proof,
            secret
        );
        loader.commit(commitHash);

        // Same block — too early
        vm.expectRevert(CommittedIncomingCallLoader.CommitmentTooNew.selector);
        loader.revealAndRegister(
            L2_CONTRACT,
            GENESIS_HASH,
            callData,
            response,
            proof,
            secret
        );
    }

    /// @notice Reveal too late (expired) reverts
    function test_RevealExpiredReverts() public {
        NativeRollupCore.IncomingCallResponse
            memory response = _createSimpleResponse();
        bytes memory callData = abi.encode("test call");
        bytes memory proof = _signIncomingCallProof(
            L2_CONTRACT,
            GENESIS_HASH,
            callData,
            response
        );
        bytes32 secret = keccak256("my_secret");

        bytes32 commitHash = loader.makeCommitment(
            L2_CONTRACT,
            GENESIS_HASH,
            callData,
            response,
            proof,
            secret
        );
        loader.commit(commitHash);

        // Way past MAX_COMMITMENT_AGE
        vm.roll(block.number + 300);

        vm.expectRevert(CommittedIncomingCallLoader.CommitmentExpired.selector);
        loader.revealAndRegister(
            L2_CONTRACT,
            GENESIS_HASH,
            callData,
            response,
            proof,
            secret
        );
    }

    /// @notice Wrong secret reverts
    function test_WrongSecretReverts() public {
        NativeRollupCore.IncomingCallResponse
            memory response = _createSimpleResponse();
        bytes memory callData = abi.encode("test call");
        bytes memory proof = _signIncomingCallProof(
            L2_CONTRACT,
            GENESIS_HASH,
            callData,
            response
        );

        bytes32 commitHash = loader.makeCommitment(
            L2_CONTRACT,
            GENESIS_HASH,
            callData,
            response,
            proof,
            keccak256("correct")
        );
        loader.commit(commitHash);
        vm.roll(block.number + 2);

        vm.expectRevert(
            CommittedIncomingCallLoader.CommitmentNotFound.selector
        );
        loader.revealAndRegister(
            L2_CONTRACT,
            GENESIS_HASH,
            callData,
            response,
            proof,
            keccak256("wrong")
        );
    }

    /// @notice Commitment is consumed (no replay)
    function test_CommitmentConsumedAfterReveal() public {
        NativeRollupCore.IncomingCallResponse
            memory response = _createSimpleResponse();
        bytes memory callData = abi.encode("test call");
        bytes memory proof = _signIncomingCallProof(
            L2_CONTRACT,
            GENESIS_HASH,
            callData,
            response
        );
        bytes32 secret = keccak256("s");

        bytes32 commitHash = loader.makeCommitment(
            L2_CONTRACT,
            GENESIS_HASH,
            callData,
            response,
            proof,
            secret
        );
        loader.commit(commitHash);
        vm.roll(block.number + 2);

        loader.revealAndRegister(
            L2_CONTRACT,
            GENESIS_HASH,
            callData,
            response,
            proof,
            secret
        );

        // Commitment should be consumed
        assertEq(loader.commitments(commitHash), 0);
    }
}
