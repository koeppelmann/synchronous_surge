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
  // Use account #2 to avoid nonce conflict with admin (used by builder)
  const wallet = new Wallet(
    "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
    provider
  );
  console.log(`Sender: ${wallet.address}`);

  const syncDemo = new Contract(SYNC_DEMO, SYNC_DEMO_ABI, wallet);

  // Check current L2 value via L2 RPC
  console.log("\n=== SyncDemo.setValue(99) Test ===\n");

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

  console.log("Submitting SyncDemo.setValue(99) to builder...");
  const response = await fetch(`${BUILDER_URL}/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ signedTx, sourceChain: "L1" }),
  });

  const result = await response.json();
  console.log("\nBuilder response:", JSON.stringify(result, null, 2));

  if (result.error) {
    console.log("\nFAILED:", result.error);
    process.exit(1);
  }

  // Read results
  const [valueBefore, valueSet, valueAfter] = await syncDemo.getValues();
  console.log("\n=== Results ===");
  console.log(`  valueBefore: ${valueBefore} (expected: 42)`);
  console.log(`  valueSet:    ${valueSet} (expected: 99)`);
  console.log(`  valueAfter:  ${valueAfter} (expected: 99)`);

  if (valueBefore.toString() === "42" && valueSet.toString() === "99" && valueAfter.toString() === "99") {
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

main().catch(console.error);
