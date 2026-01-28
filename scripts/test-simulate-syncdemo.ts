/**
 * Test SyncDemo via /simulate endpoint first, then submit if simulation passes.
 */
import { ethers, JsonRpcProvider, Wallet, Contract } from "ethers";

const L1_RPC = "http://localhost:8545";
const BUILDER_URL = "http://localhost:3200";
const SYNC_DEMO = "0xa513E6E4b8f2a923D98304ec87F64353C4D5C853";

const SYNC_DEMO_ABI = [
  "function setValue(uint256 newValue)",
  "function valueBefore() view returns (uint256)",
  "function valueSet() view returns (uint256)",
  "function valueAfter() view returns (uint256)",
  "function getValues() view returns (uint256, uint256, uint256)",
];

async function main() {
  const provider = new JsonRpcProvider(L1_RPC);
  // Use account #2 to avoid nonce conflict with admin
  const wallet = new Wallet(
    "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
    provider
  );
  console.log(`Sender: ${wallet.address}`);

  const syncDemo = new Contract(SYNC_DEMO, SYNC_DEMO_ABI, wallet);

  // Build tx
  const nonce = await provider.getTransactionCount(wallet.address);
  const tx = await wallet.populateTransaction({
    to: SYNC_DEMO,
    data: syncDemo.interface.encodeFunctionData("setValue", [99]),
    nonce,
    gasLimit: 2000000,
    gasPrice: ethers.parseUnits("100", "gwei"),
  });
  const signedTx = await wallet.signTransaction(tx);

  // === Step 1: Simulate ===
  console.log("\n=== Step 1: Simulate SyncDemo.setValue(99) ===\n");
  const simResponse = await fetch(`${BUILDER_URL}/simulate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ signedTx, sourceChain: "L1" }),
  });
  const simResult = await simResponse.json();
  console.log("Simulation result:", JSON.stringify(simResult, null, 2));

  if (!simResult.txWouldSucceed) {
    console.log("\n SIMULATION FAILED — tx would revert");
    console.log("Error:", simResult.txError);
    process.exit(1);
  }

  // Verify we found 3 L2 calls
  const details = simResult.callDetails || [];
  console.log(`\nFound ${details.length} L2 calls:`);
  for (const d of details) {
    console.log(`  ${d.selector} from ${d.l1Caller.slice(0, 10)}... → ${d.l2Address.slice(0, 10)}...`);
    console.log(`    state: ${d.stateHash.slice(0, 14)}... → ${d.newStateHash.slice(0, 14)}...`);
    console.log(`    return: ${d.returnData.slice(0, 42)}${d.returnData.length > 42 ? '...' : ''}`);
    console.log(`    success: ${d.success}, alreadyRegistered: ${d.wasAlreadyRegistered}`);
  }

  if (details.length !== 3) {
    console.log(`\n EXPECTED 3 L2 calls, got ${details.length}`);
    process.exit(1);
  }

  // Verify call 1: value() returns 42
  const call1Return = details[0].returnData;
  const value1 = BigInt(call1Return);
  console.log(`\nCall 1 (value before): ${value1} (expected 42)`);
  if (value1 !== 42n) {
    console.log(" WRONG value before");
    process.exit(1);
  }

  // Call 2: setValue(99) — state-changing
  console.log(`Call 2 (setValue(99)): success=${details[1].success}`);

  // Call 3: value() returns 99
  const call3Return = details[2].returnData;
  const value3 = BigInt(call3Return);
  console.log(`Call 3 (value after): ${value3} (expected 99)`);
  if (value3 !== 99n) {
    console.log(" WRONG value after");
    process.exit(1);
  }

  console.log("\n SIMULATION PASSED — all 3 L2 calls verified!\n");

  // === Step 2: Submit for real ===
  console.log("=== Step 2: Submitting real transaction ===\n");
  const submitResponse = await fetch(`${BUILDER_URL}/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ signedTx, sourceChain: "L1" }),
  });
  const submitResult = await submitResponse.json();
  console.log("Submit result:", JSON.stringify(submitResult, null, 2));

  if (submitResult.error) {
    console.log("\n SUBMIT FAILED:", submitResult.error);
    process.exit(1);
  }

  // Read results from SyncDemo
  const [valueBefore, valueSet, valueAfter] = await syncDemo.getValues();
  console.log("\n=== On-chain Results ===");
  console.log(`  valueBefore: ${valueBefore} (expected: 42)`);
  console.log(`  valueSet:    ${valueSet} (expected: 99)`);
  console.log(`  valueAfter:  ${valueAfter} (expected: 99)`);

  if (
    valueBefore.toString() === "42" &&
    valueSet.toString() === "99" &&
    valueAfter.toString() === "99"
  ) {
    console.log("\n SUCCESS: Synchronous L1↔L2 composability demonstrated!");
    console.log("  - L1 read L2 state (42) before update");
    console.log("  - L1 modified L2 state via L1SyncedCounter.setValue(99)");
    console.log("  - L1 read updated L2 state (99) after update");
    console.log("  - All within a SINGLE L1 transaction!");
  } else {
    console.log("\n UNEXPECTED values");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
