#!/bin/bash
#
# Native Rollup - Gnosis Deployment Script
#
# This script:
# 1. Computes the deterministic genesis state root locally
# 2. Deploys contracts to Gnosis with that genesis hash
# 3. Updates .env with new contract addresses
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

log() {
    echo -e "${BLUE}[$(date +%H:%M:%S)]${NC} $1"
}

success() {
    echo -e "${GREEN}[$(date +%H:%M:%S)] ✓${NC} $1"
}

error() {
    echo -e "${RED}[$(date +%H:%M:%S)] ✗${NC} $1"
}

cleanup() {
    pkill -f "anvil.*19999" 2>/dev/null || true
}
trap cleanup EXIT

# Load config
if [ -f ".env" ]; then
    source .env
fi

# Check required env vars
if [ -z "$ADMIN_PRIVATE_KEY" ]; then
    error "ADMIN_PRIVATE_KEY not set in .env"
    exit 1
fi

if [ -z "$L1_RPC" ]; then
    L1_RPC="https://rpc.gnosischain.com"
fi

ADMIN_ADDRESS=$(cast wallet address $ADMIN_PRIVATE_KEY)

echo ""
echo -e "${BLUE}╔═══════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║   Native Rollup - Gnosis Deployment       ║${NC}"
echo -e "${BLUE}╚═══════════════════════════════════════════╝${NC}"
echo ""

log "Admin address: $ADMIN_ADDRESS"
log "L1 RPC: $L1_RPC"

# Check admin balance
BALANCE=$(cast balance $ADMIN_ADDRESS --rpc-url $L1_RPC)
log "Admin balance: $BALANCE wei"

if [ "$BALANCE" = "0" ]; then
    error "Admin has no balance on Gnosis. Fund the address first."
    exit 1
fi

# Step 1: Compute genesis state root locally
log "Computing genesis state root locally..."

# Start a temporary Anvil to compute genesis
# IMPORTANT: Use --accounts 0 to match the fullnode configuration
# This ensures no default accounts are created which would affect the state root
TEMP_PORT=19999
anvil --port $TEMP_PORT --chain-id 10200200 --gas-price 0 --base-fee 0 --accounts 0 --silent &
ANVIL_PID=$!

# Wait for Anvil to start
for i in {1..20}; do
    if curl -s "http://localhost:$TEMP_PORT" -X POST -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' > /dev/null 2>&1; then
        break
    fi
    sleep 0.5
done

if ! curl -s "http://localhost:$TEMP_PORT" -X POST -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' > /dev/null 2>&1; then
    error "Failed to start temporary Anvil"
    exit 1
fi

# System address config
SYSTEM_ADDRESS="0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf"
SYSTEM_PRIVATE_KEY="0x0000000000000000000000000000000000000000000000000000000000000001"

# Fund system address
curl -s "http://localhost:$TEMP_PORT" -X POST -H "Content-Type: application/json" \
    -d "{\"jsonrpc\":\"2.0\",\"method\":\"anvil_setBalance\",\"params\":[\"$SYSTEM_ADDRESS\",\"0x204fce5e3e25026110000000\"],\"id\":1}" > /dev/null

# Impersonate system address (so Anvil can sign for it)
curl -s "http://localhost:$TEMP_PORT" -X POST -H "Content-Type: application/json" \
    -d "{\"jsonrpc\":\"2.0\",\"method\":\"anvil_impersonateAccount\",\"params\":[\"$SYSTEM_ADDRESS\"],\"id\":1}" > /dev/null

# Get L1 deployment block timestamp for genesis
log "Getting L1 block for genesis timestamp..."
GENESIS_L1_BLOCK=$(cast block-number --rpc-url $L1_RPC)
L1_TIMESTAMP=$(cast block $GENESIS_L1_BLOCK --rpc-url $L1_RPC --json | jq -r '.timestamp')
# Convert hex to decimal if needed
if [[ "$L1_TIMESTAMP" == 0x* ]]; then
    L1_TIMESTAMP=$((L1_TIMESTAMP))
fi
log "Using L1 block #$GENESIS_L1_BLOCK with timestamp $L1_TIMESTAMP"

# Set genesis timestamp
curl -s "http://localhost:$TEMP_PORT" -X POST -H "Content-Type: application/json" \
    -d "{\"jsonrpc\":\"2.0\",\"method\":\"evm_setNextBlockTimestamp\",\"params\":[$L1_TIMESTAMP],\"id\":1}" > /dev/null

# Build contracts first
log "Building contracts..."
forge build --quiet

# Compute deterministic addresses
L2_CALL_REGISTRY=$(cast compute-address $SYSTEM_ADDRESS --nonce 0 | grep -oE '0x[a-fA-F0-9]{40}')
L1_SENDER_PROXY_L2_FACTORY=$(cast compute-address $SYSTEM_ADDRESS --nonce 1 | grep -oE '0x[a-fA-F0-9]{40}')

log "Expected L2CallRegistry: $L2_CALL_REGISTRY"
log "Expected L1SenderProxyL2Factory: $L1_SENDER_PROXY_L2_FACTORY"

# Deploy L2CallRegistry (nonce 0)
log "Deploying L2CallRegistry..."
REGISTRY_BYTECODE=$(forge inspect src/L1SenderProxyL2.sol:L2CallRegistry bytecode)
REGISTRY_ARGS=$(cast abi-encode "constructor(address)" $SYSTEM_ADDRESS | cut -c 3-)

TX_HASH=$(curl -s "http://localhost:$TEMP_PORT" -X POST -H "Content-Type: application/json" \
    -d "{\"jsonrpc\":\"2.0\",\"method\":\"eth_sendTransaction\",\"params\":[{\"from\":\"$SYSTEM_ADDRESS\",\"data\":\"${REGISTRY_BYTECODE}${REGISTRY_ARGS}\",\"gas\":\"0x1e8480\"}],\"id\":1}" | jq -r '.result')

if [ -z "$TX_HASH" ] || [ "$TX_HASH" = "null" ]; then
    error "Failed to send L2CallRegistry deploy tx"
    exit 1
fi

# Deploy L1SenderProxyL2Factory (nonce 1)
log "Deploying L1SenderProxyL2Factory..."
FACTORY_BYTECODE=$(forge inspect src/L1SenderProxyL2.sol:L1SenderProxyL2Factory bytecode)
FACTORY_ARGS=$(cast abi-encode "constructor(address,address)" $SYSTEM_ADDRESS $L2_CALL_REGISTRY | cut -c 3-)

TX_HASH2=$(curl -s "http://localhost:$TEMP_PORT" -X POST -H "Content-Type: application/json" \
    -d "{\"jsonrpc\":\"2.0\",\"method\":\"eth_sendTransaction\",\"params\":[{\"from\":\"$SYSTEM_ADDRESS\",\"data\":\"${FACTORY_BYTECODE}${FACTORY_ARGS}\",\"gas\":\"0x1e8480\"}],\"id\":1}" | jq -r '.result')

if [ -z "$TX_HASH2" ] || [ "$TX_HASH2" = "null" ]; then
    error "Failed to send L1SenderProxyL2Factory deploy tx"
    exit 1
fi

# Mine the genesis block
curl -s "http://localhost:$TEMP_PORT" -X POST -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","method":"evm_mine","params":[],"id":1}' > /dev/null

# Get genesis state root
GENESIS_HASH=$(curl -s "http://localhost:$TEMP_PORT" -X POST -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","method":"eth_getBlockByNumber","params":["latest",false],"id":1}' | jq -r '.result.stateRoot')

# Verify contracts were deployed
REGISTRY_CODE=$(curl -s "http://localhost:$TEMP_PORT" -X POST -H "Content-Type: application/json" \
    -d "{\"jsonrpc\":\"2.0\",\"method\":\"eth_getCode\",\"params\":[\"$L2_CALL_REGISTRY\",\"latest\"],\"id\":1}" | jq -r '.result')

if [ "$REGISTRY_CODE" = "0x" ] || [ -z "$REGISTRY_CODE" ]; then
    error "L2CallRegistry not deployed correctly"
    exit 1
fi

success "L2CallRegistry: $L2_CALL_REGISTRY"
success "L1SenderProxyL2Factory: $L1_SENDER_PROXY_L2_FACTORY"
success "Genesis state root: $GENESIS_HASH"

# Kill temporary Anvil
kill $ANVIL_PID 2>/dev/null || true

# Step 2: Deploy to Gnosis
log "Deploying to Gnosis..."

DEPLOY_OUTPUT=$(GENESIS_HASH=$GENESIS_HASH ADMIN=$ADMIN_ADDRESS forge script script/Deploy.s.sol:DeployScript \
    --rpc-url $L1_RPC \
    --private-key $ADMIN_PRIVATE_KEY \
    --broadcast \
    --slow 2>&1)

echo "$DEPLOY_OUTPUT"

# Extract addresses from output
VERIFIER_ADDRESS=$(echo "$DEPLOY_OUTPUT" | grep "AdminProofVerifier:" | awk '{print $2}')
ROLLUP_ADDRESS=$(echo "$DEPLOY_OUTPUT" | grep "NativeRollupCore:" | awk '{print $2}')

if [ -z "$ROLLUP_ADDRESS" ]; then
    error "Failed to deploy contracts"
    exit 1
fi

success "AdminProofVerifier deployed at: $VERIFIER_ADDRESS"
success "NativeRollupCore deployed at: $ROLLUP_ADDRESS"
success "Genesis L1 block (DEPLOYMENT_BLOCK): $GENESIS_L1_BLOCK"

# Step 3: Update .env
log "Updating .env..."

cat > .env << EOF
# Native Rollup POC - Gnosis Configuration
# Deployed: $(date)

ADMIN_PRIVATE_KEY=$ADMIN_PRIVATE_KEY

ROLLUP_ADDRESS=$ROLLUP_ADDRESS
VERIFIER_ADDRESS=$VERIFIER_ADDRESS
DEPLOYMENT_BLOCK=$GENESIS_L1_BLOCK
GENESIS_HASH=$GENESIS_HASH

L1_RPC=$L1_RPC

# System addresses (L2)
SYSTEM_ADDRESS=$SYSTEM_ADDRESS
L2_CALL_REGISTRY=$L2_CALL_REGISTRY
L1_SENDER_PROXY_L2_FACTORY=$L1_SENDER_PROXY_L2_FACTORY
EOF

success "Updated .env with new contract addresses"

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}   Deployment Complete!${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo "  Deployed contracts:"
echo "    NativeRollupCore:   $ROLLUP_ADDRESS"
echo "    AdminProofVerifier: $VERIFIER_ADDRESS"
echo "    Genesis L1 Block:   $GENESIS_L1_BLOCK"
echo "    Genesis Hash:       $GENESIS_HASH"
echo ""
echo "  L2 System Contracts (deterministic):"
echo "    System Address:            $SYSTEM_ADDRESS"
echo "    L2CallRegistry:            $L2_CALL_REGISTRY"
echo "    L1SenderProxyL2Factory:    $L1_SENDER_PROXY_L2_FACTORY"
echo ""
echo "  To start the fullnode:"
echo "    ./tools/startGnosis.sh"
echo ""
