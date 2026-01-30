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
  Transaction,
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
  l1StartBlock: number;     // L1 block to start scanning events from (0 = genesis)
  ignoreStateMismatch: boolean; // Skip prevBlockHash checks during replay (for testing with changed L2 system contracts)
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
  l1StartBlock: parseInt(process.env.L1_START_BLOCK || "0"),
  ignoreStateMismatch: false,
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
  "function getReturnValue(bytes32 callKey) returns (bool registered, bytes memory returnData)",
  "function clearReturnValues(bytes32[] calldata callKeys)",
  "function isRegistered(bytes32 callKey) view returns (bool)",
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

      case "nativerollup_ensureL1SenderProxyL2":
        return this.nativerollup_ensureL1SenderProxyL2(params[0]);

      case "nativerollup_verifyStateChain":
        return this.nativerollup_verifyStateChain(params[0]);

      case "nativerollup_registerL2OutgoingCallResult":
        return this.nativerollup_registerL2OutgoingCallResult(params[0]);

      case "nativerollup_executeL2TransactionWithOutgoingCalls":
        return this.nativerollup_executeL2TransactionWithOutgoingCalls(params[0], params[1], params[2]);

      case "nativerollup_detectL2OutgoingCalls":
        return this.nativerollup_detectL2OutgoingCalls(params[0], params[1]);

      case "nativerollup_detectOutgoingCallsFromL1ToL2Call":
        return this.nativerollup_detectOutgoingCallsFromL1ToL2Call(params[0]);

      case "nativerollup_executeL1ToL2CallWithOutgoingCalls":
        return this.nativerollup_executeL1ToL2CallWithOutgoingCalls(params[0], params[1], params[2]);

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
      let txHash: string;
      try {
        txHash = await this.l2Provider.send("eth_sendRawTransaction", [rawTx]);
      } catch (sendErr: any) {
        const errMsg = sendErr.info?.error?.message || sendErr.error?.message || sendErr.message || "";
        if (errMsg.includes("already imported") || errMsg.includes("already known")) {
          // Transaction is stuck in the pending pool from a prior attempt.
          // Drop all pending transactions and retry.
          log("Fullnode", `  Transaction already in pool, clearing pending txs and retrying...`);
          await this.l2Provider.send("anvil_dropAllTransactions", []);
          txHash = await this.l2Provider.send("eth_sendRawTransaction", [rawTx]);
        } else {
          throw sendErr;
        }
      }
      log("Fullnode", `  TX Hash: ${txHash}`);

      // Mine a block first to include the transaction
      log("Fullnode", `  Mining block...`);
      await this.l2Provider.send("evm_mine", []);

      log("Fullnode", `  Getting receipt...`);
      const receipt = await this.l2Provider.getTransactionReceipt(txHash);
      log("Fullnode", `  Receipt status: ${receipt?.status}`);

      if (!receipt) {
        const tx = Transaction.from(rawTx);
        const expectedNonce = await this.l2Provider.send("eth_getTransactionCount", [tx.from!, "latest"]);
        log("Fullnode", `  TX not mined! TX nonce: ${tx.nonce}, account nonce: ${parseInt(expectedNonce, 16)}`);
        return {
          success: false,
          txHash,
          returnData: "0x",
          newStateRoot: await this.nativerollup_getStateRoot(),
          gasUsed: "0",
          logs: [],
          error: `L2 transaction not mined (tx nonce: ${tx.nonce}, expected: ${parseInt(expectedNonce, 16)}). Reset your wallet nonce.`,
        };
      }

      const newStateRoot = await this.nativerollup_getStateRoot();
      log("Fullnode", `  New state root: ${newStateRoot}`);

      return {
        success: receipt.status === 1,
        txHash,
        returnData: "0x",
        newStateRoot,
        gasUsed: (receipt.gasUsed || 0n).toString(),  // Convert bigint to string for JSON
        logs: [],
      };
    } catch (err: any) {
      // Extract more specific error info
      let errorMsg = err.message;
      if (err.info?.error?.message) {
        errorMsg = err.info.error.message;
      } else if (err.error?.message) {
        errorMsg = err.error.message;
      }
      log("Fullnode", `  Error: ${errorMsg}`);
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
   * Ensure an L1SenderProxyL2 is deployed for the given L1 address.
   * Deploys it if not already deployed, then mines the block.
   */
  async nativerollup_ensureL1SenderProxyL2(l1Address: string): Promise<string> {
    const existing = this.l1ProxyAddresses.get(l1Address.toLowerCase());
    if (existing) return existing;

    log("Fullnode", `Deploying L1SenderProxyL2 for ${l1Address}...`);
    const address = await this.deployL1SenderProxyL2(
      l1Address,
      this.l2Provider,
      this.systemWallet,
      true
    );

    // Mine the block to include the deploy tx
    await this.l2Provider.send("evm_mine", []);
    log("Fullnode", `  L1SenderProxyL2 deployed at ${address}`);
    return address;
  }

  /**
   * Register a return value in L2CallRegistry for an L2→L1 outgoing call.
   * This must be called BEFORE executing the L2 tx that makes the outgoing call.
   *
   * The callKey is: keccak256(abi.encodePacked(l1Address, l2Caller, callData))
   * where l1Address is the actual L1 contract, l2Caller is the L2 contract calling,
   * and callData is the function selector + args sent to the L1 proxy.
   *
   * @param l1Address The L1 contract address being called (the L1SenderProxyL2's l1Address)
   * @param l2Caller The L2 contract making the outgoing call
   * @param callData The calldata sent to the proxy (function selector + args)
   * @param returnData The pre-computed return data from the L1 call
   */
  async nativerollup_registerL2OutgoingCallResult(params: {
    l1Address: string;
    l2Caller: string;
    callData: string;
    returnData: string;
  }): Promise<{ callKey: string; txHash: string }> {
    log("Fullnode", `Registering L2→L1 outgoing call result:`);
    log("Fullnode", `  L1 address: ${params.l1Address}`);
    log("Fullnode", `  L2 caller: ${params.l2Caller}`);
    log("Fullnode", `  Calldata: ${params.callData.slice(0, 10)}...`);
    log("Fullnode", `  Return data: ${(params.returnData || "0x").slice(0, 42)}...`);

    // Compute the call key (must match L1SenderProxyL2.fallback)
    const callKey = ethers.keccak256(
      ethers.solidityPacked(
        ["address", "address", "bytes"],
        [params.l1Address, params.l2Caller, params.callData]
      )
    );
    log("Fullnode", `  Call key: ${callKey}`);

    // Register in L2CallRegistry via system address
    if (!this.l2CallRegistryAddress) {
      throw new Error("L2CallRegistry not deployed");
    }

    const registry = new Contract(
      this.l2CallRegistryAddress,
      L2_CALL_REGISTRY_ABI,
      this.systemWallet
    );

    let nonce = parseInt(
      await this.l2Provider.send("eth_getTransactionCount", [
        this.systemWallet.address, "pending"
      ]), 16
    );

    // Clear any stale entry for this key first
    await registry.clearReturnValues([callKey], { nonce: nonce++, gasPrice: 0 });

    const tx = await registry.registerReturnValue(
      callKey,
      params.returnData || "0x",
      { nonce: nonce, gasPrice: 0 }
    );

    // Mine clear + registration
    await this.l2Provider.send("evm_mine", []);
    const receipt = await tx.wait();

    log("Fullnode", `  Registered! TX: ${receipt?.hash}`);

    return { callKey, txHash: receipt?.hash || "" };
  }

  /**
   * Execute an L2 transaction that has outgoing L1 calls.
   *
   * This method:
   * 1. Pre-registers each outgoing call's return value in L2CallRegistry
   * 2. Executes the L2 transaction
   * 3. Returns the execution result
   *
   * Used by both:
   * - The builder (on its private fullnode during simulation)
   * - The read-only fullnode (during L1 event replay)
   *
   * @param rawTx The RLP-encoded signed L2 transaction
   * @param outgoingCalls Array of outgoing call details (from, target, data, etc.)
   * @param outgoingCallResults The return data for each outgoing call
   */
  async nativerollup_executeL2TransactionWithOutgoingCalls(
    rawTx: string,
    outgoingCalls: Array<{
      from: string;   // L2 contract making the call
      target: string; // L1 contract being called (via proxy)
      data: string;   // Calldata to the L1 function
    }>,
    outgoingCallResults: string[]
  ): Promise<ExecutionResult> {
    log("Fullnode", `Executing L2 transaction with ${outgoingCalls.length} outgoing call(s)...`);

    if (!this.l2CallRegistryAddress) {
      throw new Error("L2CallRegistry not deployed");
    }

    const registry = new Contract(
      this.l2CallRegistryAddress,
      L2_CALL_REGISTRY_ABI,
      this.systemWallet
    );

    // Step 0: Ensure L1SenderProxyL2 is deployed for each L1 target address
    // The proxy must exist so the L2 tx can call it (triggering registry lookup)
    const uniqueTargets = [...new Set(outgoingCalls.map(c => c.target.toLowerCase()))];
    for (const target of uniqueTargets) {
      const isDeployed = this.l1ProxyAddresses.has(target);
      if (!isDeployed) {
        log("Fullnode", `  Deploying L1SenderProxyL2 for L1:${target}...`);
        await this.deployL1SenderProxyL2(target, this.l2Provider, this.systemWallet, true);
      }
    }
    // Proxy deploy txs are in the mempool — they'll be mined with registrations + L2 tx

    // Step 1: Clear any stale registry entries for these call keys, then register new values.
    // This ensures repeated calls to the same L1 function get fresh return values.
    let nonce = parseInt(
      await this.l2Provider.send("eth_getTransactionCount", [
        this.systemWallet.address, "pending"
      ]), 16
    );

    // Compute all call keys and clear stale entries
    const allCallKeys = outgoingCalls.map(call =>
      ethers.keccak256(
        ethers.solidityPacked(
          ["address", "address", "bytes"],
          [call.target, call.from, call.data]
        )
      )
    );
    const uniqueCallKeys = [...new Set(allCallKeys)];
    // Clear in mempool (will be mined with registrations)
    await registry.clearReturnValues(uniqueCallKeys, { nonce: nonce++, gasPrice: 0 });
    log("Fullnode", `  Clearing ${uniqueCallKeys.length} stale registry key(s)`);

    for (let i = 0; i < outgoingCalls.length; i++) {
      const call = outgoingCalls[i];
      const result = outgoingCallResults[i] || "0x";

      // Compute the call key (must match L1SenderProxyL2.fallback):
      //   callKey = keccak256(l1Address, msg.sender, msg.data)
      // where l1Address = call.target (L1 contract), msg.sender = call.from (L2 caller)
      const callKey = ethers.keccak256(
        ethers.solidityPacked(
          ["address", "address", "bytes"],
          [call.target, call.from, call.data]
        )
      );

      log("Fullnode", `  Registering outgoing call ${i}: ${call.from} → ${call.target}`);
      log("Fullnode", `    Calldata: ${call.data.slice(0, 10)}...`);
      log("Fullnode", `    Return: ${result.slice(0, 42)}${result.length > 42 ? '...' : ''}`);
      log("Fullnode", `    Call key: ${callKey}`);

      // Send to mempool — do NOT mine yet.
      // Use very high gasPrice to ensure Anvil orders registrations before user txs.
      await registry.registerReturnValue(callKey, result, { nonce: nonce++, gasPrice: 0 });
      log("Fullnode", `    Registration tx sent (nonce ${nonce - 1})`);
    }

    // Step 2: Mine registrations (+ any proxy deploys) in their own block.
    // This must happen before the user tx because Anvil orders by gas price,
    // and user txs from real wallets have higher gas price than system txs (gasPrice 0).
    log("Fullnode", `  Mining registration block...`);
    await this.l2Provider.send("evm_mine", []);

    // Step 3: Send the L2 user tx and mine it
    log("Fullnode", `  Sending L2 tx...`);
    let txHash: string;
    try {
      txHash = await this.l2Provider.send("eth_sendRawTransaction", [rawTx]);
    } catch (sendErr: any) {
      const errMsg = sendErr.info?.error?.message || sendErr.error?.message || sendErr.message || "";
      if (errMsg.includes("already imported") || errMsg.includes("already known")) {
        log("Fullnode", `  Transaction already in pool, clearing and retrying...`);
        await this.l2Provider.send("anvil_dropAllTransactions", []);
        txHash = await this.l2Provider.send("eth_sendRawTransaction", [rawTx]);
      } else {
        throw sendErr;
      }
    }
    log("Fullnode", `  TX Hash: ${txHash}`);

    log("Fullnode", `  Mining L2 tx block...`);
    await this.l2Provider.send("evm_mine", []);

    // Get the receipt
    const receipt = await this.l2Provider.getTransactionReceipt(txHash);
    log("Fullnode", `  Receipt status: ${receipt?.status}`);

    if (!receipt) {
      // TX was not mined — likely nonce mismatch
      const tx = Transaction.from(rawTx);
      const expectedNonce = await this.l2Provider.send("eth_getTransactionCount", [tx.from!, "latest"]);
      log("Fullnode", `  TX not mined! TX nonce: ${tx.nonce}, account nonce: ${parseInt(expectedNonce, 16)}`);
      return {
        success: false,
        txHash,
        returnData: "0x",
        newStateRoot: await this.nativerollup_getStateRoot(),
        gasUsed: "0",
        logs: [],
        error: `L2 transaction not mined (tx nonce: ${tx.nonce}, expected: ${parseInt(expectedNonce, 16)}). Reset your wallet nonce.`,
      };
    }

    const newStateRoot = await this.nativerollup_getStateRoot();
    log("Fullnode", `  New state root: ${newStateRoot}`);

    return {
      success: receipt.status === 1,
      txHash,
      returnData: "0x",
      newStateRoot,
      gasUsed: (receipt.gasUsed || 0n).toString(),
      logs: [],
      error: receipt.status === 1 ? undefined : "L2 transaction reverted",
    };
  }

  /**
   * Detect outgoing L2→L1 calls in an L2 transaction by tracing it.
   *
   * Traces the transaction and looks for calls to L1SenderProxyL2 contracts
   * from non-system addresses (which indicates an L2→L1 outgoing call).
   *
   * Returns the list of outgoing calls detected.
   */
  async nativerollup_detectL2OutgoingCalls(rawTx: string, l1Addresses?: string[]): Promise<Array<{
    l2Caller: string;
    proxyAddress: string;
    l1Address: string;
    callData: string;
    value: string; // hex-encoded value
  }>> {
    log("Fullnode", `Detecting L2→L1 outgoing calls...`);

    // Parse the transaction to get from/to/data
    const tx = Transaction.from(rawTx);
    log("Fullnode", `  TX from: ${tx.from}, to: ${tx.to}`);

    // If L1 addresses are provided, ensure their L2 proxies are deployed (in a snapshot)
    // This is needed so the trace can identify calls to proxy contracts
    let snapshotId: string | null = null;
    if (l1Addresses && l1Addresses.length > 0) {
      snapshotId = await this.l2Provider.send("evm_snapshot", []);
      for (const l1Addr of l1Addresses) {
        const isDeployed = this.l1ProxyAddresses.has(l1Addr.toLowerCase());
        if (!isDeployed) {
          log("Fullnode", `  Temporarily deploying L1SenderProxyL2 for ${l1Addr}...`);
          await this.deployL1SenderProxyL2(l1Addr, this.l2Provider, this.systemWallet, false);
          await this.l2Provider.send("evm_mine", []);
        }
      }
    }

    // Trace the transaction using debug_traceCall
    let traceResult: any;
    try {
      traceResult = await this.l2Provider.send("debug_traceCall", [
        {
          from: tx.from,
          to: tx.to,
          data: tx.data,
          value: tx.value ? ethers.toQuantity(tx.value) : "0x0",
          gas: tx.gasLimit ? ethers.toQuantity(tx.gasLimit) : "0x1000000",
        },
        "latest",
        { tracer: "callTracer", tracerConfig: { withLog: false } },
      ]);
    } catch (err: any) {
      log("Fullnode", `  Trace failed: ${err.message}`);
      // The tx might revert because outgoing calls are not registered yet
      // Try to parse the error data as trace result
      const errorData = err.info?.error?.data;
      if (errorData && typeof errorData === "object") {
        traceResult = errorData;
        log("Fullnode", `  Recovered trace from error data`);
      } else {
        if (snapshotId) await this.l2Provider.send("evm_revert", [snapshotId]);
        return [];
      }
    }

    // Find calls to L1SenderProxyL2 contracts
    const outgoingCalls: Array<{
      l2Caller: string;
      proxyAddress: string;
      l1Address: string;
      callData: string;
      value: string;
    }> = [];

    const findOutgoingCalls = async (call: any, depth: number = 0) => {
      if (!call.to) return;

      // Check if this call target is an L1SenderProxyL2
      // We can check by looking at the factory's proxies mapping
      // or by checking if the address has the L1SenderProxyL2 code pattern
      const targetAddr = call.to.toLowerCase();

      // Check if this is a known L1SenderProxyL2 by trying to read l1Address()
      try {
        const proxyContract = new Contract(
          targetAddr,
          L1_SENDER_PROXY_L2_ABI,
          this.l2Provider
        );
        const l1Addr = await proxyContract.l1Address();
        const sysAddr = await proxyContract.systemAddress();

        // It's a proxy! Check if caller is NOT the system address
        const callerAddr = (call.from || "").toLowerCase();
        if (callerAddr !== sysAddr.toLowerCase()) {
          // This is an L2→L1 outgoing call
          log("Fullnode", `  Found outgoing call at depth ${depth}:`);
          log("Fullnode", `    L2 caller: ${callerAddr}`);
          log("Fullnode", `    Proxy: ${targetAddr}`);
          log("Fullnode", `    L1 address: ${l1Addr}`);
          log("Fullnode", `    Calldata: ${(call.input || "0x").slice(0, 10)}...`);
          log("Fullnode", `    Value: ${call.value || "0x0"}`);

          outgoingCalls.push({
            l2Caller: callerAddr,
            proxyAddress: targetAddr,
            l1Address: l1Addr,
            callData: call.input || "0x",
            value: call.value || "0x0",
          });
        }
      } catch {
        // Not a proxy, continue
      }

      // Recurse into subcalls
      if (call.calls) {
        for (const subcall of call.calls) {
          await findOutgoingCalls(subcall, depth + 1);
        }
      }
    };

    await findOutgoingCalls(traceResult);

    // Revert snapshot if we temporarily deployed proxies
    if (snapshotId) {
      await this.l2Provider.send("evm_revert", [snapshotId]);
      log("Fullnode", `  Reverted detection snapshot`);
    }

    log("Fullnode", `  Detected ${outgoingCalls.length} outgoing call(s)`);
    return outgoingCalls;
  }

  /**
   * Detect outgoing L2→L1 calls within an L1→L2 call.
   * Traces the proxy call on L2 and finds calls to L1SenderProxyL2 contracts.
   */
  async nativerollup_detectOutgoingCallsFromL1ToL2Call(params: L1ToL2CallParams): Promise<Array<{
    l2Caller: string;
    proxyAddress: string;
    l1Address: string;
    callData: string;
  }>> {
    log("Fullnode", `Detecting outgoing L2→L1 calls within L1→L2 call...`);

    // Get or deploy the proxy for the L1 caller (needed for tracing)
    let proxyAddress = this.l1ProxyAddresses.get(params.l1Caller.toLowerCase());
    if (!proxyAddress) {
      // Deploy the proxy so we can trace through it
      // The builder's outer snapshot will handle cleanup
      proxyAddress = await this.deployL1SenderProxyL2(
        params.l1Caller,
        this.l2Provider,
        this.systemWallet,
        true  // Store in proxy cache so executeL1ToL2CallWithOutgoingCalls can find it
      );
      // Mine to include the deploy tx
      await this.l2Provider.send("evm_mine", []);
      log("Fullnode", `  Deployed temp proxy for ${params.l1Caller}: ${proxyAddress}`);
    }

    // Build the packed calldata (same as executeL1ToL2CallOnProvider)
    const callData = params.callData || "0x";
    const packedCalldata = ethers.solidityPacked(
      ["address", "bytes"],
      [params.l2Target, callData]
    );

    // Trace the call
    let traceResult: any;
    try {
      traceResult = await this.l2Provider.send("debug_traceCall", [
        {
          from: this.systemWallet.address,
          to: proxyAddress,
          data: packedCalldata,
          value: params.value ? ethers.toQuantity(BigInt(params.value)) : "0x0",
          gas: "0x1000000",
        },
        "latest",
        { tracer: "callTracer", tracerConfig: { withLog: false } },
      ]);
    } catch (err: any) {
      log("Fullnode", `  Trace failed: ${err.message}`);
      return [];
    }

    // Reuse the same detection logic as nativerollup_detectL2OutgoingCalls
    const outgoingCalls: Array<{
      l2Caller: string;
      proxyAddress: string;
      l1Address: string;
      callData: string;
    }> = [];

    const findOutgoingCalls = async (call: any, depth: number = 0) => {
      if (!call.to) return;
      const targetAddr = call.to.toLowerCase();

      try {
        const proxyContract = new Contract(targetAddr, L1_SENDER_PROXY_L2_ABI, this.l2Provider);
        const l1Addr = await proxyContract.l1Address();
        const sysAddr = await proxyContract.systemAddress();

        const callerAddr = (call.from || "").toLowerCase();
        if (callerAddr !== sysAddr.toLowerCase()) {
          log("Fullnode", `  Found outgoing call at depth ${depth}:`);
          log("Fullnode", `    L2 caller: ${callerAddr}`);
          log("Fullnode", `    Proxy: ${targetAddr}`);
          log("Fullnode", `    L1 address: ${l1Addr}`);
          log("Fullnode", `    Calldata: ${(call.input || "0x").slice(0, 10)}...`);

          outgoingCalls.push({
            l2Caller: callerAddr,
            proxyAddress: targetAddr,
            l1Address: l1Addr,
            callData: call.input || "0x",
          });
        }
      } catch {
        // Not a proxy
      }

      if (call.calls) {
        for (const subcall of call.calls) {
          await findOutgoingCalls(subcall, depth + 1);
        }
      }
    };

    await findOutgoingCalls(traceResult);
    log("Fullnode", `  Detected ${outgoingCalls.length} outgoing call(s) within L1→L2 call`);
    return outgoingCalls;
  }

  /**
   * Execute an L1→L2 call that contains outgoing L2→L1 calls.
   * Pre-registers outgoing call results in L2CallRegistry, then executes the L1→L2 call.
   */
  async nativerollup_executeL1ToL2CallWithOutgoingCalls(
    params: L1ToL2CallParams,
    outgoingCalls: Array<{ from: string; target: string; data: string }>,
    outgoingCallResults: string[]
  ): Promise<ExecutionResult> {
    log("Fullnode", `Executing L1→L2 call with ${outgoingCalls.length} outgoing call(s)...`);

    if (!this.l2CallRegistryAddress) {
      throw new Error("L2CallRegistry not deployed");
    }

    const registry = new Contract(
      this.l2CallRegistryAddress,
      L2_CALL_REGISTRY_ABI,
      this.systemWallet
    );

    // Get or deploy proxy for L1 caller
    let proxyAddress = this.l1ProxyAddresses.get(params.l1Caller.toLowerCase());
    if (!proxyAddress) {
      proxyAddress = await this.deployL1SenderProxyL2(
        params.l1Caller,
        this.l2Provider,
        this.systemWallet,
        true
      );
    }

    // Build packed calldata
    const callData = params.callData || "0x";
    const packedCalldata = ethers.solidityPacked(
      ["address", "bytes"],
      [params.l2Target, callData]
    );

    // Get system nonce
    let nonce = parseInt(
      await this.l2Provider.send("eth_getTransactionCount", [
        this.systemWallet.address, "pending"
      ]), 16
    );

    // Step 1: Clear stale entries and register new return values
    const allCallKeys = outgoingCalls.map(call =>
      ethers.keccak256(
        ethers.solidityPacked(
          ["address", "address", "bytes"],
          [call.target, call.from, call.data]
        )
      )
    );
    if (allCallKeys.length > 0) {
      const uniqueCallKeys = [...new Set(allCallKeys)];
      await registry.clearReturnValues(uniqueCallKeys, { nonce: nonce++, gasPrice: 0 });
      log("Fullnode", `  Clearing ${uniqueCallKeys.length} stale registry key(s)`);
    }

    for (let i = 0; i < outgoingCalls.length; i++) {
      const call = outgoingCalls[i];
      const result = outgoingCallResults[i] || "0x";

      const callKey = ethers.keccak256(
        ethers.solidityPacked(
          ["address", "address", "bytes"],
          [call.target, call.from, call.data]
        )
      );

      log("Fullnode", `  Registering outgoing call ${i}: ${call.from} → ${call.target}`);
      log("Fullnode", `    Call key: ${callKey}`);

      await registry.registerReturnValue(callKey, result, { nonce: nonce++, gasPrice: 0 });
    }

    // Step 2: Send the L1→L2 proxy call to mempool
    log("Fullnode", `  Sending L1→L2 proxy call (nonce: ${nonce})...`);
    const txRequest = {
      to: proxyAddress,
      data: packedCalldata,
      value: BigInt(params.value || "0"),
      gasLimit: 10000000n,
      nonce: nonce,
    };
    const tx = await this.systemWallet.sendTransaction(txRequest);

    // Step 3: Mine single block with everything
    await this.l2Provider.send("evm_mine", []);

    const receipt = await tx.wait();
    const newStateRoot = await this.nativerollup_getStateRoot();

    log("Fullnode", `  Receipt status: ${receipt?.status}`);
    log("Fullnode", `  New state root: ${newStateRoot}`);

    // Capture return data
    let returnData = "0x";
    try {
      returnData = await this.l2Provider.send("eth_call", [
        {
          from: this.systemWallet.address,
          to: proxyAddress,
          data: packedCalldata,
          value: params.value ? ethers.toQuantity(BigInt(params.value)) : "0x0",
        },
        "latest",
      ]);
    } catch {
      // state-changing call, return data not available via eth_call after state change
    }

    return {
      success: receipt?.status === 1,
      txHash: receipt?.hash || "",
      returnData,
      newStateRoot,
      gasUsed: (receipt?.gasUsed || 0n).toString(),
      logs: [],
    };
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
      const tx = await factory.deployProxy(l1Address, { nonce: parseInt(nonceHex, 16), gasLimit: 2000000n, gasPrice: 0 });
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
    const fromBlock = this.config.l1StartBlock || 0;
    const l2BlockEvents = await this.rollupCore.queryFilter(
      this.rollupCore.filters.L2BlockProcessed(),
      fromBlock,
      "latest"
    );

    const incomingCallEvents = await this.rollupCore.queryFilter(
      this.rollupCore.filters.IncomingCallHandled(),
      fromBlock,
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
        const { prevBlockHash, newBlockHash, rlpEncodedTx, outgoingCalls: evtOutgoingCalls, outgoingCallResults: evtResults } = event.args;

        // Check if this event applies to our current state
        if (prevBlockHash.toLowerCase() !== prevState.toLowerCase()) {
          if (!this.config.ignoreStateMismatch) {
            continue; // Skip, not applicable to current state
          }
          log("Fullnode", `  State mismatch (ignored): expected ${prevBlockHash.slice(0, 18)}..., have ${prevState.slice(0, 18)}...`);
        }

        log("Fullnode", `  Replaying L2BlockProcessed from L1 #${blockNumber}`);

        if (rlpEncodedTx && rlpEncodedTx !== "0x") {
          // Check if there are outgoing calls that need pre-registration
          if (evtOutgoingCalls && evtOutgoingCalls.length > 0) {
            const calls = evtOutgoingCalls.map((c: any) => ({
              from: c.from,
              target: c.target,
              data: c.data,
            }));
            const results = evtResults || [];
            log("Fullnode", `    With ${calls.length} outgoing call(s)`);
            await this.nativerollup_executeL2TransactionWithOutgoingCalls(
              rlpEncodedTx, calls, results
            );
          } else {
            await this.nativerollup_executeL2Transaction(rlpEncodedTx);
          }
        }
      } else {
        const { l2Address, l1Caller, prevBlockHash, callData, value, outgoingCalls: evtOutgoingCalls, outgoingCallResults: evtResults, finalStateHash } = event.args;

        // Check if this event applies to our current state
        if (prevBlockHash.toLowerCase() !== prevState.toLowerCase()) {
          if (!this.config.ignoreStateMismatch) {
            continue; // Skip, not applicable to current state
          }
          log("Fullnode", `  State mismatch (ignored): expected ${prevBlockHash.slice(0, 18)}..., have ${prevState.slice(0, 18)}...`);
        }

        log("Fullnode", `  Replaying IncomingCallHandled from L1 #${blockNumber}`);

        if (evtOutgoingCalls && evtOutgoingCalls.length > 0) {
          const calls = evtOutgoingCalls.map((c: any) => ({
            from: c.from,
            target: c.target,
            data: c.data,
          }));
          const results = evtResults || [];
          log("Fullnode", `    With ${calls.length} outgoing L2→L1 call(s)`);
          await this.nativerollup_executeL1ToL2CallWithOutgoingCalls(
            { l1Caller, l2Target: l2Address, callData, value: value.toString(), currentStateRoot: prevBlockHash },
            calls,
            results
          );
        } else {
          await this.nativerollup_executeL1ToL2Call({
            l1Caller,
            l2Target: l2Address,
            callData,
            value: value.toString(),
            currentStateRoot: prevBlockHash,
          });
        }
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
            const evtOutgoingCalls = args.outgoingCalls;
            const evtResults = args.outgoingCallResults;

            log("Fullnode", `IncomingCallHandled event:`);
            log("Fullnode", `  L2 address: ${l2Address}`);
            log("Fullnode", `  L1 caller: ${l1Caller}`);
            log("Fullnode", `  Final state: ${finalStateHash}`);

            const currentState = await this.nativerollup_getStateRoot();
            if (currentState.toLowerCase() === finalStateHash.toLowerCase()) {
              log("Fullnode", `  Already at expected state (builder executed)`);
              continue;
            }

            if (evtOutgoingCalls && evtOutgoingCalls.length > 0) {
              const calls = evtOutgoingCalls.map((c: any) => ({
                from: c.from,
                target: c.target,
                data: c.data,
              }));
              const results = evtResults || [];
              log("Fullnode", `  With ${calls.length} outgoing L2→L1 call(s)`);
              await this.nativerollup_executeL1ToL2CallWithOutgoingCalls(
                { l1Caller, l2Target: l2Address, callData, value: value.toString(), currentStateRoot: currentState },
                calls,
                results
              );
            } else {
              await this.nativerollup_executeL1ToL2Call({
                l1Caller,
                l2Target: l2Address,
                callData,
                value: value.toString(),
                currentStateRoot: currentState,
              });
            }
          } else if (entry.type === 'l2block') {
            const e = entry.event;
            const args = (e as any).args;
            const blockNumber = args.blockNumber;
            const newBlockHash = args.newBlockHash;
            const rlpEncodedTx = args.rlpEncodedTx;
            const evtOutgoingCalls = args.outgoingCalls;
            const evtResults = args.outgoingCallResults;

            log("Fullnode", `L2BlockProcessed event:`);
            log("Fullnode", `  Block: ${blockNumber}`);
            log("Fullnode", `  New hash: ${newBlockHash}`);

            const currentState = await this.nativerollup_getStateRoot();
            if (currentState.toLowerCase() === newBlockHash.toLowerCase()) {
              log("Fullnode", `  Already at expected state`);
              continue;
            }

            if (rlpEncodedTx && rlpEncodedTx !== "0x") {
              // Check if there are outgoing calls that need pre-registration
              if (evtOutgoingCalls && evtOutgoingCalls.length > 0) {
                const calls = evtOutgoingCalls.map((c: any) => ({
                  from: c.from,
                  target: c.target,
                  data: c.data,
                }));
                const results = evtResults || [];
                log("Fullnode", `  With ${calls.length} outgoing call(s)`);
                await this.nativerollup_executeL2TransactionWithOutgoingCalls(
                  rlpEncodedTx, calls, results
                );
              } else {
                await this.nativerollup_executeL2Transaction(rlpEncodedTx);
              }
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
      case "--l1-start-block":
        config.l1StartBlock = parseInt(args[++i]);
        break;
      case "--ignore-state-mismatch":
        config.ignoreStateMismatch = true;
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
