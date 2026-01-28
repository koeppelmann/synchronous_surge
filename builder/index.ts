/**
 * Native Rollup Builder
 *
 * The builder handles L2 state transitions by:
 * 1. Receiving transactions from users (not from mempool)
 * 2. Simulating on a local L2 Anvil to get real state roots
 * 3. Registering the state transition on L1
 * 4. Then submitting the user's transaction
 *
 * Key design:
 * - ALL L2 transactions are sent FROM the L2 System Address
 * - The system address is pre-funded in genesis (10 billion xDAI)
 * - L1 callers are represented by L1SenderProxyL2 contracts on L2
 * - System address calls proxy, proxy forwards to target with correct msg.sender
 *
 * This ensures determinism - no per-call balance manipulation needed.
 */

import {
  ethers,
  Contract,
  ContractFactory,
  JsonRpcProvider,
  Wallet,
  AbiCoder,
  keccak256,
  Interface,
} from "ethers";
import { spawn, ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";

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
  // Expected address after deployment (nonce 449)
  rollupAddress:
    process.env.ROLLUP_ADDRESS || "0xBdec2590117ED5D3ec3dca8EcC1E5d2CbEaedfAf",
  adminPrivateKey:
    process.env.ADMIN_PK ||
    "0xf2024347d89be67338b62344010fb2ebc5db60cad2ff591a92a30b8215f87f22",
  l2Port: parseInt(process.env.L2_PORT || "9547"),
  l2ChainId: parseInt(process.env.L2_CHAIN_ID || "10200200"),
};

// ============ Constants ============

/**
 * L2 System Address - computed as:
 * keccak256(encode("NativeRollup.L1SenderProxy.v1", NativeRollupCoreAddress))
 * This is the proxy of the L1 NativeRollupCore contract on L2.
 *
 * Pre-funded in genesis with 10 billion xDAI.
 * ALL L2 transactions originate from this address.
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
  "function l2BlockHash() view returns (bytes32)",
  "function l2BlockNumber() view returns (uint256)",
  "function getProxyAddress(address l2Address) view returns (address)",
  "function isProxyDeployed(address l2Address) view returns (bool)",
  "function deployProxy(address l2Address) returns (address)",
  "function registerIncomingCall(address l2Address, bytes32 stateHash, bytes calldata callData, tuple(bytes32 preOutgoingCallsStateHash, tuple(address from, address target, uint256 value, uint256 gas, bytes data, bytes32 postCallStateHash)[] outgoingCalls, bytes[] expectedResults, bytes returnValue, bytes32 finalStateHash) response, bytes proof)",
  "event IncomingCallHandled(address indexed l2Address, bytes32 indexed responseKey, uint256 outgoingCallsCount, uint256 value)",
];

const L2_PROXY_FACTORY_ABI = [
  "function deployProxy(address l1Address) returns (address)",
  "function computeProxyAddress(address l1Address) view returns (address)",
  "function isProxyDeployed(address l1Address) view returns (bool)",
  "function getProxy(address l1Address) view returns (address)",
  "function proxies(address) view returns (address)",
];

const L2_PROXY_ABI = [
  "function systemAddress() view returns (address)",
  "function l1Address() view returns (address)",
];

// ============ Types ============

export interface DepositRequest {
  l2Recipient: string;
  value: bigint;
  callData?: string;
}

export interface BuildResult {
  success: boolean;
  l1TxHash?: string;
  l2StateRoot?: string;
  contractAddress?: string;
  error?: string;
}

export interface DeployRequest {
  deployer: string;
  bytecode: string;
  constructorArgs?: string;
}

export interface L1ToL2CallRequest {
  l1Caller: string;    // L1 address making the call
  l2Target: string;    // L2 address being called
  callData: string;    // Call data for the L2 contract
  value: bigint;       // Value to send
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

function getContractArtifact(contractName: string): { abi: any; bytecode: string } {
  const artifactPath = path.join(
    process.cwd(),
    `out/L1SenderProxyL2.sol/${contractName}.json`
  );

  if (!fs.existsSync(artifactPath)) {
    throw new Error(`Contract artifact not found: ${artifactPath}. Run 'forge build' first.`);
  }

  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  return {
    abi: artifact.abi,
    bytecode: artifact.bytecode.object,
  };
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

  // L2 infrastructure contracts
  private l2ProxyFactory: Contract | null = null;
  private l2CallRegistry: Contract | null = null;
  private l2ProxyFactoryAddress: string | null = null;
  private l2CallRegistryAddress: string | null = null;

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
   * Start the builder - spawn L2 Anvil and deploy L2 infrastructure
   */
  async start(): Promise<void> {
    console.log("=== Native Rollup Builder ===");
    console.log(`L1 RPC: ${this.config.l1Rpc}`);
    console.log(`NativeRollupCore: ${this.config.rollupAddress}`);
    console.log(`Admin: ${this.adminWallet.address}`);
    console.log(`L2 System Address: ${L2_SYSTEM_ADDRESS}`);
    console.log("");

    // Spawn L2 Anvil with system address pre-funded
    await this.spawnL2Anvil();

    // Deploy L2 infrastructure (CallRegistry and ProxyFactory)
    await this.deployL2Infrastructure();

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
      console.log(`⚠ State roots don't match yet (fresh Anvil with infrastructure)`);
    }

    this.isReady = true;
    console.log("\nBuilder ready to accept transactions.");
  }

  /**
   * Spawn L2 Anvil instance with system address pre-funded
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
        "--accounts",
        "0", // No pre-funded accounts - only system address gets funded
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

    // Fund the L2 system address
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
   * Deploy L2 infrastructure contracts (CallRegistry and ProxyFactory)
   */
  private async deployL2Infrastructure(): Promise<void> {
    console.log(`Deploying L2 infrastructure...`);

    // Impersonate system address for deployments
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
   * Ensure L1 caller has a proxy on L2, deploy if not
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
   * Process an L1→L2 call
   *
   * Flow:
   * 1. Ensure L1 caller has a proxy on L2
   * 2. System address calls the proxy with (target + calldata)
   * 3. Proxy forwards to target with msg.sender = proxy
   */
  async processL1ToL2Call(request: L1ToL2CallRequest): Promise<BuildResult> {
    if (!this.isReady) {
      return { success: false, error: "Builder not ready. Call start() first." };
    }

    console.log(`\n=== Processing L1→L2 Call ===`);
    console.log(`L1 Caller: ${request.l1Caller}`);
    console.log(`L2 Target: ${request.l2Target}`);
    console.log(`Value: ${ethers.formatEther(request.value)} xDAI`);

    try {
      // Step 1: Get current L2 state from L1
      const currentL2Hash = await this.rollupCore.l2BlockHash();
      console.log(`Current L2 hash on L1: ${currentL2Hash}`);

      // Step 2: Ensure L1 caller has proxy on L2
      const l1CallerL2Proxy = await this.ensureL2Proxy(request.l1Caller);
      console.log(`L1 caller's L2 proxy: ${l1CallerL2Proxy}`);

      // Step 3: Simulate the call on L2
      console.log(`Simulating call on L2...`);

      await this.l2Provider.send("anvil_impersonateAccount", [L2_SYSTEM_ADDRESS]);
      const systemSigner = await this.l2Provider.getSigner(L2_SYSTEM_ADDRESS);

      // Encode the call: target address (20 bytes) + calldata
      const proxyCallData = ethers.concat([
        request.l2Target,
        request.callData || "0x",
      ]);

      // System calls the proxy, which forwards to target
      const l2Tx = await systemSigner.sendTransaction({
        to: l1CallerL2Proxy,
        data: proxyCallData,
        value: request.value,
      });
      await l2Tx.wait();

      await this.l2Provider.send("anvil_stopImpersonatingAccount", [L2_SYSTEM_ADDRESS]);

      // Get the new state root
      const newBlock = await this.l2Provider.getBlock("latest");
      const newStateRoot = newBlock?.stateRoot;
      if (!newStateRoot) {
        return { success: false, error: "Failed to get new L2 state root" };
      }
      console.log(`  New L2 state root: ${newStateRoot}`);

      // Step 4: Register and execute on L1
      console.log(`Registering incoming call on L1...`);

      // Deploy L1 proxy for the L2 target if needed
      const isL1ProxyDeployed = await this.rollupCore.isProxyDeployed(request.l2Target);
      let l1ProxyAddress = await this.rollupCore.getProxyAddress(request.l2Target);

      if (!isL1ProxyDeployed) {
        console.log(`  Deploying L1 proxy for ${request.l2Target}...`);
        const deployTx = await this.rollupCore.deployProxy(request.l2Target);
        await deployTx.wait();
        console.log(`  L1 proxy deployed at: ${l1ProxyAddress}`);
      }

      const response = {
        preOutgoingCallsStateHash: newStateRoot,
        outgoingCalls: [],
        expectedResults: [],
        returnValue: "0x",
        finalStateHash: newStateRoot,
      };

      const callData = request.callData || "0x";
      const proof = await this.signIncomingCallProof(
        request.l2Target,
        currentL2Hash,
        callData,
        newStateRoot,
        keccak256("0x"),
        keccak256("0x"),
        keccak256("0x"),
        newStateRoot
      );

      const registerTx = await this.rollupCore.registerIncomingCall(
        request.l2Target,
        currentL2Hash,
        callData,
        response,
        proof
      );
      const registerReceipt = await registerTx.wait();
      console.log(`  Register tx: ${registerReceipt?.hash}`);

      // Execute the call on L1
      console.log(`Executing call on L1...`);
      const executeTx = await this.adminWallet.sendTransaction({
        to: l1ProxyAddress,
        data: request.callData || "0x",
        value: request.value,
      });
      const executeReceipt = await executeTx.wait();
      console.log(`  Execute tx: ${executeReceipt?.hash}`);

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
        l1TxHash: executeReceipt?.hash,
        l2StateRoot: newStateRoot,
      };
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  /**
   * Process a deposit (simplified L1→L2 value transfer)
   */
  async processDeposit(request: DepositRequest): Promise<BuildResult> {
    return this.processL1ToL2Call({
      l1Caller: this.adminWallet.address,
      l2Target: request.l2Recipient,
      callData: request.callData || "0x",
      value: request.value,
    });
  }

  /**
   * Process a contract deployment on L2
   */
  async processDeployment(request: DeployRequest): Promise<BuildResult> {
    if (!this.isReady) {
      return { success: false, error: "Builder not ready. Call start() first." };
    }

    console.log(`\n=== Processing Contract Deployment ===`);
    console.log(`Deployer (L1): ${request.deployer}`);

    try {
      // Step 1: Get current L2 state from L1
      const currentL2Hash = await this.rollupCore.l2BlockHash();
      console.log(`Current L2 hash on L1: ${currentL2Hash}`);

      // Step 2: Ensure deployer has proxy on L2
      const deployerL2Proxy = await this.ensureL2Proxy(request.deployer);
      console.log(`Deployer's L2 proxy: ${deployerL2Proxy}`);

      // Step 3: Simulate deployment on L2
      // For deployment, we need to deploy from the proxy address
      // We'll impersonate the proxy (not system) for the actual deployment
      console.log(`Simulating deployment on L2...`);

      await this.l2Provider.send("anvil_impersonateAccount", [deployerL2Proxy]);
      const proxySigner = await this.l2Provider.getSigner(deployerL2Proxy);

      // Get nonce for contract address prediction
      const nonce = await this.l2Provider.getTransactionCount(deployerL2Proxy);
      const contractAddress = ethers.getCreateAddress({
        from: deployerL2Proxy,
        nonce: nonce,
      });
      console.log(`  Expected contract address: ${contractAddress}`);

      // Deploy the contract
      const deployBytecode = request.bytecode + (request.constructorArgs || "").replace("0x", "");
      const l2Tx = await proxySigner.sendTransaction({
        data: deployBytecode,
        gasLimit: 3000000,
      });
      await l2Tx.wait();

      await this.l2Provider.send("anvil_stopImpersonatingAccount", [deployerL2Proxy]);

      // Verify deployment
      const deployedCode = await this.l2Provider.getCode(contractAddress);
      if (deployedCode === "0x") {
        return { success: false, error: "Contract deployment failed on L2 simulation" };
      }
      console.log(`  Contract deployed at: ${contractAddress}`);
      console.log(`  Code length: ${(deployedCode.length - 2) / 2} bytes`);

      // Get the new state root
      const newBlock = await this.l2Provider.getBlock("latest");
      const newStateRoot = newBlock?.stateRoot;
      if (!newStateRoot) {
        return { success: false, error: "Failed to get new L2 state root" };
      }
      console.log(`  New L2 state root: ${newStateRoot}`);

      // Step 4: Register and execute on L1
      console.log(`Registering deployment on L1...`);

      // Deploy L1 proxy for the new contract address
      const isL1ProxyDeployed = await this.rollupCore.isProxyDeployed(contractAddress);
      let l1ProxyAddress = await this.rollupCore.getProxyAddress(contractAddress);

      if (!isL1ProxyDeployed) {
        const deployTx = await this.rollupCore.deployProxy(contractAddress);
        await deployTx.wait();
        console.log(`  L1 proxy deployed at: ${l1ProxyAddress}`);
      }

      const response = {
        preOutgoingCallsStateHash: newStateRoot,
        outgoingCalls: [],
        expectedResults: [],
        returnValue: AbiCoder.defaultAbiCoder().encode(["address"], [contractAddress]),
        finalStateHash: newStateRoot,
      };

      const proof = await this.signIncomingCallProof(
        contractAddress,
        currentL2Hash,
        deployBytecode,
        newStateRoot,
        keccak256("0x"),
        keccak256("0x"),
        keccak256(response.returnValue),
        newStateRoot
      );

      const registerTx = await this.rollupCore.registerIncomingCall(
        contractAddress,
        currentL2Hash,
        deployBytecode,
        response,
        proof
      );
      const registerReceipt = await registerTx.wait();
      console.log(`  Register tx: ${registerReceipt?.hash}`);

      // Execute deployment trigger on L1
      console.log(`Executing deployment trigger on L1...`);
      const triggerTx = await this.adminWallet.sendTransaction({
        to: l1ProxyAddress,
        data: deployBytecode,
      });
      const triggerReceipt = await triggerTx.wait();
      console.log(`  Trigger tx: ${triggerReceipt?.hash}`);

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
        l1TxHash: triggerReceipt?.hash,
        l2StateRoot: newStateRoot,
        contractAddress,
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
    l2ProxyFactoryAddress: string | null;
    l2CallRegistryAddress: string | null;
  }> {
    const l1BlockHash = await this.rollupCore.l2BlockHash();
    const l2Block = await this.l2Provider.getBlock("latest");
    const l2StateRoot = l2Block?.stateRoot || "0x0";

    return {
      l1BlockHash,
      l2StateRoot,
      synced: l1BlockHash.toLowerCase() === l2StateRoot.toLowerCase(),
      l2ProxyFactoryAddress: this.l2ProxyFactoryAddress,
      l2CallRegistryAddress: this.l2CallRegistryAddress,
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

  /**
   * Get L2 infrastructure addresses
   */
  getL2Infrastructure(): { proxyFactory: string | null; callRegistry: string | null } {
    return {
      proxyFactory: this.l2ProxyFactoryAddress,
      callRegistry: this.l2CallRegistryAddress,
    };
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
      console.log(`L2 Proxy Factory: ${status.l2ProxyFactoryAddress}`);
      console.log(`L2 Call Registry: ${status.l2CallRegistryAddress}`);

      builder.stop();
      break;
    }

    case "deploy": {
      const deployer = args[1];
      const bytecode = args[2];
      const constructorArgs = args[3];

      if (!deployer || !bytecode) {
        console.log("Usage: npx tsx builder/index.ts deploy <deployer> <bytecode> [constructorArgs]");
        console.log("Example: npx tsx builder/index.ts deploy 0xE5e69c567516C6C3E88ABEb2455d1228d2aF35F1 0x608060...");
        process.exit(1);
      }

      await builder.start();

      const result = await builder.processDeployment({
        deployer,
        bytecode,
        constructorArgs,
      });

      if (result.success) {
        console.log("\n=== Deployment Complete ===");
        console.log(`L1 Tx: ${result.l1TxHash}`);
        console.log(`L2 Contract: ${result.contractAddress}`);
        console.log(`L2 State Root: ${result.l2StateRoot}`);
      } else {
        console.error(`\nDeployment failed: ${result.error}`);
      }

      builder.stop();
      break;
    }

    default: {
      console.log("Native Rollup Builder");
      console.log("");
      console.log("Commands:");
      console.log("  deposit <l2Recipient> <amountEther>  - Deposit xDAI to L2 address");
      console.log("  deploy <deployer> <bytecode> [args]  - Deploy contract on L2");
      console.log("  status                                - Show current state");
      console.log("");
      console.log("Examples:");
      console.log("  npx tsx builder/index.ts deposit 0x7B2e78D4dFaABA045A167a70dA285E30E8FcA196 0.01");
      console.log("  npx tsx builder/index.ts deploy 0xE5e69c567516C6C3E88ABEb2455d1228d2aF35F1 0x608060...");
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
