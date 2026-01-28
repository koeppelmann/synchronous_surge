/**
 * Fullnode Determinism Test
 *
 * This test verifies that the fullnode produces deterministic state roots.
 * It does this by:
 * 1. Starting two independent fullnodes (on different ports)
 * 2. Verifying they have identical genesis state
 * 3. Replaying the same sequence of L1 events on both
 * 4. Verifying state roots match after each event
 *
 * This is a CRITICAL test - if it fails, the fullnode is not deterministic
 * and cannot be used for a native rollup.
 *
 * Usage:
 *   npx tsx scripts/test-determinism.ts [--l1-rpc <url>] [--rollup <address>]
 */

import { ethers, JsonRpcProvider, Contract, Transaction } from "ethers";
import { spawn, ChildProcess } from "child_process";
import * as path from "path";
import { DETERMINISM_CONSTANTS } from "../fullnode/fullnode-rpc-interface.js";

// ============ Configuration ============

interface TestConfig {
  l1Rpc: string;
  rollupAddress: string;
  fullnode1: { l2Port: number; rpcPort: number };
  fullnode2: { l2Port: number; rpcPort: number };
}

const DEFAULT_CONFIG: TestConfig = {
  l1Rpc: process.env.L1_RPC || "http://localhost:8545",
  rollupAddress: process.env.ROLLUP_ADDRESS || "",
  fullnode1: { l2Port: 19546, rpcPort: 19547 },
  fullnode2: { l2Port: 19646, rpcPort: 19647 },
};

// ============ ABIs ============

const ROLLUP_ABI = [
  "event L2BlockProcessed(uint256 indexed blockNumber, bytes32 indexed prevBlockHash, bytes32 indexed newBlockHash, bytes rlpEncodedTx, tuple(address from, address target, uint256 value, uint256 gas, bytes data, bytes32 postCallStateHash)[] outgoingCalls, bytes[] outgoingCallResults)",
  "event IncomingCallHandled(address indexed l2Address, address indexed l1Caller, bytes32 indexed prevBlockHash, bytes callData, uint256 value, tuple(address from, address target, uint256 value, uint256 gas, bytes data, bytes32 postCallStateHash)[] outgoingCalls, bytes[] outgoingCallResults, bytes32 finalStateHash)",
  "function l2BlockHash() view returns (bytes32)",
];

// ============ Types ============

interface L2Event {
  type: "L2BlockProcessed" | "IncomingCallHandled";
  l1Block: number;
  prevStateHash: string;
  newStateHash: string;
  rlpEncodedTx?: string;
  l2Address?: string;
  l1Caller?: string;
  callData?: string;
  value?: bigint;
}

interface FullnodeInstance {
  process: ChildProcess;
  rpcUrl: string;
  name: string;
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

// ============ Event Extraction ============

async function extractEvents(l1Provider: JsonRpcProvider, rollupAddress: string): Promise<L2Event[]> {
  log("Extracting L2 events from L1...");

  const rollup = new Contract(rollupAddress, ROLLUP_ABI, l1Provider);

  const [l2BlockEvents, incomingCallEvents] = await Promise.all([
    rollup.queryFilter(rollup.filters.L2BlockProcessed(), 0, "latest"),
    rollup.queryFilter(rollup.filters.IncomingCallHandled(), 0, "latest"),
  ]);

  const events: L2Event[] = [];

  for (const event of l2BlockEvents) {
    const eventLog = event as ethers.EventLog;
    events.push({
      type: "L2BlockProcessed",
      l1Block: event.blockNumber,
      prevStateHash: eventLog.args.prevBlockHash,
      newStateHash: eventLog.args.newBlockHash,
      rlpEncodedTx: eventLog.args.rlpEncodedTx,
    });
  }

  for (const event of incomingCallEvents) {
    const eventLog = event as ethers.EventLog;
    events.push({
      type: "IncomingCallHandled",
      l1Block: event.blockNumber,
      prevStateHash: eventLog.args.prevBlockHash,
      newStateHash: eventLog.args.finalStateHash,
      l2Address: eventLog.args.l2Address,
      l1Caller: eventLog.args.l1Caller,
      callData: eventLog.args.callData,
      value: eventLog.args.value,
    });
  }

  // Sort by L1 block
  events.sort((a, b) => a.l1Block - b.l1Block);

  log(`Found ${events.length} events`);
  return events;
}

// ============ Fullnode Management ============

async function startFullnode(
  name: string,
  l2Port: number,
  rpcPort: number,
  rollupAddress: string
): Promise<FullnodeInstance> {
  const rpcUrl = `http://localhost:${rpcPort}`;

  log(`Starting ${name} on ports ${l2Port}/${rpcPort}...`);

  // Kill any existing processes on these ports
  try {
    const { execSync } = await import("child_process");
    execSync(`lsof -ti:${l2Port} | xargs kill -9 2>/dev/null || true`, { stdio: "ignore" });
    execSync(`lsof -ti:${rpcPort} | xargs kill -9 2>/dev/null || true`, { stdio: "ignore" });
    await new Promise(r => setTimeout(r, 500));
  } catch {}

  const scriptPath = path.join(process.cwd(), "fullnode", "l2-fullnode.ts");

  const proc = spawn("npx", [
    "tsx",
    scriptPath,
    "--l1-rpc", "http://localhost:8545",
    "--rollup", rollupAddress,
    "--l2-port", l2Port.toString(),
    "--rpc-port", rpcPort.toString(),
  ], {
    stdio: ["ignore", "pipe", "pipe"],
    cwd: process.cwd(),
    env: {
      ...process.env,
      DISABLE_L1_WATCH: "true",
    },
  });

  // Wait for ready
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`${name} start timeout`)), 30000);

    const check = async () => {
      try {
        const response = await fetch(rpcUrl, {
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

    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    setTimeout(check, 500);
  });

  log(`${name} started`);

  return { process: proc, rpcUrl, name };
}

async function getStateRoot(rpcUrl: string): Promise<string> {
  const response = await fetch(rpcUrl, {
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

async function executeL2Transaction(rpcUrl: string, rlpEncodedTx: string): Promise<string> {
  const response = await fetch(rpcUrl, {
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
    throw new Error(json.error.message);
  }
  return json.result.newStateRoot;
}

async function executeL1ToL2Call(rpcUrl: string, params: {
  l1Caller: string;
  l2Target: string;
  callData: string;
  value: string;
}): Promise<string> {
  const response = await fetch(rpcUrl, {
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
    throw new Error(json.error.message);
  }
  return json.result.newStateRoot;
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
    }
  }

  if (!config.rollupAddress) {
    console.error("Error: --rollup <address> required");
    process.exit(1);
  }

  console.log("\n==========================================================");
  console.log("           Fullnode Determinism Test");
  console.log("==========================================================\n");

  // Print determinism constants
  logInfo("Determinism Constants:");
  logInfo(`  System Address: ${DETERMINISM_CONSTANTS.SYSTEM_ADDRESS}`);
  logInfo(`  L2 Chain ID: ${DETERMINISM_CONSTANTS.L2_CHAIN_ID}`);
  logInfo(`  L2CallRegistry Nonce: ${DETERMINISM_CONSTANTS.L2_CALL_REGISTRY_NONCE}`);
  logInfo(`  L1SenderProxyL2Factory Nonce: ${DETERMINISM_CONSTANTS.L1_SENDER_PROXY_L2_FACTORY_NONCE}`);
  console.log();

  const l1Provider = new JsonRpcProvider(config.l1Rpc);

  // Extract events from L1
  const events = await extractEvents(l1Provider, config.rollupAddress);

  if (events.length === 0) {
    log("No events found. Testing genesis determinism only.");
  }

  // Start two independent fullnodes
  let fullnode1: FullnodeInstance | null = null;
  let fullnode2: FullnodeInstance | null = null;

  try {
    fullnode1 = await startFullnode(
      "Fullnode-A",
      config.fullnode1.l2Port,
      config.fullnode1.rpcPort,
      config.rollupAddress
    );

    fullnode2 = await startFullnode(
      "Fullnode-B",
      config.fullnode2.l2Port,
      config.fullnode2.rpcPort,
      config.rollupAddress
    );

    // Test 1: Verify genesis state is identical
    console.log("\n--- Test 1: Genesis State Determinism ---\n");

    const genesis1 = await getStateRoot(fullnode1.rpcUrl);
    const genesis2 = await getStateRoot(fullnode2.rpcUrl);

    logInfo(`Fullnode-A genesis: ${genesis1}`);
    logInfo(`Fullnode-B genesis: ${genesis2}`);

    if (genesis1.toLowerCase() === genesis2.toLowerCase()) {
      logSuccess("Genesis state is DETERMINISTIC - both fullnodes have identical genesis");
    } else {
      logError("Genesis state is NOT deterministic!");
      logError("  This means system contract deployment is not deterministic.");
      logError("  Check nonces, constructor args, and bytecode.");
      process.exit(1);
    }

    // Test 2: Replay events and verify state after each
    if (events.length > 0) {
      console.log("\n--- Test 2: Event Replay Determinism ---\n");

      let passCount = 0;
      let failCount = 0;

      for (let i = 0; i < events.length; i++) {
        const event = events[i];
        const eventNum = i + 1;

        // Get current state from both fullnodes
        const stateBefore1 = await getStateRoot(fullnode1.rpcUrl);
        const stateBefore2 = await getStateRoot(fullnode2.rpcUrl);

        // Verify pre-state matches
        if (stateBefore1.toLowerCase() !== stateBefore2.toLowerCase()) {
          logError(`Event ${eventNum}: Pre-state mismatch before replay!`);
          logError(`  Fullnode-A: ${stateBefore1.slice(0, 18)}...`);
          logError(`  Fullnode-B: ${stateBefore2.slice(0, 18)}...`);
          failCount++;
          continue;
        }

        // Execute event on both fullnodes
        let stateAfter1: string;
        let stateAfter2: string;

        try {
          if (event.type === "L2BlockProcessed") {
            log(`Event ${eventNum}: L2BlockProcessed (L1 #${event.l1Block})`);
            stateAfter1 = await executeL2Transaction(fullnode1.rpcUrl, event.rlpEncodedTx!);
            stateAfter2 = await executeL2Transaction(fullnode2.rpcUrl, event.rlpEncodedTx!);
          } else {
            log(`Event ${eventNum}: IncomingCallHandled (L1 #${event.l1Block})`);
            const params = {
              l1Caller: event.l1Caller!,
              l2Target: event.l2Address!,
              callData: event.callData || "0x",
              value: (event.value || 0n).toString(),
            };
            stateAfter1 = await executeL1ToL2Call(fullnode1.rpcUrl, params);
            stateAfter2 = await executeL1ToL2Call(fullnode2.rpcUrl, params);
          }
        } catch (err: any) {
          logError(`Event ${eventNum}: Execution error: ${err.message}`);
          failCount++;
          continue;
        }

        // Verify post-state matches between fullnodes
        if (stateAfter1.toLowerCase() === stateAfter2.toLowerCase()) {
          // Also verify it matches expected from L1
          if (stateAfter1.toLowerCase() === event.newStateHash.toLowerCase()) {
            logSuccess(`Event ${eventNum}: Deterministic + matches L1 (${stateAfter1.slice(0, 18)}...)`);
          } else {
            logError(`Event ${eventNum}: Deterministic but DOESN'T match L1!`);
            logError(`  Fullnodes: ${stateAfter1.slice(0, 18)}...`);
            logError(`  Expected:  ${event.newStateHash.slice(0, 18)}...`);
            failCount++;
            continue;
          }
          passCount++;
        } else {
          logError(`Event ${eventNum}: NOT deterministic!`);
          logError(`  Fullnode-A: ${stateAfter1.slice(0, 18)}...`);
          logError(`  Fullnode-B: ${stateAfter2.slice(0, 18)}...`);
          failCount++;
        }
      }

      // Summary
      console.log("\n==========================================================");
      console.log("                    Test Results");
      console.log("==========================================================\n");

      console.log(`Genesis Determinism: ${COLORS.green}PASS${COLORS.reset}`);
      console.log(`Event Replay: ${events.length} events`);
      console.log(`  ${COLORS.green}Passed: ${passCount}${COLORS.reset}`);
      console.log(`  ${COLORS.red}Failed: ${failCount}${COLORS.reset}`);

      if (failCount === 0) {
        console.log(`\n${COLORS.green}SUCCESS: Fullnode is DETERMINISTIC!${COLORS.reset}`);
        console.log(`Two independent fullnodes produce identical state roots.\n`);
      } else {
        console.log(`\n${COLORS.red}FAILURE: Fullnode is NOT deterministic!${COLORS.reset}`);
        console.log(`State roots differ between fullnode instances.\n`);
        process.exit(1);
      }
    } else {
      console.log(`\n${COLORS.green}Genesis determinism verified. No events to replay.${COLORS.reset}\n`);
    }

  } finally {
    // Cleanup
    if (fullnode1?.process) {
      fullnode1.process.kill();
    }
    if (fullnode2?.process) {
      fullnode2.process.kill();
    }

    // Kill any lingering anvil processes on test ports
    try {
      const { execSync } = await import("child_process");
      execSync(`lsof -ti:${config.fullnode1.l2Port} | xargs kill -9 2>/dev/null || true`, { stdio: "ignore" });
      execSync(`lsof -ti:${config.fullnode1.rpcPort} | xargs kill -9 2>/dev/null || true`, { stdio: "ignore" });
      execSync(`lsof -ti:${config.fullnode2.l2Port} | xargs kill -9 2>/dev/null || true`, { stdio: "ignore" });
      execSync(`lsof -ti:${config.fullnode2.rpcPort} | xargs kill -9 2>/dev/null || true`, { stdio: "ignore" });
    } catch {}
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
