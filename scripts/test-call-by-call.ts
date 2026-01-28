/**
 * Test Call-by-Call State Transitions
 *
 * For SyncDemo.setValue(66), there are 3 L2 calls:
 * 1. READ: SyncDemo -> L2Proxy.value()
 *    - Caller: SyncDemo (0x2279b7a0...)
 *    - This deploys L1SenderProxyL2 for SyncDemo on L2, changing state!
 *
 * 2. WRITE: L1SyncedCounter -> L2Proxy.setValue(66)
 *    - Caller: L1SyncedCounter (0x2E983A1B...)
 *    - This deploys L1SenderProxyL2 for L1SyncedCounter AND updates value
 *
 * 3. READ: SyncDemo -> L2Proxy.value()
 *    - Caller: SyncDemo (already has proxy deployed)
 *    - Returns the new value (66)
 *
 * For each call, we check:
 * - What state hash did the builder register on L1?
 * - What state hash does the fullnode produce when executing?
 */

import { ethers, JsonRpcProvider, Contract } from "ethers";

const L1_RPC = "http://localhost:8545";
const L2_RPC = "http://localhost:9546";
const ROLLUP_ADDRESS = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512";
const L2_SYNCED_COUNTER = "0x663F3ad617193148711d28f5334eE4Ed07016602";
const SYNC_DEMO_ADDRESS = "0x2279b7a0a67db372996a5fab50d91eaa73d2ebe6";
const L1_SYNCED_COUNTER = "0x2E983A1Ba5e8b38AAAeC4B440B9dDcFBf72E15d1";

const ROLLUP_ABI = [
  "function l2BlockHash() view returns (bytes32)",
  "function getResponseKey(address l2Address, bytes32 stateHash, bytes callData) view returns (bytes32)",
  "function incomingCallRegistered(bytes32 key) view returns (bool)",
  // IncomingCallResponse struct: preOutgoingCallsStateHash, outgoingCalls[], expectedResults[], returnValue, finalStateHash
  "function incomingCallResponses(bytes32 key) view returns (tuple(bytes32 preOutgoingCallsStateHash, tuple(address from, address target, uint256 value, uint256 gas, bytes data, bytes32 postCallStateHash)[] outgoingCalls, bytes[] expectedResults, bytes returnValue, bytes32 finalStateHash))",
];

function computeL1SenderProxyL2Address(l1Address: string): string {
  const hash = ethers.keccak256(ethers.solidityPacked(
    ["string", "address"],
    ["L1SenderProxyL2.v1", l1Address]
  ));
  return "0x" + hash.slice(-40);
}

async function getStateRoot(provider: JsonRpcProvider): Promise<string> {
  const block = await provider.send("eth_getBlockByNumber", ["latest", false]);
  return block?.stateRoot || "0x0";
}

async function main() {
  const l1Provider = new JsonRpcProvider(L1_RPC);
  const l2Provider = new JsonRpcProvider(L2_RPC);
  const rollup = new Contract(ROLLUP_ADDRESS, ROLLUP_ABI, l1Provider);

  console.log("=== Call-by-Call State Analysis ===\n");

  // Get current state
  const currentL2Hash = await rollup.l2BlockHash();
  const currentL2State = await getStateRoot(l2Provider);

  console.log("Current L2 state from L1 contract:", currentL2Hash);
  console.log("Current L2 state from fullnode:   ", currentL2State);
  console.log("Match:", currentL2Hash.toLowerCase() === currentL2State.toLowerCase() ? "YES" : "NO");
  console.log();

  // Analyze the 3 calls that SyncDemo.setValue(66) would make
  const calls = [
    {
      name: "Call 1: READ value()",
      l2Address: L2_SYNCED_COUNTER,
      caller: SYNC_DEMO_ADDRESS,
      callData: "0x3fa4f245", // value()
      isWrite: false,
    },
    {
      name: "Call 2: WRITE setValue(66)",
      l2Address: L2_SYNCED_COUNTER,
      caller: L1_SYNCED_COUNTER, // Called through L1SyncedCounter!
      callData: ethers.AbiCoder.defaultAbiCoder().encode(["bytes4", "uint256"], ["0x55241077", 66]).replace("0x000000000000000000000000000000000000000000000000000000", "0x"),
      isWrite: true,
    },
    {
      name: "Call 3: READ value() (after write)",
      l2Address: L2_SYNCED_COUNTER,
      caller: SYNC_DEMO_ADDRESS,
      callData: "0x3fa4f245", // value()
      isWrite: false,
    },
  ];

  // Fix callData for setValue
  calls[1].callData = "0x55241077" + ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [66]).slice(2);

  let prevStateHash = currentL2Hash;

  for (let i = 0; i < calls.length; i++) {
    const call = calls[i];
    console.log(`\n--- ${call.name} ---`);
    console.log(`  L2 Address: ${call.l2Address}`);
    console.log(`  L1 Caller:  ${call.caller}`);
    console.log(`  CallData:   ${call.callData.slice(0, 20)}...`);
    console.log(`  Is Write:   ${call.isWrite}`);
    console.log();

    // Check what's registered on L1
    const responseKey = await rollup.getResponseKey(call.l2Address, prevStateHash, call.callData);
    const isRegistered = await rollup.incomingCallRegistered(responseKey);

    console.log(`  State hash used for lookup: ${prevStateHash.slice(0, 18)}...`);
    console.log(`  Response key: ${responseKey}`);
    console.log(`  Is registered: ${isRegistered}`);

    if (isRegistered) {
      const response = await rollup.incomingCallResponses(responseKey);
      console.log(`  Registered response:`);
      console.log(`    preOutgoingCallsStateHash: ${response[0].slice(0, 18)}...`);
      console.log(`    outgoingCalls count:       ${response[1].length}`);
      console.log(`    returnValue:               ${response[3]}`);
      console.log(`    finalStateHash:            ${response[4].slice(0, 18)}...`);

      // Update prevStateHash for next call
      prevStateHash = response[4]; // finalStateHash
    } else {
      console.log(`  NOT REGISTERED - cannot continue chain`);
      break;
    }

    // Check L1SenderProxyL2 on L2
    const l1ProxyOnL2 = computeL1SenderProxyL2Address(call.caller);
    const proxyCode = await l2Provider.getCode(l1ProxyOnL2);
    console.log();
    console.log(`  L1 caller's proxy on L2: ${l1ProxyOnL2}`);
    console.log(`  Proxy deployed: ${proxyCode !== "0x" ? "YES" : "NO"}`);
  }

  console.log("\n\n=== Simulating Calls on Fresh L2 ===\n");

  // Now simulate each call on a fresh L2 to see what state roots we get
  console.log("Spawning fresh L2 Anvil for simulation...");

  // We'll use the existing L2 but with snapshots
  const snapshotId = await l2Provider.send("evm_snapshot", []);
  console.log("Created snapshot:", snapshotId);

  try {
    let simStateHash = currentL2Hash;

    for (let i = 0; i < calls.length; i++) {
      const call = calls[i];
      console.log(`\n--- Simulating ${call.name} ---`);

      const l1ProxyOnL2 = computeL1SenderProxyL2Address(call.caller);
      console.log(`  Executing as: ${l1ProxyOnL2}`);

      // Check if proxy needs deployment
      const proxyCode = await l2Provider.getCode(l1ProxyOnL2);
      if (proxyCode === "0x") {
        console.log(`  Deploying L1SenderProxyL2...`);
        // In real implementation, we'd deploy the proxy contract
        // For now, just ensure the account exists with balance
        await l2Provider.send("anvil_setBalance", [
          l1ProxyOnL2,
          "0x" + ethers.parseEther("1").toString(16),
        ]);
      }

      // Impersonate and execute
      await l2Provider.send("anvil_impersonateAccount", [l1ProxyOnL2]);

      const stateBefore = await getStateRoot(l2Provider);
      console.log(`  State before: ${stateBefore.slice(0, 18)}...`);

      if (call.isWrite) {
        // Execute as transaction for writes
        const txHash = await l2Provider.send("eth_sendTransaction", [{
          from: l1ProxyOnL2,
          to: call.l2Address,
          data: call.callData,
          gas: "0x1000000",
        }]);
        const receipt = await l2Provider.waitForTransaction(txHash);
        console.log(`  Tx result: ${receipt?.status === 1 ? "SUCCESS" : "REVERTED"}`);
      } else {
        // Use eth_call for reads (no state change expected from the call itself)
        // But we still need to "execute" to potentially deploy proxy
        const result = await l2Provider.send("eth_call", [{
          from: l1ProxyOnL2,
          to: call.l2Address,
          data: call.callData,
        }, "latest"]);
        console.log(`  Read result: ${result}`);
      }

      await l2Provider.send("anvil_stopImpersonatingAccount", [l1ProxyOnL2]);

      // Mine to commit any state changes
      await l2Provider.send("evm_mine", []);

      const stateAfter = await getStateRoot(l2Provider);
      console.log(`  State after:  ${stateAfter.slice(0, 18)}...`);
      console.log(`  State changed: ${stateBefore !== stateAfter ? "YES" : "NO"}`);

      // Compare with registered
      const responseKey = await rollup.getResponseKey(call.l2Address, simStateHash, call.callData);
      const isRegistered = await rollup.incomingCallRegistered(responseKey);
      if (isRegistered) {
        const response = await rollup.incomingCallResponses(responseKey);
        const registeredFinalState = response[4]; // finalStateHash
        console.log(`  Registered finalStateHash: ${registeredFinalState.slice(0, 18)}...`);
        console.log(`  Simulated stateAfter:      ${stateAfter.slice(0, 18)}...`);
        console.log(`  MATCH: ${registeredFinalState.toLowerCase() === stateAfter.toLowerCase() ? "YES ✓" : "NO ✗"}`);
        simStateHash = registeredFinalState;
      }
    }

  } finally {
    // Revert to snapshot
    await l2Provider.send("evm_revert", [snapshotId]);
    console.log("\nReverted to snapshot");
  }
}

main().catch(console.error);
