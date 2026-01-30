/**
 * L2 Fullnode RPC Interface
 *
 * ============================================================================
 * CRITICAL REQUIREMENT: DETERMINISTIC EXECUTION
 * ============================================================================
 *
 * Given a specific NativeRollupCore contract address and the sequence of events
 * it has emitted (L2BlockProcessed and IncomingCallHandled), ANY fullnode
 * implementation MUST produce IDENTICAL state roots.
 *
 * This means:
 * 1. Genesis state must be deterministic (same system contract addresses)
 * 2. System contract deployment must use fixed nonces and CREATE2
 * 3. All L2 state transitions must be reproducible from L1 events alone
 * 4. No reliance on timestamps, block numbers, or other non-deterministic inputs
 *
 * DETERMINISM REQUIREMENTS:
 *
 * 1. SYSTEM ADDRESS
 *    - The system address MUST be: 0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf
 *    - Derived from private key: 0x01
 *    - This address executes all L2 operations and deploys system contracts
 *
 * 2. GENESIS STATE
 *    - The genesis state is the state AFTER deploying system contracts
 *    - System contracts MUST be deployed at fixed nonces:
 *      - L2CallRegistry: nonce 0
 *      - L1SenderProxyL2Factory: nonce 1
 *    - The genesis state root MUST be identical across all fullnode instances
 *
 * 3. L1SenderProxyL2 DEPLOYMENT
 *    - Uses CREATE2 via L1SenderProxyL2Factory for deterministic addresses
 *    - Salt: keccak256(SALT_PREFIX + l1Address)
 *    - SALT_PREFIX: keccak256("NativeRollup.L1SenderProxyL2.v1")
 *    - Any fullnode can compute the proxy address without deploying
 *
 * 4. EVENT REPLAY
 *    - A fullnode can fully reconstruct L2 state by replaying L1 events
 *    - L2BlockProcessed: Contains RLP-encoded signed L2 transaction
 *    - IncomingCallHandled: Contains L1 caller, L2 target, calldata, value
 *
 * 5. NON-DETERMINISTIC OPERATIONS (PROHIBITED)
 *    - block.timestamp (returns 0 or genesis time)
 *    - block.number (returns L2 block number from event)
 *    - PREVRANDAO/DIFFICULTY (returns 0)
 *    - External RPC calls
 *
 * ============================================================================
 *
 * RPC Methods:
 *
 * Standard Ethereum RPC (subset):
 *   - eth_blockNumber
 *   - eth_getBalance
 *   - eth_getCode
 *   - eth_call
 *   - eth_getTransactionReceipt
 *   - eth_getBlockByNumber
 *
 * Native Rollup specific:
 *   - nativerollup_getStateRoot() -> bytes32
 *       Returns the current state root (L2 block hash)
 *
 *   - nativerollup_simulateL1ToL2Call(params) -> SimulationResult
 *       Simulates an L1→L2 call and returns the result WITHOUT changing state.
 *       The fullnode creates a fork internally for this simulation.
 *
 *       Params:
 *         - l1Caller: address (the L1 contract making the call)
 *         - l2Target: address (the L2 contract being called)
 *         - callData: bytes (the calldata for the L2 call)
 *         - value: uint256 (ETH value to send)
 *         - currentStateRoot: bytes32 (the state to start from)
 *
 *       Returns:
 *         - success: boolean
 *         - returnData: bytes
 *         - newStateRoot: bytes32
 *         - gasUsed: uint256
 *         - logs: Log[]
 *
 *   - nativerollup_executeL1ToL2Call(params) -> ExecutionResult
 *       Executes an L1→L2 call and COMMITS the state change.
 *       This is called after the L1 event is emitted.
 *
 *       Params: same as simulateL1ToL2Call
 *       Returns: same as simulateL1ToL2Call, plus txHash
 *
 *   - nativerollup_executeL2Transaction(rawTx) -> ExecutionResult
 *       Executes a raw signed L2 transaction.
 *
 *       Params:
 *         - rawTx: bytes (RLP-encoded signed transaction)
 *
 *       Returns:
 *         - success: boolean
 *         - txHash: bytes32
 *         - newStateRoot: bytes32
 *         - gasUsed: uint256
 *
 *   - nativerollup_getL1SenderProxyL2(l1Address) -> address
 *       Returns the L1SenderProxyL2 address for an L1 caller.
 *       If not deployed, returns the computed address (CREATE2 deterministic).
 *
 *   - nativerollup_isL1SenderProxyL2Deployed(l1Address) -> boolean
 *       Checks if the L1SenderProxyL2 is deployed for an L1 caller.
 *
 *   - nativerollup_syncFromEvents(events) -> SyncResult (NEW)
 *       Replays a sequence of L1 events to reconstruct L2 state.
 *       Used for initial sync and verification.
 */

export interface SimulationResult {
  success: boolean;
  returnData: string;
  newStateRoot: string;
  gasUsed: string;  // Hex or decimal string (bigint doesn't serialize to JSON)
  logs: LogEntry[];
  error?: string;
}

export interface ExecutionResult extends SimulationResult {
  txHash: string;
}

export interface LogEntry {
  address: string;
  topics: string[];
  data: string;
}

export interface L1ToL2CallParams {
  l1Caller: string;
  l2Target: string;
  callData: string;
  value: string;  // Hex-encoded uint256
  currentStateRoot: string;
}

/**
 * Event types for replay
 */
export interface L2BlockProcessedEvent {
  type: 'L2BlockProcessed';
  blockNumber: bigint;
  prevBlockHash: string;
  newBlockHash: string;
  rlpEncodedTx: string;
}

export interface IncomingCallHandledEvent {
  type: 'IncomingCallHandled';
  l2Address: string;
  l1Caller: string;
  prevBlockHash: string;
  callData: string;
  value: bigint;
  finalStateHash: string;
}

export type L2Event = L2BlockProcessedEvent | IncomingCallHandledEvent;

export interface SyncResult {
  success: boolean;
  finalStateRoot: string;
  eventsProcessed: number;
  errors: string[];
}

/**
 * Interface that the builder uses to interact with the fullnode.
 * The builder should ONLY use methods from this interface.
 */
export interface IFullnodeRpc {
  // Standard Ethereum RPC
  eth_blockNumber(): Promise<string>;
  eth_getBalance(address: string, block?: string): Promise<string>;
  eth_getCode(address: string, block?: string): Promise<string>;
  eth_call(tx: { to: string; data: string; from?: string; value?: string }, block?: string): Promise<string>;
  eth_getBlockByNumber(block: string, fullTx: boolean): Promise<any>;

  // Native Rollup specific
  nativerollup_getStateRoot(): Promise<string>;
  nativerollup_simulateL1ToL2Call(params: L1ToL2CallParams): Promise<SimulationResult>;
  nativerollup_executeL1ToL2Call(params: L1ToL2CallParams): Promise<ExecutionResult>;
  nativerollup_executeL2Transaction(rawTx: string): Promise<ExecutionResult>;
  nativerollup_getL1SenderProxyL2(l1Address: string): Promise<string>;
  nativerollup_isL1SenderProxyL2Deployed(l1Address: string): Promise<boolean>;

  // Sync and replay
  nativerollup_syncFromEvents(events: L2Event[]): Promise<SyncResult>;
}

/**
 * DETERMINISM CONSTANTS
 *
 * These MUST be identical across all fullnode implementations.
 */
export const DETERMINISM_CONSTANTS = {
  // System address derived from private key 0x01
  SYSTEM_ADDRESS: '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf',
  SYSTEM_PRIVATE_KEY: '0x0000000000000000000000000000000000000000000000000000000000000001',

  // Fixed nonces for system contract deployment
  L2_CALL_REGISTRY_NONCE: 0,
  L1_SENDER_PROXY_L2_FACTORY_NONCE: 1,

  // CREATE2 salt prefix for L1SenderProxyL2
  L1_SENDER_PROXY_L2_SALT_PREFIX: 'NativeRollup.L1SenderProxyL2.v1',

  // L2 chain configuration
  L2_CHAIN_ID: 10200200,

  // System address initial balance (for gas)
  SYSTEM_BALANCE: '10000000000000000000000000000', // 10 billion ETH
};

/**
 * Implementation notes:
 *
 * The key principle is that the fullnode handles ALL L2 state transitions.
 * The builder never directly manipulates L2 state - it only:
 * 1. Simulates to predict state roots
 * 2. Requests execution after L1 confirmation
 *
 * For L1→L2 calls:
 * 1. Builder calls nativerollup_simulateL1ToL2Call to get the predicted state root
 * 2. Builder registers the incoming call on L1 with this state root
 * 3. User's L1 tx executes, emitting IncomingCallHandled event
 * 4. Fullnode sees the event and calls nativerollup_executeL1ToL2Call internally
 *
 * For L2 transactions:
 * 1. Builder calls nativerollup_simulateL2Transaction to get the predicted state root
 * 2. Builder submits to L1 via processSingleTxOnL2
 * 3. Fullnode sees L2BlockProcessed event and executes the tx
 *
 * CRITICAL: The fullnode must deploy L1SenderProxyL2 contracts properly.
 * When simulating/executing L1→L2 calls:
 * 1. Check if L1SenderProxyL2 exists for the L1 caller
 * 2. If not, deploy it (using system address)
 * 3. Make the call FROM the proxy address TO the target
 * 4. This ensures msg.sender on L2 is the proxy, not some impersonated address
 *
 * DETERMINISM: For the fullnode to be deterministic:
 * 1. System contracts must be deployed at genesis with fixed nonces
 * 2. L1SenderProxyL2 must use CREATE2 with deterministic salt
 * 3. No reliance on timestamps, block numbers, or external data
 * 4. All state transitions must be reproducible from L1 events alone
 */
