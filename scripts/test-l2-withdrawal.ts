/**
 * Standalone Test: L2→L1 Value Withdrawal
 *
 * Tests that an L2 transaction sending value to an L1SenderProxyL2
 * generates an outgoing L1 call that delivers the value on L1.
 *
 * Flow:
 * 1. Deposit ETH from L1 to L2 (fund L2 account)
 * 2. Send L2 tx with value to L1SenderProxyL2 (withdrawal)
 * 3. Verify outgoing L1 call delivers value on L1
 * 4. Verify all fullnodes stay in sync
 *
 * Usage:
 *   npx tsx scripts/test-l2-withdrawal.ts
 */

import { ethers, JsonRpcProvider, Wallet, Contract, Transaction } from "ethers";
import { spawn, ChildProcess, execSync } from "child_process";
import * as path from "path";

// ============ Port Assignment ============

const PORTS = {
  l1: 19545,
  readonlyL2Evm: 19546,
  readonlyFullnode: 19547,
  builderL2Evm: 19549,
  builderFullnode: 19550,
  builder: 19200,
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
  "event L2BlockProcessed(uint256 indexed blockNumber, bytes32 indexed prevBlockHash, bytes32 indexed newBlockHash, bytes rlpEncodedTx, tuple(address from, address target, uint256 value, uint256 gas, bytes data, bytes32 postCallStateHash)[] outgoingCalls, bytes[] outgoingCallResults)",
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

  const l1Provider = await startL1Anvil();
  const zeroGenesis = "0x0000000000000000000000000000000000000000000000000000000000000000";
  const rollupAddress = await deployContracts(l1Provider, zeroGenesis);

  await startFullnode("Readonly", PORTS.readonlyL2Evm, PORTS.readonlyFullnode, rollupAddress);
  await startFullnode("Builder", PORTS.builderL2Evm, PORTS.builderFullnode, rollupAddress);

  const genesisState = await getStateRoot(`http://localhost:${PORTS.readonlyFullnode}`);
  log("Setup", `Fullnode genesis state: ${genesisState}`);

  await l1Provider.send("anvil_setStorageAt", [rollupAddress, "0x0", genesisState]);

  const rollup = new Contract(rollupAddress, ROLLUP_ABI, l1Provider);
  const storedHash = await rollup.l2BlockHash();
  if (storedHash.toLowerCase() !== genesisState.toLowerCase()) {
    throw new Error(`Failed to sync genesis: stored=${storedHash}, expected=${genesisState}`);
  }
  log("Setup", "L1 contract synced to fullnode genesis");

  await startBuilder(rollupAddress);

  log("Setup", "=== Environment Ready ===");
  console.log("");
  return { l1Provider, rollupAddress };
}

// ============ Test 1: Deposit L1→L2 then Withdraw L2→L1 ============

async function testL2Withdrawal(
  l1Provider: JsonRpcProvider,
  rollupAddress: string
): Promise<boolean> {
  log("Test1", "=== L2→L1 Value Withdrawal ===");
  log("Test1", "1. Deposit 0.1 ETH from L1 to L2 recipient");
  log("Test1", "2. Withdraw 0.05 ETH from L2 back to L1");
  log("Test1", "3. Verify L1 balance increases and all nodes sync");
  log("Test1", "");

  const readonlyUrl = `http://localhost:${PORTS.readonlyFullnode}`;
  const builderUrl = `http://localhost:${PORTS.builderFullnode}`;
  const builderApi = `http://localhost:${PORTS.builder}`;

  const rollup = new Contract(rollupAddress, ROLLUP_ABI, l1Provider);
  const user = new Wallet(USER_KEY, l1Provider);

  // --- Step 1: Deposit 0.1 ETH from L1 to L2_RECIPIENT ---
  log("Test1", "--- Step 1: Deposit 0.1 ETH L1→L2 ---");

  const proxyAddress = await rollup.getProxyAddress(L2_RECIPIENT);
  log("Test1", `L1 proxy for ${L2_RECIPIENT}: ${proxyAddress}`);

  const nonce1 = await l1Provider.getTransactionCount(user.address);
  const feeData1 = await l1Provider.getFeeData();
  const depositTx = await user.signTransaction({
    type: 2,
    chainId: 31337,
    nonce: nonce1,
    to: proxyAddress,
    value: ethers.parseEther("0.1"),
    data: "0x",
    maxFeePerGas: feeData1.maxFeePerGas || ethers.parseUnits("10", "gwei"),
    maxPriorityFeePerGas: feeData1.maxPriorityFeePerGas || ethers.parseUnits("1", "gwei"),
    gasLimit: 500000n,
  });

  const depositRes = await fetch(`${builderApi}/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      signedTx: depositTx,
      sourceChain: "L1",
      hints: { l2TargetAddress: L2_RECIPIENT },
    }),
  });
  const depositResult = await depositRes.json();

  if (depositResult.error) {
    failed("Deposit", depositResult.error);
    return false;
  }

  if (depositResult.l1TxHash) {
    const receipt = await l1Provider.waitForTransaction(depositResult.l1TxHash);
    if (receipt?.status !== 1) {
      failed("Deposit L1 tx reverted");
      return false;
    }
  }
  passed("Deposit 0.1 ETH L1→L2 succeeded");

  // Wait for sync
  await new Promise(r => setTimeout(r, 5000));

  // Verify L2 balance
  const l2Balance = await rpcCall(`http://localhost:${PORTS.readonlyL2Evm}`, "eth_getBalance", [L2_RECIPIENT, "latest"]);
  const l2BalanceBN = BigInt(l2Balance);
  log("Test1", `L2 recipient balance: ${ethers.formatEther(l2BalanceBN)} ETH`);

  if (l2BalanceBN >= ethers.parseEther("0.1")) {
    passed("L2 recipient has >= 0.1 ETH");
  } else {
    failed("L2 recipient balance too low", `${ethers.formatEther(l2BalanceBN)}`);
    return false;
  }

  // --- Step 2: Withdraw 0.05 ETH from L2 back to L1 ---
  log("Test1", "");
  log("Test1", "--- Step 2: Withdraw 0.05 ETH L2→L1 ---");

  // Get the L1SenderProxyL2 address on L2 for the withdrawal target
  // The recipient wants to send to themselves on L1, so the L2 proxy is for their L1 address
  const l2ProxyForRecipient = await rpcCall(
    `http://localhost:${PORTS.builderFullnode}`,
    "nativerollup_getL1SenderProxyL2",
    [L2_RECIPIENT]
  );
  log("Test1", `L2 proxy for L1:${L2_RECIPIENT}: ${l2ProxyForRecipient}`);

  // Record L1 balance before withdrawal
  const l1BalanceBefore = await l1Provider.getBalance(L2_RECIPIENT);
  log("Test1", `L1 recipient balance before: ${ethers.formatEther(l1BalanceBefore)} ETH`);

  // Create L2 tx: send value to the L1SenderProxyL2 on L2
  // This needs to be signed with L2 chain ID
  const l2ChainId = 10200200; // L2 chain ID
  const l2User = new Wallet(
    "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a", // L2_RECIPIENT's private key
    new JsonRpcProvider(`http://localhost:${PORTS.builderL2Evm}`)
  );

  const l2Nonce = await rpcCall(`http://localhost:${PORTS.builderL2Evm}`, "eth_getTransactionCount", [L2_RECIPIENT, "latest"]);
  log("Test1", `L2 nonce for ${L2_RECIPIENT}: ${parseInt(l2Nonce, 16)}`);

  const withdrawTx = await l2User.signTransaction({
    type: 2,
    chainId: l2ChainId,
    nonce: parseInt(l2Nonce, 16),
    to: l2ProxyForRecipient,
    value: ethers.parseEther("0.05"),
    data: "0x",
    maxFeePerGas: 0n,
    maxPriorityFeePerGas: 0n,
    gasLimit: 100000n,
  });

  log("Test1", "Submitting L2 withdrawal tx to builder...");
  const withdrawRes = await fetch(`${builderApi}/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      signedTx: withdrawTx,
      sourceChain: "L2",
      hints: { l1TargetAddress: L2_RECIPIENT },
    }),
  });
  const withdrawResult = await withdrawRes.json();

  if (withdrawResult.error) {
    failed("Withdrawal builder submission", withdrawResult.error);
    return false;
  }

  log("Test1", `L1 tx: ${withdrawResult.l1TxHash}`);
  log("Test1", `L2 tx: ${withdrawResult.l2TxHash}`);
  passed("Withdrawal tx submitted");

  if (withdrawResult.l1TxHash) {
    const receipt = await l1Provider.waitForTransaction(withdrawResult.l1TxHash);
    if (receipt?.status !== 1) {
      failed("Withdrawal L1 tx reverted");
      return false;
    }
    passed("Withdrawal L1 tx succeeded");
  }

  // Wait for sync
  await new Promise(r => setTimeout(r, 5000));

  // --- Step 3: Verify ---
  log("Test1", "");
  log("Test1", "--- Step 3: Verify ---");

  let allPassed = true;

  // Check L1 balance increased
  const l1BalanceAfter = await l1Provider.getBalance(L2_RECIPIENT);
  const l1BalanceDiff = l1BalanceAfter - l1BalanceBefore;
  log("Test1", `L1 recipient balance after: ${ethers.formatEther(l1BalanceAfter)} ETH`);
  log("Test1", `L1 balance change: +${ethers.formatEther(l1BalanceDiff)} ETH`);

  if (l1BalanceDiff === ethers.parseEther("0.05")) {
    passed("L1 balance increased by exactly 0.05 ETH (withdrawal received)");
  } else {
    failed("L1 balance change", `expected +0.05 ETH, got +${ethers.formatEther(l1BalanceDiff)} ETH`);
    allPassed = false;
  }

  // Check all nodes are synced
  const l1StateAfter = await rollup.l2BlockHash();
  const readonlyStateAfter = await getStateRoot(readonlyUrl);
  const builderStateAfter = await getStateRoot(builderUrl);

  log("Test1", "");
  log("Test1", "Post-state:");
  log("Test1", `  L1 l2BlockHash:    ${l1StateAfter}`);
  log("Test1", `  Readonly fullnode: ${readonlyStateAfter}`);
  log("Test1", `  Builder fullnode:  ${builderStateAfter}`);

  if (l1StateAfter.toLowerCase() === readonlyStateAfter.toLowerCase()) {
    passed("Readonly fullnode matches L1 contract");
  } else {
    failed("Readonly fullnode DIVERGED from L1");
    allPassed = false;
  }

  if (l1StateAfter.toLowerCase() === builderStateAfter.toLowerCase()) {
    passed("Builder fullnode matches L1 contract");
  } else {
    failed("Builder fullnode DIVERGED from L1");
    allPassed = false;
  }

  return allPassed;
}

// ============ Test 2: Withdrawal with calldata (not just value) ============

async function testL2WithdrawalWithData(
  l1Provider: JsonRpcProvider,
  rollupAddress: string
): Promise<boolean> {
  log("Test2", "=== L2→L1 Withdrawal with Calldata ===");
  log("Test2", "Send L2 tx with value AND calldata to L1SenderProxyL2");
  log("Test2", "");

  const builderUrl = `http://localhost:${PORTS.builderFullnode}`;
  const builderApi = `http://localhost:${PORTS.builder}`;
  const readonlyUrl = `http://localhost:${PORTS.readonlyFullnode}`;
  const rollup = new Contract(rollupAddress, ROLLUP_ABI, l1Provider);

  // Get L2 proxy for L2_RECIPIENT's L1 address
  const l2ProxyForRecipient = await rpcCall(
    `http://localhost:${PORTS.builderFullnode}`,
    "nativerollup_getL1SenderProxyL2",
    [L2_RECIPIENT]
  );

  // Send L2 tx with value and some calldata
  const l2ChainId = 10200200;
  const l2User = new Wallet(
    "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
    new JsonRpcProvider(`http://localhost:${PORTS.builderL2Evm}`)
  );

  const l2Nonce = await rpcCall(`http://localhost:${PORTS.builderL2Evm}`, "eth_getTransactionCount", [L2_RECIPIENT, "latest"]);

  // Use some arbitrary calldata (will be sent to EOA on L1 so it's a no-op but shouldn't break)
  const testCalldata = "0xdeadbeef";

  const l1BalanceBefore = await l1Provider.getBalance(L2_RECIPIENT);

  const withdrawTx = await l2User.signTransaction({
    type: 2,
    chainId: l2ChainId,
    nonce: parseInt(l2Nonce, 16),
    to: l2ProxyForRecipient,
    value: ethers.parseEther("0.02"),
    data: testCalldata,
    maxFeePerGas: 0n,
    maxPriorityFeePerGas: 0n,
    gasLimit: 200000n,
  });

  log("Test2", "Submitting L2 tx with value + calldata...");
  const res = await fetch(`${builderApi}/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ signedTx: withdrawTx, sourceChain: "L2", hints: { l1TargetAddress: L2_RECIPIENT } }),
  });
  const result = await res.json();

  if (result.error) {
    failed("Builder submission", result.error);
    return false;
  }
  passed("Builder accepted tx with value + calldata");

  if (result.l1TxHash) {
    const receipt = await l1Provider.waitForTransaction(result.l1TxHash);
    if (receipt?.status !== 1) {
      failed("L1 tx reverted");
      return false;
    }
    passed("L1 tx succeeded");
  }

  await new Promise(r => setTimeout(r, 5000));

  // Verify L1 balance increase
  const l1BalanceAfter = await l1Provider.getBalance(L2_RECIPIENT);
  const diff = l1BalanceAfter - l1BalanceBefore;
  if (diff === ethers.parseEther("0.02")) {
    passed("L1 balance increased by 0.02 ETH");
  } else {
    failed("L1 balance change", `expected +0.02, got +${ethers.formatEther(diff)}`);
    return false;
  }

  // Verify sync
  const l1State = await rollup.l2BlockHash();
  const readonlyState = await getStateRoot(readonlyUrl);
  const builderState = await getStateRoot(builderUrl);

  if (l1State.toLowerCase() === readonlyState.toLowerCase() &&
      l1State.toLowerCase() === builderState.toLowerCase()) {
    passed("All nodes in sync");
  } else {
    failed("Node sync", `L1=${l1State.slice(0,14)} RO=${readonlyState.slice(0,14)} B=${builderState.slice(0,14)}`);
    return false;
  }

  return true;
}

// ============ Main ============

async function main() {
  console.log("");
  console.log("╔══════════════════════════════════════════════════════╗");
  console.log("║   L2→L1 Value Withdrawal Tests                     ║");
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

  // Test 1: Basic withdrawal
  try {
    const result = await testL2Withdrawal(l1Provider, rollupAddress);
    results.push({ name: "L2→L1 value withdrawal", passed: result });
  } catch (err: any) {
    console.error(err);
    failed("L2→L1 value withdrawal", err.message);
    results.push({ name: "L2→L1 value withdrawal", passed: false });
  }
  console.log("");

  // Test 2: Withdrawal with calldata
  try {
    const result = await testL2WithdrawalWithData(l1Provider, rollupAddress);
    results.push({ name: "L2→L1 withdrawal with calldata", passed: result });
  } catch (err: any) {
    console.error(err);
    failed("L2→L1 withdrawal with calldata", err.message);
    results.push({ name: "L2→L1 withdrawal with calldata", passed: false });
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
