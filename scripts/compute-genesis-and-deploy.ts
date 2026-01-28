/**
 * Compute Genesis State Root and Deploy NativeRollupCore
 *
 * This script:
 * 1. Computes the expected NativeRollupCore address based on deployer nonce
 * 2. Computes the L2 System Address from that
 * 3. Spawns a fresh Anvil and sets the system address balance
 * 4. Gets the state root (this is our genesis hash)
 * 5. Deploys NativeRollupCore to Gnosis mainnet with the correct genesis
 */

import {
  ethers,
  JsonRpcProvider,
  Wallet,
  ContractFactory,
  AbiCoder,
  keccak256,
} from "ethers";
import { spawn, ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";

// Configuration
const L1_RPC = process.env.L1_RPC || "https://rpc.gnosischain.com";
const ADMIN_PK = process.env.ADMIN_PK || "0xf2024347d89be67338b62344010fb2ebc5db60cad2ff591a92a30b8215f87f22";
const L2_CHAIN_ID = 10200200;
const L2_SYSTEM_BALANCE = ethers.parseEther("10000000000"); // 10 billion xDAI

function computeL2SystemAddress(rollupAddress: string): string {
  const hash = keccak256(
    AbiCoder.defaultAbiCoder().encode(
      ["string", "address"],
      ["NativeRollup.L1SenderProxy.v1", rollupAddress]
    )
  );
  return "0x" + hash.slice(-40);
}

function getContractArtifact(contractPath: string, contractName: string): { abi: any; bytecode: string } {
  const artifactPath = path.join(process.cwd(), `out/${contractPath}/${contractName}.json`);

  if (!fs.existsSync(artifactPath)) {
    console.log("Compiling contracts...");
    execSync("forge build", { stdio: "inherit" });
  }

  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  return {
    abi: artifact.abi,
    bytecode: artifact.bytecode.object,
  };
}

async function spawnAnvil(port: number): Promise<{ process: ChildProcess; provider: JsonRpcProvider }> {
  const anvilProcess = spawn("anvil", [
    "--port", port.toString(),
    "--chain-id", L2_CHAIN_ID.toString(),
    "--accounts", "0", // No pre-funded accounts - only system address gets funded
    "--silent",
  ], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  const rpc = `http://localhost:${port}`;

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Anvil timeout")), 10000);

    const checkReady = async () => {
      try {
        const provider = new JsonRpcProvider(rpc);
        await provider.getBlockNumber();
        clearTimeout(timeout);
        resolve();
      } catch {
        setTimeout(checkReady, 100);
      }
    };

    anvilProcess.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    checkReady();
  });

  const provider = new JsonRpcProvider(rpc);
  return { process: anvilProcess, provider };
}

async function computeGenesisStateRoot(
  systemAddress: string,
  systemBalance: bigint
): Promise<string> {
  console.log("\n=== Computing Genesis State Root ===\n");
  console.log(`L2 System Address: ${systemAddress}`);
  console.log(`L2 System Balance: ${ethers.formatEther(systemBalance)} xDAI`);

  // Spawn a fresh Anvil to compute the genesis state
  const { process: anvilProcess, provider } = await spawnAnvil(9553);

  try {
    // Set the system address balance
    await provider.send("anvil_setBalance", [
      systemAddress,
      "0x" + systemBalance.toString(16),
    ]);

    // Mine a block to ensure state is committed
    await provider.send("evm_mine", []);

    // Verify balance was set
    const balance = await provider.getBalance(systemAddress);
    console.log(`System address balance: ${ethers.formatEther(balance)} xDAI`);

    // Get the state root
    const block = await provider.getBlock("latest");
    const stateRoot = block?.stateRoot;

    if (!stateRoot || stateRoot === "0x0000000000000000000000000000000000000000000000000000000000000000") {
      throw new Error("Failed to get valid state root");
    }

    console.log(`Genesis State Root: ${stateRoot}`);

    return stateRoot;
  } finally {
    anvilProcess.kill();
    // Wait a moment to ensure port is freed
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = !args.includes("--deploy");

  console.log("=== NativeRollupCore Genesis Calculator ===\n");

  // Setup L1 provider and wallet
  const l1Provider = new JsonRpcProvider(L1_RPC);
  const adminWallet = new Wallet(ADMIN_PK, l1Provider);

  console.log(`L1 RPC: ${L1_RPC}`);
  console.log(`Admin: ${adminWallet.address}`);

  // Get current nonce
  const nonce = await l1Provider.getTransactionCount(adminWallet.address);
  console.log(`Current nonce: ${nonce}`);

  // Compute expected NativeRollupCore address
  // Note: We might deploy AdminProofVerifier first (nonce), then NativeRollupCore (nonce+1)
  // Let's check if AdminProofVerifier is already deployed
  const verifierAtNonce = ethers.getCreateAddress({ from: adminWallet.address, nonce });
  const rollupAtNonce1 = ethers.getCreateAddress({ from: adminWallet.address, nonce: nonce + 1 });

  console.log(`\nExpected deployment addresses:`);
  console.log(`  Nonce ${nonce}: ${verifierAtNonce}`);
  console.log(`  Nonce ${nonce + 1}: ${rollupAtNonce1}`);

  // For simplicity, let's assume:
  // - Nonce N: Deploy AdminProofVerifier
  // - Nonce N+1: Deploy NativeRollupCore
  const expectedRollupAddress = rollupAtNonce1;
  const expectedVerifierAddress = verifierAtNonce;

  console.log(`\nExpected NativeRollupCore: ${expectedRollupAddress}`);

  // Compute L2 System Address
  const l2SystemAddress = computeL2SystemAddress(expectedRollupAddress);
  console.log(`L2 System Address: ${l2SystemAddress}`);

  // Compute genesis state root
  const genesisStateRoot = await computeGenesisStateRoot(l2SystemAddress, L2_SYSTEM_BALANCE);

  console.log("\n=== Summary ===\n");
  console.log(`AdminProofVerifier (expected): ${expectedVerifierAddress}`);
  console.log(`NativeRollupCore (expected):   ${expectedRollupAddress}`);
  console.log(`L2 System Address:             ${l2SystemAddress}`);
  console.log(`Genesis State Root:            ${genesisStateRoot}`);
  console.log(`L2 Chain ID:                   ${L2_CHAIN_ID}`);

  if (dryRun) {
    console.log("\n⚠️  DRY RUN - Not deploying. Add --deploy to actually deploy.\n");
    console.log("To deploy, run:");
    console.log("  npx tsx scripts/compute-genesis-and-deploy.ts --deploy");
    return;
  }

  console.log("\n=== Deploying to Gnosis Mainnet ===\n");

  // Deploy AdminProofVerifier
  // Constructor: (address _admin, address _owner)
  console.log("Deploying AdminProofVerifier...");
  const verifierArtifact = getContractArtifact("AdminProofVerifier.sol", "AdminProofVerifier");
  const verifierFactory = new ContractFactory(
    verifierArtifact.abi,
    verifierArtifact.bytecode,
    adminWallet
  );
  const verifier = await verifierFactory.deploy(
    adminWallet.address, // admin (can sign proofs)
    adminWallet.address  // owner (can change admin)
  );
  await verifier.waitForDeployment();
  const verifierAddress = await verifier.getAddress();
  console.log(`  AdminProofVerifier deployed at: ${verifierAddress}`);

  if (verifierAddress.toLowerCase() !== expectedVerifierAddress.toLowerCase()) {
    console.error(`  ⚠️  Address mismatch! Expected ${expectedVerifierAddress}`);
    process.exit(1);
  }

  // Deploy NativeRollupCore
  // Constructor: (_genesisBlockHash, _proofVerifier, _owner)
  console.log("\nDeploying NativeRollupCore...");
  const rollupArtifact = getContractArtifact("NativeRollupCore.sol", "NativeRollupCore");
  const rollupFactory = new ContractFactory(
    rollupArtifact.abi,
    rollupArtifact.bytecode,
    adminWallet
  );

  const rollup = await rollupFactory.deploy(
    genesisStateRoot,
    verifierAddress,
    adminWallet.address
  );
  await rollup.waitForDeployment();
  const rollupAddress = await rollup.getAddress();
  console.log(`  NativeRollupCore deployed at: ${rollupAddress}`);

  if (rollupAddress.toLowerCase() !== expectedRollupAddress.toLowerCase()) {
    console.error(`  ⚠️  Address mismatch! Expected ${expectedRollupAddress}`);
    console.error(`  The L2 System Address will be wrong!`);
    process.exit(1);
  }

  // Verify L2 block hash
  const rollupContract = new ethers.Contract(rollupAddress, rollupArtifact.abi, l1Provider);
  const l2BlockHash = await rollupContract.l2BlockHash();
  console.log(`\n  L2 Block Hash on contract: ${l2BlockHash}`);
  console.log(`  Expected genesis:          ${genesisStateRoot}`);
  console.log(`  Match: ${l2BlockHash === genesisStateRoot ? "✓ YES" : "✗ NO"}`);

  console.log("\n=== Deployment Complete ===\n");
  console.log(`AdminProofVerifier: ${verifierAddress}`);
  console.log(`NativeRollupCore:   ${rollupAddress}`);
  console.log(`L2 System Address:  ${l2SystemAddress}`);
  console.log(`Genesis State Root: ${genesisStateRoot}`);

  console.log("\n=== Update builder/fullnode with: ===\n");
  console.log(`export const L2_SYSTEM_ADDRESS = "${l2SystemAddress}";`);
  console.log(`export const ROLLUP_ADDRESS = "${rollupAddress}";`);

  console.log("\n=== Verify on Blockscout ===\n");
  console.log(`forge verify-contract ${verifierAddress} \\`);
  console.log(`  src/verifiers/AdminProofVerifier.sol:AdminProofVerifier \\`);
  console.log(`  --verifier blockscout --verifier-url https://gnosis.blockscout.com/api/ --chain-id 100 \\`);
  console.log(`  --constructor-args $(cast abi-encode "constructor(address,address)" \\`);
  console.log(`    ${adminWallet.address} ${adminWallet.address})`);
  console.log("");
  console.log("");
  console.log(`forge verify-contract ${rollupAddress} \\`);
  console.log(`  src/NativeRollupCore.sol:NativeRollupCore \\`);
  console.log(`  --verifier blockscout --verifier-url https://gnosis.blockscout.com/api/ --chain-id 100 \\`);
  console.log(`  --constructor-args $(cast abi-encode "constructor(bytes32,address,address)" \\`);
  console.log(`    ${genesisStateRoot} ${verifierAddress} ${adminWallet.address})`);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
