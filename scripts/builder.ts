/**
 * Builder
 *
 * The builder receives transactions and uses the fullnode RPC to simulate them.
 * It ONLY interacts with the fullnode through the defined RPC interface.
 *
 * The builder does NOT know:
 * - What EVM implementation the fullnode uses (Anvil, Reth, etc.)
 * - How the fullnode internally handles state
 * - Any internal fullnode APIs (anvil_*, etc.)
 *
 * The builder ONLY uses:
 * - Standard Ethereum RPC (eth_*)
 * - Native Rollup RPC (nativerollup_*)
 */

import {
  ethers,
  JsonRpcProvider,
  Wallet,
  Contract,
  Transaction,
} from "ethers";
import * as http from "http";
import {
  SimulationResult,
  L1ToL2CallParams,
} from "../fullnode/fullnode-rpc-interface";

// ============ Configuration ============

interface Config {
  port: number;
  l1Rpc: string;
  fullnodeRpc: string;  // The fullnode's RPC endpoint (our custom RPC)
  rollupAddress: string;
  adminPrivateKey: string;
}

function parseArgs(): Config {
  const args = process.argv.slice(2);
  const config: Config = {
    port: 3200,
    l1Rpc: "http://localhost:8545",
    fullnodeRpc: "http://localhost:9547",  // Our fullnode RPC (NOT the raw L2 EVM)
    rollupAddress: "",
    adminPrivateKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--port":
        config.port = parseInt(args[++i]);
        break;
      case "--l1-rpc":
        config.l1Rpc = args[++i];
        break;
      case "--fullnode":
        config.fullnodeRpc = args[++i];
        break;
      case "--rollup":
        config.rollupAddress = args[++i];
        break;
      case "--admin-key":
        config.adminPrivateKey = args[++i];
        break;
    }
  }

  return config;
}

// ============ Globals ============

let l1Provider: JsonRpcProvider;
let adminWallet: Wallet;
let rollupContract: Contract;
let config: Config;

const ROLLUP_ABI = [
  "function l2BlockHash() view returns (bytes32)",
  "function l2BlockNumber() view returns (uint256)",
  "function processSingleTxOnL2(bytes32 prevL2BlockHash, bytes calldata rlpEncodedTx, bytes32 preOutgoingCallsStateHash, tuple(address from, address target, uint256 value, uint256 gas, bytes data, bytes32 postCallStateHash)[] outgoingCalls, bytes[] expectedResults, bytes32 finalStateHash, bytes proof) payable",
  "function getProxyAddress(address l2Address) view returns (address)",
  "function isProxyDeployed(address l2Address) view returns (bool)",
  "function deployProxy(address l2Address) returns (address)",
  "function registerIncomingCall(address l2Address, bytes32 stateHash, bytes calldata callData, tuple(bytes32 preOutgoingCallsStateHash, tuple(address from, address target, uint256 value, uint256 gas, bytes data, bytes32 postCallStateHash)[] outgoingCalls, bytes[] expectedResults, bytes returnValue, bytes32 finalStateHash) response, bytes proof)",
  "function getResponseKey(address l2Address, bytes32 stateHash, bytes calldata callData) view returns (bytes32)",
  "function incomingCallRegistered(bytes32 responseKey) view returns (bool)",
  "function incomingCallResponses(bytes32) view returns (bytes32 preOutgoingCallsStateHash, bytes returnValue, bytes32 finalStateHash)",
];

const L2_SENDER_PROXY_ABI = [
  "function nativeRollup() view returns (address)",
  "function l2Address() view returns (address)",
];

/**
 * Check if an address is an L2SenderProxy for our rollup
 * Returns the L2 address if it is, null otherwise
 */
async function getL2AddressIfProxy(address: string): Promise<string | null> {
  if (!address) return null;

  try {
    const proxyContract = new Contract(address, L2_SENDER_PROXY_ABI, l1Provider);

    // Try to call nativeRollup() - if it fails, it's not a proxy
    const nativeRollup = await proxyContract.nativeRollup();

    // Check if it's our rollup
    if (nativeRollup.toLowerCase() !== config.rollupAddress.toLowerCase()) {
      return null;
    }

    // Get the L2 address this proxy represents
    const l2Address = await proxyContract.l2Address();
    return l2Address;
  } catch {
    // Not a proxy or call failed
    return null;
  }
}

/**
 * Extract proxy call info from a trace
 */
interface ProxyCallInfo {
  proxyAddress: string;  // L2SenderProxy address on L1
  l2Address: string;     // L2 contract address
  callData: string;      // The calldata to the proxy
  l1Caller: string;      // The L1 contract that called the proxy (from field in trace)
  value: string;         // ETH value sent with the call
}

/**
 * Simulate a transaction and detect all L2SenderProxy calls
 * Uses debug_traceCall to trace all internal calls and identify proxies
 */
async function detectL2ProxyCalls(tx: Transaction): Promise<string[]> {
  const l2Addresses: string[] = [];
  const checkedAddresses = new Set<string>();

  try {
    // Use debug_traceCall to get all internal calls
    const traceResult = await l1Provider.send("debug_traceCall", [
      {
        from: tx.from,
        to: tx.to,
        data: tx.data,
        value: tx.value ? ethers.toQuantity(tx.value) : "0x0",
        gas: tx.gasLimit ? ethers.toQuantity(tx.gasLimit) : "0x1000000",
      },
      "latest",
      { tracer: "callTracer", tracerConfig: { withLog: false } },
    ]);

    // Recursively extract all called addresses from the trace
    const extractAddresses = (call: any): string[] => {
      const addresses: string[] = [];
      if (call.to) {
        addresses.push(call.to.toLowerCase());
      }
      if (call.calls) {
        for (const subcall of call.calls) {
          addresses.push(...extractAddresses(subcall));
        }
      }
      return addresses;
    };

    const allAddresses = extractAddresses(traceResult);

    // Check each unique address to see if it's an L2SenderProxy
    for (const addr of allAddresses) {
      if (checkedAddresses.has(addr)) continue;
      checkedAddresses.add(addr);

      const l2Address = await getL2AddressIfProxy(addr);
      if (l2Address) {
        l2Addresses.push(l2Address);
        log("Builder", `  Detected L2 proxy call: ${addr} → L2:${l2Address}`);
      }
    }
  } catch (err: any) {
    // debug_traceCall might not be available - fall back to direct check
    log("Builder", `  Trace failed (${err.message}), checking direct target only`);
    if (tx.to) {
      const l2Address = await getL2AddressIfProxy(tx.to);
      if (l2Address) {
        l2Addresses.push(l2Address);
      }
    }
  }

  return l2Addresses;
}

/**
 * Extract ALL proxy calls from a trace with their calldata
 * Returns them in the order they appear in the call trace
 */
async function extractProxyCallsFromTrace(traceResult: any): Promise<ProxyCallInfo[]> {
  const proxyCalls: ProxyCallInfo[] = [];

  // Recursively extract calls to L2SenderProxy contracts (in order, no dedup)
  // We don't dedupe because the same proxy+calldata may appear multiple times
  // at different state hashes (e.g., value() called before and after setValue)
  const extractCalls = async (call: any): Promise<void> => {
    if (call.to) {
      const l2Address = await getL2AddressIfProxy(call.to);
      if (l2Address && call.input) {
        proxyCalls.push({
          proxyAddress: call.to.toLowerCase(),
          l2Address,
          callData: call.input,
          l1Caller: (call.from || "").toLowerCase(),
          value: call.value || "0x0",
        });
      }
    }
    if (call.calls) {
      for (const subcall of call.calls) {
        await extractCalls(subcall);
      }
    }
  };

  await extractCalls(traceResult);
  return proxyCalls;
}

/**
 * Iteratively discover ALL L2 calls in a complex L1 transaction
 *
 * The challenge: When simulating an L1 tx that makes multiple L2 calls,
 * the trace may fail on the first unregistered L2 call, hiding subsequent calls.
 *
 * Solution: We iteratively:
 * 1. Trace the L1 tx to find the first L2 proxy call
 * 2. Simulate that L2 call and register its response
 * 3. Re-trace the L1 tx - now it proceeds further
 * 4. Repeat until no more L2 calls are discovered
 *
 * This handles complex contracts like SyncDemo that:
 * - Read L2 state (call 1)
 * - Modify L2 state via L1 contract (call 2)
 * - Read L2 state again (call 3 - at new state hash)
 */
async function discoverAndRegisterAllL2Calls(
  tx: Transaction,
  initialL2StateHash: string
): Promise<{
  l2Calls: ProxyCallInfo[];
  finalL2StateHash: string;
  registeredCount: number;
  callDetails: Array<{
    l2Address: string;
    l1Caller: string;
    selector: string;
    callData: string;
    stateHash: string;
    newStateHash: string;
    returnData: string;
    success: boolean;
    wasAlreadyRegistered: boolean;
  }>;
}> {
  const allL2Calls: ProxyCallInfo[] = [];
  const callDetails: Array<{
    l2Address: string;
    l1Caller: string;
    selector: string;
    callData: string;
    stateHash: string;
    newStateHash: string;
    returnData: string;
    success: boolean;
    wasAlreadyRegistered: boolean;
  }> = [];
  let currentL2StateHash = initialL2StateHash;
  let registeredCount = 0;
  const maxIterations = 20;  // Safety limit

  log("Builder", `  Starting iterative L2 call discovery...`);
  log("Builder", `  Initial L2 state: ${currentL2StateHash.slice(0, 18)}...`);

  // Take a fullnode L2 snapshot - we'll execute calls persistently during discovery
  // (so later calls see earlier calls' state changes) then revert at the end
  const fullnodeSnapshot = await fullnodeClient.evm_snapshot();
  log("Builder", `  Fullnode snapshot: ${fullnodeSnapshot}`);

  try {
  for (let iteration = 0; iteration < maxIterations; iteration++) {
    // Trace the L1 transaction to discover proxy calls
    let traceResult: any;
    try {
      traceResult = await l1Provider.send("debug_traceCall", [
        {
          from: tx.from,
          to: tx.to,
          data: tx.data,
          value: tx.value ? ethers.toQuantity(tx.value) : "0x0",
          gas: tx.gasLimit ? ethers.toQuantity(tx.gasLimit) : "0x1000000",
        },
        "latest",
        { tracer: "callTracer", tracerConfig: { withLog: false } },
      ]);
    } catch (err: any) {
      log("Builder", `  Trace failed: ${err.message}`);
      break;
    }

    if (traceResult.error) {
      log("Builder", `  Trace shows revert (expected during discovery)`);
    }

    // Extract ALL L2 proxy calls from trace (in execution order, no dedup)
    const proxyCalls = await extractProxyCallsFromTrace(traceResult);

    // Also extract failed calls from the trace
    const extractFailedCalls = async (call: any): Promise<ProxyCallInfo[]> => {
      const failed: ProxyCallInfo[] = [];
      if (call.error && call.to) {
        const l2Address = await getL2AddressIfProxy(call.to);
        if (l2Address && call.input) {
          failed.push({
            proxyAddress: call.to.toLowerCase(),
            l2Address,
            callData: call.input,
            l1Caller: (call.from || "").toLowerCase(),
            value: call.value || "0x0",
          });
        }
      }
      if (call.calls) {
        for (const subcall of call.calls) {
          failed.push(...await extractFailedCalls(subcall));
        }
      }
      return failed;
    };
    const failedCalls = await extractFailedCalls(traceResult);

    // Combine all proxy calls (no dedup — same call may appear at different state hashes)
    const allProxyCalls = [...proxyCalls, ...failedCalls];

    if (allProxyCalls.length === 0) {
      if (!traceResult.error) {
        log("Builder", `  Iteration ${iteration + 1}: No L2 calls, transaction succeeded`);
      } else {
        log("Builder", `  Iteration ${iteration + 1}: No L2 calls found but tx reverts`);
      }
      break;
    }

    log("Builder", `  Iteration ${iteration + 1}: Found ${allProxyCalls.length} L2 call(s)`);
    for (const c of allProxyCalls) {
      log("Builder", `    - ${c.callData.slice(0, 10)} on ${c.l2Address.slice(0, 10)}... from ${c.l1Caller.slice(0, 10)}...`);
    }

    // Walk through calls in order, tracking state hash
    // Process the FIRST unregistered call, then re-trace
    let stateHash = initialL2StateHash;
    let registeredNewCall = false;

    for (const proxyCall of allProxyCalls) {
      const responseKey = await rollupContract.getResponseKey(
        proxyCall.l2Address,
        stateHash,
        proxyCall.callData
      );
      const isRegistered = await rollupContract.incomingCallRegistered(responseKey);

      if (isRegistered) {
        // Already registered — look up the finalStateHash to advance our tracking
        const response = await rollupContract.incomingCallResponses(responseKey);
        const finalState = response.finalStateHash;
        log("Builder", `    [${proxyCall.callData.slice(0, 10)}] Already registered at ${stateHash.slice(0, 10)}... → ${finalState.slice(0, 10)}...`);
        callDetails.push({
          l2Address: proxyCall.l2Address,
          l1Caller: proxyCall.l1Caller,
          selector: proxyCall.callData.slice(0, 10),
          callData: proxyCall.callData,
          stateHash,
          newStateHash: finalState,
          returnData: response.returnValue || "0x",
          success: true,
          wasAlreadyRegistered: true,
        });
        stateHash = finalState;
        continue;
      }

      // Not registered — simulate and register
      log("Builder", `    [${proxyCall.callData.slice(0, 10)}] Simulating at ${stateHash.slice(0, 10)}... (l1Caller: ${proxyCall.l1Caller.slice(0, 10)}...)`);

      // Use executeL1ToL2Call (persistent) so later calls see this call's state changes
      // The fullnode snapshot taken before the loop will revert everything at the end
      const callValue = proxyCall.value && proxyCall.value !== "0x0" ? BigInt(proxyCall.value).toString() : "0";
      const simResult = await fullnodeClient.nativerollup_executeL1ToL2Call({
        l1Caller: proxyCall.l1Caller || tx.to!,
        l2Target: proxyCall.l2Address,
        callData: proxyCall.callData,
        value: callValue,
        currentStateRoot: stateHash,
      });

      log("Builder", `      Result: ${simResult.success ? "SUCCESS" : "FAILED"}`);
      log("Builder", `      Return: ${(simResult.returnData || "0x").slice(0, 42)}...`);
      log("Builder", `      New state: ${simResult.newStateRoot.slice(0, 18)}...`);

      const response = {
        preOutgoingCallsStateHash: simResult.newStateRoot,
        outgoingCalls: [],
        expectedResults: [],
        returnValue: simResult.returnData || "0x",
        finalStateHash: simResult.newStateRoot,
      };

      const proof = await signIncomingCallProof(
        proxyCall.l2Address,
        stateHash,
        proxyCall.callData,
        response
      );

      log("Builder", `      Registering...`);
      const registerTx = await rollupContract.registerIncomingCall(
        proxyCall.l2Address,
        stateHash,
        proxyCall.callData,
        response,
        proof
      );
      await registerTx.wait();
      log("Builder", `      Registered!`);

      callDetails.push({
        l2Address: proxyCall.l2Address,
        l1Caller: proxyCall.l1Caller,
        selector: proxyCall.callData.slice(0, 10),
        callData: proxyCall.callData,
        stateHash,
        newStateHash: simResult.newStateRoot,
        returnData: simResult.returnData || "0x",
        success: simResult.success,
        wasAlreadyRegistered: false,
      });

      allL2Calls.push(proxyCall);
      registeredCount++;
      stateHash = simResult.newStateRoot;
      registeredNewCall = true;

      // After registering a new call, re-trace to discover further calls
      // (the trace may reveal new calls now that this one is registered)
      break;
    }

    currentL2StateHash = stateHash;

    if (!registeredNewCall) {
      // All calls in the trace were already registered
      if (!traceResult.error) {
        log("Builder", `  All calls registered, transaction succeeds`);
      } else {
        log("Builder", `  All calls registered but tx still reverts — possible non-L2 issue`);
      }
      break;
    }
  }

  } finally {
    // Revert fullnode L2 state to undo all executed calls
    const reverted = await fullnodeClient.evm_revert(fullnodeSnapshot);
    log("Builder", `  Fullnode snapshot reverted: ${reverted}`);
  }

  log("Builder", `  Discovery complete: ${allL2Calls.length} L2 calls, ${registeredCount} registered`);
  log("Builder", `  Final L2 state: ${currentL2StateHash.slice(0, 18)}...`);

  // Dedupe callDetails by (stateHash, callData) — keep first occurrence only
  const seenDetailKeys = new Set<string>();
  const uniqueCallDetails = callDetails.filter(d => {
    const key = `${d.stateHash}:${d.callData}`;
    if (seenDetailKeys.has(key)) return false;
    seenDetailKeys.add(key);
    return true;
  });

  return {
    l2Calls: allL2Calls,
    finalL2StateHash: currentL2StateHash,
    registeredCount,
    callDetails: uniqueCallDetails,
  };
}

// ============ Logging ============

function log(component: string, message: string) {
  const timestamp = new Date().toISOString().split("T")[1].split(".")[0];
  console.log(`[${timestamp}] [${component}] ${message}`);
}

// ============ Fullnode RPC Client ============

/**
 * Client for interacting with the fullnode through its RPC interface.
 * This is the ONLY way the builder communicates with the fullnode.
 */
class FullnodeRpcClient {
  private endpoint: string;

  constructor(endpoint: string) {
    this.endpoint = endpoint;
  }

  private async call(method: string, params: any[] = []): Promise<any> {
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params,
      }),
    });

    const json = await response.json();
    if (json.error) {
      throw new Error(json.error.message);
    }
    return json.result;
  }

  // Standard Ethereum RPC
  async eth_blockNumber(): Promise<string> {
    return this.call("eth_blockNumber");
  }

  async eth_getBalance(address: string): Promise<string> {
    return this.call("eth_getBalance", [address, "latest"]);
  }

  async eth_getCode(address: string): Promise<string> {
    return this.call("eth_getCode", [address, "latest"]);
  }

  async eth_call(tx: { to: string; data: string; from?: string }): Promise<string> {
    return this.call("eth_call", [tx, "latest"]);
  }

  // Native Rollup RPC
  async nativerollup_getStateRoot(): Promise<string> {
    return this.call("nativerollup_getStateRoot");
  }

  async nativerollup_simulateL1ToL2Call(params: L1ToL2CallParams): Promise<SimulationResult> {
    return this.call("nativerollup_simulateL1ToL2Call", [params]);
  }

  async nativerollup_executeL1ToL2Call(params: L1ToL2CallParams): Promise<SimulationResult> {
    return this.call("nativerollup_executeL1ToL2Call", [params]);
  }

  async evm_snapshot(): Promise<string> {
    return this.call("evm_snapshot");
  }

  async evm_revert(snapshotId: string): Promise<boolean> {
    return this.call("evm_revert", [snapshotId]);
  }

  async nativerollup_verifyStateChain(params: any): Promise<any> {
    return this.call("nativerollup_verifyStateChain", [params]);
  }

  async nativerollup_executeL2Transaction(rawTx: string): Promise<{
    success: boolean;
    txHash: string;
    returnData: string;
    newStateRoot: string;
    gasUsed: bigint;
    error?: string;
  }> {
    return this.call("nativerollup_executeL2Transaction", [rawTx]);
  }

  async nativerollup_getL1SenderProxyL2(l1Address: string): Promise<string> {
    return this.call("nativerollup_getL1SenderProxyL2", [l1Address]);
  }

  async nativerollup_isL1SenderProxyL2Deployed(l1Address: string): Promise<boolean> {
    return this.call("nativerollup_isL1SenderProxyL2Deployed", [l1Address]);
  }
}

let fullnodeClient: FullnodeRpcClient;

// ============ Proof Signing ============

async function signProof(
  prevHash: string,
  callData: string,
  postExecutionStateHash: string,
  outgoingCalls: any[],
  expectedResults: string[],
  finalStateHash: string
): Promise<string> {
  const messageHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "bytes32", "bytes32", "bytes32", "bytes32", "bytes32"],
      [
        prevHash,
        ethers.keccak256(callData),
        postExecutionStateHash,
        hashOutgoingCalls(outgoingCalls),
        hashResults(expectedResults),
        finalStateHash,
      ]
    )
  );

  return adminWallet.signMessage(ethers.getBytes(messageHash));
}

function hashOutgoingCalls(calls: any[]): string {
  let encoded = "0x";
  for (const c of calls) {
    const callEncoded = ethers.solidityPacked(
      ["address", "address", "uint256", "uint256", "bytes32", "bytes32"],
      [c.from, c.target, c.value, c.gas, ethers.keccak256(c.data), c.postCallStateHash]
    );
    encoded = ethers.concat([encoded, callEncoded]);
  }
  return ethers.keccak256(encoded);
}

function hashResults(results: string[]): string {
  let encoded = "0x";
  for (const r of results) {
    encoded = ethers.concat([encoded, ethers.keccak256(r)]);
  }
  return ethers.keccak256(encoded);
}

async function signIncomingCallProof(
  l2Address: string,
  stateHash: string,
  callData: string,
  response: any
): Promise<string> {
  const messageHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "bytes32", "bytes32", "bytes32", "bytes32", "bytes32", "bytes32", "bytes32"],
      [
        l2Address,
        stateHash,
        ethers.keccak256(callData),
        response.preOutgoingCallsStateHash,
        hashOutgoingCalls(response.outgoingCalls),
        hashResults(response.expectedResults),
        ethers.keccak256(response.returnValue),
        response.finalStateHash,
      ]
    )
  );

  return adminWallet.signMessage(ethers.getBytes(messageHash));
}

// ============ Transaction Processing ============

interface SubmitRequest {
  signedTx: string;
  sourceChain: "L1" | "L2";
  hints?: {
    l2TargetAddress?: string;
    expectedReturnValue?: string;
    isContractCall?: boolean;
    l2Addresses?: string[];
  };
}

/**
 * Process an L2 transaction
 */
async function processL2Transaction(signedTx: string): Promise<{
  l1TxHash: string;
  l2TxHash: string;
  l2StateRoot: string;
}> {
  const tx = Transaction.from(signedTx);

  log("Builder", `Processing L2 transaction:`);
  log("Builder", `  From: ${tx.from}`);
  log("Builder", `  To: ${tx.to || "(deploy)"}`);
  log("Builder", `  Value: ${ethers.formatEther(tx.value)} ETH`);

  // Get current L2 state from L1
  const prevHash = await rollupContract.l2BlockHash();
  log("Builder", `  Current L2 hash: ${prevHash}`);

  // Verify fullnode is synced
  const fullnodeState = await fullnodeClient.nativerollup_getStateRoot();
  if (fullnodeState.toLowerCase() !== prevHash.toLowerCase()) {
    throw new Error(`Fullnode not synced! L1: ${prevHash}, Fullnode: ${fullnodeState}`);
  }

  // Execute on fullnode to get the new state root
  log("Builder", `  Executing on fullnode...`);
  const execResult = await fullnodeClient.nativerollup_executeL2Transaction(signedTx);

  if (!execResult.success) {
    throw new Error(`L2 execution failed: ${execResult.error || "unknown error"}`);
  }

  log("Builder", `  L2 tx executed: ${execResult.txHash}`);
  log("Builder", `  New state root: ${execResult.newStateRoot}`);

  const newStateRoot = execResult.newStateRoot;

  // Sign the proof with the correct state roots
  const proof = await signProof(prevHash, signedTx, newStateRoot, [], [], newStateRoot);

  // Submit to L1
  log("Builder", `Submitting to L1...`);
  const l1Tx = await rollupContract.processSingleTxOnL2(
    prevHash,
    signedTx,
    newStateRoot,  // preOutgoingCallsStateHash
    [],
    [],
    newStateRoot,  // finalStateHash
    proof
  );
  const l1Receipt = await l1Tx.wait();

  log("Builder", `  L1 tx: ${l1Receipt?.hash}`);

  return {
    l1TxHash: l1Receipt?.hash || "",
    l2TxHash: execResult.txHash,
    l2StateRoot: newStateRoot,
  };
}

/**
 * Process an L1 contract call that may trigger L2 calls
 *
 * This is the key function. When an L1 contract calls an L2 contract:
 * 1. We iteratively discover ALL L2 calls via simulation
 * 2. We register each incoming call response on L1
 * 3. We broadcast the user's L1 tx
 *
 * The iterative approach handles complex scenarios where:
 * - A contract makes multiple L2 calls
 * - Later L2 calls depend on state changes from earlier calls
 * - The state hash changes between calls
 */
async function processL1ContractCall(
  signedTx: string,
  l2Addresses?: string[]
): Promise<{
  l1TxHash: string;
  detectedL2Calls: number;
  l2StateRoot: string;
}> {
  const tx = Transaction.from(signedTx);

  log("Builder", `Processing L1 contract call:`);
  log("Builder", `  From: ${tx.from}`);
  log("Builder", `  To: ${tx.to}`);
  log("Builder", `  Value: ${ethers.formatEther(tx.value)} ETH`);
  log("Builder", `  Nonce: ${tx.nonce}`);

  // Validate nonce
  const currentNonce = await l1Provider.getTransactionCount(tx.from!, "latest");
  if (tx.nonce !== currentNonce) {
    const msg = `Nonce mismatch: tx nonce=${tx.nonce}, expected=${currentNonce}. ${tx.nonce < currentNonce ? 'Nonce too low - tx already used.' : 'Nonce too high - previous tx missing.'}`;
    throw new Error(msg);
  }

  // Get current L2 state from L1
  const currentL2Hash = await rollupContract.l2BlockHash();
  log("Builder", `  Current L2 hash: ${currentL2Hash}`);

  // Verify fullnode is synced
  const fullnodeState = await fullnodeClient.nativerollup_getStateRoot();
  if (fullnodeState.toLowerCase() !== currentL2Hash.toLowerCase()) {
    throw new Error(`Fullnode not synced! L1: ${currentL2Hash}, Fullnode: ${fullnodeState}`);
  }

  // Deploy L2SenderProxy on L1 for each known L2 address (if needed)
  if (l2Addresses && l2Addresses.length > 0) {
    await ensureL2SenderProxiesDeployed(l2Addresses);
  }

  // Use iterative discovery to find and register ALL L2 calls
  // This handles complex multi-call scenarios like SyncDemo
  const discovery = await discoverAndRegisterAllL2Calls(tx, currentL2Hash);

  // === Pre-broadcast verification ===
  // Verify all preconditions are met before broadcasting the user's tx.
  // This catches issues like missing proxy deployments, unregistered calls,
  // or stale state that would cause the tx to revert.

  // 1. Verify proxy is deployed (if tx targets a proxy)
  if (l2Addresses && l2Addresses.length > 0) {
    for (const l2Addr of l2Addresses) {
      const isDeployed = await rollupContract.isProxyDeployed(l2Addr);
      if (!isDeployed) {
        throw new Error(`Pre-broadcast check failed: proxy for ${l2Addr} not deployed`);
      }
      const proxyAddr = await rollupContract.getProxyAddress(l2Addr);
      const code = await l1Provider.getCode(proxyAddr);
      if (code === "0x") {
        throw new Error(`Pre-broadcast check failed: proxy ${proxyAddr} has no code`);
      }
    }
    log("Builder", `  Pre-check: all proxies deployed`);
  }

  // 2. Verify all discovered L2 calls are registered
  {
    for (const detail of discovery.callDetails) {
      const responseKey = await rollupContract.getResponseKey(
        detail.l2Address,
        detail.stateHash,
        detail.callData
      );
      const isRegistered = await rollupContract.incomingCallRegistered(responseKey);
      if (!isRegistered) {
        throw new Error(`Pre-broadcast check failed: call ${detail.selector} at state ${detail.stateHash.slice(0, 14)}... not registered`);
      }
    }
    log("Builder", `  Pre-check: all ${discovery.callDetails.length} L2 call(s) registered`);
  }

  // 3. Dry-run the user's tx via eth_call to verify it would succeed
  try {
    await l1Provider.call({
      from: tx.from,
      to: tx.to,
      data: tx.data,
      value: tx.value,
    });
    log("Builder", `  Pre-check: eth_call dry-run succeeded`);
  } catch (dryRunErr: any) {
    const reason = dryRunErr.message || "unknown";
    throw new Error(`Pre-broadcast check failed: dry-run reverted: ${reason}`);
  }

  // === Broadcast ===
  log("Builder", `Broadcasting L1 tx...`);
  const l1TxHash = await l1Provider.send("eth_sendRawTransaction", [signedTx]);
  await l1Provider.send("anvil_mine", [1, 0]);

  // Wait for receipt with timeout (30s)
  const l1Receipt = await Promise.race([
    l1Provider.waitForTransaction(l1TxHash),
    new Promise<null>((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout waiting for tx ${l1TxHash} after 30s`)), 30000)
    ),
  ]);

  if (!l1Receipt || l1Receipt.status !== 1) {
    // Get the revert reason if possible
    try {
      await l1Provider.call({
        from: tx.from,
        to: tx.to,
        data: tx.data,
        value: tx.value,
      });
    } catch (callErr: any) {
      log("Builder", `  Revert reason: ${callErr.message}`);
    }
    throw new Error("L1 transaction reverted");
  }

  log("Builder", `  SUCCESS`);

  return {
    l1TxHash: l1Receipt?.hash || l1TxHash,
    detectedL2Calls: discovery.l2Calls.length,
    l2StateRoot: discovery.finalL2StateHash,
  };
}

/**
 * Ensure L2SenderProxy is deployed on L1 for each L2 address
 */
async function ensureL2SenderProxiesDeployed(l2Addresses: string[]): Promise<void> {
  for (const l2Address of l2Addresses) {
    const isDeployed = await rollupContract.isProxyDeployed(l2Address);

    if (!isDeployed) {
      log("Builder", `  Deploying L2SenderProxy for ${l2Address}...`);
      const tx = await rollupContract.deployProxy(l2Address);
      await tx.wait();
      const proxyAddress = await rollupContract.getProxyAddress(l2Address);
      log("Builder", `    Deployed at: ${proxyAddress}`);
    }
  }
}

// ============ HTTP Server ============

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url || "/", `http://${req.headers.host}`);

  try {
    if (url.pathname === "/status" && req.method === "GET") {
      const [l2BlockHash, l2BlockNumber, fullnodeState] = await Promise.all([
        rollupContract.l2BlockHash(),
        rollupContract.l2BlockNumber(),
        fullnodeClient.nativerollup_getStateRoot(),
      ]);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        l2BlockNumber: l2BlockNumber.toString(),
        l2BlockHash,
        fullnodeStateRoot: fullnodeState,
        rollupAddress: config.rollupAddress,
        isSynced: l2BlockHash.toLowerCase() === fullnodeState.toLowerCase(),
      }));
      return;
    }

    if (url.pathname === "/submit" && req.method === "POST") {
      const body = await new Promise<string>((resolve) => {
        let data = "";
        req.on("data", (chunk) => (data += chunk));
        req.on("end", () => resolve(data));
      });

      const request: SubmitRequest = JSON.parse(body);
      log("API", `Received ${request.sourceChain} transaction`);

      let result: any;

      if (request.sourceChain === "L2") {
        result = await processL2Transaction(request.signedTx);
      } else if (request.hints?.l2Addresses) {
        result = await processL1ContractCall(request.signedTx, request.hints.l2Addresses);
      } else if (request.hints?.l2TargetAddress) {
        // Direct L1→L2 transfer/call to a proxy address
        // The tx targets the L2 proxy on L1 — treat it as an L1 contract call with the L2 target
        log("Builder", `Hint: L2 target address ${request.hints.l2TargetAddress}`);
        result = await processL1ContractCall(request.signedTx, [request.hints.l2TargetAddress]);
      } else {
        // Simulate transaction to detect any L2 proxy calls (direct or nested)
        const tx = Transaction.from(request.signedTx);

        log("Builder", `Analyzing transaction:`);
        log("Builder", `  From: ${tx.from}`);
        log("Builder", `  To: ${tx.to}`);
        log("Builder", `  Value: ${ethers.formatEther(tx.value)} ETH`);
        log("Builder", `  Nonce: ${tx.nonce}`);

        // Validate nonce before doing anything
        const currentNonce = await l1Provider.getTransactionCount(tx.from!, "latest");
        if (tx.nonce !== currentNonce) {
          const msg = `Nonce mismatch: tx nonce=${tx.nonce}, expected=${currentNonce}. ${tx.nonce < currentNonce ? 'Nonce too low - tx already used.' : 'Nonce too high - previous tx missing.'}`;
          log("Builder", `  ERROR: ${msg}`);
          throw new Error(msg);
        }

        // First, do a quick check if any known L2 proxies are called
        const detectedL2Addresses = await detectL2ProxyCalls(tx);

        if (detectedL2Addresses.length > 0) {
          // Transaction calls L2 proxies - use iterative discovery
          log("Builder", `Detected ${detectedL2Addresses.length} L2 proxy call(s) - using iterative discovery`);
          result = await processL1ContractCall(request.signedTx, detectedL2Addresses);
        } else {
          // No proxies detected in simple trace - process as simple L1 tx
          log("Builder", `No L2 calls detected - broadcasting as simple L1 tx`);

          try {
            const txHash = await l1Provider.send("eth_sendRawTransaction", [request.signedTx]);
            log("Builder", `  TX submitted: ${txHash}`);

            // Mine block to include the transaction
            // Use anvil_mine which is more reliable for including pending txs
            await l1Provider.send("anvil_mine", [1, 0]);
            log("Builder", `  Block mined`);

            // Check if tx was included by getting the receipt directly
            const receipt = await l1Provider.getTransactionReceipt(txHash);

            if (receipt) {
              log("Builder", `  Status: ${receipt.status === 1 ? "SUCCESS" : "REVERTED"}`);
              result = { l1TxHash: receipt.hash, status: receipt.status };
            } else {
              // Transaction not included - check if it's still pending
              const pendingTx = await l1Provider.getTransaction(txHash);
              if (pendingTx && pendingTx.blockNumber === null) {
                // TX is pending but not mined - try mining again
                log("Builder", `  TX pending, mining additional block...`);
                await l1Provider.send("anvil_mine", [1, 0]);
                const retryReceipt = await l1Provider.getTransactionReceipt(txHash);
                if (retryReceipt) {
                  log("Builder", `  Status: ${retryReceipt.status === 1 ? "SUCCESS" : "REVERTED"}`);
                  result = { l1TxHash: retryReceipt.hash, status: retryReceipt.status };
                } else {
                  // Check nonce - if it's ahead of account nonce, that's the issue
                  const currentNonce = await l1Provider.getTransactionCount(pendingTx.from);
                  throw new Error(`Transaction not mined. TX nonce: ${pendingTx.nonce}, Account nonce: ${currentNonce}. Reset your wallet nonce.`);
                }
              } else {
                throw new Error("Transaction disappeared from mempool");
              }
            }
          } catch (err: any) {
            log("Builder", `  Error: ${err.message}`);
            throw err;
          }
        }
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
      return;
    }

    if (url.pathname === "/simulate" && req.method === "POST") {
      const body = await new Promise<string>((resolve) => {
        let data = "";
        req.on("data", (chunk) => (data += chunk));
        req.on("end", () => resolve(data));
      });

      const request: SubmitRequest = JSON.parse(body);
      log("API", `Received simulation request`);

      // Take L1 snapshot so all registrations are reverted afterwards
      const l1Snapshot = await l1Provider.send("evm_snapshot", []);

      try {
        const tx = Transaction.from(request.signedTx);
        log("Builder", `[Simulate] Analyzing transaction:`);
        log("Builder", `  From: ${tx.from}`);
        log("Builder", `  To: ${tx.to}`);
        log("Builder", `  Value: ${ethers.formatEther(tx.value)} ETH`);

        // Get current L2 state
        const currentL2Hash = await rollupContract.l2BlockHash();
        log("Builder", `  Current L2 hash: ${currentL2Hash}`);

        // Ensure proxies deployed
        const detectedL2Addresses = await detectL2ProxyCalls(tx);
        if (request.hints?.l2Addresses) {
          for (const addr of request.hints.l2Addresses) {
            if (!detectedL2Addresses.includes(addr)) detectedL2Addresses.push(addr);
          }
        }
        if (detectedL2Addresses.length > 0) {
          await ensureL2SenderProxiesDeployed(detectedL2Addresses);
        }

        // Run iterative discovery (registrations happen on L1 but will be reverted)
        const discovery = await discoverAndRegisterAllL2Calls(tx, currentL2Hash);

        // Now simulate the final L1 tx via eth_call
        let txSuccess = false;
        let txError = "";
        let txReturnData = "0x";
        try {
          txReturnData = await l1Provider.send("eth_call", [{
            from: tx.from,
            to: tx.to,
            data: tx.data,
            value: tx.value ? ethers.toQuantity(tx.value) : "0x0",
            gas: tx.gasLimit ? ethers.toQuantity(tx.gasLimit) : "0x1000000",
          }, "latest"]);
          txSuccess = true;
        } catch (callErr: any) {
          txError = callErr.message;
        }

        log("Builder", `[Simulate] Result: ${txSuccess ? "SUCCESS" : "REVERTED"}`);
        if (txError) log("Builder", `[Simulate] Error: ${txError}`);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          simulation: true,
          txWouldSucceed: txSuccess,
          txError: txError || undefined,
          txReturnData: txSuccess ? txReturnData : undefined,
          l2CallsDiscovered: discovery.l2Calls.length,
          l2CallsRegistered: discovery.registeredCount,
          callDetails: discovery.callDetails,
          finalL2StateHash: discovery.finalL2StateHash,
        }));
      } finally {
        // Revert L1 to undo all registrations
        await l1Provider.send("evm_revert", [l1Snapshot]);
        log("Builder", `[Simulate] L1 state reverted`);
      }
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  } catch (err: any) {
    log("API", `Error: ${err.message}`);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message }));
  }
}

// ============ Main ============

async function main() {
  config = parseArgs();

  if (!config.rollupAddress) {
    console.error("Error: --rollup <address> required");
    process.exit(1);
  }

  log("Builder", "=== Builder ===");
  log("Builder", `L1 RPC: ${config.l1Rpc}`);
  log("Builder", `Fullnode RPC: ${config.fullnodeRpc}`);
  log("Builder", `Rollup: ${config.rollupAddress}`);

  // Initialize providers
  l1Provider = new JsonRpcProvider(config.l1Rpc);
  fullnodeClient = new FullnodeRpcClient(config.fullnodeRpc);

  // Initialize admin wallet
  adminWallet = new Wallet(config.adminPrivateKey, l1Provider);
  log("Builder", `Admin: ${adminWallet.address}`);

  // Initialize rollup contract
  rollupContract = new Contract(config.rollupAddress, ROLLUP_ABI, adminWallet);

  // Verify connections
  try {
    const l1Block = await l1Provider.getBlockNumber();
    log("Builder", `L1 block: ${l1Block}`);
  } catch (err: any) {
    log("Builder", `WARNING: L1 connection failed: ${err.message}`);
  }

  try {
    const fullnodeState = await fullnodeClient.nativerollup_getStateRoot();
    log("Builder", `Fullnode state: ${fullnodeState.slice(0, 18)}...`);
  } catch (err: any) {
    log("Builder", `WARNING: Fullnode connection failed: ${err.message}`);
  }

  // Check sync status
  try {
    const l2BlockHash = await rollupContract.l2BlockHash();
    const fullnodeState = await fullnodeClient.nativerollup_getStateRoot();
    const isSynced = l2BlockHash.toLowerCase() === fullnodeState.toLowerCase();
    log("Builder", `Sync: ${isSynced ? "YES" : "NO"}`);
  } catch (err: any) {
    log("Builder", `Sync check failed: ${err.message}`);
  }

  // Start HTTP server
  const server = http.createServer(handleRequest);
  server.listen(config.port, () => {
    log("Builder", `API: http://localhost:${config.port}`);
    log("Builder", "");
    log("Builder", "Endpoints:");
    log("Builder", `  POST /submit`);
    log("Builder", `  POST /simulate`);
    log("Builder", `  GET  /status`);
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
