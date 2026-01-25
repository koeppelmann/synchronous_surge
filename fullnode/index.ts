/**
 * Native Rollup L2 Fullnode
 *
 * A deterministic L2 state machine that syncs from L1.
 * Given an L1 RPC endpoint and knowledge of NativeRollupCore,
 * this fullnode can reconstruct the complete L2 state.
 *
 * Core principle: L2 state is a PURE FUNCTION of L1 state.
 * The fullnode watches L1 events and replays the corresponding
 * state changes on L2, maintaining the invariant that:
 *   L2 state root == l2BlockHash on L1
 *
 * Events processed:
 * 1. L2BlockProcessed: L2→L1 flow (processCallOnL2)
 *    - Decode callData and execute on L2
 *    - Outgoing calls already executed on L1, no L2 action needed
 *
 * 2. IncomingCallHandled: L1→L2 flow
 *    - Determine which L1 contract called which L2 contract
 *    - Impersonate L1 caller's proxy on L2 and execute
 */

import {
  ethers,
  Contract,
  JsonRpcProvider,
  AbiCoder,
  keccak256,
  TransactionReceipt,
} from "ethers";

// ============ Configuration ============

export interface FullnodeConfig {
  l1Rpc: string;
  l2Rpc: string;
  rollupAddress: string;
  startFromBlock?: number; // L1 block to start syncing from (0 = genesis)
}

const DEFAULT_CONFIG: FullnodeConfig = {
  l1Rpc: process.env.L1_RPC || "http://localhost:9545",
  l2Rpc: process.env.L2_RPC || "http://localhost:9546",
  rollupAddress:
    process.env.ROLLUP_ADDRESS || "0x4240994d85109581B001183ab965D9e3d5fb2C2A",
  startFromBlock: 0,
};

// ============ ABI ============

const ROLLUP_ABI = [
  // Events
  "event L2BlockProcessed(uint256 indexed blockNumber, bytes32 indexed prevBlockHash, bytes32 indexed newBlockHash, uint256 outgoingCallsCount)",
  "event OutgoingCallExecuted(uint256 indexed blockNumber, uint256 indexed callIndex, address indexed from, address target, bool success)",
  "event L2SenderProxyDeployed(address indexed l2Address, address indexed proxyAddress)",
  "event IncomingCallRegistered(address indexed l2Address, bytes32 indexed stateHash, bytes32 indexed callDataHash, bytes32 responseKey)",
  "event IncomingCallHandled(address indexed l2Address, bytes32 indexed responseKey, uint256 outgoingCallsCount)",

  // View functions
  "function l2BlockHash() view returns (bytes32)",
  "function l2BlockNumber() view returns (uint256)",
  "function getProxyAddress(address l2Address) view returns (address)",
  "function incomingCallResponses(bytes32) view returns (bytes32 preOutgoingCallsStateHash, bytes returnValue, bytes32 finalStateHash)",

  // State-changing functions (for decoding)
  "function processCallOnL2(bytes32 prevL2BlockHash, bytes calldata callData, bytes32 postExecutionStateHash, tuple(address from, address target, uint256 value, uint256 gas, bytes data, bytes32 postCallStateHash)[] outgoingCalls, bytes[] expectedResults, bytes32 finalStateHash, bytes proof) payable",
  "function registerIncomingCall(address l2Address, bytes32 stateHash, bytes calldata callData, tuple(bytes32 preOutgoingCallsStateHash, tuple(address from, address target, uint256 value, uint256 gas, bytes data, bytes32 postCallStateHash)[] outgoingCalls, bytes[] expectedResults, bytes returnValue, bytes32 finalStateHash) response, bytes proof)",
];

// ============ Utility Functions ============

/**
 * Compute the L2 proxy address for an L1 address.
 * This is the address we impersonate on L2 when an L1 contract makes a call.
 */
export function computeL2ProxyAddress(l1Address: string): string {
  const hash = keccak256(
    AbiCoder.defaultAbiCoder().encode(
      ["string", "address"],
      ["NativeRollup.L1SenderProxy.v1", l1Address]
    )
  );
  return "0x" + hash.slice(-40);
}

// ============ L2 Fullnode ============

export interface SyncStatus {
  l2BlockNumber: number;
  l2BlockHash: string;
  l1BlockNumber: number;
  isSynced: boolean;
  processedL2Blocks: number;
  processedIncomingCalls: number;
}

export class L2Fullnode {
  private config: FullnodeConfig;
  private l1Provider: JsonRpcProvider;
  private l2Provider: JsonRpcProvider;
  private rollupCore: Contract;

  // Tracking state
  private processedL2Blocks: Set<number> = new Set();
  private processedIncomingCalls: Set<string> = new Set();
  private lastL1Block: number = 0;

  // Event handlers for extensibility
  private onBlockProcessed?: (blockNumber: number, hash: string) => void;
  private onIncomingCallProcessed?: (l2Address: string, caller: string) => void;

  constructor(config: Partial<FullnodeConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.l1Provider = new JsonRpcProvider(this.config.l1Rpc);
    this.l2Provider = new JsonRpcProvider(this.config.l2Rpc);
    this.rollupCore = new Contract(
      this.config.rollupAddress,
      ROLLUP_ABI,
      this.l1Provider
    );
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
    };
  }

  /**
   * Start the fullnode - sync past events and watch for new ones
   */
  async start(): Promise<void> {
    console.log("=== Native Rollup L2 Fullnode ===");
    console.log(`L1 RPC: ${this.config.l1Rpc}`);
    console.log(`L2 RPC: ${this.config.l2Rpc}`);
    console.log(`NativeRollupCore: ${this.config.rollupAddress}`);
    console.log("");

    // Get current L2 state from L1
    const status = await this.getStatus();
    console.log(`L2 State on L1:`);
    console.log(`  Block number: ${status.l2BlockNumber}`);
    console.log(`  Block hash:   ${status.l2BlockHash}`);
    console.log(`  Synced:       ${status.isSynced ? "YES" : "NO"}`);
    console.log("");

    // Sync past events first
    await this.syncPastEvents();

    // Start watching for new events
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

    console.log("Past events synced.");
  }

  /**
   * Watch for new L1 events
   */
  private watchEvents(): void {
    // Watch for L2BlockProcessed
    this.rollupCore.on(
      "L2BlockProcessed",
      async (
        blockNumber: bigint,
        prevBlockHash: string,
        newBlockHash: string,
        outgoingCallsCount: bigint,
        event: any
      ) => {
        await this.handleL2BlockProcessed(event);
      }
    );

    // Watch for IncomingCallHandled
    this.rollupCore.on(
      "IncomingCallHandled",
      async (
        l2Address: string,
        responseKey: string,
        outgoingCallsCount: bigint,
        event: any
      ) => {
        await this.handleIncomingCallHandled(event);
      }
    );
  }

  /**
   * Handle L2BlockProcessed event
   */
  private async handleL2BlockProcessed(event: any): Promise<void> {
    const blockNum = Number(event.args[0]);

    if (this.processedL2Blocks.has(blockNum)) {
      return; // Already processed
    }

    this.processedL2Blocks.add(blockNum);

    console.log(`Processing L2 block ${blockNum}...`);

    try {
      // Get the L1 transaction
      const tx = await this.l1Provider.getTransaction(event.transactionHash);
      if (!tx) throw new Error(`Transaction ${event.transactionHash} not found`);

      // Decode processCallOnL2 parameters
      const decoded = this.rollupCore.interface.parseTransaction({
        data: tx.data,
        value: tx.value,
      });

      if (!decoded) throw new Error("Failed to decode transaction");

      const callData: string = decoded.args[1];

      // Execute the L2 transaction if there's calldata
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

    if (this.processedIncomingCalls.has(responseKey)) {
      return; // Already processed
    }

    this.processedIncomingCalls.add(responseKey);

    console.log(`Processing incoming call to ${l2Address}...`);

    try {
      // Get the L1 transaction
      const tx = await this.l1Provider.getTransaction(event.transactionHash);
      if (!tx) throw new Error(`Transaction ${event.transactionHash} not found`);

      // Find the registration event to get calldata
      const callData = await this.findCallDataFromRegistration(
        l2Address,
        responseKey
      );

      if (!callData) {
        console.log(`  Warning: Could not find calldata, skipping`);
        return;
      }

      // Determine the L1 caller
      const l1Caller = await this.findL1Caller(event.transactionHash, l2Address);

      if (!l1Caller) {
        console.log(`  Warning: Could not determine L1 caller, skipping`);
        return;
      }

      console.log(`  L1 Caller: ${l1Caller}`);
      console.log(`  L2 Target: ${l2Address}`);

      // Execute the call on L2
      await this.executeL1ToL2Call(l1Caller, l2Address, 0n, callData);

      console.log(`  ✓ Incoming call processed`);

      if (this.onIncomingCallProcessed) {
        this.onIncomingCallProcessed(l2Address, l1Caller);
      }
    } catch (err: any) {
      console.error(`  ✗ Failed to process incoming call:`, err.message);
    }
  }

  /**
   * Find calldata from the registration event
   */
  private async findCallDataFromRegistration(
    l2Address: string,
    responseKey: string
  ): Promise<string | null> {
    const filter = this.rollupCore.filters.IncomingCallRegistered(
      l2Address,
      null,
      null
    );
    const events = await this.rollupCore.queryFilter(filter);

    for (const event of events) {
      if (event.args![3] === responseKey) {
        const tx = await this.l1Provider.getTransaction(event.transactionHash);
        if (tx) {
          const decoded = this.rollupCore.interface.parseTransaction({
            data: tx.data,
            value: tx.value,
          });
          if (decoded && decoded.name === "registerIncomingCall") {
            return decoded.args[2]; // callData parameter
          }
        }
      }
    }

    return null;
  }

  /**
   * Find the L1 caller of the L2 proxy
   */
  private async findL1Caller(
    txHash: string,
    l2Address: string
  ): Promise<string | null> {
    const tx = await this.l1Provider.getTransaction(txHash);
    if (!tx) return null;

    const l2ProxyOnL1 = await this.rollupCore.getProxyAddress(l2Address);

    // Try debug_traceTransaction first
    try {
      const trace = await this.l1Provider.send("debug_traceTransaction", [
        txHash,
        { tracer: "callTracer" },
      ]);

      const caller = this.findCallerOfAddress(trace, l2ProxyOnL1.toLowerCase());
      if (caller) return caller;
    } catch {
      // Trace not available
    }

    // Fallback: infer from tx.to
    if (tx.to && tx.to.toLowerCase() !== l2ProxyOnL1.toLowerCase()) {
      return tx.to;
    }

    return tx.from;
  }

  /**
   * Recursively search call trace for the caller of a specific address
   */
  private findCallerOfAddress(trace: any, targetAddress: string): string | null {
    if (!trace) return null;

    if (trace.calls) {
      for (const call of trace.calls) {
        if (call.to && call.to.toLowerCase() === targetAddress) {
          return call.from;
        }
        const found = this.findCallerOfAddress(call, targetAddress);
        if (found) return found;
      }
    }

    return null;
  }

  /**
   * Execute an L2 transaction (from callData)
   */
  private async executeL2Transaction(callData: string): Promise<void> {
    try {
      // Try as raw RLP-encoded transaction
      const txHash = await this.l2Provider.send("eth_sendRawTransaction", [
        callData,
      ]);
      console.log(`  L2 tx submitted: ${txHash}`);

      const receipt = await this.l2Provider.waitForTransaction(txHash);
      console.log(
        `  L2 tx result: ${receipt?.status === 1 ? "success" : "reverted"}`
      );
    } catch (err: any) {
      // Not a raw transaction - might be arbitrary calldata
      console.log(`  Note: callData is not raw RLP transaction`);
    }
  }

  /**
   * Execute an L1→L2 call by impersonating the L1 caller's proxy on L2
   */
  private async executeL1ToL2Call(
    l1Caller: string,
    l2Target: string,
    value: bigint,
    data: string
  ): Promise<void> {
    const l2ProxyOfL1Caller = computeL2ProxyAddress(l1Caller);

    console.log(`  L2 proxy of L1 caller: ${l2ProxyOfL1Caller}`);

    // Impersonate the proxy on L2
    await this.l2Provider.send("anvil_impersonateAccount", [l2ProxyOfL1Caller]);

    // Ensure sufficient balance for gas
    const balance = await this.l2Provider.getBalance(l2ProxyOfL1Caller);
    if (balance < ethers.parseEther("0.1")) {
      await this.l2Provider.send("anvil_setBalance", [
        l2ProxyOfL1Caller,
        "0x" + ethers.parseEther("1").toString(16),
      ]);
    }

    // Execute the call
    const signer = await this.l2Provider.getSigner(l2ProxyOfL1Caller);
    const tx = await signer.sendTransaction({
      to: l2Target,
      value,
      data,
    });

    const receipt = await tx.wait();
    console.log(
      `  L2 call result: ${receipt?.status === 1 ? "success" : "reverted"}`
    );

    // Stop impersonating
    await this.l2Provider.send("anvil_stopImpersonatingAccount", [
      l2ProxyOfL1Caller,
    ]);
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
    console.log("Fullnode stopped.");
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

// Check if run directly via import.meta.url
const isMainModule = import.meta.url.endsWith(process.argv[1]?.replace(/^file:\/\//, '') || '');
if (process.argv[1]?.includes('fullnode')) {
  main().catch((err) => {
    console.error("Fullnode error:", err);
    process.exit(1);
  });
}
