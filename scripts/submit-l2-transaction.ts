/**
 * Submit Signed L2 Transaction via L1
 *
 * This script demonstrates the correct flow for L2 transactions:
 * 1. User creates and signs an L2 transaction (standard Ethereum tx)
 * 2. Builder simulates it on local Anvil to get resulting state root
 * 3. Builder submits to L1 via processL2Transaction(rawTx, finalStateHash, proof)
 * 4. Fullnode watches L1, decodes raw tx, executes on L2, verifies state
 *
 * Usage:
 *   npx tsx scripts/submit-l2-transaction.ts deploy <privateKey> <bytecode>
 *   npx tsx scripts/submit-l2-transaction.ts call <privateKey> <to> <data> [value]
 */

import {
  ethers,
  JsonRpcProvider,
  Wallet,
  Contract,
  Transaction,
  AbiCoder,
  keccak256,
} from "ethers";
import { spawn, ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";

// Configuration
const L1_RPC = process.env.L1_RPC || "https://rpc.gnosischain.com";
const ROLLUP_ADDRESS = process.env.ROLLUP_ADDRESS || "0xB98fA7a61102e6dA6dd67a4dC8F69013FF3872E1";
const ADMIN_PK = process.env.ADMIN_PK || "0xf2024347d89be67338b62344010fb2ebc5db60cad2ff591a92a30b8215f87f22";
const L2_CHAIN_ID = parseInt(process.env.L2_CHAIN_ID || "10200200");
const L2_PORT = parseInt(process.env.L2_PORT || "9548"); // Different port for builder simulation

// L2 System Address
const L2_SYSTEM_ADDRESS = "0x7d1cc88909370e00d3ca1fd72d9b45b8f1412215";
const L2_SYSTEM_BALANCE = ethers.parseEther("10000000000");

// ABIs
const ROLLUP_ABI = [
  "function l2BlockHash() view returns (bytes32)",
  "function l2BlockNumber() view returns (uint256)",
  "function processL2Transaction(bytes rawTransaction, bytes32 finalStateHash, bytes proof)",
  "event L2TransactionProcessed(uint256 indexed blockNumber, bytes32 indexed txHash, address indexed from, bytes32 newStateHash)",
];

function getContractArtifact(contractPath: string, contractName: string): { abi: any; bytecode: string } {
  const artifactPath = path.join(process.cwd(), `out/${contractPath}/${contractName}.json`);
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  return {
    abi: artifact.abi,
    bytecode: artifact.bytecode.object,
  };
}

class L2TransactionBuilder {
  private l1Provider: JsonRpcProvider;
  private l2Provider!: JsonRpcProvider;
  private adminWallet: Wallet;
  private rollupCore: Contract;
  private anvilProcess: ChildProcess | null = null;

  constructor() {
    this.l1Provider = new JsonRpcProvider(L1_RPC);
    this.adminWallet = new Wallet(ADMIN_PK, this.l1Provider);
    this.rollupCore = new Contract(ROLLUP_ADDRESS, ROLLUP_ABI, this.adminWallet);
  }

  /**
   * Spawn a temporary Anvil for simulation
   */
  private async spawnSimulationAnvil(): Promise<void> {
    const l2Rpc = `http://localhost:${L2_PORT}`;

    console.log(`Spawning simulation Anvil on port ${L2_PORT}...`);

    this.anvilProcess = spawn("anvil", [
      "--port", L2_PORT.toString(),
      "--chain-id", L2_CHAIN_ID.toString(),
      "--accounts", "0",
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

    // Fund the system address
    await this.l2Provider.send("anvil_setBalance", [
      L2_SYSTEM_ADDRESS,
      "0x" + L2_SYSTEM_BALANCE.toString(16),
    ]);

    console.log(`Simulation Anvil ready at ${l2Rpc}`);
  }

  /**
   * Set up L2 state to match current L1 state
   * For simplicity, we just fund the sender's account
   */
  private async setupL2State(sender: string, balance: bigint): Promise<void> {
    await this.l2Provider.send("anvil_setBalance", [
      sender,
      "0x" + balance.toString(16),
    ]);
  }

  /**
   * Submit a signed L2 transaction through L1
   */
  async submitL2Transaction(signedTx: string): Promise<{
    l1TxHash: string;
    l2TxHash: string;
    finalStateRoot: string;
    contractAddress?: string;
  }> {
    console.log("\n=== Submitting L2 Transaction via L1 ===\n");

    // Parse the signed transaction
    const tx = Transaction.from(signedTx);
    console.log(`L2 Transaction:`);
    console.log(`  From: ${tx.from}`);
    console.log(`  To: ${tx.to || "(contract creation)"}`);
    console.log(`  Value: ${ethers.formatEther(tx.value)} xDAI`);
    console.log(`  Nonce: ${tx.nonce}`);
    console.log(`  Gas Limit: ${tx.gasLimit}`);
    console.log(`  Data length: ${tx.data.length} chars`);

    // Spawn simulation Anvil
    await this.spawnSimulationAnvil();

    try {
      // Get current L1 state
      const currentL2Hash = await this.rollupCore.l2BlockHash();
      console.log(`\nCurrent L2 hash on L1: ${currentL2Hash}`);

      // Fund the sender on simulation Anvil
      // In reality, the state would be synced from L1 events
      const senderBalance = ethers.parseEther("100");
      await this.setupL2State(tx.from!, senderBalance);
      console.log(`Funded ${tx.from} with 100 xDAI for simulation`);

      // Submit the raw transaction to simulation Anvil
      console.log(`\nSimulating on local Anvil...`);
      const l2TxHash = await this.l2Provider.send("eth_sendRawTransaction", [signedTx]);
      console.log(`  L2 tx hash: ${l2TxHash}`);

      // Wait for mining
      const receipt = await this.l2Provider.waitForTransaction(l2TxHash);
      console.log(`  Status: ${receipt?.status === 1 ? "success" : "reverted"}`);

      // Get contract address if deployment
      let contractAddress: string | undefined;
      if (!tx.to && receipt?.contractAddress) {
        contractAddress = receipt.contractAddress;
        console.log(`  Contract deployed at: ${contractAddress}`);
      }

      // Get the resulting state root
      const l2Block = await this.l2Provider.getBlock("latest");
      const finalStateRoot = l2Block?.stateRoot;
      if (!finalStateRoot) {
        throw new Error("Failed to get L2 state root");
      }
      console.log(`  Final state root: ${finalStateRoot}`);

      // Sign the proof (admin signature for POC)
      console.log(`\nSigning proof...`);
      const txHashBytes = keccak256(signedTx);
      const messageHash = keccak256(
        AbiCoder.defaultAbiCoder().encode(
          ["bytes32", "bytes32", "bytes32"],
          [currentL2Hash, txHashBytes, finalStateRoot]
        )
      );
      const proof = await this.adminWallet.signMessage(ethers.getBytes(messageHash));
      console.log(`  Proof signed`);

      // Submit to L1
      console.log(`\nSubmitting to L1...`);
      const l1Tx = await this.rollupCore.processL2Transaction(
        signedTx,
        finalStateRoot,
        proof
      );
      const l1Receipt = await l1Tx.wait();
      console.log(`  L1 tx hash: ${l1Receipt?.hash}`);
      console.log(`  L1 block: ${l1Receipt?.blockNumber}`);

      // Verify final state on L1
      const newL2Hash = await this.rollupCore.l2BlockHash();
      console.log(`\nL2 hash on L1 updated to: ${newL2Hash}`);

      if (newL2Hash.toLowerCase() === finalStateRoot.toLowerCase()) {
        console.log(`✓ State roots match!`);
      } else {
        console.log(`✗ State root mismatch!`);
      }

      return {
        l1TxHash: l1Receipt?.hash || "",
        l2TxHash,
        finalStateRoot,
        contractAddress,
      };
    } finally {
      this.stop();
    }
  }

  /**
   * Create and submit a contract deployment
   */
  async deployContract(
    deployerPrivateKey: string,
    bytecode: string,
    constructorArgs?: string
  ): Promise<{
    l1TxHash: string;
    l2TxHash: string;
    contractAddress: string;
    finalStateRoot: string;
  }> {
    // Create wallet for signing
    const deployerWallet = new Wallet(deployerPrivateKey);
    console.log(`Deployer: ${deployerWallet.address}`);

    // Build deployment transaction
    const deployData = bytecode + (constructorArgs || "").replace("0x", "");

    // Get nonce (for fresh Anvil, it's 0 unless we sync state)
    const nonce = 0; // First transaction from this address

    const txRequest = {
      type: 2, // EIP-1559
      chainId: L2_CHAIN_ID,
      nonce,
      to: null, // Contract creation
      value: 0n,
      data: deployData,
      maxFeePerGas: ethers.parseUnits("10", "gwei"),
      maxPriorityFeePerGas: ethers.parseUnits("1", "gwei"),
      gasLimit: 3000000n,
    };

    // Sign the transaction
    const signedTx = await deployerWallet.signTransaction(txRequest);
    console.log(`Signed deployment transaction (${signedTx.length} chars)`);

    // Predict contract address
    const predictedAddress = ethers.getCreateAddress({
      from: deployerWallet.address,
      nonce,
    });
    console.log(`Predicted contract address: ${predictedAddress}`);

    // Submit through L1
    const result = await this.submitL2Transaction(signedTx);

    return {
      l1TxHash: result.l1TxHash,
      l2TxHash: result.l2TxHash,
      contractAddress: result.contractAddress || predictedAddress,
      finalStateRoot: result.finalStateRoot,
    };
  }

  /**
   * Create and submit a contract call
   */
  async callContract(
    callerPrivateKey: string,
    to: string,
    data: string,
    value: bigint = 0n,
    nonce: number = 0
  ): Promise<{
    l1TxHash: string;
    l2TxHash: string;
    finalStateRoot: string;
  }> {
    // Create wallet for signing
    const callerWallet = new Wallet(callerPrivateKey);
    console.log(`Caller: ${callerWallet.address}`);

    const txRequest = {
      type: 2, // EIP-1559
      chainId: L2_CHAIN_ID,
      nonce,
      to,
      value,
      data,
      maxFeePerGas: ethers.parseUnits("10", "gwei"),
      maxPriorityFeePerGas: ethers.parseUnits("1", "gwei"),
      gasLimit: 500000n,
    };

    // Sign the transaction
    const signedTx = await callerWallet.signTransaction(txRequest);
    console.log(`Signed call transaction (${signedTx.length} chars)`);

    // Submit through L1
    return this.submitL2Transaction(signedTx);
  }

  stop(): void {
    if (this.anvilProcess) {
      this.anvilProcess.kill();
      this.anvilProcess = null;
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  const builder = new L2TransactionBuilder();

  try {
    switch (command) {
      case "deploy": {
        const privateKey = args[1];
        const bytecode = args[2];
        const constructorArgs = args[3];

        if (!privateKey || !bytecode) {
          console.log("Usage: npx tsx scripts/submit-l2-transaction.ts deploy <privateKey> <bytecode> [constructorArgs]");
          process.exit(1);
        }

        const result = await builder.deployContract(privateKey, bytecode, constructorArgs);

        console.log("\n=== Deployment Summary ===");
        console.log(`L1 Tx: ${result.l1TxHash}`);
        console.log(`L2 Tx: ${result.l2TxHash}`);
        console.log(`Contract: ${result.contractAddress}`);
        console.log(`State Root: ${result.finalStateRoot}`);
        break;
      }

      case "call": {
        const privateKey = args[1];
        const to = args[2];
        const data = args[3];
        const value = args[4] ? ethers.parseEther(args[4]) : 0n;
        const nonce = args[5] ? parseInt(args[5]) : 0;

        if (!privateKey || !to || !data) {
          console.log("Usage: npx tsx scripts/submit-l2-transaction.ts call <privateKey> <to> <data> [valueEther] [nonce]");
          process.exit(1);
        }

        const result = await builder.callContract(privateKey, to, data, value, nonce);

        console.log("\n=== Call Summary ===");
        console.log(`L1 Tx: ${result.l1TxHash}`);
        console.log(`L2 Tx: ${result.l2TxHash}`);
        console.log(`State Root: ${result.finalStateRoot}`);
        break;
      }

      case "deploy-synced-counter": {
        // Convenience command to deploy L2SyncedCounter
        const privateKey = args[1] || "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

        const artifact = getContractArtifact("SyncedCounter.sol", "L2SyncedCounter");
        const result = await builder.deployContract(privateKey, artifact.bytecode);

        console.log("\n=== L2SyncedCounter Deployment Summary ===");
        console.log(`L1 Tx: ${result.l1TxHash}`);
        console.log(`L2 Tx: ${result.l2TxHash}`);
        console.log(`L2SyncedCounter: ${result.contractAddress}`);
        console.log(`State Root: ${result.finalStateRoot}`);
        break;
      }

      default: {
        console.log("L2 Transaction Builder");
        console.log("");
        console.log("Commands:");
        console.log("  deploy <privateKey> <bytecode> [args]    - Deploy contract on L2");
        console.log("  call <privateKey> <to> <data> [value]    - Call contract on L2");
        console.log("  deploy-synced-counter [privateKey]       - Deploy L2SyncedCounter");
        console.log("");
        console.log("Examples:");
        console.log("  npx tsx scripts/submit-l2-transaction.ts deploy 0x... 0x6080...");
        console.log("  npx tsx scripts/submit-l2-transaction.ts deploy-synced-counter");
        process.exit(0);
      }
    }
  } catch (err: any) {
    console.error("Error:", err.message);
    process.exit(1);
  }
}

main();
