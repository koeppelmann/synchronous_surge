import { ethers, JsonRpcProvider, Wallet, Contract } from "ethers";

const L1_RPC = "http://localhost:8545";
const BUILDER_URL = "http://localhost:3200";

// Contract addresses from snapshot
const SYNC_DEMO = "0x610178dA211FEF7D417bC0e6FeD39F05609AD788";
const L1_SYNCED_COUNTER = "0x663F3ad617193148711d28f5334eE4Ed07016602";
const L2_SENDER_PROXY = "0xc5AdD61254C6CB1dA0929A571A5D13B1EaC36281";

const SYNC_DEMO_ABI = [
  "function setValue(uint256 newValue) external",
  "function getValues() external view returns (uint256 valueBefore, uint256 valueSet, uint256 valueAfter)",
  "function valueBefore() view returns (uint256)",
  "function valueSet() view returns (uint256)",
  "function valueAfter() view returns (uint256)",
  "function l2CounterProxy() view returns (address)",
  "function l1Counter() view returns (address)",
];

const L1_COUNTER_ABI = [
  "function value() view returns (uint256)",
];

async function main() {
  const provider = new JsonRpcProvider(L1_RPC);
  const wallet = new Wallet("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", provider);
  
  const syncDemo = new Contract(SYNC_DEMO, SYNC_DEMO_ABI, wallet);
  const l1Counter = new Contract(L1_SYNCED_COUNTER, L1_COUNTER_ABI, provider);
  
  console.log("=== Testing SyncDemo.setValue(99) ===\n");
  
  // Verify SyncDemo is configured
  const l2CounterProxy = await syncDemo.l2CounterProxy();
  const l1CounterAddr = await syncDemo.l1Counter();
  console.log("SyncDemo config:");
  console.log("  l2CounterProxy:", l2CounterProxy);
  console.log("  l1Counter:", l1CounterAddr);
  
  if (l2CounterProxy === "0x0000000000000000000000000000000000000000") {
    console.log("\nERROR: SyncDemo not initialized!");
    process.exit(1);
  }
  
  // Get current L1 counter value
  const currentValue = await l1Counter.value();
  console.log("\nCurrent L1SyncedCounter value:", currentValue.toString());
  
  // Check current stored values
  const [vBefore, vSet, vAfter] = await syncDemo.getValues();
  console.log("\nStored values (from previous run):");
  console.log("  valueBefore:", vBefore.toString());
  console.log("  valueSet:", vSet.toString());
  console.log("  valueAfter:", vAfter.toString());
  
  // Prepare the setValue(99) transaction
  console.log("\n=== Calling SyncDemo.setValue(99) ===\n");
  
  const nonce = await provider.getTransactionCount(wallet.address);
  const gasPrice = await provider.getFeeData();
  
  const tx = await wallet.populateTransaction({
    to: SYNC_DEMO,
    data: syncDemo.interface.encodeFunctionData("setValue", [99]),
    nonce: nonce,
    gasLimit: 1000000,
    gasPrice: gasPrice.gasPrice,
  });
  
  const signedTx = await wallet.signTransaction(tx);
  
  // Submit to builder
  console.log("Submitting to builder...");
  
  const response = await fetch(BUILDER_URL + "/submit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      signedTx,
      sourceChain: "L1",
    }),
  });
  
  const result = await response.json();
  console.log("\nBuilder response:", JSON.stringify(result, null, 2));
  
  if (result.error) {
    console.log("\nERROR:", result.error);
    process.exit(1);
  }
  
  // Check the new stored values
  const [newVBefore, newVSet, newVAfter] = await syncDemo.getValues();
  console.log("\n=== Results ===");
  console.log("  valueBefore:", newVBefore.toString(), "(L2 value before update)");
  console.log("  valueSet:", newVSet.toString(), "(value we set)");
  console.log("  valueAfter:", newVAfter.toString(), "(L2 value after update)");
  
  // Verify
  if (newVSet.toString() === "99" && newVAfter.toString() === "99") {
    console.log("\n✓ SUCCESS: Synchronous L1↔L2 composability demonstrated!");
    console.log("  - L2 state was read, modified, and read again");
    console.log("  - All within a single L1 transaction");
  } else {
    console.log("\n✗ FAILED: Values don't match expected");
    console.log("  Expected: valueSet=99, valueAfter=99");
  }
}

main().catch(console.error);
