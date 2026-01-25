#!/bin/bash
# Start L1 (Gnosis Chain fork) and L2 (fresh rollup chain) simultaneously
#
# L1: Gnosis fork at a block after NativeRollupCore is deployed
# L2: Fresh EVM chain (chain ID 10200200) - state derived from L1

set -e

# Configuration
L1_PORT=${L1_PORT:-8545}
L2_PORT=${L2_PORT:-8546}
L1_FORK_URL=${L1_FORK_URL:-https://rpc.gnosischain.com}
L1_FORK_BLOCK=${L1_FORK_BLOCK:-44315000}
L2_CHAIN_ID=${L2_CHAIN_ID:-10200200}

# Contract addresses (deployed on Gnosis mainnet)
ROLLUP_CORE="0x4240994d85109581B001183ab965D9e3d5fb2C2A"
ADMIN_VERIFIER="0x92d55056327CBFaF233bbfc3Fc9E8b38cedE4558"

cleanup() {
    echo "Shutting down..."
    [ -n "$L1_PID" ] && kill $L1_PID 2>/dev/null
    [ -n "$L2_PID" ] && kill $L2_PID 2>/dev/null
    wait 2>/dev/null
    echo "Done."
}
trap cleanup EXIT INT TERM

echo "=== Native Rollup Dual-Chain Setup ==="
echo ""

# Start L1: Gnosis fork
echo "Starting L1 (Gnosis fork at block $L1_FORK_BLOCK)..."
anvil \
    --fork-url "$L1_FORK_URL" \
    --fork-block-number "$L1_FORK_BLOCK" \
    --chain-id 100 \
    --port "$L1_PORT" \
    --silent &
L1_PID=$!

# Start L2: Fresh chain (on-demand mining — blocks only when txs arrive)
echo "Starting L2 (Chain ID $L2_CHAIN_ID)..."
anvil \
    --chain-id "$L2_CHAIN_ID" \
    --port "$L2_PORT" \
    --silent &
L2_PID=$!

# Wait for both chains to be ready
echo "Waiting for chains..."
sleep 3

# Verify L1 is up
if ! cast block-number --rpc-url "http://localhost:$L1_PORT" > /dev/null 2>&1; then
    echo "ERROR: L1 failed to start"
    exit 1
fi

# Verify L2 is up
if ! cast block-number --rpc-url "http://localhost:$L2_PORT" > /dev/null 2>&1; then
    echo "ERROR: L2 failed to start"
    exit 1
fi

L1_BLOCK=$(cast block-number --rpc-url "http://localhost:$L1_PORT")
L2_BLOCK=$(cast block-number --rpc-url "http://localhost:$L2_PORT")

echo ""
echo "=== Chains Running ==="
echo "L1 (Gnosis fork):  http://localhost:$L1_PORT  (block $L1_BLOCK)"
echo "L2 (Rollup):       http://localhost:$L2_PORT  (block $L2_BLOCK)"
echo ""
echo "NativeRollupCore:  $ROLLUP_CORE"
echo "AdminVerifier:     $ADMIN_VERIFIER"
echo ""

# Verify rollup contract is accessible
L2_BLOCK_HASH=$(cast call "$ROLLUP_CORE" "l2BlockHash()(bytes32)" --rpc-url "http://localhost:$L1_PORT" 2>/dev/null || echo "FAILED")
L2_BLOCK_NUM=$(cast call "$ROLLUP_CORE" "l2BlockNumber()(uint256)" --rpc-url "http://localhost:$L1_PORT" 2>/dev/null || echo "FAILED")

echo "L2 state on L1:"
echo "  Block number: $L2_BLOCK_NUM"
echo "  Block hash:   $L2_BLOCK_HASH"
echo ""
echo "Press Ctrl+C to stop both chains."

# Wait for either process to exit
wait
