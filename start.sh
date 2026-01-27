#!/bin/bash
#
# Native Rollup - Complete Setup Script
#
# This script starts all components needed for the Native Rollup POC:
# 1. L1 Anvil (loads pre-deployed state with contracts + SyncedCounter)
# 2. Deterministic Fullnode (syncs from L1 events)
# 3. Deterministic Builder
# 4. Frontend server
#
# The L1 state includes:
# - NativeRollupCore with all infrastructure
# - L1SyncedCounter and L2SyncedCounter deployed
# - 1 ETH deposited to deployer on L2
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

# Pre-deployed contract addresses (from saved state)
ROLLUP_ADDRESS="0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512"
VERIFIER_ADDRESS="0x5FbDB2315678afecb367f032d93F642f64180aa3"
L1_SYNCED_COUNTER="0x2E983A1Ba5e8b38AAAeC4B440B9dDcFBf72E15d1"
L2_SYNCED_COUNTER="0x663F3ad617193148711d28f5334eE4Ed07016602"
L1_PROXY_ON_L2="0xc7b2ddde61c78714fbc7678e6f8236f517f0c16c"

# Keys
ADMIN_PRIVATE_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
ADMIN_ADDRESS="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"

# State file
L1_STATE_FILE="state/l1-state.json"

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

start_l1_with_state() {
    if [ ! -f "$L1_STATE_FILE" ]; then
        error "L1 state file not found: $L1_STATE_FILE"
        error "Run './setup-fresh.sh' first to create initial state"
        exit 1
    fi

    log "Starting L1 Anvil..."
    anvil --port $L1_PORT --chain-id 31337 --silent &

    if ! wait_for_rpc "http://localhost:$L1_PORT" "L1 Anvil"; then
        error "Failed to start L1 Anvil"
        exit 1
    fi

    # Load the saved state via RPC
    log "Loading pre-deployed state..."
    local state=$(cat "$L1_STATE_FILE")
    local result=$(curl -s -X POST http://localhost:$L1_PORT \
        -H "Content-Type: application/json" \
        -d "{\"jsonrpc\":\"2.0\",\"method\":\"anvil_loadState\",\"params\":[\"$state\"],\"id\":1}")

    if echo "$result" | grep -q '"result":true'; then
        success "L1 state loaded successfully"
    else
        error "Failed to load L1 state: $result"
        exit 1
    fi

    # Verify contracts are deployed
    local code=$(cast code $ROLLUP_ADDRESS --rpc-url http://localhost:$L1_PORT 2>/dev/null || echo "0x")
    if [ "$code" = "0x" ]; then
        error "NativeRollupCore not found at $ROLLUP_ADDRESS"
        error "State file may be corrupted. Run './setup-fresh.sh' to recreate"
        exit 1
    fi
    success "Verified NativeRollupCore at $ROLLUP_ADDRESS"
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
    # Get current L2 state
    local L2_BLOCK=$(curl -s http://localhost:$L2_PORT -X POST -H "Content-Type: application/json" \
        -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' 2>/dev/null \
        | python3 -c "import sys, json; print(int(json.loads(sys.stdin.read())['result'], 16))" 2>/dev/null || echo "?")

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
    echo -e "  ${BLUE}Contracts:${NC}"
    echo -e "    NativeRollupCore:  $ROLLUP_ADDRESS"
    echo -e "    L1SyncedCounter:   $L1_SYNCED_COUNTER"
    echo -e "    L2SyncedCounter:   $L2_SYNCED_COUNTER"
    echo ""
    echo -e "  ${BLUE}L2 Status:${NC}"
    echo -e "    Block Number: $L2_BLOCK"
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
        success "L1 and L2 state roots MATCH: ${L1_STATE:0:18}..."
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

    # Start L1 with pre-deployed state
    start_l1_with_state

    # Start fullnode (will sync from L1 events)
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
