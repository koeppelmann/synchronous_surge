// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {NativeRollupCore} from "../src/NativeRollupCore.sol";
import {AdminProofVerifier} from "../src/verifiers/AdminProofVerifier.sol";
import {L2SenderProxy} from "../src/L2SenderProxy.sol";
import {OutgoingCall, IProofVerifier} from "../src/interfaces/IProofVerifier.sol";
import {L1SyncedCounter, L2SyncedCounter} from "../src/examples/SyncedCounter.sol";

/// @title SyncedCounter Tests
/// @notice Tests that try to break the sync invariant between L1 and L2 counters
/// @dev The invariant: L1 counter value == L2 counter value (conceptually)
contract SyncedCounterTest is Test {
    NativeRollupCore public rollup;
    AdminProofVerifier public verifier;
    L1SyncedCounter public l1Counter;

    // L2 contract address (arbitrary - represents the L2 contract)
    address constant L2_COUNTER_ADDRESS = address(0x1234567890123456789012345678901234567890);

    // Test accounts
    uint256 constant ADMIN_PK = 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef;
    address admin;
    address owner;
    address attacker;

    // State hashes
    bytes32 constant GENESIS_HASH = keccak256("genesis");

    // Track L2 state conceptually (in real system this would be merkle root)
    uint256 l2CounterValue;

    function setUp() public {
        admin = vm.addr(ADMIN_PK);
        owner = address(this);
        attacker = makeAddr("attacker");

        // Deploy rollup infrastructure
        verifier = new AdminProofVerifier(admin, owner);
        rollup = new NativeRollupCore(GENESIS_HASH, address(verifier), owner);

        // Deploy L1 counter
        l1Counter = new L1SyncedCounter();

        // Get the L2 proxy address and configure L1 counter
        address l2Proxy = rollup.getProxyAddress(L2_COUNTER_ADDRESS);
        l1Counter.setL2Proxy(l2Proxy);

        // Fund rollup for outgoing calls
        vm.deal(address(rollup), 100 ether);

        // Initialize L2 counter value
        l2CounterValue = 0;
    }

    // ============ Helper to compute state hash ============

    function _computeL2StateHash(uint256 counterValue) internal pure returns (bytes32) {
        return keccak256(abi.encode("L2State", counterValue));
    }

    // ============ L2 → L1 Sync Tests ============

    /// @notice Test: L2 sets value, syncs to L1 via outgoing call
    function test_L2ToL1Sync_HappyPath() public {
        uint256 newValue = 42;

        // L2 execution: setValue(42) on L2 counter
        // The outgoing call syncs to L1 by calling L1's setValue
        // Since msg.sender will be the L2 proxy, L1 won't try to sync back
        bytes memory callData = abi.encodeCall(L2SyncedCounter.setValue, (newValue));

        OutgoingCall[] memory calls = new OutgoingCall[](1);
        calls[0] = OutgoingCall({
            from: L2_COUNTER_ADDRESS,
            target: address(l1Counter),
            value: 0,
            gas: 100000,
            data: abi.encodeCall(L1SyncedCounter.setValue, (newValue)),
            postCallStateHash: _computeL2StateHash(newValue)
        });

        bytes[] memory results = new bytes[](1);
        results[0] = abi.encode(newValue);

        bytes32 postExecState = _computeL2StateHash(newValue);
        bytes32 finalState = _computeL2StateHash(newValue);

        bytes memory proof = _signProof(GENESIS_HASH, callData, postExecState, calls, results, finalState);

        rollup.processSingleTxOnL2(GENESIS_HASH, callData, postExecState, calls, results, finalState, proof);

        // Verify sync: L1 counter should have the new value
        assertEq(l1Counter.value(), newValue, "L1 counter not synced");
        l2CounterValue = newValue;
        assertEq(l1Counter.value(), l2CounterValue, "Values out of sync");
    }

    /// @notice Test: Multiple sequential updates stay in sync
    function test_L2ToL1Sync_MultipleUpdates() public {
        bytes32 currentState = GENESIS_HASH;

        for (uint256 i = 1; i <= 5; i++) {
            bytes memory callData = abi.encodeCall(L2SyncedCounter.setValue, (i * 10));

            OutgoingCall[] memory calls = new OutgoingCall[](1);
            calls[0] = OutgoingCall({
                from: L2_COUNTER_ADDRESS,
                target: address(l1Counter),
                value: 0,
                gas: 100000,
                data: abi.encodeCall(L1SyncedCounter.setValue, (i * 10)),
                postCallStateHash: _computeL2StateHash(i * 10)
            });

            bytes[] memory results = new bytes[](1);
            results[0] = abi.encode(i * 10);

            bytes32 postExecState = _computeL2StateHash(i * 10);
            bytes32 finalState = _computeL2StateHash(i * 10);

            bytes memory proof = _signProof(currentState, callData, postExecState, calls, results, finalState);

            rollup.processSingleTxOnL2(currentState, callData, postExecState, calls, results, finalState, proof);

            currentState = finalState;
            l2CounterValue = i * 10;

            assertEq(l1Counter.value(), l2CounterValue, "Values out of sync after update");
        }

        assertEq(l1Counter.value(), 50, "Final value incorrect");
    }

    // ============ Attack Scenarios ============

    /// @notice Attack: Try to update L2 without updating L1
    /// @dev The attacker omits the outgoing call to L1
    function test_Attack_UpdateL2WithoutL1() public {
        uint256 newValue = 777;

        // Attacker submits L2 state change but no outgoing call to sync L1
        bytes memory callData = abi.encodeCall(L2SyncedCounter.setValue, (newValue));

        // NO outgoing calls - L1 won't be updated
        OutgoingCall[] memory calls = new OutgoingCall[](0);
        bytes[] memory results = new bytes[](0);

        bytes32 postExecState = _computeL2StateHash(newValue);
        bytes32 finalState = _computeL2StateHash(newValue);

        bytes memory proof = _signProof(GENESIS_HASH, callData, postExecState, calls, results, finalState);

        // This succeeds but leaves values out of sync!
        // The admin should NEVER sign such a proof for synced contracts
        rollup.processSingleTxOnL2(GENESIS_HASH, callData, postExecState, calls, results, finalState, proof);

        // Values are now out of sync - this is the vulnerability if admin signs bad proofs
        l2CounterValue = newValue;
        assertEq(l1Counter.value(), 0, "L1 should not have changed");
        assertTrue(l1Counter.value() != l2CounterValue, "Values should be out of sync (trust assumption)");
    }

    /// @notice Attack: Direct L1 call without sync - MUST FAIL
    /// @dev If someone calls L1 directly, it tries to sync to L2, which fails without registered response
    function test_Attack_DirectL1Call_FailsWithoutResponse() public {
        // Deploy proxy first
        _deployProxyForL2Counter();

        // Attacker tries to directly call L1 setValue
        // This will try to sync to L2, but there's no registered response
        vm.prank(attacker);
        vm.expectRevert();  // L2 sync fails - no registered response
        l1Counter.setValue(999);

        // Value should be unchanged
        assertEq(l1Counter.value(), 0, "Value should be unchanged");
    }

    /// @notice Attack: Try to replay an old sync message
    function test_Attack_ReplayOldSync() public {
        // First, do a legitimate sync to value 50
        bytes memory callData1 = abi.encodeCall(L2SyncedCounter.setValue, (50));
        OutgoingCall[] memory calls1 = new OutgoingCall[](1);
        calls1[0] = OutgoingCall({
            from: L2_COUNTER_ADDRESS,
            target: address(l1Counter),
            value: 0,
            gas: 100000,
            data: abi.encodeCall(L1SyncedCounter.setValue, (50)),
            postCallStateHash: _computeL2StateHash(50)
        });
        bytes[] memory results1 = new bytes[](1);
        results1[0] = abi.encode(uint256(50));
        bytes32 state1 = _computeL2StateHash(50);
        bytes memory proof1 = _signProof(GENESIS_HASH, callData1, state1, calls1, results1, state1);
        rollup.processSingleTxOnL2(GENESIS_HASH, callData1, state1, calls1, results1, state1, proof1);

        // Then sync to value 100
        bytes memory callData2 = abi.encodeCall(L2SyncedCounter.setValue, (100));
        OutgoingCall[] memory calls2 = new OutgoingCall[](1);
        calls2[0] = OutgoingCall({
            from: L2_COUNTER_ADDRESS,
            target: address(l1Counter),
            value: 0,
            gas: 100000,
            data: abi.encodeCall(L1SyncedCounter.setValue, (100)),
            postCallStateHash: _computeL2StateHash(100)
        });
        bytes[] memory results2 = new bytes[](1);
        results2[0] = abi.encode(uint256(100));
        bytes32 state2 = _computeL2StateHash(100);
        bytes memory proof2 = _signProof(state1, callData2, state2, calls2, results2, state2);
        rollup.processSingleTxOnL2(state1, callData2, state2, calls2, results2, state2, proof2);

        assertEq(l1Counter.value(), 100, "Value should be 100");

        // Attack: Try to replay the first proof to revert to 50
        vm.expectRevert(
            abi.encodeWithSelector(
                NativeRollupCore.InvalidPrevBlockHash.selector,
                state2,
                GENESIS_HASH
            )
        );
        rollup.processSingleTxOnL2(GENESIS_HASH, callData1, state1, calls1, results1, state1, proof1);

        assertEq(l1Counter.value(), 100, "Replay should have failed");
    }

    /// @notice Attack: Submit conflicting updates in same block
    function test_Attack_ConflictingUpdates() public {
        uint256 value1 = 111;
        uint256 value2 = 222;

        // First update succeeds
        bytes memory callData1 = abi.encodeCall(L2SyncedCounter.setValue, (value1));
        OutgoingCall[] memory calls1 = new OutgoingCall[](1);
        calls1[0] = OutgoingCall({
            from: L2_COUNTER_ADDRESS,
            target: address(l1Counter),
            value: 0,
            gas: 100000,
            data: abi.encodeCall(L1SyncedCounter.setValue, (value1)),
            postCallStateHash: _computeL2StateHash(value1)
        });
        bytes[] memory results1 = new bytes[](1);
        results1[0] = abi.encode(value1);
        bytes32 state1 = _computeL2StateHash(value1);
        bytes memory proof1 = _signProof(GENESIS_HASH, callData1, state1, calls1, results1, state1);

        rollup.processSingleTxOnL2(GENESIS_HASH, callData1, state1, calls1, results1, state1, proof1);

        // Second update with same prevBlockHash should fail
        bytes memory callData2 = abi.encodeCall(L2SyncedCounter.setValue, (value2));
        OutgoingCall[] memory calls2 = new OutgoingCall[](1);
        calls2[0] = OutgoingCall({
            from: L2_COUNTER_ADDRESS,
            target: address(l1Counter),
            value: 0,
            gas: 100000,
            data: abi.encodeCall(L1SyncedCounter.setValue, (value2)),
            postCallStateHash: _computeL2StateHash(value2)
        });
        bytes[] memory results2 = new bytes[](1);
        results2[0] = abi.encode(value2);
        bytes32 state2 = _computeL2StateHash(value2);
        bytes memory proof2 = _signProof(GENESIS_HASH, callData2, state2, calls2, results2, state2);

        vm.expectRevert(
            abi.encodeWithSelector(
                NativeRollupCore.InvalidPrevBlockHash.selector,
                state1,
                GENESIS_HASH
            )
        );
        rollup.processSingleTxOnL2(GENESIS_HASH, callData2, state2, calls2, results2, state2, proof2);

        assertEq(l1Counter.value(), value1, "Only first update should succeed");
    }

    // ============ L1 → L2 Sync Tests ============

    /// @notice Test: L1 calls L2 via registered incoming call
    function test_L1ToL2Sync_ViaIncomingCall() public {
        uint256 newValue = 555;

        // Register incoming call response for L2SyncedCounter.setValue
        bytes memory incomingCallData = abi.encodeCall(L2SyncedCounter.setValue, (newValue));

        OutgoingCall[] memory responseCalls = new OutgoingCall[](0);
        bytes[] memory responseResults = new bytes[](0);

        NativeRollupCore.IncomingCallResponse memory response = NativeRollupCore.IncomingCallResponse({
            preOutgoingCallsStateHash: _computeL2StateHash(newValue),
            outgoingCalls: responseCalls,
            expectedResults: responseResults,
            returnValue: abi.encode(newValue),
            finalStateHash: _computeL2StateHash(newValue)
        });

        bytes memory incomingProof = _signIncomingCallProof(
            L2_COUNTER_ADDRESS,
            GENESIS_HASH,
            incomingCallData,
            response
        );

        rollup.registerIncomingCall(
            L2_COUNTER_ADDRESS,
            GENESIS_HASH,
            incomingCallData,
            response,
            incomingProof
        );

        // Deploy proxy first
        _deployProxyForL2Counter();

        // Now L1 can call the L2 proxy
        address l2Proxy = rollup.getProxyAddress(L2_COUNTER_ADDRESS);

        (bool success,) = l2Proxy.call(incomingCallData);
        assertTrue(success, "Incoming call should succeed");

        assertEq(rollup.l2BlockHash(), _computeL2StateHash(newValue), "L2 state should be updated");
    }

    // ============ Helpers ============

    function _deployProxyForL2Counter() internal {
        bytes memory callData = abi.encode("deploy proxy");
        OutgoingCall[] memory calls = new OutgoingCall[](1);
        calls[0] = OutgoingCall({
            from: L2_COUNTER_ADDRESS,
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
