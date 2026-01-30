#!/bin/bash
#
# Native Rollup - Gnosis Mainnet Startup Script
#
# Like start.sh but uses Gnosis mainnet as L1 (no local L1 Anvil).
# Reads deployment info from gnosis-deployment.json (created by deploy-gnosis.ts).
#
# Required environment:
#   ADMIN_PRIVATE_KEY - Private key for builder admin
#
# Optional environment:
#   L1_RPC - Override L1 RPC URL (default: from gnosis-deployment.json)
#
# This script starts:
# 1. Read-only L2 Fullnode (derives state from L1 events)
# 2. Builder's private L2 Fullnode (for simulation/discovery)
# 3. Builder (uses only its private fullnode RPC)
# 4. RPC Proxies for wallet connections
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

# Deployment config file
DEPLOYMENT_FILE="gnosis-deployment.json"

# Ports (same as start.sh for L2 components)
L2_EVM_PORT=9546              # Internal L2 EVM (Anvil) - read-only fullnode
FULLNODE_RPC_PORT=9547        # Fullnode RPC interface (for frontend/L2 proxy)
BUILDER_L2_PORT=9549          # Internal L2 EVM (Anvil) - builder's private fullnode
BUILDER_FULLNODE_PORT=9550    # Builder's private fullnode RPC
BUILDER_PORT=3200
L1_PROXY_PORT=8646            # L1 RPC Proxy (different from local setup's 8546)
L2_PROXY_PORT=9648            # L2 RPC Proxy (different from local setup's 9548)
FRONTEND_PORT=8180            # Frontend (different from local setup's 8080)

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

# ---- Validate prerequisites ----

if [ ! -f "$DEPLOYMENT_FILE" ]; then
    error "Deployment file not found: $DEPLOYMENT_FILE"
    error "Run 'ADMIN_PK=0x... npx tsx scripts/deploy-gnosis.ts --deploy' first"
    exit 1
fi

if [ -z "$ADMIN_PRIVATE_KEY" ]; then
    error "ADMIN_PRIVATE_KEY environment variable is required"
    error "Usage: ADMIN_PRIVATE_KEY=0x... ./startGnosis.sh"
    exit 1
fi

# Read deployment config
ROLLUP_ADDRESS=$(python3 -c "import json; print(json.load(open('$DEPLOYMENT_FILE'))['rollupAddress'])")
VERIFIER_ADDRESS=$(python3 -c "import json; print(json.load(open('$DEPLOYMENT_FILE'))['verifierAddress'])")
DEPLOYMENT_BLOCK=$(python3 -c "import json; print(json.load(open('$DEPLOYMENT_FILE'))['deploymentBlock'])")
DEFAULT_L1_RPC=$(python3 -c "import json; print(json.load(open('$DEPLOYMENT_FILE'))['l1Rpc'])")

L1_RPC_URL="${L1_RPC:-$DEFAULT_L1_RPC}"

log "Config from $DEPLOYMENT_FILE:"
log "  Rollup:           $ROLLUP_ADDRESS"
log "  Verifier:         $VERIFIER_ADDRESS"
log "  Deployment Block: $DEPLOYMENT_BLOCK"
log "  L1 RPC:           $L1_RPC_URL"

# ---- Functions ----

cleanup() {
    log "Cleaning up old processes..."
    pkill -f "anvil.*$L2_EVM_PORT" 2>/dev/null || true
    pkill -f "anvil.*$BUILDER_L2_PORT" 2>/dev/null || true
    pkill -f "l2-fullnode" 2>/dev/null || true
    pkill -f "builder.ts" 2>/dev/null || true
    pkill -f "rpc-proxy" 2>/dev/null || true
    pkill -f "l2-rpc-proxy" 2>/dev/null || true
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

start_fullnode() {
    log "Starting L2 Fullnode (read-only)..."
    log "  L2 EVM port: $L2_EVM_PORT"
    log "  Fullnode RPC port: $FULLNODE_RPC_PORT"
    log "  L1 start block: $DEPLOYMENT_BLOCK"

    npx tsx fullnode/l2-fullnode.ts \
        --l1-rpc "$L1_RPC_URL" \
        --rollup "$ROLLUP_ADDRESS" \
        --l2-port $L2_EVM_PORT \
        --rpc-port $FULLNODE_RPC_PORT \
        --l1-start-block "$DEPLOYMENT_BLOCK" \
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
}

start_builder_fullnode() {
    log "Starting Builder's private L2 Fullnode..."
    log "  L2 EVM port: $BUILDER_L2_PORT"
    log "  Fullnode RPC port: $BUILDER_FULLNODE_PORT"

    npx tsx fullnode/l2-fullnode.ts \
        --l1-rpc "$L1_RPC_URL" \
        --rollup "$ROLLUP_ADDRESS" \
        --l2-port $BUILDER_L2_PORT \
        --rpc-port $BUILDER_FULLNODE_PORT \
        --l1-start-block "$DEPLOYMENT_BLOCK" \
        > logs/builder-fullnode.log 2>&1 &

    sleep 3

    if wait_for_rpc "http://localhost:$BUILDER_L2_PORT" "Builder L2 EVM"; then
        success "Builder L2 EVM started"
    else
        error "Failed to start Builder L2 EVM"
        cat logs/builder-fullnode.log
        exit 1
    fi

    if wait_for_rpc "http://localhost:$BUILDER_FULLNODE_PORT" "Builder Fullnode RPC"; then
        success "Builder Fullnode RPC started"
    else
        error "Failed to start Builder Fullnode RPC"
        cat logs/builder-fullnode.log
        exit 1
    fi
}

start_builder() {
    log "Starting Builder on port $BUILDER_PORT..."
    log "  Connecting to Builder Fullnode RPC at http://localhost:$BUILDER_FULLNODE_PORT"

    npx tsx scripts/builder.ts \
        --l1-rpc "$L1_RPC_URL" \
        --fullnode "http://localhost:$BUILDER_FULLNODE_PORT" \
        --rollup "$ROLLUP_ADDRESS" \
        --admin-key "$ADMIN_PRIVATE_KEY" \
        --port $BUILDER_PORT \
        > logs/builder.log 2>&1 &

    sleep 2

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

    # L1 RPC Proxy - intercepts L1 txs and routes through builder
    npx tsx scripts/rpc-proxy.ts \
        --rpc "$L1_RPC_URL" \
        --builder http://localhost:$BUILDER_PORT \
        --port $L1_PROXY_PORT \
        > logs/l1-proxy.log 2>&1 &

    # L2 RPC Proxy - intercepts L2 txs and routes through builder
    npx tsx scripts/l2-rpc-proxy.ts \
        --rpc http://localhost:$FULLNODE_RPC_PORT \
        --builder http://localhost:$BUILDER_PORT \
        --port $L2_PROXY_PORT \
        > logs/l2-proxy.log 2>&1 &

    sleep 2
    success "RPC Proxies started (L1: $L1_PROXY_PORT, L2: $L2_PROXY_PORT)"
}

start_frontend() {
    log "Starting Frontend on port $FRONTEND_PORT..."

    cd ui
    python3 -m http.server $FRONTEND_PORT > ../logs/frontend.log 2>&1 &
    cd ..

    sleep 1
    success "Frontend started at http://localhost:$FRONTEND_PORT"
}

verify_sync() {
    log "Verifying sync status..."

    # Get L1 contract state
    L1_STATE=$(cast call $ROLLUP_ADDRESS "l2BlockHash()" --rpc-url "$L1_RPC_URL")

    # Get L2 fullnode state via our RPC interface
    L2_STATE=$(curl -s http://localhost:$FULLNODE_RPC_PORT -X POST -H "Content-Type: application/json" \
        -d '{"jsonrpc":"2.0","method":"nativerollup_getStateRoot","params":[],"id":1}' 2>/dev/null \
        | python3 -c "import sys, json; print(json.loads(sys.stdin.read()).get('result', 'ERROR'))" 2>/dev/null || echo "?")

    if [ "$L1_STATE" = "$L2_STATE" ]; then
        success "L1 and L2 state roots MATCH: ${L1_STATE:0:18}..."
    else
        warn "State root mismatch:"
        echo "  L1 expects: $L1_STATE"
        echo "  L2 has:     $L2_STATE"
    fi
}

print_summary() {
    echo ""
    echo -e "${GREEN}===========================================${NC}"
    echo -e "${GREEN}   Native Rollup POC - Gnosis L1 - Ready!${NC}"
    echo -e "${GREEN}===========================================${NC}"
    echo ""
    echo -e "  ${BLUE}L1 RPC (Gnosis):${NC}     $L1_RPC_URL"
    echo -e "  ${BLUE}L1 RPC (proxy):${NC}      http://localhost:$L1_PROXY_PORT  <- Use this in wallet"
    echo -e "  ${BLUE}L2 EVM (read-only):${NC}  http://localhost:$L2_EVM_PORT"
    echo -e "  ${BLUE}Fullnode RPC:${NC}        http://localhost:$FULLNODE_RPC_PORT  (read-only)"
    echo -e "  ${BLUE}Builder L2 EVM:${NC}      http://localhost:$BUILDER_L2_PORT  (private)"
    echo -e "  ${BLUE}Builder Fullnode:${NC}    http://localhost:$BUILDER_FULLNODE_PORT  (private)"
    echo -e "  ${BLUE}L2 RPC (proxy):${NC}      http://localhost:$L2_PROXY_PORT  <- Use this in wallet"
    echo -e "  ${BLUE}Builder API:${NC}         http://localhost:$BUILDER_PORT"
    echo -e "  ${BLUE}Frontend:${NC}            http://localhost:$FRONTEND_PORT"
    echo ""
    echo -e "  ${BLUE}Contracts (Gnosis L1):${NC}"
    echo -e "    NativeRollupCore:    $ROLLUP_ADDRESS"
    echo -e "    AdminProofVerifier:  $VERIFIER_ADDRESS"
    echo ""
    echo -e "  ${YELLOW}Logs:${NC}"
    echo "    - Fullnode:  logs/fullnode.log  (read-only)"
    echo "    - Builder Fullnode: logs/builder-fullnode.log  (private)"
    echo "    - Builder:   logs/builder.log"
    echo "    - L1 Proxy:  logs/l1-proxy.log"
    echo "    - L2 Proxy:  logs/l2-proxy.log"
    echo "    - Frontend:  logs/frontend.log"
    echo ""
    echo -e "  ${YELLOW}To stop:${NC} ./stop.sh or Ctrl+C"
    echo ""
}

# ---- Main ----

main() {
    echo ""
    echo -e "${BLUE}╔═══════════════════════════════════════════╗${NC}"
    echo -e "${BLUE}║   Native Rollup POC - Gnosis L1 Setup    ║${NC}"
    echo -e "${BLUE}╚═══════════════════════════════════════════╝${NC}"
    echo ""

    mkdir -p logs

    cleanup

    # No L1 Anvil — using Gnosis mainnet

    start_fullnode
    start_builder_fullnode
    start_builder
    start_rpc_proxies
    start_frontend

    verify_sync
    print_summary

    # Keep script running and forward signals
    trap 'cleanup; exit 0' SIGINT SIGTERM

    log "Tailing logs (Ctrl+C to stop)..."
    tail -f logs/*.log 2>/dev/null || wait
}

main "$@"
