#!/bin/bash
#
# Native Rollup - Fresh Setup Script
#
# This script creates a fresh L1 state with all contracts deployed.
# Run this once to generate the state file, then use ./start.sh to
# quickly start the system using the saved state.
#
# What this script does:
# 1. Start fresh L1 Anvil
# 2. Start L2 Fullnode with new architecture
# 3. Start Builder (uses fullnode RPC only)
# 4. Deploy NativeRollupCore and AdminProofVerifier
# 5. Deploy L1SyncedCounter and L2SyncedCounter
# 6. Test proxy hint mechanism:
#    - First call setValue WITHOUT hint -> Expected to FAIL (proxy not deployed)
#    - Then call setValue WITH hint (L2SyncedCounter) -> Should SUCCEED
# 7. Save L1 state
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Ports
L1_PORT=8545
L1_PROXY_PORT=8546
L2_EVM_PORT=9546
FULLNODE_RPC_PORT=9547
L2_PROXY_PORT=9548
BUILDER_PORT=3200
FRONTEND_PORT=8080

# Keys
ADMIN_PRIVATE_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
ADMIN_ADDRESS="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
DEPLOYER_PK="0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"
DEPLOYER="0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"

# State file
STATE_DIR="state"
L1_STATE_FILE="$STATE_DIR/l1-state.json"

log() {
    echo -e "${BLUE}[$(date +%H:%M:%S)]${NC} $1"
}

success() {
    echo -e "${GREEN}[$(date +%H:%M:%S)] ✓${NC} $1"
}

error() {
    echo -e "${RED}[$(date +%H:%M:%S)] ✗${NC} $1"
}

warn() {
    echo -e "${YELLOW}[$(date +%H:%M:%S)] !${NC} $1"
}

cleanup() {
    log "Cleaning up old processes..."
    pkill -f "anvil.*$L1_PORT" 2>/dev/null || true
    pkill -f "anvil.*$L2_EVM_PORT" 2>/dev/null || true
    pkill -f "anvil.*19" 2>/dev/null || true
    pkill -f "l2-fullnode" 2>/dev/null || true
    pkill -f "deterministic-fullnode" 2>/dev/null || true
    pkill -f "builder.ts" 2>/dev/null || true
    pkill -f "deterministic-builder" 2>/dev/null || true
    pkill -f "rpc-proxy.ts" 2>/dev/null || true
    pkill -f "l2-rpc-proxy.ts" 2>/dev/null || true
    pkill -f "python.*$FRONTEND_PORT" 2>/dev/null || true
    sleep 2
}

wait_for_rpc() {
    local url=$1
    local name=$2
    local max_attempts=30
    local attempt=0

    while [ $attempt -lt $max_attempts ]; do
        if curl -s "$url" -X POST -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' > /dev/null 2>&1; then
            return 0
        fi
        attempt=$((attempt + 1))
        sleep 0.5
    done

    error "Timeout waiting for $name at $url"
    return 1
}

start_l1() {
    log "Starting fresh L1 Anvil on port $L1_PORT..."
    anvil --port $L1_PORT --chain-id 31337 --silent &

    if wait_for_rpc "http://localhost:$L1_PORT" "L1 Anvil"; then
        success "L1 Anvil started"
    else
        error "Failed to start L1 Anvil"
        exit 1
    fi
}

start_fullnode() {
    log "Starting L2 Fullnode (new architecture)..."
    log "  L2 EVM port: $L2_EVM_PORT"
    log "  Fullnode RPC port: $FULLNODE_RPC_PORT"

    mkdir -p logs

    npx tsx l2fullnode/l2-fullnode.ts \
        --l1-rpc http://localhost:$L1_PORT \
        --rollup $ROLLUP_ADDRESS \
        --l2-port $L2_EVM_PORT \
        --rpc-port $FULLNODE_RPC_PORT \
        > logs/fullnode.log 2>&1 &

    sleep 3

    if wait_for_rpc "http://localhost:$L2_EVM_PORT" "L2 EVM"; then
        success "L2 EVM started"
    else
        error "Failed to start L2 EVM"
        cat logs/fullnode.log
        exit 1
    fi

    if wait_for_rpc "http://localhost:$FULLNODE_RPC_PORT" "Fullnode RPC"; then
        success "Fullnode RPC started"
    else
        error "Failed to start Fullnode RPC"
        cat logs/fullnode.log
        exit 1
    fi

    # Get and display genesis state
    GENESIS_STATE=$(curl -s http://localhost:$FULLNODE_RPC_PORT -X POST -H "Content-Type: application/json" \
        -d '{"jsonrpc":"2.0","method":"nativerollup_getStateRoot","params":[],"id":1}' | jq -r '.result')
    success "Fullnode genesis state: $GENESIS_STATE"
}

start_builder() {
    log "Starting Builder (new architecture)..."

    npx tsx builder/builder.ts \
        --l1-rpc http://localhost:$L1_PORT \
        --fullnode http://localhost:$FULLNODE_RPC_PORT \
        --rollup $ROLLUP_ADDRESS \
        --admin-key $ADMIN_PRIVATE_KEY \
        --port $BUILDER_PORT \
        > logs/builder.log 2>&1 &

    # Wait for builder to start (with retries)
    for i in {1..10}; do
        sleep 1
        if curl -s "http://localhost:$BUILDER_PORT/status" > /dev/null 2>&1; then
            success "Builder started"
            return 0
        fi
    done

    error "Failed to start Builder"
    cat logs/builder.log
    exit 1
}

start_proxies() {
    log "Starting L1 RPC Proxy on port $L1_PROXY_PORT..."

    npx tsx builder/rpc-proxy.ts \
        --port $L1_PROXY_PORT \
        --rpc http://localhost:$L1_PORT \
        --builder http://localhost:$BUILDER_PORT \
        --rollup $ROLLUP_ADDRESS \
        > logs/l1-proxy.log 2>&1 &

    # Wait for L1 proxy to start
    for i in {1..10}; do
        sleep 1
        if curl -s "http://localhost:$L1_PROXY_PORT/status" > /dev/null 2>&1; then
            success "L1 Proxy started"
            break
        fi
        if [ $i -eq 10 ]; then
            error "Failed to start L1 Proxy"
            cat logs/l1-proxy.log
            exit 1
        fi
    done

    log "Starting L2 RPC Proxy on port $L2_PROXY_PORT..."

    npx tsx builder/l2-rpc-proxy.ts \
        --port $L2_PROXY_PORT \
        --fullnode http://localhost:$FULLNODE_RPC_PORT \
        --builder http://localhost:$BUILDER_PORT \
        --l2-evm http://localhost:$L2_EVM_PORT \
        > logs/l2-proxy.log 2>&1 &

    # Wait for L2 proxy to start
    for i in {1..10}; do
        sleep 1
        if curl -s "http://localhost:$L2_PROXY_PORT/status" > /dev/null 2>&1; then
            success "L2 Proxy started"
            break
        fi
        if [ $i -eq 10 ]; then
            error "Failed to start L2 Proxy"
            cat logs/l2-proxy.log
            exit 1
        fi
    done
}

start_frontend() {
    log "Starting Frontend on port $FRONTEND_PORT..."

    cd ui
    python3 -m http.server $FRONTEND_PORT > ../logs/frontend.log 2>&1 &
    cd ..

    # Wait for frontend to start
    for i in {1..10}; do
        sleep 1
        if curl -s "http://localhost:$FRONTEND_PORT" > /dev/null 2>&1; then
            success "Frontend started"
            break
        fi
        if [ $i -eq 10 ]; then
            warn "Frontend may not have started, but continuing..."
        fi
    done
}

deploy_core_contracts() {
    log "Deploying NativeRollupCore..."

    # Get the fullnode's genesis state root
    GENESIS_HASH=$(curl -s http://localhost:$FULLNODE_RPC_PORT -X POST -H "Content-Type: application/json" \
        -d '{"jsonrpc":"2.0","method":"nativerollup_getStateRoot","params":[],"id":1}' | jq -r '.result')
    log "Using genesis hash from fullnode: $GENESIS_HASH"

    # Compile contracts if needed
    if [ ! -d "out" ]; then
        log "Compiling contracts..."
        forge build
    fi

    # Deploy using forge script
    DEPLOY_OUTPUT=$(GENESIS_HASH=$GENESIS_HASH ADMIN=$ADMIN_ADDRESS forge script script/Deploy.s.sol:DeployScript \
        --rpc-url http://localhost:$L1_PORT \
        --private-key $ADMIN_PRIVATE_KEY \
        --broadcast 2>&1)

    # Extract addresses from output
    VERIFIER_ADDRESS=$(echo "$DEPLOY_OUTPUT" | grep "AdminProofVerifier:" | awk '{print $2}')
    ROLLUP_ADDRESS=$(echo "$DEPLOY_OUTPUT" | grep "NativeRollupCore:" | awk '{print $2}')

    if [ -z "$ROLLUP_ADDRESS" ]; then
        error "Failed to deploy contracts"
        echo "$DEPLOY_OUTPUT"
        exit 1
    fi

    success "AdminProofVerifier deployed at: $VERIFIER_ADDRESS"
    success "NativeRollupCore deployed at: $ROLLUP_ADDRESS"

    # Export for other functions
    export ROLLUP_ADDRESS
    export VERIFIER_ADDRESS
}

submit_tx() {
    local signed_tx=$1
    local source_chain=$2
    local hints=$3

    if [ -n "$hints" ]; then
        curl -s -X POST http://localhost:$BUILDER_PORT/submit \
            -H "Content-Type: application/json" \
            -d "{\"signedTx\": \"$signed_tx\", \"sourceChain\": \"$source_chain\", \"hints\": $hints}"
    else
        curl -s -X POST http://localhost:$BUILDER_PORT/submit \
            -H "Content-Type: application/json" \
            -d "{\"signedTx\": \"$signed_tx\", \"sourceChain\": \"$source_chain\"}"
    fi
}

deploy_synced_counters() {
    log "Setting up L1 and L2 SyncedCounters..."

    # Fund DEPLOYER on L1
    log "Funding deployer on L1..."
    curl -s http://localhost:$L1_PORT -X POST -H "Content-Type: application/json" \
        -d "{\"jsonrpc\":\"2.0\",\"method\":\"anvil_setBalance\",\"params\":[\"$DEPLOYER\", \"0x56BC75E2D63100000\"],\"id\":1}" > /dev/null

    # Deploy L1SyncedCounter
    log "Deploying L1SyncedCounter..."
    BYTECODE=$(forge inspect src/examples/SyncedCounter.sol:L1SyncedCounter bytecode)
    NONCE=$(cast nonce $DEPLOYER --rpc-url http://localhost:$L1_PORT)

    SIGNED_TX=$(cast mktx --private-key $DEPLOYER_PK \
        --rpc-url http://localhost:$L1_PORT \
        --legacy \
        --nonce $NONCE \
        --gas-limit 500000 \
        --gas-price 2000000000 \
        --create "$BYTECODE")

    RESULT=$(submit_tx "$SIGNED_TX" "L1")
    TX_HASH=$(echo "$RESULT" | jq -r '.l1TxHash')
    L1_CONTRACT=$(cast receipt $TX_HASH --rpc-url http://localhost:$L1_PORT | grep contractAddress | awk '{print $2}')
    success "L1SyncedCounter deployed at: $L1_CONTRACT"

    # Deploy L2SyncedCounter (on L2)
    log "Deploying L2SyncedCounter..."
    BYTECODE=$(forge inspect src/examples/SyncedCounter.sol:L2SyncedCounter bytecode)
    L2_NONCE=$(cast nonce $DEPLOYER --rpc-url http://localhost:$L2_EVM_PORT)

    # Pre-compute the contract address
    L2_CONTRACT=$(cast compute-address $DEPLOYER --nonce $L2_NONCE | grep -oE '0x[a-fA-F0-9]{40}')

    SIGNED_TX=$(cast mktx --private-key $DEPLOYER_PK \
        --rpc-url http://localhost:$L2_EVM_PORT \
        --legacy \
        --nonce $L2_NONCE \
        --gas-limit 500000 \
        --gas-price 0 \
        --create "$BYTECODE")

    RESULT=$(submit_tx "$SIGNED_TX" "L2")
    if echo "$RESULT" | grep -q "error"; then
        error "L2SyncedCounter deployment failed: $RESULT"
        exit 1
    fi
    success "L2SyncedCounter deployed at: $L2_CONTRACT"

    # Deploy L2SenderProxy for L2SyncedCounter on L1
    log "Deploying L2SenderProxy for L2SyncedCounter..."
    NONCE=$(cast nonce $DEPLOYER --rpc-url http://localhost:$L1_PORT)
    CALLDATA=$(cast calldata "deployProxy(address)" $L2_CONTRACT)
    SIGNED_TX=$(cast mktx --private-key $DEPLOYER_PK \
        --rpc-url http://localhost:$L1_PORT \
        --legacy \
        --nonce $NONCE \
        --gas-limit 500000 \
        --gas-price 2000000000 \
        $ROLLUP_ADDRESS \
        "$CALLDATA")
    RESULT=$(submit_tx "$SIGNED_TX" "L1")
    L2_PROXY=$(cast call $ROLLUP_ADDRESS "getProxyAddress(address)(address)" $L2_CONTRACT --rpc-url http://localhost:$L1_PORT)
    success "L2SenderProxy deployed at: $L2_PROXY"

    # Set L2 proxy on L1SyncedCounter
    NONCE=$(cast nonce $DEPLOYER --rpc-url http://localhost:$L1_PORT)
    CALLDATA=$(cast calldata "setL2Proxy(address)" $L2_PROXY)
    SIGNED_TX=$(cast mktx --private-key $DEPLOYER_PK \
        --rpc-url http://localhost:$L1_PORT \
        --legacy \
        --nonce $NONCE \
        --gas-limit 100000 \
        --gas-price 2000000000 \
        $L1_CONTRACT \
        "$CALLDATA")
    submit_tx "$SIGNED_TX" "L1" > /dev/null
    success "Set L2 proxy on L1SyncedCounter"

    # Get the L1SenderProxyL2 address from the fullnode (it computes the CREATE2 address)
    L1_PROXY_ON_L2=$(curl -s http://localhost:$FULLNODE_RPC_PORT -X POST -H "Content-Type: application/json" \
        -d "{\"jsonrpc\":\"2.0\",\"method\":\"nativerollup_getL1SenderProxyL2\",\"params\":[\"$L1_CONTRACT\"],\"id\":1}" | jq -r '.result')
    log "L1 contract's proxy on L2 (from fullnode): $L1_PROXY_ON_L2"

    # Set L1 contract's proxy on L2SyncedCounter
    L2_NONCE=$(cast nonce $DEPLOYER --rpc-url http://localhost:$L2_EVM_PORT)
    CALLDATA=$(cast calldata "setL1ContractProxy(address)" $L1_PROXY_ON_L2)
    SIGNED_TX=$(cast mktx --private-key $DEPLOYER_PK \
        --rpc-url http://localhost:$L2_EVM_PORT \
        --legacy \
        --nonce $L2_NONCE \
        --gas-limit 100000 \
        --gas-price 0 \
        $L2_CONTRACT \
        "$CALLDATA")
    submit_tx "$SIGNED_TX" "L2" > /dev/null
    success "Set L1 contract proxy on L2SyncedCounter: $L1_PROXY_ON_L2"

    # Set L1Counter address on L2SyncedCounter (for outgoing calls)
    L2_NONCE=$(cast nonce $DEPLOYER --rpc-url http://localhost:$L2_EVM_PORT)
    CALLDATA=$(cast calldata "setL1Counter(address)" $L1_CONTRACT)
    SIGNED_TX=$(cast mktx --private-key $DEPLOYER_PK \
        --rpc-url http://localhost:$L2_EVM_PORT \
        --legacy \
        --nonce $L2_NONCE \
        --gas-limit 100000 \
        --gas-price 0 \
        $L2_CONTRACT \
        "$CALLDATA")
    submit_tx "$SIGNED_TX" "L2" > /dev/null
    success "Set L1Counter address on L2SyncedCounter"

    # Export for other functions
    export L1_CONTRACT
    export L2_CONTRACT
    export L2_PROXY
    export L1_PROXY_ON_L2
}

test_proxy_hint_mechanism() {
    echo ""
    echo -e "${YELLOW}========================================${NC}"
    echo -e "${YELLOW}   Testing Proxy Hint Mechanism${NC}"
    echo -e "${YELLOW}========================================${NC}"
    echo ""

    # ============================================================
    # TEST 1: Call setValue WITHOUT hint - should FAIL
    # The L1SenderProxyL2 for L1SyncedCounter is not deployed yet
    # ============================================================
    log "TEST 1: Calling L1SyncedCounter.setValue(42) WITHOUT hint..."
    log "  Expected: FAIL (L1SenderProxyL2 not deployed on L2)"

    NONCE=$(cast nonce $DEPLOYER --rpc-url http://localhost:$L1_PORT)
    CALLDATA=$(cast calldata "setValue(uint256)" 42)
    SIGNED_TX=$(cast mktx --private-key $DEPLOYER_PK \
        --rpc-url http://localhost:$L1_PORT \
        --legacy \
        --nonce $NONCE \
        --gas-limit 500000 \
        --gas-price 2000000000 \
        $L1_CONTRACT \
        "$CALLDATA")

    # Submit WITHOUT hints
    RESULT=$(submit_tx "$SIGNED_TX" "L1")

    # Check if we got an error from builder
    if echo "$RESULT" | grep -qi "error"; then
        success "TEST 1 PASSED: Builder returned error (expected)"
        echo "  Error: $(echo "$RESULT" | jq -r '.error // .message // .')"
    else
        # Builder returned success - but check if the actual L1 tx reverted
        TX_HASH=$(echo "$RESULT" | jq -r '.l1TxHash')
        if [ -n "$TX_HASH" ] && [ "$TX_HASH" != "null" ]; then
            TX_STATUS=$(cast receipt $TX_HASH --rpc-url http://localhost:$L1_PORT 2>/dev/null | grep status | awk '{print $2}')
            if [ "$TX_STATUS" = "0" ] || [ "$TX_STATUS" = "false" ]; then
                success "TEST 1 PASSED: L1 transaction reverted as expected"
                echo "  TX Hash: $TX_HASH"
                echo "  Status: $TX_STATUS (reverted)"
            else
                # TX succeeded - check if the value was actually set
                L1_VALUE=$(cast call $L1_CONTRACT "value()(uint256)" --rpc-url http://localhost:$L1_PORT 2>/dev/null || echo "0")
                if [ "$L1_VALUE" = "0" ]; then
                    success "TEST 1 PASSED: L1 tx succeeded but value unchanged (call must have reverted internally)"
                else
                    warn "TEST 1 UNEXPECTED: Transaction succeeded and value was set to $L1_VALUE"
                    echo "  This means the L1→L2 call succeeded without hints - checking why..."
                    # Check if there's a registered response
                    echo "  Fullnode logs:"
                    tail -10 logs/fullnode.log
                fi
            fi
        else
            warn "TEST 1: No transaction hash returned"
            echo "  Result: $RESULT"
        fi
    fi

    echo ""

    # ============================================================
    # TEST 2: Call setValue WITH hint - should SUCCEED
    # The builder should deploy L1SenderProxyL2 before execution
    # ============================================================
    log "TEST 2: Calling L1SyncedCounter.setValue(42) WITH hint..."
    log "  Hint: l2Addresses = [$L2_CONTRACT]"
    log "  Expected: SUCCESS (builder deploys L1SenderProxyL2 first)"

    # Use fresh nonce (previous tx should have failed, so same nonce)
    NONCE=$(cast nonce $DEPLOYER --rpc-url http://localhost:$L1_PORT)
    SIGNED_TX=$(cast mktx --private-key $DEPLOYER_PK \
        --rpc-url http://localhost:$L1_PORT \
        --legacy \
        --nonce $NONCE \
        --gas-limit 500000 \
        --gas-price 2000000000 \
        $L1_CONTRACT \
        "$CALLDATA")

    # Submit WITH hints
    RESULT=$(submit_tx "$SIGNED_TX" "L1" "{\"isContractCall\": true, \"l2Addresses\": [\"$L2_CONTRACT\"]}")

    if echo "$RESULT" | grep -qi "error\|fail\|revert"; then
        error "TEST 2 FAILED: Transaction failed unexpectedly"
        echo "  Error: $(echo "$RESULT" | jq -r '.error // .message // .')"
        # Check builder logs for more info
        echo ""
        echo "Builder logs:"
        tail -20 logs/builder.log
        exit 1
    else
        success "TEST 2 PASSED: Transaction succeeded with hint"
        echo "  Result: $(echo "$RESULT" | jq -c '.')"
    fi

    echo ""

    # Verify the value was set on both chains
    log "Verifying sync..."
    L1_VALUE=$(cast call $L1_CONTRACT "value()(uint256)" --rpc-url http://localhost:$L1_PORT)
    L2_VALUE=$(cast call $L2_CONTRACT "value()(uint256)" --rpc-url http://localhost:$L2_EVM_PORT)

    echo "  L1SyncedCounter.value() = $L1_VALUE"
    echo "  L2SyncedCounter.value() = $L2_VALUE"

    if [ "$L1_VALUE" = "$L2_VALUE" ] && [ "$L1_VALUE" = "42" ]; then
        success "Values are synced correctly: $L1_VALUE"
    else
        error "Value mismatch: L1=$L1_VALUE, L2=$L2_VALUE"
    fi
}

save_state() {
    log "Saving L1 state..."

    mkdir -p "$STATE_DIR"

    # Dump state
    curl -s -X POST http://localhost:$L1_PORT \
        -H "Content-Type: application/json" \
        -d '{"jsonrpc":"2.0","method":"anvil_dumpState","params":[],"id":1}' \
        | jq -r '.result' > "$L1_STATE_FILE"

    local size=$(ls -lh "$L1_STATE_FILE" | awk '{print $5}')
    success "Saved L1 state to $L1_STATE_FILE ($size)"
}

update_start_script() {
    log "Updating start.sh with new contract addresses..."

    # Update the contract addresses in start.sh
    sed -i.bak "s/ROLLUP_ADDRESS=.*/ROLLUP_ADDRESS=\"$ROLLUP_ADDRESS\"/" start.sh
    sed -i.bak "s/VERIFIER_ADDRESS=.*/VERIFIER_ADDRESS=\"$VERIFIER_ADDRESS\"/" start.sh
    sed -i.bak "s/L1_SYNCED_COUNTER=.*/L1_SYNCED_COUNTER=\"$L1_CONTRACT\"/" start.sh
    sed -i.bak "s/L2_SYNCED_COUNTER=.*/L2_SYNCED_COUNTER=\"$L2_CONTRACT\"/" start.sh
    sed -i.bak "s/L1_PROXY_ON_L2=.*/L1_PROXY_ON_L2=\"$L1_PROXY_ON_L2\"/" start.sh
    rm -f start.sh.bak

    success "Updated start.sh with new addresses"
}

main() {
    echo ""
    echo -e "${BLUE}╔═══════════════════════════════════════╗${NC}"
    echo -e "${BLUE}║   Native Rollup - Fresh Setup         ║${NC}"
    echo -e "${BLUE}║   (New Architecture)                  ║${NC}"
    echo -e "${BLUE}╚═══════════════════════════════════════╝${NC}"
    echo ""

    # Cleanup
    cleanup

    # Start L1
    start_l1

    # Deploy core contracts first (we need ROLLUP_ADDRESS for fullnode)
    # But fullnode needs genesis hash... chicken and egg problem
    # Solution: deploy contracts with a placeholder genesis, then update

    # For now, deploy with genesis hash = 0 (will update after fullnode starts)
    log "Deploying contracts (will sync genesis later)..."

    # Compile contracts if needed
    if [ ! -d "out" ]; then
        log "Compiling contracts..."
        forge build
    fi

    # Deploy with placeholder genesis (fullnode will calculate real one)
    GENESIS_HASH="0x0000000000000000000000000000000000000000000000000000000000000000"
    DEPLOY_OUTPUT=$(GENESIS_HASH=$GENESIS_HASH ADMIN=$ADMIN_ADDRESS forge script script/Deploy.s.sol:DeployScript \
        --rpc-url http://localhost:$L1_PORT \
        --private-key $ADMIN_PRIVATE_KEY \
        --broadcast 2>&1)

    VERIFIER_ADDRESS=$(echo "$DEPLOY_OUTPUT" | grep "AdminProofVerifier:" | awk '{print $2}')
    ROLLUP_ADDRESS=$(echo "$DEPLOY_OUTPUT" | grep "NativeRollupCore:" | awk '{print $2}')

    if [ -z "$ROLLUP_ADDRESS" ]; then
        error "Failed to deploy contracts"
        echo "$DEPLOY_OUTPUT"
        exit 1
    fi

    success "AdminProofVerifier deployed at: $VERIFIER_ADDRESS"
    success "NativeRollupCore deployed at: $ROLLUP_ADDRESS"
    export ROLLUP_ADDRESS
    export VERIFIER_ADDRESS

    # Now start fullnode (it will calculate its genesis state)
    start_fullnode

    # Get the fullnode's genesis state and update L1 contract
    GENESIS_STATE=$(curl -s http://localhost:$FULLNODE_RPC_PORT -X POST -H "Content-Type: application/json" \
        -d '{"jsonrpc":"2.0","method":"nativerollup_getStateRoot","params":[],"id":1}' | jq -r '.result')
    log "Syncing L1 contract to fullnode genesis: $GENESIS_STATE"

    # Update L1 contract's l2BlockHash to match fullnode genesis
    curl -s -X POST http://localhost:$L1_PORT -H "Content-Type: application/json" \
        -d "{\"jsonrpc\":\"2.0\",\"method\":\"anvil_setStorageAt\",\"params\":[\"$ROLLUP_ADDRESS\",\"0x0\",\"$GENESIS_STATE\"],\"id\":1}" > /dev/null

    # Get fullnode block number and sync
    FULLNODE_BLOCK=$(curl -s http://localhost:$FULLNODE_RPC_PORT -X POST -H "Content-Type: application/json" \
        -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' | jq -r '.result')
    BLOCK_NUM_PADDED=$(printf '0x%064x' $((16#${FULLNODE_BLOCK:2})))
    curl -s -X POST http://localhost:$L1_PORT -H "Content-Type: application/json" \
        -d "{\"jsonrpc\":\"2.0\",\"method\":\"anvil_setStorageAt\",\"params\":[\"$ROLLUP_ADDRESS\",\"0x1\",\"$BLOCK_NUM_PADDED\"],\"id\":1}" > /dev/null

    success "L1 contract synced to fullnode state"

    # Start builder
    start_builder

    # Start proxies and frontend
    start_proxies
    start_frontend

    # Deploy SyncedCounter contracts
    deploy_synced_counters

    # Test the proxy hint mechanism
    test_proxy_hint_mechanism

    # Save state
    save_state

    # Update start.sh with new addresses
    update_start_script

    echo ""
    echo -e "${GREEN}========================================${NC}"
    echo -e "${GREEN}   Setup Complete!${NC}"
    echo -e "${GREEN}========================================${NC}"
    echo ""
    echo "  State saved to: $L1_STATE_FILE"
    echo ""
    echo "  Deployed contracts:"
    echo "    NativeRollupCore:   $ROLLUP_ADDRESS"
    echo "    AdminProofVerifier: $VERIFIER_ADDRESS"
    echo "    L1SyncedCounter:    $L1_CONTRACT"
    echo "    L2SyncedCounter:    $L2_CONTRACT"
    echo "    L2Proxy (on L1):    $L2_PROXY"
    echo "    L1Proxy (on L2):    $L1_PROXY_ON_L2"
    echo ""
    echo "  To start the system:"
    echo "    ./start.sh"
    echo ""

    # Keep running for manual testing
    log "System running. Press Ctrl+C to stop."
    trap 'cleanup; exit 0' SIGINT SIGTERM
    tail -f logs/*.log 2>/dev/null || wait
}

main "$@"
