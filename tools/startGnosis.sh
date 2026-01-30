#!/bin/bash
#
# Native Rollup - Gnosis Mainnet Startup Script
#
# Reads configuration from .env file (see .env.example).
#
# Two modes:
#   Full mode  (ADMIN_PRIVATE_KEY set):     fullnode + builder + proxies + frontend
#   Read-only  (ADMIN_PRIVATE_KEY missing): fullnode + frontend only
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log()     { echo -e "${BLUE}[$(date +%H:%M:%S)]${NC} $1"; }
success() { echo -e "${GREEN}[$(date +%H:%M:%S)] ✓${NC} $1"; }
error()   { echo -e "${RED}[$(date +%H:%M:%S)] ✗${NC} $1"; }
warn()    { echo -e "${YELLOW}[$(date +%H:%M:%S)] !${NC} $1"; }

# ---- Load .env ----

ENV_FILE="${ENV_FILE:-.env}"

if [ -f "$ENV_FILE" ]; then
    log "Loading config from $ENV_FILE"
    set -a
    source "$ENV_FILE"
    set +a
else
    error "No .env file found. Copy .env.example to .env and configure it:"
    echo "  cp .env.example .env"
    exit 1
fi

# ---- Fallback: read from gnosis-deployment.json if env vars missing ----

DEPLOYMENT_FILE="gnosis-deployment.json"

if [ -z "$ROLLUP_ADDRESS" ] || [ -z "$DEPLOYMENT_BLOCK" ]; then
    if [ -f "$DEPLOYMENT_FILE" ]; then
        warn "Reading missing values from $DEPLOYMENT_FILE"
        ROLLUP_ADDRESS="${ROLLUP_ADDRESS:-$(python3 -c "import json; print(json.load(open('$DEPLOYMENT_FILE'))['rollupAddress'])")}"
        VERIFIER_ADDRESS="${VERIFIER_ADDRESS:-$(python3 -c "import json; print(json.load(open('$DEPLOYMENT_FILE'))['verifierAddress'])")}"
        DEPLOYMENT_BLOCK="${DEPLOYMENT_BLOCK:-$(python3 -c "import json; print(json.load(open('$DEPLOYMENT_FILE'))['deploymentBlock'])")}"
        L1_RPC="${L1_RPC:-$(python3 -c "import json; print(json.load(open('$DEPLOYMENT_FILE'))['l1Rpc'])")}"
    else
        error "ROLLUP_ADDRESS and DEPLOYMENT_BLOCK must be set in .env (or provide gnosis-deployment.json)"
        exit 1
    fi
fi

L1_RPC="${L1_RPC:-https://rpc.gnosischain.com}"

# ---- Ports (with defaults) ----

L2_EVM_PORT="${L2_EVM_PORT:-9546}"
FULLNODE_RPC_PORT="${FULLNODE_RPC_PORT:-9547}"
BUILDER_L2_PORT="${BUILDER_L2_PORT:-9549}"
BUILDER_FULLNODE_PORT="${BUILDER_FULLNODE_PORT:-9550}"
BUILDER_PORT="${BUILDER_PORT:-3200}"
L1_PROXY_PORT="${L1_PROXY_PORT:-8646}"
L2_PROXY_PORT="${L2_PROXY_PORT:-9648}"
FRONTEND_PORT="${FRONTEND_PORT:-8180}"

# ---- Determine mode ----

if [ -n "$ADMIN_PRIVATE_KEY" ]; then
    MODE="full"
else
    MODE="readonly"
fi

# ---- Print config ----

log "Config:"
log "  Rollup:           $ROLLUP_ADDRESS"
log "  Verifier:         ${VERIFIER_ADDRESS:-<not set>}"
log "  Deployment Block: $DEPLOYMENT_BLOCK"
log "  L1 RPC:           $L1_RPC"
if [ "$MODE" = "full" ]; then
    log "  Mode:             ${GREEN}Full (builder + proxies)${NC}"
else
    log "  Mode:             ${YELLOW}Read-only (no builder)${NC}"
fi

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

    npx tsx l2fullnode/l2-fullnode.ts \
        --l1-rpc "$L1_RPC" \
        --rollup "$ROLLUP_ADDRESS" \
        --l2-port $L2_EVM_PORT \
        --rpc-port $FULLNODE_RPC_PORT \
        --l1-start-block "$DEPLOYMENT_BLOCK" \
        > logs/fullnode.log 2>&1 &

    sleep 3

    if wait_for_rpc "http://localhost:$L2_EVM_PORT" "L2 EVM"; then
        success "L2 EVM started (port $L2_EVM_PORT)"
    else
        error "Failed to start L2 EVM"
        cat logs/fullnode.log
        exit 1
    fi

    if wait_for_rpc "http://localhost:$FULLNODE_RPC_PORT" "Fullnode RPC"; then
        success "Fullnode RPC started (port $FULLNODE_RPC_PORT)"
    else
        error "Failed to start Fullnode RPC"
        cat logs/fullnode.log
        exit 1
    fi
}

start_builder_fullnode() {
    log "Starting Builder's private L2 Fullnode..."

    npx tsx l2fullnode/l2-fullnode.ts \
        --l1-rpc "$L1_RPC" \
        --rollup "$ROLLUP_ADDRESS" \
        --l2-port $BUILDER_L2_PORT \
        --rpc-port $BUILDER_FULLNODE_PORT \
        --l1-start-block "$DEPLOYMENT_BLOCK" \
        > logs/builder-fullnode.log 2>&1 &

    sleep 3

    if wait_for_rpc "http://localhost:$BUILDER_L2_PORT" "Builder L2 EVM"; then
        success "Builder L2 EVM started (port $BUILDER_L2_PORT)"
    else
        error "Failed to start Builder L2 EVM"
        cat logs/builder-fullnode.log
        exit 1
    fi

    if wait_for_rpc "http://localhost:$BUILDER_FULLNODE_PORT" "Builder Fullnode RPC"; then
        success "Builder Fullnode RPC started (port $BUILDER_FULLNODE_PORT)"
    else
        error "Failed to start Builder Fullnode RPC"
        cat logs/builder-fullnode.log
        exit 1
    fi
}

start_builder() {
    log "Starting Builder on port $BUILDER_PORT..."

    npx tsx builder/builder.ts \
        --l1-rpc "$L1_RPC" \
        --fullnode "http://localhost:$BUILDER_FULLNODE_PORT" \
        --rollup "$ROLLUP_ADDRESS" \
        --admin-key "$ADMIN_PRIVATE_KEY" \
        --port $BUILDER_PORT \
        > logs/builder.log 2>&1 &

    sleep 2

    if curl -s "http://localhost:$BUILDER_PORT/status" > /dev/null 2>&1; then
        success "Builder started (port $BUILDER_PORT)"
    else
        error "Failed to start Builder"
        cat logs/builder.log
        exit 1
    fi
}

start_rpc_proxies() {
    log "Starting RPC Proxies..."

    npx tsx builder/rpc-proxy.ts \
        --rpc "$L1_RPC" \
        --builder http://localhost:$BUILDER_PORT \
        --port $L1_PROXY_PORT \
        > logs/l1-proxy.log 2>&1 &

    npx tsx builder/l2-rpc-proxy.ts \
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

    L1_STATE=$(cast call $ROLLUP_ADDRESS "l2BlockHash()" --rpc-url "$L1_RPC" 2>/dev/null || echo "?")

    L2_STATE=$(curl -s http://localhost:$FULLNODE_RPC_PORT -X POST -H "Content-Type: application/json" \
        -d '{"jsonrpc":"2.0","method":"nativerollup_getStateRoot","params":[],"id":1}' 2>/dev/null \
        | python3 -c "import sys, json; print(json.loads(sys.stdin.read()).get('result', 'ERROR'))" 2>/dev/null || echo "?")

    if [ "$L1_STATE" = "$L2_STATE" ]; then
        success "L1 and L2 state roots MATCH: ${L1_STATE:0:18}..."
    else
        warn "State root mismatch (may still be syncing):"
        echo "  L1 expects: $L1_STATE"
        echo "  L2 has:     $L2_STATE"
    fi
}

print_summary() {
    echo ""
    if [ "$MODE" = "full" ]; then
        echo -e "${GREEN}===========================================${NC}"
        echo -e "${GREEN}   Native Rollup POC - Gnosis L1 - Ready!${NC}"
        echo -e "${GREEN}===========================================${NC}"
    else
        echo -e "${YELLOW}===========================================${NC}"
        echo -e "${YELLOW}   Native Rollup POC - Read-Only Mode     ${NC}"
        echo -e "${YELLOW}===========================================${NC}"
    fi
    echo ""
    echo -e "  ${BLUE}L1 RPC (Gnosis):${NC}     $L1_RPC"
    echo -e "  ${BLUE}L2 Fullnode RPC:${NC}     http://localhost:$FULLNODE_RPC_PORT"
    echo -e "  ${BLUE}Frontend:${NC}            http://localhost:$FRONTEND_PORT"

    if [ "$MODE" = "full" ]; then
        echo -e "  ${BLUE}L1 RPC (proxy):${NC}      http://localhost:$L1_PROXY_PORT  <- Use in wallet"
        echo -e "  ${BLUE}L2 RPC (proxy):${NC}      http://localhost:$L2_PROXY_PORT  <- Use in wallet"
        echo -e "  ${BLUE}Builder API:${NC}         http://localhost:$BUILDER_PORT"
    else
        echo ""
        echo -e "  ${YELLOW}Builder not running. To enable, set ADMIN_PRIVATE_KEY in .env${NC}"
    fi

    echo ""
    echo -e "  ${BLUE}Contracts (Gnosis L1):${NC}"
    echo -e "    NativeRollupCore:    $ROLLUP_ADDRESS"
    echo -e "    AdminProofVerifier:  ${VERIFIER_ADDRESS:-<not set>}"
    echo ""
    echo -e "  ${YELLOW}Logs:${NC} logs/"
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

    # Always start read-only fullnode + frontend
    start_fullnode
    start_frontend

    # Full mode: also start builder + proxies
    if [ "$MODE" = "full" ]; then
        start_builder_fullnode
        start_builder
        start_rpc_proxies
    fi

    verify_sync
    print_summary

    # Keep script running and forward signals
    trap 'cleanup; exit 0' SIGINT SIGTERM

    log "Tailing logs (Ctrl+C to stop)..."
    tail -f logs/*.log 2>/dev/null || wait
}

main "$@"
