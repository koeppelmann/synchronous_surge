/**
 * Deploy NativeRollupCore + AdminProofVerifier to Gnosis Mainnet
 *
 * Based on compute-genesis-and-deploy.ts but writes gnosis-deployment.json
 * for use by startGnosis.sh.
 *
 * Usage:
 *   ADMIN_PK=0x... npx tsx scripts/deploy-gnosis.ts           # dry run
 *   ADMIN_PK=0x... npx tsx scripts/deploy-gnosis.ts --deploy   # actually deploy
 *
 * Environment:
 *   ADMIN_PK   - Required. Private key for deployer/admin/owner.
 *   L1_RPC     - Optional. Default: https://rpc.gnosischain.com
 */

import {
  ethers,
  JsonRpcProvider,
  Wallet,
  ContractFactory,
} from "ethers";
import { spawn, ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";

// Configuration
const L1_RPC = process.env.L1_RPC || "https://rpc.gnosischain.com";
const ADMIN_PK = process.env.ADMIN_PK;
const L2_CHAIN_ID = 10200200;
const L2_SYSTEM_BALANCE = ethers.parseEther("10000000000"); // 10 billion xDAI

// Must match fullnode/l2-fullnode.ts DEFAULT_CONFIG.systemPrivateKey
const SYSTEM_PRIVATE_KEY = "0x0000000000000000000000000000000000000000000000000000000000000001";

const DEPLOYMENT_FILE = "gnosis-deployment.json";

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
  // Must match fullnode/l2-fullnode.ts initializeL2() Anvil flags
  const anvilProcess = spawn("anvil", [
    "--port", port.toString(),
    "--chain-id", L2_CHAIN_ID.toString(),
    "--accounts", "0",
    "--gas-price", "0",
    "--base-fee", "0",
    "--no-mining",
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

/**
 * Compute genesis state root by replicating exactly what the fullnode does:
 * 1. Spawn Anvil (same flags as fullnode)
 * 2. anvil_setBalance on system address
 * 3. Deploy L2CallRegistry + L1SenderProxyL2Factory from system wallet
 * 4. evm_mine → block 1 state root = genesis
 */
async function computeGenesisStateRoot(): Promise<string> {
  const systemWallet = new Wallet(SYSTEM_PRIVATE_KEY);
  const systemAddress = systemWallet.address;

  console.log("\n=== Computing Genesis State Root ===\n");
  console.log(`System Address: ${systemAddress}`);
  console.log(`System Balance: ${ethers.formatEther(L2_SYSTEM_BALANCE)} xDAI`);

  const { process: anvilProcess, provider } = await spawnAnvil(9553);

  try {
    // Step 1: Fund system address (matches fullnode initializeL2)
    await provider.send("anvil_setBalance", [
      systemAddress,
      "0x" + L2_SYSTEM_BALANCE.toString(16),
    ]);

    const balance = await provider.getBalance(systemAddress);
    console.log(`System balance set: ${ethers.formatEther(balance)} xDAI`);

    // Step 2: Deploy system contracts (matches fullnode deploySystemContracts)
    const connectedWallet = new Wallet(SYSTEM_PRIVATE_KEY, provider);

    const registryArtifact = getContractArtifact("L1SenderProxyL2.sol", "L2CallRegistry");
    const registryFactory = new ContractFactory(
      registryArtifact.abi,
      registryArtifact.bytecode,
      connectedWallet
    );
    const registryAddress = ethers.getCreateAddress({ from: systemAddress, nonce: 0 });
    await registryFactory.deploy(systemAddress, { nonce: 0 });

    const factoryArtifact = getContractArtifact("L1SenderProxyL2.sol", "L1SenderProxyL2Factory");
    const factoryFactory = new ContractFactory(
      factoryArtifact.abi,
      factoryArtifact.bytecode,
      connectedWallet
    );
    const factoryAddress = ethers.getCreateAddress({ from: systemAddress, nonce: 1 });
    await factoryFactory.deploy(systemAddress, registryAddress, { nonce: 1 });

    // Step 3: Mine block 1 (same as fullnode — single block with both deploys)
    await provider.send("evm_mine", []);

    console.log(`L2CallRegistry:         ${registryAddress}`);
    console.log(`L1SenderProxyL2Factory: ${factoryAddress}`);

    // Get state root from raw RPC (ethers provider may cache stale block number)
    const rawBlock = await provider.send("eth_getBlockByNumber", ["latest", false]);
    const stateRoot = rawBlock.stateRoot as string;
    console.log(`Block ${parseInt(rawBlock.number, 16)} stateRoot: ${stateRoot}`);

    if (!stateRoot || stateRoot === "0x0000000000000000000000000000000000000000000000000000000000000000") {
      throw new Error("Failed to get valid state root");
    }

    console.log(`Genesis State Root: ${stateRoot}`);
    return stateRoot;
  } finally {
    anvilProcess.kill();
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = !args.includes("--deploy");

  if (!ADMIN_PK) {
    console.error("Error: ADMIN_PK environment variable is required");
    console.error("Usage: ADMIN_PK=0x... npx tsx scripts/deploy-gnosis.ts [--deploy]");
    process.exit(1);
  }

  console.log("=== NativeRollupCore Gnosis Deployment ===\n");

  const l1Provider = new JsonRpcProvider(L1_RPC);
  const adminWallet = new Wallet(ADMIN_PK, l1Provider);

  console.log(`L1 RPC: ${L1_RPC}`);
  console.log(`Admin: ${adminWallet.address}`);

  // Check balance
  const balance = await l1Provider.getBalance(adminWallet.address);
  console.log(`Balance: ${ethers.formatEther(balance)} xDAI`);
  if (balance === 0n) {
    console.error("\nError: Admin account has no balance. Fund it with xDAI first.");
    process.exit(1);
  }

  const nonce = await l1Provider.getTransactionCount(adminWallet.address);
  console.log(`Current nonce: ${nonce}`);

  // Compute expected addresses
  const expectedVerifierAddress = ethers.getCreateAddress({ from: adminWallet.address, nonce });
  const expectedRollupAddress = ethers.getCreateAddress({ from: adminWallet.address, nonce: nonce + 1 });

  console.log(`\nExpected deployment addresses:`);
  console.log(`  Nonce ${nonce}: AdminProofVerifier → ${expectedVerifierAddress}`);
  console.log(`  Nonce ${nonce + 1}: NativeRollupCore → ${expectedRollupAddress}`);

  // L2 system address (from SYSTEM_PRIVATE_KEY, must match fullnode)
  const l2SystemAddress = new Wallet(SYSTEM_PRIVATE_KEY).address;
  console.log(`L2 System Address: ${l2SystemAddress}`);

  // Compute genesis state root (replicates fullnode genesis exactly)
  const genesisStateRoot = await computeGenesisStateRoot();

  console.log("\n=== Summary ===\n");
  console.log(`AdminProofVerifier (expected): ${expectedVerifierAddress}`);
  console.log(`NativeRollupCore (expected):   ${expectedRollupAddress}`);
  console.log(`L2 System Address:             ${l2SystemAddress}`);
  console.log(`Genesis State Root:            ${genesisStateRoot}`);
  console.log(`L2 Chain ID:                   ${L2_CHAIN_ID}`);

  if (dryRun) {
    console.log("\n⚠️  DRY RUN - Not deploying. Add --deploy to actually deploy.\n");
    return;
  }

  console.log("\n=== Deploying to Gnosis Mainnet ===\n");

  // Get current fee data for gas pricing
  const feeData = await l1Provider.getFeeData();
  console.log(`Gas price: ${ethers.formatUnits(feeData.gasPrice || 0n, "gwei")} gwei`);

  // Deploy AdminProofVerifier
  console.log("Deploying AdminProofVerifier...");
  const verifierArtifact = getContractArtifact("AdminProofVerifier.sol", "AdminProofVerifier");
  const verifierFactory = new ContractFactory(
    verifierArtifact.abi,
    verifierArtifact.bytecode,
    adminWallet
  );
  const verifier = await verifierFactory.deploy(
    adminWallet.address,
    adminWallet.address
  );
  await verifier.waitForDeployment();
  const verifierAddress = await verifier.getAddress();
  console.log(`  AdminProofVerifier deployed at: ${verifierAddress}`);

  if (verifierAddress.toLowerCase() !== expectedVerifierAddress.toLowerCase()) {
    console.error(`  ⚠️  Address mismatch! Expected ${expectedVerifierAddress}`);
    process.exit(1);
  }

  // Deploy NativeRollupCore
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
    process.exit(1);
  }

  // Get deployment block number
  const deployTx = rollup.deploymentTransaction();
  const deployReceipt = await deployTx?.wait();
  const deploymentBlock = deployReceipt?.blockNumber || (await l1Provider.getBlockNumber());

  // Write deployment file
  const deployment = {
    rollupAddress,
    verifierAddress,
    l2SystemAddress,
    genesisStateRoot,
    deploymentBlock,
    adminAddress: adminWallet.address,
    l1Rpc: L1_RPC,
    l2ChainId: L2_CHAIN_ID,
    deployedAt: new Date().toISOString(),
  };

  fs.writeFileSync(DEPLOYMENT_FILE, JSON.stringify(deployment, null, 2));
  console.log(`\n  Wrote ${DEPLOYMENT_FILE}`);

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
  console.log(`Deployment Block:   ${deploymentBlock}`);

  console.log("\n=== Start services with: ===\n");
  console.log(`ADMIN_PRIVATE_KEY=${ADMIN_PK} ./startGnosis.sh`);

  console.log("\n=== Verify on Blockscout ===\n");
  console.log(`forge verify-contract ${verifierAddress} \\`);
  console.log(`  src/verifiers/AdminProofVerifier.sol:AdminProofVerifier \\`);
  console.log(`  --verifier blockscout --verifier-url https://gnosis.blockscout.com/api/ --chain-id 100 \\`);
  console.log(`  --constructor-args $(cast abi-encode "constructor(address,address)" \\`);
  console.log(`    ${adminWallet.address} ${adminWallet.address})`);
  console.log("");
  console.log(`forge verify-contract ${rollupAddress} \\`);
  console.log(`  src/NativeRollupCore.sol:NativeRollupCore \\`);
  console.log(`  --verifier blockscout --verifier-url https://gnosis.blockscout.com/api/ --chain-id 100 \\`);
  console.log(`  --constructor-args $(cast abi-encode "constructor(bytes32,address,address)" \\`);
  console.log(`    ${genesisStateRoot} ${verifierAddress} ${adminWallet.address})`);
}

main().then(() => {
  process.exit(0);
}).catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
