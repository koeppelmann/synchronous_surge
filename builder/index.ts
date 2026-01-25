/**
 * Native Rollup Builder
 *
 * The builder handles two types of L2 state transitions:
 *
 * 1. L2 EOA Transactions:
 *    - User signs a transaction for L2 chain
 *    - Builder executes on L2 first to get state root
 *    - Builder creates and submits processCallOnL2() on L1
 *
 * 2. L1→L2 Contract Calls:
 *    - L1 contract wants to call L2 contract via proxy
 *    - Builder executes on L2 first to get state root and return value
 *    - Builder registers the incoming call response on L1
 *    - L1 contract can then call the proxy
 *
 * The builder is the "prover" in POC mode - it signs proofs with admin key.
 * In production, this would be replaced with ZK proofs.
 */

import {
  ethers,
  Contract,
  JsonRpcProvider,
  Wallet,
  AbiCoder,
  keccak256,
  Transaction,
  TransactionLike,
} from "ethers";

// ============ Configuration ============

export interface BuilderConfig {
  l1Rpc: string;
  l2Rpc: string;
  rollupAddress: string;
  adminPrivateKey: string; // For signing proofs (POC only)
}

const DEFAULT_CONFIG: BuilderConfig = {
  l1Rpc: process.env.L1_RPC || "http://localhost:9545",
  l2Rpc: process.env.L2_RPC || "http://localhost:9546",
  rollupAddress:
    process.env.ROLLUP_ADDRESS || "0x4240994d85109581B001183ab965D9e3d5fb2C2A",
  adminPrivateKey:
    process.env.ADMIN_PK ||
    "0xf2024347d89be67338b62344010fb2ebc5db60cad2ff591a92a30b8215f87f22",
};

// ============ ABI ============

const ROLLUP_ABI = [
  "function l2BlockHash() view returns (bytes32)",
  "function l2BlockNumber() view returns (uint256)",
  "function getProxyAddress(address l2Address) view returns (address)",
  "function isProxyDeployed(address l2Address) view returns (bool)",
  "function deployProxy(address l2Address) returns (address)",
  "function processCallOnL2(bytes32 prevL2BlockHash, bytes calldata callData, bytes32 postExecutionStateHash, tuple(address from, address target, uint256 value, uint256 gas, bytes data, bytes32 postCallStateHash)[] outgoingCalls, bytes[] expectedResults, bytes32 finalStateHash, bytes proof) payable",
  "function registerIncomingCall(address l2Address, bytes32 stateHash, bytes calldata callData, tuple(bytes32 preOutgoingCallsStateHash, tuple(address from, address target, uint256 value, uint256 gas, bytes data, bytes32 postCallStateHash)[] outgoingCalls, bytes[] expectedResults, bytes returnValue, bytes32 finalStateHash) response, bytes proof)",
];

// ============ Types ============

export interface L2Transaction {
  from: string;
  to: string;
  value?: bigint;
  data?: string;
  nonce?: number;
  gasLimit?: bigint;
  gasPrice?: bigint;
}

export interface IncomingCallRequest {
  l1Caller: string; // The L1 contract that will call the L2 proxy
  l2Target: string; // The L2 contract being called
  callData: string; // The calldata for the L2 call
  value?: bigint; // Optional value
}

export interface BuildResult {
  success: boolean;
  l1TxHash?: string;
  l2TxHash?: string;
  l2StateRoot?: string;
  error?: string;
}

// ============ Utility Functions ============

/**
 * Compute the L2 proxy address for an L1 address
 */
export function computeL2ProxyAddress(l1Address: string): string {
  const hash = keccak256(
    AbiCoder.defaultAbiCoder().encode(
      ["string", "address"],
      ["NativeRollup.L1SenderProxy.v1", l1Address]
    )
  );
  return "0x" + hash.slice(-40);
}

// ============ Builder ============

export class Builder {
  private config: BuilderConfig;
  private l1Provider: JsonRpcProvider;
  private l2Provider: JsonRpcProvider;
  private adminWallet: Wallet;
  private rollupCore: Contract;

  constructor(config: Partial<BuilderConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.l1Provider = new JsonRpcProvider(this.config.l1Rpc);
    this.l2Provider = new JsonRpcProvider(this.config.l2Rpc);
    this.adminWallet = new Wallet(this.config.adminPrivateKey, this.l1Provider);
    this.rollupCore = new Contract(
      this.config.rollupAddress,
      ROLLUP_ABI,
      this.adminWallet
    );
  }

  /**
   * Get current L2 state from L1
   */
  async getL2State(): Promise<{ blockNumber: bigint; blockHash: string }> {
    const [blockNumber, blockHash] = await Promise.all([
      this.rollupCore.l2BlockNumber(),
      this.rollupCore.l2BlockHash(),
    ]);
    return { blockNumber, blockHash };
  }

  /**
   * Get actual L2 state root from L2 chain
   */
  async getL2StateRoot(): Promise<string> {
    const block = await this.l2Provider.getBlock("latest");
    return block?.stateRoot || "";
  }

  // ================================================================
  // Case 1: Build L2 EOA Transaction
  // ================================================================

  /**
   * Build and submit an L2 EOA transaction
   *
   * Flow:
   * 1. Execute transaction on L2 first (via raw tx or impersonation)
   * 2. Get resulting L2 state root
   * 3. Sign proof with admin key
   * 4. Submit processCallOnL2() on L1
   *
   * @param signedTx - RLP-encoded signed transaction for L2
   */
  async buildL2Transaction(signedTx: string): Promise<BuildResult> {
    console.log("=== Building L2 Transaction ===");

    try {
      // Get current L2 state from L1
      const l2State = await this.getL2State();
      console.log(`Current L2 block hash on L1: ${l2State.blockHash}`);

      // Step 1: Execute on L2 first
      console.log("Step 1: Executing on L2...");

      const l2TxHash = await this.l2Provider.send("eth_sendRawTransaction", [
        signedTx,
      ]);
      console.log(`  L2 tx hash: ${l2TxHash}`);

      const l2Receipt = await this.l2Provider.waitForTransaction(l2TxHash);
      if (l2Receipt?.status !== 1) {
        return { success: false, error: "L2 transaction reverted" };
      }
      console.log(`  L2 tx confirmed`);

      // Step 2: Get new L2 state root
      const l2Block = await this.l2Provider.getBlock("latest");
      const l2StateRoot = l2Block?.stateRoot;
      if (!l2StateRoot) {
        return { success: false, error: "Failed to get L2 state root" };
      }
      console.log(`  L2 state root: ${l2StateRoot}`);

      // Step 3: Sign proof
      console.log("Step 2: Signing proof...");

      const proof = await this.signProcessCallProof(
        l2State.blockHash,
        signedTx,
        l2StateRoot,
        [], // No outgoing calls for EOA tx
        [], // No expected results
        l2StateRoot // Final state = post execution state
      );

      // Step 4: Submit processCallOnL2 on L1
      console.log("Step 3: Submitting to L1...");

      const l1Tx = await this.rollupCore.processCallOnL2(
        l2State.blockHash,
        signedTx,
        l2StateRoot,
        [], // No outgoing calls
        [], // No expected results
        l2StateRoot,
        proof
      );

      const l1Receipt = await l1Tx.wait();
      console.log(`  L1 tx hash: ${l1Receipt?.hash}`);
      console.log(
        `  L1 tx status: ${l1Receipt?.status === 1 ? "success" : "failed"}`
      );

      // Verify final state
      const finalL2Hash = await this.rollupCore.l2BlockHash();
      console.log(`\nFinal L2 block hash on L1: ${finalL2Hash}`);
      console.log(
        `Match: ${finalL2Hash.toLowerCase() === l2StateRoot.toLowerCase() ? "YES" : "NO"}`
      );

      return {
        success: true,
        l1TxHash: l1Receipt?.hash,
        l2TxHash,
        l2StateRoot,
      };
    } catch (err: any) {
      console.error("Error:", err.message);
      return { success: false, error: err.message };
    }
  }

  /**
   * Build and submit an L2 transaction from unsigned tx data
   * Uses impersonation on L2 (Anvil only)
   */
  async buildL2TransactionUnsigned(tx: L2Transaction): Promise<BuildResult> {
    console.log("=== Building L2 Transaction (Unsigned) ===");
    console.log(`From: ${tx.from}`);
    console.log(`To: ${tx.to}`);

    try {
      // Get current L2 state from L1
      const l2State = await this.getL2State();
      console.log(`Current L2 block hash on L1: ${l2State.blockHash}`);

      // Step 1: Execute on L2 via impersonation
      console.log("Step 1: Executing on L2...");

      await this.l2Provider.send("anvil_impersonateAccount", [tx.from]);

      // Ensure from has balance for gas
      const balance = await this.l2Provider.getBalance(tx.from);
      if (balance < ethers.parseEther("0.1")) {
        await this.l2Provider.send("anvil_setBalance", [
          tx.from,
          "0x" + ethers.parseEther("1").toString(16),
        ]);
      }

      const signer = await this.l2Provider.getSigner(tx.from);
      const l2Tx = await signer.sendTransaction({
        to: tx.to,
        value: tx.value || 0n,
        data: tx.data || "0x",
      });

      const l2Receipt = await l2Tx.wait();
      await this.l2Provider.send("anvil_stopImpersonatingAccount", [tx.from]);

      if (l2Receipt?.status !== 1) {
        return { success: false, error: "L2 transaction reverted" };
      }
      console.log(`  L2 tx hash: ${l2Receipt.hash}`);

      // Step 2: Get new L2 state root
      const l2Block = await this.l2Provider.getBlock("latest");
      const l2StateRoot = l2Block?.stateRoot;
      if (!l2StateRoot) {
        return { success: false, error: "Failed to get L2 state root" };
      }
      console.log(`  L2 state root: ${l2StateRoot}`);

      // Step 3: Create callData representation
      // For unsigned tx, we encode it as: (from, to, value, data)
      const callData = AbiCoder.defaultAbiCoder().encode(
        ["address", "address", "uint256", "bytes"],
        [tx.from, tx.to, tx.value || 0n, tx.data || "0x"]
      );

      // Step 4: Sign proof
      console.log("Step 2: Signing proof...");

      const proof = await this.signProcessCallProof(
        l2State.blockHash,
        callData,
        l2StateRoot,
        [],
        [],
        l2StateRoot
      );

      // Step 5: Submit processCallOnL2 on L1
      console.log("Step 3: Submitting to L1...");

      const l1Tx = await this.rollupCore.processCallOnL2(
        l2State.blockHash,
        callData,
        l2StateRoot,
        [],
        [],
        l2StateRoot,
        proof
      );

      const l1Receipt = await l1Tx.wait();
      console.log(`  L1 tx hash: ${l1Receipt?.hash}`);

      return {
        success: true,
        l1TxHash: l1Receipt?.hash,
        l2TxHash: l2Receipt.hash,
        l2StateRoot,
      };
    } catch (err: any) {
      console.error("Error:", err.message);
      return { success: false, error: err.message };
    }
  }

  // ================================================================
  // Case 2: Build L1→L2 Incoming Call
  // ================================================================

  /**
   * Prepare an L1→L2 incoming call
   *
   * Flow:
   * 1. Execute the call on L2 first (impersonate L1 caller's proxy)
   * 2. Get L2 state root and return value
   * 3. Register incoming call response on L1
   * 4. Returns the L2 proxy address that L1 should call
   *
   * After this, the L1 contract can call the L2 proxy and it will
   * return the pre-registered response.
   */
  async prepareIncomingCall(request: IncomingCallRequest): Promise<BuildResult> {
    console.log("=== Preparing L1→L2 Incoming Call ===");
    console.log(`L1 Caller: ${request.l1Caller}`);
    console.log(`L2 Target: ${request.l2Target}`);

    try {
      // Get current L2 state from L1
      const l2State = await this.getL2State();
      console.log(`Current L2 block hash on L1: ${l2State.blockHash}`);

      // Compute L1 caller's proxy on L2
      const l1CallerProxyOnL2 = computeL2ProxyAddress(request.l1Caller);
      console.log(`L1 caller's proxy on L2: ${l1CallerProxyOnL2}`);

      // Step 1: Execute on L2 first
      console.log("Step 1: Executing on L2...");

      await this.l2Provider.send("anvil_impersonateAccount", [l1CallerProxyOnL2]);

      // Fund the proxy for gas
      const balance = await this.l2Provider.getBalance(l1CallerProxyOnL2);
      if (balance < ethers.parseEther("0.1")) {
        await this.l2Provider.send("anvil_setBalance", [
          l1CallerProxyOnL2,
          "0x" + ethers.parseEther("1").toString(16),
        ]);
      }

      const l2Signer = await this.l2Provider.getSigner(l1CallerProxyOnL2);
      const l2Tx = await l2Signer.sendTransaction({
        to: request.l2Target,
        value: request.value || 0n,
        data: request.callData,
      });

      const l2Receipt = await l2Tx.wait();
      await this.l2Provider.send("anvil_stopImpersonatingAccount", [
        l1CallerProxyOnL2,
      ]);

      console.log(`  L2 tx hash: ${l2Receipt?.hash}`);
      console.log(
        `  L2 tx status: ${l2Receipt?.status === 1 ? "success" : "reverted"}`
      );

      // Step 2: Get L2 state root
      const l2Block = await this.l2Provider.getBlock("latest");
      const l2StateRoot = l2Block?.stateRoot;
      if (!l2StateRoot) {
        return { success: false, error: "Failed to get L2 state root" };
      }
      console.log(`  L2 state root: ${l2StateRoot}`);

      // Step 3: Extract return value from logs (if any)
      // For now, use empty return value - in production would simulate
      // TODO: Actually capture return value from eth_call
      let returnValue = "0x";

      // Try to get return value by simulating the call
      try {
        returnValue = await this.l2Provider.call({
          from: l1CallerProxyOnL2,
          to: request.l2Target,
          data: request.callData,
        });
      } catch {
        // If simulation fails, use empty return value
      }
      console.log(`  Return value: ${returnValue}`);

      // Step 4: Sign proof for registerIncomingCall
      console.log("Step 2: Signing proof...");

      const proof = await this.signIncomingCallProof(
        request.l2Target,
        l2State.blockHash,
        request.callData,
        l2StateRoot, // preOutgoingCallsStateHash
        keccak256("0x"), // outgoingCallsHash (empty)
        keccak256("0x"), // resultsHash (empty)
        keccak256(returnValue), // returnValueHash
        l2StateRoot // finalStateHash
      );

      // Step 5: Register on L1
      console.log("Step 3: Registering on L1...");

      const response = {
        preOutgoingCallsStateHash: l2StateRoot,
        outgoingCalls: [],
        expectedResults: [],
        returnValue: returnValue,
        finalStateHash: l2StateRoot,
      };

      const l1Tx = await this.rollupCore.registerIncomingCall(
        request.l2Target,
        l2State.blockHash,
        request.callData,
        response,
        proof
      );

      const l1Receipt = await l1Tx.wait();
      console.log(`  L1 tx hash: ${l1Receipt?.hash}`);

      // Get the L2 proxy address on L1 that should be called
      const l2ProxyOnL1 = await this.rollupCore.getProxyAddress(request.l2Target);

      // Ensure proxy is deployed
      const isDeployed = await this.rollupCore.isProxyDeployed(request.l2Target);
      if (!isDeployed) {
        console.log("  Deploying L2 proxy on L1...");
        const deployTx = await this.rollupCore.deployProxy(request.l2Target);
        await deployTx.wait();
      }

      console.log(`\n✓ Ready! L1 can now call proxy at: ${l2ProxyOnL1}`);
      console.log(`  with calldata: ${request.callData}`);

      return {
        success: true,
        l1TxHash: l1Receipt?.hash,
        l2TxHash: l2Receipt?.hash,
        l2StateRoot,
      };
    } catch (err: any) {
      console.error("Error:", err.message);
      return { success: false, error: err.message };
    }
  }

  /**
   * Execute an L1 transaction that calls an L2 proxy
   *
   * This is a convenience method that:
   * 1. Prepares the incoming call (executes on L2, registers response)
   * 2. Executes the L1 transaction that calls the proxy
   */
  async executeL1ToL2Call(
    l1Caller: string,
    l2Target: string,
    callData: string,
    value?: bigint
  ): Promise<BuildResult> {
    console.log("=== Execute L1→L2 Call ===");

    // Step 1: Prepare the incoming call
    const prepResult = await this.prepareIncomingCall({
      l1Caller,
      l2Target,
      callData,
      value,
    });

    if (!prepResult.success) {
      return prepResult;
    }

    // Step 2: Execute the L1 call to the proxy
    console.log("\nStep 4: Executing L1 call to proxy...");

    const l2ProxyOnL1 = await this.rollupCore.getProxyAddress(l2Target);

    // Impersonate L1 caller and call the proxy
    await this.l1Provider.send("anvil_impersonateAccount", [l1Caller]);

    const callerBalance = await this.l1Provider.getBalance(l1Caller);
    if (callerBalance < ethers.parseEther("0.1")) {
      await this.l1Provider.send("anvil_setBalance", [
        l1Caller,
        "0x" + ethers.parseEther("1").toString(16),
      ]);
    }

    const l1Signer = await this.l1Provider.getSigner(l1Caller);
    const l1Tx = await l1Signer.sendTransaction({
      to: l2ProxyOnL1,
      value: value || 0n,
      data: callData,
    });

    const l1Receipt = await l1Tx.wait();
    await this.l1Provider.send("anvil_stopImpersonatingAccount", [l1Caller]);

    console.log(`  L1 tx hash: ${l1Receipt?.hash}`);
    console.log(
      `  L1 tx status: ${l1Receipt?.status === 1 ? "success" : "failed"}`
    );

    // Verify final state
    const finalL2Hash = await this.rollupCore.l2BlockHash();
    console.log(`\nFinal L2 block hash on L1: ${finalL2Hash}`);
    console.log(`L2 state root: ${prepResult.l2StateRoot}`);

    return {
      ...prepResult,
      l1TxHash: l1Receipt?.hash,
    };
  }

  // ================================================================
  // Proof Signing (POC - Admin Signature)
  // ================================================================

  /**
   * Sign proof for processCallOnL2
   */
  private async signProcessCallProof(
    prevBlockHash: string,
    callData: string,
    postExecutionStateHash: string,
    outgoingCalls: any[],
    expectedResults: string[],
    finalStateHash: string
  ): Promise<string> {
    // Compute message hash matching IProofVerifier
    const outgoingCallsHash = this.hashOutgoingCalls(outgoingCalls);
    const resultsHash = this.hashResults(expectedResults);

    const messageHash = keccak256(
      AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "bytes32", "bytes32", "bytes32", "bytes32", "bytes32"],
        [
          prevBlockHash,
          keccak256(callData),
          postExecutionStateHash,
          outgoingCallsHash,
          resultsHash,
          finalStateHash,
        ]
      )
    );

    return await this.adminWallet.signMessage(ethers.getBytes(messageHash));
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
   * Hash outgoing calls array
   */
  private hashOutgoingCalls(calls: any[]): string {
    if (calls.length === 0) return keccak256("0x");

    let encoded = "0x";
    for (const call of calls) {
      encoded += AbiCoder.defaultAbiCoder()
        .encode(
          ["address", "address", "uint256", "uint256", "bytes32", "bytes32"],
          [
            call.from,
            call.target,
            call.value,
            call.gas,
            keccak256(call.data),
            call.postCallStateHash,
          ]
        )
        .slice(2);
    }
    return keccak256(encoded);
  }

  /**
   * Hash expected results array
   */
  private hashResults(results: string[]): string {
    if (results.length === 0) return keccak256("0x");

    let encoded = "0x";
    for (const result of results) {
      encoded += keccak256(result).slice(2);
    }
    return keccak256(encoded);
  }
}

// ============ CLI Entry Point ============

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  const builder = new Builder();

  switch (command) {
    case "l2-tx": {
      // Build L2 transaction from: from, to, value, data
      const from = args[1];
      const to = args[2];
      const value = args[3] ? BigInt(args[3]) : 0n;
      const data = args[4] || "0x";

      if (!from || !to) {
        console.log("Usage: npx tsx builder/index.ts l2-tx <from> <to> [value] [data]");
        process.exit(1);
      }

      const result = await builder.buildL2TransactionUnsigned({
        from,
        to,
        value,
        data,
      });

      console.log("\nResult:", result);
      break;
    }

    case "l1-to-l2": {
      // Build L1→L2 call: l1Caller, l2Target, callData
      const l1Caller = args[1];
      const l2Target = args[2];
      const callData = args[3] || "0x";

      if (!l1Caller || !l2Target) {
        console.log(
          "Usage: npx tsx builder/index.ts l1-to-l2 <l1Caller> <l2Target> [callData]"
        );
        process.exit(1);
      }

      const result = await builder.executeL1ToL2Call(l1Caller, l2Target, callData);

      console.log("\nResult:", result);
      break;
    }

    case "prepare": {
      // Prepare incoming call only (don't execute L1)
      const l1Caller = args[1];
      const l2Target = args[2];
      const callData = args[3] || "0x";

      if (!l1Caller || !l2Target) {
        console.log(
          "Usage: npx tsx builder/index.ts prepare <l1Caller> <l2Target> [callData]"
        );
        process.exit(1);
      }

      const result = await builder.prepareIncomingCall({
        l1Caller,
        l2Target,
        callData,
      });

      console.log("\nResult:", result);
      break;
    }

    case "status": {
      const l2State = await builder.getL2State();
      const l2StateRoot = await builder.getL2StateRoot();

      console.log("=== Builder Status ===");
      console.log(`L2 Block Number (L1): ${l2State.blockNumber}`);
      console.log(`L2 Block Hash (L1):   ${l2State.blockHash}`);
      console.log(`L2 State Root (L2):   ${l2StateRoot}`);
      console.log(
        `Match: ${l2State.blockHash.toLowerCase() === l2StateRoot.toLowerCase() ? "YES" : "NO"}`
      );
      break;
    }

    default:
      console.log("Native Rollup Builder");
      console.log("");
      console.log("Commands:");
      console.log("  l2-tx <from> <to> [value] [data]      - Build L2 EOA transaction");
      console.log("  l1-to-l2 <l1Caller> <l2Target> [data] - Execute L1→L2 call");
      console.log("  prepare <l1Caller> <l2Target> [data]  - Prepare incoming call only");
      console.log("  status                                - Show current state");
      console.log("");
      console.log("Examples:");
      console.log(
        "  npx tsx builder/index.ts l2-tx 0xf39F... 0x7B2e... 1000000000000000000"
      );
      console.log(
        "  npx tsx builder/index.ts l1-to-l2 0xd30b... 0xe7f1... 0x55241077..."
      );
  }
}

// Run if executed directly
if (process.argv[1]?.includes('builder')) {
  main().catch(console.error);
}
