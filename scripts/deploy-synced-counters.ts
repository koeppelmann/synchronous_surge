/**
 * Deploy SyncedCounter contracts on L1 and L2
 *
 * L1SyncedCounter: Deployed directly to L1 (Gnosis)
 * L2SyncedCounter: Deployed via builder to L2
 *
 * Then links them together.
 */

import { ethers, JsonRpcProvider, Wallet, ContractFactory, Contract } from "ethers";
import { Builder, computeL2ProxyAddress } from "../builder/index.js";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

// Configuration
const L1_RPC = process.env.L1_RPC || "https://rpc.gnosischain.com";
const ROLLUP_ADDRESS = process.env.ROLLUP_ADDRESS || "0x5E87A156F55c85e765C81af1312C76f8a9a1bc7d";
const ADMIN_PK = process.env.ADMIN_PK || "0xf2024347d89be67338b62344010fb2ebc5db60cad2ff591a92a30b8215f87f22";

// Compile contracts first
function getContractArtifact(contractName: string): { abi: any; bytecode: string } {
  // Both L1SyncedCounter and L2SyncedCounter are in SyncedCounter.sol
  const artifactPath = path.join(
    process.cwd(),
    `out/SyncedCounter.sol/${contractName}.json`
  );

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

async function main() {
  console.log("=== Deploying SyncedCounter Contracts ===\n");

  // Setup L1 provider and wallet
  const l1Provider = new JsonRpcProvider(L1_RPC);
  const adminWallet = new Wallet(ADMIN_PK, l1Provider);
  console.log(`Deployer: ${adminWallet.address}`);

  // Get contract artifacts
  const l1CounterArtifact = getContractArtifact("L1SyncedCounter");
  const l2CounterArtifact = getContractArtifact("L2SyncedCounter");

  // Step 1: Deploy L1SyncedCounter on L1
  console.log("\n--- Step 1: Deploy L1SyncedCounter on L1 ---");

  const l1Factory = new ContractFactory(
    l1CounterArtifact.abi,
    l1CounterArtifact.bytecode,
    adminWallet
  );

  const l1Counter = await l1Factory.deploy();
  await l1Counter.waitForDeployment();
  const l1CounterAddress = await l1Counter.getAddress();
  console.log(`L1SyncedCounter deployed at: ${l1CounterAddress}`);

  // Step 2: Deploy L2SyncedCounter on L2 via builder
  console.log("\n--- Step 2: Deploy L2SyncedCounter on L2 via Builder ---");

  const builder = new Builder();
  await builder.start();

  const deployResult = await builder.processDeployment({
    deployer: adminWallet.address,
    bytecode: l2CounterArtifact.bytecode,
  });

  if (!deployResult.success) {
    console.error(`L2 deployment failed: ${deployResult.error}`);
    builder.stop();
    process.exit(1);
  }

  const l2CounterAddress = deployResult.contractAddress!;
  console.log(`L2SyncedCounter deployed at: ${l2CounterAddress}`);

  // Step 3: Compute L2's proxy on L1
  console.log("\n--- Step 3: Get/Deploy L2's proxy on L1 ---");

  const rollupAbi = [
    "function getProxyAddress(address l2Address) view returns (address)",
    "function isProxyDeployed(address l2Address) view returns (bool)",
    "function deployProxy(address l2Address) returns (address)",
  ];
  const rollupCore = new Contract(ROLLUP_ADDRESS, rollupAbi, adminWallet);

  // Deploy proxy for L2SyncedCounter on L1
  const isL2ProxyDeployed = await rollupCore.isProxyDeployed(l2CounterAddress);
  let l2ProxyOnL1 = await rollupCore.getProxyAddress(l2CounterAddress);

  if (!isL2ProxyDeployed) {
    console.log(`Deploying L2 proxy on L1...`);
    const deployProxyTx = await rollupCore.deployProxy(l2CounterAddress);
    await deployProxyTx.wait();
  }
  console.log(`L2SyncedCounter's proxy on L1: ${l2ProxyOnL1}`);

  // Step 4: Compute L1's proxy on L2 (just a computation, not deployed)
  const l1ProxyOnL2 = computeL2ProxyAddress(l1CounterAddress);
  console.log(`L1SyncedCounter's proxy on L2: ${l1ProxyOnL2}`);

  // Step 5: Link L1SyncedCounter to L2's proxy
  console.log("\n--- Step 4: Link L1SyncedCounter to L2 proxy ---");

  const l1CounterContract = new Contract(l1CounterAddress, l1CounterArtifact.abi, adminWallet);
  const setL2ProxyTx = await l1CounterContract.setL2Proxy(l2ProxyOnL1);
  await setL2ProxyTx.wait();
  console.log(`L1SyncedCounter.setL2Proxy(${l2ProxyOnL1}) done`);

  // Step 6: Link L2SyncedCounter to L1 contract via builder
  console.log("\n--- Step 5: Link L2SyncedCounter to L1 contract via Builder ---");

  // Encode setL1Contract call
  const l2CounterInterface = new ethers.Interface(l2CounterArtifact.abi);
  const setL1ContractData = l2CounterInterface.encodeFunctionData("setL1Contract", [l1ProxyOnL2]);

  // This is a call to L2, not a deposit - we need to simulate and register
  // For now, we'll need to do this differently...
  // Actually, we can use the deposit mechanism with calldata!

  const linkResult = await builder.processDeposit({
    l2Recipient: l2CounterAddress,
    value: 0n,
    callData: setL1ContractData,
  });

  if (!linkResult.success) {
    console.error(`L2 linking failed: ${linkResult.error}`);
    builder.stop();
    process.exit(1);
  }
  console.log(`L2SyncedCounter.setL1Contract(${l1ProxyOnL2}) done`);

  builder.stop();

  // Summary
  console.log("\n=== Deployment Complete ===");
  console.log(`L1SyncedCounter: ${l1CounterAddress}`);
  console.log(`L2SyncedCounter: ${l2CounterAddress}`);
  console.log(`L2's proxy on L1: ${l2ProxyOnL1}`);
  console.log(`L1's proxy on L2: ${l1ProxyOnL2}`);
  console.log(`\nL2 State Root: ${deployResult.l2StateRoot}`);
}

main().catch((err) => {
  console.error("Deployment error:", err);
  process.exit(1);
});
