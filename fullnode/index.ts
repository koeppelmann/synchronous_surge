/**
 * Native Rollup L2 Fullnode
 *
 * A deterministic L2 state machine that syncs from L1.
 * Given an L1 RPC endpoint and knowledge of NativeRollupCore,
 * this fullnode can reconstruct the complete L2 state.
 *
 * Core principle: L2 state is a PURE FUNCTION of L1 state.
 *
 * Key design (matching builder):
 * - L2 System Address is pre-funded in genesis (10 billion xDAI)
 * - ALL L2 transactions originate from the system address
 * - L1 callers are represented by L1SenderProxyL2 contracts on L2
 * - System address calls proxy, proxy forwards to target
 *
 * Events processed:
 * 1. L2BlockProcessed: L2→L1 flow (processCallOnL2)
 * 2. IncomingCallHandled: L1→L2 flow (deposits, calls)
 */

import {
  ethers,
  Contract,
  ContractFactory,
  JsonRpcProvider,
  AbiCoder,
  keccak256,
} from "ethers";
import { spawn, ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";

// ============ Configuration ============

export interface FullnodeConfig {
  l1Rpc: string;
  rollupAddress: string;
  l2Port: number;
  l2ChainId: number;
  startFromBlock?: number;
}

const DEFAULT_CONFIG: FullnodeConfig = {
  l1Rpc: process.env.L1_RPC || "https://rpc.gnosischain.com",
  // NativeRollupCore with processL2Transaction support
  rollupAddress:
    process.env.ROLLUP_ADDRESS || "0xB98fA7a61102e6dA6dd67a4dC8F69013FF3872E1",
  l2Port: parseInt(process.env.L2_PORT || "9546"),
  l2ChainId: parseInt(process.env.L2_CHAIN_ID || "10200200"),
  startFromBlock: 0,
};

// ============ Constants ============

/**
 * L2 System Address - computed as:
 * keccak256(encode("NativeRollup.L1SenderProxy.v1", NativeRollupCoreAddress))
 *
 * MUST match the builder's L2_SYSTEM_ADDRESS.
 * Pre-funded in genesis with 10 billion xDAI.
 *
 * Computed for NativeRollupCore at 0xBdec2590117ED5D3ec3dca8EcC1E5d2CbEaedfAf
 */
export const L2_SYSTEM_ADDRESS = "0x7d1cc88909370e00d3ca1fd72d9b45b8f1412215";

/**
 * Genesis balance for L2 system address (10 billion xDAI in wei)
 */
export const L2_SYSTEM_BALANCE = ethers.parseEther("10000000000");

// ============ ABI ============

const ROLLUP_ABI = [
  "event L2BlockProcessed(uint256 indexed blockNumber, bytes32 indexed prevBlockHash, bytes32 indexed newBlockHash, uint256 outgoingCallsCount)",
  "event OutgoingCallExecuted(uint256 indexed blockNumber, uint256 indexed callIndex, address indexed from, address target, bool success)",
  "event L2SenderProxyDeployed(address indexed l2Address, address indexed proxyAddress)",
  "event IncomingCallRegistered(address indexed l2Address, bytes32 indexed stateHash, bytes32 indexed callDataHash, bytes32 responseKey)",
  "event IncomingCallHandled(address indexed l2Address, bytes32 indexed responseKey, uint256 outgoingCallsCount, uint256 value)",
  "event L2TransactionProcessed(uint256 indexed blockNumber, bytes32 indexed txHash, address indexed from, bytes32 newStateHash)",
  "function l2BlockHash() view returns (bytes32)",
  "function l2BlockNumber() view returns (uint256)",
  "function getProxyAddress(address l2Address) view returns (address)",
  "function incomingCallResponses(bytes32) view returns (bytes32 preOutgoingCallsStateHash, bytes returnValue, bytes32 finalStateHash)",
  "function processCallOnL2(bytes32 prevL2BlockHash, bytes calldata callData, bytes32 postExecutionStateHash, tuple(address from, address target, uint256 value, uint256 gas, bytes data, bytes32 postCallStateHash)[] outgoingCalls, bytes[] expectedResults, bytes32 finalStateHash, bytes proof) payable",
  "function registerIncomingCall(address l2Address, bytes32 stateHash, bytes calldata callData, tuple(bytes32 preOutgoingCallsStateHash, tuple(address from, address target, uint256 value, uint256 gas, bytes data, bytes32 postCallStateHash)[] outgoingCalls, bytes[] expectedResults, bytes returnValue, bytes32 finalStateHash) response, bytes proof)",
  "function processL2Transaction(bytes rawTransaction, bytes32 finalStateHash, bytes proof)",
];

const L2_PROXY_FACTORY_ABI = [
  "function deployProxy(address l1Address) returns (address)",
  "function computeProxyAddress(address l1Address) view returns (address)",
  "function isProxyDeployed(address l1Address) view returns (bool)",
  "function getProxy(address l1Address) view returns (address)",
  "function proxies(address) view returns (address)",
];

// ============ Utility Functions ============

export function computeL2ProxyAddress(l1Address: string): string {
  const hash = keccak256(
    AbiCoder.defaultAbiCoder().encode(
      ["string", "address"],
      ["NativeRollup.L1SenderProxy.v1", l1Address]
    )
  );
  return "0x" + hash.slice(-40);
}

function getContractArtifact(contractName: string): { abi: any; bytecode: string } {
  // Try multiple possible paths
  const possiblePaths = [
    path.join(process.cwd(), `out/L1SenderProxyL2.sol/${contractName}.json`),
    path.join(process.cwd(), `../out/L1SenderProxyL2.sol/${contractName}.json`),
  ];

  for (const artifactPath of possiblePaths) {
    if (fs.existsSync(artifactPath)) {
      const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
      return {
        abi: artifact.abi,
        bytecode: artifact.bytecode.object,
      };
    }
  }

  throw new Error(`Contract artifact not found for ${contractName}. Run 'forge build' first.`);
}

// ============ L2 Fullnode ============

export interface SyncStatus {
  l2BlockNumber: number;
  l2BlockHash: string;
  l1BlockNumber: number;
  isSynced: boolean;
  processedL2Blocks: number;
  processedIncomingCalls: number;
  l2ProxyFactoryAddress: string | null;
  l2CallRegistryAddress: string | null;
}

export class L2Fullnode {
  private config: FullnodeConfig;
  private l1Provider: JsonRpcProvider;
  private l2Provider!: JsonRpcProvider;
  private rollupCore: Contract;
  private anvilProcess: ChildProcess | null = null;

  // L2 infrastructure
  private l2ProxyFactory: Contract | null = null;
  private l2CallRegistry: Contract | null = null;
  private l2ProxyFactoryAddress: string | null = null;
  private l2CallRegistryAddress: string | null = null;

  // Tracking state
  private processedL2Blocks: Set<number> = new Set();
  private processedIncomingCalls: Set<string> = new Set();
  private processedL2Transactions: Set<string> = new Set(); // Track by txHash
  private lastL1Block: number = 0;

  // Event handlers
  private onBlockProcessed?: (blockNumber: number, hash: string) => void;
  private onIncomingCallProcessed?: (l2Address: string, caller: string) => void;
  private onL2TransactionProcessed?: (txHash: string, from: string) => void;

  constructor(config: Partial<FullnodeConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.l1Provider = new JsonRpcProvider(this.config.l1Rpc);
    this.rollupCore = new Contract(
      this.config.rollupAddress,
      ROLLUP_ABI,
      this.l1Provider
    );
  }

  /**
   * Spawn L2 Anvil and set up genesis state (system address balance)
   */
  private async spawnL2Anvil(): Promise<void> {
    const l2Rpc = `http://localhost:${this.config.l2Port}`;

    console.log(`Spawning L2 Anvil on port ${this.config.l2Port}...`);

    this.anvilProcess = spawn("anvil", [
      "--port", this.config.l2Port.toString(),
      "--chain-id", this.config.l2ChainId.toString(),
      "--accounts", "0", // No pre-funded accounts - only system address gets funded
      "--silent",
    ], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Wait for Anvil to be ready
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Anvil failed to start within 10 seconds"));
      }, 10000);

      const checkReady = async () => {
        try {
          const provider = new JsonRpcProvider(l2Rpc);
          await provider.getBlockNumber();
          clearTimeout(timeout);
          resolve();
        } catch {
          setTimeout(checkReady, 100);
        }
      };

      this.anvilProcess!.on("error", (err) => {
        clearTimeout(timeout);
        reject(new Error(`Failed to spawn Anvil: ${err.message}`));
      });

      checkReady();
    });

    this.l2Provider = new JsonRpcProvider(l2Rpc);

    // Fund the L2 system address (MUST match builder exactly)
    console.log(`Funding L2 system address with 10B xDAI...`);
    await this.l2Provider.send("anvil_setBalance", [
      L2_SYSTEM_ADDRESS,
      "0x" + L2_SYSTEM_BALANCE.toString(16),
    ]);

    const balance = await this.l2Provider.getBalance(L2_SYSTEM_ADDRESS);
    console.log(`  System address balance: ${ethers.formatEther(balance)} xDAI`);

    console.log(`L2 Anvil ready at ${l2Rpc}`);
  }

  /**
   * Deploy L2 infrastructure contracts (MUST match builder exactly)
   */
  private async deployL2Infrastructure(): Promise<void> {
    console.log(`Deploying L2 infrastructure...`);

    await this.l2Provider.send("anvil_impersonateAccount", [L2_SYSTEM_ADDRESS]);
    const systemSigner = await this.l2Provider.getSigner(L2_SYSTEM_ADDRESS);

    // Deploy L2CallRegistry
    const registryArtifact = getContractArtifact("L2CallRegistry");
    const registryFactory = new ContractFactory(
      registryArtifact.abi,
      registryArtifact.bytecode,
      systemSigner
    );
    const registry = await registryFactory.deploy(L2_SYSTEM_ADDRESS);
    await registry.waitForDeployment();
    this.l2CallRegistryAddress = await registry.getAddress();
    this.l2CallRegistry = registry;
    console.log(`  L2CallRegistry deployed at: ${this.l2CallRegistryAddress}`);

    // Deploy L1SenderProxyL2Factory
    const factoryArtifact = getContractArtifact("L1SenderProxyL2Factory");
    const factoryFactory = new ContractFactory(
      factoryArtifact.abi,
      factoryArtifact.bytecode,
      systemSigner
    );
    const factory = await factoryFactory.deploy(L2_SYSTEM_ADDRESS, this.l2CallRegistryAddress);
    await factory.waitForDeployment();
    this.l2ProxyFactoryAddress = await factory.getAddress();
    this.l2ProxyFactory = new Contract(
      this.l2ProxyFactoryAddress,
      L2_PROXY_FACTORY_ABI,
      systemSigner
    );
    console.log(`  L1SenderProxyL2Factory deployed at: ${this.l2ProxyFactoryAddress}`);

    await this.l2Provider.send("anvil_stopImpersonatingAccount", [L2_SYSTEM_ADDRESS]);
  }

  /**
   * Ensure L1 caller has a proxy on L2
   */
  private async ensureL2Proxy(l1Address: string): Promise<string> {
    const isDeployed = await this.l2ProxyFactory!.isProxyDeployed(l1Address);

    if (isDeployed) {
      return await this.l2ProxyFactory!.getProxy(l1Address);
    }

    console.log(`  Deploying L2 proxy for L1 address ${l1Address}...`);

    await this.l2Provider.send("anvil_impersonateAccount", [L2_SYSTEM_ADDRESS]);
    const systemSigner = await this.l2Provider.getSigner(L2_SYSTEM_ADDRESS);

    const factoryWithSigner = this.l2ProxyFactory!.connect(systemSigner) as Contract;
    const tx = await factoryWithSigner.deployProxy(l1Address);
    await tx.wait();

    await this.l2Provider.send("anvil_stopImpersonatingAccount", [L2_SYSTEM_ADDRESS]);

    const proxyAddress = await this.l2ProxyFactory!.getProxy(l1Address);
    console.log(`  L2 proxy deployed at: ${proxyAddress}`);

    return proxyAddress;
  }

  /**
   * Get current sync status
   */
  async getStatus(): Promise<SyncStatus> {
    const [l2BlockHash, l2BlockNumber, l1Block, l2Block] = await Promise.all([
      this.rollupCore.l2BlockHash(),
      this.rollupCore.l2BlockNumber(),
      this.l1Provider.getBlockNumber(),
      this.l2Provider.getBlock("latest"),
    ]);

    return {
      l2BlockNumber: Number(l2BlockNumber),
      l2BlockHash,
      l1BlockNumber: l1Block,
      isSynced: l2BlockHash.toLowerCase() === l2Block?.stateRoot?.toLowerCase(),
      processedL2Blocks: this.processedL2Blocks.size,
      processedIncomingCalls: this.processedIncomingCalls.size,
      l2ProxyFactoryAddress: this.l2ProxyFactoryAddress,
      l2CallRegistryAddress: this.l2CallRegistryAddress,
    };
  }

  /**
   * Start the fullnode
   */
  async start(): Promise<void> {
    console.log("=== Native Rollup L2 Fullnode ===");
    console.log(`L1 RPC: ${this.config.l1Rpc}`);
    console.log(`NativeRollupCore: ${this.config.rollupAddress}`);
    console.log(`L2 System Address: ${L2_SYSTEM_ADDRESS}`);
    console.log("");

    // Spawn L2 Anvil with system address pre-funded
    await this.spawnL2Anvil();

    // Deploy L2 infrastructure (MUST match builder)
    await this.deployL2Infrastructure();

    console.log("");

    // Get current L2 state from L1
    const status = await this.getStatus();
    console.log(`L2 State on L1:`);
    console.log(`  Block number: ${status.l2BlockNumber}`);
    console.log(`  Block hash:   ${status.l2BlockHash}`);
    console.log(`  Synced:       ${status.isSynced ? "YES" : "NO"}`);
    console.log("");

    // Sync past events
    await this.syncPastEvents();

    // Watch for new events
    this.watchEvents();

    console.log("Fullnode running, watching for L1 events...");
  }

  /**
   * Sync all past events from L1
   */
  async syncPastEvents(): Promise<void> {
    console.log("Syncing past events...");

    // Get all past L2BlockProcessed events
    const blockFilter = this.rollupCore.filters.L2BlockProcessed();
    const blockEvents = await this.rollupCore.queryFilter(blockFilter);

    console.log(`Found ${blockEvents.length} L2BlockProcessed events`);

    for (const event of blockEvents) {
      await this.handleL2BlockProcessed(event);
    }

    // Get all past IncomingCallHandled events
    const incomingFilter = this.rollupCore.filters.IncomingCallHandled();
    const incomingEvents = await this.rollupCore.queryFilter(incomingFilter);

    console.log(`Found ${incomingEvents.length} IncomingCallHandled events`);

    for (const event of incomingEvents) {
      await this.handleIncomingCallHandled(event);
    }

    // Get all past L2TransactionProcessed events
    const txFilter = this.rollupCore.filters.L2TransactionProcessed();
    const txEvents = await this.rollupCore.queryFilter(txFilter);

    console.log(`Found ${txEvents.length} L2TransactionProcessed events`);

    for (const event of txEvents) {
      await this.handleL2TransactionProcessed(event);
    }

    console.log("Past events synced.");
  }

  /**
   * Watch for new L1 events
   */
  private watchEvents(): void {
    this.rollupCore.on(
      "L2BlockProcessed",
      async (blockNumber: bigint, prevBlockHash: string, newBlockHash: string, outgoingCallsCount: bigint, event: any) => {
        await this.handleL2BlockProcessed({
          args: [blockNumber, prevBlockHash, newBlockHash, outgoingCallsCount],
          transactionHash: event.log?.transactionHash,
          log: event.log,
        });
      }
    );

    this.rollupCore.on(
      "IncomingCallHandled",
      async (l2Address: string, responseKey: string, outgoingCallsCount: bigint, value: bigint, event: any) => {
        await this.handleIncomingCallHandled({
          args: [l2Address, responseKey, outgoingCallsCount, value],
          transactionHash: event.log?.transactionHash,
          log: event.log,
        });
      }
    );

    this.rollupCore.on(
      "L2TransactionProcessed",
      async (blockNumber: bigint, txHash: string, from: string, newStateHash: string, event: any) => {
        await this.handleL2TransactionProcessed({
          args: [blockNumber, txHash, from, newStateHash],
          transactionHash: event.log?.transactionHash,
          log: event.log,
        });
      }
    );
  }

  /**
   * Handle L2BlockProcessed event
   */
  private async handleL2BlockProcessed(event: any): Promise<void> {
    const blockNum = Number(event.args[0]);

    if (this.processedL2Blocks.has(blockNum)) {
      return;
    }

    this.processedL2Blocks.add(blockNum);

    console.log(`Processing L2 block ${blockNum}...`);

    try {
      const tx = await this.l1Provider.getTransaction(event.transactionHash);
      if (!tx) throw new Error(`Transaction ${event.transactionHash} not found`);

      const decoded = this.rollupCore.interface.parseTransaction({
        data: tx.data,
        value: tx.value,
      });

      if (!decoded) throw new Error("Failed to decode transaction");

      const callData: string = decoded.args[1];

      if (callData && callData !== "0x" && callData.length > 2) {
        await this.executeL2Transaction(callData);
      }

      console.log(`  ✓ L2 block ${blockNum} processed`);

      if (this.onBlockProcessed) {
        this.onBlockProcessed(blockNum, event.args[2]);
      }
    } catch (err: any) {
      console.error(`  ✗ Failed to process L2 block ${blockNum}:`, err.message);
    }
  }

  /**
   * Handle IncomingCallHandled event
   */
  private async handleIncomingCallHandled(event: any): Promise<void> {
    const l2Address = event.args[0];
    const responseKey = event.args[1];
    const value = BigInt(event.args[3] || 0);
    const txHash = event.transactionHash;

    if (this.processedIncomingCalls.has(responseKey)) {
      return;
    }

    this.processedIncomingCalls.add(responseKey);

    console.log(`Processing incoming call to ${l2Address}...`);
    if (value > 0n) {
      console.log(`  Value: ${ethers.formatEther(value)} xDAI`);
    }

    try {
      // Find the L1 caller and calldata from registration
      let l1Caller: string | null = null;
      let callData: string = "0x";

      if (txHash) {
        const tx = await this.l1Provider.getTransaction(txHash);
        if (tx) {
          l1Caller = tx.from;
          const regInfo = await this.findRegistrationInfo(l2Address, responseKey);
          if (regInfo) {
            callData = regInfo.callData;
          }
        }
      }

      if (!l1Caller) {
        const regInfo = await this.findRegistrationInfo(l2Address, responseKey);
        if (regInfo) {
          l1Caller = regInfo.l1Caller;
          callData = regInfo.callData;
        }
      }

      if (!l1Caller) {
        console.log(`  Warning: Could not determine L1 caller`);
        return;
      }

      console.log(`  L1 Caller: ${l1Caller}`);
      console.log(`  L2 Target: ${l2Address}`);

      // Execute the call using proxy system (matching builder)
      await this.executeL1ToL2Call(l1Caller, l2Address, value, callData);

      console.log(`  ✓ Incoming call processed`);

      if (this.onIncomingCallProcessed) {
        this.onIncomingCallProcessed(l2Address, l1Caller);
      }
    } catch (err: any) {
      console.error(`  ✗ Failed to process incoming call:`, err.message);
    }
  }

  /**
   * Handle L2TransactionProcessed event
   * This is the new primary mechanism for processing L2 transactions
   */
  private async handleL2TransactionProcessed(event: any): Promise<void> {
    const blockNum = Number(event.args[0]);
    const txHash = event.args[1];
    const expectedStateHash = event.args[3];

    if (this.processedL2Transactions.has(txHash)) {
      return;
    }

    this.processedL2Transactions.add(txHash);

    console.log(`Processing L2 transaction (block ${blockNum})...`);
    console.log(`  Tx hash: ${txHash}`);

    try {
      // Get the L1 transaction that submitted this L2 tx
      const l1Tx = await this.l1Provider.getTransaction(event.transactionHash);
      if (!l1Tx) throw new Error(`L1 transaction ${event.transactionHash} not found`);

      // Decode the L1 transaction to get the raw L2 transaction
      const decoded = this.rollupCore.interface.parseTransaction({
        data: l1Tx.data,
        value: l1Tx.value,
      });

      if (!decoded || decoded.name !== "processL2Transaction") {
        throw new Error(`Unexpected function: ${decoded?.name}`);
      }

      // Extract the raw L2 transaction bytes
      const rawTransaction: string = decoded.args[0];
      console.log(`  Raw L2 tx length: ${(rawTransaction.length - 2) / 2} bytes`);

      // Parse the transaction to get sender
      const parsedTx = ethers.Transaction.from(rawTransaction);
      const sender = parsedTx.from;
      console.log(`  Sender: ${sender}`);

      // Fund the sender if needed (in a real system, this would come from prior deposits)
      // For now, we ensure the sender has funds to execute
      const senderBalance = await this.l2Provider.getBalance(sender!);
      if (senderBalance === 0n) {
        console.log(`  Funding sender for transaction execution...`);
        await this.l2Provider.send("anvil_setBalance", [
          sender,
          "0x" + ethers.parseEther("100").toString(16),
        ]);
      }

      // Submit the raw transaction to L2
      const l2TxHash = await this.l2Provider.send("eth_sendRawTransaction", [rawTransaction]);
      console.log(`  L2 tx submitted: ${l2TxHash}`);

      // Wait for it to be mined
      const receipt = await this.l2Provider.waitForTransaction(l2TxHash);
      console.log(`  L2 tx result: ${receipt?.status === 1 ? "success" : "reverted"}`);

      // Verify state root matches expected
      const l2Block = await this.l2Provider.getBlock("latest");
      const actualStateRoot = l2Block?.stateRoot;

      if (actualStateRoot?.toLowerCase() === expectedStateHash.toLowerCase()) {
        console.log(`  ✓ State root matches!`);
      } else {
        console.log(`  ⚠ State root mismatch!`);
        console.log(`    Expected: ${expectedStateHash}`);
        console.log(`    Actual:   ${actualStateRoot}`);
      }

      console.log(`  ✓ L2 transaction processed`);

      if (this.onL2TransactionProcessed) {
        const parsedTx = ethers.Transaction.from(rawTransaction);
        this.onL2TransactionProcessed(txHash, parsedTx.from || "unknown");
      }
    } catch (err: any) {
      console.error(`  ✗ Failed to process L2 transaction:`, err.message);
    }
  }

  /**
   * Find registration info from L1 events
   */
  private async findRegistrationInfo(
    l2Address: string,
    responseKey: string
  ): Promise<{ l1Caller: string; callData: string } | null> {
    try {
      const filter = this.rollupCore.filters.IncomingCallRegistered(l2Address, null, null);
      const events = await this.rollupCore.queryFilter(filter);

      for (const regEvent of events) {
        if (regEvent.args![3] === responseKey) {
          const tx = await this.l1Provider.getTransaction(regEvent.transactionHash);
          if (tx) {
            const decoded = this.rollupCore.interface.parseTransaction({
              data: tx.data,
              value: tx.value,
            });
            if (decoded && decoded.name === "registerIncomingCall") {
              return {
                l1Caller: tx.from,
                callData: decoded.args[2],
              };
            }
          }
        }
      }
    } catch (err) {
      console.log(`  Warning: Error finding registration info`);
    }
    return null;
  }

  /**
   * Execute an L2 transaction from calldata
   */
  private async executeL2Transaction(callData: string): Promise<void> {
    try {
      const txHash = await this.l2Provider.send("eth_sendRawTransaction", [callData]);
      console.log(`  L2 tx submitted: ${txHash}`);

      const receipt = await this.l2Provider.waitForTransaction(txHash);
      console.log(`  L2 tx result: ${receipt?.status === 1 ? "success" : "reverted"}`);
    } catch (err: any) {
      console.log(`  Note: callData is not raw RLP transaction`);
    }
  }

  /**
   * Execute an L1→L2 call using the proxy system (MUST match builder)
   *
   * Flow:
   * 1. Ensure L1 caller has proxy on L2
   * 2. System address calls proxy with (target + calldata)
   * 3. Proxy forwards to target
   */
  private async executeL1ToL2Call(
    l1Caller: string,
    l2Target: string,
    value: bigint,
    data: string
  ): Promise<void> {
    // Ensure L1 caller has proxy on L2
    const l1CallerL2Proxy = await this.ensureL2Proxy(l1Caller);
    console.log(`  L1 caller's L2 proxy: ${l1CallerL2Proxy}`);

    // System address calls the proxy
    await this.l2Provider.send("anvil_impersonateAccount", [L2_SYSTEM_ADDRESS]);
    const systemSigner = await this.l2Provider.getSigner(L2_SYSTEM_ADDRESS);

    // Encode the call: target address (20 bytes) + calldata
    const proxyCallData = ethers.concat([l2Target, data || "0x"]);

    // System calls the proxy, which forwards to target
    const tx = await systemSigner.sendTransaction({
      to: l1CallerL2Proxy,
      data: proxyCallData,
      value,
    });
    const receipt = await tx.wait();

    await this.l2Provider.send("anvil_stopImpersonatingAccount", [L2_SYSTEM_ADDRESS]);

    console.log(`  L2 call result: ${receipt?.status === 1 ? "success" : "reverted"}`);
  }

  /**
   * Set callback for when a block is processed
   */
  onBlock(callback: (blockNumber: number, hash: string) => void): void {
    this.onBlockProcessed = callback;
  }

  /**
   * Set callback for when an incoming call is processed
   */
  onIncomingCall(callback: (l2Address: string, caller: string) => void): void {
    this.onIncomingCallProcessed = callback;
  }

  /**
   * Stop the fullnode
   */
  stop(): void {
    this.rollupCore.removeAllListeners();

    if (this.anvilProcess) {
      console.log("Stopping L2 Anvil...");
      this.anvilProcess.kill();
      this.anvilProcess = null;
    }

    console.log("Fullnode stopped.");
  }

  /**
   * Get the L2 RPC URL
   */
  getL2Rpc(): string {
    return `http://localhost:${this.config.l2Port}`;
  }
}

// ============ CLI Entry Point ============

async function main() {
  const fullnode = new L2Fullnode();

  fullnode.onBlock((blockNumber, hash) => {
    console.log(`Block ${blockNumber} finalized with hash ${hash}`);
  });

  fullnode.onIncomingCall((l2Address, caller) => {
    console.log(`Incoming call to ${l2Address} from ${caller}`);
  });

  await fullnode.start();

  // Handle graceful shutdown
  process.on("SIGINT", () => {
    console.log("\nShutting down...");
    fullnode.stop();
    process.exit(0);
  });
}

if (process.argv[1]?.includes('fullnode')) {
  main().catch((err) => {
    console.error("Fullnode error:", err);
    process.exit(1);
  });
}
