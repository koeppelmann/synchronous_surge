/**
 * Standalone Test: L2 Value Transfer State Consistency
 *
 * Self-bootstrapping test that:
 * 1. Starts its own L1 Anvil
 * 2. Deploys NativeRollupCore + AdminProofVerifier
 * 3. Starts two fullnodes (read-only + builder)
 * 4. Starts the builder
 * 5. Runs value transfer tests
 * 6. Cleans everything up
 *
 * Usage:
 *   npx tsx scripts/test-value-transfer.ts
 */

import { ethers, JsonRpcProvider, Wallet, Contract, Transaction } from "ethers";
import { spawn, ChildProcess, execSync } from "child_process";
import * as path from "path";

// ============ Port Assignment (high ports to avoid conflicts) ============

const PORTS = {
  l1: 18545,
  readonlyL2Evm: 18546,
  readonlyFullnode: 18547,
  builderL2Evm: 18549,
  builderFullnode: 18550,
  builder: 18200,
};

// ============ Keys ============

const ADMIN_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const ADMIN_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const USER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const USER_ADDRESS = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const L2_RECIPIENT = "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65";

const ROLLUP_ABI = [
  "function l2BlockHash() view returns (bytes32)",
  "function l2BlockNumber() view returns (uint256)",
  "function getProxyAddress(address l2Address) view returns (address)",
  "function isProxyDeployed(address l2Address) view returns (bool)",
  "function deployProxy(address l2Address) returns (address)",
  "function getResponseKey(address l2Address, bytes32 stateHash, bytes calldata callData) view returns (bytes32)",
  "function incomingCallRegistered(bytes32 responseKey) view returns (bool)",
  "function incomingCallResponses(bytes32 responseKey) view returns (bytes32 preOutgoingCallsStateHash, bytes returnValue, bytes32 finalStateHash)",
  "event IncomingCallHandled(address indexed l2Address, address indexed l1Caller, bytes32 indexed prevBlockHash, bytes callData, uint256 value, tuple(address from, address target, uint256 value, uint256 gas, bytes data, bytes32 postCallStateHash)[] outgoingCalls, bytes[] outgoingCallResults, bytes32 finalStateHash)",
];

// ============ Process Management ============

const processes: ChildProcess[] = [];

function killAll() {
  for (const p of processes) {
    try { p.kill("SIGKILL"); } catch {}
  }
  processes.length = 0;
}

process.on("exit", killAll);
process.on("SIGINT", () => { killAll(); process.exit(1); });
process.on("SIGTERM", () => { killAll(); process.exit(1); });

// ============ Utilities ============

function log(component: string, message: string) {
  const timestamp = new Date().toISOString().split("T")[1].split(".")[0];
  console.log(`[${timestamp}] [${component}] ${message}`);
}

function passed(name: string) { console.log(`  ✓ ${name}`); }
function failed(name: string, detail?: string) { console.log(`  ✗ ${name}${detail ? `: ${detail}` : ""}`); }

async function rpcCall(url: string, method: string, params: any[] = []): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`RPC error: ${json.error.message}`);
  return json.result;
}

async function waitForRpc(url: string, name: string, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await rpcCall(url, "eth_blockNumber");
      return;
    } catch {
      await new Promise(r => setTimeout(r, 200));
    }
  }
  throw new Error(`Timeout waiting for ${name} at ${url}`);
}

async function waitForCustomRpc(url: string, method: string, name: string, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await rpcCall(url, method);
      return;
    } catch {
      await new Promise(r => setTimeout(r, 200));
    }
  }
  throw new Error(`Timeout waiting for ${name} at ${url}`);
}

async function waitForHttp(url: string, name: string, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`Timeout waiting for ${name} at ${url}`);
}

async function getStateRoot(url: string): Promise<string> {
  return rpcCall(url, "nativerollup_getStateRoot");
}

// ============ Infrastructure Setup ============

const PROJECT_DIR = path.resolve(__dirname, "..");

async function startL1Anvil(): Promise<JsonRpcProvider> {
  log("Setup", "Starting L1 Anvil...");
  const p = spawn("anvil", [
    "--port", PORTS.l1.toString(),
    "--chain-id", "31337",
    "--silent",
  ], { stdio: ["ignore", "pipe", "pipe"], cwd: PROJECT_DIR });
  processes.push(p);

  const url = `http://localhost:${PORTS.l1}`;
  await waitForRpc(url, "L1 Anvil");
  log("Setup", `L1 Anvil ready on port ${PORTS.l1}`);
  return new JsonRpcProvider(url);
}

async function deployContracts(l1Provider: JsonRpcProvider, genesisHash: string): Promise<string> {
  log("Setup", "Deploying NativeRollupCore + AdminProofVerifier...");

  const output = execSync(
    `GENESIS_HASH=${genesisHash} ADMIN=${ADMIN_ADDRESS} forge script script/Deploy.s.sol:DeployScript ` +
    `--rpc-url http://localhost:${PORTS.l1} --private-key ${ADMIN_KEY} --broadcast 2>&1`,
    { cwd: PROJECT_DIR, encoding: "utf-8" }
  );

  const match = output.match(/NativeRollupCore:\s+(0x[a-fA-F0-9]{40})/);
  if (!match) {
    console.error(output);
    throw new Error("Failed to extract NativeRollupCore address from deploy output");
  }

  const rollupAddress = match[1];
  log("Setup", `NativeRollupCore deployed at: ${rollupAddress}`);
  return rollupAddress;
}

async function startFullnode(
  name: string,
  l2EvmPort: number,
  rpcPort: number,
  rollupAddress: string,
): Promise<void> {
  log("Setup", `Starting ${name} fullnode (L2 EVM: ${l2EvmPort}, RPC: ${rpcPort})...`);

  const p = spawn("npx", [
    "tsx", "fullnode/l2-fullnode.ts",
    "--l1-rpc", `http://localhost:${PORTS.l1}`,
    "--rollup", rollupAddress,
    "--l2-port", l2EvmPort.toString(),
    "--rpc-port", rpcPort.toString(),
  ], { stdio: ["ignore", "pipe", "pipe"], cwd: PROJECT_DIR });
  processes.push(p);

  // Capture stderr for debugging
  let stderr = "";
  p.stderr?.on("data", d => { stderr += d.toString(); });

  await waitForRpc(`http://localhost:${l2EvmPort}`, `${name} L2 EVM`, 20000);
  await waitForCustomRpc(`http://localhost:${rpcPort}`, "nativerollup_getStateRoot", `${name} RPC`, 20000);
  log("Setup", `${name} fullnode ready`);
}

async function startBuilder(rollupAddress: string): Promise<void> {
  log("Setup", "Starting Builder...");

  const p = spawn("npx", [
    "tsx", "scripts/builder.ts",
    "--l1-rpc", `http://localhost:${PORTS.l1}`,
    "--fullnode", `http://localhost:${PORTS.builderFullnode}`,
    "--rollup", rollupAddress,
    "--admin-key", ADMIN_KEY,
    "--port", PORTS.builder.toString(),
  ], { stdio: ["ignore", "pipe", "pipe"], cwd: PROJECT_DIR });
  processes.push(p);

  await waitForHttp(`http://localhost:${PORTS.builder}/status`, "Builder API", 15000);
  log("Setup", "Builder ready");
}

// ============ Full Bootstrap ============

async function bootstrap(): Promise<{ l1Provider: JsonRpcProvider; rollupAddress: string }> {
  log("Setup", "=== Bootstrapping Test Environment ===");

  // 1. Start L1
  const l1Provider = await startL1Anvil();

  // 2. Deploy contracts with placeholder genesis (will fix after fullnode starts)
  const zeroGenesis = "0x0000000000000000000000000000000000000000000000000000000000000000";
  const rollupAddress = await deployContracts(l1Provider, zeroGenesis);

  // 3. Start both fullnodes
  await startFullnode("Readonly", PORTS.readonlyL2Evm, PORTS.readonlyFullnode, rollupAddress);
  await startFullnode("Builder", PORTS.builderL2Evm, PORTS.builderFullnode, rollupAddress);

  // 4. Get fullnode genesis state and sync L1 contract
  const genesisState = await getStateRoot(`http://localhost:${PORTS.readonlyFullnode}`);
  log("Setup", `Fullnode genesis state: ${genesisState}`);

  // Update L1 contract's l2BlockHash (slot 0) to match fullnode genesis
  await l1Provider.send("anvil_setStorageAt", [rollupAddress, "0x0", genesisState]);

  // Verify
  const rollup = new Contract(rollupAddress, ROLLUP_ABI, l1Provider);
  const storedHash = await rollup.l2BlockHash();
  if (storedHash.toLowerCase() !== genesisState.toLowerCase()) {
    throw new Error(`Failed to sync genesis: stored=${storedHash}, expected=${genesisState}`);
  }
  log("Setup", "L1 contract synced to fullnode genesis");

  // 5. Start builder
  await startBuilder(rollupAddress);

  log("Setup", "=== Environment Ready ===");
  console.log("");
  return { l1Provider, rollupAddress };
}

// ============ Test 1: Direct fullnode call consistency ============

async function testDirectFullnodeConsistency(): Promise<boolean> {
  log("Test1", "=== Direct Fullnode Call Consistency ===");
  log("Test1", "Both fullnodes execute the same L1→L2 value transfer and compare state roots.");
  log("Test1", "");

  const readonlyUrl = `http://localhost:${PORTS.readonlyFullnode}`;
  const builderUrl = `http://localhost:${PORTS.builderFullnode}`;

  const builderState0 = await getStateRoot(builderUrl);
  const readonlyState0 = await getStateRoot(readonlyUrl);

  log("Test1", `Builder fullnode initial state:  ${builderState0}`);
  log("Test1", `Readonly fullnode initial state: ${readonlyState0}`);

  if (builderState0 !== readonlyState0) {
    failed("Initial state match", `${builderState0} vs ${readonlyState0}`);
    return false;
  }
  passed("Initial states match");

  // Take snapshots
  const builderSnap = await rpcCall(builderUrl, "evm_snapshot");
  const readonlySnap = await rpcCall(readonlyUrl, "evm_snapshot");

  try {
    const callParams = {
      l1Caller: USER_ADDRESS,
      l2Target: L2_RECIPIENT,
      callData: "0x",
      value: ethers.parseEther("0.1").toString(),
      currentStateRoot: builderState0,
    };

    log("Test1", "");
    log("Test1", "Executing L1→L2 call on BUILDER fullnode...");
    const builderResult = await rpcCall(builderUrl, "nativerollup_executeL1ToL2Call", [callParams]);
    log("Test1", `  State root: ${builderResult.newStateRoot}`);

    log("Test1", "Executing L1→L2 call on READONLY fullnode...");
    const readonlyResult = await rpcCall(readonlyUrl, "nativerollup_executeL1ToL2Call", [callParams]);
    log("Test1", `  State root: ${readonlyResult.newStateRoot}`);

    log("Test1", "");
    if (builderResult.newStateRoot === readonlyResult.newStateRoot) {
      passed("Both fullnodes produce same state root for value transfer");
    } else {
      failed("State root mismatch between fullnodes",
        `builder=${builderResult.newStateRoot.slice(0, 18)}... readonly=${readonlyResult.newStateRoot.slice(0, 18)}...`);
      return false;
    }
    return true;
  } finally {
    await rpcCall(builderUrl, "evm_revert", [builderSnap]);
    await rpcCall(readonlyUrl, "evm_revert", [readonlySnap]);
  }
}

// ============ Test 2: Builder simulate vs execute ============

async function testBuilderSimulateVsExecute(): Promise<boolean> {
  log("Test2", "=== Builder Simulate vs Execute Consistency ===");
  log("Test2", "");

  const builderUrl = `http://localhost:${PORTS.builderFullnode}`;
  const builderState0 = await getStateRoot(builderUrl);

  const callParams = {
    l1Caller: USER_ADDRESS,
    l2Target: L2_RECIPIENT,
    callData: "0x",
    value: ethers.parseEther("0.1").toString(),
    currentStateRoot: builderState0,
  };

  log("Test2", "Simulating (snapshot/revert)...");
  const simResult = await rpcCall(builderUrl, "nativerollup_simulateL1ToL2Call", [callParams]);
  log("Test2", `  Simulated state root: ${simResult.newStateRoot}`);

  const stateAfterSim = await getStateRoot(builderUrl);
  if (stateAfterSim !== builderState0) {
    failed("State unchanged after simulation");
    return false;
  }
  passed("State unchanged after simulation");

  const snap = await rpcCall(builderUrl, "evm_snapshot");
  try {
    log("Test2", "Executing (persistent)...");
    const execResult = await rpcCall(builderUrl, "nativerollup_executeL1ToL2Call", [callParams]);
    log("Test2", `  Executed state root: ${execResult.newStateRoot}`);

    if (simResult.newStateRoot === execResult.newStateRoot) {
      passed("Simulate and execute produce same state root");
    } else {
      failed("State root mismatch", `sim=${simResult.newStateRoot.slice(0, 18)}... exec=${execResult.newStateRoot.slice(0, 18)}...`);
      return false;
    }
    return true;
  } finally {
    await rpcCall(builderUrl, "evm_revert", [snap]);
  }
}

// ============ Test 3: End-to-end value transfer via builder ============

async function testEndToEndValueTransfer(
  l1Provider: JsonRpcProvider,
  rollupAddress: string
): Promise<boolean> {
  log("Test3", "=== End-to-End Value Transfer via Builder ===");
  log("Test3", "");

  const readonlyUrl = `http://localhost:${PORTS.readonlyFullnode}`;
  const builderUrl = `http://localhost:${PORTS.builderFullnode}`;
  const builderApi = `http://localhost:${PORTS.builder}`;

  const rollup = new Contract(rollupAddress, ROLLUP_ABI, l1Provider);
  const user = new Wallet(USER_KEY, l1Provider);

  // Pre-state
  const l1StateBefore = await rollup.l2BlockHash();
  const readonlyStateBefore = await getStateRoot(readonlyUrl);
  const l2BalanceBefore = await rpcCall(readonlyUrl, "eth_getBalance", [L2_RECIPIENT, "latest"]);

  log("Test3", `L1 l2BlockHash before:        ${l1StateBefore}`);
  log("Test3", `Readonly fullnode state before: ${readonlyStateBefore}`);

  if (l1StateBefore.toLowerCase() !== readonlyStateBefore.toLowerCase()) {
    failed("Pre-test: L1 and readonly fullnode not in sync");
    return false;
  }
  passed("Pre-test: L1 and readonly fullnode in sync");

  // Get proxy address
  const proxyAddress = await rollup.getProxyAddress(L2_RECIPIENT);
  log("Test3", `Proxy address: ${proxyAddress}`);

  // Sign tx
  const nonce = await l1Provider.getTransactionCount(user.address);
  const feeData = await l1Provider.getFeeData();
  const txRequest = {
    type: 2,
    chainId: 31337,
    nonce,
    to: proxyAddress,
    value: ethers.parseEther("0.1"),
    data: "0x",
    maxFeePerGas: feeData.maxFeePerGas || ethers.parseUnits("10", "gwei"),
    maxPriorityFeePerGas: feeData.maxPriorityFeePerGas || ethers.parseUnits("1", "gwei"),
    gasLimit: 500000n,
  };
  const signedTx = await user.signTransaction(txRequest);

  log("Test3", "Submitting to builder...");
  const submitRes = await fetch(`${builderApi}/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      signedTx,
      sourceChain: "L1",
      hints: { l2TargetAddress: L2_RECIPIENT },
    }),
  });
  const submitResult = await submitRes.json();

  if (submitResult.error) {
    failed("Builder submission", submitResult.error);
    return false;
  }
  passed(`Builder accepted: ${submitResult.l1TxHash?.slice(0, 14)}...`);

  // Wait for L1 tx
  if (submitResult.l1TxHash) {
    const receipt = await l1Provider.waitForTransaction(submitResult.l1TxHash);
    if (receipt?.status !== 1) {
      failed("L1 tx reverted");
      return false;
    }
    passed("L1 tx succeeded");
  }

  // Wait for readonly fullnode to process
  log("Test3", "Waiting for event processing...");
  await new Promise(r => setTimeout(r, 5000));

  // Post-state
  const l1StateAfter = await rollup.l2BlockHash();
  const readonlyStateAfter = await getStateRoot(readonlyUrl);
  const builderStateAfter = await getStateRoot(builderUrl);
  const l2BalanceAfter = await rpcCall(readonlyUrl, "eth_getBalance", [L2_RECIPIENT, "latest"]);

  log("Test3", "");
  log("Test3", "Post-state:");
  log("Test3", `  L1 l2BlockHash:    ${l1StateAfter}`);
  log("Test3", `  Readonly fullnode: ${readonlyStateAfter}`);
  log("Test3", `  Builder fullnode:  ${builderStateAfter}`);

  let allPassed = true;

  const balanceDiff = BigInt(l2BalanceAfter) - BigInt(l2BalanceBefore);
  if (balanceDiff === ethers.parseEther("0.1")) {
    passed("L2 balance increased by 0.1 ETH");
  } else {
    failed("L2 balance change", `expected +0.1 ETH, got +${ethers.formatEther(balanceDiff)} ETH`);
    allPassed = false;
  }

  if (l1StateAfter.toLowerCase() === readonlyStateAfter.toLowerCase()) {
    passed("Readonly fullnode matches L1 contract");
  } else {
    failed("Readonly fullnode DIVERGED from L1",
      `L1=${l1StateAfter.slice(0, 18)}... FN=${readonlyStateAfter.slice(0, 18)}...`);
    allPassed = false;
  }

  if (l1StateAfter.toLowerCase() === builderStateAfter.toLowerCase()) {
    passed("Builder fullnode matches L1 contract");
  } else {
    failed("Builder fullnode DIVERGED from L1",
      `L1=${l1StateAfter.slice(0, 18)}... BFN=${builderStateAfter.slice(0, 18)}...`);
    allPassed = false;
  }

  if (readonlyStateAfter.toLowerCase() === builderStateAfter.toLowerCase()) {
    passed("Both fullnodes agree with each other");
  } else {
    failed("Fullnodes disagree");
    allPassed = false;
  }

  return allPassed;
}

// ============ Test 4: Double value transfer ============

async function testDoubleValueTransfer(
  l1Provider: JsonRpcProvider,
  rollupAddress: string
): Promise<boolean> {
  log("Test4", "=== Double Value Transfer (consecutive) ===");
  log("Test4", "Two value transfers in sequence — catches stale registration bugs.");
  log("Test4", "");

  const readonlyUrl = `http://localhost:${PORTS.readonlyFullnode}`;
  const builderApi = `http://localhost:${PORTS.builder}`;
  const rollup = new Contract(rollupAddress, ROLLUP_ABI, l1Provider);
  const user = new Wallet(USER_KEY, l1Provider);

  const RECIPIENT_2 = "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc"; // Anvil account 5

  for (let i = 0; i < 2; i++) {
    const recipient = i === 0 ? L2_RECIPIENT : RECIPIENT_2;
    log("Test4", `Transfer ${i + 1}: 0.05 ETH to ${recipient.slice(0, 10)}...`);

    const l1StateBefore = await rollup.l2BlockHash();
    const readonlyStateBefore = await getStateRoot(readonlyUrl);

    if (l1StateBefore.toLowerCase() !== readonlyStateBefore.toLowerCase()) {
      failed(`Transfer ${i + 1}: pre-state mismatch`);
      return false;
    }

    const proxyAddress = await rollup.getProxyAddress(recipient);
    const nonce = await l1Provider.getTransactionCount(user.address);
    const feeData = await l1Provider.getFeeData();
    const signedTx = await user.signTransaction({
      type: 2,
      chainId: 31337,
      nonce,
      to: proxyAddress,
      value: ethers.parseEther("0.05"),
      data: "0x",
      maxFeePerGas: feeData.maxFeePerGas || ethers.parseUnits("10", "gwei"),
      maxPriorityFeePerGas: feeData.maxPriorityFeePerGas || ethers.parseUnits("1", "gwei"),
      gasLimit: 500000n,
    });

    const submitRes = await fetch(`${builderApi}/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        signedTx,
        sourceChain: "L1",
        hints: { l2TargetAddress: recipient },
      }),
    });
    const result = await submitRes.json();
    if (result.error) {
      failed(`Transfer ${i + 1}: builder error`, result.error);
      return false;
    }

    if (result.l1TxHash) {
      const receipt = await l1Provider.waitForTransaction(result.l1TxHash);
      if (receipt?.status !== 1) {
        failed(`Transfer ${i + 1}: L1 tx reverted`);
        return false;
      }
    }

    // Wait for event processing
    await new Promise(r => setTimeout(r, 5000));

    const l1StateAfter = await rollup.l2BlockHash();
    const readonlyStateAfter = await getStateRoot(readonlyUrl);

    if (l1StateAfter.toLowerCase() === readonlyStateAfter.toLowerCase()) {
      passed(`Transfer ${i + 1}: state in sync`);
    } else {
      failed(`Transfer ${i + 1}: DIVERGED`,
        `L1=${l1StateAfter.slice(0, 18)}... FN=${readonlyStateAfter.slice(0, 18)}...`);
      return false;
    }
  }

  passed("Both consecutive transfers maintained sync");
  return true;
}

// ============ Main ============

async function main() {
  console.log("");
  console.log("╔══════════════════════════════════════════════════════╗");
  console.log("║   L2 Value Transfer State Consistency Tests         ║");
  console.log("║   (Standalone - bootstraps its own environment)     ║");
  console.log("╚══════════════════════════════════════════════════════╝");
  console.log("");

  let l1Provider: JsonRpcProvider;
  let rollupAddress: string;

  try {
    ({ l1Provider, rollupAddress } = await bootstrap());
  } catch (err: any) {
    console.error(`Bootstrap failed: ${err.message}`);
    killAll();
    process.exit(1);
  }

  const results: { name: string; passed: boolean }[] = [];

  // Test 1
  try {
    const result = await testDirectFullnodeConsistency();
    results.push({ name: "Direct fullnode consistency", passed: result });
  } catch (err: any) {
    failed("Direct fullnode consistency", err.message);
    results.push({ name: "Direct fullnode consistency", passed: false });
  }
  console.log("");

  // Test 2
  try {
    const result = await testBuilderSimulateVsExecute();
    results.push({ name: "Simulate vs execute", passed: result });
  } catch (err: any) {
    failed("Simulate vs execute", err.message);
    results.push({ name: "Simulate vs execute", passed: false });
  }
  console.log("");

  // Test 3
  try {
    const result = await testEndToEndValueTransfer(l1Provider, rollupAddress);
    results.push({ name: "End-to-end value transfer", passed: result });
  } catch (err: any) {
    failed("End-to-end value transfer", err.message);
    results.push({ name: "End-to-end value transfer", passed: false });
  }
  console.log("");

  // Test 4
  try {
    const result = await testDoubleValueTransfer(l1Provider, rollupAddress);
    results.push({ name: "Double value transfer", passed: result });
  } catch (err: any) {
    failed("Double value transfer", err.message);
    results.push({ name: "Double value transfer", passed: false });
  }
  console.log("");

  // Summary
  console.log("╔══════════════════════════════════════════════════════╗");
  console.log("║                    SUMMARY                         ║");
  console.log("╠══════════════════════════════════════════════════════╣");
  const totalPassed = results.filter(r => r.passed).length;
  for (const r of results) {
    console.log(`║ ${r.passed ? "✓" : "✗"} ${r.name.padEnd(49)}║`);
  }
  console.log("╠══════════════════════════════════════════════════════╣");
  console.log(`║ ${totalPassed}/${results.length} tests passed${" ".repeat(39)}║`);
  console.log("╚══════════════════════════════════════════════════════╝");

  killAll();
  process.exit(totalPassed === results.length ? 0 : 1);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  killAll();
  process.exit(1);
});
