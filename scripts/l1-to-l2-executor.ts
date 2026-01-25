/**
 * L1→L2 Executor with Real State Roots
 *
 * This script:
 * 1. Executes the L2 call FIRST on L2 (via impersonation)
 * 2. Gets the actual L2 state root after execution
 * 3. Registers the incoming call on L1 with the real state root
 * 4. Executes the L1 transaction
 *
 * Usage:
 *   npx tsx scripts/l1-to-l2-executor.ts <value>
 */

import {
  ethers,
  JsonRpcProvider,
  Wallet,
  Contract,
  keccak256,
  AbiCoder,
  solidityPackedKeccak256,
} from "ethers";

// Configuration
const L1_RPC = process.env.L1_RPC || "http://localhost:9545";
const L2_RPC = process.env.L2_RPC || "http://localhost:9546";

const ROLLUP_ADDRESS = "0x4240994d85109581B001183ab965D9e3d5fb2C2A";
const L1_SYNCED_COUNTER = "0xd30bF3219A0416602bE8D482E0396eF332b0494E";
const L2_SYNCED_COUNTER = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512";

const ADMIN_PK =
  "0xf2024347d89be67338b62344010fb2ebc5db60cad2ff591a92a30b8215f87f22";
const CALLER_PK =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

// ABIs
const ROLLUP_ABI = [
  "function l2BlockHash() view returns (bytes32)",
  "function l2BlockNumber() view returns (uint256)",
  "function getProxyAddress(address l2Address) view returns (address)",
  "function registerIncomingCall(address l2Address, bytes32 stateHash, bytes calldata callData, tuple(bytes32 preOutgoingCallsStateHash, tuple(address from, address target, uint256 value, uint256 gas, bytes data, bytes32 postCallStateHash)[] outgoingCalls, bytes[] expectedResults, bytes returnValue, bytes32 finalStateHash) response, bytes proof)",
  "event IncomingCallRegistered(address indexed l2Address, bytes32 indexed stateHash, bytes32 indexed callDataHash, bytes32 responseKey)",
];

const SYNCED_COUNTER_ABI = [
  "function setValue(uint256 value) returns (uint256)",
  "function value() view returns (uint256)",
  "function l2Proxy() view returns (address)",
];

/**
 * Compute the L2 proxy address for an L1 address
 */
function computeL2ProxyAddress(l1Address: string): string {
  const hash = keccak256(
    AbiCoder.defaultAbiCoder().encode(
      ["string", "address"],
      ["NativeRollup.L1SenderProxy.v1", l1Address]
    )
  );
  return "0x" + hash.slice(-40);
}

/**
 * Sign the incoming call proof (admin signature)
 */
async function signIncomingCallProof(
  l2Address: string,
  stateHash: string,
  callData: string,
  preOutgoingState: string,
  outgoingCallsHash: string,
  resultsHash: string,
  returnValueHash: string,
  finalState: string,
  adminWallet: Wallet
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

  console.log(`  Message hash: ${messageHash}`);

  // Sign using signMessage which adds the Ethereum signed message prefix
  const signature = await adminWallet.signMessage(ethers.getBytes(messageHash));
  return signature;
}

async function main() {
  const valueToSet = parseInt(process.argv[2] || "200");

  console.log("=== L1→L2 Executor (Real State Roots) ===");
  console.log(`Setting value to: ${valueToSet}`);
  console.log("");

  // Setup providers and wallets
  const l1Provider = new JsonRpcProvider(L1_RPC);
  const l2Provider = new JsonRpcProvider(L2_RPC);

  const adminWallet = new Wallet(ADMIN_PK, l1Provider);
  const callerWallet = new Wallet(CALLER_PK, l1Provider);

  // Setup contracts
  const rollup = new Contract(ROLLUP_ADDRESS, ROLLUP_ABI, adminWallet);
  const l1Counter = new Contract(
    L1_SYNCED_COUNTER,
    SYNCED_COUNTER_ABI,
    callerWallet
  );
  const l2Counter = new Contract(
    L2_SYNCED_COUNTER,
    SYNCED_COUNTER_ABI,
    l2Provider
  );

  // Get current state
  const currentL2Hash: string = await rollup.l2BlockHash();
  const currentL2BlockNum: bigint = await rollup.l2BlockNumber();
  console.log(`Current L2 block hash on L1: ${currentL2Hash}`);
  console.log(`Current L2 block number on L1: ${currentL2BlockNum}`);

  // Get L2 proxy for L1SyncedCounter
  const l2ProxyOnL1 = await rollup.getProxyAddress(L2_SYNCED_COUNTER);
  console.log(`L2 proxy on L1: ${l2ProxyOnL1}`);

  // Compute L1 caller's proxy on L2
  const l1CallerProxyOnL2 = computeL2ProxyAddress(L1_SYNCED_COUNTER);
  console.log(`L1 caller proxy on L2: ${l1CallerProxyOnL2}`);

  // ============================================================
  // Step 1: Execute on L2 FIRST
  // ============================================================
  console.log("");
  console.log("Step 1: Executing on L2 first...");

  // Get L2 block BEFORE execution
  const l2BlockBefore = await l2Provider.getBlock("latest");
  console.log(`L2 block before: ${l2BlockBefore?.number}`);
  console.log(`L2 state root before: ${l2BlockBefore?.stateRoot}`);

  // Impersonate the L1 caller's proxy on L2
  await l2Provider.send("anvil_impersonateAccount", [l1CallerProxyOnL2]);

  // Fund the proxy for gas
  const proxyBalance = await l2Provider.getBalance(l1CallerProxyOnL2);
  if (proxyBalance < ethers.parseEther("0.1")) {
    await l2Provider.send("anvil_setBalance", [
      l1CallerProxyOnL2,
      "0x" + ethers.parseEther("1").toString(16),
    ]);
  }

  // Execute setValue on L2
  const l2CallData = l2Counter.interface.encodeFunctionData("setValue", [
    valueToSet,
  ]);

  const l2Signer = await l2Provider.getSigner(l1CallerProxyOnL2);
  const l2Tx = await l2Signer.sendTransaction({
    to: L2_SYNCED_COUNTER,
    data: l2CallData,
  });

  const l2Receipt = await l2Tx.wait();
  console.log(`L2 tx hash: ${l2Receipt?.hash}`);
  console.log(`L2 tx status: ${l2Receipt?.status === 1 ? "success" : "failed"}`);

  // Stop impersonating
  await l2Provider.send("anvil_stopImpersonatingAccount", [l1CallerProxyOnL2]);

  // Get L2 block AFTER execution
  const l2BlockAfter = await l2Provider.getBlock("latest");
  console.log(`L2 block after: ${l2BlockAfter?.number}`);
  console.log(`L2 state root after: ${l2BlockAfter?.stateRoot}`);

  // The state root to commit on L1
  const l2StateRoot = l2BlockAfter?.stateRoot;
  if (!l2StateRoot) {
    throw new Error("Failed to get L2 state root");
  }
  console.log("");
  console.log(`>>> L2 State Root to commit: ${l2StateRoot}`);

  // Verify L2 value was set
  const l2Value = await l2Counter.value();
  console.log(`L2 counter value: ${l2Value}`);

  // ============================================================
  // Step 2: Register incoming call on L1 with real state root
  // ============================================================
  console.log("");
  console.log("Step 2: Registering incoming call on L1...");

  // The state hashes use the ACTUAL L2 state root
  const preOutgoingState = l2StateRoot;
  const finalState = l2StateRoot; // No outgoing calls

  // Return value (setValue returns the value)
  const returnValue = AbiCoder.defaultAbiCoder().encode(["uint256"], [valueToSet]);

  // Empty outgoing calls and results
  const outgoingCallsHash = keccak256("0x"); // Empty array hash
  const resultsHash = keccak256("0x"); // Empty array hash

  // Sign the proof
  const proof = await signIncomingCallProof(
    L2_SYNCED_COUNTER,
    currentL2Hash,
    l2CallData,
    preOutgoingState,
    outgoingCallsHash,
    resultsHash,
    keccak256(returnValue),
    finalState,
    adminWallet
  );

  console.log(`Proof: ${proof.slice(0, 20)}...`);

  // Prepare the response struct
  const response = {
    preOutgoingCallsStateHash: preOutgoingState,
    outgoingCalls: [],
    expectedResults: [],
    returnValue: returnValue,
    finalStateHash: finalState,
  };

  // Register the incoming call
  const registerTx = await rollup.registerIncomingCall(
    L2_SYNCED_COUNTER,
    currentL2Hash,
    l2CallData,
    response,
    proof
  );

  const registerReceipt = await registerTx.wait();
  console.log(`Register tx hash: ${registerReceipt?.hash}`);
  console.log(
    `Register tx status: ${registerReceipt?.status === 1 ? "success" : "failed"}`
  );

  // ============================================================
  // Step 3: Execute L1 transaction
  // ============================================================
  console.log("");
  console.log("Step 3: Executing L1 transaction...");

  const l1Tx = await l1Counter.setValue(valueToSet);
  const l1Receipt = await l1Tx.wait();
  console.log(`L1 tx hash: ${l1Receipt?.hash}`);
  console.log(`L1 tx status: ${l1Receipt?.status === 1 ? "success" : "failed"}`);

  // Verify L1 value
  const l1Value = await l1Counter.value();
  console.log(`L1 counter value: ${l1Value}`);

  // ============================================================
  // Final verification
  // ============================================================
  console.log("");
  console.log("=== Final State ===");

  const finalL2HashOnL1: string = await rollup.l2BlockHash();
  console.log(`L2 block hash on L1 (commitment): ${finalL2HashOnL1}`);
  console.log(`L2 state root (actual):           ${l2StateRoot}`);
  console.log("");

  if (finalL2HashOnL1.toLowerCase() === l2StateRoot.toLowerCase()) {
    console.log("✓ SUCCESS: L1 commitment matches actual L2 state root!");
  } else {
    console.log("✗ MISMATCH: L1 commitment does not match L2 state root");
    console.log(
      "  This is expected if the L2 state root format differs from what we're storing"
    );
  }

  console.log("");
  console.log(`L1 Counter: ${l1Value}`);
  console.log(`L2 Counter: ${l2Value}`);
}

main().catch(console.error);
