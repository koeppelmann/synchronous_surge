/**
 * Test Event Sync
 *
 * This test verifies that:
 * 1. A fresh fullnode can sync from L1 events
 * 2. After each event, the fullnode's state root matches the expected state
 *
 * Usage:
 *   npx tsx scripts/test-event-sync.ts [--l1-rpc <url>] [--rollup <address>]
 */

import { ethers, JsonRpcProvider, Contract, Transaction } from "ethers";
import { spawn, ChildProcess } from "child_process";
import * as path from "path";

// ============ Configuration ============

interface TestConfig {
  l1Rpc: string;
  rollupAddress: string;
  l2Port: number;
  fullnodeRpcPort: number;
  l2ChainId: number;
  systemPrivateKey: string;
}

const DEFAULT_CONFIG: TestConfig = {
  l1Rpc: process.env.L1_RPC || "http://localhost:8545",
  rollupAddress: process.env.ROLLUP_ADDRESS || "",
  l2Port: parseInt(process.env.TEST_L2_PORT || "19546"),
  fullnodeRpcPort: parseInt(process.env.TEST_FULLNODE_PORT || "19547"),
  l2ChainId: parseInt(process.env.L2_CHAIN_ID || "10200200"),
  systemPrivateKey: "0x0000000000000000000000000000000000000000000000000000000000000001",
};

// ============ ABIs ============

const ROLLUP_ABI = [
  "event L2BlockProcessed(uint256 indexed blockNumber, bytes32 indexed prevBlockHash, bytes32 indexed newBlockHash, bytes rlpEncodedTx, tuple(address from, address target, uint256 value, uint256 gas, bytes data, bytes32 postCallStateHash)[] outgoingCalls, bytes[] outgoingCallResults)",
  "event IncomingCallHandled(address indexed l2Address, address indexed l1Caller, bytes32 indexed prevBlockHash, bytes callData, uint256 value, tuple(address from, address target, uint256 value, uint256 gas, bytes data, bytes32 postCallStateHash)[] outgoingCalls, bytes[] outgoingCallResults, bytes32 finalStateHash)",
  "function l2BlockHash() view returns (bytes32)",
  "function l2BlockNumber() view returns (uint256)",
];

// Known function selectors for decoding
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
  l1TxHash: string;
  prevStateHash: string;
  newStateHash: string;
  // L2BlockProcessed specific
  blockNumber?: bigint;
  rlpEncodedTx?: string;
  // IncomingCallHandled specific
  l2Address?: string;
  l1Caller?: string;
  callData?: string;
  value?: bigint;
  // Decoded info
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
};

function log(message: string) {
  console.log(`[Test] ${message}`);
}

function logSuccess(message: string) {
  console.log(`${COLORS.green}[PASS]${COLORS.reset} ${message}`);
}

function logError(message: string) {
  console.log(`${COLORS.red}[FAIL]${COLORS.reset} ${message}`);
}

function logInfo(message: string) {
  console.log(`${COLORS.cyan}[INFO]${COLORS.reset} ${message}`);
}

// ============ Calldata Decoder ============

function decodeCalldata(data: string): string {
  if (!data || data.length < 10) {
    return data || "0x";
  }

  const selector = data.slice(0, 10).toLowerCase();
  const funcInfo = KNOWN_FUNCTIONS[selector];

  if (!funcInfo) {
    return `${selector}...`;
  }

  if (funcInfo.params.length === 0) {
    return `${funcInfo.name}()`;
  }

  try {
    const abiCoder = ethers.AbiCoder.defaultAbiCoder();
    const paramsData = "0x" + data.slice(10);
    const decoded = abiCoder.decode(funcInfo.params, paramsData);

    const args = decoded.map((arg, i) => {
      if (funcInfo.params[i] === "address") {
        return arg;
      } else if (funcInfo.params[i] === "uint256") {
        return arg.toString();
      }
      return arg.toString();
    });

    return `${funcInfo.name}(${args.join(", ")})`;
  } catch {
    return `${funcInfo.name}(?)`;
  }
}

// ============ Event Extraction ============

async function extractEvents(l1Provider: JsonRpcProvider, rollupAddress: string): Promise<L2Event[]> {
  log("Extracting L2 events from L1...");

  const rollup = new Contract(rollupAddress, ROLLUP_ABI, l1Provider);

  // Query both event types
  const [l2BlockEvents, incomingCallEvents] = await Promise.all([
    rollup.queryFilter(rollup.filters.L2BlockProcessed(), 0, "latest"),
    rollup.queryFilter(rollup.filters.IncomingCallHandled(), 0, "latest"),
  ]);

  const events: L2Event[] = [];

  // Process L2BlockProcessed events
  for (const event of l2BlockEvents) {
    const eventLog = event as ethers.EventLog;
    const args = eventLog.args;

    // Decode the RLP-encoded transaction
    let decodedCall = "(deploy)";
    try {
      const tx = Transaction.from(args.rlpEncodedTx);
      if (tx.to) {
        decodedCall = `${tx.to.slice(0, 10)}...${decodeCalldata(tx.data)}`;
      }
    } catch {
      // Keep deploy
    }

    events.push({
      type: "L2BlockProcessed",
      l1Block: event.blockNumber,
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

    const decodedCall = decodeCalldata(args.callData);

    events.push({
      type: "IncomingCallHandled",
      l1Block: event.blockNumber,
      l1TxHash: event.transactionHash,
      prevStateHash: args.prevBlockHash,
      newStateHash: args.finalStateHash,
      l2Address: args.l2Address,
      l1Caller: args.l1Caller,
      callData: args.callData,
      value: args.value,
      decodedCall,
    });
  }

  // Sort by L1 block number, then by transaction index
  events.sort((a, b) => {
    if (a.l1Block !== b.l1Block) return a.l1Block - b.l1Block;
    return (a.l1TxHash || "").localeCompare(b.l1TxHash || "");
  });

  log(`Found ${events.length} events (${l2BlockEvents.length} L2BlockProcessed, ${incomingCallEvents.length} IncomingCallHandled)`);

  return events;
}

// ============ Fullnode Management ============

async function startTestFullnode(config: TestConfig): Promise<{
  fullnodeProcess: ChildProcess;
  fullnodeRpc: string;
  l2Rpc: string;
}> {
  const fullnodeRpc = `http://localhost:${config.fullnodeRpcPort}`;
  const l2Rpc = `http://localhost:${config.l2Port}`;

  log(`Starting test fullnode on ports ${config.l2Port} (EVM) / ${config.fullnodeRpcPort} (RPC)...`);

  const scriptPath = path.join(process.cwd(), "fullnode", "l2-fullnode.ts");

  const fullnodeProcess = spawn("npx", [
    "tsx",
    scriptPath,
    "--l1-rpc", config.l1Rpc,
    "--rollup", config.rollupAddress,
    "--l2-port", config.l2Port.toString(),
    "--rpc-port", config.fullnodeRpcPort.toString(),
  ], {
    stdio: ["ignore", "pipe", "pipe"],
    cwd: process.cwd(),
    env: {
      ...process.env,
      // Prevent it from watching L1 events (we want to replay manually)
      DISABLE_L1_WATCH: "true",
    },
  });

  // Capture output for debugging
  let stdout = "";
  let stderr = "";
  fullnodeProcess.stdout?.on("data", (data) => {
    stdout += data.toString();
  });
  fullnodeProcess.stderr?.on("data", (data) => {
    stderr += data.toString();
  });

  // Wait for fullnode to be ready
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      console.log("stdout:", stdout.slice(-1000));
      console.log("stderr:", stderr.slice(-1000));
      reject(new Error("Fullnode start timeout"));
    }, 30000);

    const check = async () => {
      try {
        const response = await fetch(fullnodeRpc, {
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
        if (json.result) {
          clearTimeout(timeout);
          resolve();
        } else {
          setTimeout(check, 200);
        }
      } catch {
        setTimeout(check, 200);
      }
    };

    fullnodeProcess.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    setTimeout(check, 500);
  });

  log("Test fullnode started");

  return { fullnodeProcess, fullnodeRpc, l2Rpc };
}

async function getFullnodeStateRoot(fullnodeRpc: string): Promise<string> {
  const response = await fetch(fullnodeRpc, {
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
  return json.result;
}

async function executeL2Transaction(fullnodeRpc: string, rlpEncodedTx: string): Promise<{
  success: boolean;
  newStateRoot: string;
  error?: string;
}> {
  const response = await fetch(fullnodeRpc, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "nativerollup_executeL2Transaction",
      params: [rlpEncodedTx],
      id: 1,
    }),
  });
  const json = await response.json();
  if (json.error) {
    return { success: false, newStateRoot: "", error: json.error.message };
  }
  return json.result;
}

async function executeL1ToL2Call(fullnodeRpc: string, params: {
  l1Caller: string;
  l2Target: string;
  callData: string;
  value: string;
}): Promise<{
  success: boolean;
  newStateRoot: string;
  error?: string;
}> {
  const response = await fetch(fullnodeRpc, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "nativerollup_executeL1ToL2Call",
      params: [params],
      id: 1,
    }),
  });
  const json = await response.json();
  if (json.error) {
    return { success: false, newStateRoot: "", error: json.error.message };
  }
  return json.result;
}

// ============ Main Test ============

async function main() {
  const config: TestConfig = { ...DEFAULT_CONFIG };

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
      case "--l2-port":
        config.l2Port = parseInt(args[++i]);
        break;
      case "--fullnode-port":
        config.fullnodeRpcPort = parseInt(args[++i]);
        break;
    }
  }

  if (!config.rollupAddress) {
    console.error("Error: --rollup <address> required");
    process.exit(1);
  }

  console.log("\n========================================");
  console.log("  Event Sync Test");
  console.log("========================================\n");

  const l1Provider = new JsonRpcProvider(config.l1Rpc);

  // Step 1: Extract events from L1
  const events = await extractEvents(l1Provider, config.rollupAddress);

  if (events.length === 0) {
    log("No events found. Nothing to test.");
    process.exit(0);
  }

  // Get genesis state (prevHash of first event)
  const genesisState = events[0].prevStateHash;
  logInfo(`Genesis state: ${genesisState.slice(0, 18)}...`);

  // Print events summary
  console.log("\n--- Events to Replay ---\n");
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    const shortPrev = e.prevStateHash.slice(0, 12) + "...";
    const shortNew = e.newStateHash.slice(0, 12) + "...";

    if (e.type === "L2BlockProcessed") {
      console.log(`${i + 1}. L2 Block #${e.blockNumber} (L1 #${e.l1Block})`);
      console.log(`   ${shortPrev} -> ${shortNew}`);
      console.log(`   Call: ${e.decodedCall}`);
    } else {
      console.log(`${i + 1}. L1->L2 Call (L1 #${e.l1Block})`);
      console.log(`   ${shortPrev} -> ${shortNew}`);
      console.log(`   L1 Caller: ${e.l1Caller?.slice(0, 10)}...`);
      console.log(`   L2 Target: ${e.l2Address?.slice(0, 10)}...`);
      console.log(`   Call: ${e.decodedCall}`);
    }
    console.log();
  }

  // Step 2: Start a fresh test fullnode
  let fullnodeProcess: ChildProcess | null = null;

  try {
    const { fullnodeProcess: fp, fullnodeRpc } = await startTestFullnode(config);
    fullnodeProcess = fp;

    // Get initial state
    const initialState = await getFullnodeStateRoot(fullnodeRpc);
    logInfo(`Fullnode initial state: ${initialState.slice(0, 18)}...`);

    // Verify genesis matches
    if (initialState.toLowerCase() !== genesisState.toLowerCase()) {
      logError(`Genesis state mismatch!`);
      logError(`  Expected: ${genesisState}`);
      logError(`  Got:      ${initialState}`);
      process.exit(1);
    }
    logSuccess("Genesis state matches");

    // Step 3: Replay each event and verify state
    console.log("\n--- Replaying Events ---\n");

    let passCount = 0;
    let failCount = 0;

    for (let i = 0; i < events.length; i++) {
      const event = events[i];
      const eventNum = i + 1;

      // Check current state matches expected prevState
      const currentState = await getFullnodeStateRoot(fullnodeRpc);
      if (currentState.toLowerCase() !== event.prevStateHash.toLowerCase()) {
        logError(`Event ${eventNum}: Pre-state mismatch!`);
        logError(`  Expected: ${event.prevStateHash.slice(0, 18)}...`);
        logError(`  Got:      ${currentState.slice(0, 18)}...`);
        failCount++;
        continue;
      }

      // Execute the event
      let result: { success: boolean; newStateRoot: string; error?: string };

      if (event.type === "L2BlockProcessed") {
        log(`Replaying event ${eventNum}: L2 Block #${event.blockNumber} (${event.decodedCall})`);
        result = await executeL2Transaction(fullnodeRpc, event.rlpEncodedTx!);
      } else {
        log(`Replaying event ${eventNum}: L1->L2 Call (${event.decodedCall})`);
        result = await executeL1ToL2Call(fullnodeRpc, {
          l1Caller: event.l1Caller!,
          l2Target: event.l2Address!,
          callData: event.callData || "0x",
          value: (event.value || 0n).toString(),
        });
      }

      if (result.error) {
        logError(`Event ${eventNum}: Execution error: ${result.error}`);
        failCount++;
        continue;
      }

      // Verify resulting state
      const newState = await getFullnodeStateRoot(fullnodeRpc);
      if (newState.toLowerCase() === event.newStateHash.toLowerCase()) {
        logSuccess(`Event ${eventNum}: State root matches (${newState.slice(0, 18)}...)`);
        passCount++;
      } else {
        logError(`Event ${eventNum}: State root mismatch!`);
        logError(`  Expected: ${event.newStateHash.slice(0, 18)}...`);
        logError(`  Got:      ${newState.slice(0, 18)}...`);
        failCount++;
      }
    }

    // Final summary
    console.log("\n========================================");
    console.log("  Test Results");
    console.log("========================================\n");

    console.log(`Total events: ${events.length}`);
    console.log(`${COLORS.green}Passed: ${passCount}${COLORS.reset}`);
    console.log(`${COLORS.red}Failed: ${failCount}${COLORS.reset}`);

    if (failCount === 0) {
      console.log(`\n${COLORS.green}All tests passed! Fullnode correctly syncs from L1 events.${COLORS.reset}\n`);
    } else {
      console.log(`\n${COLORS.red}Some tests failed.${COLORS.reset}\n`);
      process.exit(1);
    }

  } finally {
    // Cleanup
    if (fullnodeProcess) {
      fullnodeProcess.kill();
    }
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
