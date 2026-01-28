/**
 * Test Script for SyncDemo Contract
 *
 * This script demonstrates synchronous L1↔L2 composability:
 * 1. Deploys SyncDemo contract
 * 2. Sets initial L2 value to 42
 * 3. Calls SyncDemo.setValue(66)
 * 4. Verifies: valueBefore=42, valueSet=66, valueAfter=66
 *
 * Usage:
 *   npx tsx scripts/test-sync-demo.ts [deploy|test <value>|full]
 *
 * Prerequisites:
 *   - L1 and L2 chains running (./start.sh)
 *   - L1SyncedCounter and L2SyncedCounter deployed
 *   - Builder running
 */

import {
  ethers,
  JsonRpcProvider,
  Wallet,
  Contract,
  ContractFactory,
  Transaction,
} from "ethers";
import * as fs from "fs";
import * as path from "path";

// Configuration
const L1_RPC = process.env.L1_RPC || "http://localhost:8545";
const L2_RPC = process.env.L2_RPC || "http://localhost:9546";
const BUILDER_URL = process.env.BUILDER_URL || "http://localhost:3200";
const ADMIN_PK = process.env.ADMIN_PK || "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

// Contract addresses (set after deployment or from environment)
let ROLLUP_ADDRESS = process.env.ROLLUP_ADDRESS || "";
let L1_SYNCED_COUNTER = process.env.L1_SYNCED_COUNTER || "";
let L2_SYNCED_COUNTER = process.env.L2_SYNCED_COUNTER || "";
let SYNC_DEMO_ADDRESS = process.env.SYNC_DEMO_ADDRESS || "";

function log(component: string, message: string) {
  const timestamp = new Date().toISOString().split("T")[1].split(".")[0];
  console.log(`[${timestamp}] [${component}] ${message}`);
}

function getContractArtifact(contractName: string): { abi: any; bytecode: string } {
  const artifactPath = path.join(
    process.cwd(),
    `out/${contractName}.sol/${contractName}.json`
  );

  if (!fs.existsSync(artifactPath)) {
    throw new Error(`Artifact not found: ${artifactPath}. Run 'forge build' first.`);
  }

  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  return {
    abi: artifact.abi,
    bytecode: artifact.bytecode.object,
  };
}

async function getBuilderStatus(): Promise<any> {
  const response = await fetch(`${BUILDER_URL}/status`);
  if (!response.ok) {
    throw new Error(`Builder not responding: ${response.status}`);
  }
  return response.json();
}

async function submitToBuilder(request: any): Promise<any> {
  const response = await fetch(`${BUILDER_URL}/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Builder error: ${error}`);
  }

  return response.json();
}

async function deploy(): Promise<string> {
  log("Deploy", "=== Deploying SyncDemo ===");

  const l1Provider = new JsonRpcProvider(L1_RPC);
  const adminWallet = new Wallet(ADMIN_PK, l1Provider);

  // Check builder status to get rollup address
  const status = await getBuilderStatus();
  ROLLUP_ADDRESS = status.rollupAddress;
  log("Deploy", `Rollup address: ${ROLLUP_ADDRESS}`);

  // Get L2SyncedCounter's proxy on L1
  const rollupAbi = [
    "function getProxyAddress(address l2Address) view returns (address)",
    "function isProxyDeployed(address l2Address) view returns (bool)",
    "function deployProxy(address l2Address) returns (address)",
  ];
  const rollupCore = new Contract(ROLLUP_ADDRESS, rollupAbi, adminWallet);

  // Get addresses from environment or detect
  if (!L2_SYNCED_COUNTER) {
    throw new Error("L2_SYNCED_COUNTER address required. Set via environment variable.");
  }
  if (!L1_SYNCED_COUNTER) {
    throw new Error("L1_SYNCED_COUNTER address required. Set via environment variable.");
  }

  // Ensure L2 counter has a proxy on L1
  const isProxyDeployed = await rollupCore.isProxyDeployed(L2_SYNCED_COUNTER);
  const l2CounterProxy = await rollupCore.getProxyAddress(L2_SYNCED_COUNTER);

  if (!isProxyDeployed) {
    log("Deploy", "Deploying L2SenderProxy for L2SyncedCounter...");
    const tx = await rollupCore.deployProxy(L2_SYNCED_COUNTER);
    await tx.wait();
    log("Deploy", `  Deployed at: ${l2CounterProxy}`);
  } else {
    log("Deploy", `L2SenderProxy already exists: ${l2CounterProxy}`);
  }

  // Deploy SyncDemo
  const artifact = getContractArtifact("SyncDemo");
  const factory = new ContractFactory(artifact.abi, artifact.bytecode, adminWallet);

  log("Deploy", "Deploying SyncDemo...");
  const syncDemo = await factory.deploy();
  await syncDemo.waitForDeployment();
  SYNC_DEMO_ADDRESS = await syncDemo.getAddress();
  log("Deploy", `  SyncDemo deployed at: ${SYNC_DEMO_ADDRESS}`);

  // Initialize SyncDemo
  log("Deploy", "Initializing SyncDemo...");
  const initTx = await (syncDemo as Contract).initialize(l2CounterProxy, L1_SYNCED_COUNTER);
  await initTx.wait();
  log("Deploy", "  Initialized successfully");

  log("Deploy", "");
  log("Deploy", "=== Deployment Complete ===");
  log("Deploy", `SYNC_DEMO_ADDRESS=${SYNC_DEMO_ADDRESS}`);
  log("Deploy", `L1_SYNCED_COUNTER=${L1_SYNCED_COUNTER}`);
  log("Deploy", `L2_SYNCED_COUNTER=${L2_SYNCED_COUNTER}`);
  log("Deploy", `L2 Counter Proxy: ${l2CounterProxy}`);

  return SYNC_DEMO_ADDRESS;
}

async function setInitialL2Value(value: number): Promise<void> {
  log("Setup", `Setting L2SyncedCounter to ${value}...`);

  const l1Provider = new JsonRpcProvider(L1_RPC);
  const adminWallet = new Wallet(ADMIN_PK, l1Provider);

  // Call L1SyncedCounter.setValue which syncs to L2
  const l1Counter = new Contract(L1_SYNCED_COUNTER, [
    "function setValue(uint256) returns (uint256)",
    "function value() view returns (uint256)",
  ], adminWallet);

  // Prepare the transaction
  const tx = await l1Counter.setValue.populateTransaction(value);
  const signedTx = await adminWallet.signTransaction({
    ...tx,
    nonce: await l1Provider.getTransactionCount(adminWallet.address),
    gasLimit: 500000n,
    gasPrice: (await l1Provider.getFeeData()).gasPrice,
    chainId: (await l1Provider.getNetwork()).chainId,
  });

  // Submit via builder (with L2 address hint)
  const result = await submitToBuilder({
    signedTx,
    sourceChain: "L1",
    hints: {
      isContractCall: true,
      l2Addresses: [L2_SYNCED_COUNTER],
    },
  });

  log("Setup", `  L1 tx: ${result.l1TxHash}`);
  log("Setup", `  L2 state: ${result.l2StateRoot}`);

  // Verify
  const newValue = await l1Counter.value();
  log("Setup", `  L1SyncedCounter.value() = ${newValue}`);
}

async function testSyncDemo(newValue: number): Promise<boolean> {
  log("Test", `=== Testing SyncDemo with value ${newValue} ===`);

  const l1Provider = new JsonRpcProvider(L1_RPC);
  const l2Provider = new JsonRpcProvider(L2_RPC);
  const adminWallet = new Wallet(ADMIN_PK, l1Provider);

  if (!SYNC_DEMO_ADDRESS) {
    throw new Error("SYNC_DEMO_ADDRESS not set. Run 'deploy' first.");
  }

  // Check current L2 value
  const l2Counter = new Contract(L2_SYNCED_COUNTER, [
    "function value() view returns (uint256)",
  ], l2Provider);

  const currentL2Value = await l2Counter.value();
  log("Test", `Current L2 value: ${currentL2Value}`);

  // Prepare SyncDemo.setValue() transaction
  const syncDemoInterface = new ethers.Interface([
    "function setValue(uint256 newValue)",
    "function valueBefore() view returns (uint256)",
    "function valueSet() view returns (uint256)",
    "function valueAfter() view returns (uint256)",
    "function getValues() view returns (uint256, uint256, uint256)",
  ]);

  const syncDemo = new Contract(SYNC_DEMO_ADDRESS, syncDemoInterface, adminWallet);

  const tx = await syncDemo.setValue.populateTransaction(newValue);
  const signedTx = await adminWallet.signTransaction({
    ...tx,
    nonce: await l1Provider.getTransactionCount(adminWallet.address),
    gasLimit: 1000000n,
    gasPrice: (await l1Provider.getFeeData()).gasPrice,
    chainId: (await l1Provider.getNetwork()).chainId,
  });

  log("Test", `Calling SyncDemo.setValue(${newValue}) via builder...`);
  log("Test", `  (with L2 address hint: ${L2_SYNCED_COUNTER})`);

  // Submit to builder with L2 address hint
  const result = await submitToBuilder({
    signedTx,
    sourceChain: "L1",
    hints: {
      isContractCall: true,
      l2Addresses: [L2_SYNCED_COUNTER],
    },
  });

  log("Test", `  L1 tx: ${result.l1TxHash}`);
  log("Test", `  Detected L2 calls: ${result.detectedL2Calls}`);
  log("Test", `  Final L2 state: ${result.l2StateRoot}`);

  // Read results from SyncDemo
  const [valueBefore, valueSet, valueAfter] = await syncDemo.getValues();

  log("Test", "");
  log("Test", "=== Results ===");
  log("Test", `  valueBefore: ${valueBefore} (expected: ${currentL2Value})`);
  log("Test", `  valueSet:    ${valueSet} (expected: ${newValue})`);
  log("Test", `  valueAfter:  ${valueAfter} (expected: ${newValue})`);

  // Verify
  const success =
    valueBefore.toString() === currentL2Value.toString() &&
    valueSet.toString() === newValue.toString() &&
    valueAfter.toString() === newValue.toString();

  if (success) {
    log("Test", "");
    log("Test", "SUCCESS: Synchronous L1↔L2 composability demonstrated!");
    log("Test", "  - L1 read L2 state (before update)");
    log("Test", "  - L1 modified L2 state via L1SyncedCounter");
    log("Test", "  - L1 read updated L2 state (after update)");
    log("Test", "  - All within a SINGLE L1 transaction!");
  } else {
    log("Test", "");
    log("Test", "FAILURE: Values don't match expected");
  }

  return success;
}

async function fullTest(): Promise<void> {
  log("Full", "=== Running Full SyncDemo Test ===");
  log("Full", "");

  // Step 1: Deploy SyncDemo
  await deploy();

  // Step 2: Set initial L2 value to 42
  await setInitialL2Value(42);

  // Wait a bit for state to settle
  await new Promise(resolve => setTimeout(resolve, 1000));

  // Step 3: Test with value 66
  const success = await testSyncDemo(66);

  if (!success) {
    process.exit(1);
  }
}

// CLI
const args = process.argv.slice(2);
const command = args[0] || "full";

switch (command) {
  case "deploy":
    deploy()
      .then((addr) => console.log(`SyncDemo: ${addr}`))
      .catch((err) => {
        console.error("Deploy failed:", err.message);
        process.exit(1);
      });
    break;

  case "set":
    const setValue = parseInt(args[1] || "42");
    setInitialL2Value(setValue)
      .then(() => console.log("Done"))
      .catch((err) => {
        console.error("Set failed:", err.message);
        process.exit(1);
      });
    break;

  case "test":
    const testValue = parseInt(args[1] || "66");
    testSyncDemo(testValue)
      .then((success) => process.exit(success ? 0 : 1))
      .catch((err) => {
        console.error("Test failed:", err.message);
        process.exit(1);
      });
    break;

  case "full":
    fullTest().catch((err) => {
      console.error("Full test failed:", err.message);
      process.exit(1);
    });
    break;

  default:
    console.log("Usage:");
    console.log("  npx tsx scripts/test-sync-demo.ts deploy");
    console.log("  npx tsx scripts/test-sync-demo.ts set <value>");
    console.log("  npx tsx scripts/test-sync-demo.ts test <value>");
    console.log("  npx tsx scripts/test-sync-demo.ts full");
    console.log("");
    console.log("Environment variables:");
    console.log("  L1_RPC, L2_RPC, BUILDER_URL");
    console.log("  ROLLUP_ADDRESS, L1_SYNCED_COUNTER, L2_SYNCED_COUNTER");
    console.log("  SYNC_DEMO_ADDRESS (for test command)");
}
