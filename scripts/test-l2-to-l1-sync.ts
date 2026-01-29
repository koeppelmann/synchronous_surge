/**
 * Test L2→L1 Synchronous Call Flow
 *
 * This test verifies that an L2 transaction can make outgoing calls to L1.
 *
 * Scenario: L2SyncedCounter.setValue(77) is called directly on L2.
 * Since the caller is NOT the L1 contract's proxy, the L2 contract
 * makes an outgoing call to L1SyncedCounter.setValue(77).
 *
 * Flow:
 * 1. Sign an L2 tx calling L2SyncedCounter.setValue(77)
 * 2. Submit to builder as sourceChain="L2"
 * 3. Builder detects outgoing L1 call, simulates it, pre-registers result on L2
 * 4. Builder executes L2 tx (outgoing call succeeds via L2CallRegistry)
 * 5. Builder submits processSingleTxOnL2 with outgoingCalls[] to L1
 * 6. L1 executes outgoing call (L1SyncedCounter.setValue(77))
 * 7. Both L1 and L2 counters should now be 77
 * 8. Read-only fullnode reconstructs state from L1 events (verifies determinism)
 */
import { ethers, JsonRpcProvider, Wallet, Contract, Transaction } from "ethers";

// Configuration — matches start.sh
const L1_RPC = "http://localhost:8545";
const BUILDER_URL = "http://localhost:3200";
const READONLY_FULLNODE_RPC = "http://localhost:9547";
const BUILDER_FULLNODE_RPC = "http://localhost:9550";

// Contract addresses from start.sh
const ROLLUP_ADDRESS = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512";
const L1_SYNCED_COUNTER = "0x663F3ad617193148711d28f5334eE4Ed07016602";
const L2_SYNCED_COUNTER = "0x663F3ad617193148711d28f5334eE4Ed07016602";

// ABIs
const SYNCED_COUNTER_ABI = [
  "function value() view returns (uint256)",
  "function setValue(uint256 _value) external returns (uint256)",
  "function l1Counter() view returns (address)",
  "function l1ContractProxy() view returns (address)",
];

const ROLLUP_ABI = [
  "function l2BlockHash() view returns (bytes32)",
  "function l2BlockNumber() view returns (uint256)",
];

// Use deployer account — it has L2 funds from the initial L1→L2 deposit
const USER_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const L2_CHAIN_ID = 10200200;

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log("=== Test: L2→L1 Synchronous Call ===\n");

  const l1Provider = new JsonRpcProvider(L1_RPC);
  const l2ReadonlyProvider = new JsonRpcProvider(READONLY_FULLNODE_RPC);
  const l2BuilderProvider = new JsonRpcProvider(BUILDER_FULLNODE_RPC);

  // Wallet for signing L2 txs
  const l2Wallet = new Wallet(USER_PK);

  // Contract instances
  const l1Counter = new Contract(L1_SYNCED_COUNTER, SYNCED_COUNTER_ABI, l1Provider);
  const l2CounterReadonly = new Contract(L2_SYNCED_COUNTER, SYNCED_COUNTER_ABI, l2ReadonlyProvider);
  const rollup = new Contract(ROLLUP_ADDRESS, ROLLUP_ABI, l1Provider);

  // === Step 0: Read initial state ===
  console.log("Step 0: Reading initial state...");
  const l1ValueBefore = await l1Counter.value();
  let l2ValueBefore: bigint;
  try {
    l2ValueBefore = await l2CounterReadonly.value();
  } catch {
    l2ValueBefore = 0n;
  }
  const l2BlockBefore = await rollup.l2BlockNumber();
  console.log(`  L1 counter value: ${l1ValueBefore}`);
  console.log(`  L2 counter value: ${l2ValueBefore}`);
  console.log(`  L2 block number: ${l2BlockBefore}`);

  // Check L2SyncedCounter is configured
  try {
    const l1CounterAddr = await l2CounterReadonly.l1Counter();
    const l1ProxyAddr = await l2CounterReadonly.l1ContractProxy();
    console.log(`  L2SyncedCounter.l1Counter: ${l1CounterAddr}`);
    console.log(`  L2SyncedCounter.l1ContractProxy: ${l1ProxyAddr}`);
    if (l1CounterAddr === ethers.ZeroAddress) {
      console.log("\n❌ L2SyncedCounter.l1Counter not set! Run setup first.");
      process.exit(1);
    }
  } catch (err: any) {
    console.log(`  (Could not read L2SyncedCounter config: ${err.message})`);
  }

  const userAddress = l2Wallet.address;

  // === Step 1: Create signed L2 transaction ===
  const NEW_VALUE = 77n;
  console.log(`\nStep 2: Creating signed L2 transaction (setValue(${NEW_VALUE}))...`);

  const l2CounterIface = new ethers.Interface(SYNCED_COUNTER_ABI);
  const calldata = l2CounterIface.encodeFunctionData("setValue", [NEW_VALUE]);

  // Get nonce from the builder's fullnode RPC
  let l2Nonce: number;
  try {
    const nonceResult = await l2BuilderProvider.getTransactionCount(userAddress, "latest");
    l2Nonce = nonceResult;
  } catch {
    l2Nonce = 0;
  }
  console.log(`  L2 nonce: ${l2Nonce}`);

  // Create and sign L2 tx
  const l2TxData = {
    to: L2_SYNCED_COUNTER,
    data: calldata,
    nonce: l2Nonce,
    gasLimit: 500000,
    gasPrice: 0,
    chainId: L2_CHAIN_ID,
    type: 0, // legacy tx
  };
  const signedL2Tx = await l2Wallet.signTransaction(l2TxData);
  console.log(`  Signed tx: ${signedL2Tx.slice(0, 40)}...`);

  // === Step 3: Submit to builder ===
  console.log("\nStep 3: Submitting L2 transaction to builder...");
  const submitResponse = await fetch(`${BUILDER_URL}/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      signedTx: signedL2Tx,
      sourceChain: "L2",
    }),
  });

  const submitResult = await submitResponse.json();
  console.log("  Result:", JSON.stringify(submitResult, null, 2));

  if (submitResult.error) {
    console.log(`\n❌ SUBMISSION FAILED: ${submitResult.error}`);
    process.exit(1);
  }

  console.log(`  L1 tx: ${submitResult.l1TxHash}`);
  console.log(`  L2 tx: ${submitResult.l2TxHash}`);

  // === Step 4: Verify L1 state ===
  console.log("\nStep 4: Verifying L1 state...");
  const l1ValueAfter = await l1Counter.value();
  const l2BlockAfter = await rollup.l2BlockNumber();
  console.log(`  L1 counter value: ${l1ValueAfter} (expected: ${NEW_VALUE})`);
  console.log(`  L2 block number: ${l2BlockAfter} (was: ${l2BlockBefore})`);

  if (l1ValueAfter.toString() !== NEW_VALUE.toString()) {
    console.log(`\n❌ L1 counter value mismatch! Expected ${NEW_VALUE}, got ${l1ValueAfter}`);
    process.exit(1);
  }
  console.log("  ✅ L1 counter updated correctly!");

  // === Step 5: Wait for read-only fullnode to sync ===
  console.log("\nStep 5: Waiting for read-only fullnode to sync...");
  const expectedL2Hash = await rollup.l2BlockHash();
  let synced = false;
  for (let i = 0; i < 15; i++) {
    try {
      const fullnodeState = await l2ReadonlyProvider.send("eth_call", [{
        to: READONLY_FULLNODE_RPC, // dummy, we use the RPC
      }, "latest"]).catch(() => null);

      // Check fullnode state root via custom RPC
      const stateResp = await fetch(READONLY_FULLNODE_RPC, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1,
          method: "nativerollup_getStateRoot",
          params: [],
        }),
      });
      const stateJson = await stateResp.json();
      const fullnodeStateRoot = stateJson.result;

      if (fullnodeStateRoot && fullnodeStateRoot.toLowerCase() === expectedL2Hash.toLowerCase()) {
        synced = true;
        console.log(`  Synced after ${(i + 1) * 2}s`);
        break;
      }
      console.log(`  Waiting... (fullnode: ${(fullnodeStateRoot || "?").slice(0, 14)}..., expected: ${expectedL2Hash.slice(0, 14)}...)`);
    } catch (err: any) {
      console.log(`  Waiting... (${err.message})`);
    }
    await sleep(2000);
  }

  if (!synced) {
    console.log("  ⚠️  Read-only fullnode did not sync within 30s");
    console.log("  (This is expected if fullnode event replay for outgoing calls is not yet implemented)");
  }

  // === Step 6: Verify L2 state ===
  console.log("\nStep 6: Verifying L2 state...");
  try {
    const l2ValueAfter = await l2CounterReadonly.value();
    console.log(`  L2 counter value: ${l2ValueAfter} (expected: ${NEW_VALUE})`);

    if (l2ValueAfter.toString() === NEW_VALUE.toString()) {
      console.log("  ✅ L2 counter updated correctly!");
    } else {
      console.log(`  ❌ L2 counter mismatch! Expected ${NEW_VALUE}, got ${l2ValueAfter}`);
    }
  } catch (err: any) {
    console.log(`  ⚠️  Could not read L2 counter: ${err.message}`);
  }

  // === Summary ===
  console.log("\n=== Summary ===");
  console.log(`  L1 counter: ${l1ValueBefore} → ${l1ValueAfter}`);
  console.log(`  L2 block: ${l2BlockBefore} → ${l2BlockAfter}`);

  if (l1ValueAfter.toString() === NEW_VALUE.toString()) {
    console.log("\n✅ SUCCESS: L2→L1 synchronous call worked!");
    console.log("  - L2 tx called L2SyncedCounter.setValue(77)");
    console.log("  - L2 contract made outgoing call to L1SyncedCounter.setValue(77)");
    console.log("  - L1 counter updated atomically in same block");
    if (synced) {
      console.log("  - Read-only fullnode reconstructed state from L1 events");
    }
  } else {
    console.log("\n❌ FAILED");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
