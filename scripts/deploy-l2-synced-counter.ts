/**
 * Deploy L2SyncedCounter through the builder mechanism
 *
 * This ensures the deployment goes through L1 and can be replayed by the fullnode.
 */

import {
  ethers,
  JsonRpcProvider,
  Wallet,
  Contract,
  ContractFactory,
  AbiCoder,
  keccak256,
} from "ethers";
import * as fs from "fs";
import * as path from "path";

// Configuration
const L1_RPC = process.env.L1_RPC || "https://rpc.gnosischain.com";
const L2_RPC = process.env.L2_RPC || "http://localhost:9546";
const ROLLUP_ADDRESS = process.env.ROLLUP_ADDRESS || "0xBdec2590117ED5D3ec3dca8EcC1E5d2CbEaedfAf";
const ADMIN_PK = process.env.ADMIN_PK || "0xf2024347d89be67338b62344010fb2ebc5db60cad2ff591a92a30b8215f87f22";
const L2_SYSTEM_ADDRESS = "0x7d1cc88909370e00d3ca1fd72d9b45b8f1412215";

// L1SyncedCounter already deployed on Gnosis
const L1_SYNCED_COUNTER = "0xDc649168aDf79Ac4fA78BebE44b9d353F457e32f";

// ABIs
const ROLLUP_ABI = [
  "function l2BlockHash() view returns (bytes32)",
  "function l2BlockNumber() view returns (uint256)",
  "function getProxyAddress(address l2Address) view returns (address)",
  "function isProxyDeployed(address l2Address) view returns (bool)",
  "function deployProxy(address l2Address) returns (address)",
  "function registerIncomingCall(address l2Address, bytes32 stateHash, bytes calldata callData, tuple(bytes32 preOutgoingCallsStateHash, tuple(address from, address target, uint256 value, uint256 gas, bytes data, bytes32 postCallStateHash)[] outgoingCalls, bytes[] expectedResults, bytes returnValue, bytes32 finalStateHash) response, bytes proof)",
  "event IncomingCallRegistered(address indexed l2Address, bytes32 indexed stateHash, bytes32 indexed callDataHash, bytes32 responseKey)",
];

const L2_PROXY_FACTORY_ABI = [
  "function deployProxy(address l1Address) returns (address)",
  "function computeProxyAddress(address l1Address) view returns (address)",
  "function isProxyDeployed(address l1Address) view returns (bool)",
  "function getProxy(address l1Address) view returns (address)",
];

function getContractArtifact(contractPath: string, contractName: string): { abi: any; bytecode: string } {
  const artifactPath = path.join(process.cwd(), `out/${contractPath}/${contractName}.json`);
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  return {
    abi: artifact.abi,
    bytecode: artifact.bytecode.object,
  };
}

function computeL2ProxyAddress(l1Address: string): string {
  const hash = keccak256(
    AbiCoder.defaultAbiCoder().encode(
      ["string", "address"],
      ["NativeRollup.L1SenderProxy.v1", l1Address]
    )
  );
  return "0x" + hash.slice(-40);
}

async function main() {
  console.log("=== Deploy L2SyncedCounter via L1 ===\n");

  // Setup providers and wallets
  const l1Provider = new JsonRpcProvider(L1_RPC);
  const l2Provider = new JsonRpcProvider(L2_RPC);
  const adminWallet = new Wallet(ADMIN_PK, l1Provider);

  console.log(`L1 RPC: ${L1_RPC}`);
  console.log(`L2 RPC: ${L2_RPC}`);
  console.log(`Admin: ${adminWallet.address}`);
  console.log(`NativeRollupCore: ${ROLLUP_ADDRESS}`);
  console.log(`L1SyncedCounter: ${L1_SYNCED_COUNTER}`);
  console.log("");

  // Get rollup contract
  const rollupCore = new Contract(ROLLUP_ADDRESS, ROLLUP_ABI, adminWallet);

  // Get current L2 state from L1
  const currentL2Hash = await rollupCore.l2BlockHash();
  console.log(`Current L2 hash on L1: ${currentL2Hash}`);

  // Get the L1SenderProxyL2Factory on L2
  // We need to find it first - it should be deployed at a predictable address
  const l2ProxyFactoryAddress = "0x1eFE3e3b5FAc218cb3c838Dc35fF145bc1AFAA21"; // From fullnode output
  const l2ProxyFactory = new Contract(l2ProxyFactoryAddress, L2_PROXY_FACTORY_ABI, l2Provider);

  // Ensure the deployer (admin) has a proxy on L2
  const isDeployerProxyDeployed = await l2ProxyFactory.isProxyDeployed(adminWallet.address);
  let deployerL2Proxy: string;

  if (!isDeployerProxyDeployed) {
    console.log(`Deploying L2 proxy for deployer ${adminWallet.address}...`);

    // We need to deploy through system address
    await l2Provider.send("anvil_impersonateAccount", [L2_SYSTEM_ADDRESS]);
    const systemSigner = await l2Provider.getSigner(L2_SYSTEM_ADDRESS);

    const factoryWithSigner = l2ProxyFactory.connect(systemSigner) as Contract;
    const deployProxyTx = await factoryWithSigner.deployProxy(adminWallet.address);
    await deployProxyTx.wait();

    await l2Provider.send("anvil_stopImpersonatingAccount", [L2_SYSTEM_ADDRESS]);

    deployerL2Proxy = await l2ProxyFactory.getProxy(adminWallet.address);
    console.log(`  Deployer L2 proxy deployed at: ${deployerL2Proxy}`);
  } else {
    deployerL2Proxy = await l2ProxyFactory.getProxy(adminWallet.address);
    console.log(`Deployer L2 proxy already exists: ${deployerL2Proxy}`);
  }

  // Get L2SyncedCounter bytecode
  const l2CounterArtifact = getContractArtifact("SyncedCounter.sol", "L2SyncedCounter");
  const deployBytecode = l2CounterArtifact.bytecode;
  console.log(`\nL2SyncedCounter bytecode length: ${(deployBytecode.length - 2) / 2} bytes`);

  // Predict contract address (nonce-based)
  const deployerNonce = await l2Provider.getTransactionCount(deployerL2Proxy);
  const predictedAddress = ethers.getCreateAddress({
    from: deployerL2Proxy,
    nonce: deployerNonce,
  });
  console.log(`Predicted L2SyncedCounter address: ${predictedAddress}`);
  console.log(`  Deployer proxy nonce: ${deployerNonce}`);

  // Step 1: Simulate deployment on L2 (from deployer's L2 proxy)
  console.log(`\nSimulating deployment on L2...`);

  // Fund the proxy for gas (this is fine for simulation - the actual L2 state comes from system address forwarding)
  await l2Provider.send("anvil_setBalance", [
    deployerL2Proxy,
    "0x" + ethers.parseEther("1").toString(16),
  ]);

  await l2Provider.send("anvil_impersonateAccount", [deployerL2Proxy]);
  const proxySigner = await l2Provider.getSigner(deployerL2Proxy);

  const l2DeployTx = await proxySigner.sendTransaction({
    data: deployBytecode,
    gasLimit: 3000000,
  });
  const l2Receipt = await l2DeployTx.wait();
  console.log(`  L2 tx hash: ${l2Receipt?.hash}`);

  await l2Provider.send("anvil_stopImpersonatingAccount", [deployerL2Proxy]);

  // Verify deployment
  const deployedCode = await l2Provider.getCode(predictedAddress);
  if (deployedCode === "0x") {
    throw new Error("Contract deployment failed on L2");
  }
  console.log(`  Contract deployed at: ${predictedAddress}`);
  console.log(`  Code length: ${(deployedCode.length - 2) / 2} bytes`);

  // Get new state root
  const l2Block = await l2Provider.getBlock("latest");
  const newStateRoot = l2Block?.stateRoot;
  if (!newStateRoot) {
    throw new Error("Failed to get L2 state root");
  }
  console.log(`  New L2 state root: ${newStateRoot}`);

  // Step 2: Register on L1
  console.log(`\nRegistering deployment on L1...`);

  // Deploy L1 proxy for the new L2 contract if needed
  const isL1ProxyDeployed = await rollupCore.isProxyDeployed(predictedAddress);
  let l1ProxyAddress = await rollupCore.getProxyAddress(predictedAddress);

  if (!isL1ProxyDeployed) {
    console.log(`  Deploying L1 proxy for L2 contract ${predictedAddress}...`);
    const deployProxyTx = await rollupCore.deployProxy(predictedAddress);
    await deployProxyTx.wait();
    console.log(`  L1 proxy deployed at: ${l1ProxyAddress}`);
  }

  // Build response structure
  const response = {
    preOutgoingCallsStateHash: newStateRoot,
    outgoingCalls: [],
    expectedResults: [],
    returnValue: AbiCoder.defaultAbiCoder().encode(["address"], [predictedAddress]),
    finalStateHash: newStateRoot,
  };

  // Sign the proof
  const messageHash = keccak256(
    AbiCoder.defaultAbiCoder().encode(
      ["address", "bytes32", "bytes32", "bytes32", "bytes32", "bytes32", "bytes32", "bytes32"],
      [
        predictedAddress,
        currentL2Hash,
        keccak256(deployBytecode),
        newStateRoot,
        keccak256("0x"), // empty outgoing calls
        keccak256("0x"), // empty results
        keccak256(response.returnValue),
        newStateRoot,
      ]
    )
  );
  const proof = await adminWallet.signMessage(ethers.getBytes(messageHash));

  // Register incoming call
  const registerTx = await rollupCore.registerIncomingCall(
    predictedAddress,
    currentL2Hash,
    deployBytecode,
    response,
    proof
  );
  const registerReceipt = await registerTx.wait();
  console.log(`  Register tx: ${registerReceipt?.hash}`);
  console.log(`  Block: ${registerReceipt?.blockNumber}`);

  // Execute on L1
  console.log(`\nExecuting deployment trigger on L1...`);
  const triggerTx = await adminWallet.sendTransaction({
    to: l1ProxyAddress,
    data: deployBytecode,
  });
  const triggerReceipt = await triggerTx.wait();
  console.log(`  Trigger tx: ${triggerReceipt?.hash}`);

  // Verify final state
  const finalL2Hash = await rollupCore.l2BlockHash();
  console.log(`\nFinal L2 hash on L1: ${finalL2Hash}`);
  console.log(`Expected (local):    ${newStateRoot}`);

  if (finalL2Hash.toLowerCase() === newStateRoot.toLowerCase()) {
    console.log(`✓ State roots match!`);
  } else {
    console.log(`✗ State roots don't match!`);
    console.log(`  This is expected if infrastructure deployment state differs.`);
  }

  // Now set up the L1Contract reference
  console.log(`\n=== Setting up L2SyncedCounter.setL1Contract ===`);

  const l2Counter = new Contract(
    predictedAddress,
    ["function setL1Contract(address)", "function l1Contract() view returns (address)"],
    l2Provider
  );

  // Get current L2 state for next call
  const currentL2Hash2 = await rollupCore.l2BlockHash();

  // Encode setL1Contract call
  const setL1ContractData = l2Counter.interface.encodeFunctionData("setL1Contract", [L1_SYNCED_COUNTER]);

  // Simulate on L2
  console.log(`Simulating setL1Contract on L2...`);
  await l2Provider.send("anvil_impersonateAccount", [deployerL2Proxy]);
  const proxySigner2 = await l2Provider.getSigner(deployerL2Proxy);

  const setL1Tx = await proxySigner2.sendTransaction({
    to: predictedAddress,
    data: setL1ContractData,
  });
  await setL1Tx.wait();
  await l2Provider.send("anvil_stopImpersonatingAccount", [deployerL2Proxy]);

  // Verify
  const l1ContractSet = await l2Counter.l1Contract();
  console.log(`  L1Contract set to: ${l1ContractSet}`);

  // Get new state root
  const l2Block2 = await l2Provider.getBlock("latest");
  const newStateRoot2 = l2Block2?.stateRoot;
  console.log(`  New L2 state root: ${newStateRoot2}`);

  // Register on L1
  const response2 = {
    preOutgoingCallsStateHash: newStateRoot2,
    outgoingCalls: [],
    expectedResults: [],
    returnValue: "0x",
    finalStateHash: newStateRoot2,
  };

  const messageHash2 = keccak256(
    AbiCoder.defaultAbiCoder().encode(
      ["address", "bytes32", "bytes32", "bytes32", "bytes32", "bytes32", "bytes32", "bytes32"],
      [
        predictedAddress,
        currentL2Hash2,
        keccak256(setL1ContractData),
        newStateRoot2,
        keccak256("0x"),
        keccak256("0x"),
        keccak256("0x"),
        newStateRoot2,
      ]
    )
  );
  const proof2 = await adminWallet.signMessage(ethers.getBytes(messageHash2));

  const registerTx2 = await rollupCore.registerIncomingCall(
    predictedAddress,
    currentL2Hash2,
    setL1ContractData,
    response2,
    proof2
  );
  const registerReceipt2 = await registerTx2.wait();
  console.log(`  Register tx: ${registerReceipt2?.hash}`);

  // Execute on L1
  const triggerTx2 = await adminWallet.sendTransaction({
    to: l1ProxyAddress,
    data: setL1ContractData,
  });
  const triggerReceipt2 = await triggerTx2.wait();
  console.log(`  Trigger tx: ${triggerReceipt2?.hash}`);

  // Final verification
  const finalL2Hash2 = await rollupCore.l2BlockHash();
  console.log(`\nFinal L2 hash on L1: ${finalL2Hash2}`);

  console.log(`\n=== Deployment Summary ===`);
  console.log(`L2SyncedCounter deployed at: ${predictedAddress}`);
  console.log(`L2SyncedCounter.l1Contract:  ${L1_SYNCED_COUNTER}`);
  console.log(`L1 Proxy for L2 Counter:     ${l1ProxyAddress}`);

  // Now set up L1SyncedCounter to point to the L2 proxy
  console.log(`\n=== Setting up L1SyncedCounter.setL2Proxy ===`);

  const l1Counter = new Contract(
    L1_SYNCED_COUNTER,
    ["function setL2Proxy(address)", "function l2Proxy() view returns (address)", "function value() view returns (uint256)"],
    adminWallet
  );

  const currentL2Proxy = await l1Counter.l2Proxy();
  console.log(`Current L1SyncedCounter.l2Proxy: ${currentL2Proxy}`);
  console.log(`Setting to: ${l1ProxyAddress}`);

  const setL2ProxyTx = await l1Counter.setL2Proxy(l1ProxyAddress);
  await setL2ProxyTx.wait();
  console.log(`  Tx: ${setL2ProxyTx.hash}`);

  const newL2Proxy = await l1Counter.l2Proxy();
  console.log(`  L2Proxy now set to: ${newL2Proxy}`);

  console.log(`\n=== Setup Complete ===`);
  console.log(`L1SyncedCounter: ${L1_SYNCED_COUNTER}`);
  console.log(`  l2Proxy:       ${newL2Proxy}`);
  console.log(`L2SyncedCounter: ${predictedAddress}`);
  console.log(`  l1Contract:    ${L1_SYNCED_COUNTER}`);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
