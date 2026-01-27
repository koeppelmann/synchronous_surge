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
 * 5. Builder submits to L1: processCallOnL2(rawTx, newStateRoot, proof)
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
  "function processCallOnL2(bytes32 prevL2BlockHash, bytes calldata callData, bytes32 postExecutionStateHash, tuple(address from, address target, uint256 value, uint256 gas, bytes data, bytes32 postCallStateHash)[] outgoingCalls, bytes[] expectedResults, bytes32 finalStateHash, bytes proof) payable",
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
  return block?.stateRoot || "0x0";
}

// ============ Fork Management ============

interface ForkInstance {
  provider: JsonRpcProvider;
  process: ChildProcess;
  port: number;
}

let forkCounter = 0;

/**
 * Create a fork of the canonical fullnode state
 */
async function createFork(): Promise<ForkInstance> {
  const forkPort = 19000 + (forkCounter++ % 100);
  const forkRpc = `http://localhost:${forkPort}`;

  log("Builder", `Creating fork on port ${forkPort}...`);

  const anvilProcess = spawn("anvil", [
    "--fork-url", config.fullnodeRpc,
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

// ============ Proof Signing ============

async function signProof(
  prevHash: string,
  callData: string,
  postExecutionStateHash: string,
  outgoingCalls: any[],
  expectedResults: string[],
  finalStateHash: string
): Promise<string> {
  // For POC, admin signs a simple hash of all parameters
  const messageHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "bytes", "bytes32", "bytes32", "bytes32"],
      [
        prevHash,
        callData,
        postExecutionStateHash,
        ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
          ["tuple(address,address,uint256,uint256,bytes,bytes32)[]"],
          [outgoingCalls.map(c => [c.from, c.target, c.value, c.gas, c.data, c.postCallStateHash])]
        )),
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

// ============ Transaction Processing ============

interface SubmitRequest {
  signedTx: string;
  sourceChain: "L1" | "L2";
  hints?: {
    l2TargetAddress: string;
    expectedReturnValue?: string;
  };
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

  // Create a fork of the fullnode
  const fork = await createFork();

  try {
    // Fund the sender on the fork (so they can pay for gas)
    await fork.provider.send("anvil_setBalance", [
      tx.from,
      "0x" + ethers.parseEther("100").toString(16),
    ]);

    // Execute the transaction on the fork
    log("Builder", `  Executing on fork...`);
    const l2TxHash = await fork.provider.send("eth_sendRawTransaction", [signedTx]);
    const l2Receipt = await fork.provider.waitForTransaction(l2TxHash);

    log("Builder", `  L2 tx hash: ${l2TxHash}`);
    log("Builder", `  Status: ${l2Receipt?.status === 1 ? "SUCCESS" : "REVERTED"}`);

    // Get the new state root from the fork
    const newStateRoot = await getStateRoot(fork.provider);
    log("Builder", `  New state root: ${newStateRoot}`);

    // Sign the proof
    const proof = await signProof(prevHash, signedTx, newStateRoot, [], [], newStateRoot);

    // Submit to L1
    log("Builder", `Submitting to L1...`);
    const l1Tx = await rollupContract.processCallOnL2(
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
  } finally {
    // Clean up the fork
    destroyFork(fork);
  }
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
        result = await processL1ToL2Transaction(request.signedTx, request.hints);
      } else {
        // Simple L1 tx - just broadcast
        log("Builder", "Broadcasting simple L1 transaction...");
        const txHash = await l1Provider.send("eth_sendRawTransaction", [request.signedTx]);
        const receipt = await l1Provider.waitForTransaction(txHash);
        result = {
          l1TxHash: receipt?.hash || txHash,
          txType: "L1_SIMPLE",
        };
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
