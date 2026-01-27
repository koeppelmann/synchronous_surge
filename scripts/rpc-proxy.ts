/**
 * RPC Proxy Server
 *
 * A proxy that sits between the wallet and the real RPC node.
 * It forwards all requests to the underlying RPC, EXCEPT:
 * - eth_sendRawTransaction: Intercepts signed transactions and routes them
 *   through the Builder API instead of directly to the node.
 *
 * This allows wallets like Rabby (that don't support eth_signTransaction)
 * to work with the Native Rollup by using their normal eth_sendTransaction flow.
 *
 * Usage:
 *   npx tsx scripts/rpc-proxy.ts [options]
 *
 * Options:
 *   --port <port>       Proxy port (default: 8546)
 *   --rpc <url>         Underlying RPC URL (default: http://localhost:8545)
 *   --builder <url>     Builder API URL (default: http://localhost:3200)
 *   --rollup <addr>     NativeRollupCore address (for proxy detection)
 */

import * as http from "http";
import { ethers, Transaction } from "ethers";

// ============ Configuration ============

interface Config {
  port: number;
  rpcUrl: string;
  builderUrl: string;
  rollupAddress: string;
}

function parseArgs(): Config {
  const args = process.argv.slice(2);
  const config: Config = {
    port: 8546,
    rpcUrl: "http://localhost:8545",
    builderUrl: "http://localhost:3200",
    rollupAddress: "",
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--port":
        config.port = parseInt(args[++i]);
        break;
      case "--rpc":
        config.rpcUrl = args[++i];
        break;
      case "--builder":
        config.builderUrl = args[++i];
        break;
      case "--rollup":
        config.rollupAddress = args[++i];
        break;
    }
  }

  return config;
}

// ============ Constants ============

// Magic address for proxy detection
// When eth_getBalance is called for this address, the proxy returns a magic value
// instead of forwarding to the underlying RPC
const PROXY_DETECTION_ADDRESS = "0x00000000000000000000000050524f5859525043"; // "PROXYRPC" in hex
const PROXY_DETECTION_MAGIC_BALANCE = "0x50524f5859525043"; // "PROXYRPC" in hex = 5765665392615308355

// ============ Globals ============

let config: Config;
let provider: ethers.JsonRpcProvider;
let rollupContract: ethers.Contract | null = null;

const ROLLUP_ABI = [
  "function getProxyAddress(address l2Address) view returns (address)",
];

// ============ Logging ============

function log(component: string, message: string) {
  const timestamp = new Date().toISOString().split("T")[1].split(".")[0];
  console.log(`[${timestamp}] [${component}] ${message}`);
}

// ============ Proxy Address Detection ============

// Cache of proxy address -> L2 address mappings
const proxyToL2Cache: Map<string, string> = new Map();

/**
 * Check if an address is a proxy address and return the corresponding L2 address
 */
async function getL2AddressForProxy(proxyAddress: string): Promise<string | null> {
  const lowerProxy = proxyAddress.toLowerCase();

  // Check cache first
  if (proxyToL2Cache.has(lowerProxy)) {
    return proxyToL2Cache.get(lowerProxy)!;
  }

  if (!rollupContract) {
    return null;
  }

  // We need to check if this address is a proxy
  // Since we can't reverse the CREATE2 hash, we'll use a different approach:
  // The UI should include hints in the transaction data or we maintain a registry

  // For now, return null - the UI will need to provide hints
  return null;
}

// ============ Builder Integration ============

interface BuilderSubmitRequest {
  signedTx: string;
  hints?: {
    l2TargetAddress: string;
    description?: string;
  };
  sourceChain: "L1" | "L2";
}

async function submitToBuilder(request: BuilderSubmitRequest): Promise<any> {
  log("Proxy", `Submitting to builder at ${config.builderUrl}/submit`);

  try {
    const response = await fetch(`${config.builderUrl}/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      const error = await response.text();
      log("Proxy", `Builder returned error: ${error}`);
      throw new Error(`Builder error: ${error}`);
    }

    const result = await response.json();
    log("Proxy", `Builder response: ${JSON.stringify(result).slice(0, 200)}`);
    return result;
  } catch (err: any) {
    log("Proxy", `Failed to submit to builder: ${err.message}`);
    throw err;
  }
}

// ============ RPC Forwarding ============

async function forwardToRpc(body: any): Promise<any> {
  const response = await fetch(config.rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  return response.json();
}

// ============ Transaction Interception ============

/**
 * Registry of pending L1→L2 transactions
 * Key: transaction hash or nonce-based key
 * Value: L2 target address hint
 */
const pendingL1ToL2Hints: Map<string, string> = new Map();

/**
 * Register a hint for an upcoming L1→L2 transaction
 * Called by the UI before sending the transaction
 */
function registerHint(proxyAddress: string, l2TargetAddress: string): void {
  proxyToL2Cache.set(proxyAddress.toLowerCase(), l2TargetAddress.toLowerCase());
  log("Proxy", `Registered hint: ${proxyAddress} -> ${l2TargetAddress}`);
}

/**
 * Handle eth_sendRawTransaction by routing through builder
 */
async function handleSendRawTransaction(
  signedTx: string,
  id: number | string
): Promise<any> {
  try {
    // Parse the transaction to understand it
    const tx = Transaction.from(signedTx);
    log("Proxy", `Intercepted tx from ${tx.from} to ${tx.to}`);
    log("Proxy", `  Value: ${ethers.formatEther(tx.value)} ETH`);

    // Check if destination is a known proxy address
    const l2Target = tx.to ? proxyToL2Cache.get(tx.to.toLowerCase()) : null;

    if (l2Target) {
      // This is an L1→L2 transaction - route through builder
      log("Proxy", `  Detected L1→L2 tx to L2 address: ${l2Target}`);
      log("Proxy", `  Routing through builder...`);

      const result = await submitToBuilder({
        signedTx,
        hints: {
          l2TargetAddress: l2Target,
          description: `L1→L2 deposit to ${l2Target}`,
        },
        sourceChain: "L1",
      });

      log("Proxy", `  Builder accepted: ${result.l1TxHash}`);

      // Return the L1 tx hash as the result
      return {
        jsonrpc: "2.0",
        id,
        result: result.l1TxHash,
      };
    } else {
      // Simple L1 transaction - forward directly to RPC
      log("Proxy", `  Simple L1 tx - forwarding to RPC`);

      const response = await forwardToRpc({
        jsonrpc: "2.0",
        id,
        method: "eth_sendRawTransaction",
        params: [signedTx],
      });

      return response;
    }
  } catch (err: any) {
    log("Proxy", `Error handling tx: ${err.message}`);
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32000,
        message: err.message,
      },
    };
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

  // Handle hint registration endpoint
  const url = new URL(req.url || "/", `http://${req.headers.host}`);

  if (url.pathname === "/register-hint" && req.method === "POST") {
    const body = await readBody(req);
    const { proxyAddress, l2TargetAddress } = JSON.parse(body);

    if (proxyAddress && l2TargetAddress) {
      registerHint(proxyAddress, l2TargetAddress);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true }));
    } else {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing proxyAddress or l2TargetAddress" }));
    }
    return;
  }

  if (url.pathname === "/status" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      proxy: true,
      rpcUrl: config.rpcUrl,
      builderUrl: config.builderUrl,
      registeredHints: proxyToL2Cache.size,
    }));
    return;
  }

  // Handle JSON-RPC requests
  if (req.method !== "POST") {
    res.writeHead(405);
    res.end("Method not allowed");
    return;
  }

  try {
    const body = await readBody(req);
    const request = JSON.parse(body);

    // Handle batch requests
    if (Array.isArray(request)) {
      const results = await Promise.all(
        request.map((r) => handleRpcRequest(r))
      );
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(results));
      return;
    }

    // Handle single request
    const result = await handleRpcRequest(request);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
  } catch (err: any) {
    log("Proxy", `Request error: ${err.message}`);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      })
    );
  }
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
  });
}

async function handleRpcRequest(request: any): Promise<any> {
  const { method, params, id } = request;

  // Intercept eth_getBalance for magic proxy detection address
  if (method === "eth_getBalance" && params?.[0]) {
    const address = params[0].toLowerCase();
    if (address === PROXY_DETECTION_ADDRESS.toLowerCase()) {
      log("Proxy", `Proxy detection check received`);
      return {
        jsonrpc: "2.0",
        id,
        result: PROXY_DETECTION_MAGIC_BALANCE,
      };
    }
  }

  // Intercept eth_getCode for magic proxy detection address
  if (method === "eth_getCode" && params?.[0]) {
    const address = params[0].toLowerCase();
    if (address === PROXY_DETECTION_ADDRESS.toLowerCase()) {
      log("Proxy", `Proxy detection check (code) received`);
      // Return a magic bytecode that spells "PROXYRPC" when decoded
      return {
        jsonrpc: "2.0",
        id,
        result: "0x50524f5859525043", // "PROXYRPC" in hex
      };
    }
  }

  // Intercept eth_sendRawTransaction
  if (method === "eth_sendRawTransaction" && params?.[0]) {
    return handleSendRawTransaction(params[0], id);
  }

  // Forward all other requests to the underlying RPC
  return forwardToRpc(request);
}

// ============ Main ============

async function main() {
  config = parseArgs();

  log("Proxy", "=== RPC Proxy Server ===");
  log("Proxy", `Underlying RPC: ${config.rpcUrl}`);
  log("Proxy", `Builder API: ${config.builderUrl}`);
  if (config.rollupAddress) {
    log("Proxy", `Rollup: ${config.rollupAddress}`);
  }

  // Initialize provider
  provider = new ethers.JsonRpcProvider(config.rpcUrl);

  // Initialize rollup contract if address provided
  if (config.rollupAddress) {
    rollupContract = new ethers.Contract(
      config.rollupAddress,
      ROLLUP_ABI,
      provider
    );
  }

  // Verify connection to underlying RPC
  try {
    const blockNumber = await provider.getBlockNumber();
    log("Proxy", `Connected to RPC. Block: ${blockNumber}`);
  } catch (err: any) {
    log("Proxy", `Warning: Could not connect to RPC: ${err.message}`);
  }

  // Verify connection to builder
  try {
    const response = await fetch(`${config.builderUrl}/status`);
    if (response.ok) {
      const status = await response.json();
      log("Proxy", `Connected to Builder. L2 Block: ${status.l2BlockNumber}`);
    }
  } catch (err: any) {
    log("Proxy", `Warning: Could not connect to Builder: ${err.message}`);
  }

  // Start server
  const server = http.createServer(handleRequest);
  server.listen(config.port, () => {
    log("Proxy", "");
    log("Proxy", `Proxy listening on http://localhost:${config.port}`);
    log("Proxy", "");
    log("Proxy", "Configure your wallet to use this RPC URL:");
    log("Proxy", `  http://localhost:${config.port}`);
    log("Proxy", "");
    log("Proxy", "Endpoints:");
    log("Proxy", `  POST /              - JSON-RPC (proxied)`);
    log("Proxy", `  POST /register-hint - Register L1→L2 hint`);
    log("Proxy", `  GET  /status        - Proxy status`);
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
