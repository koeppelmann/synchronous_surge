/**
 * L2 Fullnode Implementation
 *
 * This fullnode exposes a well-defined RPC interface for the builder.
 * The underlying EVM (Anvil for POC, Reth/Nethermind for production) is hidden.
 *
 * KEY ARCHITECTURAL DECISIONS:
 *
 * 1. SYSTEM ADDRESS
 *    All L2 transactions are executed by a system address.
 *    This address has special privileges:
 *    - Can deploy L1SenderProxyL2 contracts
 *    - Can make calls through those proxies
 *    - Is pre-funded with enough ETH for gas
 *
 * 2. L1SenderProxyL2 DEPLOYMENT
 *    When an L1 address calls L2 for the first time:
 *    - System deploys L1SenderProxyL2 for that L1 address
 *    - Subsequent calls go through this proxy
 *    - msg.sender on L2 is the proxy address (deterministic, CREATE2)
 *
 * 3. NO IMPERSONATION
 *    We NEVER use anvil_impersonateAccount or anvil_setBalance.
 *    Instead, all operations go through the system address and proper contracts.
 *
 * 4. SIMULATION vs EXECUTION
 *    - Simulation: fork, execute, return result, discard fork
 *    - Execution: execute on canonical state, persist changes
 */

import {
  ethers,
  Contract,
  ContractFactory,
  JsonRpcProvider,
  Wallet,
} from "ethers";
import { spawn, ChildProcess } from "child_process";
import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import {
  SimulationResult,
  ExecutionResult,
  L1ToL2CallParams,
  IFullnodeRpc,
} from "./fullnode-rpc-interface";

// ============ Configuration ============

export interface L2FullnodeConfig {
  l1Rpc: string;
  rollupAddress: string;
  l2Port: number;           // Port for L2 EVM
  rpcPort: number;          // Port for fullnode RPC server
  l2ChainId: number;
  systemPrivateKey: string; // System address private key
}

const DEFAULT_CONFIG: L2FullnodeConfig = {
  l1Rpc: process.env.L1_RPC || "http://localhost:8545",
  rollupAddress: process.env.ROLLUP_ADDRESS || "",
  l2Port: parseInt(process.env.L2_PORT || "9546"),
  rpcPort: parseInt(process.env.RPC_PORT || "9547"),
  l2ChainId: parseInt(process.env.L2_CHAIN_ID || "10200200"),
  // System address: 0x1000000000000000000000000000000000000001
  // This is the "sequencer" that executes all L2 operations
  systemPrivateKey: process.env.SYSTEM_PRIVATE_KEY || "0x0000000000000000000000000000000000000000000000000000000000000001",
};

// ============ Constants ============

// System address balance (10 billion ETH for gas)
const SYSTEM_BALANCE = ethers.parseEther("10000000000");

// L1SenderProxyL2Factory ABI (minimal for deployment)
const L1_SENDER_PROXY_L2_FACTORY_ABI = [
  "function deployProxy(address l1Address) returns (address)",
  "function computeProxyAddress(address l1Address) view returns (address)",
  "function isProxyDeployed(address l1Address) view returns (bool)",
  "function getProxy(address l1Address) view returns (address)",
  "function systemAddress() view returns (address)",
  "function callRegistry() view returns (address)",
  "function SALT_PREFIX() view returns (bytes32)",
];

// L1SenderProxyL2 ABI (for making calls)
const L1_SENDER_PROXY_L2_ABI = [
  "function l1Address() view returns (address)",
  "function systemAddress() view returns (address)",
];

// L2CallRegistry ABI
const L2_CALL_REGISTRY_ABI = [
  "function registerReturnValue(bytes32 callKey, bytes calldata returnData)",
  "function getReturnValue(bytes32 callKey) view returns (bool registered, bytes memory returnData)",
];

// L1 NativeRollupCore ABI (for watching events)
const ROLLUP_ABI = [
  "event IncomingCallHandled(address indexed l2Address, address indexed l1Caller, bytes32 indexed prevBlockHash, bytes callData, uint256 value, tuple(address from, address target, uint256 value, uint256 gas, bytes data, bytes32 postCallStateHash)[] outgoingCalls, bytes[] outgoingCallResults, bytes32 finalStateHash)",
  "event L2BlockProcessed(uint256 indexed blockNumber, bytes32 indexed prevBlockHash, bytes32 indexed newBlockHash, bytes rlpEncodedTx, tuple(address from, address target, uint256 value, uint256 gas, bytes data, bytes32 postCallStateHash)[] outgoingCalls, bytes[] outgoingCallResults)",
  "function l2BlockHash() view returns (bytes32)",
  "function l2BlockNumber() view returns (uint256)",
];

// ============ Logging ============

function log(component: string, message: string) {
  const timestamp = new Date().toISOString().split("T")[1].split(".")[0];
  console.log(`[${timestamp}] [${component}] ${message}`);
}

// ============ L2 Fullnode Implementation ============

export class L2Fullnode implements IFullnodeRpc {
  private config: L2FullnodeConfig;
  private l1Provider: JsonRpcProvider;
  private l2Provider!: JsonRpcProvider;
  private systemWallet!: Wallet;
  private anvilProcess: ChildProcess | null = null;
  private rollupCore: Contract;
  private httpServer: http.Server | null = null;

  // L2 system contracts (deployed at genesis or on first use)
  private l1SenderProxyL2FactoryAddress: string | null = null;
  private l2CallRegistryAddress: string | null = null;
  private l1SenderProxyL2Factory: Contract | null = null;

  // Fork counter for simulation
  private forkCounter = 0;

  constructor(config: Partial<L2FullnodeConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.l1Provider = new JsonRpcProvider(this.config.l1Rpc);
    this.rollupCore = new Contract(
      this.config.rollupAddress,
      ROLLUP_ABI,
      this.l1Provider
    );
  }

  // ============ Lifecycle ============

  async start(): Promise<void> {
    log("Fullnode", "=== L2 Fullnode ===");
    log("Fullnode", `L1 RPC: ${this.config.l1Rpc}`);
    log("Fullnode", `Rollup: ${this.config.rollupAddress}`);
    log("Fullnode", `L2 Port: ${this.config.l2Port}`);
    log("Fullnode", `RPC Port: ${this.config.rpcPort}`);

    // Start L2 EVM (Anvil)
    await this.startL2Evm();

    // Deploy system contracts
    await this.deploySystemContracts();

    // Replay historical L1 events to catch up
    await this.replayHistoricalEvents();

    // Start RPC server
    await this.startRpcServer();

    // Set polling cursor to current block so we don't re-process historical events
    this.lastPolledBlock = await this.l1Provider.getBlockNumber();

    // Watch L1 events (for new events going forward)
    this.watchL1Events();

    log("Fullnode", "Fullnode started");
  }

  async stop(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
    }
    if (this.httpServer) {
      this.httpServer.close();
    }
    if (this.anvilProcess) {
      this.anvilProcess.kill();
    }
  }

  // ============ L2 EVM Management ============

  private async startL2Evm(): Promise<void> {
    const l2Rpc = `http://localhost:${this.config.l2Port}`;

    log("Fullnode", `Starting L2 EVM on port ${this.config.l2Port}...`);

    this.anvilProcess = spawn(
      "anvil",
      [
        "--port", this.config.l2Port.toString(),
        "--chain-id", this.config.l2ChainId.toString(),
        "--accounts", "0",
        "--gas-price", "0",
        "--base-fee", "0",
        "--no-mining",  // Manual mining: 1 block per L1 event
        "--silent",
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );

    // Wait for ready
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("L2 EVM start timeout")), 10000);

      const check = async () => {
        try {
          const provider = new JsonRpcProvider(l2Rpc);
          await provider.getBlockNumber();
          clearTimeout(timeout);
          resolve();
        } catch {
          setTimeout(check, 100);
        }
      };

      this.anvilProcess!.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      check();
    });

    this.l2Provider = new JsonRpcProvider(l2Rpc);

    // Fund system address using Anvil's special method
    // This is the ONLY place we use anvil_setBalance
    // The system address is like the "block producer" - it needs funds to operate
    const systemAddress = new Wallet(this.config.systemPrivateKey).address;
    await this.l2Provider.send("anvil_setBalance", [
      systemAddress,
      "0x" + SYSTEM_BALANCE.toString(16),
    ]);

    this.systemWallet = new Wallet(this.config.systemPrivateKey, this.l2Provider);

    log("Fullnode", `System address: ${this.systemWallet.address}`);
    log("Fullnode", `L2 EVM ready at ${l2Rpc}`);
  }

  // ============ System Contract Deployment ============

  private async deploySystemContracts(): Promise<void> {
    log("Fullnode", "Deploying L2 system contracts...");

    // For POC, deploy from compiled Foundry artifacts
    // In production, these would be pre-deployed at genesis with known addresses

    // Get current nonce
    let nonce = await this.systemWallet.getNonce("pending");
    log("Fullnode", `  System nonce: ${nonce}`);

    // Compute deterministic addresses (CREATE: keccak(rlp(sender, nonce)))
    const registryAddress = ethers.getCreateAddress({ from: this.systemWallet.address, nonce: nonce });
    const factoryAddress = ethers.getCreateAddress({ from: this.systemWallet.address, nonce: nonce + 1 });

    // Send both deploy txs to mempool (no automine — they stay pending)
    const registryArtifact = this.loadArtifact("L2CallRegistry");
    const registryFactory = new ContractFactory(
      registryArtifact.abi,
      registryArtifact.bytecode,
      this.systemWallet
    );
    const registryTx = await registryFactory.deploy(
      this.systemWallet.address,  // systemAddress
      { nonce: nonce++ }
    );

    const factoryArtifact = this.loadArtifact("L1SenderProxyL2Factory");
    const factoryFactory = new ContractFactory(
      factoryArtifact.abi,
      factoryArtifact.bytecode,
      this.systemWallet
    );
    const factoryTx = await factoryFactory.deploy(
      this.systemWallet.address,      // systemAddress
      registryAddress,                 // callRegistry (pre-computed address)
      { nonce: nonce++ }
    );

    // Mine a single genesis block containing both deploys
    await this.l2Provider.send("evm_mine", []);

    // Wait for both to be mined
    await registryTx.waitForDeployment();
    await factoryTx.waitForDeployment();

    this.l2CallRegistryAddress = registryAddress;
    this.l1SenderProxyL2FactoryAddress = factoryAddress;
    log("Fullnode", `  L2CallRegistry: ${this.l2CallRegistryAddress}`);
    log("Fullnode", `  L1SenderProxyL2Factory: ${this.l1SenderProxyL2FactoryAddress}`);

    // Store factory contract reference for later use
    this.l1SenderProxyL2Factory = new Contract(
      this.l1SenderProxyL2FactoryAddress,
      L1_SENDER_PROXY_L2_FACTORY_ABI,
      this.systemWallet
    );

    const stateRoot = await this.nativerollup_getStateRoot();
    log("Fullnode", `  Genesis state root: ${stateRoot}`);
  }

  /**
   * Load a compiled Foundry artifact
   */
  private loadArtifact(contractName: string): { abi: any[]; bytecode: string } {
    // Try multiple paths (fullnode may be run from different directories)
    // Use import.meta.url for ES module compatibility
    const currentDir = new URL(".", import.meta.url).pathname;
    const possiblePaths = [
      path.join(currentDir, "..", "out", `L1SenderProxyL2.sol`, `${contractName}.json`),
      path.join(process.cwd(), "out", `L1SenderProxyL2.sol`, `${contractName}.json`),
      path.join(process.cwd(), "synchronous_surge", "out", `L1SenderProxyL2.sol`, `${contractName}.json`),
    ];

    for (const artifactPath of possiblePaths) {
      try {
        const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf-8"));
        return {
          abi: artifact.abi,
          bytecode: artifact.bytecode.object,
        };
      } catch {
        // Try next path
      }
    }

    throw new Error(`Could not find artifact for ${contractName}. Run 'forge build' first.`);
  }


  // ============ RPC Server ============

  private async startRpcServer(): Promise<void> {
    this.httpServer = http.createServer(async (req, res) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      if (req.method !== "POST") {
        res.writeHead(405);
        res.end("Method not allowed");
        return;
      }

      try {
        const body = await new Promise<string>((resolve) => {
          let data = "";
          req.on("data", (chunk) => (data += chunk));
          req.on("end", () => resolve(data));
        });

        const parsed = JSON.parse(body);

        // Handle batch requests
        if (Array.isArray(parsed)) {
          const results = await Promise.all(
            parsed.map(async (req: any) => {
              try {
                const result = await this.handleRpcCall(req.method, req.params || []);
                return { jsonrpc: "2.0", id: req.id, result };
              } catch (err: any) {
                return { jsonrpc: "2.0", id: req.id, error: { code: -32000, message: err.message } };
              }
            })
          );
          if (!res.headersSent) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(results));
          }
          return;
        }

        // Single request
        const { jsonrpc, id, method, params } = parsed;

        let result: any;
        let error: any = null;

        try {
          result = await this.handleRpcCall(method, params || []);
        } catch (err: any) {
          error = { code: -32000, message: err.message };
        }

        if (!res.headersSent) {
          res.writeHead(200, { "Content-Type": "application/json" });
          if (error) {
            res.end(JSON.stringify({ jsonrpc: "2.0", id, error }));
          } else {
            res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
          }
        }
      } catch (err: any) {
        if (!res.headersSent) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32000, message: err.message },
          }));
        }
      }
    });

    this.httpServer.listen(this.config.rpcPort, () => {
      log("Fullnode", `RPC server listening on http://localhost:${this.config.rpcPort}`);
    });
  }

  private async handleRpcCall(method: string, params: any[]): Promise<any> {
    // Standard Ethereum RPC - proxy to L2 EVM
    if (method.startsWith("eth_")) {
      return this.l2Provider.send(method, params);
    }

    // EVM state management - save/restore proxy cache alongside snapshots
    if (method === "evm_snapshot") {
      const snapshotId = await this.l2Provider.send("evm_snapshot", []);
      this.proxySnapshots.set(snapshotId, new Map(this.l1ProxyAddresses));
      log("Fullnode", `Snapshot taken: ${snapshotId} (${this.l1ProxyAddresses.size} cached proxies)`);
      return snapshotId;
    }
    if (method === "evm_revert") {
      const result = await this.l2Provider.send("evm_revert", params);
      const snapshotId = params[0];
      const savedCache = this.proxySnapshots.get(snapshotId);
      if (savedCache) {
        this.l1ProxyAddresses = new Map(savedCache);
        this.proxySnapshots.delete(snapshotId);
        log("Fullnode", `Snapshot reverted: ${snapshotId} (restored ${this.l1ProxyAddresses.size} cached proxies)`);
      } else {
        this.l1ProxyAddresses.clear();
        log("Fullnode", `Snapshot reverted: ${snapshotId} (no saved cache, cleared all)`);
      }
      return result;
    }

    // Native Rollup specific RPC
    switch (method) {
      case "nativerollup_getStateRoot":
        return this.nativerollup_getStateRoot();

      case "nativerollup_simulateL1ToL2Call":
        return this.nativerollup_simulateL1ToL2Call(params[0]);

      case "nativerollup_executeL1ToL2Call":
        return this.nativerollup_executeL1ToL2Call(params[0]);

      case "nativerollup_executeL2Transaction":
        return this.nativerollup_executeL2Transaction(params[0]);

      case "nativerollup_getL1SenderProxyL2":
        return this.nativerollup_getL1SenderProxyL2(params[0]);

      case "nativerollup_isL1SenderProxyL2Deployed":
        return this.nativerollup_isL1SenderProxyL2Deployed(params[0]);

      case "nativerollup_verifyStateChain":
        return this.nativerollup_verifyStateChain(params[0]);

      default:
        throw new Error(`Unknown method: ${method}`);
    }
  }

  // ============ IFullnodeRpc Implementation ============

  async eth_blockNumber(): Promise<string> {
    return this.l2Provider.send("eth_blockNumber", []);
  }

  async eth_getBalance(address: string, block?: string): Promise<string> {
    return this.l2Provider.send("eth_getBalance", [address, block || "latest"]);
  }

  async eth_getCode(address: string, block?: string): Promise<string> {
    return this.l2Provider.send("eth_getCode", [address, block || "latest"]);
  }

  async eth_call(tx: { to: string; data: string; from?: string; value?: string }, block?: string): Promise<string> {
    return this.l2Provider.send("eth_call", [tx, block || "latest"]);
  }

  async eth_getBlockByNumber(block: string, fullTx: boolean): Promise<any> {
    return this.l2Provider.send("eth_getBlockByNumber", [block, fullTx]);
  }

  async nativerollup_getStateRoot(): Promise<string> {
    const block = await this.l2Provider.send("eth_getBlockByNumber", ["latest", false]);
    return block?.stateRoot || "0x0";
  }

  async nativerollup_simulateL1ToL2Call(params: L1ToL2CallParams): Promise<SimulationResult> {
    log("Fullnode", `Simulating L1→L2 call:`);
    log("Fullnode", `  L1 caller: ${params.l1Caller}`);
    log("Fullnode", `  L2 target: ${params.l2Target}`);
    log("Fullnode", `  Value: ${params.value}`);

    // APPROACH: Use snapshot/revert on canonical chain instead of fork.
    // This gives us the REAL state root, which is essential for the
    // registration system to work correctly.
    //
    // Why not fork? Anvil in fork mode returns 0x0 for stateRoot after
    // any state change, breaking our state tracking.

    try {
      // Take a snapshot of the current state
      const snapshotId = await this.l2Provider.send("evm_snapshot", []);
      log("Fullnode", `  Snapshot taken: ${snapshotId}`);

      try {
        // Execute on canonical chain (isSimulation=true to not store proxy address)
        const result = await this.executeL1ToL2CallOnProvider(
          params,
          this.l2Provider,
          this.systemWallet,
          true  // isSimulation - don't store proxy addresses
        );

        return result;
      } finally {
        // Always revert to snapshot, restoring the original state
        const reverted = await this.l2Provider.send("evm_revert", [snapshotId]);
        log("Fullnode", `  Reverted to snapshot: ${reverted}`);
      }
    } catch (err: any) {
      log("Fullnode", `  Simulation failed: ${err.message}`);
      throw err;
    }
  }

  async nativerollup_executeL1ToL2Call(params: L1ToL2CallParams): Promise<ExecutionResult> {
    log("Fullnode", `Executing L1→L2 call:`);
    log("Fullnode", `  L1 caller: ${params.l1Caller}`);
    log("Fullnode", `  L2 target: ${params.l2Target}`);
    log("Fullnode", `  Value: ${params.value}`);

    // Execute on canonical state (isSimulation=false means store proxy address)
    return this.executeL1ToL2CallOnProvider(
      params,
      this.l2Provider,
      this.systemWallet,
      false  // isSimulation
    );
  }

  async nativerollup_executeL2Transaction(rawTx: string): Promise<ExecutionResult> {
    log("Fullnode", `Executing L2 transaction...`);
    log("Fullnode", `  RawTx length: ${rawTx.length}`);

    try {
      log("Fullnode", `  Sending to L2 EVM...`);
      const txHash = await this.l2Provider.send("eth_sendRawTransaction", [rawTx]);
      log("Fullnode", `  TX Hash: ${txHash}`);

      // Mine a block first to include the transaction
      log("Fullnode", `  Mining block...`);
      await this.l2Provider.send("evm_mine", []);

      log("Fullnode", `  Getting receipt...`);
      const receipt = await this.l2Provider.getTransactionReceipt(txHash);
      log("Fullnode", `  Receipt status: ${receipt?.status}`);

      const newStateRoot = await this.nativerollup_getStateRoot();
      log("Fullnode", `  New state root: ${newStateRoot}`);

      return {
        success: receipt?.status === 1,
        txHash,
        returnData: "0x",
        newStateRoot,
        gasUsed: (receipt?.gasUsed || 0n).toString(),  // Convert bigint to string for JSON
        logs: [],
      };
    } catch (err: any) {
      log("Fullnode", `  Error: ${err.message}`);
      return {
        success: false,
        txHash: "0x0",
        returnData: "0x",
        newStateRoot: await this.nativerollup_getStateRoot(),
        gasUsed: "0",  // String for JSON
        logs: [],
        error: err.message,
      };
    }
  }

  async nativerollup_getL1SenderProxyL2(l1Address: string): Promise<string> {
    // Return the deployed address if exists, otherwise the expected address
    const deployed = this.l1ProxyAddresses.get(l1Address.toLowerCase());
    if (deployed) {
      return deployed;
    }
    // Return expected address (for pre-deployment queries)
    return await this.computeL1SenderProxyL2Address(l1Address);
  }

  async nativerollup_isL1SenderProxyL2Deployed(l1Address: string): Promise<boolean> {
    return this.l1ProxyAddresses.has(l1Address.toLowerCase());
  }

  /**
   * Verify a chain of expected state transitions by replaying them.
   * Takes a snapshot, replays each event, compares actual vs expected state hash.
   * Returns a report showing where divergence (if any) occurs.
   */
  async nativerollup_verifyStateChain(params: {
    events: Array<{
      type: "IncomingCallHandled" | "L2BlockProcessed";
      l2Address?: string;
      l1Caller?: string;
      callData?: string;
      value?: string;
      rlpEncodedTx?: string;
      expectedPreStateHash: string;
      expectedPostStateHash: string;
    }>;
  }): Promise<{
    results: Array<{
      index: number;
      type: string;
      expectedPreStateHash: string;
      actualPreStateHash: string;
      expectedPostStateHash: string;
      actualPostStateHash: string;
      preMatch: boolean;
      postMatch: boolean;
      returnData?: string;
    }>;
    allMatch: boolean;
    firstDivergence: number | null;
  }> {
    log("Fullnode", `=== Verifying state chain (${params.events.length} events) ===`);

    const snapshotId = await this.l2Provider.send("evm_snapshot", []);
    const savedProxies = new Map(this.l1ProxyAddresses);

    try {
      const results: Array<{
        index: number;
        type: string;
        expectedPreStateHash: string;
        actualPreStateHash: string;
        expectedPostStateHash: string;
        actualPostStateHash: string;
        preMatch: boolean;
        postMatch: boolean;
        returnData?: string;
      }> = [];
      let firstDivergence: number | null = null;

      for (let i = 0; i < params.events.length; i++) {
        const event = params.events[i];
        const actualPreState = await this.nativerollup_getStateRoot();
        const preMatch = actualPreState.toLowerCase() === event.expectedPreStateHash.toLowerCase();

        log("Fullnode", `  Event ${i}: ${event.type}`);
        log("Fullnode", `    Pre-state: expected=${event.expectedPreStateHash.slice(0, 14)}... actual=${actualPreState.slice(0, 14)}... ${preMatch ? "MATCH" : "MISMATCH"}`);

        let returnData: string | undefined;

        if (event.type === "IncomingCallHandled") {
          const execResult = await this.nativerollup_executeL1ToL2Call({
            l1Caller: event.l1Caller!,
            l2Target: event.l2Address!,
            callData: event.callData!,
            value: event.value || "0",
            currentStateRoot: actualPreState,
          });
          returnData = execResult.returnData;
        } else if (event.type === "L2BlockProcessed" && event.rlpEncodedTx) {
          await this.nativerollup_executeL2Transaction(event.rlpEncodedTx);
        }

        const actualPostState = await this.nativerollup_getStateRoot();
        const postMatch = actualPostState.toLowerCase() === event.expectedPostStateHash.toLowerCase();

        log("Fullnode", `    Post-state: expected=${event.expectedPostStateHash.slice(0, 14)}... actual=${actualPostState.slice(0, 14)}... ${postMatch ? "MATCH" : "MISMATCH"}`);
        if (returnData) {
          log("Fullnode", `    Return data: ${returnData.slice(0, 42)}${returnData.length > 42 ? '...' : ''}`);
        }

        if (!postMatch && firstDivergence === null) {
          firstDivergence = i;
        }

        results.push({
          index: i,
          type: event.type,
          expectedPreStateHash: event.expectedPreStateHash,
          actualPreStateHash: actualPreState,
          expectedPostStateHash: event.expectedPostStateHash,
          actualPostStateHash: actualPostState,
          preMatch,
          postMatch,
          returnData,
        });
      }

      const allMatch = firstDivergence === null;
      log("Fullnode", `=== Verification ${allMatch ? "PASSED" : `FAILED at event ${firstDivergence}`} ===`);

      return { results, allMatch, firstDivergence };
    } finally {
      await this.l2Provider.send("evm_revert", [snapshotId]);
      this.l1ProxyAddresses = savedProxies;
      log("Fullnode", `  State reverted after verification`);
    }
  }

  // ============ Internal Helpers ============

  private async computeL1SenderProxyL2Address(l1Address: string): Promise<string> {
    // Check if already deployed
    const deployed = this.l1ProxyAddresses.get(l1Address.toLowerCase());
    if (deployed) {
      return deployed;
    }

    // If factory is deployed, use it to compute the address
    if (this.l1SenderProxyL2Factory) {
      return await this.l1SenderProxyL2Factory.computeProxyAddress(l1Address);
    }

    // Fallback: compute CREATE2 address manually (matches factory logic)
    // Salt: keccak256(SALT_PREFIX + l1Address)
    // SALT_PREFIX = keccak256("NativeRollup.L1SenderProxyL2.v1")
    const SALT_PREFIX = ethers.keccak256(ethers.toUtf8Bytes("NativeRollup.L1SenderProxyL2.v1"));
    const salt = ethers.keccak256(ethers.solidityPacked(
      ["bytes32", "address"],
      [SALT_PREFIX, l1Address]
    ));

    // For CREATE2: address = keccak256(0xff ++ factory ++ salt ++ keccak256(initCode))[12:]
    // We need the factory address and init code to compute this
    // Since factory isn't deployed yet, we can't compute reliably
    // Return a placeholder that indicates we need the factory
    log("Fullnode", `  WARNING: Factory not deployed, cannot compute deterministic address for ${l1Address}`);
    return ethers.ZeroAddress;
  }

  private async executeL1ToL2CallOnProvider(
    params: L1ToL2CallParams,
    provider: JsonRpcProvider,
    systemWallet: Wallet,
    isSimulation: boolean = false
  ): Promise<ExecutionResult> {
    // Check if proxy is deployed for this L1 caller (only on canonical chain)
    let proxyAddress = this.l1ProxyAddresses.get(params.l1Caller.toLowerCase());

    if (!proxyAddress) {
      // Deploy the proxy
      log("Fullnode", `  Deploying L1SenderProxyL2 for ${params.l1Caller}...`);
      proxyAddress = await this.deployL1SenderProxyL2(
        params.l1Caller,
        provider,
        systemWallet,
        !isSimulation  // Only store if not simulation
      );
    }

    // Now execute the call through the proxy
    // The proxy expects: target (20 bytes) + calldata
    const callData = params.callData || "0x";
    const packedCalldata = ethers.solidityPacked(
      ["address", "bytes"],
      [params.l2Target, callData]
    );

    log("Fullnode", `  Calling through proxy ${proxyAddress}...`);
    log("Fullnode", `    L2 target: ${params.l2Target}`);
    log("Fullnode", `    L2 calldata: ${callData}`);
    log("Fullnode", `    Packed calldata length: ${packedCalldata.length} chars (${(packedCalldata.length - 2) / 2} bytes)`);
    log("Fullnode", `    Packed calldata: ${packedCalldata}`);

    try {
      // Capture return data via eth_call (stateless simulation) on pending state
      let returnData = "0x";
      try {
        returnData = await provider.send("eth_call", [
          {
            from: systemWallet.address,
            to: proxyAddress,
            data: packedCalldata,
            value: params.value ? ethers.toQuantity(BigInt(params.value)) : "0x0",
          },
          "pending",
        ]);
        log("Fullnode", `    eth_call return data: ${returnData}`);
      } catch (callErr: any) {
        log("Fullnode", `    eth_call failed (expected for state-changing calls): ${callErr.message}`);
      }

      // Get nonce from pending state (includes unmined txs like proxy deploy)
      const nonceHex = await provider.send("eth_getTransactionCount", [systemWallet.address, "pending"]);
      const nonce = parseInt(nonceHex, 16);
      log("Fullnode", `    Current nonce (pending): ${nonce}`);

      // Send the call tx to mempool
      const txRequest = {
        to: proxyAddress,
        data: packedCalldata,
        value: BigInt(params.value || "0"),
        gasLimit: 10000000n,
        nonce: nonce,
      };
      log("Fullnode", `    Using nonce: ${nonce}`);
      const tx = await systemWallet.sendTransaction(txRequest);

      // Mine a single block containing proxy deploy (if any) + this call
      await provider.send("evm_mine", []);

      const receipt = await tx.wait();

      // Get new state root
      const block = await provider.send("eth_getBlockByNumber", ["latest", false]);
      const newStateRoot = block?.stateRoot || "0x0";

      log("Fullnode", `  New state root: ${newStateRoot}`);
      log("Fullnode", `  Return data: ${returnData}`);

      return {
        success: receipt?.status === 1,
        txHash: receipt?.hash || "",
        returnData,
        newStateRoot,
        gasUsed: (receipt?.gasUsed || 0n).toString(),
        logs: [],
      };
    } catch (err: any) {
      log("Fullnode", `  Call failed: ${err.message}`);

      // Mine to commit any pending proxy deploys even on failure
      await provider.send("evm_mine", []);
      const block = await provider.send("eth_getBlockByNumber", ["latest", false]);
      return {
        success: false,
        txHash: "",
        returnData: "0x",
        newStateRoot: block?.stateRoot || "0x0",
        gasUsed: "0",
        logs: [],
        error: err.message,
      };
    }
  }

  private async deployL1SenderProxyL2(
    l1Address: string,
    provider: JsonRpcProvider,
    systemWallet: Wallet,
    storeAddress: boolean = true
  ): Promise<string> {
    // Deploy via the factory to get deterministic CREATE2 address
    // This ensures the proxy address is predictable and matches what setup scripts expect

    if (!this.l1SenderProxyL2FactoryAddress) {
      throw new Error("L1SenderProxyL2Factory not deployed");
    }

    try {
      // Create factory contract reference using the PASSED-IN provider
      // This is critical for fork support - the factory is at the same address on fork
      const factory = new Contract(
        this.l1SenderProxyL2FactoryAddress,
        L1_SENDER_PROXY_L2_FACTORY_ABI,
        systemWallet  // systemWallet is already connected to the correct provider
      );

      // First compute what the address will be (deterministic CREATE2)
      const expectedAddress = await factory.computeProxyAddress(l1Address);
      log("Fullnode", `    Expected proxy address (CREATE2): ${expectedAddress}`);

      // Check if already deployed on-chain
      const existingCode = await provider.getCode(expectedAddress);
      if (existingCode && existingCode !== "0x" && existingCode.length >= 10) {
        log("Fullnode", `  L1SenderProxyL2 already deployed at ${expectedAddress} (skipping deploy)`);
        if (storeAddress) {
          this.l1ProxyAddresses.set(l1Address.toLowerCase(), expectedAddress);
        }
        return expectedAddress;
      }

      // Send deploy tx to mempool (caller is responsible for mining)
      // Use pending nonce to account for unmined txs in --no-mining mode
      const nonceHex = await provider.send("eth_getTransactionCount", [systemWallet.address, "pending"]);
      const tx = await factory.deployProxy(l1Address, { nonce: parseInt(nonceHex, 16) });
      log("Fullnode", `  L1SenderProxyL2 deploy tx sent for ${l1Address} → ${expectedAddress}`);

      // Only store the mapping if this is a canonical execution (not simulation)
      if (storeAddress) {
        this.l1ProxyAddresses.set(l1Address.toLowerCase(), expectedAddress);
      }

      return expectedAddress;
    } catch (err: any) {
      log("Fullnode", `  Failed to deploy via factory: ${err.message}`);
      throw err;
    }
  }


  // Track deployed L1SenderProxyL2 addresses
  private l1ProxyAddresses: Map<string, string> = new Map();
  private proxySnapshots: Map<string, Map<string, string>> = new Map();
  private eventQueue: Promise<void> = Promise.resolve(); // Serialize L1 event processing

  private async createFork(): Promise<{
    provider: JsonRpcProvider;
    systemWallet: Wallet;
    process: ChildProcess;
  }> {
    const forkPort = 19000 + (this.forkCounter++ % 100);
    const forkRpc = `http://localhost:${forkPort}`;

    log("Fullnode", `  Creating fork on port ${forkPort}...`);

    const anvilProcess = spawn("anvil", [
      "--fork-url", `http://localhost:${this.config.l2Port}`,
      "--port", forkPort.toString(),
      "--chain-id", this.config.l2ChainId.toString(),
      "--accounts", "0",
      "--gas-price", "0",
      "--base-fee", "0",
      "--silent",
    ], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });

    // Capture stderr for debugging
    let stderrData = "";
    anvilProcess.stderr?.on("data", (data) => {
      stderrData += data.toString();
    });

    // Wait for ready using fetch instead of ethers (more reliable)
    const provider = await new Promise<JsonRpcProvider>((resolve, reject) => {
      const timeout = setTimeout(() => {
        log("Fullnode", `  Fork timeout! stderr: ${stderrData.slice(0, 200)}`);
        anvilProcess.kill();
        reject(new Error("Fork timeout"));
      }, 15000);

      const check = async () => {
        try {
          // Use raw fetch first to check if anvil is responding
          const response = await fetch(forkRpc, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              method: "eth_chainId",
              params: [],
              id: 1,
            }),
          });

          const json = await response.json();
          if (json.result) {
            // Anvil is responding, now create provider with static network
            // Use FetchRequest to avoid network auto-detection issues
            const p = new JsonRpcProvider(forkRpc, this.config.l2ChainId, {
              staticNetwork: true,
            });
            clearTimeout(timeout);
            log("Fullnode", `  Fork ready on port ${forkPort}`);
            resolve(p);
          } else {
            setTimeout(check, 100);
          }
        } catch {
          setTimeout(check, 100);
        }
      };

      anvilProcess.on("error", (err) => {
        log("Fullnode", `  Fork process error: ${err.message}`);
        clearTimeout(timeout);
        reject(err);
      });

      anvilProcess.on("exit", (code) => {
        if (code !== null && code !== 0) {
          log("Fullnode", `  Fork process exited with code ${code}`);
          clearTimeout(timeout);
          reject(new Error(`Fork anvil exited with code ${code}`));
        }
      });

      // Start checking after a small delay to let anvil start
      setTimeout(check, 200);
    });

    const systemWallet = new Wallet(this.config.systemPrivateKey, provider);

    return { provider, systemWallet, process: anvilProcess };
  }

  // ============ Historical Event Replay ============

  /**
   * Replay historical L1 events to catch up to the current L1 state.
   * This is called on startup to sync the fullnode with L1.
   */
  private async replayHistoricalEvents(): Promise<void> {
    log("Fullnode", "Replaying historical L1 events...");

    // Get current L1 state
    const l1StateHash = await this.rollupCore.l2BlockHash();
    const currentStateHash = await this.nativerollup_getStateRoot();

    if (currentStateHash.toLowerCase() === l1StateHash.toLowerCase()) {
      log("Fullnode", "  Already synced with L1");
      return;
    }

    log("Fullnode", `  Current state: ${currentStateHash.slice(0, 18)}...`);
    log("Fullnode", `  L1 state: ${l1StateHash.slice(0, 18)}...`);

    // Fetch all historical events
    const l2BlockEvents = await this.rollupCore.queryFilter(
      this.rollupCore.filters.L2BlockProcessed(),
      0,
      "latest"
    );

    const incomingCallEvents = await this.rollupCore.queryFilter(
      this.rollupCore.filters.IncomingCallHandled(),
      0,
      "latest"
    );

    // Combine and sort by block number
    interface L1Event {
      type: "L2BlockProcessed" | "IncomingCallHandled";
      blockNumber: number;
      event: ethers.EventLog;
    }

    const allEvents: L1Event[] = [
      ...l2BlockEvents.map((e) => ({
        type: "L2BlockProcessed" as const,
        blockNumber: e.blockNumber,
        event: e as ethers.EventLog,
      })),
      ...incomingCallEvents.map((e) => ({
        type: "IncomingCallHandled" as const,
        blockNumber: e.blockNumber,
        event: e as ethers.EventLog,
      })),
    ];

    allEvents.sort((a, b) => a.blockNumber - b.blockNumber);

    log("Fullnode", `  Found ${allEvents.length} events to replay`);

    // Replay each event
    for (const { type, blockNumber, event } of allEvents) {
      const prevState = await this.nativerollup_getStateRoot();

      if (type === "L2BlockProcessed") {
        const { prevBlockHash, newBlockHash, rlpEncodedTx } = event.args;

        // Check if this event applies to our current state
        if (prevBlockHash.toLowerCase() !== prevState.toLowerCase()) {
          continue; // Skip, not applicable to current state
        }

        log("Fullnode", `  Replaying L2BlockProcessed from L1 #${blockNumber}`);

        if (rlpEncodedTx && rlpEncodedTx !== "0x") {
          await this.nativerollup_executeL2Transaction(rlpEncodedTx);
        }
      } else {
        const { l2Address, l1Caller, prevBlockHash, callData, value, finalStateHash } = event.args;

        // Check if this event applies to our current state
        if (prevBlockHash.toLowerCase() !== prevState.toLowerCase()) {
          continue; // Skip, not applicable to current state
        }

        log("Fullnode", `  Replaying IncomingCallHandled from L1 #${blockNumber}`);

        await this.nativerollup_executeL1ToL2Call({
          l1Caller,
          l2Target: l2Address,
          callData,
          value: value.toString(),
          currentStateRoot: prevBlockHash,
        });
      }
    }

    // Verify we're now synced
    const finalState = await this.nativerollup_getStateRoot();
    if (finalState.toLowerCase() === l1StateHash.toLowerCase()) {
      log("Fullnode", `  Synced! State: ${finalState.slice(0, 18)}...`);
    } else {
      log("Fullnode", `  WARNING: Not fully synced!`);
      log("Fullnode", `    Fullnode: ${finalState.slice(0, 18)}...`);
      log("Fullnode", `    L1:       ${l1StateHash.slice(0, 18)}...`);
    }
  }

  // ============ L1 Event Watching ============

  private lastPolledBlock: number = 0;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  private watchL1Events(): void {
    log("Fullnode", "Watching L1 events (polling mode)...");

    // Poll every 2 seconds for new events
    this.pollTimer = setInterval(() => {
      this.pollL1Events();
    }, 2000);

    // Initial poll
    this.pollL1Events();
  }

  private pollL1Events(): void {
    this.eventQueue = this.eventQueue.then(async () => {
      try {
        const currentBlock = await this.l1Provider.getBlockNumber();
        if (currentBlock <= this.lastPolledBlock) return;

        const fromBlock = this.lastPolledBlock + 1;
        this.lastPolledBlock = currentBlock;

        // Query both event types in the new block range
        const [incomingCallEvents, l2BlockEvents] = await Promise.all([
          this.rollupCore.queryFilter(
            this.rollupCore.filters.IncomingCallHandled(),
            fromBlock,
            currentBlock
          ),
          this.rollupCore.queryFilter(
            this.rollupCore.filters.L2BlockProcessed(),
            fromBlock,
            currentBlock
          ),
        ]);

        if (incomingCallEvents.length === 0 && l2BlockEvents.length === 0) return;

        // Merge and sort by block number then log index
        const allEvents = [
          ...incomingCallEvents.map(e => ({ type: 'incoming' as const, event: e, block: e.blockNumber, index: e.index })),
          ...l2BlockEvents.map(e => ({ type: 'l2block' as const, event: e, block: e.blockNumber, index: e.index })),
        ].sort((a, b) => a.block !== b.block ? a.block - b.block : a.index - b.index);

        log("Fullnode", `Poll: ${allEvents.length} new event(s) in blocks ${fromBlock}-${currentBlock}`);

        for (const entry of allEvents) {
          if (entry.type === 'incoming') {
            const e = entry.event;
            const args = (e as any).args;
            const l2Address = args.l2Address;
            const l1Caller = args.l1Caller;
            const finalStateHash = args.finalStateHash;
            const callData = args.callData;
            const value = args.value;

            log("Fullnode", `IncomingCallHandled event:`);
            log("Fullnode", `  L2 address: ${l2Address}`);
            log("Fullnode", `  L1 caller: ${l1Caller}`);
            log("Fullnode", `  Final state: ${finalStateHash}`);

            const currentState = await this.nativerollup_getStateRoot();
            if (currentState.toLowerCase() === finalStateHash.toLowerCase()) {
              log("Fullnode", `  Already at expected state (builder executed)`);
              continue;
            }

            await this.nativerollup_executeL1ToL2Call({
              l1Caller,
              l2Target: l2Address,
              callData,
              value: value.toString(),
              currentStateRoot: currentState,
            });
          } else if (entry.type === 'l2block') {
            const e = entry.event;
            const args = (e as any).args;
            const blockNumber = args.blockNumber;
            const newBlockHash = args.newBlockHash;
            const rlpEncodedTx = args.rlpEncodedTx;

            log("Fullnode", `L2BlockProcessed event:`);
            log("Fullnode", `  Block: ${blockNumber}`);
            log("Fullnode", `  New hash: ${newBlockHash}`);

            const currentState = await this.nativerollup_getStateRoot();
            if (currentState.toLowerCase() === newBlockHash.toLowerCase()) {
              log("Fullnode", `  Already at expected state`);
              continue;
            }

            if (rlpEncodedTx && rlpEncodedTx !== "0x") {
              await this.nativerollup_executeL2Transaction(rlpEncodedTx);
            }
          }
        }
      } catch (err: any) {
        log("Fullnode", `Poll error: ${err.message}`);
      }
    }).catch(err => {
      log("Fullnode", `Event queue error: ${err.message}`);
    });
  }

  // ============ Getters ============

  getL2Url(): string {
    return `http://localhost:${this.config.l2Port}`;
  }

  getRpcUrl(): string {
    return `http://localhost:${this.config.rpcPort}`;
  }
}

// ============ Main ============

async function main() {
  const config: Partial<L2FullnodeConfig> = {};

  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--l1-rpc":
        config.l1Rpc = args[++i];
        break;
      case "--rollup":
        config.rollupAddress = args[++i];
        break;
      case "--l2-port":
        config.l2Port = parseInt(args[++i]);
        break;
      case "--rpc-port":
        config.rpcPort = parseInt(args[++i]);
        break;
    }
  }

  if (!config.rollupAddress && !process.env.ROLLUP_ADDRESS) {
    console.error("Error: --rollup <address> required");
    process.exit(1);
  }

  const fullnode = new L2Fullnode(config);

  process.on("SIGINT", async () => {
    await fullnode.stop();
    process.exit(0);
  });

  await fullnode.start();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
