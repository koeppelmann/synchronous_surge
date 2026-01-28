/**
 * Deterministic L2 Fullnode
 *
 * A fullnode that derives L2 state from L1 events.
 * Given an L1 RPC endpoint and NativeRollupCore address,
 * this fullnode maintains L2 state synchronized with L1.
 *
 * ARCHITECTURE:
 * The fullnode works in two modes:
 *
 * 1. LIVE MODE (builder is running):
 *    - Builder executes L2 txs directly on this fullnode
 *    - Fullnode just needs to verify its state matches L1 commitments
 *    - For IncomingCallHandled events, fullnode applies the state change
 *
 * 2. SYNC MODE (catching up):
 *    - Fullnode replays events to reconstruct state
 *    - Note: Anvil state roots are NOT deterministic across sessions
 *    - We track "logical state" but can't verify state roots match
 *
 * IMPORTANT: Anvil's state root depends on internal implementation details
 * (block number, timestamp, etc.) so replays produce different roots.
 * For a production system, you'd use a deterministic EVM implementation.
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
  toBlock?: number;  // Only sync up to this block (for testing)
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
  // Events - all events now include ALL data needed for fullnode reconstruction
  "event L2BlockProcessed(uint256 indexed blockNumber, bytes32 indexed prevBlockHash, bytes32 indexed newBlockHash, bytes rlpEncodedTx, tuple(address from, address target, uint256 value, uint256 gas, bytes data, bytes32 postCallStateHash)[] outgoingCalls, bytes[] outgoingCallResults)",
  "event L2StateUpdated(uint256 indexed blockNumber, bytes32 indexed newStateHash, uint256 callIndex)",
  "event IncomingCallHandled(address indexed l2Address, address indexed l1Caller, bytes32 indexed prevBlockHash, bytes callData, uint256 value, tuple(address from, address target, uint256 value, uint256 gas, bytes data, bytes32 postCallStateHash)[] outgoingCalls, bytes[] outgoingCallResults, bytes32 finalStateHash)",
  "event IncomingCallRegistered(address indexed l2Address, bytes32 indexed stateHash, bytes32 indexed callDataHash, bytes32 responseKey)",
  // View functions
  "function l2BlockHash() view returns (bytes32)",
  "function l2BlockNumber() view returns (uint256)",
  "function incomingCallResponses(bytes32) view returns (bytes32 preOutgoingCallsStateHash, bytes returnValue, bytes32 finalStateHash)",
  "function getProxyAddress(address l2Address) view returns (address)",
];

/**
 * Compute the deterministic L1SenderProxyL2 address for an L1 address
 * This must match the builder's computation
 */
function computeL1SenderProxyL2Address(l1Address: string): string {
  const hash = keccak256(ethers.solidityPacked(
    ["string", "address"],
    ["L1SenderProxyL2.v1", l1Address]
  ));
  return "0x" + hash.slice(-40);
}

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

  // Track the expected L2 state from L1 (for comparison)
  private expectedL2StateHash: string = "";
  private expectedL2BlockNumber: number = 0;

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
   *
   * NOTE: For POC with Anvil, local state roots may differ from L1-canonical hashes
   * due to Anvil's non-determinism (block numbers, timestamps affect state root).
   * The fullnode tracks the L1-canonical hash and reports synced based on that.
   */
  async getStatus(): Promise<{
    l2BlockNumber: number;
    l2BlockHash: string;           // L1-canonical state hash
    l2StateRoot: string;           // Locally computed state root (may differ!)
    l1BlockNumber: number;
    isSynced: boolean;             // Based on having processed all L1 events
    processedBlocks: number;
    processedIncomingCalls: number;
    stateRootsMatch: boolean;      // Whether local matches L1-canonical
  }> {
    const [l2BlockHash, l2BlockNumber, l1Block] = await Promise.all([
      this.rollupCore.l2BlockHash(),
      this.rollupCore.l2BlockNumber(),
      this.l1Provider.getBlockNumber(),
    ]);

    const l2StateRoot = await getStateRoot(this.l2Provider);

    // Update expected state
    this.expectedL2StateHash = l2BlockHash;
    this.expectedL2BlockNumber = Number(l2BlockNumber);

    // isSynced means we've processed all events, regardless of state root match
    // For a production system, state roots MUST match. For Anvil POC, they may differ.
    const stateRootsMatch = l2BlockHash.toLowerCase() === l2StateRoot.toLowerCase();

    return {
      l2BlockNumber: Number(l2BlockNumber),
      l2BlockHash,
      l2StateRoot,
      l1BlockNumber: l1Block,
      isSynced: stateRootsMatch, // For now, keep strict matching
      processedBlocks: this.processedBlocks.size,
      processedIncomingCalls: this.processedIncomingCalls.size,
      stateRootsMatch,
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

    // Watch for new events (unless we're in test mode with --to-block)
    if (!this.config.toBlock) {
      this.watchEvents();
    }

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
        "--gas-price", "0", // No gas fees on L2 for this POC
        "--base-fee", "0", // No base fee
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
   *
   * IMPORTANT: This processes events in L1 block order. Events must be processed
   * in the same order they occurred on L1 to maintain consistent state.
   */
  async syncPastEvents(): Promise<void> {
    log("Fullnode", "Syncing past events...");

    const currentL1Block = await this.l1Provider.getBlockNumber();
    const toBlock = this.config.toBlock ?? currentL1Block;

    if (this.config.toBlock) {
      log("Fullnode", `Limited sync: only processing events up to block ${toBlock}`);
    }

    // Get all L2BlockProcessed events
    const blockFilter = this.rollupCore.filters.L2BlockProcessed();
    const blockEvents = await this.rollupCore.queryFilter(blockFilter, 0, toBlock);
    log("Fullnode", `Found ${blockEvents.length} L2BlockProcessed events`);

    // Get all IncomingCallHandled events
    const incomingFilter = this.rollupCore.filters.IncomingCallHandled();
    const incomingEvents = await this.rollupCore.queryFilter(incomingFilter, 0, toBlock);
    log("Fullnode", `Found ${incomingEvents.length} IncomingCallHandled events`);

    // Combine and sort by block number and log index
    // This ensures events are processed in the exact order they occurred on L1
    const allEvents = [...blockEvents, ...incomingEvents].sort((a, b) => {
      if (a.blockNumber !== b.blockNumber) {
        return a.blockNumber - b.blockNumber;
      }
      return a.index - b.index;
    });

    log("Fullnode", `Processing ${allEvents.length} events in chronological order...`);

    for (const event of allEvents) {
      await this.handleEvent(event);
    }

    this.lastPolledBlock = currentL1Block;
    log("Fullnode", "Past events synced.");
  }

  /**
   * Watch for new L1 events using both listeners and polling
   */
  private watchEvents(): void {
    // Try ethers event listeners (may not work reliably with Anvil)
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

    // Also poll for events every 2 seconds as backup
    // (ethers listeners don't always work with Anvil)
    this.startPolling();
  }

  private lastPolledBlock = 0;
  private isPolling = false;

  /**
   * Poll for new events periodically
   */
  private startPolling(): void {
    setInterval(async () => {
      if (this.isPolling) return;
      this.isPolling = true;

      try {
        const currentBlock = await this.l1Provider.getBlockNumber();
        if (currentBlock > this.lastPolledBlock) {
          // Query for new events
          const fromBlock = this.lastPolledBlock + 1;

          const blockFilter = this.rollupCore.filters.L2BlockProcessed();
          const blockEvents = await this.rollupCore.queryFilter(blockFilter, fromBlock, currentBlock);

          const incomingFilter = this.rollupCore.filters.IncomingCallHandled();
          const incomingEvents = await this.rollupCore.queryFilter(incomingFilter, fromBlock, currentBlock);

          // Process events in block order
          const allEvents = [...blockEvents, ...incomingEvents].sort((a, b) => {
            if (a.blockNumber !== b.blockNumber) return a.blockNumber - b.blockNumber;
            return a.index - b.index;
          });

          for (const event of allEvents) {
            await this.handleEvent(event);
          }

          this.lastPolledBlock = currentBlock;
        }
      } catch (err: any) {
        // Ignore polling errors
      } finally {
        this.isPolling = false;
      }
    }, 2000);
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
   * This event means an L2 transaction was processed via processSingleTxOnL2.
   * The event now contains ALL data needed for reconstruction:
   * - rlpEncodedTx: The RLP-encoded signed L2 transaction
   * - outgoingCalls: L2→L1 calls made during execution
   * - outgoingCallResults: Results of those L1 calls
   *
   * The fullnode no longer needs to look up L1 transaction calldata.
   */
  private async handleL2BlockProcessed(event: any): Promise<void> {
    const blockNumber = Number(event.args?.[0] || event.args?.blockNumber);
    const prevBlockHash = event.args?.[1] || event.args?.prevBlockHash;
    const newBlockHash = event.args?.[2] || event.args?.newBlockHash;
    // Extract data directly from event (new format)
    const rlpEncodedTx = event.args?.[3] || event.args?.rlpEncodedTx;
    const outgoingCalls = event.args?.[4] || event.args?.outgoingCalls || [];
    const outgoingCallResults = event.args?.[5] || event.args?.outgoingCallResults || [];

    if (this.processedBlocks.has(blockNumber)) {
      return; // Already processed
    }
    // Mark as processed IMMEDIATELY to prevent duplicate processing
    this.processedBlocks.add(blockNumber);

    log("Fullnode", `Processing L2 block ${blockNumber}...`);
    log("Fullnode", `  Prev hash: ${prevBlockHash}`);
    log("Fullnode", `  New hash:  ${newBlockHash}`);
    log("Fullnode", `  Outgoing calls: ${outgoingCalls.length}`);

    // Extract rlpEncodedTx directly from the event (no need to look up L1 tx)
    if (rlpEncodedTx && rlpEncodedTx !== "0x") {
      // rlpEncodedTx is a raw signed L2 transaction
      await this.executeL2Transaction(rlpEncodedTx, newBlockHash, blockNumber);
    } else {
      log("Fullnode", `  No L2 transaction to execute (empty rlpEncodedTx)`);
    }
  }

  /**
   * Execute a raw L2 transaction
   *
   * If already at expected state (builder executed live), just verify.
   * Otherwise execute the transaction (for replay after restart).
   *
   * NOTE: During replay, the nonce may not match because the account
   * state differs between the original execution and the replay.
   */
  private async executeL2Transaction(rawTx: string, expectedStateHash: string, blockNumber: number): Promise<void> {
    try {
      const tx = Transaction.from(rawTx);
      log("Fullnode", `  Executing L2 tx:`);
      log("Fullnode", `    From: ${tx.from}`);
      log("Fullnode", `    To: ${tx.to || "(deploy)"}`);
      log("Fullnode", `    Value: ${ethers.formatEther(tx.value)} ETH`);
      log("Fullnode", `    Nonce: ${tx.nonce}`);

      // Check if already at expected state (builder executed on this fullnode instance)
      const currentStateRoot = await getStateRoot(this.l2Provider);
      if (currentStateRoot.toLowerCase() === expectedStateHash.toLowerCase()) {
        log("Fullnode", `    Already at expected state (builder executed live)`);
        return;
      }

      // Check sender's nonce - for replay, we may need to adjust
      // Mine a block first to ensure state is fully committed (Anvil timing fix)
      await this.l2Provider.send("evm_mine", []);
      // Get nonce using direct RPC call to avoid caching issues
      const nonceHex = await this.l2Provider.send("eth_getTransactionCount", [tx.from!, "latest"]);
      const senderNonce = parseInt(nonceHex, 16);
      log("Fullnode", `    Sender current nonce: ${senderNonce} (hex: ${nonceHex})`);

      if (tx.nonce !== senderNonce) {
        log("Fullnode", `    Nonce mismatch: tx has ${tx.nonce}, account has ${senderNonce}`);
        log("Fullnode", `    (This is expected during replay - nonces diverge)`);

        // For replay, we'll simulate the effect rather than re-execute
        // This is because the transaction was already proven on L1
        if (tx.to === null) {
          // Contract deployment - we'd need to deploy at the same address
          log("Fullnode", `    Skipping contract deployment replay (cannot reproduce exact address)`);
        } else {
          // Regular transaction - skip, state already diverged
          log("Fullnode", `    Skipping transaction replay (state already diverged from L1)`);
        }
        return;
      }

      // Execute the transaction
      log("Fullnode", `    Sending raw transaction...`);
      const txHash = await this.l2Provider.send("eth_sendRawTransaction", [rawTx]);
      log("Fullnode", `    L2 tx hash: ${txHash}`);

      // Wait for receipt with timeout
      const receipt = await Promise.race([
        this.l2Provider.waitForTransaction(txHash),
        new Promise<null>((_, reject) => setTimeout(() => reject(new Error("Transaction wait timeout")), 10000))
      ]);
      log("Fullnode", `    Status: ${receipt?.status === 1 ? "SUCCESS" : "REVERTED"}`);

      // Log the state (but don't expect it to match during replay)
      const newStateRoot = await getStateRoot(this.l2Provider);
      if (newStateRoot.toLowerCase() === expectedStateHash.toLowerCase()) {
        log("Fullnode", `    State root MATCHES!`);
      } else {
        log("Fullnode", `    Local state root: ${newStateRoot}`);
        log("Fullnode", `    (Note: State roots may differ during replay)`);
      }
    } catch (err: any) {
      log("Fullnode", `    ERROR: ${err.message}`);
      // During replay, errors like "nonce too low" are expected
      if (err.message.includes("nonce")) {
        log("Fullnode", `    (This is expected during replay - tx was already proven on L1)`);
      }
    }
  }

  /**
   * Handle IncomingCallHandled event
   *
   * This event means an L1→L2 deposit/call was processed.
   * The event now contains ALL data needed for reconstruction:
   * - l2Address: The L2 contract that was called
   * - l1Caller: The L1 contract that initiated the call
   * - prevBlockHash: L2 state before this call
   * - callData: The calldata sent to L2 contract
   * - value: ETH value sent
   * - outgoingCalls: L2→L1 calls made during execution
   * - outgoingCallResults: Results of those L1 calls
   * - finalStateHash: Final L2 state after all calls
   *
   * The fullnode no longer needs to look up L1 transaction calldata.
   */
  private async handleIncomingCallHandled(event: any): Promise<void> {
    // New event signature: IncomingCallHandled(address indexed l2Address, address indexed l1Caller, bytes32 indexed prevBlockHash, bytes callData, uint256 value, OutgoingCall[] outgoingCalls, bytes[] outgoingCallResults, bytes32 finalStateHash)
    const l2Address = event.args?.[0] || event.args?.l2Address;
    const l1Caller = event.args?.[1] || event.args?.l1Caller;
    const prevBlockHash = event.args?.[2] || event.args?.prevBlockHash;
    // Extract data directly from event (new format)
    const callData = event.args?.[3] || event.args?.callData || "0x";
    const value = event.args?.[4] || event.args?.value || 0n;
    const outgoingCalls = event.args?.[5] || event.args?.outgoingCalls || [];
    const outgoingCallResults = event.args?.[6] || event.args?.outgoingCallResults || [];
    const finalStateHash = event.args?.[7] || event.args?.finalStateHash;

    // Use txHash + logIndex as unique key, with fallbacks for different event formats
    const txHash = event.transactionHash || event.log?.transactionHash;
    const logIndex = event.index ?? event.logIndex ?? event.log?.index ?? event.log?.logIndex ?? 0;
    const eventKey = `incoming-${txHash}-${logIndex}`;

    if (this.processedIncomingCalls.has(eventKey)) {
      return; // Already processed
    }
    // Mark as processed IMMEDIATELY to prevent duplicate processing
    this.processedIncomingCalls.add(eventKey);

    log("Fullnode", `Processing incoming call to ${l2Address}...`);
    log("Fullnode", `  Prev block hash: ${prevBlockHash}`);
    log("Fullnode", `  L1 caller: ${l1Caller}`);
    log("Fullnode", `  Value: ${ethers.formatEther(value)} ETH`);
    log("Fullnode", `  Outgoing calls: ${outgoingCalls.length}`);
    log("Fullnode", `  Final state: ${finalStateHash}`);

    try {
      // Check if we're already at the expected state (builder already executed)
      const currentStateRoot = await getStateRoot(this.l2Provider);
      if (currentStateRoot.toLowerCase() === finalStateHash.toLowerCase()) {
        log("Fullnode", `  Already at expected state (builder executed live)`);
        return;
      }

      // For L1→L2 deposits/calls, we need to:
      // 1. Credit ETH if value > 0
      // 2. Execute the contract call if there's calldata

      if (value > 0n) {
        const currentBalance = await this.l2Provider.getBalance(l2Address);
        const newBalance = currentBalance + value;
        await this.l2Provider.send("anvil_setBalance", [
          l2Address,
          "0x" + newBalance.toString(16),
        ]);
        log("Fullnode", `  Credited ${ethers.formatEther(value)} ETH to ${l2Address}`);
      }

      // Execute contract call if there's calldata (extracted directly from event)
      if (callData && callData !== "0x") {
        await this.executeL2ContractCall(l1Caller, l2Address, callData, value);
      }

      // Mine a block to update state
      await this.l2Provider.send("evm_mine", []);

      // Log the state (but don't expect it to match during replay)
      const newStateRoot = await getStateRoot(this.l2Provider);
      log("Fullnode", `  Local state root: ${newStateRoot}`);
      if (newStateRoot.toLowerCase() === finalStateHash.toLowerCase()) {
        log("Fullnode", `  State root MATCHES!`);
      } else {
        log("Fullnode", `  (Note: State roots may differ during replay - Anvil is non-deterministic)`);
      }
    } catch (err: any) {
      log("Fullnode", `  ERROR: ${err.message}`);
    }
  }

  /**
   * Execute an L2 contract call from an L1 caller's proxy
   *
   * When L1 contract A calls L2 contract B:
   * - On L2, msg.sender should be A's proxy (L1SenderProxyL2)
   * - We execute: impersonate(L1SenderProxyL2(A)) → B.call(data)
   */
  private async executeL2ContractCall(
    l1Caller: string,
    l2Target: string,
    callData: string,
    value: bigint
  ): Promise<void> {
    log("Fullnode", `  Executing L2 contract call:`);
    log("Fullnode", `    L1 caller: ${l1Caller}`);
    log("Fullnode", `    L2 target: ${l2Target}`);
    log("Fullnode", `    Call data: ${callData.slice(0, 10)}...`);

    // Compute the L1 caller's proxy address on L2
    const l1ProxyOnL2 = computeL1SenderProxyL2Address(l1Caller);
    log("Fullnode", `    L1's proxy on L2: ${l1ProxyOnL2}`);

    // Impersonate the L1's proxy on L2
    await this.l2Provider.send("anvil_impersonateAccount", [l1ProxyOnL2]);

    // Fund the proxy to pay for gas
    await this.l2Provider.send("anvil_setBalance", [
      l1ProxyOnL2,
      "0x" + ethers.parseEther("1").toString(16),
    ]);

    try {
      // Execute the call as if from L1's proxy
      const txHash = await this.l2Provider.send("eth_sendTransaction", [{
        from: l1ProxyOnL2,
        to: l2Target,
        data: callData,
        value: value > 0n ? "0x" + value.toString(16) : "0x0",
        gas: "0x1000000",
      }]);

      const receipt = await this.l2Provider.waitForTransaction(txHash);
      log("Fullnode", `    L2 tx hash: ${txHash}`);
      log("Fullnode", `    Status: ${receipt?.status === 1 ? "SUCCESS" : "REVERTED"}`);

    } catch (err: any) {
      log("Fullnode", `    L2 call failed: ${err.message}`);
    } finally {
      await this.l2Provider.send("anvil_stopImpersonatingAccount", [l1ProxyOnL2]);
    }
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
      case "--to-block":
        config.toBlock = parseInt(args[++i]);
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
