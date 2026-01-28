/**
 * Diagnose state divergence between builder expectations and fullnode execution.
 *
 * Fetches IncomingCallHandled events from L1, extracts expected state hashes,
 * then asks the fullnode to replay them and report where divergence occurs.
 */
import { ethers, JsonRpcProvider, Contract } from "ethers";

const L1_RPC = "http://localhost:8545";
const FULLNODE_RPC = "http://localhost:9547";
const ROLLUP_ADDRESS = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512";

const ROLLUP_ABI = [
  "event IncomingCallHandled(address indexed l2Address, address indexed l1Caller, bytes32 indexed prevBlockHash, bytes callData, uint256 value, tuple(address from, address target, uint256 value, uint256 gas, bytes data, bytes32 postCallStateHash)[] outgoingCalls, bytes[] outgoingCallResults, bytes32 finalStateHash)",
  "event L2BlockProcessed(uint256 indexed blockNumber, bytes32 indexed prevBlockHash, bytes32 indexed newBlockHash, bytes rlpEncodedTx, tuple(address from, address target, uint256 value, uint256 gas, bytes data, bytes32 postCallStateHash)[] outgoingCalls, bytes[] outgoingCallResults)",
  "function l2BlockHash() view returns (bytes32)",
];

async function fullnodeRpc(method: string, params: any[] = []): Promise<any> {
  const response = await fetch(FULLNODE_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json: any = await response.json();
  if (json.error) throw new Error(json.error.message);
  return json.result;
}

async function main() {
  const l1Provider = new JsonRpcProvider(L1_RPC);
  const rollup = new Contract(ROLLUP_ADDRESS, ROLLUP_ABI, l1Provider);

  // Get current state
  const l1StateHash = await rollup.l2BlockHash();
  const fullnodeState = await fullnodeRpc("nativerollup_getStateRoot");

  console.log("=== State Divergence Diagnosis ===\n");
  console.log(`L1 state hash:       ${l1StateHash}`);
  console.log(`Fullnode state hash: ${fullnodeState}`);
  console.log(`Match: ${l1StateHash.toLowerCase() === fullnodeState.toLowerCase() ? "YES" : "NO - DIVERGED"}\n`);

  // Fetch all events
  const [l2BlockEvents, incomingCallEvents] = await Promise.all([
    rollup.queryFilter(rollup.filters.L2BlockProcessed(), 0, "latest"),
    rollup.queryFilter(rollup.filters.IncomingCallHandled(), 0, "latest"),
  ]);

  // Combine and sort
  interface EventInfo {
    type: "L2BlockProcessed" | "IncomingCallHandled";
    blockNumber: number;
    logIndex: number;
    event: ethers.EventLog;
  }

  const allEvents: EventInfo[] = [
    ...l2BlockEvents.map((e) => ({
      type: "L2BlockProcessed" as const,
      blockNumber: e.blockNumber,
      logIndex: (e as ethers.EventLog).index,
      event: e as ethers.EventLog,
    })),
    ...incomingCallEvents.map((e) => ({
      type: "IncomingCallHandled" as const,
      blockNumber: e.blockNumber,
      logIndex: (e as ethers.EventLog).index,
      event: e as ethers.EventLog,
    })),
  ];

  allEvents.sort((a, b) => {
    if (a.blockNumber !== b.blockNumber) return a.blockNumber - b.blockNumber;
    return a.logIndex - b.logIndex;
  });

  console.log(`Total events: ${allEvents.length} (${l2BlockEvents.length} L2Block, ${incomingCallEvents.length} IncomingCall)\n`);

  // Build verification chain
  const verifyEvents: any[] = [];

  for (const { type, blockNumber, logIndex, event } of allEvents) {
    if (type === "IncomingCallHandled") {
      const { l2Address, l1Caller, prevBlockHash, callData, value, finalStateHash } = event.args;
      console.log(`Event: IncomingCallHandled (L1 #${blockNumber}, log ${logIndex})`);
      console.log(`  L1 Caller: ${l1Caller}`);
      console.log(`  L2 Target: ${l2Address}`);
      console.log(`  CallData:  ${callData.slice(0, 10)}...`);
      console.log(`  Pre:  ${prevBlockHash}`);
      console.log(`  Post: ${finalStateHash}`);
      console.log();

      verifyEvents.push({
        type: "IncomingCallHandled",
        l2Address,
        l1Caller,
        callData,
        value: value.toString(),
        expectedPreStateHash: prevBlockHash,
        expectedPostStateHash: finalStateHash,
      });
    } else {
      const { prevBlockHash, newBlockHash, rlpEncodedTx } = event.args;
      console.log(`Event: L2BlockProcessed (L1 #${blockNumber}, log ${logIndex})`);
      console.log(`  Pre:  ${prevBlockHash}`);
      console.log(`  Post: ${newBlockHash}`);
      console.log();

      verifyEvents.push({
        type: "L2BlockProcessed",
        rlpEncodedTx,
        expectedPreStateHash: prevBlockHash,
        expectedPostStateHash: newBlockHash,
      });
    }
  }

  // Call fullnode verification
  console.log("=== Replaying on Fullnode ===\n");
  const result = await fullnodeRpc("nativerollup_verifyStateChain", [{ events: verifyEvents }]);

  for (const r of result.results) {
    const preStatus = r.preMatch ? "OK" : "MISMATCH";
    const postStatus = r.postMatch ? "OK" : "MISMATCH";
    console.log(`Event ${r.index} (${r.type}):`);
    console.log(`  Pre:  expected=${r.expectedPreStateHash.slice(0, 14)}... actual=${r.actualPreStateHash.slice(0, 14)}... [${preStatus}]`);
    console.log(`  Post: expected=${r.expectedPostStateHash.slice(0, 14)}... actual=${r.actualPostStateHash.slice(0, 14)}... [${postStatus}]`);
    if (r.returnData && r.returnData !== "0x") {
      // Try to decode return data
      try {
        const value = BigInt(r.returnData);
        console.log(`  Return: ${r.returnData} (${value})`);
      } catch {
        console.log(`  Return: ${r.returnData.slice(0, 66)}...`);
      }
    }
    console.log();
  }

  if (result.allMatch) {
    console.log("=== ALL STATE TRANSITIONS MATCH ===");
    console.log("The fullnode can deterministically reproduce all L1-recorded state hashes.");
  } else {
    console.log(`=== DIVERGENCE DETECTED at event ${result.firstDivergence} ===`);
    const diverged = result.results[result.firstDivergence];
    console.log(`\nDiverging event details:`);
    console.log(`  Type: ${diverged.type}`);
    console.log(`  Expected post: ${diverged.expectedPostStateHash}`);
    console.log(`  Actual post:   ${diverged.actualPostStateHash}`);
    console.log(`\nThe builder produced a different state hash than the fullnode.`);
    console.log(`This means the builder's simulation diverged from deterministic replay.`);
  }
}

main().catch(console.error);
