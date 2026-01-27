# Synchronous Surge Component Specifications

## Overview

This document specifies the exact behavior of each component in the Synchronous Surge system. The system enables **synchronous composability** between L1 and L2 - meaning L1 contracts can call L2 contracts and vice versa within a single atomic transaction.

### Key Invariant

**L2 state is a pure function of L1 events.** Given the same L1 event history, any fullnode MUST derive the exact same L2 state.

### State Root

The `l2BlockHash` (also called "state root") is the Ethereum state root of the L2 EVM. It uniquely identifies the entire L2 state (all account balances, contract storage, code, nonces).

---

## 1. L2 Fullnode

### Purpose
The L2 Fullnode maintains L2 state by watching L1 events and applying state transitions. It exposes an Ethereum JSON-RPC interface for querying L2 state.

### Initialization

1. Read the `l2BlockHash` from NativeRollupCore at genesis (block 0)
2. Create a fresh EVM instance with:
   - Chain ID: configured (e.g., 10200200)
   - System address `0x1000000000000000000000000000000000000001` funded with 10B ETH
   - No other pre-funded accounts
3. The state root after this setup MUST equal the genesis `l2BlockHash` from L1
4. If mismatch: the fullnode cannot sync and must abort

### Event Processing

The fullnode watches two event types from NativeRollupCore:

#### A. `L2BlockProcessed` Event

```solidity
event L2BlockProcessed(
    uint256 indexed blockNumber,
    bytes32 indexed prevBlockHash,
    bytes32 indexed newBlockHash,
    bytes rlpEncodedTx,              // The RLP-encoded signed L2 transaction
    OutgoingCall[] outgoingCalls,    // L2→L1 calls made during execution
    bytes[] outgoingCallResults      // Results of those L1 calls
);
```

**Processing Steps:**

1. Verify `prevBlockHash` matches current local state root
2. Extract `rlpEncodedTx` directly from the event data (no need to look up L1 transaction calldata)
3. Parse `rlpEncodedTx` as a signed L2 transaction
4. Execute the transaction on L2:
   - Sender: recovered from signature
   - Verify nonce matches sender's current nonce
   - Apply gas, value, and data
5. Verify local state root now equals `newBlockHash`
6. If `outgoingCalls.length > 0`, process the outgoing calls (L2→L1 calls)

**Note:** The event contains ALL data needed for the fullnode to reconstruct L2 state. The fullnode does NOT need to look up L1 transaction calldata.

#### B. `IncomingCallHandled` Event

```solidity
event IncomingCallHandled(
    address indexed l2Address,           // L2 contract being called
    address indexed l1Caller,            // L1 contract that initiated the call
    bytes32 indexed prevBlockHash,       // L2 state hash before this call
    bytes callData,                      // The calldata sent to L2 contract
    uint256 value,                       // ETH value sent
    OutgoingCall[] outgoingCalls,        // L2→L1 calls made during execution
    bytes[] outgoingCallResults,         // Results returned by L1 calls
    bytes32 finalStateHash               // Final L2 state after all calls
);
```

**Processing Steps:**

1. Verify `prevBlockHash` matches current local state root
2. Extract `callData` directly from the event data (no need to trace L1 transaction)
3. Compute `l1ProxyOnL2 = computeL1SenderProxyL2Address(l1Caller)`
4. If `value > 0`: credit `value` ETH to `l2Address`
5. If `callData` is not empty:
   - Execute call on L2 with:
     - `from`: `l1ProxyOnL2` (the L1 caller's proxy on L2)
     - `to`: `l2Address`
     - `data`: `callData`
     - `value`: `value`
6. If `outgoingCalls.length > 0`, process the outgoing calls (L2→L1 calls)
7. Verify local state root now equals `finalStateHash`

**Note:** The event contains ALL data needed for the fullnode to reconstruct L2 state. The fullnode does NOT need to look up L1 transaction calldata or query L1 storage.

### State Root Computation

The fullnode MUST use the same state root computation as the builder:

```
stateRoot = keccak256(RLP(accountTrie))
```

Where `accountTrie` is the Merkle Patricia Trie of all accounts, and each account contains:
- nonce
- balance
- storageRoot (hash of storage trie)
- codeHash

### L1 Caller Proxy Address

When an L1 contract calls an L2 contract, the `msg.sender` on L2 is NOT the L1 contract address. Instead, it's a deterministic proxy address computed as:

```typescript
function computeL1SenderProxyL2Address(l1Address: string): string {
  const hash = keccak256(solidityPacked(
    ["string", "address"],
    ["L1SenderProxyL2.v1", l1Address]
  ));
  return "0x" + hash.slice(-40);
}
```

This ensures:
- Each L1 address has a unique, deterministic L2 proxy address
- L2 contracts can identify which L1 contract called them
- The address is the same across all fullnodes

### API

Standard Ethereum JSON-RPC on configured port (default: 9546):
- `eth_call` - Query L2 state
- `eth_getBalance` - Get L2 balance
- `eth_getCode` - Get L2 contract code
- `eth_getStorageAt` - Get L2 storage
- `eth_blockNumber` - Current L2 block number
- `eth_getBlockByNumber` - Get L2 block (includes state root)

---

## 2. Builder

### Purpose
The Builder receives transactions, simulates them to compute the resulting state, and submits them to L1 with proofs.

### API Endpoint

`POST /submit`

```typescript
interface SubmitRequest {
  signedTx: string;         // Hex-encoded signed transaction
  sourceChain: "L1" | "L2"; // Which chain the tx targets
  hints?: {
    l2TargetAddress?: string;  // For direct L1→L2 deposits
    l2Addresses?: string[];    // L2 addresses that will be called (builder deploys proxies if needed)
    isContractCall?: boolean;  // Hint that this L1 tx will call L2 contracts
  };
}
```

**Hint: l2Addresses**

When submitting an L1 transaction that will call L2 contracts, provide the `l2Addresses` hint with an array of L2 contract addresses. This allows the builder to:

1. Deploy L2SenderProxy for each L2 address (if not already deployed)
2. Pre-register the incoming call responses before the L1 tx executes
3. Ensure the L1 tx doesn't revert due to missing proxies or responses

Without this hint, the builder will still try to detect L2 calls via tracing, but this may fail if the proxies aren't deployed yet.

### Transaction Types

#### A. L2 Transaction (sourceChain: "L2")

A standard Ethereum transaction targeting L2.

**Processing Steps:**

1. Parse `signedTx` to get sender, nonce, to, value, data
2. Verify nonce matches sender's current L2 nonce
3. Get current `l2BlockHash` from NativeRollupCore
4. Verify fullnode state root matches `l2BlockHash`
5. Execute transaction on fullnode
6. Get new state root from fullnode
7. Sign proof covering: prevHash, callData, newStateRoot
8. Submit to NativeRollupCore.processCallOnL2()

**L1 Call:**
```solidity
processSingleTxOnL2(
  prevL2BlockHash,              // Current l2BlockHash
  rlpEncodedTx,                 // The RLP-encoded signed L2 transaction
  preOutgoingCallsStateHash,    // State after L2 execution, before L1 calls
  outgoingCalls,                // L2→L1 calls (empty for simple tx)
  expectedResults,              // Expected results (empty for simple tx)
  finalStateHash,               // Final state after all calls
  proof                         // Admin signature
)
```

#### B. L1 Transaction with L2 Interaction (sourceChain: "L1")

An L1 transaction that may call L2 contracts via L2SenderProxy.

**Processing Steps:**

1. Parse `signedTx` to understand the L1 transaction
2. **If `hints.l2Addresses` provided**: Deploy L2SenderProxy for each L2 address (if not already deployed)
3. Get current `l2BlockHash` from NativeRollupCore
4. Verify fullnode state matches `l2BlockHash`
5. Create an L1 fork (Anvil fork of L1)
6. Trace the transaction execution using `debug_traceCall`
7. Detect any calls to L2SenderProxy contracts
8. For each detected L2 proxy call:
   a. Extract: `l2Address`, `callData`, `value`, `l1Caller`
   b. Simulate the L2 effect on the fullnode (using snapshot/revert)
   c. Get the resulting state root
   d. Sign and register the incoming call response on L1
9. Broadcast the original L1 transaction

**Important:** Proxy deployment happens BEFORE tracing. This ensures the trace can detect the proxy calls.

**L1 Calls (for each L2 interaction):**
```solidity
// Step 0: Deploy proxies for hinted L2 addresses (before tracing)
for (l2Address in hints.l2Addresses) {
  if (!isProxyDeployed(l2Address)) {
    deployProxy(l2Address)
  }
}

// Step 1: Register the expected response (for each detected L2 call)
registerIncomingCall(
  l2Address,            // L2 contract being called
  currentL2BlockHash,   // State at which this response is valid
  callData,             // The calldata
  {
    preOutgoingCallsStateHash: newStateRoot,
    outgoingCalls: [],
    expectedResults: [],
    returnValue: "0x",
    finalStateHash: newStateRoot
  },
  proof                 // Admin signature
)

// Step 2: Broadcast user's original L1 tx
eth_sendRawTransaction(signedTx)
```

#### C. Simple L1 Transaction (sourceChain: "L1", no L2 interaction)

An L1 transaction that doesn't interact with L2.

**Processing Steps:**

1. Detect that transaction doesn't call any L2SenderProxy
2. Simply broadcast to L1: `eth_sendRawTransaction(signedTx)`

### Simulation Requirements

The builder MUST simulate L2 effects using the **exact same execution environment** as the fullnode:

1. Fork from the fullnode's current state
2. Use identical EVM configuration (chain ID, gas settings)
3. Execute the same operations in the same order
4. State roots will match because inputs are identical

### Proof Generation

For POC, proofs are admin signatures. The builder signs:

```typescript
const messageHash = keccak256(encode(
  prevBlockHash,
  keccak256(rlpEncodedTx),
  preOutgoingCallsStateHash,
  hashOutgoingCalls(outgoingCalls),
  hashResults(expectedResults),
  finalStateHash
));

const signature = adminWallet.signMessage(getBytes(messageHash));
```

---

## 3. L1 Proxy (RPC Proxy)

### Purpose
Intercepts wallet transactions and routes them through the Builder.

### Behavior

All `eth_sendRawTransaction` calls are forwarded to the Builder. The proxy does NOT try to determine which transactions need L2 interaction - that's the Builder's job.

```typescript
async function handleSendRawTransaction(signedTx: string): Promise<string> {
  // Always forward to builder
  const result = await submitToBuilder({
    signedTx,
    sourceChain: "L1"
  });
  return result.l1TxHash;
}
```

### Why Not Filter?

The proxy cannot know which L1 contracts might internally call L2. An L1 contract like `L1SyncedCounter` doesn't appear special, but its `setValue()` function calls an L2 contract. The Builder traces execution to detect this.

### API

Standard Ethereum JSON-RPC on configured port (default: 8546):
- `eth_sendRawTransaction` → Forward to Builder
- All other methods → Forward to underlying L1 RPC

### Additional Endpoints

- `GET /status` - Proxy status
- `POST /register-hint` - Register L2 target hint (optional optimization)

---

## 4. L2SenderProxy (L1 Contract)

### Purpose
Acts as `msg.sender` on L1 for calls originating from L2 contracts.

### Deployment

Deployed via CREATE2 by NativeRollupCore with deterministic address:

```solidity
address proxy = CREATE2(
  salt: keccak256(abi.encode(PROXY_SALT, l2Address)),
  bytecode: L2SenderProxy.creationCode + abi.encode(nativeRollup, l2Address)
);
```

### Address Computation

```solidity
function getProxyAddress(address l2Address) public view returns (address) {
    bytes32 bytecodeHash = keccak256(abi.encodePacked(
        type(L2SenderProxy).creationCode,
        abi.encode(address(this), l2Address)
    ));

    return address(uint160(uint256(keccak256(abi.encodePacked(
        bytes1(0xff),
        address(this),
        keccak256(abi.encode(PROXY_SALT, l2Address)),
        bytecodeHash
    )))));
}
```

### Dual Role

The L2SenderProxy serves TWO purposes:

#### A. Outgoing Calls (L2→L1)

When an L2 contract calls an L1 contract, NativeRollupCore routes the call through the proxy:

```solidity
// In processCallOnL2:
address proxy = _getOrDeployProxy(outgoingCall.from);
L2SenderProxy(proxy).execute(target, data);
```

The L1 contract sees `msg.sender = proxy`, which uniquely identifies the L2 caller.

#### B. Incoming Calls (L1→L2)

When an L1 contract calls an L2 contract, it calls the proxy address:

```solidity
// L1 contract calls L2 contract:
l2ContractProxy.someFunction{value: 1 ether}(args);
```

The proxy's `fallback()` forwards to `NativeRollupCore.handleIncomingCall()`:

```solidity
fallback(bytes calldata) external payable returns (bytes memory) {
    return INativeRollupCore(nativeRollup).handleIncomingCall{value: msg.value}(
        l2Address,
        msg.sender,  // The L1 caller
        msg.data
    );
}
```

### Incoming Call Handling

`handleIncomingCall` looks up a pre-registered response:

```solidity
function handleIncomingCall(
    address l2Address,
    address l1Caller,
    bytes calldata callData
) external payable returns (bytes memory) {
    bytes32 responseKey = keccak256(abi.encode(l2Address, l2BlockHash, keccak256(callData)));

    // Revert if not pre-registered
    if (!incomingCallRegistered[responseKey]) {
        revert IncomingCallNotRegistered(responseKey);
    }

    IncomingCallResponse storage response = incomingCallResponses[responseKey];

    // Update L2 state
    l2BlockHash = response.finalStateHash;

    // Return pre-registered value
    return response.returnValue;
}
```

---

## State Root Determinism

### Requirements

For the system to work, state roots MUST be deterministic:

1. Given genesis state G
2. Apply operations O1, O2, O3...
3. Result state root R must be identical on all nodes

### Sources of Non-Determinism (to avoid)

- Block timestamp (use fixed or L1-derived)
- Block number (use L1 block number or event index)
- Block hash as randomness (don't use)
- Gas pricing (use fixed gas price)
- Precompile behavior differences (use standard precompiles)

### L2 Transaction Execution

When executing an L2 transaction:

```
Input:
  - prevStateRoot: bytes32
  - signedTx: bytes (RLP-encoded signed transaction)

Output:
  - newStateRoot: bytes32
  - success: bool
  - logs: Log[]
```

The EVM execution MUST be deterministic given:
- Previous state (identified by prevStateRoot)
- Transaction bytes
- Block context (timestamp, number, etc. - must be deterministic)

### Incoming Call Execution

When processing an L1→L2 call:

```
Input:
  - prevStateRoot: bytes32
  - l1Caller: address
  - l2Target: address
  - callData: bytes
  - value: uint256

Output:
  - newStateRoot: bytes32
```

Execution steps:
1. l1ProxyOnL2 = computeL1SenderProxyL2Address(l1Caller)
2. If value > 0: l2Target.balance += value
3. If callData != 0x: execute call from l1ProxyOnL2 to l2Target
4. Compute new state root

---

## Event Ordering

Events MUST be processed in L1 block order, then by log index within a block.

Example timeline:
```
L1 Block 5:  IncomingCallRegistered (log 0)
L1 Block 5:  ProxyDeployed (log 1)
L1 Block 6:  IncomingCallHandled (log 0)    <- Apply state change
L1 Block 7:  L2BlockProcessed (log 0)        <- Apply L2 tx
```

The fullnode processes these in order: 5.0, 5.1, 6.0, 7.0

---

## Error Handling

### Builder Errors

| Error | Cause | Resolution |
|-------|-------|------------|
| Nonce mismatch | Transaction has wrong nonce | User must refresh nonce |
| Fullnode not synced | Fullnode state != L1 state | Wait for fullnode to sync |
| Trace failed | Couldn't trace L1 execution | Fall back to no-L2 assumption |
| Proof signing failed | Admin key issue | Check admin key configuration |

### Fullnode Errors

| Error | Cause | Resolution |
|-------|-------|------------|
| Genesis mismatch | Initial state root differs | Reconfigure genesis or restart L1 |
| Event out of order | Missed events | Re-sync from earlier block |
| State root mismatch | Execution differs from L1 | Debug execution difference |

### Contract Errors

| Error | Cause | Resolution |
|-------|-------|------------|
| `IncomingCallNotRegistered` | L1 call to L2 without pre-registration | Route through Builder |
| `InvalidPrevBlockHash` | Building on wrong state | Get current state and retry |
| `ProofVerificationFailed` | Invalid proof | Check proof generation |

---

## Security Considerations

### Builder Trust

In POC, the Builder/Admin is trusted to:
- Correctly simulate L2 execution
- Generate valid proofs
- Not censor transactions

In production, ZK proofs would replace admin signatures.

### L2SenderProxy Security

- Only NativeRollupCore can call `execute()`
- Proxy address is deterministic and unforgeable
- Pre-deployment funds can be refunded

### State Root Integrity

- Fullnode verifies each state transition against L1
- Mismatch indicates bug or attack
- In production, ZK proofs ensure correctness

---

## Configuration

### L2 Fullnode

| Parameter | Default | Description |
|-----------|---------|-------------|
| `--l1-rpc` | `http://localhost:8545` | L1 RPC endpoint |
| `--rollup` | Required | NativeRollupCore address |
| `--port` | `9546` | L2 RPC port |
| `--chain-id` | `10200200` | L2 chain ID |

### Builder

| Parameter | Default | Description |
|-----------|---------|-------------|
| `--l1-rpc` | `http://localhost:8545` | L1 RPC endpoint |
| `--fullnode` | `http://localhost:9546` | L2 fullnode endpoint |
| `--rollup` | Required | NativeRollupCore address |
| `--admin-key` | Required | Private key for signing proofs |
| `--port` | `3200` | Builder API port |

### L1 Proxy

| Parameter | Default | Description |
|-----------|---------|-------------|
| `--rpc` | `http://localhost:8545` | Underlying L1 RPC |
| `--builder` | `http://localhost:3200` | Builder API endpoint |
| `--port` | `8546` | Proxy port |
