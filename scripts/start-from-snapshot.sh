#!/bin/bash
#
# Start the synchronous surge demo from a saved L1 snapshot
#
# This script:
# 1. Starts Anvil with forked state from Gnosis (or fresh)
# 2. Deploys all contracts if starting fresh
# 3. Starts the L2 fullnode (syncs from L1 events)
# 4. Starts the builder
# 5. Starts the RPC proxies
# 6. Starts the frontend
#
# Usage:
#   ./scripts/start-from-snapshot.sh [--fresh]
#
#   --fresh: Deploy everything from scratch instead of using snapshot
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

# Contract addresses (from snapshot)
ROLLUP="0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512"
L1_SYNCED_COUNTER="0x663F3ad617193148711d28f5334eE4Ed07016602"
L2_SENDER_PROXY="0xc5AdD61254C6CB1dA0929A571A5D13B1EaC36281"
SYNC_DEMO="0x610178dA211FEF7D417bC0e6FeD39F05609AD788"

# Ports
L1_PORT=8545
L2_EVM_PORT=9546
FULLNODE_RPC_PORT=9547
L2_PROXY_PORT=9548
L1_PROXY_PORT=8546
BUILDER_PORT=3200
FRONTEND_PORT=8080

# Keys
DEPLOYER_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
DEPLOYER_ADDR="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log() {
  echo -e "${BLUE}[$(date +%H:%M:%S)]${NC} $1"
}

success() {
  echo -e "${GREEN}[$(date +%H:%M:%S)] ✓${NC} $1"
}

warn() {
  echo -e "${YELLOW}[$(date +%H:%M:%S)] ⚠${NC} $1"
}

error() {
  echo -e "${RED}[$(date +%H:%M:%S)] ✗${NC} $1"
}

# Parse arguments
FRESH_DEPLOY=false
for arg in "$@"; do
  case $arg in
    --fresh)
      FRESH_DEPLOY=true
      ;;
  esac
done

# Create logs directory
mkdir -p logs

# Kill any existing processes
log "Stopping any existing processes..."
pkill -f "anvil.*$L1_PORT" 2>/dev/null || true
pkill -f "l2-fullnode.ts" 2>/dev/null || true
pkill -f "builder.ts" 2>/dev/null || true
pkill -f "rpc-proxy.ts" 2>/dev/null || true
pkill -f "l2-rpc-proxy.ts" 2>/dev/null || true
lsof -ti:$L1_PORT | xargs kill -9 2>/dev/null || true
lsof -ti:$L2_EVM_PORT | xargs kill -9 2>/dev/null || true
lsof -ti:$FULLNODE_RPC_PORT | xargs kill -9 2>/dev/null || true
lsof -ti:$L2_PROXY_PORT | xargs kill -9 2>/dev/null || true
lsof -ti:$L1_PROXY_PORT | xargs kill -9 2>/dev/null || true
lsof -ti:$BUILDER_PORT | xargs kill -9 2>/dev/null || true
sleep 2

echo ""
echo "=============================================="
echo "   Synchronous Surge Demo"
echo "=============================================="
echo ""

# Step 1: Start Anvil (L1)
log "Starting Anvil (L1) on port $L1_PORT..."
anvil \
  --port $L1_PORT \
  --chain-id 31337 \
  --silent \
  > logs/anvil.log 2>&1 &

# Wait for Anvil
for i in {1..30}; do
  if curl -s http://localhost:$L1_PORT -X POST -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' 2>/dev/null | grep -q result; then
    success "Anvil started"
    break
  fi
  sleep 0.5
  if [ $i -eq 30 ]; then
    error "Anvil failed to start"
    exit 1
  fi
done

# Step 2: Deploy contracts (if fresh) or verify existing
if [ "$FRESH_DEPLOY" = true ]; then
  log "Fresh deployment requested - deploying all contracts..."

  # Deploy NativeRollupCore
  log "Deploying NativeRollupCore..."
  ROLLUP=$(forge create src/NativeRollupCore.sol:NativeRollupCore \
    --rpc-url http://localhost:$L1_PORT \
    --private-key $DEPLOYER_KEY \
    --broadcast 2>/dev/null | grep "Deployed to:" | awk '{print $3}')
  success "NativeRollupCore: $ROLLUP"

  # Deploy L1SyncedCounter
  log "Deploying L1SyncedCounter..."
  L1_SYNCED_COUNTER=$(forge create src/examples/SyncedCounter.sol:L1SyncedCounter \
    --rpc-url http://localhost:$L1_PORT \
    --private-key $DEPLOYER_KEY \
    --broadcast 2>/dev/null | grep "Deployed to:" | awk '{print $3}')
  success "L1SyncedCounter: $L1_SYNCED_COUNTER"

  # Deploy SyncDemo
  log "Deploying SyncDemo..."
  SYNC_DEMO=$(forge create src/examples/SyncDemo.sol:SyncDemo \
    --rpc-url http://localhost:$L1_PORT \
    --private-key $DEPLOYER_KEY \
    --broadcast 2>/dev/null | grep "Deployed to:" | awk '{print $3}')
  success "SyncDemo: $SYNC_DEMO"

  warn "Fresh deployment complete. You'll need to:"
  warn "  1. Deploy L2SyncedCounter via builder"
  warn "  2. Set up proxies and initialize contracts"

else
  log "Using pre-deployed contracts from snapshot..."

  # Redeploy contracts at same addresses by running deployment script
  log "Deploying contracts..."

  # Deploy NativeRollupCore
  RESULT=$(forge create src/NativeRollupCore.sol:NativeRollupCore \
    --rpc-url http://localhost:$L1_PORT \
    --private-key $DEPLOYER_KEY \
    --broadcast 2>&1)
  ROLLUP=$(echo "$RESULT" | grep "Deployed to:" | awk '{print $3}')
  success "NativeRollupCore: $ROLLUP"

  # Deploy L1SyncedCounter
  RESULT=$(forge create src/examples/SyncedCounter.sol:L1SyncedCounter \
    --rpc-url http://localhost:$L1_PORT \
    --private-key $DEPLOYER_KEY \
    --broadcast 2>&1)
  L1_SYNCED_COUNTER=$(echo "$RESULT" | grep "Deployed to:" | awk '{print $3}')
  success "L1SyncedCounter: $L1_SYNCED_COUNTER"

  # Deploy SyncDemo
  RESULT=$(forge create src/examples/SyncDemo.sol:SyncDemo \
    --rpc-url http://localhost:$L1_PORT \
    --private-key $DEPLOYER_KEY \
    --broadcast 2>&1)
  SYNC_DEMO=$(echo "$RESULT" | grep "Deployed to:" | awk '{print $3}')
  success "SyncDemo: $SYNC_DEMO"
fi

# Step 3: Start L2 Fullnode
log "Starting L2 Fullnode..."
npx tsx fullnode/l2-fullnode.ts \
  --l1-rpc http://localhost:$L1_PORT \
  --rollup $ROLLUP \
  --l2-port $L2_EVM_PORT \
  --rpc-port $FULLNODE_RPC_PORT \
  > logs/fullnode.log 2>&1 &

# Wait for fullnode
for i in {1..30}; do
  if curl -s http://localhost:$FULLNODE_RPC_PORT -X POST -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","method":"nativerollup_getStateRoot","params":[],"id":1}' 2>/dev/null | grep -q result; then
    success "Fullnode started"
    break
  fi
  sleep 1
  if [ $i -eq 30 ]; then
    error "Fullnode failed to start"
    cat logs/fullnode.log
    exit 1
  fi
done

# Step 4: Start Builder
log "Starting Builder..."
npx tsx scripts/builder.ts \
  --l1-rpc http://localhost:$L1_PORT \
  --fullnode http://localhost:$FULLNODE_RPC_PORT \
  --rollup $ROLLUP \
  --port $BUILDER_PORT \
  > logs/builder.log 2>&1 &

# Wait for builder
for i in {1..15}; do
  if curl -s http://localhost:$BUILDER_PORT/status 2>/dev/null | grep -q isSynced; then
    success "Builder started"
    break
  fi
  sleep 1
  if [ $i -eq 15 ]; then
    error "Builder failed to start"
    cat logs/builder.log
    exit 1
  fi
done

# Step 5: Start L1 RPC Proxy
log "Starting L1 RPC Proxy..."
npx tsx scripts/rpc-proxy.ts \
  --port $L1_PROXY_PORT \
  --rpc http://localhost:$L1_PORT \
  --builder http://localhost:$BUILDER_PORT \
  --rollup $ROLLUP \
  > logs/l1-proxy.log 2>&1 &

sleep 2
success "L1 Proxy started on port $L1_PROXY_PORT"

# Step 6: Start L2 RPC Proxy
log "Starting L2 RPC Proxy..."
npx tsx scripts/l2-rpc-proxy.ts \
  --port $L2_PROXY_PORT \
  --fullnode http://localhost:$FULLNODE_RPC_PORT \
  --builder http://localhost:$BUILDER_PORT \
  --l2-evm http://localhost:$L2_EVM_PORT \
  > logs/l2-proxy.log 2>&1 &

sleep 2
success "L2 Proxy started on port $L2_PROXY_PORT"

# Step 7: Start Frontend
log "Starting Frontend..."
cd ui && python3 -m http.server $FRONTEND_PORT > ../logs/frontend.log 2>&1 &
cd ..
sleep 1
success "Frontend started on port $FRONTEND_PORT"

echo ""
echo "=============================================="
echo "   All Services Running"
echo "=============================================="
echo ""
echo "Endpoints:"
echo "  Frontend:      http://localhost:$FRONTEND_PORT"
echo "  L1 RPC:        http://localhost:$L1_PORT"
echo "  L1 Proxy:      http://localhost:$L1_PROXY_PORT"
echo "  L2 Fullnode:   http://localhost:$FULLNODE_RPC_PORT"
echo "  L2 Proxy:      http://localhost:$L2_PROXY_PORT"
echo "  Builder:       http://localhost:$BUILDER_PORT"
echo ""
echo "Contracts:"
echo "  Rollup:           $ROLLUP"
echo "  L1SyncedCounter:  $L1_SYNCED_COUNTER"
echo "  SyncDemo:         $SYNC_DEMO"
echo ""
echo "To view logs:"
echo "  tail -f logs/builder.log logs/fullnode.log logs/l1-proxy.log"
echo ""
echo "To stop all services:"
echo "  pkill -f 'anvil|fullnode|builder|rpc-proxy|http.server'"
echo ""
