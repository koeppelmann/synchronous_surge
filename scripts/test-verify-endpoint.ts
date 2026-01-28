import { ethers } from "ethers";

const ROLLUP_ABI = [
  "event L2BlockProcessed(uint256 indexed l2BlockNumber, bytes32 prevBlockHash, bytes32 newBlockHash, bytes rlpEncodedTx, tuple(address target, bytes data)[] outgoingCalls, bytes[] actualResults)",
  "event IncomingCallHandled(address indexed l2Address, address l1Caller, bytes32 prevBlockHash, bytes callData, uint256 value, bytes32 finalStateHash)",
  "function l2BlockHash() view returns (bytes32)",
];

const L1_RPC = "http://localhost:8545";
const FULLNODE_RPC = "http://localhost:9547";
const ROLLUP = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512";

async function main() {
  const provider = new ethers.JsonRpcProvider(L1_RPC);
  const rollup = new ethers.Contract(ROLLUP, ROLLUP_ABI, provider);

  // Get current fullnode state
  const fnRes = await fetch(FULLNODE_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "nativerollup_getStateRoot", params: [], id: 1 }),
  });
  const fnState = (await fnRes.json() as any).result;

  // Get L1 expected state
  const l1State = await rollup.l2BlockHash();

  console.log(`Fullnode state: ${fnState}`);
  console.log(`L1 state:       ${l1State}`);
  console.log(`In sync:        ${fnState.toLowerCase() === l1State.toLowerCase() ? "YES" : "NO"}`);
  console.log();

  // Fetch all events
  const l2blocks = await rollup.queryFilter(rollup.filters.L2BlockProcessed(), 0, "latest");
  const incoming = await rollup.queryFilter(rollup.filters.IncomingCallHandled(), 0, "latest");

  interface Ev {
    type: "L2BlockProcessed" | "IncomingCallHandled";
    block: number;
    logIndex: number;
    args: any;
  }

  const all: Ev[] = [
    ...l2blocks.map((e) => ({
      type: "L2BlockProcessed" as const,
      block: e.blockNumber,
      logIndex: (e as any).index,
      args: (e as ethers.EventLog).args,
    })),
    ...incoming.map((e) => ({
      type: "IncomingCallHandled" as const,
      block: e.blockNumber,
      logIndex: (e as any).index,
      args: (e as ethers.EventLog).args,
    })),
  ];
  all.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);

  console.log(`Found ${all.length} events to verify:`);
  for (const e of all) {
    if (e.type === "L2BlockProcessed") {
      console.log(`  [${e.block}] L2Block: ${e.args.prevBlockHash.slice(0, 14)}... -> ${e.args.newBlockHash.slice(0, 14)}...`);
    } else {
      console.log(`  [${e.block}] IncomingCall: ${e.args.prevBlockHash.slice(0, 14)}... -> ${e.args.finalStateHash.slice(0, 14)}... caller=${e.args.l1Caller.slice(0, 10)}`);
    }
  }
  console.log();

  // Build events array for verifyStateChain
  const events = all.map((e) => {
    if (e.type === "L2BlockProcessed") {
      return {
        type: "L2BlockProcessed" as const,
        rlpEncodedTx: e.args.rlpEncodedTx,
        expectedPreStateHash: e.args.prevBlockHash,
        expectedPostStateHash: e.args.newBlockHash,
      };
    } else {
      return {
        type: "IncomingCallHandled" as const,
        l2Address: e.args.l2Address,
        l1Caller: e.args.l1Caller,
        callData: e.args.callData,
        value: e.args.value.toString(),
        expectedPreStateHash: e.args.prevBlockHash,
        expectedPostStateHash: e.args.finalStateHash,
      };
    }
  });

  // Call verifyStateChain
  console.log("Calling nativerollup_verifyStateChain...");
  const verifyRes = await fetch(FULLNODE_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "nativerollup_verifyStateChain",
      params: [{ events }],
      id: 2,
    }),
  });
  const verifyResult = (await verifyRes.json() as any).result;

  if (!verifyResult) {
    console.log("ERROR: No result from verifyStateChain");
    return;
  }

  console.log(`\nResults (allMatch: ${verifyResult.allMatch}, firstDivergence: ${verifyResult.firstDivergence}):\n`);
  for (const r of verifyResult.results) {
    const preOk = r.preMatch ? "OK" : "MISMATCH";
    const postOk = r.postMatch ? "OK" : "MISMATCH";
    console.log(`  Event ${r.index} (${r.type}):`);
    console.log(`    Pre:  ${preOk}  expected=${r.expectedPreStateHash.slice(0, 14)}... actual=${r.actualPreStateHash.slice(0, 14)}...`);
    console.log(`    Post: ${postOk}  expected=${r.expectedPostStateHash.slice(0, 14)}... actual=${r.actualPostStateHash.slice(0, 14)}...`);
    if (r.returnData) {
      console.log(`    Return: ${r.returnData}`);
    }
  }

  if (verifyResult.allMatch) {
    console.log("\nSUCCESS: Fullnode can reproduce the entire state chain from events!");
  } else {
    console.log(`\nFAILED: Divergence at event ${verifyResult.firstDivergence}`);
  }
}

main().catch(console.error);
