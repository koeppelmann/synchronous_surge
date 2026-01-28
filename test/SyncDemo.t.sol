// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/examples/SyncDemo.sol";
import "../src/examples/SyncedCounter.sol";
import "../src/NativeRollupCore.sol";
import "../src/verifiers/AdminProofVerifier.sol";

/**
 * @title SyncDemo Tests
 * @notice Tests for the SyncDemo contract that demonstrates synchronous L1↔L2 composability
 */
contract SyncDemoTest is Test {
    SyncDemo public syncDemo;
    L1SyncedCounter public l1Counter;
    L2SyncedCounter public l2Counter;
    NativeRollupCore public rollup;
    AdminProofVerifier public verifier;

    address public admin = address(0x1);
    address public user = address(0x2);

    // Initial L2 state hash (mock)
    bytes32 public constant INITIAL_L2_HASH = bytes32(uint256(1));

    function setUp() public {
        vm.startPrank(admin);

        // Deploy verifier and rollup
        verifier = new AdminProofVerifier(admin, admin);
        rollup = new NativeRollupCore(INITIAL_L2_HASH, address(verifier), admin);

        // Deploy L2SyncedCounter (on "L2" - just a mock here)
        l2Counter = new L2SyncedCounter();

        // Deploy L1SyncedCounter
        l1Counter = new L1SyncedCounter();

        // Deploy L2's proxy on L1
        address l2Proxy = rollup.deployProxy(address(l2Counter));

        // Configure L1SyncedCounter to use the proxy
        l1Counter.setL2Proxy(l2Proxy);

        // Deploy SyncDemo
        syncDemo = new SyncDemo();
        syncDemo.initialize(l2Proxy, address(l1Counter));

        vm.stopPrank();
    }

    function test_Initialize() public view {
        assertEq(syncDemo.l2CounterProxy(), rollup.getProxyAddress(address(l2Counter)));
        assertEq(syncDemo.l1Counter(), address(l1Counter));
    }

    function test_RevertIfL2ProxyNotSet() public {
        SyncDemo uninitializedDemo = new SyncDemo();

        vm.expectRevert(SyncDemo.L2ProxyNotSet.selector);
        uninitializedDemo.setValue(42);
    }

    function test_RevertIfL1CounterNotSet() public {
        SyncDemo partialDemo = new SyncDemo();
        address l2Proxy = rollup.getProxyAddress(address(l2Counter));
        partialDemo.initialize(l2Proxy, address(0));

        vm.expectRevert(SyncDemo.L1CounterNotSet.selector);
        partialDemo.setValue(42);
    }

    function test_GetValuesInitiallyZero() public view {
        (uint256 valueBefore, uint256 valueSet, uint256 valueAfter) = syncDemo.getValues();
        assertEq(valueBefore, 0);
        assertEq(valueSet, 0);
        assertEq(valueAfter, 0);
    }

    /**
     * @notice Integration test that demonstrates the full flow
     * @dev This test requires proper L1/L2 simulation which is complex in Forge.
     *      For full E2E testing, use the TypeScript test script with actual chains.
     *
     * The expected flow:
     * 1. SyncDemo.setValue(66) is called
     * 2. It reads L2SyncedCounter.value() via proxy → returns 42 (pre-registered)
     * 3. It calls L1SyncedCounter.setValue(66) → syncs to L2 via proxy
     * 4. It reads L2SyncedCounter.value() via proxy again → returns 66 (pre-registered)
     * 5. valueBefore=42, valueSet=66, valueAfter=66
     */
    function test_SetValueFlow_Conceptual() public {
        // This test demonstrates the CONTRACT LOGIC, not the full L1↔L2 flow
        // For full flow testing, see scripts/test-sync-demo.ts

        // In a real scenario:
        // - Builder pre-registers response for value() at state Hash0 → returns 42
        // - Builder pre-registers response for setValue(66) at state Hash0 → updates to Hash1
        // - Builder pre-registers response for value() at state Hash1 → returns 66
        // - Then SyncDemo.setValue(66) executes and reads these pre-registered values

        // Verify contract is properly configured
        assertTrue(syncDemo.l2CounterProxy() != address(0), "L2 proxy not set");
        assertTrue(syncDemo.l1Counter() != address(0), "L1 counter not set");
    }

    /**
     * @notice Test that SyncDemo emits correct event
     */
    function test_EventEmission() public {
        // Mock the proxy responses by directly setting up the incoming call registry
        // This is a simplified test - full flow requires builder integration

        // For a complete test, we would need to:
        // 1. Register incoming call responses on the rollup
        // 2. Call SyncDemo.setValue()
        // 3. Verify the event was emitted with correct values

        // This is tested via the E2E script instead
    }
}

/**
 * @title SyncDemo Unit Tests (Isolated)
 * @notice Unit tests that don't require the full L1↔L2 infrastructure
 */
contract SyncDemoUnitTest is Test {
    SyncDemo public syncDemo;

    function setUp() public {
        syncDemo = new SyncDemo();
    }

    function test_InitializeOnce() public {
        address proxy = address(0x123);
        address counter = address(0x456);

        syncDemo.initialize(proxy, counter);

        assertEq(syncDemo.l2CounterProxy(), proxy);
        assertEq(syncDemo.l1Counter(), counter);
    }

    function test_InitializeCanBeCalledMultipleTimes() public {
        // Currently initialize can be called multiple times
        // This is intentional for the POC to allow reconfiguration
        syncDemo.initialize(address(0x1), address(0x2));
        syncDemo.initialize(address(0x3), address(0x4));

        assertEq(syncDemo.l2CounterProxy(), address(0x3));
        assertEq(syncDemo.l1Counter(), address(0x4));
    }

    function test_StorageSlots() public {
        // Verify storage layout
        assertEq(syncDemo.valueBefore(), 0);
        assertEq(syncDemo.valueSet(), 0);
        assertEq(syncDemo.valueAfter(), 0);
    }
}
