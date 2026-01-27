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
# 2. Calculate genesis hash for L2
# 3. Deploy NativeRollupCore and AdminProofVerifier
# 4. Deploy L1SyncedCounter and L2SyncedCounter
# 5. Deposit 1 ETH to deployer on L2
# 6. Configure bidirectional sync
# 7. Save L1 state to state/l1-state.json
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

# Keys
ADMIN_PRIVATE_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
ADMIN_ADDRESS="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
DEPLOYER_PK="0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"
DEPLOYER="0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"

# L2 System address (for genesis)
L2_SYSTEM_ADDRESS="0x1000000000000000000000000000000000000001"
L2_SYSTEM_BALANCE="0x204fce5e3e25026110000000" # 10 billion ETH in hex

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

cleanup() {
    log "Cleaning up old processes..."
    pkill -f "anvil.*$L1_PORT" 2>/dev/null || true
    pkill -f "anvil.*$L2_PORT" 2>/dev/null || true
    pkill -f "anvil.*19999" 2>/dev/null || true
    pkill -f "deterministic-fullnode" 2>/dev/null || true
    pkill -f "deterministic-builder" 2>/dev/null || true
    pkill -f "python3.*http.server.*$FRONTEND_PORT" 2>/dev/null || true
    sleep 2
}

start_frontend() {
    log "Starting frontend server on port $FRONTEND_PORT..."
    mkdir -p logs
    (cd ui && python3 -m http.server $FRONTEND_PORT > ../logs/frontend.log 2>&1) &
    sleep 1
    if curl -s "http://localhost:$FRONTEND_PORT" > /dev/null 2>&1; then
        success "Frontend started at http://localhost:$FRONTEND_PORT"
    else
        error "Failed to start frontend (continuing anyway)"
    fi
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
    log "Starting fresh L1 Anvil on port $L1_PORT..."
    anvil --port $L1_PORT --chain-id 31337 --silent &

    if wait_for_rpc "http://localhost:$L1_PORT" "L1 Anvil"; then
        success "L1 Anvil started"
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
}

start_fullnode() {
    log "Starting temporary fullnode..."

    mkdir -p logs

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
    log "Starting temporary builder..."

    npx tsx scripts/deterministic-builder.ts \
        --l1-rpc http://localhost:$L1_PORT \
        --fullnode http://localhost:$L2_PORT \
        --rollup $ROLLUP_ADDRESS \
        --admin-key $ADMIN_PRIVATE_KEY \
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
    log "Depositing 1 ETH to deployer on L2..."

    # Get proxy address for deployer (the L2 address we're depositing to)
    PROXY_ADDRESS=$(cast call $ROLLUP_ADDRESS "getProxyAddress(address)(address)" $DEPLOYER --rpc-url http://localhost:$L1_PORT)

    # Fund DEPLOYER on L1 first so they can make the deposit
    # (Using anvil_setBalance since DEPLOYER starts with 0 on fresh L1)
    log "Funding deployer on L1..."
    curl -s http://localhost:$L1_PORT -X POST -H "Content-Type: application/json" \
        -d "{\"jsonrpc\":\"2.0\",\"method\":\"anvil_setBalance\",\"params\":[\"$DEPLOYER\", \"0x56BC75E2D63100000\"],\"id\":1}" > /dev/null

    # Get deployer nonce on L1
    NONCE=$(cast nonce $DEPLOYER --rpc-url http://localhost:$L1_PORT)

    # Create deposit transaction (from DEPLOYER, not ADMIN)
    # This avoids nonce conflicts with builder's admin wallet
    SIGNED_TX=$(cast mktx --private-key $DEPLOYER_PK \
        --rpc-url http://localhost:$L1_PORT \
        --legacy \
        --nonce $NONCE \
        --gas-limit 100000 \
        --gas-price 2000000000 \
        $PROXY_ADDRESS \
        --value 1ether)

    RESULT=$(submit_tx "$SIGNED_TX" "L1" "{\"l2TargetAddress\": \"$DEPLOYER\"}")
    if echo "$RESULT" | grep -q "error"; then
        error "Deposit failed: $RESULT"
        exit 1
    fi
    success "Deposited 1 ETH to $DEPLOYER on L2"

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

    # Deploy L2SyncedCounter
    log "Deploying L2SyncedCounter..."
    BYTECODE=$(forge inspect src/examples/SyncedCounter.sol:L2SyncedCounter bytecode)
    L2_NONCE=$(cast nonce $DEPLOYER --rpc-url http://localhost:$L2_PORT)

    # Pre-compute the contract address (CREATE address = keccak256(rlp(sender, nonce))[12:])
    L2_CONTRACT=$(cast compute-address $DEPLOYER --nonce $L2_NONCE)
    # Extract just the address from "Computed Address: 0x..."
    L2_CONTRACT=$(echo "$L2_CONTRACT" | grep -oE '0x[a-fA-F0-9]{40}')

    SIGNED_TX=$(cast mktx --private-key $DEPLOYER_PK \
        --rpc-url http://localhost:$L2_PORT \
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

    # Configure bidirectional sync
    log "Configuring bidirectional sync..."

    # Deploy L2SenderProxy for L2SyncedCounter on L1
    # This is required so that L1SyncedCounter can call L2SyncedCounter through the proxy
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

    # Compute the L1SenderProxyL2 address for the L1 contract
    # This is the address that will be msg.sender on L2 when L1 calls L2
    # Hash: keccak256(solidityPacked(["string", "address"], ["L1SenderProxyL2.v1", l1Address]))
    # Take last 20 bytes
    L1_PROXY_ON_L2=$(node -e "const { ethers } = require('ethers'); const hash = ethers.keccak256(ethers.solidityPacked(['string', 'address'], ['L1SenderProxyL2.v1', '$L1_CONTRACT'])); console.log('0x' + hash.slice(-40));")
    log "L1 contract's proxy on L2: $L1_PROXY_ON_L2"

    # Set L1 contract's proxy on L2SyncedCounter
    L2_NONCE=$(cast nonce $DEPLOYER --rpc-url http://localhost:$L2_PORT)
    CALLDATA=$(cast calldata "setL1ContractProxy(address)" $L1_PROXY_ON_L2)
    SIGNED_TX=$(cast mktx --private-key $DEPLOYER_PK \
        --rpc-url http://localhost:$L2_PORT \
        --legacy \
        --nonce $L2_NONCE \
        --gas-limit 100000 \
        --gas-price 0 \
        $L2_CONTRACT \
        "$CALLDATA")
    submit_tx "$SIGNED_TX" "L2" > /dev/null
    success "Set L1 contract proxy on L2SyncedCounter: $L1_PROXY_ON_L2"
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

main() {
    echo ""
    echo -e "${BLUE}╔═══════════════════════════════════════╗${NC}"
    echo -e "${BLUE}║   Native Rollup - Fresh Setup         ║${NC}"
    echo -e "${BLUE}╚═══════════════════════════════════════╝${NC}"
    echo ""

    # Cleanup
    cleanup

    # Start frontend first (so user can watch progress)
    start_frontend

    # Calculate genesis hash
    calculate_genesis_hash

    # Start L1
    start_l1

    # Deploy core contracts
    deploy_contracts

    # Start fullnode and builder temporarily
    start_fullnode
    start_builder

    # Deploy SyncedCounter contracts and configure
    deploy_synced_counters

    # Save the L1 state
    save_state

    # Cleanup temporary processes
    log "Stopping temporary services..."
    pkill -f "deterministic-fullnode" 2>/dev/null || true
    pkill -f "deterministic-builder" 2>/dev/null || true
    pkill -f "anvil.*$L1_PORT" 2>/dev/null || true
    pkill -f "anvil.*$L2_PORT" 2>/dev/null || true

    echo ""
    echo -e "${GREEN}========================================${NC}"
    echo -e "${GREEN}   Setup Complete!${NC}"
    echo -e "${GREEN}========================================${NC}"
    echo ""
    echo "  State saved to: $L1_STATE_FILE"
    echo ""
    echo "  Deployed contracts:"
    echo "    NativeRollupCore:  $ROLLUP_ADDRESS"
    echo "    AdminProofVerifier: $VERIFIER_ADDRESS"
    echo "    L1SyncedCounter:   $L1_CONTRACT"
    echo "    L2SyncedCounter:   $L2_CONTRACT"
    echo ""
    echo "  Run './start.sh' to start the system with this state."
    echo ""
}

main "$@"
