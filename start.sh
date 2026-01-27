#!/bin/bash
#
# Native Rollup - Complete Setup Script
#
# This script starts all components needed for the Native Rollup POC:
# 1. L1 Anvil (fresh chain)
# 2. Deploy NativeRollupCore with correct genesis hash
# 3. Deterministic Fullnode
# 4. Deterministic Builder
# 5. Frontend server
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Ports
L1_PORT=8545
L2_PORT=9546
BUILDER_PORT=3200
FRONTEND_PORT=8080

# Addresses
ADMIN_PRIVATE_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
ADMIN_ADDRESS="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"

# L2 System address (for genesis)
L2_SYSTEM_ADDRESS="0x1000000000000000000000000000000000000001"
L2_SYSTEM_BALANCE="0x204fce5e3e25026110000000" # 10 billion ETH in hex

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
    pkill -f "anvil.*$L2_PORT" 2>/dev/null || true
    pkill -f "anvil.*19999" 2>/dev/null || true
    pkill -f "deterministic-fullnode" 2>/dev/null || true
    pkill -f "deterministic-builder" 2>/dev/null || true
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

calculate_genesis_hash() {
    log "Calculating deterministic genesis hash..."

    # Start temporary anvil to calculate genesis
    anvil --port 19999 --chain-id 10200200 --accounts 0 --silent &
    local temp_pid=$!
    sleep 2

    # Fund system address
    curl -s http://localhost:19999 -X POST -H "Content-Type: application/json" \
        -d "{\"jsonrpc\":\"2.0\",\"method\":\"anvil_setBalance\",\"params\":[\"$L2_SYSTEM_ADDRESS\", \"$L2_SYSTEM_BALANCE\"],\"id\":1}" > /dev/null

    # Mine a block
    curl -s http://localhost:19999 -X POST -H "Content-Type: application/json" \
        -d '{"jsonrpc":"2.0","method":"evm_mine","params":[],"id":1}' > /dev/null

    # Get state root
    GENESIS_HASH=$(curl -s http://localhost:19999 -X POST -H "Content-Type: application/json" \
        -d '{"jsonrpc":"2.0","method":"eth_getBlockByNumber","params":["latest", false],"id":1}' \
        | python3 -c "import sys, json; print(json.loads(sys.stdin.read())['result']['stateRoot'])")

    kill $temp_pid 2>/dev/null || true
    wait $temp_pid 2>/dev/null || true

    success "Genesis hash: $GENESIS_HASH"
}

start_l1() {
    log "Starting L1 Anvil on port $L1_PORT..."
    # No --block-time means blocks are mined only when transactions are pending
    anvil --port $L1_PORT --chain-id 31337 --silent &

    if wait_for_rpc "http://localhost:$L1_PORT" "L1 Anvil"; then
        success "L1 Anvil started (auto-mine mode)"
    else
        error "Failed to start L1 Anvil"
        exit 1
    fi
}

deploy_contracts() {
    log "Deploying NativeRollupCore..."

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

    # Verify the genesis hash was set correctly
    STORED_HASH=$(cast call $ROLLUP_ADDRESS "l2BlockHash()(bytes32)" --rpc-url http://localhost:$L1_PORT)
    if [ "$STORED_HASH" = "$GENESIS_HASH" ]; then
        success "Genesis hash verified in contract"
    else
        warn "Genesis hash mismatch! Expected: $GENESIS_HASH, Got: $STORED_HASH"
    fi

    export ROLLUP_ADDRESS
}

start_fullnode() {
    log "Starting Deterministic Fullnode on port $L2_PORT..."

    npx tsx fullnode/deterministic-fullnode.ts \
        --l1-rpc http://localhost:$L1_PORT \
        --rollup $ROLLUP_ADDRESS \
        --port $L2_PORT \
        > logs/fullnode.log 2>&1 &

    sleep 3

    if wait_for_rpc "http://localhost:$L2_PORT" "Fullnode"; then
        success "Fullnode started"
    else
        error "Failed to start Fullnode"
        cat logs/fullnode.log
        exit 1
    fi
}

start_builder() {
    log "Starting Deterministic Builder on port $BUILDER_PORT..."

    npx tsx scripts/deterministic-builder.ts \
        --l1-rpc http://localhost:$L1_PORT \
        --fullnode http://localhost:$L2_PORT \
        --rollup $ROLLUP_ADDRESS \
        --admin-key $ADMIN_PRIVATE_KEY \
        --port $BUILDER_PORT \
        > logs/builder.log 2>&1 &

    sleep 2

    # Check if builder is responding
    if curl -s "http://localhost:$BUILDER_PORT/status" > /dev/null 2>&1; then
        success "Builder started"
    else
        error "Failed to start Builder"
        cat logs/builder.log
        exit 1
    fi
}

start_rpc_proxies() {
    log "Starting RPC Proxies..."

    # L1 RPC Proxy (port 8546) - intercepts L1 txs and routes through builder
    npx tsx scripts/rpc-proxy.ts \
        --rpc http://localhost:$L1_PORT \
        --builder http://localhost:$BUILDER_PORT \
        --port 8546 \
        > logs/l1-proxy.log 2>&1 &

    # L2 RPC Proxy (port 9548) - intercepts L2 txs and routes through builder
    npx tsx scripts/l2-rpc-proxy.ts \
        --rpc http://localhost:$L2_PORT \
        --builder http://localhost:$BUILDER_PORT \
        --port 9548 \
        > logs/l2-proxy.log 2>&1 &

    sleep 2
    success "RPC Proxies started (L1: 8546, L2: 9548)"
}

start_frontend() {
    log "Starting Frontend on port $FRONTEND_PORT..."

    cd ui
    python3 -m http.server $FRONTEND_PORT > ../logs/frontend.log 2>&1 &
    cd ..

    sleep 1
    success "Frontend started at http://localhost:$FRONTEND_PORT"
}

print_summary() {
    echo ""
    echo -e "${GREEN}========================================${NC}"
    echo -e "${GREEN}   Native Rollup POC - Ready!${NC}"
    echo -e "${GREEN}========================================${NC}"
    echo ""
    echo -e "  ${BLUE}L1 RPC (direct):${NC}  http://localhost:$L1_PORT"
    echo -e "  ${BLUE}L1 RPC (proxy):${NC}   http://localhost:8546  <- Use this in wallet"
    echo -e "  ${BLUE}L2 RPC (direct):${NC}  http://localhost:$L2_PORT"
    echo -e "  ${BLUE}L2 RPC (proxy):${NC}   http://localhost:9548  <- Use this in wallet"
    echo -e "  ${BLUE}Builder API:${NC}      http://localhost:$BUILDER_PORT"
    echo -e "  ${BLUE}Frontend:${NC}         http://localhost:$FRONTEND_PORT"
    echo ""
    echo -e "  ${BLUE}NativeRollupCore:${NC} $ROLLUP_ADDRESS"
    echo -e "  ${BLUE}Genesis Hash:${NC}     $GENESIS_HASH"
    echo ""
    echo -e "  ${YELLOW}Logs:${NC}"
    echo "    - Fullnode:  logs/fullnode.log"
    echo "    - Builder:   logs/builder.log"
    echo "    - L1 Proxy:  logs/l1-proxy.log"
    echo "    - L2 Proxy:  logs/l2-proxy.log"
    echo "    - Frontend:  logs/frontend.log"
    echo ""
    echo -e "  ${YELLOW}To stop:${NC} ./stop.sh or Ctrl+C"
    echo ""
}

verify_sync() {
    log "Verifying sync status..."

    # Get L1 contract state
    L1_STATE=$(cast call $ROLLUP_ADDRESS "l2BlockHash()" --rpc-url http://localhost:$L1_PORT)

    # Get L2 fullnode state
    L2_STATE=$(curl -s http://localhost:$L2_PORT -X POST -H "Content-Type: application/json" \
        -d '{"jsonrpc":"2.0","method":"eth_getBlockByNumber","params":["latest", false],"id":1}' \
        | python3 -c "import sys, json; print(json.loads(sys.stdin.read())['result']['stateRoot'])")

    if [ "$L1_STATE" = "$L2_STATE" ]; then
        success "L1 and L2 state roots MATCH: $L1_STATE"
    else
        warn "State root mismatch:"
        echo "  L1 expects: $L1_STATE"
        echo "  L2 has:     $L2_STATE"
    fi
}

main() {
    echo ""
    echo -e "${BLUE}╔═══════════════════════════════════════╗${NC}"
    echo -e "${BLUE}║   Native Rollup POC - Setup Script    ║${NC}"
    echo -e "${BLUE}╚═══════════════════════════════════════╝${NC}"
    echo ""

    # Create logs directory
    mkdir -p logs

    # Cleanup any existing processes
    cleanup

    # Calculate genesis hash first
    calculate_genesis_hash

    # Start L1
    start_l1

    # Deploy contracts
    deploy_contracts

    # Start fullnode
    start_fullnode

    # Start builder
    start_builder

    # Start RPC proxies
    start_rpc_proxies

    # Start frontend
    start_frontend

    # Verify everything is in sync
    verify_sync

    # Print summary
    print_summary

    # Keep script running and forward signals
    trap 'cleanup; exit 0' SIGINT SIGTERM

    # Tail all logs
    log "Tailing logs (Ctrl+C to stop)..."
    tail -f logs/*.log 2>/dev/null || wait
}

main "$@"
