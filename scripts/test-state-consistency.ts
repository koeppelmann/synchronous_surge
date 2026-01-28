/**
 * State Consistency Test Script
 *
 * This script systematically tests that the fullnode's state matches the builder's
 * predictions by:
 * 1. Parsing all L1 events (L2BlockProcessed, IncomingCallHandled)
 * 2. For each event, capturing the state transition
 * 3. Verifying the fullnode produces the same state root
 *
 * CRITICAL INSIGHT: The divergence is caused by either:
 * - Builder registering wrong state roots
 * - Fullnode computing different state roots for the same operations
 * - Events being processed in wrong order
 *
 * Usage:
 *   npx tsx scripts/test-state-consistency.ts [--verbose]
 */

import {
  ethers,
  JsonRpcProvider,
  Contract,
} from "ethers";
import { spawn, ChildProcess } from "child_process";

// ============ Configuration ============

const L1_RPC = process.env.L1_RPC || "http://localhost:8545";
const L2_RPC = process.env.L2_RPC || "http://localhost:9546";
const ROLLUP_ADDRESS = process.env.ROLLUP_ADDRESS || "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512";

const VERBOSE = process.argv.includes("--verbose");

// ============ ABI ============

const ROLLUP_ABI = [
  "event L2BlockProcessed(uint256 indexed blockNumber, bytes32 indexed prevBlockHash, bytes32 indexed newBlockHash, bytes rlpEncodedTx, tuple(address from, address target, uint256 value, uint256 gas, bytes data, bytes32 postCallStateHash)[] outgoingCalls, bytes[] outgoingCallResults)",
  "event IncomingCallHandled(address indexed l2Address, address indexed l1Caller, bytes32 indexed prevBlockHash, bytes callData, uint256 value, tuple(address from, address target, uint256 value, uint256 gas, bytes data, bytes32 postCallStateHash)[] outgoingCalls, bytes[] outgoingCallResults, bytes32 finalStateHash)",
  "event IncomingCallRegistered(address indexed l2Address, bytes32 indexed stateHash, bytes32 indexed callDataHash, bytes32 responseKey)",
  "function l2BlockHash() view returns (bytes32)",
  "function l2BlockNumber() view returns (uint256)",
];

// ============ L2 System ============

const L2_SYSTEM_ADDRESS = "0x1000000000000000000000000000000000000001";
const L2_SYSTEM_BALANCE = ethers.parseEther("10000000000");

// ============ Logging ============

function log(component: string, message: string) {
  const timestamp = new Date().toISOString().split("T")[1].split(".")[0];
  console.log(`[${timestamp}] [${component}] ${message}`);
}

function debug(component: string, message: string) {
  if (VERBOSE) {
    log(component, message);
  }
}

// ============ Utility ============

async function getStateRoot(provider: JsonRpcProvider): Promise<string> {
  const block = await provider.send("eth_getBlockByNumber", ["latest", false]);
  return block?.stateRoot || "0x0";
}

function computeL1SenderProxyL2Address(l1Address: string): string {
  const hash = ethers.keccak256(ethers.solidityPacked(
    ["string", "address"],
    ["L1SenderProxyL2.v1", l1Address]
  ));
  return "0x" + hash.slice(-40);
}

// ============ Event Types ============

interface StateTransition {
  eventType: "L2BlockProcessed" | "IncomingCallHandled";
  l1Block: number;
  l1TxHash: string;
  logIndex: number;
  prevStateHash: string;
  newStateHash: string;
  eventData: any;
}

// ============ Event Parser ============

async function getAllStateTransitions(
  l1Provider: JsonRpcProvider,
  rollupContract: Contract
): Promise<StateTransition[]> {
  const transitions: StateTransition[] = [];

  log("Parser", "Fetching L2BlockProcessed events...");
  const blockFilter = rollupContract.filters.L2BlockProcessed();
  const blockEvents = await rollupContract.queryFilter(blockFilter, 0, "latest");
  log("Parser", `  Found ${blockEvents.length} L2BlockProcessed events`);

  log("Parser", "Fetching IncomingCallHandled events...");
  const incomingFilter = rollupContract.filters.IncomingCallHandled();
  const incomingEvents = await rollupContract.queryFilter(incomingFilter, 0, "latest");
  log("Parser", `  Found ${incomingEvents.length} IncomingCallHandled events`);

  // Parse L2BlockProcessed events
  for (const event of blockEvents) {
    const blockNumber = Number(event.args?.[0] || event.args?.blockNumber);
    const prevBlockHash = event.args?.[1] || event.args?.prevBlockHash;
    const newBlockHash = event.args?.[2] || event.args?.newBlockHash;
    const rlpEncodedTx = event.args?.[3] || event.args?.rlpEncodedTx;
    const outgoingCalls = event.args?.[4] || event.args?.outgoingCalls || [];
    const outgoingCallResults = event.args?.[5] || event.args?.outgoingCallResults || [];

    transitions.push({
      eventType: "L2BlockProcessed",
      l1Block: event.blockNumber,
      l1TxHash: event.transactionHash,
      logIndex: event.index,
      prevStateHash: prevBlockHash,
      newStateHash: newBlockHash,
      eventData: {
        l2BlockNumber: blockNumber,
        rlpEncodedTx,
        outgoingCalls,
        outgoingCallResults,
      },
    });
  }

  // Parse IncomingCallHandled events
  for (const event of incomingEvents) {
    const l2Address = event.args?.[0] || event.args?.l2Address;
    const l1Caller = event.args?.[1] || event.args?.l1Caller;
    const prevBlockHash = event.args?.[2] || event.args?.prevBlockHash;
    const callData = event.args?.[3] || event.args?.callData || "0x";
    const value = event.args?.[4] || event.args?.value || 0n;
    const outgoingCalls = event.args?.[5] || event.args?.outgoingCalls || [];
    const outgoingCallResults = event.args?.[6] || event.args?.outgoingCallResults || [];
    const finalStateHash = event.args?.[7] || event.args?.finalStateHash;

    transitions.push({
      eventType: "IncomingCallHandled",
      l1Block: event.blockNumber,
      l1TxHash: event.transactionHash,
      logIndex: event.index,
      prevStateHash: prevBlockHash,
      newStateHash: finalStateHash,
      eventData: {
        l2Address,
        l1Caller,
        callData,
        value,
        outgoingCalls,
        outgoingCallResults,
      },
    });
  }

  // Sort by L1 block number and log index to ensure correct order
  transitions.sort((a, b) => {
    if (a.l1Block !== b.l1Block) {
      return a.l1Block - b.l1Block;
    }
    return a.logIndex - b.logIndex;
  });

  log("Parser", `Total ${transitions.length} state transitions in chronological order`);
  return transitions;
}

// ============ Fresh L2 Anvil ============

interface FreshL2 {
  provider: JsonRpcProvider;
  process: ChildProcess;
  port: number;
}

async function spawnFreshL2Anvil(port: number = 19999): Promise<FreshL2> {
  log("L2", `Spawning fresh L2 Anvil on port ${port}...`);

  const anvilProcess = spawn(
    "anvil",
    [
      "--port", port.toString(),
      "--chain-id", "10200200",
      "--accounts", "0",
      "--gas-price", "0",
      "--base-fee", "0",
      "--silent",
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
    }
  );

  // Wait for Anvil to be ready
  const provider = await new Promise<JsonRpcProvider>((resolve, reject) => {
    const timeout = setTimeout(() => {
      anvilProcess.kill();
      reject(new Error("Fresh L2 Anvil failed to start within 10 seconds"));
    }, 10000);

    const checkReady = async () => {
      try {
        const testProvider = new JsonRpcProvider(`http://localhost:${port}`);
        const block = await testProvider.send("eth_getBlockByNumber", ["latest", false]);
        if (block?.stateRoot) {
          clearTimeout(timeout);
          resolve(testProvider);
        } else {
          setTimeout(checkReady, 100);
        }
      } catch {
        setTimeout(checkReady, 100);
      }
    };

    anvilProcess.on("error", (err) => {
      clearTimeout(timeout);
      reject(new Error(`Failed to spawn fresh L2 Anvil: ${err.message}`));
    });

    checkReady();
  });

  // Set up deterministic genesis state
  log("L2", "Setting up genesis state...");
  await provider.send("anvil_setBalance", [
    L2_SYSTEM_ADDRESS,
    "0x" + L2_SYSTEM_BALANCE.toString(16),
  ]);

  // Mine a block to commit the genesis state
  await provider.send("evm_mine", []);

  const genesisRoot = await getStateRoot(provider);
  log("L2", `  Genesis state root: ${genesisRoot}`);

  return { provider, process: anvilProcess, port };
}

function stopFreshL2(l2: FreshL2) {
  l2.process.kill();
}

// ============ Event Replay ============

/**
 * Replay a single state transition on the fresh L2
 */
async function replayTransition(
  l2: FreshL2,
  transition: StateTransition,
  expectedPrevState: string
): Promise<{ success: boolean; actualNewState: string; error?: string }> {
  const { provider } = l2;

  // Check current state matches expected prev state
  const currentState = await getStateRoot(provider);
  if (currentState.toLowerCase() !== expectedPrevState.toLowerCase()) {
    return {
      success: false,
      actualNewState: currentState,
      error: `State mismatch before replay: expected ${expectedPrevState.slice(0, 18)}..., got ${currentState.slice(0, 18)}...`,
    };
  }

  try {
    if (transition.eventType === "L2BlockProcessed") {
      await replayL2BlockProcessed(provider, transition);
    } else if (transition.eventType === "IncomingCallHandled") {
      await replayIncomingCallHandled(provider, transition);
    }

    const newState = await getStateRoot(provider);
    const matches = newState.toLowerCase() === transition.newStateHash.toLowerCase();

    return {
      success: matches,
      actualNewState: newState,
      error: matches ? undefined : `State mismatch: expected ${transition.newStateHash.slice(0, 18)}..., got ${newState.slice(0, 18)}...`,
    };
  } catch (err: any) {
    return {
      success: false,
      actualNewState: await getStateRoot(provider),
      error: err.message,
    };
  }
}

/**
 * Replay L2BlockProcessed event
 */
async function replayL2BlockProcessed(
  provider: JsonRpcProvider,
  transition: StateTransition
): Promise<void> {
  const { rlpEncodedTx } = transition.eventData;

  if (!rlpEncodedTx || rlpEncodedTx === "0x") {
    debug("Replay", "  No transaction to execute");
    return;
  }

  // Try to send the raw transaction
  try {
    const txHash = await provider.send("eth_sendRawTransaction", [rlpEncodedTx]);
    await provider.waitForTransaction(txHash);
    debug("Replay", `  Executed L2 tx: ${txHash}`);
  } catch (err: any) {
    // If nonce is wrong, we need to handle differently
    if (err.message.includes("nonce")) {
      debug("Replay", `  Nonce issue: ${err.message}`);
      // For testing, we'll accept this as the state already diverged
    } else {
      throw err;
    }
  }
}

/**
 * Replay IncomingCallHandled event
 */
async function replayIncomingCallHandled(
  provider: JsonRpcProvider,
  transition: StateTransition
): Promise<void> {
  const { l2Address, l1Caller, callData, value } = transition.eventData;

  // Credit ETH if value > 0
  if (value > 0n) {
    const currentBalance = await provider.getBalance(l2Address);
    const newBalance = currentBalance + value;
    await provider.send("anvil_setBalance", [
      l2Address,
      "0x" + newBalance.toString(16),
    ]);
    debug("Replay", `  Credited ${ethers.formatEther(value)} ETH to ${l2Address}`);
  }

  // Execute contract call if there's calldata
  if (callData && callData !== "0x") {
    const l1ProxyOnL2 = computeL1SenderProxyL2Address(l1Caller);
    debug("Replay", `  Executing call from ${l1ProxyOnL2} to ${l2Address}`);

    // Impersonate the L1's proxy on L2
    await provider.send("anvil_impersonateAccount", [l1ProxyOnL2]);
    await provider.send("anvil_setBalance", [
      l1ProxyOnL2,
      "0x" + ethers.parseEther("1").toString(16),
    ]);

    try {
      const txHash = await provider.send("eth_sendTransaction", [{
        from: l1ProxyOnL2,
        to: l2Address,
        data: callData,
        value: value > 0n ? "0x" + value.toString(16) : "0x0",
        gas: "0x1000000",
      }]);

      const receipt = await provider.waitForTransaction(txHash);
      debug("Replay", `  Call executed: ${receipt?.status === 1 ? "SUCCESS" : "REVERTED"}`);
    } finally {
      await provider.send("anvil_stopImpersonatingAccount", [l1ProxyOnL2]);
    }
  }

  // Mine a block to commit state
  await provider.send("evm_mine", []);
}

// ============ State Chain Verification ============

interface VerificationResult {
  totalTransitions: number;
  successfulTransitions: number;
  failedTransitions: number;
  firstFailure?: {
    index: number;
    transition: StateTransition;
    error: string;
    actualState: string;
  };
  stateChain: {
    index: number;
    eventType: string;
    prevState: string;
    expectedNewState: string;
    actualNewState: string;
    match: boolean;
  }[];
}

async function verifyStateChain(
  l1Provider: JsonRpcProvider,
  rollupContract: Contract
): Promise<VerificationResult> {
  log("Verify", "=== State Chain Verification ===");
  log("Verify", "");

  // Get all transitions
  const transitions = await getAllStateTransitions(l1Provider, rollupContract);

  if (transitions.length === 0) {
    log("Verify", "No state transitions found!");
    return {
      totalTransitions: 0,
      successfulTransitions: 0,
      failedTransitions: 0,
      stateChain: [],
    };
  }

  // Get the expected genesis state (prevStateHash of first transition)
  const expectedGenesisState = transitions[0].prevStateHash;
  log("Verify", `Expected genesis state: ${expectedGenesisState}`);

  // Spawn fresh L2 Anvil
  const freshL2 = await spawnFreshL2Anvil();
  const actualGenesisState = await getStateRoot(freshL2.provider);

  log("Verify", `Actual genesis state:   ${actualGenesisState}`);

  if (actualGenesisState.toLowerCase() !== expectedGenesisState.toLowerCase()) {
    log("Verify", "");
    log("Verify", "ERROR: Genesis state mismatch!");
    log("Verify", "  This means the fullnode's genesis doesn't match what was stored in the L1 contract.");
    log("Verify", "  This is a fundamental setup issue.");
    stopFreshL2(freshL2);

    return {
      totalTransitions: transitions.length,
      successfulTransitions: 0,
      failedTransitions: transitions.length,
      firstFailure: {
        index: 0,
        transition: transitions[0],
        error: "Genesis state mismatch",
        actualState: actualGenesisState,
      },
      stateChain: [],
    };
  }

  log("Verify", "");
  log("Verify", `Replaying ${transitions.length} transitions...`);
  log("Verify", "");

  const result: VerificationResult = {
    totalTransitions: transitions.length,
    successfulTransitions: 0,
    failedTransitions: 0,
    stateChain: [],
  };

  let currentExpectedState = expectedGenesisState;

  for (let i = 0; i < transitions.length; i++) {
    const t = transitions[i];

    log("Verify", `[${i + 1}/${transitions.length}] ${t.eventType}`);
    log("Verify", `    L1 block: ${t.l1Block}, tx: ${t.l1TxHash.slice(0, 10)}...`);
    log("Verify", `    Prev:     ${t.prevStateHash.slice(0, 18)}...`);
    log("Verify", `    Expected: ${t.newStateHash.slice(0, 18)}...`);

    // Verify the chain is consistent (each transition's prevState matches previous newState)
    if (t.prevStateHash.toLowerCase() !== currentExpectedState.toLowerCase()) {
      log("Verify", `    ERROR: Chain broken! Expected prev ${currentExpectedState.slice(0, 18)}...`);
      result.failedTransitions++;
      result.stateChain.push({
        index: i,
        eventType: t.eventType,
        prevState: t.prevStateHash,
        expectedNewState: t.newStateHash,
        actualNewState: "N/A - chain broken",
        match: false,
      });

      if (!result.firstFailure) {
        result.firstFailure = {
          index: i,
          transition: t,
          error: `Chain broken: expected prev ${currentExpectedState.slice(0, 18)}... but got ${t.prevStateHash.slice(0, 18)}...`,
          actualState: currentExpectedState,
        };
      }

      currentExpectedState = t.newStateHash;
      continue;
    }

    // Replay the transition
    const replayResult = await replayTransition(freshL2, t, currentExpectedState);

    log("Verify", `    Actual:   ${replayResult.actualNewState.slice(0, 18)}...`);
    log("Verify", `    Result:   ${replayResult.success ? "MATCH ✓" : "MISMATCH ✗"}`);

    result.stateChain.push({
      index: i,
      eventType: t.eventType,
      prevState: t.prevStateHash,
      expectedNewState: t.newStateHash,
      actualNewState: replayResult.actualNewState,
      match: replayResult.success,
    });

    if (replayResult.success) {
      result.successfulTransitions++;
    } else {
      result.failedTransitions++;
      if (!result.firstFailure) {
        result.firstFailure = {
          index: i,
          transition: t,
          error: replayResult.error || "Unknown error",
          actualState: replayResult.actualNewState,
        };
      }
    }

    // Update expected state for next iteration
    currentExpectedState = t.newStateHash;
    log("Verify", "");
  }

  stopFreshL2(freshL2);

  return result;
}

// ============ Compare Builder vs Fullnode ============

async function compareBuilderVsFullnode(): Promise<void> {
  log("Compare", "=== Comparing Builder Predictions vs Fullnode State ===");
  log("Compare", "");

  const l1Provider = new JsonRpcProvider(L1_RPC);
  const l2Provider = new JsonRpcProvider(L2_RPC);
  const rollupContract = new Contract(ROLLUP_ADDRESS, ROLLUP_ABI, l1Provider);

  // Get current state from L1 contract (builder's prediction)
  const l1ExpectedState = await rollupContract.l2BlockHash();
  log("Compare", `L1 Contract l2BlockHash: ${l1ExpectedState}`);

  // Get current state from fullnode
  const fullnodeState = await getStateRoot(l2Provider);
  log("Compare", `Fullnode state root:     ${fullnodeState}`);

  log("Compare", "");
  if (l1ExpectedState.toLowerCase() === fullnodeState.toLowerCase()) {
    log("Compare", "✓ States MATCH - Builder and fullnode are in sync!");
  } else {
    log("Compare", "✗ States MISMATCH - Divergence detected!");
    log("Compare", "");
    log("Compare", "Running state chain verification to find divergence point...");
    log("Compare", "");

    const result = await verifyStateChain(l1Provider, rollupContract);

    log("Report", "");
    log("Report", "=== Verification Report ===");
    log("Report", `Total transitions:      ${result.totalTransitions}`);
    log("Report", `Successful transitions: ${result.successfulTransitions}`);
    log("Report", `Failed transitions:     ${result.failedTransitions}`);

    if (result.firstFailure) {
      log("Report", "");
      log("Report", "First failure:");
      log("Report", `  Index: ${result.firstFailure.index}`);
      log("Report", `  Type:  ${result.firstFailure.transition.eventType}`);
      log("Report", `  Error: ${result.firstFailure.error}`);
      log("Report", `  L1 Tx: ${result.firstFailure.transition.l1TxHash}`);

      if (result.firstFailure.transition.eventType === "IncomingCallHandled") {
        const data = result.firstFailure.transition.eventData;
        log("Report", "");
        log("Report", "  Event details:");
        log("Report", `    L2 Address: ${data.l2Address}`);
        log("Report", `    L1 Caller:  ${data.l1Caller}`);
        log("Report", `    Call Data:  ${data.callData?.slice(0, 20)}...`);
        log("Report", `    Value:      ${ethers.formatEther(data.value || 0n)} ETH`);
      }
    }

    log("Report", "");
    log("Report", "State chain:");
    for (const entry of result.stateChain) {
      log("Report", `  [${entry.index}] ${entry.eventType}: ${entry.match ? "✓" : "✗"}`);
      if (!entry.match) {
        log("Report", `       Expected: ${entry.expectedNewState.slice(0, 18)}...`);
        log("Report", `       Actual:   ${entry.actualNewState.slice(0, 18)}...`);
      }
    }
  }
}

// ============ Main ============

async function main() {
  log("Main", "State Consistency Test");
  log("Main", "");
  log("Main", `L1 RPC: ${L1_RPC}`);
  log("Main", `L2 RPC: ${L2_RPC}`);
  log("Main", `Rollup: ${ROLLUP_ADDRESS}`);
  log("Main", "");

  await compareBuilderVsFullnode();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
