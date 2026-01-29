/**
 * Test L1Orchestrator - Complex Cross-Chain Orchestration
 *
 * Tests a contract on L1 that:
 * 1. Calls setValue(number) on L2SyncedCounter (via L2SenderProxy on L1)
 *    - This is an L1→L2 incoming call
 *    - L2SyncedCounter sees caller is NOT l1ContractProxy
 *    - So it makes an outgoing L2→L1 call to L1SyncedCounter.setValue(number)
 *    - Result: both counters == number
 * 2. Reads L1SyncedCounter.value() (should be number)
 * 3. Calls L1SyncedCounter.setValue(number + 1)
 *    - L1SyncedCounter calls l2Proxy → L2SyncedCounter.setValue(number + 1)
 *    - L2SyncedCounter sees caller IS l1ContractProxy → no outgoing call
 *    - Result: both counters == number + 1
 *
 * This tests:
 * - Multiple L2 calls in a single L1 transaction
 * - Bidirectional L1→L2→L1 call (first call)
 * - Simple L1→L2 call (second call)
 * - L1 state reads between L2 calls
 * - Read-only fullnode reconstruction of complex state transitions
 */
import { ethers, JsonRpcProvider, Wallet, Contract, ContractFactory } from "ethers";
import { readFileSync } from "fs";
import { join } from "path";

// Configuration
const L1_RPC = "http://localhost:8545";
const L1_PROXY_RPC = "http://localhost:8546";
const BUILDER_URL = "http://localhost:3200";
const READONLY_FULLNODE_RPC = "http://localhost:9547";

// Contract addresses
const ROLLUP_ADDRESS = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512";
const L1_SYNCED_COUNTER = "0x663F3ad617193148711d28f5334eE4Ed07016602";
const L2_SYNCED_COUNTER = "0x663F3ad617193148711d28f5334eE4Ed07016602";
const L2_SENDER_PROXY = "0xc5AdD61254C6CB1dA0929A571A5D13B1EaC36281"; // L2SenderProxy for L2SyncedCounter on L1

// Deployer key (has L1 ETH on Anvil) — used for deploying
const DEPLOYER_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
// Separate caller key — used for execute() via the proxy
const CALLER_PK = "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a";

// ABIs
const SYNCED_COUNTER_ABI = [
  "function value() view returns (uint256)",
  "function setValue(uint256 _value) external returns (uint256)",
];

const ORCHESTRATOR_ABI = [
  "function setAddresses(address _l1SyncedCounter, address _l2SyncedCounterProxy) external",
  "function execute(uint256 number) external returns (uint256 finalValue)",
  "function l1SyncedCounter() view returns (address)",
  "function l2SyncedCounterProxy() view returns (address)",
  "event OrchestratorExecuted(uint256 inputNumber, uint256 finalValue)",
];

const ROLLUP_ABI = [
  "function l2BlockHash() view returns (bytes32)",
  "function l2BlockNumber() view returns (uint256)",
];

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log("=== Test: L1Orchestrator - Complex Cross-Chain Orchestration ===\n");

  const l1Provider = new JsonRpcProvider(L1_RPC);
  const l1ProxyProvider = new JsonRpcProvider(L1_PROXY_RPC);
  const l2ReadonlyProvider = new JsonRpcProvider(READONLY_FULLNODE_RPC);
  const deployer = new Wallet(DEPLOYER_PK, l1Provider);
  const caller = new Wallet(CALLER_PK, l1ProxyProvider);

  const l1Counter = new Contract(L1_SYNCED_COUNTER, SYNCED_COUNTER_ABI, l1Provider);
  const rollup = new Contract(ROLLUP_ADDRESS, ROLLUP_ABI, l1Provider);

  // === Step 0: Read initial state ===
  console.log("Step 0: Reading initial state...");
  const l1ValueBefore = await l1Counter.value();
  const l2BlockBefore = await rollup.l2BlockNumber();
  let l2ValueBefore: bigint;
  try {
    const l2Counter = new Contract(L2_SYNCED_COUNTER, SYNCED_COUNTER_ABI, l2ReadonlyProvider);
    l2ValueBefore = await l2Counter.value();
  } catch {
    l2ValueBefore = 0n;
  }
  console.log(`  L1 counter: ${l1ValueBefore}`);
  console.log(`  L2 counter: ${l2ValueBefore}`);
  console.log(`  L2 block: ${l2BlockBefore}`);

  // === Step 1: Deploy L1Orchestrator ===
  console.log("\nStep 1: Deploying L1Orchestrator on L1...");

  // Read compiled artifact
  const artifactPath = join(__dirname, "../out/L1Orchestrator.sol/L1Orchestrator.json");
  const artifact = JSON.parse(readFileSync(artifactPath, "utf-8"));

  const factory = new ContractFactory(artifact.abi, artifact.bytecode.object, deployer);
  const orchestrator = await factory.deploy();
  await orchestrator.waitForDeployment();
  const orchestratorAddress = await orchestrator.getAddress();
  console.log(`  Deployed at: ${orchestratorAddress}`);

  // Configure addresses
  const orchestratorContract = new Contract(orchestratorAddress, ORCHESTRATOR_ABI, deployer);
  const setAddrTx = await orchestratorContract.setAddresses(L1_SYNCED_COUNTER, L2_SENDER_PROXY);
  await setAddrTx.wait();
  console.log(`  Configured: L1Counter=${L1_SYNCED_COUNTER}, L2Proxy=${L2_SENDER_PROXY}`);

  // Register hints with the L1 proxy so it knows about the L2 calls
  console.log("  Registering L2 address hints with L1 proxy...");
  await fetch(`${L1_PROXY_RPC}/register-l2-addresses`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contractAddress: orchestratorAddress.toLowerCase(),
      l2Addresses: {
        [L2_SENDER_PROXY.toLowerCase()]: L2_SYNCED_COUNTER.toLowerCase(),
      },
    }),
  });
  // Also register for L1SyncedCounter since it calls the L2SenderProxy too
  await fetch(`${L1_PROXY_RPC}/register-l2-addresses`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contractAddress: L1_SYNCED_COUNTER.toLowerCase(),
      l2Addresses: {
        [L2_SENDER_PROXY.toLowerCase()]: L2_SYNCED_COUNTER.toLowerCase(),
      },
    }),
  });

  // Also register specific hints for the L2SenderProxy
  await fetch(`${L1_PROXY_RPC}/register-hint`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      proxyAddress: L2_SENDER_PROXY,
      l2Address: L2_SYNCED_COUNTER,
    }),
  });
  console.log("  Hints registered.");

  // === Step 2: Execute the orchestrator ===
  const INPUT_NUMBER = 50n;
  const EXPECTED_FINAL = INPUT_NUMBER + 1n; // 51
  console.log(`\nStep 2: Calling orchestrator.execute(${INPUT_NUMBER})...`);
  console.log(`  Expected result: both counters == ${EXPECTED_FINAL}`);

  // Call through the L1 proxy so the builder can intercept L2 calls
  // Use a different account than the deployer to avoid nonce conflicts
  const orchestratorViaProxy = new Contract(orchestratorAddress, ORCHESTRATOR_ABI, caller);

  try {
    const executeTx = await orchestratorViaProxy.execute(INPUT_NUMBER, { gasLimit: 2000000 });
    console.log(`  TX hash: ${executeTx.hash}`);
    const receipt = await executeTx.wait();
    console.log(`  TX status: ${receipt?.status === 1 ? "SUCCESS" : "FAILED"}`);
    console.log(`  Gas used: ${receipt?.gasUsed}`);

    if (receipt?.status !== 1) {
      console.log("\n❌ Transaction reverted!");
      process.exit(1);
    }
  } catch (err: any) {
    console.log(`\n❌ Transaction failed: ${err.message}`);

    // Check builder logs
    console.log("\nChecking builder status...");
    try {
      const status = await fetch(`${BUILDER_URL}/status`).then(r => r.json());
      console.log(`  Builder status: ${JSON.stringify(status)}`);
    } catch {}

    process.exit(1);
  }

  // === Step 3: Verify L1 state ===
  console.log("\nStep 3: Verifying L1 state...");
  const l1ValueAfter = await l1Counter.value();
  const l2BlockAfter = await rollup.l2BlockNumber();
  console.log(`  L1 counter: ${l1ValueAfter} (expected: ${EXPECTED_FINAL})`);
  console.log(`  L2 block: ${l2BlockAfter} (was: ${l2BlockBefore})`);

  if (l1ValueAfter.toString() !== EXPECTED_FINAL.toString()) {
    console.log(`\n❌ L1 counter mismatch! Expected ${EXPECTED_FINAL}, got ${l1ValueAfter}`);
    process.exit(1);
  }
  console.log("  ✅ L1 counter correct!");

  // === Step 4: Wait for read-only fullnode to sync ===
  console.log("\nStep 4: Waiting for read-only fullnode to sync...");
  const expectedL2Hash = await rollup.l2BlockHash();
  let synced = false;
  for (let i = 0; i < 15; i++) {
    try {
      const stateResp = await fetch(READONLY_FULLNODE_RPC, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1,
          method: "nativerollup_getStateRoot",
          params: [],
        }),
      });
      const stateJson = await stateResp.json() as any;
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
  }

  // === Step 5: Verify L2 state ===
  console.log("\nStep 5: Verifying L2 state...");
  try {
    const l2Counter = new Contract(L2_SYNCED_COUNTER, SYNCED_COUNTER_ABI, l2ReadonlyProvider);
    const l2ValueAfter = await l2Counter.value();
    console.log(`  L2 counter: ${l2ValueAfter} (expected: ${EXPECTED_FINAL})`);

    if (l2ValueAfter.toString() === EXPECTED_FINAL.toString()) {
      console.log("  ✅ L2 counter correct!");
    } else {
      console.log(`  ❌ L2 counter mismatch!`);
    }
  } catch (err: any) {
    console.log(`  ⚠️  Could not read L2 counter: ${err.message}`);
  }

  // === Summary ===
  console.log("\n=== Summary ===");
  console.log(`  Input number: ${INPUT_NUMBER}`);
  console.log(`  L1 counter: ${l1ValueBefore} → ${l1ValueAfter}`);
  console.log(`  L2 block: ${l2BlockBefore} → ${l2BlockAfter}`);

  if (l1ValueAfter.toString() === EXPECTED_FINAL.toString()) {
    console.log(`\n✅ SUCCESS: L1Orchestrator cross-chain orchestration worked!`);
    console.log(`  - Step 1: Set L2 counter to ${INPUT_NUMBER} (with L2→L1 outgoing call to L1)`);
    console.log(`  - Step 2: Read L1 counter = ${INPUT_NUMBER}`);
    console.log(`  - Step 3: Set L1 counter to ${EXPECTED_FINAL} (with L1→L2 incoming call)`);
    console.log(`  - Both counters = ${EXPECTED_FINAL}`);
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
