# Surge L2 State Derivation Specification

**Version 0.2 - Draft**

This document specifies how L2 state is deterministically derived from L1 events in the Surge synchronous rollup system. It also describes the operational components (Builder, Proxy, etc.) that interact with this system.

---

## Part I: State Derivation Specification

### 1. Fundamental Invariant

```
L2_State_Root = f(Genesis_State, L1_Events[0..n])
```

The L2 state root is a **pure function** of:
1. A well-defined genesis state
2. An ordered sequence of L1 events

Any compliant fullnode MUST derive the identical state root given the same inputs.

---

### 2. Genesis State

#### 2.1 L2 Chain Parameters

| Parameter | Value |
|-----------|-------|
| Chain ID | 10200200 |
| System Address | `0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf` |
| System Private Key | `0x0000000000000000000000000000000000000000000000000000000000000001` |

#### 2.2 Initial Account State

At genesis (before any L1 events), the L2 state contains exactly the following accounts:

##### 2.2.1 System Address

| Field | Value |
|-------|-------|
| Address | `0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf` |
| Balance | 10,000,000,000 ETH (10^28 wei) |
| Nonce | 0 |
| Code | Empty |
| Storage | Empty |

##### 2.2.2 System Contract Deployment

The system address deploys exactly 2 contracts at genesis, using sequential nonces:

**Contract 1: L2CallRegistry (nonce 0)**
```
Address = keccak256(RLP([system_address, 0]))[12:32]
       = 0xF2E246BB76DF876Cef8b38ae84130F4F55De395b
```

Constructor arguments:
- `systemAddress`: `0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf`

**Contract 2: L1SenderProxyL2Factory (nonce 1)**
```
Address = keccak256(RLP([system_address, 1]))[12:32]
       = 0x2946259E0334f33A064106302415aD3391BeD384
```

Constructor arguments:
- `systemAddress`: `0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf`
- `callRegistry`: `0xF2E246BB76DF876Cef8b38ae84130F4F55De395b`

#### 2.3 Genesis State Root

After deploying the two system contracts:
- System address nonce = 2
- System address balance = 10^28 wei (unchanged, gas price = 0)
- Two contracts deployed with their respective code and empty storage

The genesis state root MUST equal the `genesisStateRoot` stored in the L1 NativeRollupCore contract at deployment.

---

### 3. L1 Events

The NativeRollupCore contract emits the following events that affect L2 state:

#### 3.1 State-Changing Events

These events MUST be processed to derive L2 state:

##### 3.1.1 L2BlockProcessed

```solidity
event L2BlockProcessed(
    uint256 indexed l2BlockNumber,
    bytes32 indexed prevBlockHash,
    bytes32 indexed newBlockHash,
    bytes rlpEncodedTx,
    OutgoingCall[] outgoingCalls,
    bytes[] outgoingCallResults
);

struct OutgoingCall {
    address from;
    address target;
    uint256 value;
    uint256 gas;
    bytes data;
    bytes32 postCallStateHash;
}
```

##### 3.1.2 IncomingCallHandled

```solidity
event IncomingCallHandled(
    address indexed l2Target,
    address indexed l1Caller,
    bytes32 indexed prevBlockHash,
    bytes callData,
    uint256 value,
    OutgoingCall[] outgoingCalls,
    bytes[] outgoingCallResults,
    bytes32 finalStateHash
);
```

#### 3.2 Informational Events

These events do NOT directly change L2 state but provide useful information:

- `L2SenderProxyDeployed(address indexed l1Address, address indexed proxyAddress)`
- `IncomingCallRegistered(address indexed l2Address, bytes32 indexed stateHash, bytes32 indexed callDataHash, bytes32 responseKey)`
- `OutgoingCallExecuted(uint256 indexed blockNumber, uint256 indexed callIndex, address indexed from, address target, bool success)`
- `L2StateUpdated(uint256 indexed blockNumber, bytes32 indexed newStateHash, uint256 callIndex)`

---

### 4. Event Processing Rules

#### 4.1 Event Ordering

Events MUST be processed in strict order:
1. By L1 block number (ascending)
2. Within the same L1 block, by log index (ascending)

Example timeline:
```
L1 Block 5:  IncomingCallRegistered (log 0)
L1 Block 5:  ProxyDeployed (log 1)
L1 Block 6:  IncomingCallHandled (log 0)    <- Apply state change
L1 Block 7:  L2BlockProcessed (log 0)        <- Apply L2 tx
```

The fullnode processes these in order: 5.0, 5.1, 6.0, 7.0

#### 4.2 State Matching Requirement

For both `L2BlockProcessed` and `IncomingCallHandled`:

```
IF event.prevBlockHash != current_l2_state_root:
    SKIP event (not applicable to current state)
```

This ensures only events that apply to the current state are processed.

#### 4.3 L2BlockProcessed Processing

**Input:** Current L2 state with root `S_prev`

**Precondition:** `event.prevBlockHash == S_prev`

**Processing Steps:**

1. **Decode Transaction**
   ```
   tx = RLP.decode(event.rlpEncodedTx)
   sender = ecrecover(tx.signature, tx.hash)
   ```

2. **Pre-register Outgoing Call Results** (if any)
   ```
   FOR each (call, result) in zip(event.outgoingCalls, event.outgoingCallResults):
       callKey = keccak256(call.target, call.from, call.data)
       L2CallRegistry.registerReturnValue(callKey, result)
   ```

   This step uses the system address to call L2CallRegistry. Each registration increments the system nonce.

3. **Execute L2 Transaction**
   ```
   receipt = EVM.execute(tx)
   S_post_tx = EVM.getStateRoot()
   ```

4. **Verify Final State**
   ```
   REQUIRE S_post_tx == event.newBlockHash
   ```

5. **Update State**
   ```
   current_l2_state_root = event.newBlockHash
   l2_block_number = event.l2BlockNumber
   ```

#### 4.4 IncomingCallHandled Processing

**Input:** Current L2 state with root `S_prev`

**Precondition:** `event.prevBlockHash == S_prev`

**Processing Steps:**

1. **Determine L1 Sender Proxy Address**
   ```
   proxyAddress = L1SenderProxyL2Factory.computeProxyAddress(event.l1Caller)
   ```

2. **Deploy Proxy if Needed**
   ```
   IF code_at(proxyAddress) == empty:
       L1SenderProxyL2Factory.deployProxy(event.l1Caller)
       // This increments system nonce
   ```

3. **Pre-register Outgoing Call Results** (if any)
   ```
   FOR each (call, result) in zip(event.outgoingCalls, event.outgoingCallResults):
       callKey = keccak256(call.target, call.from, call.data)
       L2CallRegistry.registerReturnValue(callKey, result)
   ```

4. **Execute L1→L2 Call**

   The system address calls the proxy with packed calldata:
   ```
   packedCalldata = abi.encodePacked(event.l2Target, event.callData)

   system_address.call{value: event.value}(
       to: proxyAddress,
       data: packedCalldata
   )
   ```

   The proxy then:
   - Extracts target address from first 20 bytes
   - Forwards call to target with remaining calldata
   - Forwards the value

5. **Verify Final State**
   ```
   S_final = EVM.getStateRoot()
   REQUIRE S_final == event.finalStateHash
   ```

6. **Update State**
   ```
   current_l2_state_root = event.finalStateHash
   ```

---

### 5. L1 Sender Proxy System

#### 5.1 Proxy Address Computation

Each L1 address has a unique, deterministic proxy address on L2:

```
SALT_PREFIX = keccak256("NativeRollup.L1SenderProxyL2.v1")

salt = keccak256(abi.encodePacked(SALT_PREFIX, l1Address))

initCodeHash = keccak256(
    L1SenderProxyL2.creationCode +
    abi.encode(systemAddress, l1Address, callRegistryAddress)
)

proxyAddress = address(uint160(uint256(keccak256(abi.encodePacked(
    bytes1(0xff),
    factoryAddress,
    salt,
    initCodeHash
)))))
```

This ensures:
- Each L1 address has a unique, deterministic L2 proxy address
- L2 contracts can identify which L1 contract called them
- The address is the same across all fullnodes

#### 5.2 Proxy Behavior

**When called by System Address (L1→L2 direction):**
```
function fallback() {
    require(msg.data.length >= 20);
    address target = address(bytes20(msg.data[0:20]));
    bytes memory data = msg.data[20:];

    (bool success, bytes memory result) = target.call{value: msg.value}(data);
    require(success);
    return result;
}
```

**When called by Other (L2→L1 direction):**
```
function fallback() {
    bytes32 callKey = keccak256(abi.encodePacked(l1Address, msg.sender, msg.data));
    (bool registered, bytes memory result) = callRegistry.getReturnValue(callKey);
    require(registered);
    return result;
}
```

---

### 6. L2 Call Registry

#### 6.1 Storage Structure

```solidity
mapping(bytes32 => mapping(uint256 => bytes)) returnValues;  // callKey => index => data
mapping(bytes32 => uint256) callCount;                        // callKey => registered count
mapping(bytes32 => uint256) consumed;                         // callKey => consumed count
```

#### 6.2 Operations

**registerReturnValue(callKey, data):**
```
require(msg.sender == systemAddress);
uint256 index = callCount[callKey];
returnValues[callKey][index] = data;
callCount[callKey] = index + 1;
```

**getReturnValue(callKey) returns (bool, bytes):**
```
uint256 index = consumed[callKey];
if (index >= callCount[callKey]) return (false, "");
bytes memory data = returnValues[callKey][index];
consumed[callKey] = index + 1;  // FIFO consumption
return (true, data);
```

**clearReturnValues(callKey):**
```
require(msg.sender == systemAddress);
delete callCount[callKey];
delete consumed[callKey];
// Note: individual returnValues entries not deleted for gas efficiency
```

---

### 7. Nonce Management

#### 7.1 System Address Nonce

The system address nonce increments for each transaction it sends:

| Operation | Nonce Used |
|-----------|------------|
| Deploy L2CallRegistry | 0 |
| Deploy L1SenderProxyL2Factory | 1 |
| First proxy deployment | 2 |
| First registry write | 3 |
| ... | ... |

#### 7.2 User Address Nonces

User transaction nonces are validated during L2BlockProcessed:
```
require(tx.nonce == account[tx.from].nonce);
account[tx.from].nonce++;
```

---

### 8. Balance Management

#### 8.1 ETH Credits from L1→L2

When processing `IncomingCallHandled` with `value > 0`:

The ETH is credited to the L2 target through the proxy call mechanism:
1. System address sends `value` to proxy
2. Proxy forwards `value` to target

This debits system address and credits target.

#### 8.2 Gas Costs

On L2, gas price is 0. All transactions execute without consuming ETH for gas.

---

### 9. State Root Computation

The L2 state root is computed as:

```
stateRoot = keccak256(RLP(accountTrie))
```

Where `accountTrie` is a Merkle Patricia Trie containing all accounts:

```
account = RLP([nonce, balance, storageRoot, codeHash])
```

This follows standard Ethereum state root computation (EIP-161).

---

### 10. Determinism Requirements

For deterministic state derivation, the following MUST be consistent:

| Parameter | Requirement |
|-----------|-------------|
| EVM Version | Paris (no PREVRANDAO randomness) |
| Block Timestamp | **MUST** be derived from L1 block timestamp |
| Block Number | Sequential from 0 |
| Block Gas Limit | Fixed (e.g., 30M) |
| Coinbase | System address or zero address |
| Base Fee | 0 |
| Gas Price | 0 for all transactions |

#### 10.1 Block Timestamp Derivation

**CRITICAL**: Each L2 block's timestamp MUST be derived from the L1 block that contains the corresponding L1 event:

```
L2_block.timestamp = L1_block[event.blockNumber].timestamp
```

This ensures that replaying the same L1 events at any point in time produces identical L2 state.

#### 10.2 One Block Per Event

Each state-changing L1 event (`L2BlockProcessed` or `IncomingCallHandled`) produces exactly ONE L2 block. All operations for that event (proxy deployment, registry operations, main call/transaction) are included in a single block.

#### Sources of Non-Determinism (to avoid)

- Block timestamp from system clock (ALWAYS use L1-derived timestamp)
- Block number not matching event sequence
- Block hash as randomness (don't use)
- Gas pricing variations (use fixed gas price of 0)
- Precompile behavior differences (use standard precompiles)
- Mining multiple blocks per event (all operations go in one block)

---

### 11. Error Handling

#### 11.1 State Mismatch

If computed state root does not match event's expected state:
```
ABORT processing
LOG error with details
```

The fullnode should NOT continue processing subsequent events.

#### 11.2 Transaction Failure

If an L2 transaction reverts:
- The transaction's state changes are NOT applied
- The state root should still match (revert is deterministic)

#### 11.3 Missing Events

If events are missing (gap in block numbers), the fullnode should:
- Wait for missing events
- Or report sync failure

---

## Part II: Component Specifications

### 12. L2 Fullnode

#### Purpose
The L2 Fullnode maintains L2 state by watching L1 events and applying state transitions. It exposes an Ethereum JSON-RPC interface for querying L2 state.

#### Initialization

1. Read the `l2BlockHash` from NativeRollupCore at genesis (block 0)
2. Create a fresh EVM instance with:
   - Chain ID: 10200200
   - System address `0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf` funded with 10B ETH
   - No other pre-funded accounts
3. Deploy L2CallRegistry and L1SenderProxyL2Factory
4. The state root after this setup MUST equal the genesis `l2BlockHash` from L1
5. If mismatch: the fullnode cannot sync and must abort

#### API

Standard Ethereum JSON-RPC on configured port (default: 9546):
- `eth_call` - Query L2 state
- `eth_getBalance` - Get L2 balance
- `eth_getCode` - Get L2 contract code
- `eth_getStorageAt` - Get L2 storage
- `eth_blockNumber` - Current L2 block number
- `eth_getBlockByNumber` - Get L2 block (includes state root)

---

### 13. Builder

#### Purpose
The Builder receives transactions, simulates them to compute the resulting state, and submits them to L1 with proofs.

#### API Endpoint

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

#### Transaction Types

##### A. L2 Transaction (sourceChain: "L2")

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

##### B. L1 Transaction with L2 Interaction (sourceChain: "L1")

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

#### Proof Generation

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

### 14. L1 Proxy (RPC Proxy)

#### Purpose
Intercepts wallet transactions and routes them through the Builder.

#### Behavior

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

#### API

Standard Ethereum JSON-RPC on configured port (default: 8546):
- `eth_sendRawTransaction` → Forward to Builder
- All other methods → Forward to underlying L1 RPC

---

### 15. L2SenderProxy (L1 Contract)

#### Purpose
Acts as `msg.sender` on L1 for calls originating from L2 contracts.

#### Deployment

Deployed via CREATE2 by NativeRollupCore with deterministic address:

```solidity
address proxy = CREATE2(
  salt: keccak256(abi.encode(PROXY_SALT, l2Address)),
  bytecode: L2SenderProxy.creationCode + abi.encode(nativeRollup, l2Address)
);
```

#### Dual Role

The L2SenderProxy serves TWO purposes:

##### A. Outgoing Calls (L2→L1)

When an L2 contract calls an L1 contract, NativeRollupCore routes the call through the proxy:

```solidity
// In processCallOnL2:
address proxy = _getOrDeployProxy(outgoingCall.from);
L2SenderProxy(proxy).execute(target, data);
```

##### B. Incoming Calls (L1→L2)

When an L1 contract calls an L2 contract, it calls the proxy address:

```solidity
// L1 contract calls L2 contract:
l2ContractProxy.someFunction{value: 1 ether}(args);
```

The proxy's `fallback()` forwards to `NativeRollupCore.handleIncomingCall()`.

---

## Part III: Reference Implementation

### 16. Anvil Configuration

When using Anvil as L2 EVM:
```
anvil \
  --chain-id 10200200 \
  --gas-price 0 \
  --block-base-fee-per-gas 0 \
  --no-mining \
  --accounts 0
```

Key settings:
- `--no-mining`: Manual block production
- `--gas-price 0`: Free transactions
- `--accounts 0`: No pre-funded accounts (we fund system address explicitly)

### 17. State Root Retrieval

After each transaction/call:
```javascript
const block = await provider.send("eth_getBlockByNumber", ["latest", false]);
const stateRoot = block.stateRoot;
```

---

## Part IV: Configuration Reference

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

---

## Part V: Error Reference

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

## Part VI: Security Considerations

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

## Appendix A: Contract ABIs

### A.1 L2CallRegistry

```solidity
interface IL2CallRegistry {
    function registerReturnValue(bytes32 callKey, bytes calldata data) external;
    function getReturnValue(bytes32 callKey) external returns (bool, bytes memory);
    function clearReturnValues(bytes32 callKey) external;
}
```

### A.2 L1SenderProxyL2Factory

```solidity
interface IL1SenderProxyL2Factory {
    function deployProxy(address l1Address) external returns (address);
    function computeProxyAddress(address l1Address) external view returns (address);
    function proxies(address l1Address) external view returns (address);
}
```

### A.3 L1SenderProxyL2

```solidity
interface IL1SenderProxyL2 {
    function systemAddress() external view returns (address);
    function l1Address() external view returns (address);
    function callRegistry() external view returns (address);
}
```

---

## Appendix B: Pseudocode for Full Sync

```python
def sync_from_genesis(l1_rpc, rollup_address, deployment_block):
    # Initialize L2 EVM
    l2 = create_l2_evm(chain_id=10200200)

    # Fund system address
    l2.set_balance(SYSTEM_ADDRESS, 10**28)

    # Deploy system contracts
    l2.deploy(L2CallRegistry, [SYSTEM_ADDRESS], from=SYSTEM_ADDRESS, nonce=0)
    l2.deploy(L1SenderProxyL2Factory, [SYSTEM_ADDRESS, REGISTRY_ADDRESS], from=SYSTEM_ADDRESS, nonce=1)

    genesis_root = l2.get_state_root()

    # Verify genesis matches L1
    l1_genesis = rollup.l2BlockHash(block=deployment_block)
    assert genesis_root == l1_genesis

    # Fetch and process events
    events = fetch_events(l1_rpc, rollup_address, from_block=deployment_block)
    events.sort(key=lambda e: (e.block_number, e.log_index))

    for event in events:
        if event.type == "L2BlockProcessed":
            process_l2_block(l2, event)
        elif event.type == "IncomingCallHandled":
            process_incoming_call(l2, event)

    return l2.get_state_root()
```

---

## Changelog

- **v0.1**: Initial draft specification (SPEC.md)
- **v0.2**: Merged with operational component specifications (SPECIFICATIONS.md)
