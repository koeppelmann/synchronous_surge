// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {NativeRollupCore} from "../src/NativeRollupCore.sol";
import {AdminProofVerifier} from "../src/verifiers/AdminProofVerifier.sol";
import {L2SenderProxy} from "../src/L2SenderProxy.sol";
import {OutgoingCall, IProofVerifier} from "../src/interfaces/IProofVerifier.sol";

/// @title NativeRollupCore Tests
/// @notice Comprehensive test suite for Native Rollup contracts
contract NativeRollupCoreTest is Test {
    NativeRollupCore public rollup;
    AdminProofVerifier public verifier;

    // Test accounts
    uint256 constant ADMIN_PK = 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef;
    address admin;
    address owner;
    address user1;
    address user2;

    // L2 addresses (arbitrary for testing)
    address constant L2_ALICE = address(0xA11CE);
    address constant L2_BOB = address(0xB0B);
    address constant L2_CONTRACT = address(0xC0DE);

    // State hashes (simplified for testing)
    bytes32 constant GENESIS_HASH = keccak256("genesis");
    bytes32 constant STATE_1 = keccak256("state1");
    bytes32 constant STATE_2 = keccak256("state2");
    bytes32 constant STATE_3 = keccak256("state3");
    bytes32 constant STATE_4 = keccak256("state4");

    // Mock L1 contracts
    MockL1Contract public mockL1Contract;
    MockL1Callback public mockL1Callback;

    function setUp() public {
        admin = vm.addr(ADMIN_PK);
        owner = address(this);
        user1 = makeAddr("user1");
        user2 = makeAddr("user2");

        // Deploy verifier and rollup
        verifier = new AdminProofVerifier(admin, owner);
        rollup = new NativeRollupCore(GENESIS_HASH, address(verifier), owner);

        // Deploy mock L1 contracts
        mockL1Contract = new MockL1Contract();
        mockL1Callback = new MockL1Callback(address(rollup));

        // Fund accounts
        vm.deal(address(rollup), 100 ether);
        vm.deal(user1, 10 ether);
    }

    // ============ Basic State Tests ============

    function test_InitialState() public view {
        assertEq(rollup.l2BlockHash(), GENESIS_HASH);
        assertEq(rollup.l2BlockNumber(), 0);
        assertEq(address(rollup.proofVerifier()), address(verifier));
        assertEq(rollup.owner(), owner);
    }

    function test_GenesisHashImmutable() public view {
        // Genesis hash is set at construction and becomes the initial l2BlockHash
        assertEq(rollup.l2BlockHash(), GENESIS_HASH);
    }

    // ============ processSingleTxOnL2 Tests ============

    function test_ProcessCallOnL2_SimpleTransition() public {
        bytes memory callData = abi.encode("simple transition");
        OutgoingCall[] memory calls = new OutgoingCall[](0);
        bytes[] memory results = new bytes[](0);

        bytes memory proof = _signProof(
            GENESIS_HASH,
            callData,
            STATE_1,
            calls,
            results,
            STATE_1  // finalStateHash same as postExecutionStateHash when no calls
        );

        rollup.processSingleTxOnL2(
            GENESIS_HASH,
            callData,
            STATE_1,
            calls,
            results,
            STATE_1,
            proof
        );

        assertEq(rollup.l2BlockHash(), STATE_1);
        assertEq(rollup.l2BlockNumber(), 1);
    }

    function test_ProcessCallOnL2_WithOutgoingCall() public {
        bytes memory callData = abi.encode("call with outgoing");
        bytes memory l1CallData = abi.encodeCall(MockL1Contract.setValue, (42));
        bytes memory expectedResult = abi.encode(true);

        // Since the L1 call doesn't modify l2BlockHash, postCallStateHash should equal
        // the state BEFORE the call (which is postExecutionStateHash = STATE_1)
        OutgoingCall[] memory calls = new OutgoingCall[](1);
        calls[0] = OutgoingCall({
            from: L2_ALICE,
            target: address(mockL1Contract),
            value: 0,
            gas: 100000,
            data: l1CallData,
            postCallStateHash: STATE_1  // Same as postExecutionStateHash since no callback
        });

        bytes[] memory results = new bytes[](1);
        results[0] = expectedResult;

        bytes memory proof = _signProof(
            GENESIS_HASH,
            callData,
            STATE_1,
            calls,
            results,
            STATE_2  // Final state after all processing
        );

        rollup.processSingleTxOnL2(
            GENESIS_HASH,
            callData,
            STATE_1,
            calls,
            results,
            STATE_2,
            proof
        );

        assertEq(rollup.l2BlockHash(), STATE_2);
        assertEq(mockL1Contract.value(), 42);
    }

    function test_ProcessCallOnL2_MultipleOutgoingCalls() public {
        bytes memory callData = abi.encode("multiple calls");

        OutgoingCall[] memory calls = new OutgoingCall[](3);
        bytes[] memory results = new bytes[](3);

        // Since none of these L1 calls modify l2BlockHash via callback,
        // each postCallStateHash should equal the state BEFORE that call
        // (which is postExecutionStateHash = STATE_1 for all of them)

        // Call 1: Set value to 10
        calls[0] = OutgoingCall({
            from: L2_ALICE,
            target: address(mockL1Contract),
            value: 0,
            gas: 100000,
            data: abi.encodeCall(MockL1Contract.setValue, (10)),
            postCallStateHash: STATE_1  // No callback, state unchanged
        });
        results[0] = abi.encode(true);

        // Call 2: Add 5
        calls[1] = OutgoingCall({
            from: L2_BOB,
            target: address(mockL1Contract),
            value: 0,
            gas: 100000,
            data: abi.encodeCall(MockL1Contract.addValue, (5)),
            postCallStateHash: STATE_1  // No callback, state unchanged
        });
        results[1] = abi.encode(15);

        // Call 3: Get value
        calls[2] = OutgoingCall({
            from: L2_CONTRACT,
            target: address(mockL1Contract),
            value: 0,
            gas: 100000,
            data: abi.encodeCall(MockL1Contract.getValue, ()),
            postCallStateHash: STATE_1  // No callback, state unchanged
        });
        results[2] = abi.encode(15);

        bytes memory proof = _signProof(
            GENESIS_HASH,
            callData,
            STATE_1,  // postExecutionStateHash
            calls,
            results,
            STATE_2  // finalStateHash (different from postCallStateHash of last call)
        );

        rollup.processSingleTxOnL2(
            GENESIS_HASH,
            callData,
            STATE_1,
            calls,
            results,
            STATE_2,
            proof
        );

        assertEq(rollup.l2BlockHash(), STATE_2);
        assertEq(mockL1Contract.value(), 15);
    }

    function test_ProcessCallOnL2_WithETHValue() public {
        bytes memory callData = abi.encode("eth transfer");

        OutgoingCall[] memory calls = new OutgoingCall[](1);
        calls[0] = OutgoingCall({
            from: L2_ALICE,
            target: user2,
            value: 1 ether,
            gas: 50000,
            data: "",
            postCallStateHash: STATE_1
        });

        bytes[] memory results = new bytes[](1);
        results[0] = "";

        bytes memory proof = _signProof(
            GENESIS_HASH,
            callData,
            STATE_1,
            calls,
            results,
            STATE_1
        );

        uint256 user2BalanceBefore = user2.balance;

        rollup.processSingleTxOnL2(
            GENESIS_HASH,
            callData,
            STATE_1,
            calls,
            results,
            STATE_1,
            proof
        );

        assertEq(user2.balance, user2BalanceBefore + 1 ether);
    }

    function test_RevertWhen_InvalidPrevBlockHash() public {
        bytes memory callData = abi.encode("test");
        OutgoingCall[] memory calls = new OutgoingCall[](0);
        bytes[] memory results = new bytes[](0);

        bytes memory proof = _signProof(
            STATE_1,  // Wrong prev hash
            callData,
            STATE_2,
            calls,
            results,
            STATE_2
        );

        vm.expectRevert(
            abi.encodeWithSelector(
                NativeRollupCore.InvalidPrevBlockHash.selector,
                GENESIS_HASH,
                STATE_1
            )
        );

        rollup.processSingleTxOnL2(
            STATE_1,
            callData,
            STATE_2,
            calls,
            results,
            STATE_2,
            proof
        );
    }

    function test_RevertWhen_InvalidProof() public {
        bytes memory callData = abi.encode("test");
        OutgoingCall[] memory calls = new OutgoingCall[](0);
        bytes[] memory results = new bytes[](0);

        // Sign with wrong private key
        bytes memory badProof = _signWithKey(
            0xBAD,
            GENESIS_HASH,
            callData,
            STATE_1,
            calls,
            results,
            STATE_1
        );

        vm.expectRevert(NativeRollupCore.ProofVerificationFailed.selector);

        rollup.processSingleTxOnL2(
            GENESIS_HASH,
            callData,
            STATE_1,
            calls,
            results,
            STATE_1,
            badProof
        );
    }

    function test_RevertWhen_OutgoingCallFails() public {
        bytes memory callData = abi.encode("failing call");

        OutgoingCall[] memory calls = new OutgoingCall[](1);
        calls[0] = OutgoingCall({
            from: L2_ALICE,
            target: address(mockL1Contract),
            value: 0,
            gas: 100000,
            data: abi.encodeCall(MockL1Contract.failingFunction, ()),
            postCallStateHash: STATE_1
        });

        bytes[] memory results = new bytes[](1);
        results[0] = "";

        bytes memory proof = _signProof(
            GENESIS_HASH,
            callData,
            STATE_1,
            calls,
            results,
            STATE_1
        );

        vm.expectRevert(
            abi.encodeWithSelector(
                NativeRollupCore.OutgoingCallFailed.selector,
                0,
                L2_ALICE,
                address(mockL1Contract)
            )
        );

        rollup.processSingleTxOnL2(
            GENESIS_HASH,
            callData,
            STATE_1,
            calls,
            results,
            STATE_1,
            proof
        );
    }

    function test_RevertWhen_UnexpectedCallResult() public {
        bytes memory callData = abi.encode("wrong result");

        OutgoingCall[] memory calls = new OutgoingCall[](1);
        calls[0] = OutgoingCall({
            from: L2_ALICE,
            target: address(mockL1Contract),
            value: 0,
            gas: 100000,
            data: abi.encodeCall(MockL1Contract.getValue, ()),
            postCallStateHash: STATE_1
        });

        bytes[] memory results = new bytes[](1);
        results[0] = abi.encode(999);  // Wrong expected result (actual is 0)

        bytes memory proof = _signProof(
            GENESIS_HASH,
            callData,
            STATE_1,
            calls,
            results,
            STATE_1
        );

        vm.expectRevert();  // UnexpectedCallResult

        rollup.processSingleTxOnL2(
            GENESIS_HASH,
            callData,
            STATE_1,
            calls,
            results,
            STATE_1,
            proof
        );
    }

    function test_RevertWhen_Reentrancy() public {
        // This test verifies reentrancy protection
        // The mockL1Callback will try to call processSingleTxOnL2 during execution
        bytes memory callData = abi.encode("reentrancy test");

        OutgoingCall[] memory calls = new OutgoingCall[](1);
        calls[0] = OutgoingCall({
            from: L2_ALICE,
            target: address(mockL1Callback),
            value: 0,
            gas: 500000,
            data: abi.encodeCall(MockL1Callback.triggerReentrancy, ()),
            postCallStateHash: STATE_1
        });

        bytes[] memory results = new bytes[](1);
        results[0] = "";

        bytes memory proof = _signProof(
            GENESIS_HASH,
            callData,
            STATE_1,
            calls,
            results,
            STATE_1
        );

        // The call should fail due to reentrancy guard
        vm.expectRevert();

        rollup.processSingleTxOnL2(
            GENESIS_HASH,
            callData,
            STATE_1,
            calls,
            results,
            STATE_1,
            proof
        );
    }

    // ============ L2SenderProxy Tests ============

    function test_ProxyAddressDeterministic() public view {
        address proxy1 = rollup.getProxyAddress(L2_ALICE);
        address proxy2 = rollup.getProxyAddress(L2_ALICE);
        assertEq(proxy1, proxy2);

        address proxy3 = rollup.getProxyAddress(L2_BOB);
        assertTrue(proxy1 != proxy3);
    }

    function test_ProxyDeployedOnFirstCall() public {
        assertFalse(rollup.isProxyDeployed(L2_ALICE));

        // Execute a call that uses L2_ALICE as sender
        bytes memory callData = abi.encode("deploy proxy");

        OutgoingCall[] memory calls = new OutgoingCall[](1);
        calls[0] = OutgoingCall({
            from: L2_ALICE,
            target: address(mockL1Contract),
            value: 0,
            gas: 100000,
            data: abi.encodeCall(MockL1Contract.getValue, ()),
            postCallStateHash: STATE_1
        });

        bytes[] memory results = new bytes[](1);
        results[0] = abi.encode(0);

        bytes memory proof = _signProof(
            GENESIS_HASH,
            callData,
            STATE_1,
            calls,
            results,
            STATE_1
        );

        rollup.processSingleTxOnL2(
            GENESIS_HASH,
            callData,
            STATE_1,
            calls,
            results,
            STATE_1,
            proof
        );

        assertTrue(rollup.isProxyDeployed(L2_ALICE));
    }

    function test_ProxyMsgSenderCorrect() public {
        bytes memory callData = abi.encode("check sender");

        // Call recordSender which stores msg.sender
        OutgoingCall[] memory calls = new OutgoingCall[](1);
        calls[0] = OutgoingCall({
            from: L2_ALICE,
            target: address(mockL1Contract),
            value: 0,
            gas: 100000,
            data: abi.encodeCall(MockL1Contract.recordSender, ()),
            postCallStateHash: STATE_1
        });

        bytes[] memory results = new bytes[](1);
        results[0] = "";

        bytes memory proof = _signProof(
            GENESIS_HASH,
            callData,
            STATE_1,
            calls,
            results,
            STATE_1
        );

        rollup.processSingleTxOnL2(
            GENESIS_HASH,
            callData,
            STATE_1,
            calls,
            results,
            STATE_1,
            proof
        );

        // The recorded sender should be the proxy address for L2_ALICE
        assertEq(mockL1Contract.lastSender(), rollup.getProxyAddress(L2_ALICE));
    }

    // ============ Incoming Call Registry Tests ============

    function test_RegisterIncomingCall() public {
        NativeRollupCore.IncomingCallResponse memory response = _createSimpleResponse();

        bytes memory callData = abi.encodeCall(MockL1Contract.getValue, ());
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

        bytes32 responseKey = rollup.getResponseKey(L2_CONTRACT, GENESIS_HASH, callData);
        assertTrue(rollup.incomingCallRegistered(responseKey));
    }

    function test_RevertWhen_IncomingCallAlreadyRegistered() public {
        NativeRollupCore.IncomingCallResponse memory response = _createSimpleResponse();

        bytes memory callData = abi.encodeCall(MockL1Contract.getValue, ());
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

        vm.expectRevert();  // IncomingCallAlreadyRegistered

        rollup.registerIncomingCall(
            L2_CONTRACT,
            GENESIS_HASH,
            callData,
            response,
            proof
        );
    }

    function test_RevertWhen_IncomingCallProofInvalid() public {
        NativeRollupCore.IncomingCallResponse memory response = _createSimpleResponse();

        bytes memory callData = abi.encodeCall(MockL1Contract.getValue, ());
        bytes memory badProof = _signWithKeyIncoming(
            0xBAD,
            L2_CONTRACT,
            GENESIS_HASH,
            callData,
            response
        );

        vm.expectRevert(NativeRollupCore.IncomingCallProofFailed.selector);

        rollup.registerIncomingCall(
            L2_CONTRACT,
            GENESIS_HASH,
            callData,
            response,
            badProof
        );
    }

    // ============ State Callback Tests ============

    function test_OutgoingCallWithNoCallback() public {
        // Test that when L1 call doesn't modify state, postCallStateHash must match current state
        bytes memory callData = abi.encode("no callback");

        OutgoingCall[] memory calls = new OutgoingCall[](1);
        calls[0] = OutgoingCall({
            from: L2_ALICE,
            target: address(mockL1Contract),
            value: 0,
            gas: 100000,
            data: abi.encodeCall(MockL1Contract.setValue, (100)),
            postCallStateHash: STATE_1  // State unchanged since no callback
        });

        bytes[] memory results = new bytes[](1);
        results[0] = abi.encode(true);

        bytes memory proof = _signProof(
            GENESIS_HASH,
            callData,
            STATE_1,
            calls,
            results,
            STATE_2
        );

        rollup.processSingleTxOnL2(
            GENESIS_HASH,
            callData,
            STATE_1,
            calls,
            results,
            STATE_2,
            proof
        );

        assertEq(rollup.l2BlockHash(), STATE_2);
        assertEq(mockL1Contract.value(), 100);
    }

    function test_RevertWhen_UnexpectedPostCallState() public {
        // Test that if we expect wrong postCallStateHash, it reverts
        bytes memory callData = abi.encode("wrong state expectation");

        OutgoingCall[] memory calls = new OutgoingCall[](1);
        calls[0] = OutgoingCall({
            from: L2_ALICE,
            target: address(mockL1Contract),
            value: 0,
            gas: 100000,
            data: abi.encodeCall(MockL1Contract.setValue, (50)),
            postCallStateHash: STATE_3  // Wrong! Should be STATE_1 since no callback
        });

        bytes[] memory results = new bytes[](1);
        results[0] = abi.encode(true);

        bytes memory proof = _signProof(
            GENESIS_HASH,
            callData,
            STATE_1,
            calls,
            results,
            STATE_2
        );

        vm.expectRevert(
            abi.encodeWithSelector(
                NativeRollupCore.UnexpectedPostCallState.selector,
                0,
                STATE_3,
                STATE_1
            )
        );

        rollup.processSingleTxOnL2(
            GENESIS_HASH,
            callData,
            STATE_1,
            calls,
            results,
            STATE_2,
            proof
        );
    }

    // ============ Admin Functions Tests ============

    function test_UpgradeProofVerifier() public {
        AdminProofVerifier newVerifier = new AdminProofVerifier(admin, owner);

        rollup.upgradeProofVerifier(address(newVerifier));

        assertEq(address(rollup.proofVerifier()), address(newVerifier));
    }

    function test_RevertWhen_NonOwnerUpgradesVerifier() public {
        AdminProofVerifier newVerifier = new AdminProofVerifier(admin, owner);

        vm.prank(user1);
        vm.expectRevert(NativeRollupCore.OnlyOwner.selector);

        rollup.upgradeProofVerifier(address(newVerifier));
    }

    function test_TransferOwnership() public {
        rollup.transferOwnership(user1);
        assertEq(rollup.owner(), user1);
    }

    // ============ Events Tests ============

    function test_EmitsL2BlockProcessed() public {
        bytes memory callData = abi.encode("event test");
        OutgoingCall[] memory calls = new OutgoingCall[](0);
        bytes[] memory results = new bytes[](0);

        bytes memory proof = _signProof(
            GENESIS_HASH,
            callData,
            STATE_1,
            calls,
            results,
            STATE_1
        );

        vm.expectEmit(true, true, true, true);
        emit NativeRollupCore.L2BlockProcessed(1, GENESIS_HASH, STATE_1, callData, calls, results);

        rollup.processSingleTxOnL2(
            GENESIS_HASH,
            callData,
            STATE_1,
            calls,
            results,
            STATE_1,
            proof
        );
    }

    function test_EmitsL2StateUpdated() public {
        bytes memory callData = abi.encode("state update event");
        OutgoingCall[] memory calls = new OutgoingCall[](0);
        bytes[] memory results = new bytes[](0);

        bytes memory proof = _signProof(
            GENESIS_HASH,
            callData,
            STATE_1,
            calls,
            results,
            STATE_1
        );

        vm.expectEmit(true, true, true, true);
        emit NativeRollupCore.L2StateUpdated(1, STATE_1, 0);

        rollup.processSingleTxOnL2(
            GENESIS_HASH,
            callData,
            STATE_1,
            calls,
            results,
            STATE_1,
            proof
        );
    }

    function test_EmitsL2SenderProxyDeployed() public {
        bytes memory callData = abi.encode("proxy deploy event");

        OutgoingCall[] memory calls = new OutgoingCall[](1);
        calls[0] = OutgoingCall({
            from: L2_ALICE,
            target: address(mockL1Contract),
            value: 0,
            gas: 100000,
            data: abi.encodeCall(MockL1Contract.getValue, ()),
            postCallStateHash: STATE_1
        });

        bytes[] memory results = new bytes[](1);
        results[0] = abi.encode(0);

        bytes memory proof = _signProof(
            GENESIS_HASH,
            callData,
            STATE_1,
            calls,
            results,
            STATE_1
        );

        address expectedProxy = rollup.getProxyAddress(L2_ALICE);

        vm.expectEmit(true, true, false, false);
        emit NativeRollupCore.L2SenderProxyDeployed(L2_ALICE, expectedProxy);

        rollup.processSingleTxOnL2(
            GENESIS_HASH,
            callData,
            STATE_1,
            calls,
            results,
            STATE_1,
            proof
        );
    }

    // ============ Helper Functions ============

    function _signProof(
        bytes32 prevBlockHash,
        bytes memory callData,
        bytes32 postExecutionStateHash,
        OutgoingCall[] memory calls,
        bytes[] memory results,
        bytes32 finalStateHash
    ) internal view returns (bytes memory) {
        return _signWithKey(ADMIN_PK, prevBlockHash, callData, postExecutionStateHash, calls, results, finalStateHash);
    }

    function _signWithKey(
        uint256 privateKey,
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

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, ethSignedMessageHash);
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

    function _createSimpleResponse() internal pure returns (NativeRollupCore.IncomingCallResponse memory) {
        OutgoingCall[] memory calls = new OutgoingCall[](0);
        bytes[] memory results = new bytes[](0);

        return NativeRollupCore.IncomingCallResponse({
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
    ) internal view returns (bytes memory) {
        return _signWithKeyIncoming(ADMIN_PK, l2Address, stateHash, callData, response);
    }

    function _signWithKeyIncoming(
        uint256 privateKey,
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

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, ethSignedMessageHash);
        return abi.encodePacked(r, s, v);
    }
}

// ============ Mock Contracts ============

contract MockL1Contract {
    uint256 public value;
    address public lastSender;

    function setValue(uint256 _value) external returns (bool) {
        value = _value;
        return true;
    }

    function addValue(uint256 _amount) external returns (uint256) {
        value += _amount;
        return value;
    }

    function getValue() external view returns (uint256) {
        return value;
    }

    function recordSender() external {
        lastSender = msg.sender;
    }

    function failingFunction() external pure {
        revert("Always fails");
    }

    receive() external payable {}
}

contract MockL1Callback {
    NativeRollupCore public rollup;

    constructor(address _rollup) {
        rollup = NativeRollupCore(payable(_rollup));
    }

    function triggerReentrancy() external {
        // Try to call processSingleTxOnL2 during execution - should fail
        OutgoingCall[] memory calls = new OutgoingCall[](0);
        bytes[] memory results = new bytes[](0);

        rollup.processSingleTxOnL2(
            rollup.l2BlockHash(),
            "",
            keccak256("reentrant"),
            calls,
            results,
            keccak256("reentrant"),
            ""
        );
    }
}

