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
} from "../l2fullnode/fullnode-rpc-interface";

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
let isAnvilL1 = false; // Detected at startup; enables anvil_mine, evm_snapshot etc.

/**
 * Mine a block on L1 if running on Anvil, otherwise no-op (real chain mines itself).
 */
async function mineL1Block(): Promise<void> {
  if (isAnvilL1) {
    await l1Provider.send("anvil_mine", [1, 0]);
  }
}

/**
 * Wait for an L1 transaction receipt, polling if needed.
 * On Anvil we mine first; on real chains we just wait.
 */
async function waitForL1Receipt(txHash: string, maxWaitMs = 120_000): Promise<any> {
  await mineL1Block();

  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const receipt = await l1Provider.getTransactionReceipt(txHash);
    if (receipt) return receipt;
    await new Promise(r => setTimeout(r, isAnvilL1 ? 500 : 3000));
  }
  throw new Error(`Timeout waiting for L1 tx receipt: ${txHash}`);
}
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
    // Filter out calls FROM the NativeRollupCore itself — these are internal calls
    // within handleIncomingCall, not user-initiated L1→L2 proxy calls
    const rollupLower = config.rollupAddress.toLowerCase();
    const allProxyCalls = [...proxyCalls, ...failedCalls].filter(
      c => c.l1Caller.toLowerCase() !== rollupLower
    );

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

      const callValue = proxyCall.value && proxyCall.value !== "0x0" ? BigInt(proxyCall.value).toString() : "0";
      const l1Caller = proxyCall.l1Caller || tx.to!;

      // Check for outgoing L2→L1 calls within this L1→L2 call
      const outgoingL2Calls = await fullnodeClient.nativerollup_detectOutgoingCallsFromL1ToL2Call({
        l1Caller,
        l2Target: proxyCall.l2Address,
        callData: proxyCall.callData,
        value: callValue,
      });

      let simResult: any;
      const responseOutgoingCalls: Array<{ from: string; target: string; value: string; gas: string; data: string; postCallStateHash: string }> = [];
      const responseExpectedResults: string[] = [];

      if (outgoingL2Calls.length > 0) {
        log("Builder", `      Found ${outgoingL2Calls.length} outgoing L2→L1 call(s) within L1→L2 call`);

        // Simulate each outgoing call on L1 to get expected results
        const outgoingCallsForFullnode: Array<{ from: string; target: string; data: string }> = [];
        const outgoingCallResults: string[] = [];

        for (const oc of outgoingL2Calls) {
          log("Builder", `      Simulating L1 call: ${oc.l2Caller} → L1:${oc.l1Address}`);
          log("Builder", `        Calldata: ${oc.callData.slice(0, 10)}...`);

          // Ensure L2SenderProxy exists on L1 for the L2 caller
          const isDeployed = await rollupContract.isProxyDeployed(oc.l2Caller);
          if (!isDeployed) {
            log("Builder", `        Deploying L2SenderProxy on L1 for ${oc.l2Caller}...`);
            const deployTx = await rollupContract.deployProxy(oc.l2Caller);
            await deployTx.wait();
          }
          const l2SenderProxy = await rollupContract.getProxyAddress(oc.l2Caller);
          log("Builder", `        L2SenderProxy on L1: ${l2SenderProxy}`);

          // Simulate the L1 call via eth_call (from L2SenderProxy)
          let l1Result = "0x";
          try {
            l1Result = await l1Provider.send("eth_call", [{
              from: l2SenderProxy,
              to: oc.l1Address,
              data: oc.callData,
            }, "latest"]);
            log("Builder", `        L1 result: ${l1Result.slice(0, 42)}${l1Result.length > 42 ? '...' : ''}`);
          } catch (err: any) {
            log("Builder", `        L1 simulation failed: ${err.message}`);
          }

          outgoingCallsForFullnode.push({
            from: oc.l2Caller,
            target: oc.l1Address,
            data: oc.callData,
          });
          outgoingCallResults.push(l1Result);

          // For the L1 registerIncomingCall response
          responseOutgoingCalls.push({
            from: oc.l2Caller,
            target: oc.l1Address,
            value: "0",
            gas: "100000",
            data: oc.callData,
            postCallStateHash: ethers.ZeroHash, // Will be filled after execution
          });
          responseExpectedResults.push(l1Result);
        }

        // Execute on builder fullnode with pre-registered outgoing call results
        simResult = await fullnodeClient.nativerollup_executeL1ToL2CallWithOutgoingCalls(
          { l1Caller, l2Target: proxyCall.l2Address, callData: proxyCall.callData, value: callValue, currentStateRoot: stateHash },
          outgoingCallsForFullnode,
          outgoingCallResults
        );
      } else {
        // No outgoing calls — simple L1→L2 call
        simResult = await fullnodeClient.nativerollup_executeL1ToL2Call({
          l1Caller,
          l2Target: proxyCall.l2Address,
          callData: proxyCall.callData,
          value: callValue,
          currentStateRoot: stateHash,
        });
      }

      log("Builder", `      Result: ${simResult.success ? "SUCCESS" : "FAILED"}`);
      log("Builder", `      Return: ${(simResult.returnData || "0x").slice(0, 42)}...`);
      log("Builder", `      New state: ${simResult.newStateRoot.slice(0, 18)}...`);

      // Fill in postCallStateHash for outgoing calls (use the final state for now)
      for (const oc of responseOutgoingCalls) {
        oc.postCallStateHash = simResult.newStateRoot;
      }

      const response = {
        preOutgoingCallsStateHash: simResult.newStateRoot,
        outgoingCalls: responseOutgoingCalls,
        expectedResults: responseExpectedResults,
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

  async nativerollup_ensureL1SenderProxyL2(l1Address: string): Promise<string> {
    return this.call("nativerollup_ensureL1SenderProxyL2", [l1Address]);
  }

  async nativerollup_detectL2OutgoingCalls(rawTx: string, l1Addresses?: string[]): Promise<Array<{
    l2Caller: string;
    proxyAddress: string;
    l1Address: string;
    callData: string;
    value: string; // hex-encoded value
  }>> {
    return this.call("nativerollup_detectL2OutgoingCalls", [rawTx, l1Addresses || []]);
  }

  async nativerollup_detectOutgoingCallsFromL1ToL2Call(params: {
    l1Caller: string;
    l2Target: string;
    callData: string;
    value?: string;
  }): Promise<Array<{
    l2Caller: string;
    proxyAddress: string;
    l1Address: string;
    callData: string;
  }>> {
    return this.call("nativerollup_detectOutgoingCallsFromL1ToL2Call", [params]);
  }

  async nativerollup_executeL1ToL2CallWithOutgoingCalls(
    params: { l1Caller: string; l2Target: string; callData: string; value?: string; currentStateRoot?: string },
    outgoingCalls: Array<{ from: string; target: string; data: string }>,
    outgoingCallResults: string[]
  ): Promise<{
    success: boolean;
    txHash: string;
    returnData: string;
    newStateRoot: string;
    gasUsed: string;
    error?: string;
  }> {
    return this.call("nativerollup_executeL1ToL2CallWithOutgoingCalls", [params, outgoingCalls, outgoingCallResults]);
  }

  async nativerollup_registerL2OutgoingCallResult(params: {
    l1Address: string;
    l2Caller: string;
    callData: string;
    returnData: string;
  }): Promise<{ callKey: string; txHash: string }> {
    return this.call("nativerollup_registerL2OutgoingCallResult", [params]);
  }

  async nativerollup_executeL2TransactionWithOutgoingCalls(
    rawTx: string,
    outgoingCalls: Array<{ from: string; target: string; data: string }>,
    outgoingCallResults: string[]
  ): Promise<{
    success: boolean;
    txHash: string;
    returnData: string;
    newStateRoot: string;
    gasUsed: string;
    error?: string;
  }> {
    return this.call("nativerollup_executeL2TransactionWithOutgoingCalls", [rawTx, outgoingCalls, outgoingCallResults]);
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
    l1TargetAddress?: string;
    expectedReturnValue?: string;
    isContractCall?: boolean;
    l2Addresses?: string[];
  };
}

/**
 * Process an L2 transaction (may include L2→L1 outgoing calls)
 *
 * Flow:
 * 1. Detect outgoing L2→L1 calls by tracing the L2 tx
 * 2. For each outgoing call, simulate the L1 call to get the return value
 * 3. Pre-register return values on builder's L2 fullnode
 * 4. Execute the L2 tx on builder's fullnode (outgoing calls now succeed via registry)
 * 5. Submit processSingleTxOnL2 to L1 with outgoingCalls[] and expectedResults[]
 * 6. L1 executes the actual outgoing calls, verifies results match
 */
async function processL2Transaction(signedTx: string, hints?: { l1TargetAddress?: string }): Promise<{
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

  // Step 1: Detect outgoing L2→L1 calls
  // Pass L1 target address hint so the detection can temporarily deploy the proxy for tracing
  const l1Addresses = hints?.l1TargetAddress ? [hints.l1TargetAddress] : [];
  log("Builder", `  Detecting outgoing L2→L1 calls...${l1Addresses.length ? ` (hint: L1 target ${l1Addresses[0]})` : ""}`);
  const detectedOutgoingCalls = await fullnodeClient.nativerollup_detectL2OutgoingCalls(signedTx, l1Addresses);

  if (detectedOutgoingCalls.length === 0) {
    // Simple case: no outgoing calls
    log("Builder", `  No outgoing calls detected — simple L2 tx`);
    return processSimpleL2Transaction(signedTx, prevHash);
  }

  log("Builder", `  Detected ${detectedOutgoingCalls.length} outgoing L2→L1 call(s):`);
  for (const c of detectedOutgoingCalls) {
    const valStr = c.value && c.value !== "0x0" ? ` value=${ethers.formatEther(BigInt(c.value))}` : "";
    log("Builder", `    ${c.l2Caller} → L1:${c.l1Address} (${c.callData.slice(0, 10)})${valStr}`);
  }

  // Step 2: For each outgoing call, simulate the L1 call to get the return value
  // The L1 call is made through L2SenderProxy on L1 (the proxy for the L2 caller)
  const outgoingCalls: Array<{
    from: string;       // L2 contract
    target: string;     // L1 contract
    value: bigint;
    gas: bigint;
    data: string;       // Calldata for L1 function
    postCallStateHash: string;
  }> = [];
  const expectedResults: string[] = [];

  for (const call of detectedOutgoingCalls) {
    log("Builder", `  Simulating L1 call: ${call.l2Caller} → ${call.l1Address}`);
    log("Builder", `    Calldata: ${call.callData}`);

    // Ensure L2SenderProxy is deployed on L1 for this L2 caller
    const isDeployed = await rollupContract.isProxyDeployed(call.l2Caller);
    if (!isDeployed) {
      log("Builder", `    Deploying L2SenderProxy for ${call.l2Caller}...`);
      const deployTx = await rollupContract.deployProxy(call.l2Caller);
      await deployTx.wait();
      const proxyAddr = await rollupContract.getProxyAddress(call.l2Caller);
      log("Builder", `    Deployed at: ${proxyAddr}`);
    }

    // Get the L2SenderProxy address on L1
    const l2SenderProxyOnL1 = await rollupContract.getProxyAddress(call.l2Caller);
    log("Builder", `    L2SenderProxy on L1: ${l2SenderProxyOnL1}`);

    // Simulate the L1 call through the L2SenderProxy
    // The L2SenderProxy.execute(target, data) makes the actual L1 call
    // But during processSingleTxOnL2, the NativeRollupCore calls execute() directly
    // So we simulate: L2SenderProxy → target.call{value}(data)
    const callValue = call.value ? BigInt(call.value) : 0n;

    // Check if target is an EOA (no code) — for value-only transfers, result is always 0x
    const targetCode = await l1Provider.getCode(call.l1Address);
    const isEOA = !targetCode || targetCode === "0x";

    if (isEOA) {
      log("Builder", `    L1 target is EOA — expected result: 0x (value transfer: ${ethers.formatEther(callValue)} ETH)`);
      expectedResults.push("0x");
    } else {
      try {
        const l1Result = await l1Provider.call({
          to: call.l1Address,
          data: call.callData,
          from: l2SenderProxyOnL1, // msg.sender will be the L2SenderProxy
          value: callValue,
        });
        log("Builder", `    L1 simulation result: ${l1Result.slice(0, 42)}${l1Result.length > 42 ? '...' : ''}`);

        expectedResults.push(l1Result);
      } catch (err: any) {
        log("Builder", `    L1 simulation failed: ${err.message}`);
        throw new Error(`Outgoing L1 call simulation failed for ${call.l1Address}: ${err.message}`);
      }
    }
  }

  // Step 3: Pre-register return values on builder's L2 fullnode
  // and execute the L2 tx with outgoing calls
  log("Builder", `  Executing L2 tx with outgoing calls on builder fullnode...`);

  const outgoingCallsForFullnode = detectedOutgoingCalls.map(c => ({
    from: c.l2Caller,
    target: c.l1Address,
    data: c.callData,
  }));

  const execResult = await fullnodeClient.nativerollup_executeL2TransactionWithOutgoingCalls(
    signedTx,
    outgoingCallsForFullnode,
    expectedResults
  );

  if (!execResult.success) {
    throw new Error(`L2 execution with outgoing calls failed: ${execResult.error || "unknown error"}`);
  }

  log("Builder", `  L2 tx executed: ${execResult.txHash}`);
  log("Builder", `  New state root (preOutgoingCallsStateHash): ${execResult.newStateRoot}`);

  const preOutgoingCallsStateHash = execResult.newStateRoot;

  // Step 4: Build outgoing call structs for L1 submission
  // For each outgoing call, the postCallStateHash is the L2 state after that L1 call.
  // In this POC, L1 calls don't modify L2 state (no re-entrant L1→L2 calls during outgoing),
  // so postCallStateHash = preOutgoingCallsStateHash for all calls.
  // In the general case, each L1 call might trigger an incoming L2 call,
  // changing the L2 state.
  for (let i = 0; i < detectedOutgoingCalls.length; i++) {
    const call = detectedOutgoingCalls[i];
    const callValue = call.value ? BigInt(call.value) : 0n;
    outgoingCalls.push({
      from: call.l2Caller,
      target: call.l1Address,
      value: callValue,
      gas: 500000n, // Gas limit for L1 call
      data: call.callData,
      postCallStateHash: preOutgoingCallsStateHash, // Same state — L1 call doesn't modify L2
    });
  }

  // finalStateHash = preOutgoingCallsStateHash since no L2 state changes from L1 calls
  const finalStateHash = preOutgoingCallsStateHash;

  // Step 5: Sign proof and submit to L1
  const proof = await signProof(
    prevHash,
    signedTx,
    preOutgoingCallsStateHash,
    outgoingCalls.map(c => ({
      from: c.from,
      target: c.target,
      value: c.value,
      gas: c.gas,
      data: c.data,
      postCallStateHash: c.postCallStateHash,
    })),
    expectedResults,
    finalStateHash
  );

  // Calculate total value needed for outgoing calls
  const totalOutgoingValue = outgoingCalls.reduce((sum, c) => sum + c.value, 0n);
  log("Builder", `Submitting to L1 (with ${outgoingCalls.length} outgoing calls, total value: ${ethers.formatEther(totalOutgoingValue)})...`);
  const l1Tx = await rollupContract.processSingleTxOnL2(
    prevHash,
    signedTx,
    preOutgoingCallsStateHash,
    outgoingCalls,
    expectedResults,
    finalStateHash,
    proof,
    { value: totalOutgoingValue }
  );
  const l1Receipt = await l1Tx.wait();

  if (!l1Receipt || l1Receipt.status !== 1) {
    throw new Error("L1 transaction with outgoing calls reverted");
  }

  log("Builder", `  L1 tx: ${l1Receipt?.hash}`);
  log("Builder", `  SUCCESS — L2 tx with ${outgoingCalls.length} outgoing L1 call(s) processed`);

  return {
    l1TxHash: l1Receipt?.hash || "",
    l2TxHash: execResult.txHash,
    l2StateRoot: finalStateHash,
  };
}

/**
 * Process a simple L2 transaction (no outgoing calls)
 */
async function processSimpleL2Transaction(signedTx: string, prevHash: string): Promise<{
  l1TxHash: string;
  l2TxHash: string;
  l2StateRoot: string;
}> {
  // Execute on fullnode to get the new state root
  log("Builder", `  Executing on fullnode...`);
  const execResult = await fullnodeClient.nativerollup_executeL2Transaction(signedTx);

  if (!execResult.success) {
    const tx = Transaction.from(signedTx);
    throw new Error(`L2 execution reverted (from: ${tx.from}, to: ${tx.to}, data: ${tx.data?.slice(0, 10) || '0x'}). ${execResult.error || ''}`);
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
  // Skip dry-run for txs with L2 calls — the proxy fallback can't return
  // registered responses during a plain eth_call (only works during
  // processSingleTxOnL2). The L2 simulation already verified correctness.
  if (discovery.callDetails.length === 0) {
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
  } else {
    log("Builder", `  Pre-check: skipping eth_call dry-run (tx has ${discovery.callDetails.length} L2 call(s) — proxy can't serve responses in plain eth_call)`);
  }

  // === Broadcast ===
  log("Builder", `Broadcasting L1 tx...`);
  const l1TxHash = await l1Provider.send("eth_sendRawTransaction", [signedTx]);
  let l1Receipt = await waitForL1Receipt(l1TxHash);

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
        result = await processL2Transaction(request.signedTx, {
          l1TargetAddress: request.hints?.l1TargetAddress,
        });
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

            const receipt = await waitForL1Receipt(txHash);
            log("Builder", `  Status: ${receipt.status === 1 ? "SUCCESS" : "REVERTED"}`);
            result = { l1TxHash: receipt.hash, status: receipt.status };
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

      if (!isAnvilL1) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Simulation not supported on live L1 chains (requires evm_snapshot)" }));
        return;
      }

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

  // Detect if L1 is Anvil (enables anvil_mine, evm_snapshot, etc.)
  try {
    await l1Provider.send("anvil_nodeInfo", []);
    isAnvilL1 = true;
    log("Builder", `L1 type: Anvil (local devnet)`);
  } catch {
    isAnvilL1 = false;
    log("Builder", `L1 type: Live chain (no anvil_mine, no simulation)`);
  }

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
