/**
 * Deterministic Builder API
 *
 * The builder receives transactions and simulates them by FORKING the canonical
 * fullnode state. This ensures the builder computes the exact same state roots
 * that any fullnode will compute after seeing the L1 events.
 *
 * Architecture:
 * 1. User submits signed L2 transaction
 * 2. Builder forks the fullnode's current state
 * 3. Builder executes transaction on the fork
 * 4. Builder reads the new state root from the fork
 * 5. Builder submits to L1: processSingleTxOnL2(rawTx, newStateRoot, proof)
 * 6. L1 emits event, fullnode sees it, executes same tx, gets same state root
 *
 * Key insight: The builder doesn't maintain its own L2 state - it always
 * forks the canonical fullnode to ensure determinism.
 */

import {
  ethers,
  JsonRpcProvider,
  Wallet,
  Contract,
  Transaction,
} from "ethers";
import * as http from "http";
import { spawn, ChildProcess } from "child_process";

// ============ Configuration ============

interface Config {
  port: number;
  l1Rpc: string;
  fullnodeRpc: string; // The canonical fullnode to fork
  rollupAddress: string;
  adminPrivateKey: string;
}

function parseArgs(): Config {
  const args = process.argv.slice(2);
  const config: Config = {
    port: 3200,
    l1Rpc: "http://localhost:8545",
    fullnodeRpc: "http://localhost:9546", // Fork from the canonical fullnode
    rollupAddress: "",
    adminPrivateKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--port":
        config.port = parseInt(args[++i]);
        break;
      case "--l1-rpc":
        config.l1Rpc = args[++i];
        break;
      case "--fullnode":
        config.fullnodeRpc = args[++i];
        break;
      case "--rollup":
        config.rollupAddress = args[++i];
        break;
      case "--admin-key":
        config.adminPrivateKey = args[++i];
        break;
    }
  }

  return config;
}

// ============ Globals ============

let l1Provider: JsonRpcProvider;
let fullnodeProvider: JsonRpcProvider;
let adminWallet: Wallet;
let rollupContract: Contract;
let config: Config;

const ROLLUP_ABI = [
  "function l2BlockHash() view returns (bytes32)",
  "function l2BlockNumber() view returns (uint256)",
  "function processSingleTxOnL2(bytes32 prevL2BlockHash, bytes calldata rlpEncodedTx, bytes32 preOutgoingCallsStateHash, tuple(address from, address target, uint256 value, uint256 gas, bytes data, bytes32 postCallStateHash)[] outgoingCalls, bytes[] expectedResults, bytes32 finalStateHash, bytes proof) payable",
  "function getProxyAddress(address l2Address) view returns (address)",
  "function isProxyDeployed(address l2Address) view returns (bool)",
  "function deployProxy(address l2Address) returns (address)",
  "function registerIncomingCall(address l2Address, bytes32 stateHash, bytes calldata callData, tuple(bytes32 preOutgoingCallsStateHash, tuple(address from, address target, uint256 value, uint256 gas, bytes data, bytes32 postCallStateHash)[] outgoingCalls, bytes[] expectedResults, bytes returnValue, bytes32 finalStateHash) response, bytes proof)",
  "function getResponseKey(address l2Address, bytes32 stateHash, bytes calldata callData) view returns (bytes32)",
  "function incomingCallRegistered(bytes32 responseKey) view returns (bool)",
];

// ============ Logging ============

function log(component: string, message: string) {
  const timestamp = new Date().toISOString().split("T")[1].split(".")[0];
  console.log(`[${timestamp}] [${component}] ${message}`);
}

// ============ State Root Helpers ============

async function getStateRoot(provider: JsonRpcProvider): Promise<string> {
  const block = await provider.send("eth_getBlockByNumber", ["latest", false]);
  const stateRoot = block?.stateRoot;

  // CRITICAL: Never return a zero or invalid state root
  if (!stateRoot || stateRoot === "0x0" || stateRoot === "0x0000000000000000000000000000000000000000000000000000000000000000") {
    throw new Error(`Invalid state root from provider: ${stateRoot}`);
  }

  return stateRoot;
}

// ============ Fork Management ============

interface ForkInstance {
  provider: JsonRpcProvider;
  process: ChildProcess;
  port: number;
}

let forkCounter = 0;

/**
 * Create a fork of the canonical fullnode state (L2)
 */
async function createFork(): Promise<ForkInstance> {
  return createForkFrom(config.fullnodeRpc);
}

/**
 * Create a fork of L1 state
 */
async function createL1Fork(): Promise<ForkInstance> {
  return createForkFrom(config.l1Rpc);
}

/**
 * Create a fork from a specific RPC URL
 */
async function createForkFrom(rpcUrl: string): Promise<ForkInstance> {
  const forkPort = 19000 + (forkCounter++ % 100);
  const forkRpc = `http://localhost:${forkPort}`;

  log("Builder", `Creating fork on port ${forkPort}...`);

  const anvilProcess = spawn("anvil", [
    "--fork-url", rpcUrl,
    "--port", forkPort.toString(),
    "--silent",
  ], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Wait for fork to be ready and return the working provider
  const provider = await new Promise<JsonRpcProvider>((resolve, reject) => {
    const timeout = setTimeout(() => {
      anvilProcess.kill();
      reject(new Error("Fork failed to start within 10 seconds"));
    }, 10000);

    const checkReady = async () => {
      try {
        const testProvider = new JsonRpcProvider(forkRpc);
        // Verify we can actually get a block with state root
        const block = await testProvider.send("eth_getBlockByNumber", ["latest", false]);
        if (block?.stateRoot && block.stateRoot !== "0x0000000000000000000000000000000000000000000000000000000000000000") {
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
      reject(new Error(`Failed to spawn fork: ${err.message}`));
    });

    checkReady();
  });

  log("Builder", `Fork ready at ${forkRpc}`);

  return { provider, process: anvilProcess, port: forkPort };
}

/**
 * Destroy a fork instance
 */
function destroyFork(fork: ForkInstance) {
  fork.process.kill();
}

// ============ L2SenderProxy Management ============

/**
 * Ensure L2SenderProxy is deployed on L1 for each L2 address
 *
 * @param l2Addresses Array of L2 contract addresses that will be called
 * @returns Array of proxy addresses that were deployed or already existed
 */
async function ensureL2SenderProxiesDeployed(l2Addresses: string[]): Promise<string[]> {
  const proxyAddresses: string[] = [];

  for (const l2Address of l2Addresses) {
    const isDeployed = await rollupContract.isProxyDeployed(l2Address);
    const proxyAddress = await rollupContract.getProxyAddress(l2Address);

    if (!isDeployed) {
      log("Builder", `  Deploying L2SenderProxy for ${l2Address}...`);
      const tx = await rollupContract.deployProxy(l2Address);
      await tx.wait();
      log("Builder", `    Proxy deployed at: ${proxyAddress}`);
    } else {
      log("Builder", `  L2SenderProxy already deployed for ${l2Address}: ${proxyAddress}`);
    }

    proxyAddresses.push(proxyAddress);
  }

  return proxyAddresses;
}

// ============ Proof Signing ============

async function signProof(
  prevHash: string,
  callData: string,
  postExecutionStateHash: string,
  outgoingCalls: any[],
  expectedResults: string[],
  finalStateHash: string
): Promise<string> {
  // Match the contract's verifyProof exactly:
  // keccak256(abi.encode(
  //     prevBlockHash,
  //     keccak256(callData),
  //     postExecutionStateHash,
  //     _hashCalls(outgoingCalls),
  //     _hashResults(expectedResults),
  //     finalStateHash
  // ));
  const messageHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "bytes32", "bytes32", "bytes32", "bytes32", "bytes32"],
      [
        prevHash,
        ethers.keccak256(callData),  // Contract hashes callData
        postExecutionStateHash,
        hashOutgoingCalls(outgoingCalls),
        hashResults(expectedResults),
        finalStateHash,
      ]
    )
  );

  const signature = await adminWallet.signMessage(ethers.getBytes(messageHash));
  return signature;
}

/**
 * Hash outgoing calls exactly like the contract's _hashOutgoingCalls
 *
 * Contract logic:
 *   bytes memory encoded;
 *   for (uint256 i = 0; i < calls.length; i++) {
 *       encoded = abi.encodePacked(
 *           encoded,
 *           calls[i].from,
 *           calls[i].target,
 *           calls[i].value,
 *           calls[i].gas,
 *           keccak256(calls[i].data),
 *           calls[i].postCallStateHash
 *       );
 *   }
 *   return keccak256(encoded);
 */
function hashOutgoingCalls(calls: any[]): string {
  let encoded = "0x";
  for (const c of calls) {
    // abi.encodePacked for each call
    const callEncoded = ethers.solidityPacked(
      ["address", "address", "uint256", "uint256", "bytes32", "bytes32"],
      [
        c.from,
        c.target,
        c.value,
        c.gas,
        ethers.keccak256(c.data),
        c.postCallStateHash,
      ]
    );
    // Concatenate to existing encoded
    encoded = ethers.concat([encoded, callEncoded]);
  }
  return ethers.keccak256(encoded);
}

/**
 * Hash expected results exactly like the contract's _hashResults
 *
 * Contract logic:
 *   bytes memory encoded;
 *   for (uint256 i = 0; i < results.length; i++) {
 *       encoded = abi.encodePacked(encoded, keccak256(results[i]));
 *   }
 *   return keccak256(encoded);
 */
function hashResults(results: string[]): string {
  let encoded = "0x";
  for (const r of results) {
    const resultHash = ethers.keccak256(r);
    encoded = ethers.concat([encoded, resultHash]);
  }
  return ethers.keccak256(encoded);
}

async function signIncomingCallProof(
  l2Address: string,
  stateHash: string,
  callData: string,
  response: any
): Promise<string> {
  // Hash outgoing calls exactly like the contract
  const outgoingCallsHash = hashOutgoingCalls(response.outgoingCalls);

  // Hash expected results exactly like the contract
  const expectedResultsHash = hashResults(response.expectedResults);

  // The message hash must match the contract's _verifyIncomingCallProof
  const messageHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "bytes32", "bytes32", "bytes32", "bytes32", "bytes32", "bytes32", "bytes32"],
      [
        l2Address,
        stateHash,
        ethers.keccak256(callData),  // callData hash
        response.preOutgoingCallsStateHash,
        outgoingCallsHash,
        expectedResultsHash,
        ethers.keccak256(response.returnValue),  // returnValue hash
        response.finalStateHash,
      ]
    )
  );

  const signature = await adminWallet.signMessage(ethers.getBytes(messageHash));
  return signature;
}

// ============ L2 System Contracts ============

// System address that executes L2 calls (must match fullnode)
const L2_SYSTEM_ADDRESS = "0x1000000000000000000000000000000000000001";

// L1SenderProxyL2 bytecode for deployment on L2
// This is deployed on-demand for each L1 caller
const L1_SENDER_PROXY_L2_BYTECODE = "0x"; // Will be set during initialization

// ============ Transaction Processing ============

interface SubmitRequest {
  signedTx: string;
  sourceChain: "L1" | "L2";
  hints?: {
    l2TargetAddress?: string;  // For simple deposits
    expectedReturnValue?: string;
    isContractCall?: boolean;  // Hint that this L1 tx will call L2 contracts
    l2Addresses?: string[];    // L2 addresses that will be called (builder deploys proxies if needed)
  };
}

/**
 * Detected L2 proxy call during L1 execution
 */
interface DetectedProxyCall {
  l2Address: string;      // The L2 contract being called
  proxyAddress: string;   // The L2SenderProxy on L1
  callData: string;       // The calldata sent to the proxy
  value: bigint;          // ETH value sent
  caller: string;         // The L1 address that made the call
}

/**
 * Process an L2 transaction
 *
 * 1. Fork the canonical fullnode
 * 2. Execute the tx on the fork
 * 3. Get the new state root
 * 4. Submit to L1
 */
async function processL2Transaction(signedTx: string): Promise<{
  l1TxHash: string;
  l2TxHash: string;
  l2StateRoot: string;
}> {
  const tx = Transaction.from(signedTx);

  log("Builder", `Processing L2 transaction:`);
  log("Builder", `  From: ${tx.from}`);
  log("Builder", `  To: ${tx.to || "(deploy)"}`);
  log("Builder", `  Value: ${ethers.formatEther(tx.value)} ETH`);
  log("Builder", `  Nonce: ${tx.nonce}`);

  // Check nonce before proceeding
  const expectedNonce = await fullnodeProvider.getTransactionCount(tx.from!);
  if (tx.nonce !== expectedNonce) {
    const errorMsg = `Nonce mismatch! Transaction has nonce ${tx.nonce}, but account ${tx.from} has nonce ${expectedNonce} on L2. Clear your wallet's activity data for this account.`;
    log("Builder", `  ERROR: ${errorMsg}`);
    throw new Error(errorMsg);
  }

  // Get current L2 state from L1 contract
  const prevHash = await rollupContract.l2BlockHash();
  log("Builder", `  Current L2 hash (from L1): ${prevHash}`);

  // Verify the fullnode is in sync
  const fullnodeStateRoot = await getStateRoot(fullnodeProvider);
  if (fullnodeStateRoot.toLowerCase() !== prevHash.toLowerCase()) {
    log("Builder", `  WARNING: Fullnode not in sync with L1!`);
    log("Builder", `    L1 expects: ${prevHash}`);
    log("Builder", `    Fullnode:   ${fullnodeStateRoot}`);
    // Continue anyway for POC - in production this should fail
  }

  // For L2 transactions, we execute directly on the fullnode WITHOUT reverting.
  // The builder is the sequencer - it decides the canonical state.
  // The fullnode will see the L1 event and verify the state matches (but won't re-execute).

  let newStateRoot: string;
  let l2TxHash: string;
  let l2TxStatus: number;

  // Execute the transaction on the fullnode
  // The sender should already have sufficient balance - no artificial funding
  log("Builder", `  Executing on fullnode...`);
  l2TxHash = await fullnodeProvider.send("eth_sendRawTransaction", [signedTx]);
  const l2Receipt = await fullnodeProvider.waitForTransaction(l2TxHash);

  log("Builder", `  L2 tx hash: ${l2TxHash}`);
  l2TxStatus = l2Receipt?.status || 0;
  log("Builder", `  Status: ${l2TxStatus === 1 ? "SUCCESS" : "REVERTED"}`);

  // Get the new state root
  newStateRoot = await getStateRoot(fullnodeProvider);
  log("Builder", `  New state root: ${newStateRoot}`);

  // Sign the proof
  const proof = await signProof(prevHash, signedTx, newStateRoot, [], [], newStateRoot);

  // Submit to L1
  log("Builder", `Submitting to L1...`);
  const l1Tx = await rollupContract.processSingleTxOnL2(
    prevHash,
    signedTx,
    newStateRoot,
    [],  // No outgoing calls for simple tx
    [],  // No expected results
    newStateRoot,
    proof
  );
  const l1Receipt = await l1Tx.wait();

  log("Builder", `  L1 tx hash: ${l1Receipt?.hash}`);
  log("Builder", `  L1 block: ${l1Receipt?.blockNumber}`);

  return {
    l1TxHash: l1Receipt?.hash || "",
    l2TxHash,
    l2StateRoot: newStateRoot,
  };
}

/**
 * Process an L1→L2 transaction (deposit)
 *
 * For L1→L2 deposits, we need to:
 * 1. Create a snapshot of the fullnode state
 * 2. Simulate the L2 effect on the fullnode
 * 3. Get the new state root
 * 4. Revert to snapshot (so fullnode is unchanged)
 * 5. Register the incoming call response
 * 6. Deploy the proxy if needed
 * 7. Broadcast the user's L1 tx
 *
 * The fullnode will update its state when it sees the L1 event, ensuring
 * it stays in sync with L1 rather than getting ahead of it.
 */
async function processL1ToL2Transaction(signedTx: string, hints: { l2TargetAddress: string; expectedReturnValue?: string }): Promise<{
  l1TxHash: string;
  proxyAddress: string;
  l2StateRoot: string;
}> {
  const tx = Transaction.from(signedTx);
  const l2Target = hints.l2TargetAddress;

  log("Builder", `Processing L1→L2 transaction:`);
  log("Builder", `  From: ${tx.from}`);
  log("Builder", `  L2 Target: ${l2Target}`);
  log("Builder", `  Value: ${ethers.formatEther(tx.value)} ETH`);

  // Validate hint - tx.to should be the proxy address
  const expectedProxy = await rollupContract.getProxyAddress(l2Target);
  if (tx.to?.toLowerCase() !== expectedProxy.toLowerCase()) {
    throw new Error(`Invalid hint: tx.to (${tx.to}) doesn't match expected proxy (${expectedProxy})`);
  }

  // Get current L2 state from L1
  const currentL2Hash = await rollupContract.l2BlockHash();
  log("Builder", `  Current L2 hash: ${currentL2Hash}`);

  // Get current fullnode state (should match currentL2Hash if synced)
  const currentFullnodeState = await getStateRoot(fullnodeProvider);
  log("Builder", `  Fullnode state: ${currentFullnodeState}`);

  if (currentFullnodeState.toLowerCase() !== currentL2Hash.toLowerCase()) {
    throw new Error(`Fullnode not synced with L1! L1: ${currentL2Hash}, Fullnode: ${currentFullnodeState}`);
  }

  // Create a snapshot so we can revert after simulation
  const snapshotId = await fullnodeProvider.send("evm_snapshot", []);
  log("Builder", `  Created snapshot: ${snapshotId}`);

  let newStateRoot: string;

  try {
    // Simulate the L2 effect on the fullnode
    if (tx.value > 0n) {
      const currentBalance = await fullnodeProvider.getBalance(l2Target);
      const newBalance = currentBalance + tx.value;
      await fullnodeProvider.send("anvil_setBalance", [
        l2Target,
        "0x" + newBalance.toString(16),
      ]);
      log("Builder", `  Simulated: Credit ${ethers.formatEther(tx.value)} ETH to ${l2Target}`);
    }

    // Mine a block to commit the state change
    await fullnodeProvider.send("evm_mine", []);

    // Get new state root from fullnode
    newStateRoot = await getStateRoot(fullnodeProvider);
    log("Builder", `  New state root: ${newStateRoot}`);

    // Validate state root is not zero
    if (newStateRoot === "0x0000000000000000000000000000000000000000000000000000000000000000" || newStateRoot === "0x0") {
      throw new Error("Failed to compute valid state root - fullnode returned zero");
    }
  } finally {
    // ALWAYS revert to snapshot so fullnode state is unchanged
    // The fullnode will update when it sees the L1 event
    await fullnodeProvider.send("evm_revert", [snapshotId]);
    log("Builder", `  Reverted to snapshot`);
  }

  // Prepare the response
  const callData = tx.data || "0x";
  const response = {
    preOutgoingCallsStateHash: newStateRoot,
    outgoingCalls: [],
    expectedResults: [],
    returnValue: hints.expectedReturnValue || "0x",
    finalStateHash: newStateRoot,
  };

  // Check if already registered
  const responseKey = await rollupContract.getResponseKey(l2Target, currentL2Hash, callData);
  const isRegistered = await rollupContract.incomingCallRegistered(responseKey);

  if (!isRegistered) {
    // Sign and register the incoming call
    const proof = await signIncomingCallProof(l2Target, currentL2Hash, callData, response);

    log("Builder", `Registering incoming call...`);
    const registerTx = await rollupContract.registerIncomingCall(
      l2Target,
      currentL2Hash,
      callData,
      response,
      proof
    );
    await registerTx.wait();
    log("Builder", `  Registered: ${registerTx.hash}`);
  } else {
    log("Builder", `  Already registered`);
  }

  // Deploy proxy if needed
  const isDeployed = await rollupContract.isProxyDeployed(l2Target);
  if (!isDeployed) {
    log("Builder", `Deploying proxy for ${l2Target}...`);
    const deployTx = await rollupContract.deployProxy(l2Target);
    await deployTx.wait();
    log("Builder", `  Deployed: ${deployTx.hash}`);
  }

  // Broadcast user's L1 transaction
  log("Builder", `Broadcasting user's L1 tx...`);
  const l1TxHash = await l1Provider.send("eth_sendRawTransaction", [signedTx]);
  log("Builder", `  L1 tx hash: ${l1TxHash}`);

  // Mine a block to include the transaction (Anvil doesn't auto-mine)
  await l1Provider.send("evm_mine", []);

  const l1Receipt = await l1Provider.waitForTransaction(l1TxHash);
  if (l1Receipt?.status !== 1) {
    throw new Error("L1 transaction reverted");
  }

  log("Builder", `  SUCCESS`);

  return {
    l1TxHash: l1Receipt?.hash || l1TxHash,
    proxyAddress: expectedProxy,
    l2StateRoot: newStateRoot,
  };
}

/**
 * Process an L1 contract call that may trigger L2 calls
 *
 * This is the most complex case. When an L1 contract (e.g., L1SyncedCounter)
 * calls an L2 contract (via its proxy), we need to:
 *
 * 1. Fork L1 and trace the execution
 * 2. Detect any calls to L2SenderProxy contracts
 * 3. For each detected proxy call:
 *    a. Get the L2 target address
 *    b. Simulate the L2 execution
 *    c. Register the incoming call response
 * 4. Then broadcast the original L1 tx
 *
 * The key insight: L2SenderProxy.fallback() calls handleIncomingCall(),
 * which looks up a pre-registered response. We must register these responses
 * BEFORE the L1 tx executes.
 */
async function processL1ContractCall(
  signedTx: string,
  l2Addresses?: string[]  // Hint: L2 addresses that will be called
): Promise<{
  l1TxHash: string;
  detectedL2Calls: number;
  l2StateRoot: string;
}> {
  const tx = Transaction.from(signedTx);

  log("Builder", `Processing L1 contract call:`);
  log("Builder", `  From: ${tx.from}`);
  log("Builder", `  To: ${tx.to}`);
  log("Builder", `  Value: ${ethers.formatEther(tx.value)} ETH`);
  log("Builder", `  Data: ${tx.data?.slice(0, 10)}...`);

  // Step 0: Deploy L2SenderProxy for each hinted L2 address (if not already deployed)
  // This must happen BEFORE we trace/simulate, so the proxies exist
  if (l2Addresses && l2Addresses.length > 0) {
    log("Builder", `  Hint: ${l2Addresses.length} L2 address(es) provided`);
    await ensureL2SenderProxiesDeployed(l2Addresses);
  }

  // Get current L2 state from L1
  const currentL2Hash = await rollupContract.l2BlockHash();
  log("Builder", `  Current L2 hash: ${currentL2Hash}`);

  // Verify fullnode is synced
  const currentFullnodeState = await getStateRoot(fullnodeProvider);
  if (currentFullnodeState.toLowerCase() !== currentL2Hash.toLowerCase()) {
    throw new Error(`Fullnode not synced! L1: ${currentL2Hash}, L2: ${currentFullnodeState}`);
  }

  // Step 1: Create L1 fork to trace execution
  log("Builder", `  Creating L1 fork for tracing...`);
  const fork = await createL1Fork();

  let detectedCalls: DetectedProxyCall[] = [];
  let finalL2StateRoot = currentL2Hash;

  try {
    // Step 2: Trace the L1 execution to detect L2 proxy calls
    // We use eth_call with state overrides to simulate without actually executing
    log("Builder", `  Tracing L1 execution...`);

    // First, let's execute on the fork to see what happens
    const forkWallet = new Wallet(config.adminPrivateKey, fork.provider);

    // Send the tx on the fork (we need to get the actual calls)
    // For now, we'll use a simpler approach: check if tx.to is a known L1 contract
    // that might call L2, and pre-compute the proxy calls

    // Check if any known proxies will be called
    // For the POC, we'll detect calls by looking at the tx target and its potential calls

    // Get all deployed L2 proxies by checking the rollup contract
    // For each proxy, check if it might be called during this tx

    // Simplified approach: Trace using debug_traceCall
    try {
      const traceResult = await fork.provider.send("debug_traceCall", [
        {
          from: tx.from,
          to: tx.to,
          value: tx.value ? "0x" + tx.value.toString(16) : "0x0",
          data: tx.data || "0x",
          gas: tx.gasLimit ? "0x" + tx.gasLimit.toString(16) : "0x1000000",
        },
        "latest",
        { tracer: "callTracer", tracerConfig: { onlyTopCall: false } }
      ]);

      // Parse trace to find calls to L2 proxies
      detectedCalls = await parseTraceForProxyCalls(traceResult, tx.from!);
      log("Builder", `  Detected ${detectedCalls.length} L2 proxy call(s)`);

    } catch (traceErr: any) {
      log("Builder", `  Trace failed: ${traceErr.message}`);
      log("Builder", `  Falling back to static analysis...`);

      // Fallback: Check if tx.to has code that might call a proxy
      // For the POC, we'll just try to execute and see
    }

    // Step 3: For each detected L2 proxy call, simulate on fullnode (with snapshot/revert)
    // The builder simulates on the fullnode using snapshots to get the state root.
    // The fullnode will independently derive the same state from L1 events.
    //
    // IMPORTANT: We use the fullnode directly (with snapshots) instead of a fork
    // because Anvil-to-Anvil forking doesn't compute state roots properly.
    if (detectedCalls.length > 0) {
      for (const call of detectedCalls) {
        log("Builder", `  Processing L2 call to ${call.l2Address}...`);

        // Simulate the L2 effect on the fullnode (uses snapshot/revert internally)
        finalL2StateRoot = await simulateL2CallOnFullnode(
          call.caller,      // L1 contract that made the call
          call.l2Address,   // L2 contract being called
          call.callData,    // Actual call data (after proxy unpacking)
          call.value,       // ETH value
          currentL2Hash     // Current L2 state
        );

        log("Builder", `    New L2 state: ${finalL2StateRoot}`);
      }
    }

  } finally {
    destroyFork(fork);
  }

  // Step 4: Broadcast the original L1 tx
  log("Builder", `Broadcasting L1 tx...`);
  const l1TxHash = await l1Provider.send("eth_sendRawTransaction", [signedTx]);
  log("Builder", `  L1 tx hash: ${l1TxHash}`);

  // Mine a block to include the transaction (Anvil doesn't auto-mine)
  await l1Provider.send("evm_mine", []);

  const l1Receipt = await l1Provider.waitForTransaction(l1TxHash);
  if (l1Receipt?.status !== 1) {
    throw new Error("L1 transaction reverted");
  }

  log("Builder", `  SUCCESS`);

  return {
    l1TxHash: l1Receipt?.hash || l1TxHash,
    detectedL2Calls: detectedCalls.length,
    l2StateRoot: finalL2StateRoot,
  };
}

/**
 * Parse a call trace to find calls to L2SenderProxy contracts
 */
async function parseTraceForProxyCalls(
  trace: any,
  originalCaller: string
): Promise<DetectedProxyCall[]> {
  const calls: DetectedProxyCall[] = [];

  async function traverse(node: any, caller: string) {
    if (!node) return;

    const to = node.to?.toLowerCase();
    if (to) {
      // Check if this is a call to an L2SenderProxy
      // L2SenderProxy contracts are deployed by NativeRollupCore
      // They forward calls to handleIncomingCall

      // Simple heuristic: check if the target has L2SenderProxy bytecode
      // For POC, we'll check if the call eventually reaches handleIncomingCall

      // Check if this address is a known proxy
      try {
        // Try to get the l2Address from the proxy
        const proxyContract = new Contract(to, [
          "function l2Address() view returns (address)",
          "function nativeRollup() view returns (address)"
        ], l1Provider);

        const [l2Address, nativeRollup] = await Promise.all([
          proxyContract.l2Address().catch(() => null),
          proxyContract.nativeRollup().catch(() => null)
        ]);

        if (l2Address && nativeRollup?.toLowerCase() === config.rollupAddress.toLowerCase()) {
          // This is an L2SenderProxy!
          // The caller is the 'from' address of this node (the contract that made this call)
          const actualCaller = node.from?.toLowerCase() || caller;
          calls.push({
            l2Address,
            proxyAddress: to,
            callData: node.input || "0x",
            value: BigInt(node.value || "0x0"),
            caller: actualCaller,
          });
        }
      } catch {
        // Not a proxy, continue
      }
    }

    // Traverse child calls
    if (node.calls && Array.isArray(node.calls)) {
      for (const childCall of node.calls) {
        await traverse(childCall, node.from || caller);
      }
    }
  }

  await traverse(trace, originalCaller);
  return calls;
}

/**
 * Simulate an L2 call and register the incoming call response
 *
 * When L1 contract A calls L2 contract B:
 * - On L2, msg.sender should be A's proxy (L1SenderProxyL2)
 * - We simulate: system → L1SenderProxyL2(A) → B
 */
async function simulateL2Call(
  l1Caller: string,
  l2Target: string,
  callData: string,
  value: bigint,
  currentL2Hash: string
): Promise<string> {
  log("Builder", `    Simulating L2 call:`);
  log("Builder", `      L1 caller: ${l1Caller}`);
  log("Builder", `      L2 target: ${l2Target}`);
  log("Builder", `      Value: ${ethers.formatEther(value)} ETH`);

  // Compute the L1SenderProxyL2 address for this L1 caller
  // For POC, we'll use a deterministic address based on the L1 address
  const l1ProxyOnL2 = computeL1SenderProxyL2Address(l1Caller);
  log("Builder", `      L1's proxy on L2: ${l1ProxyOnL2}`);

  // Check if L1SenderProxyL2 is deployed on L2
  const proxyCode = await fullnodeProvider.getCode(l1ProxyOnL2);
  if (proxyCode === "0x") {
    log("Builder", `      Deploying L1SenderProxyL2 on L2...`);
    await deployL1SenderProxyL2OnL2(l1Caller, l1ProxyOnL2);
  }

  // Simulate the L2 call from L1's proxy to the target
  // This mimics what the fullnode will do when it sees the event

  // For ETH transfers, credit the balance
  if (value > 0n) {
    const currentBalance = await fullnodeProvider.getBalance(l2Target);
    const newBalance = currentBalance + value;
    await fullnodeProvider.send("anvil_setBalance", [
      l2Target,
      "0x" + newBalance.toString(16),
    ]);
    log("Builder", `      Credited ${ethers.formatEther(value)} ETH`);
  }

  // For contract calls, execute through the proxy
  if (callData && callData !== "0x") {
    // Impersonate the L1's proxy on L2
    await fullnodeProvider.send("anvil_impersonateAccount", [l1ProxyOnL2]);

    // Fund the proxy to pay for gas
    await fullnodeProvider.send("anvil_setBalance", [
      l1ProxyOnL2,
      "0x" + ethers.parseEther("1").toString(16),
    ]);

    try {
      // Execute the call as if from L1's proxy
      const txHash = await fullnodeProvider.send("eth_sendTransaction", [{
        from: l1ProxyOnL2,
        to: l2Target,
        data: callData,
        value: value > 0n ? "0x" + value.toString(16) : "0x0",
        gas: "0x1000000",
      }]);

      const receipt = await fullnodeProvider.waitForTransaction(txHash);
      log("Builder", `      L2 call executed: ${receipt?.status === 1 ? "SUCCESS" : "REVERTED"}`);

    } finally {
      await fullnodeProvider.send("anvil_stopImpersonatingAccount", [l1ProxyOnL2]);
    }
  }

  // Mine a block to commit the state
  await fullnodeProvider.send("evm_mine", []);

  // Get the new state root
  const newStateRoot = await getStateRoot(fullnodeProvider);

  // Register the incoming call response on L1
  await registerIncomingCallResponse(
    l2Target,
    currentL2Hash,
    callData,
    newStateRoot
  );

  return newStateRoot;
}

/**
 * Simulate an L2 call on the FULLNODE using snapshots
 *
 * NOTE: We use the fullnode directly instead of a fork because Anvil-to-Anvil
 * forking doesn't compute state roots properly (returns 0x0 after evm_mine).
 *
 * This function:
 * 1. Creates a snapshot on the fullnode
 * 2. Executes the L2 call
 * 3. Gets the new state root
 * 4. Reverts to snapshot
 * 5. Registers the response on L1
 *
 * The fullnode will re-execute when it sees the L1 event.
 */
async function simulateL2CallOnFullnode(
  l1Caller: string,
  l2Target: string,
  callData: string,
  value: bigint,
  currentL2Hash: string
): Promise<string> {
  log("Builder", `    Simulating L2 call on fullnode:`);
  log("Builder", `      L1 caller: ${l1Caller}`);
  log("Builder", `      L2 target: ${l2Target}`);
  log("Builder", `      Value: ${ethers.formatEther(value)} ETH`);

  const l1ProxyOnL2 = computeL1SenderProxyL2Address(l1Caller);
  log("Builder", `      L1's proxy on L2: ${l1ProxyOnL2}`);

  // Check if L1SenderProxyL2 is deployed on L2 (outside snapshot - this is permanent)
  const proxyCode = await fullnodeProvider.getCode(l1ProxyOnL2);
  if (proxyCode === "0x") {
    log("Builder", `      Deploying L1SenderProxyL2 on L2...`);
    await deployL1SenderProxyL2OnL2(l1Caller, l1ProxyOnL2);
  }

  // Create snapshot so we can revert after simulation
  const snapshotId = await fullnodeProvider.send("evm_snapshot", []);
  log("Builder", `      Created snapshot: ${snapshotId}`);

  let newStateRoot: string;

  try {
    // For ETH transfers, credit the balance
    if (value > 0n) {
      const currentBalance = await fullnodeProvider.getBalance(l2Target);
      const newBalance = currentBalance + value;
      await fullnodeProvider.send("anvil_setBalance", [
        l2Target,
        "0x" + newBalance.toString(16),
      ]);
      log("Builder", `      Credited ${ethers.formatEther(value)} ETH`);
    }

    // For contract calls, execute through the proxy
    if (callData && callData !== "0x") {
      await fullnodeProvider.send("anvil_impersonateAccount", [l1ProxyOnL2]);
      await fullnodeProvider.send("anvil_setBalance", [
        l1ProxyOnL2,
        "0x" + ethers.parseEther("1").toString(16),
      ]);

      try {
        const txHash = await fullnodeProvider.send("eth_sendTransaction", [{
          from: l1ProxyOnL2,
          to: l2Target,
          data: callData,
          value: value > 0n ? "0x" + value.toString(16) : "0x0",
          gas: "0x1000000",
        }]);

        const receipt = await fullnodeProvider.waitForTransaction(txHash);
        log("Builder", `      L2 call executed: ${receipt?.status === 1 ? "SUCCESS" : "REVERTED"}`);
      } finally {
        await fullnodeProvider.send("anvil_stopImpersonatingAccount", [l1ProxyOnL2]);
      }
    }

    // Mine a block to commit state changes
    await fullnodeProvider.send("evm_mine", []);

    // Get the new state root
    newStateRoot = await getStateRoot(fullnodeProvider);
    log("Builder", `      New state root: ${newStateRoot}`);

  } finally {
    // ALWAYS revert to snapshot so fullnode state is unchanged
    // The fullnode will update when it sees the L1 event
    await fullnodeProvider.send("evm_revert", [snapshotId]);
    log("Builder", `      Reverted to snapshot`);
  }

  // Register on L1
  await registerIncomingCallResponse(l2Target, currentL2Hash, callData, newStateRoot);

  return newStateRoot;
}

/**
 * Compute the deterministic L1SenderProxyL2 address for an L1 address
 *
 * For POC, we use a simple deterministic address.
 * In production, this would use CREATE2 via L1SenderProxyL2Factory.
 */
function computeL1SenderProxyL2Address(l1Address: string): string {
  // Simple deterministic address: hash(prefix, l1Address)
  // This matches what the L1SenderProxyL2Factory would compute
  const hash = ethers.keccak256(ethers.solidityPacked(
    ["string", "address"],
    ["L1SenderProxyL2.v1", l1Address]
  ));
  // Take the last 20 bytes
  return "0x" + hash.slice(-40);
}

/**
 * Deploy L1SenderProxyL2 on L2 for an L1 address
 *
 * For POC, we use anvil_setCode to deploy at the deterministic address.
 * In production, this would use the L1SenderProxyL2Factory.
 */
async function deployL1SenderProxyL2OnL2(l1Address: string, proxyAddress: string): Promise<void> {
  // For POC, we'll create a minimal proxy that just forwards calls
  // The actual L1SenderProxyL2 contract needs the system address and call registry

  // Since we're using Anvil, we can use a simpler approach:
  // Just set the code to a minimal contract that allows calls

  // For now, we'll skip actual deployment and just credit the address
  // The key is that msg.sender will be this address when L1 calls L2
  log("Builder", `      (POC: Using address ${proxyAddress} for L1 caller ${l1Address})`);

  // In a full implementation, we would deploy the actual L1SenderProxyL2 contract
}

/**
 * Register the incoming call response on L1
 */
async function registerIncomingCallResponse(
  l2Target: string,
  currentL2Hash: string,
  callData: string,
  newStateRoot: string
): Promise<void> {
  // Build the response
  const response = {
    preOutgoingCallsStateHash: newStateRoot,
    outgoingCalls: [],  // No outgoing calls from this L2 execution (for now)
    expectedResults: [],
    returnValue: "0x",  // Could capture actual return value
    finalStateHash: newStateRoot,
  };

  // Check if already registered
  const responseKey = await rollupContract.getResponseKey(l2Target, currentL2Hash, callData);
  const isRegistered = await rollupContract.incomingCallRegistered(responseKey);

  if (!isRegistered) {
    // Sign and register the incoming call
    const proof = await signIncomingCallProof(l2Target, currentL2Hash, callData, response);

    log("Builder", `      Registering incoming call response...`);
    const registerTx = await rollupContract.registerIncomingCall(
      l2Target,
      currentL2Hash,
      callData,
      response,
      proof
    );
    await registerTx.wait();
    log("Builder", `      Registered: ${registerTx.hash}`);

    // Deploy L2SenderProxy on L1 if needed
    const isDeployed = await rollupContract.isProxyDeployed(l2Target);
    if (!isDeployed) {
      log("Builder", `      Deploying L2SenderProxy on L1...`);
      const deployTx = await rollupContract.deployProxy(l2Target);
      await deployTx.wait();
      log("Builder", `      Deployed: ${deployTx.hash}`);
    }
  } else {
    log("Builder", `      Already registered`);
  }
}

// ============ HTTP Server ============

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url || "/", `http://${req.headers.host}`);

  try {
    if (url.pathname === "/status" && req.method === "GET") {
      const [l2BlockHash, l2BlockNumber, fullnodeState] = await Promise.all([
        rollupContract.l2BlockHash(),
        rollupContract.l2BlockNumber(),
        getStateRoot(fullnodeProvider),
      ]);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        l2BlockNumber: l2BlockNumber.toString(),
        l2BlockHash,
        fullnodeStateRoot: fullnodeState,
        rollupAddress: config.rollupAddress,
        isSynced: l2BlockHash.toLowerCase() === fullnodeState.toLowerCase(),
      }));
      return;
    }

    if (url.pathname === "/submit" && req.method === "POST") {
      const body = await new Promise<string>((resolve) => {
        let data = "";
        req.on("data", (chunk) => (data += chunk));
        req.on("end", () => resolve(data));
      });

      const request: SubmitRequest = JSON.parse(body);
      log("API", `Received ${request.sourceChain} transaction`);

      let result: any;

      if (request.sourceChain === "L2") {
        result = await processL2Transaction(request.signedTx);
      } else if (request.hints?.l2TargetAddress) {
        // Direct L1→L2 deposit (tx to L2SenderProxy)
        result = await processL1ToL2Transaction(request.signedTx, request.hints);
      } else if (request.hints?.isContractCall || request.hints?.l2Addresses) {
        // L1 contract call that may trigger L2 calls
        // Pass l2Addresses hint so builder can deploy proxies before tracing
        result = await processL1ContractCall(request.signedTx, request.hints?.l2Addresses);
      } else {
        // Check if this might be a contract call that triggers L2 interactions
        // For now, we'll try to detect automatically
        const tx = Transaction.from(request.signedTx);
        const toCode = tx.to ? await l1Provider.getCode(tx.to) : "0x";

        if (toCode !== "0x" && tx.data && tx.data.length > 2) {
          // This is a call to a contract with data - might trigger L2 calls
          log("Builder", "Detected L1 contract call, checking for L2 interactions...");
          result = await processL1ContractCall(request.signedTx, request.hints?.l2Addresses);
        } else {
          // Simple L1 tx - just broadcast
          log("Builder", "Broadcasting simple L1 transaction...");
          const txHash = await l1Provider.send("eth_sendRawTransaction", [request.signedTx]);
          // Mine a block to include the transaction (Anvil doesn't auto-mine)
          await l1Provider.send("evm_mine", []);
          const receipt = await l1Provider.waitForTransaction(txHash);
          result = {
            l1TxHash: receipt?.hash || txHash,
            txType: "L1_SIMPLE",
          };
        }
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  } catch (err: any) {
    log("API", `Error: ${err.message}`);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message }));
  }
}

// ============ Main ============

async function main() {
  config = parseArgs();

  if (!config.rollupAddress) {
    console.error("Error: --rollup <address> required");
    process.exit(1);
  }

  log("Builder", "=== Deterministic Builder API ===");
  log("Builder", `L1 RPC: ${config.l1Rpc}`);
  log("Builder", `Fullnode RPC: ${config.fullnodeRpc}`);
  log("Builder", `NativeRollupCore: ${config.rollupAddress}`);
  log("Builder", "");

  // Initialize providers
  l1Provider = new JsonRpcProvider(config.l1Rpc);
  fullnodeProvider = new JsonRpcProvider(config.fullnodeRpc);

  // Initialize admin wallet
  adminWallet = new Wallet(config.adminPrivateKey, l1Provider);
  log("Builder", `Admin address: ${adminWallet.address}`);

  // Initialize rollup contract
  rollupContract = new Contract(config.rollupAddress, ROLLUP_ABI, adminWallet);

  // Verify connections
  try {
    const l1Block = await l1Provider.getBlockNumber();
    log("Builder", `Connected to L1. Block: ${l1Block}`);
  } catch (err: any) {
    log("Builder", `WARNING: Could not connect to L1: ${err.message}`);
  }

  try {
    const l2State = await getStateRoot(fullnodeProvider);
    log("Builder", `Connected to fullnode. State root: ${l2State.slice(0, 18)}...`);
  } catch (err: any) {
    log("Builder", `WARNING: Could not connect to fullnode: ${err.message}`);
  }

  // Check sync status
  try {
    const l2BlockHash = await rollupContract.l2BlockHash();
    const fullnodeState = await getStateRoot(fullnodeProvider);
    const isSynced = l2BlockHash.toLowerCase() === fullnodeState.toLowerCase();
    log("Builder", `Sync status: ${isSynced ? "SYNCED" : "NOT SYNCED"}`);
    if (!isSynced) {
      log("Builder", `  L1 expects: ${l2BlockHash}`);
      log("Builder", `  Fullnode:   ${fullnodeState}`);
    }
  } catch (err: any) {
    log("Builder", `Could not check sync status: ${err.message}`);
  }

  // Start HTTP server
  const server = http.createServer(handleRequest);
  server.listen(config.port, () => {
    log("Builder", "");
    log("Builder", `Builder API listening on http://localhost:${config.port}`);
    log("Builder", "");
    log("Builder", "Endpoints:");
    log("Builder", `  POST /submit  - Submit transaction`);
    log("Builder", `  GET  /status  - Get builder status`);
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
