/**
 * Test script for L1→L2 deposit with proper role separation
 *
 * Demonstrates the separation between:
 * - USER: Signs L1 tx to proxy address, submits with hints
 * - BUILDER: Processes tx, simulates L2, registers response, broadcasts
 *
 * Run after starting the testnet:
 *   npx tsx scripts/start-local-testnet.ts --daemon --no-explorer
 *
 * Then run this test:
 *   npx tsx scripts/test-deposit.ts [rollup-address]
 */

import {
  ethers,
  JsonRpcProvider,
  Wallet,
  Contract,
  AbiCoder,
  keccak256,
  Transaction,
} from "ethers";

// ============ Configuration ============

const CONFIG = {
  l1Port: 8545,
  l2FullnodePort: 9546,
  l2BuilderPort: 9547,
  l1ChainId: 31337,
  l2ChainId: 10200200,
};

const ACCOUNTS = {
  admin: {
    address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    privateKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  },
  user1: {
    address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    privateKey: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  },
  user2: {
    address: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
    privateKey: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  },
};

const ROLLUP_ABI = [
  "function l2BlockHash() view returns (bytes32)",
  "function l2BlockNumber() view returns (uint256)",
  "function getProxyAddress(address l2Address) view returns (address)",
  "function isProxyDeployed(address l2Address) view returns (bool)",
  "function deployProxy(address l2Address) returns (address)",
  "function registerIncomingCall(address l2Address, bytes32 stateHash, bytes calldata callData, tuple(bytes32 preOutgoingCallsStateHash, tuple(address from, address target, uint256 value, uint256 gas, bytes data, bytes32 postCallStateHash)[] outgoingCalls, bytes[] expectedResults, bytes returnValue, bytes32 finalStateHash) response, bytes proof)",
];

// Get rollup address from command line or use default
const ROLLUP_ADDRESS = process.argv[2] || "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512";

// ============ Utilities ============

function log(component: string, message: string) {
  const timestamp = new Date().toISOString().split("T")[1].split(".")[0];
  console.log(`[${timestamp}] [${component}] ${message}`);
}

// ============ Hints Interface ============

/**
 * Hints for L1→L2 transaction submission
 * These help the builder understand what the transaction is doing
 */
interface L1ToL2TransactionHints {
  /** The L2 address that the proxy represents (REQUIRED) */
  l2TargetAddress: string;

  /** Optional: Expected return value */
  expectedReturnValue?: string;

  /** Optional: Description for logging */
  description?: string;
}

// ============ USER Functions ============

/**
 * USER: Get the L1 proxy address for an L2 address
 */
async function userGetProxyAddress(
  l1Provider: JsonRpcProvider,
  rollupAddress: string,
  l2Address: string
): Promise<string> {
  const rollup = new Contract(rollupAddress, ROLLUP_ABI, l1Provider);
  return await rollup.getProxyAddress(l2Address);
}

/**
 * USER: Create and sign an L1 transaction to an L2 address's proxy
 */
async function userCreateL1ToL2Transaction(
  l1Provider: JsonRpcProvider,
  rollupAddress: string,
  senderPrivateKey: string,
  l2Target: string,
  value: bigint,
  callData: string = "0x"
): Promise<{
  signedTx: string;
  hints: L1ToL2TransactionHints;
}> {
  const sender = new Wallet(senderPrivateKey, l1Provider);

  // Get the proxy address
  const proxyAddress = await userGetProxyAddress(l1Provider, rollupAddress, l2Target);
  log("User", `L2 address ${l2Target}`);
  log("User", `  -> L1 proxy ${proxyAddress}`);

  // Create transaction
  const nonce = await l1Provider.getTransactionCount(sender.address);
  const feeData = await l1Provider.getFeeData();

  const txRequest = {
    type: 2,
    chainId: CONFIG.l1ChainId,
    nonce,
    to: proxyAddress,
    value,
    data: callData,
    maxFeePerGas: feeData.maxFeePerGas || ethers.parseUnits("10", "gwei"),
    maxPriorityFeePerGas: feeData.maxPriorityFeePerGas || ethers.parseUnits("1", "gwei"),
    gasLimit: 500000n,
  };

  // Sign
  const signedTx = await sender.signTransaction(txRequest);
  log("User", `Signed tx to proxy, value: ${ethers.formatEther(value)} ETH`);

  // Create hints
  const hints: L1ToL2TransactionHints = {
    l2TargetAddress: l2Target,
    description: value > 0n ? `Deposit ${ethers.formatEther(value)} ETH` : "L1->L2 call",
  };

  return { signedTx, hints };
}

// ============ BUILDER Functions ============

/**
 * BUILDER: Sign incoming call proof
 */
async function builderSignIncomingCallProof(
  adminWallet: Wallet,
  l2Address: string,
  stateHash: string,
  callData: string,
  response: {
    preOutgoingCallsStateHash: string;
    outgoingCalls: any[];
    expectedResults: string[];
    returnValue: string;
    finalStateHash: string;
  }
): Promise<string> {
  let outgoingCallsEncoded = "0x";
  for (const c of response.outgoingCalls) {
    outgoingCallsEncoded = ethers.solidityPacked(
      ["bytes", "address", "address", "uint256", "uint256", "bytes32", "bytes32"],
      [outgoingCallsEncoded, c.from, c.target, c.value, c.gas, keccak256(c.data), c.postCallStateHash]
    );
  }
  const outgoingCallsHash = keccak256(outgoingCallsEncoded);

  let resultsEncoded = "0x";
  for (const r of response.expectedResults) {
    resultsEncoded = ethers.solidityPacked(["bytes", "bytes32"], [resultsEncoded, keccak256(r)]);
  }
  const resultsHash = keccak256(resultsEncoded);

  const messageHash = keccak256(
    AbiCoder.defaultAbiCoder().encode(
      ["address", "bytes32", "bytes32", "bytes32", "bytes32", "bytes32", "bytes32", "bytes32"],
      [
        l2Address,
        stateHash,
        keccak256(callData),
        response.preOutgoingCallsStateHash,
        outgoingCallsHash,
        resultsHash,
        keccak256(response.returnValue),
        response.finalStateHash
      ]
    )
  );

  return await adminWallet.signMessage(ethers.getBytes(messageHash));
}

/**
 * BUILDER: Process an L1→L2 transaction submitted by a user
 */
async function builderProcessL1ToL2Transaction(
  l1Provider: JsonRpcProvider,
  l2BuilderProvider: JsonRpcProvider,
  l2FullnodeProvider: JsonRpcProvider,
  rollupAddress: string,
  adminPrivateKey: string,
  signedTx: string,
  hints: L1ToL2TransactionHints
): Promise<{
  l1TxHash: string;
  proxyAddress: string;
  l2StateRoot: string;
}> {
  const adminWallet = new Wallet(adminPrivateKey, l1Provider);
  const rollup = new Contract(rollupAddress, ROLLUP_ABI, adminWallet);

  // Parse transaction
  const tx = Transaction.from(signedTx);
  const l2Target = hints.l2TargetAddress;

  log("Builder", `Received L1→L2 tx`);
  log("Builder", `  From: ${tx.from}`);
  log("Builder", `  To (proxy): ${tx.to}`);
  log("Builder", `  L2 Target (hint): ${l2Target}`);
  log("Builder", `  Value: ${ethers.formatEther(tx.value)} ETH`);
  if (hints.description) {
    log("Builder", `  Description: ${hints.description}`);
  }

  // Validate hint
  const expectedProxy = await rollup.getProxyAddress(l2Target);
  if (tx.to?.toLowerCase() !== expectedProxy.toLowerCase()) {
    throw new Error(`Invalid hint: tx.to doesn't match expected proxy`);
  }
  log("Builder", `  ✓ Hint validated`);

  // Get current L2 state
  const currentL2Hash = await rollup.l2BlockHash();
  log("Builder", `  Current L2 hash: ${currentL2Hash}`);

  // Simulate L2 effect
  log("Builder", `Simulating L2 effect...`);
  if (tx.value > 0n) {
    const currentBalance = await l2BuilderProvider.getBalance(l2Target);
    const newBalance = currentBalance + tx.value;
    await l2BuilderProvider.send("anvil_setBalance", [
      l2Target,
      "0x" + newBalance.toString(16),
    ]);
    log("Builder", `  Credited ${ethers.formatEther(tx.value)} ETH to ${l2Target}`);
  }

  await l2BuilderProvider.send("evm_mine", []);
  const l2Block = await l2BuilderProvider.getBlock("latest");
  const newL2StateRoot = l2Block?.stateRoot!;
  log("Builder", `  New L2 state root: ${newL2StateRoot}`);

  // Prepare response
  const callData = tx.data || "0x";
  const response = {
    preOutgoingCallsStateHash: newL2StateRoot,
    outgoingCalls: [],
    expectedResults: [],
    returnValue: hints.expectedReturnValue || "0x",
    finalStateHash: newL2StateRoot,
  };

  // Sign proof
  const proof = await builderSignIncomingCallProof(adminWallet, l2Target, currentL2Hash, callData, response);

  // Register incoming call
  log("Builder", `Registering incoming call response...`);
  const registerTx = await rollup.registerIncomingCall(l2Target, currentL2Hash, callData, response, proof);
  await registerTx.wait();
  log("Builder", `  Registered: ${registerTx.hash}`);

  // Deploy proxy if needed
  const isDeployed = await rollup.isProxyDeployed(l2Target);
  if (!isDeployed) {
    log("Builder", `Deploying proxy...`);
    const deployTx = await rollup.deployProxy(l2Target);
    await deployTx.wait();
    log("Builder", `  Deployed: ${deployTx.hash}`);
  } else {
    log("Builder", `  Proxy already deployed`);
  }

  // Broadcast user's transaction
  log("Builder", `Broadcasting user's L1 tx...`);
  const l1TxHash = await l1Provider.send("eth_sendRawTransaction", [signedTx]);
  const receipt = await l1Provider.waitForTransaction(l1TxHash);
  log("Builder", `  L1 tx: ${receipt?.hash}`);
  log("Builder", `  Status: ${receipt?.status === 1 ? "SUCCESS" : "REVERTED"}`);

  if (receipt?.status !== 1) {
    throw new Error(`L1 tx reverted`);
  }

  // Sync fullnode
  log("Builder", `Syncing fullnode...`);
  if (tx.value > 0n) {
    const currentBalance = await l2FullnodeProvider.getBalance(l2Target);
    const newBalance = currentBalance + tx.value;
    await l2FullnodeProvider.send("anvil_setBalance", [
      l2Target,
      "0x" + newBalance.toString(16),
    ]);
  }
  await l2FullnodeProvider.send("evm_mine", []);

  // Verify
  const fullnodeBlock = await l2FullnodeProvider.getBlock("latest");
  const builderBlock = await l2BuilderProvider.getBlock("latest");
  if (builderBlock?.stateRoot === fullnodeBlock?.stateRoot) {
    log("Builder", `  ✓ State roots match`);
  } else {
    log("Builder", `  ✗ State mismatch!`);
  }

  return {
    l1TxHash: receipt?.hash || "",
    proxyAddress: expectedProxy,
    l2StateRoot: newL2StateRoot,
  };
}

// ============ Main Test ============

async function main() {
  log("Test", "=== L1→L2 Deposit Test (Role Separation) ===");
  log("Test", `Rollup: ${ROLLUP_ADDRESS}`);

  // Connect to chains
  const l1Provider = new JsonRpcProvider(`http://localhost:${CONFIG.l1Port}`);
  const l2BuilderProvider = new JsonRpcProvider(`http://localhost:${CONFIG.l2BuilderPort}`);
  const l2FullnodeProvider = new JsonRpcProvider(`http://localhost:${CONFIG.l2FullnodePort}`);

  const l2Target = ACCOUNTS.user2.address;
  const depositAmount = ethers.parseEther("0.1");

  // Check initial balance
  const initialL2Balance = await l2FullnodeProvider.getBalance(l2Target);
  log("Test", `Initial L2 balance of ${l2Target}: ${ethers.formatEther(initialL2Balance)} ETH`);

  // ==========================================
  // USER SIDE
  // ==========================================
  log("Test", "");
  log("Test", "========== USER SIDE ==========");

  const { signedTx, hints } = await userCreateL1ToL2Transaction(
    l1Provider,
    ROLLUP_ADDRESS,
    ACCOUNTS.user1.privateKey,  // User1 deposits to User2
    l2Target,
    depositAmount
  );

  log("User", `Transaction signed, submitting to builder with hints:`);
  log("User", `  l2TargetAddress: ${hints.l2TargetAddress}`);
  log("User", `  description: ${hints.description}`);

  // ==========================================
  // BUILDER SIDE
  // ==========================================
  log("Test", "");
  log("Test", "========== BUILDER SIDE ==========");

  const result = await builderProcessL1ToL2Transaction(
    l1Provider,
    l2BuilderProvider,
    l2FullnodeProvider,
    ROLLUP_ADDRESS,
    ACCOUNTS.admin.privateKey,
    signedTx,
    hints
  );

  // ==========================================
  // VERIFY
  // ==========================================
  log("Test", "");
  log("Test", "========== VERIFICATION ==========");

  await new Promise(r => setTimeout(r, 500));

  const finalL2Balance = await l2FullnodeProvider.getBalance(l2Target);
  const change = finalL2Balance - initialL2Balance;

  log("Test", `Final L2 balance: ${ethers.formatEther(finalL2Balance)} ETH`);
  log("Test", `Change: +${ethers.formatEther(change)} ETH`);

  if (change === depositAmount) {
    log("Test", "✓ Deposit successful!");
  } else {
    log("Test", "✗ Deposit failed - unexpected balance change");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
