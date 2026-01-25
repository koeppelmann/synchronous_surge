#!/bin/bash
# Sync a value from L2 to L1 via processCallOnL2
#
# This script:
# 1. Creates a signed L2 transaction calling L2SyncedCounter.setValue(value)
# 2. Submits it to L1 via processCallOnL2 with an outgoing call to L1SyncedCounter
# 3. The sequencer picks up the event and replays the tx on L2

set -e

# Configuration
L1_RPC="http://localhost:9545"
L2_RPC="http://localhost:9546"
ROLLUP_CORE="0x4240994d85109581B001183ab965D9e3d5fb2C2A"
L1_SYNCED_COUNTER="0xd30bF3219A0416602bE8D482E0396eF332b0494E"
L2_SYNCED_COUNTER="0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512"

# Keys
ADMIN_PK="0xf2024347d89be67338b62344010fb2ebc5db60cad2ff591a92a30b8215f87f22"
USER_PK="0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a"
USER_ADDR="0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65"

# Value to set
VALUE=${1:-42}

echo "=== Syncing value $VALUE from L2 to L1 ==="
echo ""

# Step 1: Fund user on L2 if needed
echo "Step 1: Funding user on L2..."
cast rpc anvil_setBalance $USER_ADDR "0x56BC75E2D63100000" --rpc-url $L2_RPC > /dev/null

# Step 2: Create signed L2 transaction
echo "Step 2: Creating signed L2 transaction..."
RAW_TX=$(cast mktx \
    --private-key $USER_PK \
    --chain 10200200 \
    --rpc-url $L2_RPC \
    $L2_SYNCED_COUNTER \
    "setValue(uint256)" $VALUE)
echo "  Raw tx: ${RAW_TX:0:40}..."

# Step 3: Get current L2 state
echo "Step 3: Getting current L2 state..."
L2_BLOCK_HASH=$(cast call $ROLLUP_CORE "l2BlockHash()(bytes32)" --rpc-url $L1_RPC)
L2_BLOCK_NUM=$(cast call $ROLLUP_CORE "l2BlockNumber()(uint256)" --rpc-url $L1_RPC)
echo "  L2 block: $L2_BLOCK_NUM"
echo "  L2 hash: ${L2_BLOCK_HASH:0:20}..."

# Step 4: Compute proof parameters
echo "Step 4: Computing proof..."

# State hashes (POC - consistent values)
POST_EXEC_STATE=$(cast keccak "$(cast abi-encode 'f(string,uint256)' 'post-exec' $VALUE)")
FINAL_STATE=$POST_EXEC_STATE

# Outgoing call parameters
SET_VALUE_DATA=$(cast calldata "setValue(uint256)" $VALUE)
SET_VALUE_DATA_HASH=$(cast keccak $SET_VALUE_DATA)

# Hash the outgoing call (matches AdminProofVerifier._hashCalls)
# encodePacked(from, target, value, gas, dataHash, postCallStateHash)
CALLS_ENCODED=$(cast abi-encode --packed \
    'f(address,address,uint256,uint256,bytes32,bytes32)' \
    $L2_SYNCED_COUNTER \
    $L1_SYNCED_COUNTER \
    0 \
    100000 \
    $SET_VALUE_DATA_HASH \
    $POST_EXEC_STATE)
CALLS_HASH=$(cast keccak $CALLS_ENCODED)

# Hash the expected result (returns uint256)
EXPECTED_RESULT=$(cast abi-encode 'f(uint256)' $VALUE)
RESULT_HASH=$(cast keccak $EXPECTED_RESULT)
RESULTS_ENCODED=$(cast abi-encode --packed 'f(bytes32)' $RESULT_HASH)
RESULTS_HASH=$(cast keccak $RESULTS_ENCODED)

# Compute message hash
CALL_DATA_HASH=$(cast keccak $RAW_TX)
MSG_HASH=$(cast keccak $(cast abi-encode \
    'f(bytes32,bytes32,bytes32,bytes32,bytes32,bytes32)' \
    $L2_BLOCK_HASH \
    $CALL_DATA_HASH \
    $POST_EXEC_STATE \
    $CALLS_HASH \
    $RESULTS_HASH \
    $FINAL_STATE))

# Add Ethereum signed message prefix
ETH_MSG_HASH=$(cast keccak $(cast abi-encode --packed \
    'f(string,bytes32)' \
    $'\x19Ethereum Signed Message:\n32' \
    $MSG_HASH))

echo "  Message hash: ${MSG_HASH:0:20}..."

# Step 5: Sign proof
echo "Step 5: Signing proof..."
PROOF=$(cast wallet sign --private-key $ADMIN_PK $ETH_MSG_HASH)
echo "  Proof: ${PROOF:0:40}..."

# Step 6: Submit to L1
echo "Step 6: Submitting processCallOnL2 to L1..."

# Build the outgoing call tuple array
# tuple(address from, address target, uint256 value, uint256 gas, bytes data, bytes32 postCallStateHash)[]
OUTGOING_CALLS="[(${L2_SYNCED_COUNTER},${L1_SYNCED_COUNTER},0,100000,${SET_VALUE_DATA},${POST_EXEC_STATE})]"

TX_HASH=$(cast send $ROLLUP_CORE \
    "processCallOnL2(bytes32,bytes,bytes32,(address,address,uint256,uint256,bytes,bytes32)[],bytes[],bytes32,bytes)" \
    $L2_BLOCK_HASH \
    $RAW_TX \
    $POST_EXEC_STATE \
    "$OUTGOING_CALLS" \
    "[$EXPECTED_RESULT]" \
    $FINAL_STATE \
    $PROOF \
    --rpc-url $L1_RPC \
    --private-key $ADMIN_PK \
    2>&1) || {
    echo "Transaction failed!"
    echo "$TX_HASH"
    exit 1
}

echo "  L1 tx: $TX_HASH"

# Step 7: Verify state
echo ""
echo "Step 7: Verifying state..."
NEW_L2_NUM=$(cast call $ROLLUP_CORE "l2BlockNumber()(uint256)" --rpc-url $L1_RPC)
L1_VALUE=$(cast call $L1_SYNCED_COUNTER "value()(uint256)" --rpc-url $L1_RPC)
echo "  L2 block number: $NEW_L2_NUM"
echo "  L1SyncedCounter value: $L1_VALUE"

echo ""
echo "=== Done! Waiting for sequencer to sync L2... ==="
echo "Check L2SyncedCounter value with:"
echo "  cast call $L2_SYNCED_COUNTER 'value()(uint256)' --rpc-url $L2_RPC"
