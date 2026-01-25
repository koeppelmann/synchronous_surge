/**
 * Deposit xDAI from L1 (Gnosis) to L2 addresses
 *
 * This script:
 * 1. Deploys L2SenderProxy for each L2 recipient (if not exists)
 * 2. Registers the incoming call response (deposit with empty calldata)
 * 3. Calls the proxy with value to trigger the deposit
 */

import { ethers, Contract, Wallet, AbiCoder, keccak256 } from "ethers";

// Configuration
const L1_RPC = process.env.L1_RPC || "https://rpc.gnosischain.com";
const ROLLUP_ADDRESS = process.env.ROLLUP_ADDRESS || "0x5E87A156F55c85e765C81af1312C76f8a9a1bc7d";
const ADMIN_PK = process.env.ADMIN_PK || "0xf2024347d89be67338b62344010fb2ebc5db60cad2ff591a92a30b8215f87f22";

// Deposit amount: 0.01 xDAI
const DEPOSIT_AMOUNT = ethers.parseEther("0.01");

// L2 recipients
const RECIPIENTS = [
  "0x7B2e78D4dFaABA045A167a70dA285E30E8FcA196", // External address
  "0xE5e69c567516C6C3E88ABEb2455d1228d2aF35F1", // Admin address (we have key)
];

// ABI
const ROLLUP_ABI = [
  "function l2BlockHash() view returns (bytes32)",
  "function l2BlockNumber() view returns (uint256)",
  "function getProxyAddress(address l2Address) view returns (address)",
  "function isProxyDeployed(address l2Address) view returns (bool)",
  "function deployProxy(address l2Address) returns (address)",
  "function registerIncomingCall(address l2Address, bytes32 stateHash, bytes calldata callData, tuple(bytes32 preOutgoingCallsStateHash, tuple(address from, address target, uint256 value, uint256 gas, bytes data, bytes32 postCallStateHash)[] outgoingCalls, bytes[] expectedResults, bytes returnValue, bytes32 finalStateHash) response, bytes proof)",
  "function incomingCallRegistered(bytes32) view returns (bool)",
  "event L2SenderProxyDeployed(address indexed l2Address, address indexed proxyAddress)",
  "event IncomingCallHandled(address indexed l2Address, bytes32 indexed responseKey, uint256 outgoingCallsCount, uint256 value)",
];

async function main() {
  console.log("=== Deposit xDAI to L2 on Gnosis Mainnet ===\n");

  const provider = new ethers.JsonRpcProvider(L1_RPC);
  const wallet = new Wallet(ADMIN_PK, provider);
  const rollup = new Contract(ROLLUP_ADDRESS, ROLLUP_ABI, wallet);

  console.log(`L1 RPC: ${L1_RPC}`);
  console.log(`NativeRollupCore: ${ROLLUP_ADDRESS}`);
  console.log(`Admin/Depositor: ${wallet.address}`);
  console.log(`Deposit amount: ${ethers.formatEther(DEPOSIT_AMOUNT)} xDAI per recipient`);
  console.log("");

  // Check admin balance
  const balance = await provider.getBalance(wallet.address);
  console.log(`Admin balance: ${ethers.formatEther(balance)} xDAI`);

  const totalNeeded = DEPOSIT_AMOUNT * BigInt(RECIPIENTS.length) + ethers.parseEther("0.01"); // + gas
  if (balance < totalNeeded) {
    console.error(`Insufficient balance. Need at least ${ethers.formatEther(totalNeeded)} xDAI`);
    process.exit(1);
  }

  // Get current L2 state
  const currentL2Hash = await rollup.l2BlockHash();
  const currentL2Block = await rollup.l2BlockNumber();
  console.log(`\nCurrent L2 state:`);
  console.log(`  Block number: ${currentL2Block}`);
  console.log(`  Block hash: ${currentL2Hash}`);

  for (const recipient of RECIPIENTS) {
    console.log(`\n--- Depositing to ${recipient} ---`);

    // Step 1: Check/deploy proxy
    const isDeployed = await rollup.isProxyDeployed(recipient);
    let proxyAddress = await rollup.getProxyAddress(recipient);

    if (!isDeployed) {
      console.log(`Deploying proxy for ${recipient}...`);
      const deployTx = await rollup.deployProxy(recipient);
      const receipt = await deployTx.wait();
      console.log(`  Proxy deployed at: ${proxyAddress}`);
      console.log(`  Tx hash: ${receipt.hash}`);
    } else {
      console.log(`Proxy already deployed at: ${proxyAddress}`);
    }

    // Step 2: Register incoming call response
    // For a simple deposit (no calldata), we need to register the response
    // The L2 state will change to reflect the deposit

    // Get fresh L2 state (may have changed from previous deposit)
    const l2Hash = await rollup.l2BlockHash();
    const callData = "0x"; // Empty calldata for pure value transfer

    // For POC, the new state is the same as current (we're not actually executing on L2)
    // In production, we'd compute the real post-deposit state
    // For this POC, we use a deterministic hash based on the deposit
    const newStateHash = keccak256(
      AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "address", "uint256"],
        [l2Hash, recipient, DEPOSIT_AMOUNT]
      )
    );

    // Create the response structure
    const response = {
      preOutgoingCallsStateHash: newStateHash,
      outgoingCalls: [],
      expectedResults: [],
      returnValue: "0x",
      finalStateHash: newStateHash,
    };

    // Sign the proof
    const proof = await signIncomingCallProof(
      wallet,
      recipient,
      l2Hash,
      callData,
      response.preOutgoingCallsStateHash,
      keccak256("0x"), // empty outgoing calls
      keccak256("0x"), // empty results
      keccak256("0x"), // empty return value
      response.finalStateHash
    );

    console.log(`Registering incoming call...`);
    console.log(`  Current L2 hash: ${l2Hash}`);
    console.log(`  New state hash: ${newStateHash}`);

    const registerTx = await rollup.registerIncomingCall(
      recipient,
      l2Hash,
      callData,
      response,
      proof
    );
    const registerReceipt = await registerTx.wait();
    console.log(`  Registered. Tx hash: ${registerReceipt.hash}`);

    // Step 3: Call the proxy with value
    console.log(`Calling proxy with ${ethers.formatEther(DEPOSIT_AMOUNT)} xDAI...`);

    const depositTx = await wallet.sendTransaction({
      to: proxyAddress,
      value: DEPOSIT_AMOUNT,
      data: "0x",
    });
    const depositReceipt = await depositTx.wait();
    console.log(`  Deposit complete. Tx hash: ${depositReceipt.hash}`);

    // Verify new state
    const finalL2Hash = await rollup.l2BlockHash();
    console.log(`  New L2 hash: ${finalL2Hash}`);
  }

  console.log("\n=== All deposits complete ===");

  const finalL2Hash = await rollup.l2BlockHash();
  const finalL2Block = await rollup.l2BlockNumber();
  console.log(`Final L2 state:`);
  console.log(`  Block number: ${finalL2Block}`);
  console.log(`  Block hash: ${finalL2Hash}`);
}

async function signIncomingCallProof(
  wallet: Wallet,
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

  return await wallet.signMessage(ethers.getBytes(messageHash));
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
