import { ethers, JsonRpcProvider, Wallet, Contract } from "ethers";

const L1_RPC = "http://localhost:8545";
const BUILDER_URL = "http://localhost:3200";

const CALL_LOGGER = "0xa513E6E4b8f2a923D98304ec87F64353C4D5C853";
const L2_SENDER_PROXY = "0xc5AdD61254C6CB1dA0929A571A5D13B1EaC36281"; // L2SyncedCounter proxy on L1

const CALL_LOGGER_ABI = [
  "function makeCall(address target, bytes data) returns (bool success, bytes returnData)",
  "function getResult(uint256 index) view returns (bool success, bytes returnData)",
  "function callCount() view returns (uint256)",
];

async function main() {
  const provider = new JsonRpcProvider(L1_RPC);
  // Use a DIFFERENT account than admin (account #2 = proposer)
  // Admin wallet is used by builder for registerIncomingCall, so using same account causes nonce conflicts
  const wallet = new Wallet(
    "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
    provider
  );
  console.log(`Sender: ${wallet.address}`);

  const callLogger = new Contract(CALL_LOGGER, CALL_LOGGER_ABI, wallet);

  console.log("=== CallLogger: Read L2SyncedCounter.value() via proxy ===\n");
  console.log(`CallLogger: ${CALL_LOGGER}`);
  console.log(`L2SenderProxy: ${L2_SENDER_PROXY}`);
  console.log(`Target call: value() [0x3fa4f245]\n`);

  // Encode value() call
  const valueSelector = "0x3fa4f245";

  // Build the transaction: callLogger.makeCall(proxy, value())
  const nonce = await provider.getTransactionCount(wallet.address);
  const tx = await wallet.populateTransaction({
    to: CALL_LOGGER,
    data: callLogger.interface.encodeFunctionData("makeCall", [
      L2_SENDER_PROXY,
      valueSelector,
    ]),
    nonce,
    gasLimit: 1000000,
    gasPrice: ethers.parseUnits("100", "gwei"),
  });

  const signedTx = await wallet.signTransaction(tx);

  console.log("Submitting to builder...");
  const response = await fetch(`${BUILDER_URL}/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ signedTx, sourceChain: "L1" }),
  });

  const result = await response.json();
  console.log("\nBuilder response:", JSON.stringify(result, null, 2));

  if (result.error) {
    console.log("\nFAILED:", result.error);

    // Check builder logs for details
    console.log("\nCheck logs/builder.log for details");
    process.exit(1);
  }

  // Read the stored result
  const count = await callLogger.callCount();
  console.log(`\nCallLogger.callCount: ${count}`);

  if (count > 0n) {
    const [success, returnData] = await callLogger.getResult(count - 1n);
    console.log(`Result[${count - 1n}]:`);
    console.log(`  success: ${success}`);
    console.log(`  returnData: ${returnData}`);

    if (success && returnData.length > 2) {
      const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
        ["uint256"],
        returnData
      );
      console.log(`  decoded value: ${decoded[0]}`);

      if (decoded[0].toString() === "42") {
        console.log("\n SUCCESS: L2SyncedCounter.value() returned 42 via proxy!");
      } else {
        console.log(
          `\n UNEXPECTED: Expected 42, got ${decoded[0]}`
        );
      }
    } else if (success) {
      console.log("\n ISSUE: Call succeeded but returned empty data");
    } else {
      console.log("\n FAILED: The L2 proxy call reverted");
    }
  }
}

main().catch(console.error);
