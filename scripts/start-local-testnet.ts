/**
 * Local Native Rollup Testnet
 *
 * Starts a complete local test environment:
 * 1. L1 Anvil chain (port 8545)
 * 2. Deploys NativeRollupCore + AdminProofVerifier to L1
 * 3. L2 Fullnode Anvil (port 9546) - syncs from L1
 * 4. L2 Builder Anvil (port 9547) - simulates before submitting to L1
 * 5. Blockscout for L1 (port 3100) - requires Docker
 * 6. Blockscout for L2 (port 3101) - requires Docker
 *
 * ============================================================================
 * TWO TYPES OF L2 STATE CHANGES
 * ============================================================================
 *
 * Type 1: L2 Transaction (conceptually triggered by L2 EOA)
 * ---------------------------------------------------------
 * - A signed transaction for the L2 chain (chainId = L2)
 * - Submitted to the builder, which executes it on L2 and submits proof to L1
 * - Example: User signs tx to call an L2 contract
 * - Flow:
 *   1. User signs L2 transaction
 *   2. Builder executes on L2, gets new state root
 *   3. Builder submits to L1 via processCallOnL2(callData = signedTx)
 *   4. Fullnode replays the transaction
 *
 * Type 2: L1→L2 Transaction (L1 call to an L2 address)
 * -----------------------------------------------------
 * - An L1 transaction that targets an L2 address's proxy on L1
 * - The proxy forwards the call to NativeRollupCore.handleIncomingCall()
 * - This triggers L2 state changes that must be pre-registered
 * - Example: Deposit ETH to L2 EOA, or call L2 contract from L1
 * - Flow:
 *   1. Derive the L1 proxy address for the target L2 address
 *   2. Send L1 tx to the proxy (with value and/or calldata)
 *   3. Builder detects the target is a proxy, simulates the L2 effect
 *   4. Builder registers the incoming call response (pre-computed L2 state)
 *   5. L1 tx executes, proxy calls handleIncomingCall()
 *   6. NativeRollupCore updates L2 state and executes any outgoing calls
 *
 * DEPOSIT is just the simplest L1→L2 tx: send ETH to an EOA's proxy
 * - No calldata, no return value, no outgoing calls
 * - Just credits the L2 EOA with the ETH value
 *
 * More complex L1→L2 txs can:
 * - Call L2 contract functions (with calldata)
 * - Return values to the L1 caller
 * - Trigger outgoing L1 calls from L2 contracts
 *
 * ============================================================================
 *
 * Test accounts (Anvil defaults, all funded on L1):
 * - Admin/Deployer: 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
 * - User 1: 0x70997970C51812dc3A010C7d01b50e0d17dc79C8
 * - User 2: 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC
 *
 * Usage:
 *   npx tsx scripts/start-local-testnet.ts              # With Blockscout (requires Docker)
 *   npx tsx scripts/start-local-testnet.ts --no-explorer # Without Blockscout (faster startup)
 *   npx tsx scripts/start-local-testnet.ts --daemon      # Keep services running in background
 */

import {
  ethers,
  JsonRpcProvider,
  Wallet,
  Contract,
  ContractFactory,
  AbiCoder,
  keccak256,
  Transaction,
} from "ethers";
import { spawn, ChildProcess, execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";

// ============ Configuration ============

const CONFIG = {
  l1Port: 8545,
  l2FullnodePort: 9546,
  l2BuilderPort: 9547,
  l1ChainId: 31337,
  l2ChainId: 10200200,
  // Use ports that don't conflict with existing blockscout instances
  blockscoutL1Port: 3100,  // frontend
  blockscoutL1Backend: 4100, // backend API
  blockscoutL1Postgres: 5500,
  blockscoutL2Port: 3101,  // frontend
  blockscoutL2Backend: 4101, // backend API
  blockscoutL2Postgres: 5501,
};

// Test accounts (Anvil defaults)
const ACCOUNTS = {
  admin: {
    address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    privateKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  },
  user1: {
    address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    privateKey: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  },
  user2: {
    address: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
    privateKey: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  },
};

// ============ Globals ============

let l1Anvil: ChildProcess | null = null;
let l2Fullnode: ChildProcess | null = null;
let l2Builder: ChildProcess | null = null;
let l1Provider: JsonRpcProvider;
let l2FullnodeProvider: JsonRpcProvider;
let l2BuilderProvider: JsonRpcProvider;
let adminWallet: Wallet;

// Docker container names for cleanup
const BLOCKSCOUT_CONTAINERS = [
  "blockscout-l1-postgres",
  "blockscout-l1-backend",
  "blockscout-l1-frontend",
  "blockscout-l2-postgres",
  "blockscout-l2-backend",
  "blockscout-l2-frontend",
];

let rollupCoreAddress: string;
let proofVerifierAddress: string;
let genesisStateRoot: string;

// L2 System Address (computed from rollup address)
let l2SystemAddress: string;

// ============ Utility Functions ============

function getContractArtifact(contractPath: string, contractName: string): { abi: any; bytecode: string } {
  const artifactPath = path.join(process.cwd(), `out/${contractPath}/${contractName}.json`);
  if (!fs.existsSync(artifactPath)) {
    throw new Error(`Artifact not found: ${artifactPath}. Run 'forge build' first.`);
  }
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  return {
    abi: artifact.abi,
    bytecode: artifact.bytecode.object,
  };
}

function computeL2SystemAddress(rollupAddress: string): string {
  const hash = keccak256(
    AbiCoder.defaultAbiCoder().encode(
      ["string", "address"],
      ["NativeRollup.L1SenderProxy.v1", rollupAddress]
    )
  );
  return "0x" + hash.slice(-40);
}

async function waitForAnvil(port: number, timeout = 10000): Promise<JsonRpcProvider> {
  const rpc = `http://localhost:${port}`;
  const start = Date.now();

  while (Date.now() - start < timeout) {
    try {
      const provider = new JsonRpcProvider(rpc);
      await provider.getBlockNumber();
      return provider;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  throw new Error(`Anvil on port ${port} failed to start within ${timeout}ms`);
}

function log(component: string, message: string) {
  const timestamp = new Date().toISOString().split("T")[1].split(".")[0];
  console.log(`[${timestamp}] [${component}] ${message}`);
}

// ============ L1 Setup ============

async function startL1(): Promise<void> {
  log("L1", `Starting Anvil on port ${CONFIG.l1Port}...`);

  // Anvil without --block-time auto-mines only when there's a transaction
  // This avoids unnecessary empty blocks while still being responsive
  l1Anvil = spawn("anvil", [
    "--port", CONFIG.l1Port.toString(),
    "--chain-id", CONFIG.l1ChainId.toString(),
    "--silent",
  ], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  l1Anvil.stderr?.on("data", (data) => {
    const msg = data.toString().trim();
    if (msg) log("L1", `[stderr] ${msg}`);
  });

  l1Provider = await waitForAnvil(CONFIG.l1Port);
  adminWallet = new Wallet(ACCOUNTS.admin.privateKey, l1Provider);

  log("L1", `Anvil ready at http://localhost:${CONFIG.l1Port}`);
  log("L1", `Admin: ${ACCOUNTS.admin.address}`);

  const balance = await l1Provider.getBalance(ACCOUNTS.admin.address);
  log("L1", `Admin balance: ${ethers.formatEther(balance)} ETH`);
}

async function deployL1Contracts(): Promise<void> {
  log("L1", "Deploying contracts...");

  // First, compute what the genesis state root will be
  // We need to deploy a temporary L2 Anvil to get the state root
  log("L1", "Computing genesis state root...");

  const tempAnvil = spawn("anvil", [
    "--port", "19999",
    "--chain-id", CONFIG.l2ChainId.toString(),
    "--accounts", "0",
    "--silent",
  ]);

  await new Promise((r) => setTimeout(r, 2000));

  const tempProvider = new JsonRpcProvider("http://localhost:19999");

  // Fund system address (we need to predict the rollup address first)
  // For now, use a placeholder and we'll update after deployment
  const tempSystemAddress = "0x0000000000000000000000000000000000000001";
  await tempProvider.send("anvil_setBalance", [
    tempSystemAddress,
    "0x" + ethers.parseEther("10000000000").toString(16),
  ]);

  const genesisBlock = await tempProvider.getBlock("latest");
  genesisStateRoot = genesisBlock?.stateRoot || ethers.ZeroHash;

  tempAnvil.kill();
  log("L1", `Genesis state root: ${genesisStateRoot}`);

  // Deploy AdminProofVerifier
  const verifierArtifact = getContractArtifact("AdminProofVerifier.sol", "AdminProofVerifier");
  const verifierFactory = new ContractFactory(
    verifierArtifact.abi,
    verifierArtifact.bytecode,
    adminWallet
  );
  const verifier = await verifierFactory.deploy(ACCOUNTS.admin.address, ACCOUNTS.admin.address);
  await verifier.waitForDeployment();
  proofVerifierAddress = await verifier.getAddress();
  log("L1", `AdminProofVerifier deployed at: ${proofVerifierAddress}`);

  // Deploy NativeRollupCore
  const rollupArtifact = getContractArtifact("NativeRollupCore.sol", "NativeRollupCore");
  const rollupFactory = new ContractFactory(
    rollupArtifact.abi,
    rollupArtifact.bytecode,
    adminWallet
  );
  const rollup = await rollupFactory.deploy(
    genesisStateRoot,
    proofVerifierAddress,
    ACCOUNTS.admin.address
  );
  await rollup.waitForDeployment();
  rollupCoreAddress = await rollup.getAddress();
  log("L1", `NativeRollupCore deployed at: ${rollupCoreAddress}`);

  // Compute L2 system address
  l2SystemAddress = computeL2SystemAddress(rollupCoreAddress);
  log("L1", `L2 System Address: ${l2SystemAddress}`);
}

// ============ L2 Fullnode ============

async function startL2Fullnode(): Promise<void> {
  log("Fullnode", `Starting L2 Anvil on port ${CONFIG.l2FullnodePort}...`);

  l2Fullnode = spawn("anvil", [
    "--port", CONFIG.l2FullnodePort.toString(),
    "--chain-id", CONFIG.l2ChainId.toString(),
    "--accounts", "0",
    "--silent",
  ], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  l2FullnodeProvider = await waitForAnvil(CONFIG.l2FullnodePort);

  // Fund L2 system address
  await l2FullnodeProvider.send("anvil_setBalance", [
    l2SystemAddress,
    "0x" + ethers.parseEther("10000000000").toString(16),
  ]);

  log("Fullnode", `L2 Anvil ready at http://localhost:${CONFIG.l2FullnodePort}`);

  const balance = await l2FullnodeProvider.getBalance(l2SystemAddress);
  log("Fullnode", `System address balance: ${ethers.formatEther(balance)} ETH`);
}

// ============ L2 Builder ============

async function startL2Builder(): Promise<void> {
  log("Builder", `Starting L2 Anvil on port ${CONFIG.l2BuilderPort}...`);

  l2Builder = spawn("anvil", [
    "--port", CONFIG.l2BuilderPort.toString(),
    "--chain-id", CONFIG.l2ChainId.toString(),
    "--accounts", "0",
    "--silent",
  ], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  l2BuilderProvider = await waitForAnvil(CONFIG.l2BuilderPort);

  // Fund L2 system address
  await l2BuilderProvider.send("anvil_setBalance", [
    l2SystemAddress,
    "0x" + ethers.parseEther("10000000000").toString(16),
  ]);

  log("Builder", `L2 Anvil ready at http://localhost:${CONFIG.l2BuilderPort}`);
}

// ============ Blockscout ============

function isDockerRunning(): boolean {
  try {
    execSync("docker info", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function stopBlockscoutContainers(): void {
  for (const container of BLOCKSCOUT_CONTAINERS) {
    try {
      execSync(`docker rm -f ${container} 2>/dev/null`, { stdio: "ignore" });
    } catch {
      // Container might not exist
    }
  }
}

function stopBlockscoutCompose(): void {
  try {
    const composeFile = path.join(process.cwd(), "docker-compose.blockscout.yml");
    execSync(`docker compose -f "${composeFile}" down -v 2>/dev/null`, { stdio: "ignore" });
  } catch {
    // Compose file might not exist or services might not be running
  }
}

async function startBlockscoutInstances(): Promise<void> {
  if (!isDockerRunning()) {
    log("Blockscout", "Docker is not running. Skipping Blockscout startup.");
    log("Blockscout", "Start Docker Desktop and run again for block explorers.");
    return;
  }

  // Clean up any existing containers
  log("Blockscout", "Cleaning up existing Blockscout containers...");
  stopBlockscoutContainers();
  stopBlockscoutCompose();

  try {
    log("Blockscout", "Starting Blockscout via docker-compose...");
    log("Blockscout", `  L1 RPC: http://host.docker.internal:${CONFIG.l1Port}`);
    log("Blockscout", `  L2 RPC: http://host.docker.internal:${CONFIG.l2FullnodePort}`);

    // Use docker-compose to start all Blockscout services
    const composeFile = path.join(process.cwd(), "docker-compose.blockscout.yml");

    execSync(
      `L1_RPC_PORT=${CONFIG.l1Port} L2_RPC_PORT=${CONFIG.l2FullnodePort} docker compose -f "${composeFile}" up -d`,
      { stdio: "pipe" }
    );

    log("Blockscout", "Waiting for services to initialize (this may take a minute)...");
    await new Promise((r) => setTimeout(r, 15000));

    log("Blockscout", "Blockscout instances started:");
    log("Blockscout", `  L1 Frontend: http://localhost:${CONFIG.blockscoutL1Port}`);
    log("Blockscout", `  L1 Backend API: http://localhost:${CONFIG.blockscoutL1Backend}`);
    log("Blockscout", `  L2 Frontend: http://localhost:${CONFIG.blockscoutL2Port}`);
    log("Blockscout", `  L2 Backend API: http://localhost:${CONFIG.blockscoutL2Backend}`);
    log("Blockscout", "Note: It may take another minute for indexing to begin.");
  } catch (err: any) {
    const stderr = err.stderr?.toString() || err.message;
    log("Blockscout", `Failed to start Blockscout: ${stderr}`);
    log("Blockscout", "The testnet will continue without block explorers.");
    log("Blockscout", "You can start Blockscout manually with:");
    log("Blockscout", `  docker compose -f docker-compose.blockscout.yml up -d`);
  }
}

// ============ Transaction Processing ============

const ROLLUP_ABI = [
  "function l2BlockHash() view returns (bytes32)",
  "function l2BlockNumber() view returns (uint256)",
  "function processCallOnL2(bytes32 prevL2BlockHash, bytes calldata callData, bytes32 postExecutionStateHash, tuple(address from, address target, uint256 value, uint256 gas, bytes data, bytes32 postCallStateHash)[] outgoingCalls, bytes[] expectedResults, bytes32 finalStateHash, bytes proof) payable",
  "function getProxyAddress(address l2Address) view returns (address)",
  "function isProxyDeployed(address l2Address) view returns (bool)",
  "function deployProxy(address l2Address) returns (address)",
  "function registerIncomingCall(address l2Address, bytes32 stateHash, bytes calldata callData, tuple(bytes32 preOutgoingCallsStateHash, tuple(address from, address target, uint256 value, uint256 gas, bytes data, bytes32 postCallStateHash)[] outgoingCalls, bytes[] expectedResults, bytes returnValue, bytes32 finalStateHash) response, bytes proof)",
  "event L2BlockProcessed(uint256 indexed blockNumber, bytes32 indexed prevBlockHash, bytes32 indexed newBlockHash, uint256 outgoingCallsCount)",
  "event L2SenderProxyDeployed(address indexed l2Address, address indexed proxyAddress)",
  "event IncomingCallRegistered(address indexed l2Address, bytes32 indexed stateHash, bytes32 indexed callDataHash, bytes32 responseKey)",
];

async function signProof(
  prevHash: string,
  callData: string,
  postExecutionState: string,
  outgoingCalls: any[],
  expectedResults: string[],
  finalState: string
): Promise<string> {
  // Hash outgoing calls
  let outgoingCallsEncoded = "0x";
  for (const c of outgoingCalls) {
    outgoingCallsEncoded = ethers.solidityPacked(
      ["bytes", "address", "address", "uint256", "uint256", "bytes32", "bytes32"],
      [outgoingCallsEncoded, c.from, c.target, c.value, c.gas, keccak256(c.data), c.postCallStateHash]
    );
  }
  const outgoingCallsHash = keccak256(outgoingCallsEncoded);

  // Hash expected results
  let resultsEncoded = "0x";
  for (const r of expectedResults) {
    resultsEncoded = ethers.solidityPacked(["bytes", "bytes32"], [resultsEncoded, keccak256(r)]);
  }
  const resultsHash = keccak256(resultsEncoded);

  const messageHash = keccak256(
    AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "bytes32", "bytes32", "bytes32", "bytes32", "bytes32"],
      [prevHash, keccak256(callData), postExecutionState, outgoingCallsHash, resultsHash, finalState]
    )
  );

  return await adminWallet.signMessage(ethers.getBytes(messageHash));
}

/**
 * Submit a signed L2 transaction through L1
 */
async function submitL2Transaction(signedTx: string): Promise<{
  l1TxHash: string;
  l2StateRoot: string;
  contractAddress?: string;
}> {
  const rollup = new Contract(rollupCoreAddress, ROLLUP_ABI, adminWallet);

  // Get current L2 state from L1
  const prevHash = await rollup.l2BlockHash();
  log("Builder", `Current L2 hash on L1: ${prevHash}`);

  // Parse the signed transaction
  const tx = Transaction.from(signedTx);
  log("Builder", `Processing tx from ${tx.from} to ${tx.to || "(deploy)"}`);

  // Fund sender on builder's L2
  await l2BuilderProvider.send("anvil_setBalance", [
    tx.from,
    "0x" + ethers.parseEther("100").toString(16),
  ]);

  // Execute on builder's L2
  const l2TxHash = await l2BuilderProvider.send("eth_sendRawTransaction", [signedTx]);
  const receipt = await l2BuilderProvider.waitForTransaction(l2TxHash);
  log("Builder", `L2 tx ${receipt?.status === 1 ? "success" : "reverted"}: ${l2TxHash}`);

  // Get new state root
  const l2Block = await l2BuilderProvider.getBlock("latest");
  const newStateRoot = l2Block?.stateRoot!;
  log("Builder", `New L2 state root: ${newStateRoot}`);

  // Sign proof
  const proof = await signProof(prevHash, signedTx, newStateRoot, [], [], newStateRoot);

  // Submit to L1
  log("Builder", "Submitting to L1...");
  const l1Tx = await rollup.processCallOnL2(
    prevHash,
    signedTx,
    newStateRoot,
    [], // no outgoing calls for simple tx
    [],
    newStateRoot,
    proof
  );
  const l1Receipt = await l1Tx.wait();
  log("Builder", `L1 tx: ${l1Receipt?.hash}`);

  // Sync to fullnode
  await syncFullnode(signedTx);

  return {
    l1TxHash: l1Receipt?.hash || "",
    l2StateRoot: newStateRoot,
    contractAddress: receipt?.contractAddress || undefined,
  };
}

/**
 * Sync a transaction to the fullnode
 */
async function syncFullnode(signedTx: string): Promise<void> {
  const tx = Transaction.from(signedTx);

  // Fund sender on fullnode's L2
  await l2FullnodeProvider.send("anvil_setBalance", [
    tx.from,
    "0x" + ethers.parseEther("100").toString(16),
  ]);

  // Execute on fullnode's L2
  const l2TxHash = await l2FullnodeProvider.send("eth_sendRawTransaction", [signedTx]);
  const receipt = await l2FullnodeProvider.waitForTransaction(l2TxHash);
  log("Fullnode", `Synced tx ${receipt?.status === 1 ? "success" : "reverted"}: ${l2TxHash}`);

  // Verify state matches
  const builderBlock = await l2BuilderProvider.getBlock("latest");
  const fullnodeBlock = await l2FullnodeProvider.getBlock("latest");

  if (builderBlock?.stateRoot === fullnodeBlock?.stateRoot) {
    log("Fullnode", `✓ State roots match: ${fullnodeBlock?.stateRoot}`);
  } else {
    log("Fullnode", `✗ State mismatch! Builder: ${builderBlock?.stateRoot}, Fullnode: ${fullnodeBlock?.stateRoot}`);
  }
}

/**
 * Create and submit a contract deployment
 */
async function deployContract(
  deployerPrivateKey: string,
  bytecode: string,
  constructorArgs?: string
): Promise<{ address: string; l1TxHash: string }> {
  const deployer = new Wallet(deployerPrivateKey);
  const deployData = bytecode + (constructorArgs || "").replace("0x", "");

  // Get nonce from builder (should match fullnode if synced)
  const nonce = await l2BuilderProvider.getTransactionCount(deployer.address);

  const txRequest = {
    type: 2,
    chainId: CONFIG.l2ChainId,
    nonce,
    to: null,
    value: 0n,
    data: deployData,
    maxFeePerGas: ethers.parseUnits("10", "gwei"),
    maxPriorityFeePerGas: ethers.parseUnits("1", "gwei"),
    gasLimit: 3000000n,
  };

  const signedTx = await deployer.signTransaction(txRequest);
  const predictedAddress = ethers.getCreateAddress({ from: deployer.address, nonce });

  log("Deploy", `Deploying contract from ${deployer.address}, predicted address: ${predictedAddress}`);

  const result = await submitL2Transaction(signedTx);

  return {
    address: result.contractAddress || predictedAddress,
    l1TxHash: result.l1TxHash,
  };
}

/**
 * Create and submit a contract call
 */
async function callContract(
  callerPrivateKey: string,
  to: string,
  data: string,
  value: bigint = 0n
): Promise<{ l1TxHash: string }> {
  const caller = new Wallet(callerPrivateKey);

  const nonce = await l2BuilderProvider.getTransactionCount(caller.address);

  const txRequest = {
    type: 2,
    chainId: CONFIG.l2ChainId,
    nonce,
    to,
    value,
    data,
    maxFeePerGas: ethers.parseUnits("10", "gwei"),
    maxPriorityFeePerGas: ethers.parseUnits("1", "gwei"),
    gasLimit: 500000n,
  };

  const signedTx = await caller.signTransaction(txRequest);
  log("Call", `Calling ${to} from ${caller.address}`);

  const result = await submitL2Transaction(signedTx);

  return { l1TxHash: result.l1TxHash };
}

// ============ L1→L2 Transactions ============
//
// ROLE SEPARATION:
//
// USER:
//   1. Knows the L2 target address (A)
//   2. Computes the proxy address (A*) using getProxyAddress(A)
//   3. Signs an L1 transaction TO the proxy address (A*)
//   4. Submits the signed transaction to the Builder with a HINT containing the L2 address (A)
//
// BUILDER:
//   1. Receives signed L1 transaction + hints from user
//   2. Uses the hint to understand that the target (A*) is a proxy for L2 address (A)
//   3. Simulates the L2 effect of the incoming call
//   4. Deploys the proxy on L1 if not already deployed
//   5. Registers the incoming call response (pre-computed L2 state)
//   6. Broadcasts the user's signed L1 transaction
//   7. Syncs the fullnode
//
// The hint is REQUIRED because:
//   - The builder cannot distinguish between A* being a regular L1 EOA vs a proxy address
//   - Only with the hint can the builder know to:
//     a) Deploy the proxy contract at A* if needed
//     b) Simulate the L2 state change for address A
//     c) Register the incoming call response
//

/**
 * Hints for L1→L2 transaction submission
 * These help the builder understand what the transaction is doing
 */
interface L1ToL2TransactionHints {
  /** The L2 address that the proxy represents (REQUIRED for proxy detection) */
  l2TargetAddress: string;

  /** Optional: Expected return value (for contract calls) */
  expectedReturnValue?: string;

  /** Optional: Description for logging */
  description?: string;
}

/**
 * Builder's internal function to sign an incoming call proof
 */
function builderSignIncomingCallProof(
  l2Address: string,
  stateHash: string,
  callData: string,
  response: {
    preOutgoingCallsStateHash: string;
    outgoingCalls: any[];
    expectedResults: string[];
    returnValue: string;
    finalStateHash: string;
  }
): Promise<string> {
  // Hash outgoing calls (same as in verifier)
  let outgoingCallsEncoded = "0x";
  for (const c of response.outgoingCalls) {
    outgoingCallsEncoded = ethers.solidityPacked(
      ["bytes", "address", "address", "uint256", "uint256", "bytes32", "bytes32"],
      [outgoingCallsEncoded, c.from, c.target, c.value, c.gas, keccak256(c.data), c.postCallStateHash]
    );
  }
  const outgoingCallsHash = keccak256(outgoingCallsEncoded);

  // Hash expected results
  let resultsEncoded = "0x";
  for (const r of response.expectedResults) {
    resultsEncoded = ethers.solidityPacked(["bytes", "bytes32"], [resultsEncoded, keccak256(r)]);
  }
  const resultsHash = keccak256(resultsEncoded);

  // Create message hash matching the contract's _verifyIncomingCallProof
  const messageHash = keccak256(
    AbiCoder.defaultAbiCoder().encode(
      ["address", "bytes32", "bytes32", "bytes32", "bytes32", "bytes32", "bytes32", "bytes32"],
      [
        l2Address,
        stateHash,
        keccak256(callData),
        response.preOutgoingCallsStateHash,
        outgoingCallsHash,
        resultsHash,
        keccak256(response.returnValue),
        response.finalStateHash
      ]
    )
  );

  return adminWallet.signMessage(ethers.getBytes(messageHash));
}

// =====================================
// USER-SIDE FUNCTIONS
// =====================================
// The user only needs to:
// 1. Know the L2 target address (A)
// 2. Get the proxy address (A*) from the rollup contract
// 3. Sign an L1 transaction to A*
// 4. Submit to builder with hint containing A

/**
 * USER: Get the L1 proxy address for an L2 address
 * This is a read-only call that can be done by anyone
 */
async function userGetProxyAddress(l2Address: string): Promise<string> {
  const rollup = new Contract(rollupCoreAddress, ROLLUP_ABI, l1Provider);
  return await rollup.getProxyAddress(l2Address);
}

/**
 * USER: Create and sign an L1 transaction to an L2 address's proxy
 *
 * @param senderPrivateKey - The user's L1 private key
 * @param l2Target - The L2 address to send to
 * @param value - ETH value to send
 * @param callData - Call data (empty for simple ETH transfer)
 * @returns Signed transaction and hints for the builder
 */
async function userCreateL1ToL2Transaction(
  senderPrivateKey: string,
  l2Target: string,
  value: bigint,
  callData: string = "0x"
): Promise<{
  signedTx: string;
  hints: L1ToL2TransactionHints;
}> {
  const sender = new Wallet(senderPrivateKey, l1Provider);

  // Step 1: Get the proxy address for the L2 target
  const proxyAddress = await userGetProxyAddress(l2Target);
  log("User", `L2 address ${l2Target} -> L1 proxy ${proxyAddress}`);

  // Step 2: Create the transaction to the proxy
  const nonce = await l1Provider.getTransactionCount(sender.address);
  const feeData = await l1Provider.getFeeData();

  const txRequest = {
    type: 2,
    chainId: CONFIG.l1ChainId,
    nonce,
    to: proxyAddress,
    value,
    data: callData,
    maxFeePerGas: feeData.maxFeePerGas || ethers.parseUnits("10", "gwei"),
    maxPriorityFeePerGas: feeData.maxPriorityFeePerGas || ethers.parseUnits("1", "gwei"),
    gasLimit: 500000n, // Generous limit for proxy + incoming call handling
  };

  // Step 3: Sign the transaction
  const signedTx = await sender.signTransaction(txRequest);
  log("User", `Signed L1 tx to proxy, value: ${ethers.formatEther(value)} ETH`);

  // Step 4: Create hints for the builder
  const hints: L1ToL2TransactionHints = {
    l2TargetAddress: l2Target,
    description: value > 0n ? `Deposit ${ethers.formatEther(value)} ETH` : "L1->L2 call",
  };

  return { signedTx, hints };
}

// =====================================
// BUILDER-SIDE FUNCTIONS
// =====================================
// The builder receives signed L1 transactions with hints and:
// 1. Validates the hint (checks that tx.to matches proxy for hint.l2TargetAddress)
// 2. Simulates the L2 effect
// 3. Deploys proxy if needed
// 4. Registers incoming call response
// 5. Broadcasts the user's signed transaction
// 6. Syncs fullnode

/**
 * BUILDER: Process an L1→L2 transaction submitted by a user
 *
 * @param signedTx - The user's signed L1 transaction
 * @param hints - Hints from the user explaining the transaction
 * @returns Result of processing
 */
async function builderProcessL1ToL2Transaction(
  signedTx: string,
  hints: L1ToL2TransactionHints
): Promise<{
  l1TxHash: string;
  proxyAddress: string;
  l2StateRoot: string;
}> {
  const rollup = new Contract(rollupCoreAddress, ROLLUP_ABI, adminWallet);

  // Parse the signed transaction
  const tx = Transaction.from(signedTx);
  const l2Target = hints.l2TargetAddress;

  log("Builder", `Received L1→L2 tx from user`);
  log("Builder", `  From: ${tx.from}`);
  log("Builder", `  To (proxy): ${tx.to}`);
  log("Builder", `  L2 Target (from hint): ${l2Target}`);
  log("Builder", `  Value: ${ethers.formatEther(tx.value)} ETH`);
  if (hints.description) {
    log("Builder", `  Description: ${hints.description}`);
  }

  // Step 1: Validate the hint - check that tx.to is the correct proxy for l2Target
  const expectedProxy = await rollup.getProxyAddress(l2Target);
  if (tx.to?.toLowerCase() !== expectedProxy.toLowerCase()) {
    throw new Error(
      `Invalid hint: tx.to (${tx.to}) does not match expected proxy (${expectedProxy}) for L2 address ${l2Target}`
    );
  }
  log("Builder", `  ✓ Hint validated: tx.to matches proxy for L2 address`);

  // Step 2: Get current L2 state
  const currentL2Hash = await rollup.l2BlockHash();
  log("Builder", `  Current L2 hash: ${currentL2Hash}`);

  // Step 3: Simulate the L2 effect
  log("Builder", `Simulating L2 effect...`);

  // For deposits (value > 0), credit the L2 target
  if (tx.value > 0n) {
    const currentBalance = await l2BuilderProvider.getBalance(l2Target);
    const newBalance = currentBalance + tx.value;
    await l2BuilderProvider.send("anvil_setBalance", [
      l2Target,
      "0x" + newBalance.toString(16),
    ]);
    log("Builder", `  Credited ${ethers.formatEther(tx.value)} ETH to ${l2Target}`);
  }

  // TODO: If tx.data is not empty, execute L2 contract and capture:
  // - Return value
  // - Outgoing L1 calls
  // - Post-call state changes

  // Mine to update state root
  await l2BuilderProvider.send("evm_mine", []);
  const l2Block = await l2BuilderProvider.getBlock("latest");
  const newL2StateRoot = l2Block?.stateRoot!;
  log("Builder", `  New L2 state root: ${newL2StateRoot}`);

  // Step 4: Prepare incoming call response
  const callData = tx.data || "0x";
  const response = {
    preOutgoingCallsStateHash: newL2StateRoot,
    outgoingCalls: [],
    expectedResults: [],
    returnValue: hints.expectedReturnValue || "0x",
    finalStateHash: newL2StateRoot,
  };

  // Step 5: Sign the incoming call proof
  const proof = await builderSignIncomingCallProof(l2Target, currentL2Hash, callData, response);

  // Step 6: Register incoming call response on L1
  log("Builder", `Registering incoming call response...`);
  const registerTx = await rollup.registerIncomingCall(
    l2Target,
    currentL2Hash,
    callData,
    response,
    proof
  );
  await registerTx.wait();
  log("Builder", `  Registered: ${registerTx.hash}`);

  // Step 7: Deploy proxy if needed
  const isDeployed = await rollup.isProxyDeployed(l2Target);
  if (!isDeployed) {
    log("Builder", `Deploying proxy for ${l2Target}...`);
    const deployTx = await rollup.deployProxy(l2Target);
    await deployTx.wait();
    log("Builder", `  Proxy deployed: ${deployTx.hash}`);
  } else {
    log("Builder", `  Proxy already deployed`);
  }

  // Step 8: Broadcast the user's signed transaction
  log("Builder", `Broadcasting user's L1 transaction...`);
  const l1TxHash = await l1Provider.send("eth_sendRawTransaction", [signedTx]);
  const receipt = await l1Provider.waitForTransaction(l1TxHash);
  log("Builder", `  L1 tx: ${receipt?.hash}`);
  log("Builder", `  Status: ${receipt?.status === 1 ? "SUCCESS" : "REVERTED"}`);

  if (receipt?.status !== 1) {
    throw new Error(`L1 transaction reverted: ${l1TxHash}`);
  }

  // Step 9: Sync fullnode
  log("Builder", `Syncing fullnode...`);
  if (tx.value > 0n) {
    const currentBalance = await l2FullnodeProvider.getBalance(l2Target);
    const newBalance = currentBalance + tx.value;
    await l2FullnodeProvider.send("anvil_setBalance", [
      l2Target,
      "0x" + newBalance.toString(16),
    ]);
  }
  await l2FullnodeProvider.send("evm_mine", []);

  // Verify state roots match
  const fullnodeBlock = await l2FullnodeProvider.getBlock("latest");
  const builderBlock = await l2BuilderProvider.getBlock("latest");

  if (builderBlock?.stateRoot === fullnodeBlock?.stateRoot) {
    log("Builder", `  ✓ State roots match: ${fullnodeBlock?.stateRoot}`);
  } else {
    log("Builder", `  ✗ State mismatch! Builder: ${builderBlock?.stateRoot}, Fullnode: ${fullnodeBlock?.stateRoot}`);
  }

  return {
    l1TxHash: receipt?.hash || "",
    proxyAddress: expectedProxy,
    l2StateRoot: newL2StateRoot,
  };
}

// =====================================
// CONVENIENCE FUNCTIONS
// =====================================

/**
 * Complete L1→L2 deposit flow (combines user + builder steps for testing)
 *
 * In production:
 * - User would call userCreateL1ToL2Transaction() and submit to builder API
 * - Builder would receive and call builderProcessL1ToL2Transaction()
 */
async function deposit(
  senderPrivateKey: string,
  l2Recipient: string,
  amount: bigint
): Promise<{ l1TxHash: string; proxyAddress: string }> {
  log("Deposit", `=== Depositing ${ethers.formatEther(amount)} ETH to ${l2Recipient} ===`);

  // USER SIDE: Create and sign the transaction
  log("Deposit", "--- User: Creating transaction ---");
  const { signedTx, hints } = await userCreateL1ToL2Transaction(
    senderPrivateKey,
    l2Recipient,
    amount,
    "0x"
  );

  // BUILDER SIDE: Process the transaction
  log("Deposit", "--- Builder: Processing transaction ---");
  const result = await builderProcessL1ToL2Transaction(signedTx, hints);

  // Verify
  const l2Balance = await l2FullnodeProvider.getBalance(l2Recipient);
  log("Deposit", `=== Complete! L2 balance: ${ethers.formatEther(l2Balance)} ETH ===`);

  return {
    l1TxHash: result.l1TxHash,
    proxyAddress: result.proxyAddress,
  };
}

// ============ Demo / Interactive ============

async function runDemo(): Promise<void> {
  log("Demo", "=== Deploying L2SyncedCounter ===");

  const artifact = getContractArtifact("SyncedCounter.sol", "L2SyncedCounter");
  const deployment = await deployContract(ACCOUNTS.user1.privateKey, artifact.bytecode);

  log("Demo", `L2SyncedCounter deployed at: ${deployment.address}`);

  // Read initial value
  const counter = new Contract(
    deployment.address,
    ["function value() view returns (uint256)", "function setValue(uint256) returns (uint256)"],
    l2FullnodeProvider
  );

  const initialValue = await counter.value();
  log("Demo", `Initial value: ${initialValue}`);

  // Set value to 42
  log("Demo", "=== Setting value to 42 ===");
  const setValueData = counter.interface.encodeFunctionData("setValue", [42]);
  await callContract(ACCOUNTS.user1.privateKey, deployment.address, setValueData);

  const newValue = await counter.value();
  log("Demo", `New value: ${newValue}`);

  // Set value to 100
  log("Demo", "=== Setting value to 100 ===");
  const setValueData2 = counter.interface.encodeFunctionData("setValue", [100]);
  await callContract(ACCOUNTS.user1.privateKey, deployment.address, setValueData2);

  const finalValue = await counter.value();
  log("Demo", `Final value: ${finalValue}`);
}

async function interactiveMode(): Promise<void> {
  console.log("\n=== Native Rollup Local Testnet ===");
  console.log(`\nRPC Endpoints:`);
  console.log(`  L1 RPC: http://localhost:${CONFIG.l1Port}`);
  console.log(`  L2 Fullnode RPC: http://localhost:${CONFIG.l2FullnodePort}`);
  console.log(`  L2 Builder RPC: http://localhost:${CONFIG.l2BuilderPort}`);
  console.log(`\nBlock Explorers:`);
  console.log(`  L1 Blockscout: http://localhost:${CONFIG.blockscoutL1Port}`);
  console.log(`  L2 Blockscout: http://localhost:${CONFIG.blockscoutL2Port}`);
  console.log(`\nContracts:`);
  console.log(`  NativeRollupCore: ${rollupCoreAddress}`);
  console.log(`  AdminProofVerifier: ${proofVerifierAddress}`);
  console.log(`  L2 System Address: ${l2SystemAddress}`);
  console.log(`\nAccounts:`);
  console.log(`  Admin: ${ACCOUNTS.admin.address}`);
  console.log(`  User1: ${ACCOUNTS.user1.address}`);
  console.log(`  User2: ${ACCOUNTS.user2.address}`);
  console.log(`\nCommands:`);
  console.log(`  demo     - Run the demo (deploy counter, set values)`);
  console.log(`  deposit  - Deposit 0.1 ETH from L1 to User2 on L2`);
  console.log(`  status   - Show current L1/L2 state`);
  console.log(`  balances - Show L2 balances`);
  console.log(`  quit     - Exit`);

  // Check if stdin is a TTY (interactive) or has piped input
  const hasPipedInput = !process.stdin.isTTY && process.stdin.readable;

  if (!process.stdin.isTTY && !hasPipedInput) {
    if (daemonMode) {
      // Daemon mode - keep running without cleanup
      log("Main", "Daemon mode - services will keep running.");
      log("Main", "Press Ctrl+C to stop all services.");
      // Keep the process alive
      await new Promise(() => {}); // Never resolves
    } else {
      // Non-interactive mode - just run demo and exit
      log("Main", "Non-interactive mode detected, running demo...");
      await runDemo();
      cleanup();
      process.exit(0);
    }
    return;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const prompt = () => {
    rl.question("\n> ", async (input) => {
      const cmd = input.trim().toLowerCase();

      switch (cmd) {
        case "demo":
          await runDemo();
          break;

        case "deposit":
          // Deposit 0.1 ETH from Admin (L1) to User2 (L2)
          try {
            const depositAmount = ethers.parseEther("0.1");
            console.log(`\nDepositing ${ethers.formatEther(depositAmount)} ETH to User2 on L2...`);
            const depositResult = await deposit(
              ACCOUNTS.admin.privateKey,
              ACCOUNTS.user2.address,
              depositAmount
            );
            console.log(`\nDeposit complete!`);
            console.log(`  L1 TX: ${depositResult.l1TxHash}`);
            console.log(`  L1 Proxy: ${depositResult.proxyAddress}`);
          } catch (err: any) {
            console.error(`Deposit failed: ${err.message}`);
          }
          break;

        case "balances":
          console.log(`\nL2 Balances (Fullnode):`);
          for (const [name, account] of Object.entries(ACCOUNTS)) {
            const balance = await l2FullnodeProvider.getBalance(account.address);
            console.log(`  ${name}: ${ethers.formatEther(balance)} ETH`);
          }
          break;

        case "status":
          const rollup = new Contract(rollupCoreAddress, ROLLUP_ABI, l1Provider);
          const l2Hash = await rollup.l2BlockHash();
          const l2BlockNum = await rollup.l2BlockNumber();
          const fullnodeBlock = await l2FullnodeProvider.getBlock("latest");
          const builderBlock = await l2BuilderProvider.getBlock("latest");

          console.log(`\nL1 State:`);
          console.log(`  L2 Block Number: ${l2BlockNum}`);
          console.log(`  L2 Block Hash: ${l2Hash}`);
          console.log(`\nFullnode State:`);
          console.log(`  Block: ${fullnodeBlock?.number}`);
          console.log(`  State Root: ${fullnodeBlock?.stateRoot}`);
          console.log(`\nBuilder State:`);
          console.log(`  Block: ${builderBlock?.number}`);
          console.log(`  State Root: ${builderBlock?.stateRoot}`);
          break;

        case "quit":
        case "exit":
        case "q":
          rl.close();
          cleanup();
          process.exit(0);

        case "help":
          console.log(`\nCommands:`);
          console.log(`  demo     - Run the demo (deploy counter, set values)`);
          console.log(`  deposit  - Deposit 0.1 ETH from L1 to User2 on L2`);
          console.log(`  status   - Show current L1/L2 state`);
          console.log(`  balances - Show L2 balances`);
          console.log(`  quit     - Exit`);
          break;

        default:
          console.log("Unknown command. Try: demo, deposit, status, balances, quit");
      }

      prompt();
    });
  };

  prompt();
}

// ============ Cleanup ============

function cleanup(): void {
  log("Main", "Cleaning up...");

  if (l1Anvil) {
    l1Anvil.kill();
    l1Anvil = null;
  }
  if (l2Fullnode) {
    l2Fullnode.kill();
    l2Fullnode = null;
  }
  if (l2Builder) {
    l2Builder.kill();
    l2Builder = null;
  }

  // Stop Blockscout containers
  log("Main", "Stopping Blockscout containers...");
  stopBlockscoutContainers();
  stopBlockscoutCompose();

  log("Main", "Done.");
}

// ============ Main ============

// Parse command-line arguments
const skipExplorer = process.argv.includes("--no-explorer");
const daemonMode = process.argv.includes("--daemon");

async function main(): Promise<void> {
  console.log("=== Native Rollup Local Testnet ===\n");

  // Handle cleanup on exit
  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });

  try {
    // Compile contracts first
    log("Main", "Compiling contracts...");
    execSync("forge build", { stdio: "inherit" });

    // Start L1
    await startL1();

    // Deploy L1 contracts
    await deployL1Contracts();

    // Start L2 Fullnode
    await startL2Fullnode();

    // Start L2 Builder
    await startL2Builder();

    // Start Blockscout instances (requires Docker)
    if (!skipExplorer) {
      await startBlockscoutInstances();
    } else {
      log("Main", "Skipping Blockscout (--no-explorer flag)");
    }

    // Enter interactive mode
    await interactiveMode();
  } catch (err: any) {
    log("Main", `Error: ${err.message}`);
    cleanup();
    process.exit(1);
  }
}

main();
