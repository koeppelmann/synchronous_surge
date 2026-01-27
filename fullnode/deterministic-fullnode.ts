/**
 * Deterministic L2 Fullnode
 *
 * A fullnode that derives L2 state PURELY from L1 events.
 * Given an L1 RPC endpoint and NativeRollupCore address,
 * this fullnode reconstructs the complete L2 state deterministically.
 *
 * CORE PRINCIPLE: L2 state is a PURE FUNCTION of L1 state.
 * Two independent fullnodes watching the same L1 MUST derive identical L2 state.
 *
 * Events processed:
 * 1. L2BlockProcessed: Contains callData (raw L2 tx) and final state hash
 * 2. IncomingCallHandled: L1→L2 deposits/calls
 *
 * The fullnode:
 * 1. Spawns a fresh Anvil instance
 * 2. Sets up genesis state (system address funded)
 * 3. Watches L1 for events
 * 4. For each event, executes the corresponding L2 operation
 * 5. Verifies the resulting state root matches L1's commitment
 */

import {
  ethers,
  Contract,
  JsonRpcProvider,
  Transaction,
  keccak256,
  AbiCoder,
} from "ethers";
import { spawn, ChildProcess } from "child_process";

// ============ Configuration ============

export interface FullnodeConfig {
  l1Rpc: string;
  rollupAddress: string;
  l2Port: number;
  l2ChainId: number;
  startFromBlock?: number;
}

const DEFAULT_CONFIG: FullnodeConfig = {
  l1Rpc: process.env.L1_RPC || "http://localhost:8545",
  rollupAddress: process.env.ROLLUP_ADDRESS || "",
  l2Port: parseInt(process.env.L2_PORT || "9546"),
  l2ChainId: parseInt(process.env.L2_CHAIN_ID || "10200200"),
  startFromBlock: 0,
};

// ============ Constants ============

/**
 * L2 System Address - the "sequencer" that executes all L2 transactions
 * This address is pre-funded in genesis with enough ETH to pay for gas
 */
export const L2_SYSTEM_ADDRESS = "0x1000000000000000000000000000000000000001";

/**
 * Genesis balance for L2 system address (10 billion ETH in wei)
 */
export const L2_SYSTEM_BALANCE = ethers.parseEther("10000000000");

// ============ ABI ============

const ROLLUP_ABI = [
  // Events
  "event L2BlockProcessed(uint256 indexed blockNumber, bytes32 indexed prevBlockHash, bytes32 indexed newBlockHash, uint256 outgoingCallsCount)",
  "event L2StateUpdated(uint256 indexed blockNumber, bytes32 indexed newStateHash, uint256 callIndex)",
  "event IncomingCallHandled(address indexed l2Address, bytes32 indexed responseKey, uint256 outgoingCallsCount, uint256 value)",
  "event IncomingCallRegistered(address indexed l2Address, bytes32 indexed stateHash, bytes32 indexed callDataHash, bytes32 responseKey)",
  // View functions
  "function l2BlockHash() view returns (bytes32)",
  "function l2BlockNumber() view returns (uint256)",
  "function incomingCallResponses(bytes32) view returns (bytes32 preOutgoingCallsStateHash, bytes returnValue, bytes32 finalStateHash)",
];

// ============ Utility Functions ============

function log(component: string, message: string) {
  const timestamp = new Date().toISOString().split("T")[1].split(".")[0];
  console.log(`[${timestamp}] [${component}] ${message}`);
}

async function getStateRoot(provider: JsonRpcProvider): Promise<string> {
  const block = await provider.send("eth_getBlockByNumber", ["latest", false]);
  return block?.stateRoot || "0x0";
}

// ============ Deterministic Fullnode ============

export class DeterministicFullnode {
  private config: FullnodeConfig;
  private l1Provider: JsonRpcProvider;
  private l2Provider!: JsonRpcProvider;
  private rollupCore: Contract;
  private anvilProcess: ChildProcess | null = null;

  // State tracking
  private processedBlocks: Set<number> = new Set();
  private processedIncomingCalls: Set<string> = new Set();
  private lastL1Block: number = 0;

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
   * Get current sync status
   */
  async getStatus(): Promise<{
    l2BlockNumber: number;
    l2BlockHash: string;
    l2StateRoot: string;
    l1BlockNumber: number;
    isSynced: boolean;
  }> {
    const [l2BlockHash, l2BlockNumber, l1Block] = await Promise.all([
      this.rollupCore.l2BlockHash(),
      this.rollupCore.l2BlockNumber(),
      this.l1Provider.getBlockNumber(),
    ]);

    const l2StateRoot = await getStateRoot(this.l2Provider);

    return {
      l2BlockNumber: Number(l2BlockNumber),
      l2BlockHash,
      l2StateRoot,
      l1BlockNumber: l1Block,
      isSynced: l2BlockHash.toLowerCase() === l2StateRoot.toLowerCase(),
    };
  }

  /**
   * Start the fullnode
   */
  async start(): Promise<void> {
    log("Fullnode", "=== Deterministic L2 Fullnode ===");
    log("Fullnode", `L1 RPC: ${this.config.l1Rpc}`);
    log("Fullnode", `NativeRollupCore: ${this.config.rollupAddress}`);
    log("Fullnode", `L2 Port: ${this.config.l2Port}`);
    log("Fullnode", "");

    // Get genesis state from L1 contract
    const genesisHash = await this.rollupCore.l2BlockHash();
    log("Fullnode", `Genesis L2 hash from L1: ${genesisHash}`);

    // Spawn L2 Anvil
    await this.spawnL2Anvil();

    // Verify genesis matches
    const l2StateRoot = await getStateRoot(this.l2Provider);
    log("Fullnode", `L2 genesis state root: ${l2StateRoot}`);

    if (genesisHash.toLowerCase() !== l2StateRoot.toLowerCase()) {
      log("Fullnode", `WARNING: Genesis mismatch!`);
      log("Fullnode", `  L1 expects: ${genesisHash}`);
      log("Fullnode", `  L2 has:     ${l2StateRoot}`);
      log("Fullnode", `  This is expected if transactions have been processed.`);
    }

    // Sync past events
    await this.syncPastEvents();

    // Watch for new events
    this.watchEvents();

    // Verify sync status
    const status = await this.getStatus();
    log("Fullnode", "");
    log("Fullnode", `Current Status:`);
    log("Fullnode", `  L2 Block Number: ${status.l2BlockNumber}`);
    log("Fullnode", `  L1 expects hash: ${status.l2BlockHash}`);
    log("Fullnode", `  L2 state root:   ${status.l2StateRoot}`);
    log("Fullnode", `  Synced: ${status.isSynced ? "YES" : "NO"}`);
    log("Fullnode", "");
    log("Fullnode", "Fullnode running, watching for L1 events...");
  }

  /**
   * Spawn L2 Anvil with deterministic genesis
   */
  private async spawnL2Anvil(): Promise<void> {
    const l2Rpc = `http://localhost:${this.config.l2Port}`;

    log("Fullnode", `Spawning L2 Anvil on port ${this.config.l2Port}...`);

    this.anvilProcess = spawn(
      "anvil",
      [
        "--port", this.config.l2Port.toString(),
        "--chain-id", this.config.l2ChainId.toString(),
        "--accounts", "0", // No pre-funded accounts
        "--silent",
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
      }
    );

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

    // Set up deterministic genesis state
    // Fund the L2 system address
    log("Fullnode", `Setting up genesis state...`);
    await this.l2Provider.send("anvil_setBalance", [
      L2_SYSTEM_ADDRESS,
      "0x" + L2_SYSTEM_BALANCE.toString(16),
    ]);

    const balance = await this.l2Provider.getBalance(L2_SYSTEM_ADDRESS);
    log("Fullnode", `  System address balance: ${ethers.formatEther(balance)} ETH`);

    // Mine a block to commit the genesis state
    await this.l2Provider.send("evm_mine", []);

    const genesisRoot = await getStateRoot(this.l2Provider);
    log("Fullnode", `  Genesis state root: ${genesisRoot}`);
    log("Fullnode", `L2 Anvil ready at ${l2Rpc}`);
  }

  /**
   * Sync all past events from L1
   */
  async syncPastEvents(): Promise<void> {
    log("Fullnode", "Syncing past events...");

    // Get all L2BlockProcessed events
    const blockFilter = this.rollupCore.filters.L2BlockProcessed();
    const blockEvents = await this.rollupCore.queryFilter(blockFilter);
    log("Fullnode", `Found ${blockEvents.length} L2BlockProcessed events`);

    // Get all IncomingCallHandled events
    const incomingFilter = this.rollupCore.filters.IncomingCallHandled();
    const incomingEvents = await this.rollupCore.queryFilter(incomingFilter);
    log("Fullnode", `Found ${incomingEvents.length} IncomingCallHandled events`);

    // Combine and sort by block number and log index
    const allEvents = [...blockEvents, ...incomingEvents].sort((a, b) => {
      if (a.blockNumber !== b.blockNumber) {
        return a.blockNumber - b.blockNumber;
      }
      return a.index - b.index;
    });

    log("Fullnode", `Processing ${allEvents.length} events in order...`);

    for (const event of allEvents) {
      await this.handleEvent(event);
    }

    log("Fullnode", "Past events synced.");
  }

  /**
   * Watch for new L1 events
   */
  private watchEvents(): void {
    this.rollupCore.on(
      "L2BlockProcessed",
      async (blockNumber: bigint, prevBlockHash: string, newBlockHash: string, outgoingCallsCount: bigint, event: any) => {
        await this.handleL2BlockProcessed(event);
      }
    );

    this.rollupCore.on(
      "IncomingCallHandled",
      async (l2Address: string, responseKey: string, outgoingCallsCount: bigint, value: bigint, event: any) => {
        await this.handleIncomingCallHandled(event);
      }
    );
  }

  /**
   * Handle any event by type
   */
  private async handleEvent(event: any): Promise<void> {
    const eventName = event.fragment?.name || event.eventName;

    if (eventName === "L2BlockProcessed") {
      await this.handleL2BlockProcessed(event);
    } else if (eventName === "IncomingCallHandled") {
      await this.handleIncomingCallHandled(event);
    }
  }

  /**
   * Handle L2BlockProcessed event
   *
   * This event means an L2 transaction was processed via processCallOnL2.
   * The callData contains the raw signed L2 transaction.
   */
  private async handleL2BlockProcessed(event: any): Promise<void> {
    const blockNumber = Number(event.args?.[0] || event.args?.blockNumber);
    const prevBlockHash = event.args?.[1] || event.args?.prevBlockHash;
    const newBlockHash = event.args?.[2] || event.args?.newBlockHash;

    if (this.processedBlocks.has(blockNumber)) {
      return; // Already processed
    }

    log("Fullnode", `Processing L2 block ${blockNumber}...`);
    log("Fullnode", `  Prev hash: ${prevBlockHash}`);
    log("Fullnode", `  New hash:  ${newBlockHash}`);

    // Get the transaction that triggered this event
    const txHash = event.transactionHash || event.log?.transactionHash;
    if (!txHash) {
      log("Fullnode", `  ERROR: No transaction hash found`);
      return;
    }

    const tx = await this.l1Provider.getTransaction(txHash);
    if (!tx) {
      log("Fullnode", `  ERROR: Transaction not found`);
      return;
    }

    // Decode the callData from processCallOnL2
    // function processCallOnL2(bytes32 prevL2BlockHash, bytes calldata callData, ...)
    const iface = new ethers.Interface([
      "function processCallOnL2(bytes32 prevL2BlockHash, bytes calldata callData, bytes32 postExecutionStateHash, tuple(address from, address target, uint256 value, uint256 gas, bytes data, bytes32 postCallStateHash)[] outgoingCalls, bytes[] expectedResults, bytes32 finalStateHash, bytes proof)"
    ]);

    try {
      const decoded = iface.parseTransaction({ data: tx.data });
      const callData = decoded?.args?.[1]; // callData is second argument

      if (callData && callData !== "0x") {
        // callData is a raw signed L2 transaction
        await this.executeL2Transaction(callData, newBlockHash, blockNumber);
      }
    } catch (err: any) {
      log("Fullnode", `  ERROR decoding: ${err.message}`);
    }

    this.processedBlocks.add(blockNumber);
  }

  /**
   * Execute a raw L2 transaction
   */
  private async executeL2Transaction(rawTx: string, expectedStateHash: string, blockNumber: number): Promise<void> {
    try {
      // Parse the transaction
      const tx = Transaction.from(rawTx);
      log("Fullnode", `  Executing L2 tx:`);
      log("Fullnode", `    From: ${tx.from}`);
      log("Fullnode", `    To: ${tx.to || "(deploy)"}`);
      log("Fullnode", `    Value: ${ethers.formatEther(tx.value)} ETH`);

      // Fund the sender if needed (they're paying for the tx)
      const senderBalance = await this.l2Provider.getBalance(tx.from!);
      const neededBalance = tx.value + (tx.gasLimit * (tx.maxFeePerGas || tx.gasPrice || 0n));

      if (senderBalance < neededBalance) {
        await this.l2Provider.send("anvil_setBalance", [
          tx.from,
          "0x" + (neededBalance * 2n).toString(16),
        ]);
      }

      // Execute the transaction
      const txHash = await this.l2Provider.send("eth_sendRawTransaction", [rawTx]);
      const receipt = await this.l2Provider.waitForTransaction(txHash);

      log("Fullnode", `    L2 tx hash: ${txHash}`);
      log("Fullnode", `    Status: ${receipt?.status === 1 ? "SUCCESS" : "REVERTED"}`);

      // Verify state root matches
      const newStateRoot = await getStateRoot(this.l2Provider);
      if (newStateRoot.toLowerCase() === expectedStateHash.toLowerCase()) {
        log("Fullnode", `    State root MATCHES!`);
      } else {
        log("Fullnode", `    WARNING: State root MISMATCH!`);
        log("Fullnode", `      Expected: ${expectedStateHash}`);
        log("Fullnode", `      Got:      ${newStateRoot}`);
      }
    } catch (err: any) {
      log("Fullnode", `    ERROR: ${err.message}`);
    }
  }

  /**
   * Handle IncomingCallHandled event
   *
   * This event means an L1→L2 deposit/call was processed.
   * We need to update L2 state to match.
   */
  private async handleIncomingCallHandled(event: any): Promise<void> {
    const l2Address = event.args?.[0] || event.args?.l2Address;
    const responseKey = event.args?.[1] || event.args?.responseKey;
    const value = event.args?.[3] || event.args?.value || 0n;

    const eventKey = `${event.transactionHash || event.log?.transactionHash}-${event.index || event.log?.index}`;
    if (this.processedIncomingCalls.has(eventKey)) {
      return; // Already processed
    }

    log("Fullnode", `Processing incoming call to ${l2Address}...`);
    log("Fullnode", `  Response key: ${responseKey}`);
    log("Fullnode", `  Value: ${ethers.formatEther(value)} ETH`);

    // Get the registered response to find the final state hash
    try {
      const response = await this.rollupCore.incomingCallResponses(responseKey);
      const finalStateHash = response.finalStateHash;
      log("Fullnode", `  Final state hash: ${finalStateHash}`);

      // For L1→L2 deposits, we credit the L2 address
      if (value > 0n) {
        const currentBalance = await this.l2Provider.getBalance(l2Address);
        const newBalance = currentBalance + value;
        await this.l2Provider.send("anvil_setBalance", [
          l2Address,
          "0x" + newBalance.toString(16),
        ]);
        log("Fullnode", `  Credited ${ethers.formatEther(value)} ETH to ${l2Address}`);
      }

      // Mine a block to update state
      await this.l2Provider.send("evm_mine", []);

      // Verify state root matches
      const newStateRoot = await getStateRoot(this.l2Provider);
      if (newStateRoot.toLowerCase() === finalStateHash.toLowerCase()) {
        log("Fullnode", `  State root MATCHES!`);
      } else {
        log("Fullnode", `  WARNING: State root MISMATCH!`);
        log("Fullnode", `    Expected: ${finalStateHash}`);
        log("Fullnode", `    Got:      ${newStateRoot}`);
      }
    } catch (err: any) {
      log("Fullnode", `  ERROR: ${err.message}`);
    }

    this.processedIncomingCalls.add(eventKey);
  }

  /**
   * Stop the fullnode
   */
  async stop(): Promise<void> {
    if (this.anvilProcess) {
      this.anvilProcess.kill();
      this.anvilProcess = null;
    }
  }

  /**
   * Get the L2 provider for external use
   */
  getL2Provider(): JsonRpcProvider {
    return this.l2Provider;
  }

  /**
   * Get the L2 RPC URL
   */
  getL2Url(): string {
    return `http://localhost:${this.config.l2Port}`;
  }
}

// ============ Main ============

async function main() {
  const config: Partial<FullnodeConfig> = {};

  // Parse command line args
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--l1-rpc":
        config.l1Rpc = args[++i];
        break;
      case "--rollup":
        config.rollupAddress = args[++i];
        break;
      case "--port":
        config.l2Port = parseInt(args[++i]);
        break;
      case "--chain-id":
        config.l2ChainId = parseInt(args[++i]);
        break;
    }
  }

  if (!config.rollupAddress && !process.env.ROLLUP_ADDRESS) {
    console.error("Error: --rollup <address> or ROLLUP_ADDRESS env var required");
    process.exit(1);
  }

  const fullnode = new DeterministicFullnode(config);

  // Handle shutdown
  process.on("SIGINT", async () => {
    log("Fullnode", "Shutting down...");
    await fullnode.stop();
    process.exit(0);
  });

  await fullnode.start();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
