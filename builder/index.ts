/**
 * Native Rollup Builder
 *
 * The builder handles L2 state transitions by:
 * 1. Receiving transactions from users (not from mempool)
 * 2. Simulating on a local L2 Anvil to get real state roots
 * 3. Registering the state transition on L1
 * 4. Then submitting the user's transaction
 *
 * This ensures state roots on L1 match what fullnodes compute.
 *
 * The builder is the "prover" in POC mode - it signs proofs with admin key.
 * In production, this would be replaced with ZK proofs.
 */

import {
  ethers,
  Contract,
  JsonRpcProvider,
  Wallet,
  AbiCoder,
  keccak256,
} from "ethers";
import { spawn, ChildProcess } from "child_process";

// ============ Configuration ============

export interface BuilderConfig {
  l1Rpc: string;
  rollupAddress: string;
  adminPrivateKey: string;
  l2Port: number;
  l2ChainId: number;
}

const DEFAULT_CONFIG: BuilderConfig = {
  l1Rpc: process.env.L1_RPC || "https://rpc.gnosischain.com",
  rollupAddress:
    process.env.ROLLUP_ADDRESS || "0x5E87A156F55c85e765C81af1312C76f8a9a1bc7d",
  adminPrivateKey:
    process.env.ADMIN_PK ||
    "0xf2024347d89be67338b62344010fb2ebc5db60cad2ff591a92a30b8215f87f22",
  l2Port: parseInt(process.env.L2_PORT || "9547"), // Different from fullnode default
  l2ChainId: parseInt(process.env.L2_CHAIN_ID || "10200200"),
};

// ============ ABI ============

const ROLLUP_ABI = [
  "function l2BlockHash() view returns (bytes32)",
  "function l2BlockNumber() view returns (uint256)",
  "function getProxyAddress(address l2Address) view returns (address)",
  "function isProxyDeployed(address l2Address) view returns (bool)",
  "function deployProxy(address l2Address) returns (address)",
  "function registerIncomingCall(address l2Address, bytes32 stateHash, bytes calldata callData, tuple(bytes32 preOutgoingCallsStateHash, tuple(address from, address target, uint256 value, uint256 gas, bytes data, bytes32 postCallStateHash)[] outgoingCalls, bytes[] expectedResults, bytes returnValue, bytes32 finalStateHash) response, bytes proof)",
  "event IncomingCallHandled(address indexed l2Address, bytes32 indexed responseKey, uint256 outgoingCallsCount, uint256 value)",
];

// ============ Types ============

/**
 * A deposit request from a user
 */
export interface DepositRequest {
  l2Recipient: string;
  value: bigint;
  callData?: string;
}

export interface BuildResult {
  success: boolean;
  l1TxHash?: string;
  l2StateRoot?: string;
  error?: string;
}

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

// ============ Builder ============

export class Builder {
  private config: BuilderConfig;
  private l1Provider: JsonRpcProvider;
  private l2Provider!: JsonRpcProvider;
  private adminWallet: Wallet;
  private rollupCore: Contract;
  private anvilProcess: ChildProcess | null = null;
  private isReady: boolean = false;

  constructor(config: Partial<BuilderConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.l1Provider = new JsonRpcProvider(this.config.l1Rpc);
    this.adminWallet = new Wallet(this.config.adminPrivateKey, this.l1Provider);
    this.rollupCore = new Contract(
      this.config.rollupAddress,
      ROLLUP_ABI,
      this.adminWallet
    );
  }

  /**
   * Start the builder - spawn L2 Anvil
   */
  async start(): Promise<void> {
    console.log("=== Native Rollup Builder ===");
    console.log(`L1 RPC: ${this.config.l1Rpc}`);
    console.log(`NativeRollupCore: ${this.config.rollupAddress}`);
    console.log(`Admin: ${this.adminWallet.address}`);
    console.log("");

    // Spawn L2 Anvil
    await this.spawnL2Anvil();

    // Get current L2 state from L1
    const l2BlockHash = await this.rollupCore.l2BlockHash();
    const l2BlockNumber = await this.rollupCore.l2BlockNumber();

    console.log(`Current L2 state on L1:`);
    console.log(`  Block number: ${l2BlockNumber}`);
    console.log(`  Block hash: ${l2BlockHash}`);

    // Check if L2 state matches
    const l2Block = await this.l2Provider.getBlock("latest");
    const l2StateRoot = l2Block?.stateRoot;

    console.log(`Local L2 state root: ${l2StateRoot}`);

    if (l2BlockHash.toLowerCase() === l2StateRoot?.toLowerCase()) {
      console.log(`✓ State roots match!`);
    } else {
      console.log(`⚠ State roots don't match yet (fresh Anvil)`);
      // This is expected for a fresh Anvil - state will match after first operation
    }

    this.isReady = true;
    console.log("\nBuilder ready to accept transactions.");
  }

  /**
   * Spawn L2 Anvil instance
   */
  private async spawnL2Anvil(): Promise<void> {
    const l2Rpc = `http://localhost:${this.config.l2Port}`;

    console.log(`Spawning L2 Anvil on port ${this.config.l2Port}...`);

    this.anvilProcess = spawn(
      "anvil",
      [
        "--port",
        this.config.l2Port.toString(),
        "--chain-id",
        this.config.l2ChainId.toString(),
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
    console.log(`L2 Anvil ready at ${l2Rpc}`);
  }

  /**
   * Process a deposit request
   *
   * Flow:
   * 1. Deploy proxy on L1 if needed
   * 2. Simulate deposit on local L2 to get real state root
   * 3. Register incoming call on L1 with real state root
   * 4. Execute the deposit (call proxy with value)
   */
  async processDeposit(request: DepositRequest): Promise<BuildResult> {
    if (!this.isReady) {
      return { success: false, error: "Builder not ready. Call start() first." };
    }

    console.log(`\n=== Processing Deposit ===`);
    console.log(`L2 Recipient: ${request.l2Recipient}`);
    console.log(`Value: ${ethers.formatEther(request.value)} xDAI`);

    try {
      // Step 1: Get current L2 state from L1
      const currentL2Hash = await this.rollupCore.l2BlockHash();
      console.log(`Current L2 hash on L1: ${currentL2Hash}`);

      // Step 2: Deploy proxy on L1 if needed
      const isDeployed = await this.rollupCore.isProxyDeployed(request.l2Recipient);
      let proxyAddress = await this.rollupCore.getProxyAddress(request.l2Recipient);

      if (!isDeployed) {
        console.log(`Deploying proxy for ${request.l2Recipient}...`);
        const deployTx = await this.rollupCore.deployProxy(request.l2Recipient);
        await deployTx.wait();
        console.log(`  Proxy deployed at: ${proxyAddress}`);
      } else {
        console.log(`Proxy already deployed at: ${proxyAddress}`);
      }

      // Step 3: Simulate the deposit on local L2
      console.log(`Simulating deposit on local L2...`);

      // Compute the L1 caller's proxy on L2
      const l1Caller = this.adminWallet.address;
      const l1CallerProxyOnL2 = computeL2ProxyAddress(l1Caller);
      console.log(`  L1 caller proxy on L2: ${l1CallerProxyOnL2}`);

      // Impersonate and execute on L2
      await this.l2Provider.send("anvil_impersonateAccount", [l1CallerProxyOnL2]);

      // Give the proxy enough balance for gas + deposit
      const gasAllowance = ethers.parseEther("0.1");
      await this.l2Provider.send("anvil_setBalance", [
        l1CallerProxyOnL2,
        "0x" + (request.value + gasAllowance).toString(16),
      ]);

      // Execute the deposit
      const l2Signer = await this.l2Provider.getSigner(l1CallerProxyOnL2);
      const l2Tx = await l2Signer.sendTransaction({
        to: request.l2Recipient,
        value: request.value,
        data: request.callData || "0x",
      });
      await l2Tx.wait();

      await this.l2Provider.send("anvil_stopImpersonatingAccount", [l1CallerProxyOnL2]);

      // Get the new state root
      const newBlock = await this.l2Provider.getBlock("latest");
      const newStateRoot = newBlock?.stateRoot;
      if (!newStateRoot) {
        return { success: false, error: "Failed to get new L2 state root" };
      }
      console.log(`  New L2 state root: ${newStateRoot}`);

      // Step 4: Register incoming call on L1 with the real state root
      console.log(`Registering incoming call on L1...`);

      const callData = request.callData || "0x";
      const response = {
        preOutgoingCallsStateHash: newStateRoot,
        outgoingCalls: [],
        expectedResults: [],
        returnValue: "0x",
        finalStateHash: newStateRoot,
      };

      const proof = await this.signIncomingCallProof(
        request.l2Recipient,
        currentL2Hash,
        callData,
        newStateRoot,
        keccak256("0x"),
        keccak256("0x"),
        keccak256("0x"),
        newStateRoot
      );

      const registerTx = await this.rollupCore.registerIncomingCall(
        request.l2Recipient,
        currentL2Hash,
        callData,
        response,
        proof
      );
      const registerReceipt = await registerTx.wait();
      console.log(`  Register tx: ${registerReceipt?.hash}`);

      // Step 5: Execute the deposit on L1 (call proxy with value)
      console.log(`Executing deposit on L1...`);

      const depositTx = await this.adminWallet.sendTransaction({
        to: proxyAddress,
        value: request.value,
        data: request.callData || "0x",
      });
      const depositReceipt = await depositTx.wait();
      console.log(`  Deposit tx: ${depositReceipt?.hash}`);

      // Verify final state
      const finalL2Hash = await this.rollupCore.l2BlockHash();
      console.log(`\nFinal L2 hash on L1: ${finalL2Hash}`);
      console.log(`Expected (local):    ${newStateRoot}`);

      if (finalL2Hash.toLowerCase() === newStateRoot.toLowerCase()) {
        console.log(`✓ State roots match!`);
      } else {
        console.log(`✗ State roots don't match!`);
      }

      return {
        success: true,
        l1TxHash: depositReceipt?.hash,
        l2StateRoot: newStateRoot,
      };
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  /**
   * Sign proof for registerIncomingCall
   */
  private async signIncomingCallProof(
    l2Address: string,
    stateHash: string,
    callData: string,
    preOutgoingState: string,
    outgoingCallsHash: string,
    resultsHash: string,
    returnValueHash: string,
    finalState: string
  ): Promise<string> {
    const messageHash = keccak256(
      AbiCoder.defaultAbiCoder().encode(
        [
          "address",
          "bytes32",
          "bytes32",
          "bytes32",
          "bytes32",
          "bytes32",
          "bytes32",
          "bytes32",
        ],
        [
          l2Address,
          stateHash,
          keccak256(callData),
          preOutgoingState,
          outgoingCallsHash,
          resultsHash,
          returnValueHash,
          finalState,
        ]
      )
    );

    return await this.adminWallet.signMessage(ethers.getBytes(messageHash));
  }

  /**
   * Get current status
   */
  async getStatus(): Promise<{
    l1BlockHash: string;
    l2StateRoot: string;
    synced: boolean;
  }> {
    const l1BlockHash = await this.rollupCore.l2BlockHash();
    const l2Block = await this.l2Provider.getBlock("latest");
    const l2StateRoot = l2Block?.stateRoot || "0x0";

    return {
      l1BlockHash,
      l2StateRoot,
      synced: l1BlockHash.toLowerCase() === l2StateRoot.toLowerCase(),
    };
  }

  /**
   * Stop the builder
   */
  stop(): void {
    if (this.anvilProcess) {
      console.log("Stopping L2 Anvil...");
      this.anvilProcess.kill();
      this.anvilProcess = null;
    }
    console.log("Builder stopped.");
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
  const args = process.argv.slice(2);
  const command = args[0];

  const builder = new Builder();

  // Handle graceful shutdown
  process.on("SIGINT", () => {
    console.log("\nShutting down...");
    builder.stop();
    process.exit(0);
  });

  switch (command) {
    case "deposit": {
      // deposit <l2Recipient> <amountEther>
      const l2Recipient = args[1];
      const amountEther = args[2];

      if (!l2Recipient || !amountEther) {
        console.log("Usage: npx tsx builder/index.ts deposit <l2Recipient> <amountEther>");
        console.log("Example: npx tsx builder/index.ts deposit 0x7B2e78D4dFaABA045A167a70dA285E30E8FcA196 0.01");
        process.exit(1);
      }

      await builder.start();

      const result = await builder.processDeposit({
        l2Recipient,
        value: ethers.parseEther(amountEther),
      });

      if (result.success) {
        console.log("\n=== Deposit Complete ===");
        console.log(`L1 Tx: ${result.l1TxHash}`);
        console.log(`L2 State Root: ${result.l2StateRoot}`);
      } else {
        console.error(`\nDeposit failed: ${result.error}`);
      }

      builder.stop();
      break;
    }

    case "status": {
      await builder.start();
      const status = await builder.getStatus();

      console.log("\n=== Status ===");
      console.log(`L1 Block Hash: ${status.l1BlockHash}`);
      console.log(`L2 State Root: ${status.l2StateRoot}`);
      console.log(`Synced: ${status.synced ? "YES" : "NO"}`);

      builder.stop();
      break;
    }

    default: {
      console.log("Native Rollup Builder");
      console.log("");
      console.log("Commands:");
      console.log("  deposit <l2Recipient> <amountEther>  - Deposit xDAI to L2 address");
      console.log("  status                                - Show current state");
      console.log("");
      console.log("Examples:");
      console.log("  npx tsx builder/index.ts deposit 0x7B2e78D4dFaABA045A167a70dA285E30E8FcA196 0.01");
      console.log("  npx tsx builder/index.ts status");
      process.exit(0);
    }
  }
}

if (process.argv[1]?.includes("builder")) {
  main().catch((err) => {
    console.error("Builder error:", err);
    process.exit(1);
  });
}

export { Builder as default };
