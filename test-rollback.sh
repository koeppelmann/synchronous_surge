#!/bin/bash
set -e

cd /Users/mkoeppelmann/Code/stuff/surge/synchronous_surge

L1_PORT=8545
L2_PORT=9546
ROLLUP_ADDRESS="0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512"

# Expected state hashes at each stage (from L1 events)
# Block 5:  IncomingCallHandled - 1 ETH deposit, state: 0x661870414c08a264064a9d5b7f6e16f1c268dbda9484d8484ea8122f267e8662
# Block 7:  L2BlockProcessed #1 - deployment, newHash: 0xc48e42c6768fc565f263904f6d827be36d091167511c83e27e3ded20bcd41bce
# Block 10: L2BlockProcessed #2 - setL1ContractProxy, newHash: 0x704dfcf73b2281ddeab24cd5fd855624331bde5e3e78549c03d499ff3c84c179
# Block 13: IncomingCallHandled - setValue(100), finalState: 0x5ac2c6f8f765f97d8d53285b2026ed8a3add82c64ebff087f688053c43773ae4

echo "=== L1 Rollback and L2 Resync Test ==="
echo ""
echo "Event Timeline:"
echo "  Block 5:  IncomingCallHandled (1 ETH deposit) -> state 0x6618..."
echo "  Block 7:  L2BlockProcessed #1 (deploy)       -> state 0xc48e..."
echo "  Block 10: L2BlockProcessed #2 (setL1Proxy)   -> state 0x704d..."
echo "  Block 13: IncomingCallHandled (setValue)     -> state 0x5ac2..."
echo ""

run_test() {
    local TO_BLOCK=$1
    local EXPECTED_EVENTS=$2
    local DESCRIPTION=$3

    echo "========================================"
    echo "Test: Sync up to block $TO_BLOCK"
    echo "Description: $DESCRIPTION"
    echo "Expected events: $EXPECTED_EVENTS"
    echo ""

    # Kill any running fullnode
    pkill -f "deterministic-fullnode" 2>/dev/null || true
    sleep 2

    # Start fullnode with --to-block
    echo "Starting fullnode..."
    npx tsx fullnode/deterministic-fullnode.ts \
        --l1-rpc http://localhost:$L1_PORT \
        --rollup $ROLLUP_ADDRESS \
        --port $L2_PORT \
        --to-block $TO_BLOCK > logs/fullnode-test.log 2>&1 &

    FULLNODE_PID=$!

    # Wait for fullnode to start and sync
    sleep 5

    # Check if fullnode is still running
    if ! kill -0 $FULLNODE_PID 2>/dev/null; then
        echo "ERROR: Fullnode crashed!"
        cat logs/fullnode-test.log
        return 1
    fi

    # Get L2 state
    echo "Results:"

    L2_STATE=$(cast rpc eth_getBlockByNumber "latest" "false" --rpc-url http://localhost:$L2_PORT 2>/dev/null | jq -r '.stateRoot' || echo "FAILED")
    echo "  L2 state root: $L2_STATE"

    # Check counter value
    COUNTER=$(cast call 0x663F3ad617193148711d28f5334eE4Ed07016602 "value()(uint256)" --rpc-url http://localhost:$L2_PORT 2>/dev/null || echo "N/A")
    echo "  L2 counter value: $COUNTER"

    # Show fullnode log summary
    echo ""
    echo "Fullnode log (events processed):"
    grep -E "(Found|Processing|State root|L2 call executed)" logs/fullnode-test.log | head -20

    echo ""

    # Kill fullnode
    kill $FULLNODE_PID 2>/dev/null || true
    sleep 1
}

# Test 1: Before any events
run_test 4 "0 events" "Before any L2 events (genesis only)"

# Test 2: After deposit only
run_test 6 "1 IncomingCallHandled" "After 1 ETH deposit to deployer"

# Test 3: After first L2BlockProcessed
run_test 8 "1 IncomingCallHandled + 1 L2BlockProcessed" "After L2SyncedCounter deployment"

# Test 4: After second L2BlockProcessed
run_test 11 "1 IncomingCallHandled + 2 L2BlockProcessed" "After setL1ContractProxy"

# Test 5: After setValue (full sync)
run_test 14 "2 IncomingCallHandled + 2 L2BlockProcessed" "After setValue(100) - full sync"

echo "========================================"
echo "All tests complete!"
