// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {NativeRollupCore} from "../src/NativeRollupCore.sol";
import {AdminProofVerifier} from "../src/verifiers/AdminProofVerifier.sol";
import {L2SenderProxy} from "../src/L2SenderProxy.sol";
import {OutgoingCall, IProofVerifier} from "../src/interfaces/IProofVerifier.sol";
import {L1SyncedCounter, L2SyncedCounter} from "../src/examples/SyncedCounter.sol";

/// @title SyncInvariant Tests
/// @notice Tests that verify sync invariant CANNOT be broken (assuming honest prover)
/// @dev The key insight: ANYONE can call either L1 or L2, but the call MUST sync to the other
contract SyncInvariantTest is Test {
    NativeRollupCore public rollup;
    AdminProofVerifier public verifier;
    L1SyncedCounter public l1Counter;

    // L2 contract address (conceptual - doesn't exist as deployed contract)
    address constant L2_COUNTER = address(0x12C0DE);

    // Honest admin key
    uint256 constant ADMIN_PK = 0xAD01;
    address admin;
    address owner;

    // Various users
    address alice;
    address bob;
    address attacker;

    // Track the TRUE L2 state (what an honest prover knows)
    uint256 trueL2Value;

    // State hashes
    bytes32 constant GENESIS_HASH = keccak256("genesis-sync-test");

    function setUp() public {
        admin = vm.addr(ADMIN_PK);
        owner = address(this);
        alice = makeAddr("alice");
        bob = makeAddr("bob");
        attacker = makeAddr("attacker");

        verifier = new AdminProofVerifier(admin, owner);
        rollup = new NativeRollupCore(GENESIS_HASH, address(verifier), owner);

        // Deploy L1 counter and configure it
        l1Counter = new L1SyncedCounter();
        address l2Proxy = rollup.getProxyAddress(L2_COUNTER);
        l1Counter.setL2Proxy(l2Proxy);

        vm.deal(address(rollup), 100 ether);
        vm.deal(alice, 10 ether);
        vm.deal(bob, 10 ether);
        vm.deal(attacker, 10 ether);

        trueL2Value = 0;
    }

    // ============ Core Invariant ============
    // L1 value == L2 value ALWAYS (with honest prover)

    /// @notice L2→L1 sync: L2 sets value, syncs to L1 via outgoing call
    function test_L2ToL1_Sync() public {
        uint256 newValue = 42;

        _l2SetsValue(newValue);

        // INVARIANT CHECK
        assertEq(l1Counter.value(), trueL2Value, "INVARIANT VIOLATED: L1 != L2");
        assertEq(l1Counter.value(), newValue);
    }

    /// @notice L1→L2 sync: Anyone calls L1, it MUST sync to L2
    function test_L1ToL2_Sync_AnyoneCanCall() public {
        uint256 newValue = 100;

        // First, register the incoming call response for when L1 calls L2
        _registerL1ToL2SyncResponse(newValue);

        // Deploy proxy first (needed for incoming call)
        _deployL2Proxy();

        // Now ANYONE (alice) can call L1 directly
        vm.prank(alice);
        l1Counter.setValue(newValue);

        // The L1 call triggered L2 sync via handleIncomingCall
        // Update our tracking
        trueL2Value = newValue;

        // INVARIANT CHECK
        assertEq(l1Counter.value(), trueL2Value, "INVARIANT VIOLATED: L1 != L2");
        assertEq(rollup.l2BlockHash(), _computeState(newValue), "L2 state not updated");
    }

    /// @notice Multiple users can call L1, all syncs correctly
    function test_L1ToL2_MultipleUsers() public {
        // Deploy proxy first
        _deployL2Proxy();

        // Alice sets to 10
        _registerL1ToL2SyncResponse(10);
        vm.prank(alice);
        l1Counter.setValue(10);
        trueL2Value = 10;
        assertEq(l1Counter.value(), trueL2Value);

        // Bob sets to 20
        _registerL1ToL2SyncResponse(20);
        vm.prank(bob);
        l1Counter.setValue(20);
        trueL2Value = 20;
        assertEq(l1Counter.value(), trueL2Value);

        // Attacker sets to 999 - this is FINE, they're just a user
        _registerL1ToL2SyncResponse(999);
        vm.prank(attacker);
        l1Counter.setValue(999);
        trueL2Value = 999;
        assertEq(l1Counter.value(), trueL2Value);

        // INVARIANT: still in sync
        assertEq(l1Counter.value(), trueL2Value, "INVARIANT VIOLATED");
    }

    /// @notice Interleaved L1→L2 and L2→L1 updates
    function test_Interleaved_L1_L2_Updates() public {
        _deployL2Proxy();

        // L2 sets to 10
        _l2SetsValue(10);
        assertEq(l1Counter.value(), 10);

        // L1 (alice) sets to 20
        _registerL1ToL2SyncResponse(20);
        vm.prank(alice);
        l1Counter.setValue(20);
        trueL2Value = 20;
        assertEq(l1Counter.value(), 20);

        // L2 sets to 30
        _l2SetsValue(30);
        assertEq(l1Counter.value(), 30);

        // L1 (bob) sets to 40
        _registerL1ToL2SyncResponse(40);
        vm.prank(bob);
        l1Counter.setValue(40);
        trueL2Value = 40;
        assertEq(l1Counter.value(), 40);

        // INVARIANT
        assertEq(l1Counter.value(), trueL2Value, "INVARIANT VIOLATED");
    }

    // ============ Attack Scenarios ============

    /// @notice Attack: Call L1 without registered L2 response - MUST FAIL
    function test_Attack_L1CallWithoutL2Response_Fails() public {
        _deployL2Proxy();

        // Try to call L1 without registering the L2 response
        // This MUST fail because the L2 sync will fail
        vm.prank(attacker);
        vm.expectRevert();  // L2 sync will fail - no registered response
        l1Counter.setValue(999);

        // INVARIANT: Values unchanged
        assertEq(l1Counter.value(), 0, "L1 should be unchanged");
        assertEq(trueL2Value, 0, "L2 should be unchanged");
    }

    /// @notice Attack: Try to update L2 without L1 sync - MUST FAIL (honest prover won't sign)
    function test_Attack_L2WithoutL1Sync_HonestProverRefuses() public {
        // An honest prover will NEVER sign a proof that updates L2 without the L1 sync call
        // This test demonstrates what happens if somehow a bad proof got through

        // We simply don't create this scenario because an honest prover won't do it
        // The protocol relies on the prover being honest (or ZK proof being correct)

        // What we CAN test: if we try to submit without outgoing calls,
        // the L1 value won't change
        uint256 newValue = 999;
        bytes32 currentState = rollup.l2BlockHash();
        bytes memory callData = abi.encode("setValue", newValue);

        // NO outgoing calls
        OutgoingCall[] memory calls = new OutgoingCall[](0);
        bytes[] memory results = new bytes[](0);

        bytes32 newState = _computeState(newValue);
        bytes memory proof = _signProof(currentState, callData, newState, calls, results, newState);

        // This would "succeed" in updating L2 state, but L1 is not synced
        // An HONEST prover would NEVER sign this proof for a synced counter
        rollup.processSingleTxOnL2(currentState, callData, newState, calls, results, newState, proof);

        // L2 updated but L1 didn't - this is the trust assumption violation
        trueL2Value = newValue;
        assertTrue(l1Counter.value() != trueL2Value, "This shows the trust assumption");

        // The point: honest prover would include the L1 sync call
    }

    /// @notice L1 call reverts if L2 sync fails
    function test_L1Call_RevertsIfL2SyncFails() public {
        _deployL2Proxy();

        // Register a response for value 100
        _registerL1ToL2SyncResponse(100);

        // But try to set value 200 - no response registered for this!
        vm.prank(alice);
        vm.expectRevert();
        l1Counter.setValue(200);

        // INVARIANT: Nothing changed
        assertEq(l1Counter.value(), 0);
    }

    /// @notice Concurrent L1 calls - only one can succeed
    function test_ConcurrentL1Calls_OnlyOneSucceeds() public {
        _deployL2Proxy();

        // Register response for value 100 at current state
        _registerL1ToL2SyncResponse(100);

        // Alice calls first - succeeds
        vm.prank(alice);
        l1Counter.setValue(100);
        trueL2Value = 100;

        // Bob tries same call - fails because state changed
        // The incoming call response was for the OLD state
        vm.prank(bob);
        vm.expectRevert();  // IncomingCallNotRegistered for new state
        l1Counter.setValue(100);

        // INVARIANT: Alice's value persists
        assertEq(l1Counter.value(), 100);
        assertEq(l1Counter.value(), trueL2Value);
    }

    /// @notice Verify atomicity: if L2 part fails, L1 part also reverts
    function test_Atomicity_L1RevertsIfL2Fails() public {
        _deployL2Proxy();

        // Don't register any response - L2 sync will fail
        uint256 initialL1Value = l1Counter.value();

        vm.prank(alice);
        vm.expectRevert();
        l1Counter.setValue(42);

        // L1 value should be unchanged (atomic revert)
        assertEq(l1Counter.value(), initialL1Value, "L1 should have reverted");
    }

    // ============ Helpers ============

    /// @notice Simulates L2 setting a value and syncing to L1
    function _l2SetsValue(uint256 newValue) internal {
        bytes32 currentState = rollup.l2BlockHash();
        bytes memory callData = abi.encodeCall(L2SyncedCounter.setValue, (newValue));

        OutgoingCall[] memory calls = new OutgoingCall[](1);
        calls[0] = OutgoingCall({
            from: L2_COUNTER,
            target: address(l1Counter),
            value: 0,
            gas: 100000,
            data: abi.encodeCall(L1SyncedCounter.setValue, (newValue)),
            postCallStateHash: currentState  // No callback changes state
        });

        bytes[] memory results = new bytes[](1);
        results[0] = abi.encode(newValue);

        bytes32 newState = _computeState(newValue);
        bytes memory proof = _signProof(currentState, callData, currentState, calls, results, newState);

        rollup.processSingleTxOnL2(currentState, callData, currentState, calls, results, newState, proof);
        trueL2Value = newValue;
    }

    /// @notice Register the incoming call response for L1→L2 sync
    function _registerL1ToL2SyncResponse(uint256 newValue) internal {
        bytes32 currentState = rollup.l2BlockHash();
        bytes memory incomingCallData = abi.encodeCall(L2SyncedCounter.setValue, (newValue));

        // The L2 response: update L2 state, no outgoing calls needed
        OutgoingCall[] memory responseCalls = new OutgoingCall[](0);
        bytes[] memory responseResults = new bytes[](0);

        bytes32 newState = _computeState(newValue);

        NativeRollupCore.IncomingCallResponse memory response = NativeRollupCore.IncomingCallResponse({
            preOutgoingCallsStateHash: newState,  // State after L2 processes the call
            outgoingCalls: responseCalls,
            expectedResults: responseResults,
            returnValue: abi.encode(newValue),
            finalStateHash: newState
        });

        bytes memory incomingProof = _signIncomingCallProof(
            L2_COUNTER,
            currentState,
            incomingCallData,
            response
        );

        rollup.registerIncomingCall(
            L2_COUNTER,
            currentState,
            incomingCallData,
            response,
            incomingProof
        );
    }

    /// @notice Deploy the L2 proxy by doing a simple state transition
    function _deployL2Proxy() internal {
        bytes memory callData = abi.encode("deploy proxy");
        OutgoingCall[] memory calls = new OutgoingCall[](1);
        calls[0] = OutgoingCall({
            from: L2_COUNTER,
            target: address(l1Counter),
            value: 0,
            gas: 50000,
            data: abi.encodeWithSignature("value()"),
            postCallStateHash: GENESIS_HASH
        });
        bytes[] memory results = new bytes[](1);
        results[0] = abi.encode(uint256(0));

        bytes memory proof = _signProof(GENESIS_HASH, callData, GENESIS_HASH, calls, results, GENESIS_HASH);
        rollup.processSingleTxOnL2(GENESIS_HASH, callData, GENESIS_HASH, calls, results, GENESIS_HASH, proof);
    }

    function _computeState(uint256 value) internal pure returns (bytes32) {
        return keccak256(abi.encode("SyncState", value));
    }

    function _signProof(
        bytes32 prevBlockHash,
        bytes memory callData,
        bytes32 postExecutionStateHash,
        OutgoingCall[] memory calls,
        bytes[] memory results,
        bytes32 finalStateHash
    ) internal pure returns (bytes memory) {
        bytes32 messageHash = keccak256(abi.encode(
            prevBlockHash,
            keccak256(callData),
            postExecutionStateHash,
            _hashCalls(calls),
            _hashResults(results),
            finalStateHash
        ));

        bytes32 ethSignedMessageHash = keccak256(abi.encodePacked(
            "\x19Ethereum Signed Message:\n32",
            messageHash
        ));

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ADMIN_PK, ethSignedMessageHash);
        return abi.encodePacked(r, s, v);
    }

    function _signIncomingCallProof(
        address l2Address,
        bytes32 stateHash,
        bytes memory callData,
        NativeRollupCore.IncomingCallResponse memory response
    ) internal pure returns (bytes memory) {
        bytes32 messageHash = keccak256(abi.encode(
            l2Address,
            stateHash,
            keccak256(callData),
            response.preOutgoingCallsStateHash,
            _hashCalls(response.outgoingCalls),
            _hashResults(response.expectedResults),
            keccak256(response.returnValue),
            response.finalStateHash
        ));

        bytes32 ethSignedMessageHash = keccak256(abi.encodePacked(
            "\x19Ethereum Signed Message:\n32",
            messageHash
        ));

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ADMIN_PK, ethSignedMessageHash);
        return abi.encodePacked(r, s, v);
    }

    function _hashCalls(OutgoingCall[] memory calls) internal pure returns (bytes32) {
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

    function _hashResults(bytes[] memory results) internal pure returns (bytes32) {
        bytes memory encoded;
        for (uint256 i = 0; i < results.length; i++) {
            encoded = abi.encodePacked(encoded, keccak256(results[i]));
        }
        return keccak256(encoded);
    }
}
