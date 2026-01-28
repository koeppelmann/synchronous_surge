/**
 * Verify State Chain
 *
 * This script verifies that:
 * 1. All L1 events form a valid state chain (each event's prevState = previous event's newState)
 * 2. The current fullnode state matches the final expected state
 * 3. Optionally replays events on an existing fullnode
 *
 * Usage:
 *   npx tsx scripts/verify-state-chain.ts [--l1-rpc <url>] [--rollup <address>] [--fullnode <url>]
 */

import { ethers, JsonRpcProvider, Contract, Transaction } from "ethers";

// ============ Configuration ============

interface Config {
  l1Rpc: string;
  rollupAddress: string;
  fullnodeRpc: string;
}

const DEFAULT_CONFIG: Config = {
  l1Rpc: process.env.L1_RPC || "http://localhost:8545",
  rollupAddress: process.env.ROLLUP_ADDRESS || "",
  fullnodeRpc: process.env.FULLNODE_RPC || "http://localhost:9547",
};

// ============ ABIs ============

const ROLLUP_ABI = [
  "event L2BlockProcessed(uint256 indexed blockNumber, bytes32 indexed prevBlockHash, bytes32 indexed newBlockHash, bytes rlpEncodedTx, tuple(address from, address target, uint256 value, uint256 gas, bytes data, bytes32 postCallStateHash)[] outgoingCalls, bytes[] outgoingCallResults)",
  "event IncomingCallHandled(address indexed l2Address, address indexed l1Caller, bytes32 indexed prevBlockHash, bytes callData, uint256 value, tuple(address from, address target, uint256 value, uint256 gas, bytes data, bytes32 postCallStateHash)[] outgoingCalls, bytes[] outgoingCallResults, bytes32 finalStateHash)",
  "function l2BlockHash() view returns (bytes32)",
  "function l2BlockNumber() view returns (uint256)",
];

// Known function selectors
const KNOWN_FUNCTIONS: Record<string, { name: string; params: string[] }> = {
  "0x55241077": { name: "setValue", params: ["uint256"] },
  "0x96fc4414": { name: "setL2Proxy", params: ["address"] },
  "0x549290ad": { name: "setL1ContractProxy", params: ["address"] },
  "0xec63d87f": { name: "setL1Counter", params: ["address"] },
  "0x3fa4f245": { name: "value", params: [] },
};

// ============ Types ============

interface L2Event {
  type: "L2BlockProcessed" | "IncomingCallHandled";
  l1Block: number;
  l1TxIndex: number;
  l1TxHash: string;
  prevStateHash: string;
  newStateHash: string;
  blockNumber?: bigint;
  rlpEncodedTx?: string;
  l2Address?: string;
  l1Caller?: string;
  callData?: string;
  value?: bigint;
  decodedCall?: string;
}

// ============ Logging ============

const COLORS = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

function decodeCalldata(data: string): string {
  if (!data || data.length < 10) return data || "0x";

  const selector = data.slice(0, 10).toLowerCase();
  const funcInfo = KNOWN_FUNCTIONS[selector];

  if (!funcInfo) return `${selector}...`;

  if (funcInfo.params.length === 0) return `${funcInfo.name}()`;

  try {
    const abiCoder = ethers.AbiCoder.defaultAbiCoder();
    const decoded = abiCoder.decode(funcInfo.params, "0x" + data.slice(10));
    const args = decoded.map((arg, i) =>
      funcInfo.params[i] === "uint256" ? arg.toString() : arg
    );
    return `${funcInfo.name}(${args.join(", ")})`;
  } catch {
    return `${funcInfo.name}(?)`;
  }
}

// ============ Main ============

async function main() {
  const config: Config = { ...DEFAULT_CONFIG };

  // Parse args
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--l1-rpc":
        config.l1Rpc = args[++i];
        break;
      case "--rollup":
        config.rollupAddress = args[++i];
        break;
      case "--fullnode":
        config.fullnodeRpc = args[++i];
        break;
    }
  }

  if (!config.rollupAddress) {
    console.error("Error: --rollup <address> required");
    process.exit(1);
  }

  console.log("\n╔════════════════════════════════════════════════════════════════╗");
  console.log("║              L2 State Chain Verification                        ║");
  console.log("╚════════════════════════════════════════════════════════════════╝\n");

  const l1Provider = new JsonRpcProvider(config.l1Rpc);
  const rollup = new Contract(config.rollupAddress, ROLLUP_ABI, l1Provider);

  // Get current L1 state
  const [currentL2Hash, currentL2BlockNum] = await Promise.all([
    rollup.l2BlockHash(),
    rollup.l2BlockNumber(),
  ]);

  console.log(`${COLORS.cyan}L1 Contract State:${COLORS.reset}`);
  console.log(`  Rollup Address: ${config.rollupAddress}`);
  console.log(`  Current L2 Hash: ${currentL2Hash}`);
  console.log(`  Current L2 Block: ${currentL2BlockNum}\n`);

  // Query events
  console.log(`${COLORS.cyan}Fetching L1 events...${COLORS.reset}\n`);

  const [l2BlockEvents, incomingCallEvents] = await Promise.all([
    rollup.queryFilter(rollup.filters.L2BlockProcessed(), 0, "latest"),
    rollup.queryFilter(rollup.filters.IncomingCallHandled(), 0, "latest"),
  ]);

  const events: L2Event[] = [];

  // Process L2BlockProcessed events
  for (const event of l2BlockEvents) {
    const eventLog = event as ethers.EventLog;
    const args = eventLog.args;

    let decodedCall = "(deploy)";
    try {
      const tx = Transaction.from(args.rlpEncodedTx);
      if (tx.to) {
        decodedCall = decodeCalldata(tx.data);
      }
    } catch {}

    events.push({
      type: "L2BlockProcessed",
      l1Block: event.blockNumber,
      l1TxIndex: event.index,
      l1TxHash: event.transactionHash,
      prevStateHash: args.prevBlockHash,
      newStateHash: args.newBlockHash,
      blockNumber: args.blockNumber,
      rlpEncodedTx: args.rlpEncodedTx,
      decodedCall,
    });
  }

  // Process IncomingCallHandled events
  for (const event of incomingCallEvents) {
    const eventLog = event as ethers.EventLog;
    const args = eventLog.args;

    events.push({
      type: "IncomingCallHandled",
      l1Block: event.blockNumber,
      l1TxIndex: event.index,
      l1TxHash: event.transactionHash,
      prevStateHash: args.prevBlockHash,
      newStateHash: args.finalStateHash,
      l2Address: args.l2Address,
      l1Caller: args.l1Caller,
      callData: args.callData,
      value: args.value,
      decodedCall: decodeCalldata(args.callData),
    });
  }

  // Sort by L1 block, then tx index
  events.sort((a, b) => {
    if (a.l1Block !== b.l1Block) return a.l1Block - b.l1Block;
    return a.l1TxIndex - b.l1TxIndex;
  });

  if (events.length === 0) {
    console.log("No events found.\n");
    process.exit(0);
  }

  // Print state chain
  console.log(`${COLORS.cyan}L2 State Chain (${events.length} state transitions):${COLORS.reset}\n`);

  const genesisState = events[0].prevStateHash;
  console.log(`┌─────────────────────────────────────────────────────────────────┐`);
  console.log(`│ ${COLORS.yellow}GENESIS${COLORS.reset}                                                         │`);
  console.log(`│ State: ${genesisState.slice(0, 18)}...${genesisState.slice(-8)}               │`);
  console.log(`└─────────────────────────────────────────────────────────────────┘`);
  console.log(`                              │`);

  let chainValid = true;
  let expectedPrev = genesisState;

  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    const isLast = i === events.length - 1;

    // Check chain continuity
    const prevMatch = e.prevStateHash.toLowerCase() === expectedPrev.toLowerCase();
    if (!prevMatch) {
      chainValid = false;
    }

    const typeColor = e.type === "L2BlockProcessed" ? COLORS.blue : COLORS.yellow;
    const typeLabel = e.type === "L2BlockProcessed" ? "L2 TX" : "L1→L2";
    const blockLabel = e.type === "L2BlockProcessed" ? `Block #${e.blockNumber}` : "Incoming";

    console.log(`                              ▼`);
    console.log(`┌─────────────────────────────────────────────────────────────────┐`);
    console.log(`│ ${typeColor}${typeLabel}${COLORS.reset} ${blockLabel.padEnd(12)} ${COLORS.gray}L1 #${e.l1Block}${COLORS.reset}                              │`);

    if (!prevMatch) {
      console.log(`│ ${COLORS.red}⚠ CHAIN BREAK!${COLORS.reset}                                                  │`);
      console.log(`│   Expected: ${expectedPrev.slice(0, 18)}...                            │`);
      console.log(`│   Got:      ${e.prevStateHash.slice(0, 18)}...                            │`);
    }

    console.log(`│ Prev: ${e.prevStateHash.slice(0, 18)}...${e.prevStateHash.slice(-8)}                   │`);
    console.log(`│  New: ${e.newStateHash.slice(0, 18)}...${e.newStateHash.slice(-8)}                   │`);

    // Show call details
    if (e.type === "L2BlockProcessed") {
      console.log(`│ Call: ${(e.decodedCall || "").slice(0, 50).padEnd(50)}          │`);
    } else {
      const callerShort = (e.l1Caller || "").slice(0, 10) + "...";
      const targetShort = (e.l2Address || "").slice(0, 10) + "...";
      console.log(`│ From: ${callerShort} → ${targetShort}                          │`);
      console.log(`│ Call: ${(e.decodedCall || "").slice(0, 50).padEnd(50)}          │`);
      if (e.value && e.value > 0n) {
        console.log(`│ Value: ${ethers.formatEther(e.value)} ETH                                        │`);
      }
    }

    if (isLast) {
      const isCurrent = e.newStateHash.toLowerCase() === currentL2Hash.toLowerCase();
      if (isCurrent) {
        console.log(`│ ${COLORS.green}✓ CURRENT STATE${COLORS.reset}                                                │`);
      }
    }

    console.log(`└─────────────────────────────────────────────────────────────────┘`);

    expectedPrev = e.newStateHash;
  }

  // Summary
  console.log(`\n${COLORS.cyan}═══════════════════════════════════════════════════════════════════${COLORS.reset}\n`);

  const finalState = events[events.length - 1].newStateHash;
  const stateMatchesL1 = finalState.toLowerCase() === currentL2Hash.toLowerCase();

  console.log(`${COLORS.cyan}Verification Results:${COLORS.reset}`);
  console.log(`  Chain Continuity: ${chainValid ? COLORS.green + "✓ VALID" : COLORS.red + "✗ BROKEN"}${COLORS.reset}`);
  console.log(`  Final State Matches L1: ${stateMatchesL1 ? COLORS.green + "✓ YES" : COLORS.red + "✗ NO"}${COLORS.reset}`);

  if (!stateMatchesL1) {
    console.log(`\n  ${COLORS.red}Expected: ${currentL2Hash}${COLORS.reset}`);
    console.log(`  ${COLORS.red}Got:      ${finalState}${COLORS.reset}`);
  }

  // Check fullnode state if available
  try {
    const response = await fetch(config.fullnodeRpc, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "nativerollup_getStateRoot",
        params: [],
        id: 1,
      }),
    });
    const json = await response.json();
    const fullnodeState = json.result;

    const fullnodeMatchesL1 = fullnodeState?.toLowerCase() === currentL2Hash.toLowerCase();
    console.log(`  Fullnode State Matches L1: ${fullnodeMatchesL1 ? COLORS.green + "✓ YES" : COLORS.yellow + "✗ NO"}${COLORS.reset}`);

    if (!fullnodeMatchesL1 && fullnodeState) {
      console.log(`\n  ${COLORS.yellow}Fullnode: ${fullnodeState}${COLORS.reset}`);
      console.log(`  ${COLORS.yellow}L1:       ${currentL2Hash}${COLORS.reset}`);
    }
  } catch {
    console.log(`  Fullnode: ${COLORS.gray}(not reachable at ${config.fullnodeRpc})${COLORS.reset}`);
  }

  console.log();

  if (!chainValid || !stateMatchesL1) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
