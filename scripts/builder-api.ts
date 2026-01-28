/**
 * Builder API Server
 *
 * Receives signed transactions from users and processes them appropriately:
 * - Simple L1 transactions: Forward to L1 node
 * - L1→L2 transactions (with hints): Deploy proxy, register response, broadcast
 * - L2 transactions: Encode as L2 calldata and submit via processCallOnL2
 *
 * Usage:
 *   npx tsx scripts/builder-api.ts [options]
 *
 * Options:
 *   --port <port>       API port (default: 3200)
 *   --l1-rpc <url>      L1 RPC URL (default: http://localhost:8545)
 *   --l2-rpc <url>      L2 Builder RPC URL (default: http://localhost:9547)
 *   --l2-fullnode <url> L2 Fullnode RPC URL (default: http://localhost:9546)
 *   --rollup <addr>     NativeRollupCore address
 *   --admin-key <key>   Admin private key for signing proofs
 */

import {
  ethers,
  JsonRpcProvider,
  Wallet,
  Contract,
  AbiCoder,
  keccak256,
  Transaction,
} from "ethers";
import * as http from "http";
import * as fs from "fs";
import * as path from "path";

// ============ Configuration ============

interface Config {
  port: number;
  l1Rpc: string;
  l2BuilderRpc: string;
  l2FullnodeRpc: string;
  rollupAddress: string;
  adminPrivateKey: string;
}

function parseArgs(): Config {
  const args = process.argv.slice(2);
  const config: Config = {
    port: 3200,
    l1Rpc: "http://localhost:8545",
    l2BuilderRpc: "http://localhost:9547",
    l2FullnodeRpc: "http://localhost:9546",
    rollupAddress: "",
    adminPrivateKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", // Anvil default
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--port":
        config.port = parseInt(args[++i]);
        break;
      case "--l1-rpc":
        config.l1Rpc = args[++i];
        break;
      case "--l2-rpc":
        config.l2BuilderRpc = args[++i];
        break;
      case "--l2-fullnode":
        config.l2FullnodeRpc = args[++i];
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
let l2BuilderProvider: JsonRpcProvider;
let l2FullnodeProvider: JsonRpcProvider;
let adminWallet: Wallet;
let rollupContract: Contract;
let config: Config;

const ROLLUP_ABI = [
  "function l2BlockHash() view returns (bytes32)",
  "function l2BlockNumber() view returns (uint256)",
  "function getProxyAddress(address l2Address) view returns (address)",
  "function isProxyDeployed(address l2Address) view returns (bool)",
  "function deployProxy(address l2Address) returns (address)",
  "function registerIncomingCall(address l2Address, bytes32 stateHash, bytes calldata callData, tuple(bytes32 preOutgoingCallsStateHash, tuple(address from, address target, uint256 value, uint256 gas, bytes data, bytes32 postCallStateHash)[] outgoingCalls, bytes[] expectedResults, bytes returnValue, bytes32 finalStateHash) response, bytes proof)",
  "function processSingleTxOnL2(bytes32 prevL2BlockHash, bytes calldata rlpEncodedTx, bytes32 preOutgoingCallsStateHash, tuple(address from, address target, uint256 value, uint256 gas, bytes data, bytes32 postCallStateHash)[] outgoingCalls, bytes[] expectedResults, bytes32 finalStateHash, bytes proof) payable",
  "function getResponseKey(address l2Address, bytes32 stateHash, bytes calldata callData) view returns (bytes32)",
  "function incomingCallRegistered(bytes32 responseKey) view returns (bool)",
];

// ============ Logging ============

function log(component: string, message: string) {
  const timestamp = new Date().toISOString().split("T")[1].split(".")[0];
  console.log(`[${timestamp}] [${component}] ${message}`);
}

// ============ Hints Interface ============

interface L1ToL2TransactionHints {
  l2TargetAddress: string;
  expectedReturnValue?: string;
  description?: string;
}

interface SubmitRequest {
  signedTx: string;
  hints?: L1ToL2TransactionHints;
  sourceChain: "L1" | "L2";
}

// ============ Proof Signing ============

async function signIncomingCallProof(
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
  let outgoingCallsEncoded = "0x";
  for (const c of response.outgoingCalls) {
    outgoingCallsEncoded = ethers.solidityPacked(
      ["bytes", "address", "address", "uint256", "uint256", "bytes32", "bytes32"],
      [outgoingCallsEncoded, c.from, c.target, c.value, c.gas, keccak256(c.data), c.postCallStateHash]
    );
  }
  const outgoingCallsHash = keccak256(outgoingCallsEncoded);

  let resultsEncoded = "0x";
  for (const r of response.expectedResults) {
    resultsEncoded = ethers.solidityPacked(["bytes", "bytes32"], [resultsEncoded, keccak256(r)]);
  }
  const resultsHash = keccak256(resultsEncoded);

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

  return await adminWallet.signMessage(ethers.getBytes(messageHash));
}

async function signL2TransactionProof(
  prevHash: string,
  callData: string,
  postExecutionState: string,
  outgoingCalls: any[],
  expectedResults: string[],
  finalState: string
): Promise<string> {
  let outgoingCallsEncoded = "0x";
  for (const c of outgoingCalls) {
    outgoingCallsEncoded = ethers.solidityPacked(
      ["bytes", "address", "address", "uint256", "uint256", "bytes32", "bytes32"],
      [outgoingCallsEncoded, c.from, c.target, c.value, c.gas, keccak256(c.data), c.postCallStateHash]
    );
  }
  const outgoingCallsHash = keccak256(outgoingCallsEncoded);

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

// ============ Transaction Processing ============

/**
 * Check if an address is a proxy for an L2 address
 */
async function isProxyAddress(address: string): Promise<string | null> {
  // This is a simplified check - in production you'd need a registry or pattern matching
  // For now, we rely on hints
  return null;
}

/**
 * Process a simple L1 transaction (no L2 involvement)
 */
async function processSimpleL1Transaction(signedTx: string): Promise<{
  l1TxHash: string;
  txType: string;
  gasUsed: string;
  blockNumber: string;
}> {
  log("Builder", "Processing simple L1 transaction...");

  const tx = Transaction.from(signedTx);
  log("Builder", `  From: ${tx.from}`);
  log("Builder", `  To: ${tx.to}`);
  log("Builder", `  Value: ${ethers.formatEther(tx.value)} ETH`);

  const l1TxHash = await l1Provider.send("eth_sendRawTransaction", [signedTx]);
  const receipt = await l1Provider.waitForTransaction(l1TxHash);

  log("Builder", `L1 tx: ${receipt?.hash} (${receipt?.status === 1 ? "SUCCESS" : "REVERTED"})`);

  return {
    l1TxHash: receipt?.hash || l1TxHash,
    txType: "L1_SIMPLE",
    gasUsed: receipt?.gasUsed?.toString() || "0",
    blockNumber: receipt?.blockNumber?.toString() || "0",
  };
}

/**
 * Process an L1→L2 transaction (with hints)
 */
async function processL1ToL2Transaction(
  signedTx: string,
  hints: L1ToL2TransactionHints
): Promise<{
  l1TxHash: string;
  proxyAddress: string;
  l2StateRoot: string;
}> {
  const tx = Transaction.from(signedTx);
  const l2Target = hints.l2TargetAddress;

  log("Builder", `Processing L1→L2 tx to ${l2Target}`);
  log("Builder", `  From: ${tx.from}`);
  log("Builder", `  Value: ${ethers.formatEther(tx.value)} ETH`);

  // Validate hint
  const expectedProxy = await rollupContract.getProxyAddress(l2Target);
  if (tx.to?.toLowerCase() !== expectedProxy.toLowerCase()) {
    throw new Error(`Invalid hint: tx.to (${tx.to}) doesn't match expected proxy (${expectedProxy})`);
  }
  log("Builder", `  ✓ Hint validated`);

  // Get current L2 state
  const currentL2Hash = await rollupContract.l2BlockHash();
  log("Builder", `  Current L2 hash: ${currentL2Hash}`);

  // Simulate L2 effect
  log("Builder", `Simulating L2 effect...`);
  if (tx.value > 0n) {
    const currentBalance = await l2BuilderProvider.getBalance(l2Target);
    const newBalance = currentBalance + tx.value;
    await l2BuilderProvider.send("anvil_setBalance", [
      l2Target,
      "0x" + newBalance.toString(16),
    ]);
    log("Builder", `  Credited ${ethers.formatEther(tx.value)} ETH to ${l2Target}`);
  }

  // TODO: Execute contract call if tx.data is not empty

  await l2BuilderProvider.send("evm_mine", []);
  const l2Block = await l2BuilderProvider.getBlock("latest");
  const newL2StateRoot = l2Block?.stateRoot!;
  log("Builder", `  New L2 state root: ${newL2StateRoot}`);

  // Prepare response
  const callData = tx.data || "0x";
  const response = {
    preOutgoingCallsStateHash: newL2StateRoot,
    outgoingCalls: [],
    expectedResults: [],
    returnValue: hints.expectedReturnValue || "0x",
    finalStateHash: newL2StateRoot,
  };

  // Check if incoming call is already registered (from a previous failed attempt)
  const responseKey = await rollupContract.getResponseKey(l2Target, currentL2Hash, callData);
  const isAlreadyRegistered = await rollupContract.incomingCallRegistered(responseKey);

  let registerTxHash = "already-registered";

  if (isAlreadyRegistered) {
    log("Builder", `Incoming call already registered (key: ${responseKey})`);
    log("Builder", `  Skipping registration, proceeding with broadcast`);
  } else {
    // Sign proof
    const proof = await signIncomingCallProof(l2Target, currentL2Hash, callData, response);

    // Register incoming call
    log("Builder", `Registering incoming call response...`);
    const registerTx = await rollupContract.registerIncomingCall(
      l2Target,
      currentL2Hash,
      callData,
      response,
      proof
    );
    await registerTx.wait();
    log("Builder", `  Registered: ${registerTx.hash}`);
    registerTxHash = registerTx.hash;
  }

  // Deploy proxy if needed
  const isDeployed = await rollupContract.isProxyDeployed(l2Target);
  if (!isDeployed) {
    log("Builder", `Deploying proxy...`);
    const deployTx = await rollupContract.deployProxy(l2Target);
    await deployTx.wait();
    log("Builder", `  Deployed: ${deployTx.hash}`);
  }

  // Broadcast user's transaction
  log("Builder", `Broadcasting user's L1 tx...`);
  log("Builder", `  User tx to: ${tx.to}`);
  log("Builder", `  User tx value: ${ethers.formatEther(tx.value)} ETH`);
  log("Builder", `  User tx from: ${tx.from}`);

  let l1TxHash: string;
  try {
    l1TxHash = await l1Provider.send("eth_sendRawTransaction", [signedTx]);
  } catch (sendErr: any) {
    log("Builder", `  Failed to send raw tx: ${sendErr.message}`);
    throw new Error(`Failed to broadcast L1 tx: ${sendErr.message}`);
  }

  log("Builder", `  L1 tx hash: ${l1TxHash}`);
  const receipt = await l1Provider.waitForTransaction(l1TxHash);
  log("Builder", `  L1 tx: ${receipt?.hash} (${receipt?.status === 1 ? "SUCCESS" : "REVERTED"})`);

  if (receipt?.status !== 1) {
    // Try to get revert reason
    log("Builder", `  Gas used: ${receipt?.gasUsed}`);
    log("Builder", `  Block: ${receipt?.blockNumber}`);

    // Try to simulate the call to get revert reason
    try {
      await l1Provider.call({
        to: tx.to,
        from: tx.from,
        value: tx.value,
        data: tx.data,
      });
    } catch (simErr: any) {
      log("Builder", `  Revert reason: ${simErr.message}`);
    }

    throw new Error(`L1 transaction reverted`);
  }

  // Sync fullnode
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

  // Get L2 block number
  const l2BlockNumber = await rollupContract.l2BlockNumber();

  return {
    l1TxHash: receipt?.hash || l1TxHash,
    proxyAddress: expectedProxy,
    l2StateRoot: newL2StateRoot,
    l2BlockNumber: l2BlockNumber.toString(),
    l2Target: l2Target,
    txType: "L1_TO_L2",
    gasUsed: receipt?.gasUsed?.toString() || "0",
    blockNumber: receipt?.blockNumber?.toString() || "0",
    registerTxHash: registerTxHash,
  };
}

/**
 * Process an L2 transaction (wrap in processCallOnL2)
 */
async function processL2Transaction(signedTx: string): Promise<{
  l1TxHash: string;
  l2StateRoot: string;
}> {
  const tx = Transaction.from(signedTx);

  log("Builder", `Processing L2 tx`);
  log("Builder", `  From: ${tx.from}`);
  log("Builder", `  To: ${tx.to || "(deploy)"}`);
  log("Builder", `  Value: ${ethers.formatEther(tx.value)} ETH`);

  // Get current L2 state
  const prevHash = await rollupContract.l2BlockHash();
  log("Builder", `  Current L2 hash: ${prevHash}`);

  // Fund sender on builder L2
  await l2BuilderProvider.send("anvil_setBalance", [
    tx.from,
    "0x" + ethers.parseEther("100").toString(16),
  ]);

  // Execute on builder L2
  const l2TxHash = await l2BuilderProvider.send("eth_sendRawTransaction", [signedTx]);
  const l2Receipt = await l2BuilderProvider.waitForTransaction(l2TxHash);
  log("Builder", `  L2 exec: ${l2Receipt?.status === 1 ? "SUCCESS" : "REVERTED"}`);

  // Get new state root
  const l2Block = await l2BuilderProvider.getBlock("latest");
  const newStateRoot = l2Block?.stateRoot!;
  log("Builder", `  New L2 state root: ${newStateRoot}`);

  // Sign proof
  const proof = await signL2TransactionProof(prevHash, signedTx, newStateRoot, [], [], newStateRoot);

  // Submit to L1
  log("Builder", `Submitting to L1...`);
  const l1Tx = await rollupContract.processSingleTxOnL2(
    prevHash,
    signedTx,
    newStateRoot,
    [],
    [],
    newStateRoot,
    proof
  );
  const l1Receipt = await l1Tx.wait();
  log("Builder", `  L1 tx: ${l1Receipt?.hash}`);

  // Sync fullnode
  log("Builder", `Syncing fullnode...`);
  await l2FullnodeProvider.send("anvil_setBalance", [
    tx.from,
    "0x" + ethers.parseEther("100").toString(16),
  ]);
  await l2FullnodeProvider.send("eth_sendRawTransaction", [signedTx]);

  // Get L2 block number
  const l2BlockNumber = await rollupContract.l2BlockNumber();

  return {
    l1TxHash: l1Receipt?.hash || "",
    l2StateRoot: newStateRoot,
    l2BlockNumber: l2BlockNumber.toString(),
    l2TxHash: l2TxHash,
    txType: "L2_TRANSACTION",
    gasUsed: l1Receipt?.gasUsed?.toString() || "0",
    blockNumber: l1Receipt?.blockNumber?.toString() || "0",
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
    if (url.pathname === "/submit" && req.method === "POST") {
      // Read body
      const body = await new Promise<string>((resolve) => {
        let data = "";
        req.on("data", (chunk) => (data += chunk));
        req.on("end", () => resolve(data));
      });

      const request: SubmitRequest = JSON.parse(body);
      log("API", `Received ${request.sourceChain} transaction`);

      let result: any;

      if (request.sourceChain === "L2") {
        // L2 transaction - wrap in processCallOnL2
        result = await processL2Transaction(request.signedTx);
      } else if (request.hints?.l2TargetAddress) {
        // L1→L2 transaction with hints
        result = await processL1ToL2Transaction(request.signedTx, request.hints);
      } else {
        // Simple L1 transaction
        result = await processSimpleL1Transaction(request.signedTx);
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));

    } else if (url.pathname === "/status" && req.method === "GET") {
      const l2Hash = await rollupContract.l2BlockHash();
      const l2BlockNum = await rollupContract.l2BlockNumber();

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        l2BlockNumber: l2BlockNum.toString(),
        l2BlockHash: l2Hash,
        rollupAddress: config.rollupAddress,
      }));

    } else if (url.pathname === "/proxy" && req.method === "GET") {
      const l2Address = url.searchParams.get("l2Address");
      if (!l2Address) {
        res.writeHead(400);
        res.end("Missing l2Address parameter");
        return;
      }

      const proxyAddress = await rollupContract.getProxyAddress(l2Address);
      const isDeployed = await rollupContract.isProxyDeployed(l2Address);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ l2Address, proxyAddress, isDeployed }));

    } else if (url.pathname === "/" || url.pathname === "/index.html") {
      // Serve the UI
      const uiPath = path.join(process.cwd(), "ui", "index.html");
      if (fs.existsSync(uiPath)) {
        const content = fs.readFileSync(uiPath, "utf-8");
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(content);
      } else {
        res.writeHead(404);
        res.end("UI not found. Make sure ui/index.html exists.");
      }

    } else {
      res.writeHead(404);
      res.end("Not found");
    }

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
    console.error("Error: --rollup <address> is required");
    process.exit(1);
  }

  log("Builder", "=== Builder API Server ===");
  log("Builder", `L1 RPC: ${config.l1Rpc}`);
  log("Builder", `L2 Builder RPC: ${config.l2BuilderRpc}`);
  log("Builder", `L2 Fullnode RPC: ${config.l2FullnodeRpc}`);
  log("Builder", `Rollup: ${config.rollupAddress}`);

  // Initialize providers
  l1Provider = new JsonRpcProvider(config.l1Rpc);
  l2BuilderProvider = new JsonRpcProvider(config.l2BuilderRpc);
  l2FullnodeProvider = new JsonRpcProvider(config.l2FullnodeRpc);
  adminWallet = new Wallet(config.adminPrivateKey, l1Provider);
  rollupContract = new Contract(config.rollupAddress, ROLLUP_ABI, adminWallet);

  // Verify connection
  const l2BlockNum = await rollupContract.l2BlockNumber();
  log("Builder", `Connected. L2 block: ${l2BlockNum}`);

  // Start server
  const server = http.createServer(handleRequest);
  server.listen(config.port, () => {
    log("Builder", `API listening on http://localhost:${config.port}`);
    log("Builder", "");
    log("Builder", "Endpoints:");
    log("Builder", `  POST /submit       - Submit signed transaction`);
    log("Builder", `  GET  /status       - Get rollup status`);
    log("Builder", `  GET  /proxy?l2Address=0x... - Get proxy address`);
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
