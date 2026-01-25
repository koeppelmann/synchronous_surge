/**
 * Direct L2 Proxy Call from an arbitrary L1 address
 *
 * This script calls the L2 proxy directly from a specified L1 address,
 * bypassing any L1 contract intermediary.
 *
 * Usage:
 *   npx tsx scripts/direct-proxy-call.ts <l1_caller> <value>
 */

import {
  ethers,
  JsonRpcProvider,
  Wallet,
  Contract,
  keccak256,
  AbiCoder,
} from "ethers";

// Configuration
const L1_RPC = process.env.L1_RPC || "http://localhost:9545";
const L2_RPC = process.env.L2_RPC || "http://localhost:9546";

const ROLLUP_ADDRESS = "0x4240994d85109581B001183ab965D9e3d5fb2C2A";
const L2_SYNCED_COUNTER = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512";

const ADMIN_PK =
  "0xf2024347d89be67338b62344010fb2ebc5db60cad2ff591a92a30b8215f87f22";

// ABIs
const ROLLUP_ABI = [
  "function l2BlockHash() view returns (bytes32)",
  "function l2BlockNumber() view returns (uint256)",
  "function getProxyAddress(address l2Address) view returns (address)",
  "function registerIncomingCall(address l2Address, bytes32 stateHash, bytes calldata callData, tuple(bytes32 preOutgoingCallsStateHash, tuple(address from, address target, uint256 value, uint256 gas, bytes data, bytes32 postCallStateHash)[] outgoingCalls, bytes[] expectedResults, bytes returnValue, bytes32 finalStateHash) response, bytes proof)",
];

const SYNCED_COUNTER_ABI = [
  "function setValue(uint256 value) returns (uint256)",
  "function value() view returns (uint256)",
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

  const signature = await adminWallet.signMessage(ethers.getBytes(messageHash));
  return signature;
}

async function main() {
  const l1Caller = process.argv[2] || "0x7B2e78D4dFaABA045A167a70dA285E30E8FcA196";
  const valueToSet = parseInt(process.argv[3] || "6");

  console.log("=== Direct L2 Proxy Call ===");
  console.log(`L1 Caller: ${l1Caller}`);
  console.log(`Setting value to: ${valueToSet}`);
  console.log("");

  // Setup providers and wallets
  const l1Provider = new JsonRpcProvider(L1_RPC);
  const l2Provider = new JsonRpcProvider(L2_RPC);

  const adminWallet = new Wallet(ADMIN_PK, l1Provider);

  // Setup contracts
  const rollup = new Contract(ROLLUP_ADDRESS, ROLLUP_ABI, adminWallet);
  const l2Counter = new Contract(
    L2_SYNCED_COUNTER,
    SYNCED_COUNTER_ABI,
    l2Provider
  );

  // Get current state
  const currentL2Hash: string = await rollup.l2BlockHash();
  console.log(`Current L2 block hash on L1: ${currentL2Hash}`);

  // Get L2 proxy address on L1
  const l2ProxyOnL1: string = await rollup.getProxyAddress(L2_SYNCED_COUNTER);
  console.log(`L2 proxy on L1: ${l2ProxyOnL1}`);

  // Compute L1 caller's proxy on L2
  const l1CallerProxyOnL2 = computeL2ProxyAddress(l1Caller);
  console.log(`L1 caller (${l1Caller}) proxy on L2: ${l1CallerProxyOnL2}`);

  // The call data for setValue
  const l2CallData = l2Counter.interface.encodeFunctionData("setValue", [
    valueToSet,
  ]);

  // ============================================================
  // Step 1: Execute on L2 FIRST
  // ============================================================
  console.log("");
  console.log("Step 1: Executing on L2 first...");

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

  const preOutgoingState = l2StateRoot;
  const finalState = l2StateRoot;

  // Return value
  const returnValue = AbiCoder.defaultAbiCoder().encode(["uint256"], [valueToSet]);

  // Empty outgoing calls and results
  const outgoingCallsHash = keccak256("0x");
  const resultsHash = keccak256("0x");

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
  // Step 3: Execute L1 call to the proxy directly
  // ============================================================
  console.log("");
  console.log("Step 3: Executing direct call to L2 proxy on L1...");

  // Impersonate the L1 caller on L1
  await l1Provider.send("anvil_impersonateAccount", [l1Caller]);

  // Fund the L1 caller for gas
  const l1CallerBalance = await l1Provider.getBalance(l1Caller);
  if (l1CallerBalance < ethers.parseEther("0.1")) {
    await l1Provider.send("anvil_setBalance", [
      l1Caller,
      "0x" + ethers.parseEther("1").toString(16),
    ]);
  }

  // Call the L2 proxy directly from the L1 caller
  const l1Signer = await l1Provider.getSigner(l1Caller);
  const l1Tx = await l1Signer.sendTransaction({
    to: l2ProxyOnL1,
    data: l2CallData,
  });

  const l1Receipt = await l1Tx.wait();
  console.log(`L1 tx hash: ${l1Receipt?.hash}`);
  console.log(`L1 tx status: ${l1Receipt?.status === 1 ? "success" : "failed"}`);

  // Stop impersonating
  await l1Provider.send("anvil_stopImpersonatingAccount", [l1Caller]);

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
  }

  // Check L2 counter value
  const finalL2Value = await l2Counter.value();
  console.log("");
  console.log(`L2 Counter: ${finalL2Value}`);
  console.log(`L1 Caller: ${l1Caller}`);
  console.log(`L1 Caller's proxy on L2: ${l1CallerProxyOnL2}`);
}

main().catch(console.error);
