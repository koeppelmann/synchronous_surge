# Synchronous Rollup

A minimal implementation of **Synchronous Rollups** - L2s where state is a pure function of L1 state, proven and verified atomically with block submission.

## Quick Start

Start the complete Synchronous Rollup environment with a single command:

```bash
cd synchronous_surge
./start.sh
```

This starts:
- **L1 Anvil** (port 8545) - Local Ethereum chain
- **L2 Fullnode** (port 9546) - Deterministic L2 derived from L1
- **Builder** (port 3200) - Processes L1→L2 deposits
- **L1 RPC Proxy** (port 8546) - Routes wallet transactions through builder
- **L2 RPC Proxy** (port 9548) - Routes L2 transactions through builder
- **Frontend** (port 8080) - Web UI for deposits/withdrawals

### Wallet Setup

Add these networks to your wallet (e.g., MetaMask, Rabby):

| Network | Chain ID | RPC URL |
|---------|----------|---------|
| L1 (via proxy) | 31337 | `http://localhost:8546` |
| L2 (via proxy) | 10200200 | `http://localhost:9548` |

**Important:** Use the proxy ports (8546/9548), not the direct RPC ports, so transactions are routed through the builder.

### Test the Flow

1. Open http://localhost:8080 in your browser
2. Connect your wallet to L1 (Chain ID 31337, port 8546)
3. The default Anvil account has 10,000 ETH
4. Enter an amount and click "Deposit to L2"
5. Switch your wallet to L2 (Chain ID 10200200, port 9548)
6. Your deposited ETH appears on L2

### Stop Everything

```bash
./stop.sh
# or just Ctrl+C in the terminal running start.sh
```

## Overview

Synchronous Rollups eliminate the 7-day withdrawal delays of optimistic rollups by proving each L2 state transition at submission time. This enables **instant L2→L1 bridging** and **synchronous cross-chain composability**.

### Core Concept

```
L2 State = f(Previous L2 State, Input CallData, L1 Calls)
```

Every L2 block:
1. Takes previous L2 state + input calldata
2. Computes new L2 state deterministically
3. May trigger outgoing L1 calls
4. Is proven and verified atomically in a single transaction

### Key Features

- **Instant Finality**: No withdrawal delays - state is proven immediately
- **L2→L1 Calls**: L2 contracts can call L1 contracts synchronously
- **L1→L2 Calls**: L1 contracts can call L2 contracts via pre-registered responses
- **Proper `msg.sender`**: Each address has a deterministic proxy for correct caller identity
- **Real State Roots**: L1 commitment always matches actual L2 state root
- **Pluggable Verification**: Replace `AdminProofVerifier` with ZK or TEE verifier for production

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     L1 (Ethereum/Gnosis)                    │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─────────────────────┐    ┌────────────────────────┐     │
│  │  NativeRollupCore   │───▶│  IProofVerifier        │     │
│  │                     │    │  (AdminProofVerifier)  │     │
│  │  - l2BlockHash      │    └────────────────────────┘     │
│  │  - l2BlockNumber    │                                   │
│  │  - processSingleTxOnL2│                                   │
│  │  - registerIncoming │                                   │
│  │  - handleIncoming   │                                   │
│  └──────────┬──────────┘                                   │
│             │                                               │
│             │ CREATE2                                       │
│             ▼                                               │
│  ┌─────────────────────┐                                   │
│  │   L2SenderProxy     │──────▶ Any L1 Contract            │
│  │   (per L2 address)  │       (msg.sender = proxy)        │
│  └─────────────────────┘                                   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
                              │
                     ┌────────┴────────┐
                     │   Sequencer     │
                     │  (TypeScript)   │
                     │  - Watch L1     │
                     │  - Replay on L2 │
                     └────────┬────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                     L2 (Fresh EVM Chain)                    │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  L2 State is a PURE FUNCTION of L1 actions                  │
│                                                             │
│  - L1SenderProxy: Deterministic address for each L1 caller │
│  - Contract storage: Synced via sequencer replay           │
│  - State root: Committed on L1 after each transition       │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## Contracts

| Contract | Description |
|----------|-------------|
| `NativeRollupCore` | Main rollup contract - tracks L2 state, processes blocks, executes L1 calls |
| `L2SenderProxy` | Minimal proxy deployed per L2 address for proper `msg.sender` on L1 |
| `IProofVerifier` | Interface for proof verification (ZK, TEE, or admin signature) |
| `AdminProofVerifier` | POC verifier using admin signatures (replace for production) |
| `SyncedCounter` | Example of bidirectional L1↔L2 synchronized state |

## Components

### Fullnode (`fullnode/`)

The L2 Fullnode deterministically syncs L2 state from L1. It:
- Watches L1 for `L2BlockProcessed` and `IncomingCallHandled` events
- Replays all state transitions on L2
- Maintains the invariant: L2 state root == l2BlockHash on L1

```bash
cd fullnode && npm install
npx tsx index.ts
```

### Builder (`builder/`)

The Builder handles two types of L2 state transitions:

**1. L2 EOA Transactions:**
```bash
npx tsx index.ts l2-tx <from> <to> [value] [data]

# Example: Transfer 1 ETH on L2
npx tsx index.ts l2-tx 0xf39F... 0x7099... 1000000000000000000
```

**2. L1→L2 Contract Calls:**
```bash
npx tsx index.ts l1-to-l2 <l1Caller> <l2Target> [callData]

# Example: L1SyncedCounter calls L2SyncedCounter.setValue(42)
npx tsx index.ts l1-to-l2 0xd30b... 0xe7f1... 0x55241077...00002a
```

**Check Status:**
```bash
npx tsx index.ts status
```

## Scripts

| Script | Description |
|--------|-------------|
| `start.sh` | **Start everything** - L1, contracts, fullnode, builder, proxies, UI |
| `stop.sh` | Stop all running components |
| `fullnode/deterministic-fullnode.ts` | L2 Fullnode - derives state from L1 events |
| `scripts/deterministic-builder.ts` | Builder - handles L1→L2 deposits and L2 transactions |
| `scripts/rpc-proxy.ts` | L1 RPC proxy - routes transactions through builder |
| `scripts/l2-rpc-proxy.ts` | L2 RPC proxy - routes L2 transactions through builder |

## Usage

### Build

```bash
forge build
```

### Test

```bash
forge test
```

### Run Full Stack (Recommended)

```bash
./start.sh
```

This script:
1. Calculates the deterministic genesis hash
2. Starts L1 Anvil (auto-mine mode)
3. Deploys NativeRollupCore with correct genesis
4. Starts the deterministic fullnode
5. Starts the builder service
6. Starts RPC proxies for wallet integration
7. Starts the frontend UI

### Run Components Manually

If you prefer to run components separately:

```bash
# Terminal 1: Start L1
anvil --port 8545 --chain-id 31337

# Terminal 2: Start L2 Fullnode (after deploying contracts)
npx tsx fullnode/deterministic-fullnode.ts \
    --l1-rpc http://localhost:8545 \
    --rollup <ROLLUP_ADDRESS> \
    --port 9546

# Terminal 3: Start Builder
npx tsx scripts/deterministic-builder.ts \
    --l1-rpc http://localhost:8545 \
    --fullnode http://localhost:9546 \
    --rollup <ROLLUP_ADDRESS> \
    --admin-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
    --port 3200

# Terminal 4: Start RPC Proxies
npx tsx scripts/rpc-proxy.ts --rpc http://localhost:8545 --builder http://localhost:3200 --port 8546
npx tsx scripts/l2-rpc-proxy.ts --rpc http://localhost:9546 --builder http://localhost:3200 --port 9548
```

### Deploy

```bash
# Set environment variables
export PRIVATE_KEY=0x...
export ADMIN_ADDRESS=0x...  # Who can sign proofs
export OWNER_ADDRESS=0x...  # Who can upgrade verifier

# Deploy to Gnosis Chain
forge script script/Deploy.s.sol --rpc-url https://rpc.gnosischain.com --broadcast
```

## Bidirectional L1↔L2 Sync

### L2→L1: Outgoing Calls (processSingleTxOnL2)

L2 contracts include `OutgoingCall[]` in state transitions. The NativeRollupCore executes these calls on L1 via deterministic proxies.

```solidity
nativeRollupCore.processSingleTxOnL2{value: depositAmount}(
    rawTransaction,       // RLP-encoded signed L2 transaction
    outgoingCalls,        // Array of L1 calls triggered by L2 execution
    expectedResults,      // Expected return data from L1 calls
    finalStateHash,       // Final L2 state after all calls
    proof                 // Proof of valid state transition chain
);
```

### L1→L2: Incoming Call Registry (registerIncomingCall + handleIncomingCall)

L1 contracts can call L2 contracts by:

1. **Prover registers expected L2 response** (off-chain execution first):
```solidity
nativeRollupCore.registerIncomingCall(
    l2Address,           // L2 contract being called
    currentStateHash,    // Current L2 state (must match l2BlockHash)
    callData,            // The call to simulate
    IncomingCallResponse({
        preOutgoingCallsStateHash: newState,  // L2 state after call
        outgoingCalls: [],                    // Any L2→L1 calls triggered
        expectedResults: [],
        returnValue: abi.encode(result),      // Return value for L1 caller
        finalStateHash: newState
    }),
    proof                // Admin signature (or ZK proof in production)
);
```

2. **L1 contract calls L2 proxy**:
```solidity
// L2Proxy.fallback() calls NativeRollupCore.handleIncomingCall()
(bool success, bytes memory result) = l2Proxy.call(callData);
```

### State Root Commitment

**Critical Invariant**: The `l2BlockHash` on L1 always matches the actual L2 state root.

The L1→L2 executor flow ensures this:
1. Execute L2 transaction first (via impersonation on test chain)
2. Get actual L2 state root from `block.stateRoot`
3. Use that exact state root as the commitment when registering on L1
4. Execute L1 transaction

This ensures L1 and L2 state are always consistent.

## L2 Proxy Address Computation

### L2SenderProxy (for L2 addresses calling L1)

```solidity
// Deployed by NativeRollupCore via CREATE2
proxyAddress = CREATE2(
    salt: keccak256(abi.encode(PROXY_SALT, l2Address)),
    bytecode: L2SenderProxy(nativeRollup, l2Address)
)
```

### L1SenderProxy (for L1 addresses calling L2)

```typescript
// Computed deterministically (not deployed, just impersonated)
const hash = keccak256(
    AbiCoder.defaultAbiCoder().encode(
        ["string", "address"],
        ["NativeRollup.L1SenderProxy.v1", l1Address]
    )
);
const l1ProxyOnL2 = "0x" + hash.slice(-40);
```

## Example: SyncedCounter

The `SyncedCounter` example demonstrates bidirectional sync:

```
┌─────────────────────┐           ┌─────────────────────┐
│   L1SyncedCounter   │           │   L2SyncedCounter   │
│                     │           │                     │
│   value: 6          │◀─────────▶│   value: 6          │
│   l2Proxy: 0x...    │           │   l1Contract: 0x... │
└─────────────────────┘           └─────────────────────┘
        │                                   │
        │ setValue(6)                       │ setValue(6)
        ▼                                   ▼
   Calls L2Proxy  ──────────────────▶  Called by L1Proxy
   (registerIncomingCall first)        (impersonated)
```

**Deployed Addresses:**
- L1SyncedCounter: `0xd30bF3219A0416602bE8D482E0396eF332b0494E`
- L2SyncedCounter: `0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512`

## Sequencer

The sequencer (`sequencer/index.ts`) watches L1 for events and replays on L2:

### Events Watched

1. **`L2BlockProcessed`**: L2→L1 flow via `processSingleTxOnL2`
2. **`IncomingCallHandled`**: L1→L2 flow via proxy calls

### L2 Replay

For each event, the sequencer:
1. Determines the L1 caller (via `debug_traceTransaction`)
2. Computes the L1 caller's proxy address on L2
3. Impersonates that proxy on L2 (Anvil only)
4. Executes the same call on L2

```typescript
// Compute L1 caller's proxy on L2
const l2ProxyOfL1Caller = "0x" + keccak256(
    encode(["string", "address"], ["NativeRollup.L1SenderProxy.v1", l1Caller])
).slice(-40);

// Impersonate and execute
await l2Provider.send("anvil_impersonateAccount", [l2ProxyOfL1Caller]);
await l2Signer.sendTransaction({ to: l2Address, data: callData });
```

## Current Deployment

**Gnosis Mainnet (January 2026):**

| Contract | Address | Gnosisscan | Blockscout |
|----------|---------|------------|------------|
| NativeRollupCore | `0x5E87A156F55c85e765C81af1312C76f8a9a1bc7d` | [View](https://gnosisscan.io/address/0x5E87A156F55c85e765C81af1312C76f8a9a1bc7d#code) | [View](https://gnosis.blockscout.com/address/0x5E87A156F55c85e765C81af1312C76f8a9a1bc7d) |
| AdminProofVerifier | `0x797dEe9c58b9F685a2B5bfa8dA6AE16875F8Ef8C` | [View](https://gnosisscan.io/address/0x797dEe9c58b9F685a2B5bfa8dA6AE16875F8Ef8C#code) | [View](https://gnosis.blockscout.com/address/0x797dEe9c58b9F685a2B5bfa8dA6AE16875F8Ef8C) |

**Deployment Details:**
- Genesis Hash: `0x0000000000000000000000000000000000000000000000000000000000000000` (matches Anvil block 0)
- Admin/Owner: `0xE5e69c567516C6C3E88ABEb2455d1228d2aF35F1`
- Compiler: solc 0.8.27
- EVM Version: cancun

**Local Testnet (via start.sh):**

Contracts are deployed fresh each time. The NativeRollupCore address is printed in the startup output.

**Service Ports:**

| Service | Port | Description |
|---------|------|-------------|
| L1 RPC (direct) | 8545 | Direct Anvil access |
| L1 RPC (proxy) | 8546 | **Use this in wallet** - routes through builder |
| L2 RPC (direct) | 9546 | Direct fullnode access |
| L2 RPC (proxy) | 9548 | **Use this in wallet** - routes through builder |
| Builder API | 3200 | Builder status and transaction submission |
| Frontend | 8080 | Web UI for deposits/withdrawals |

**Configuration:**
- L1 Chain ID: `31337`
- L2 Chain ID: `10200200`
- L2 System Address: `0x1000000000000000000000000000000000000001` (10B ETH at genesis)

## Test Accounts

| Role | Address | Private Key |
|------|---------|-------------|
| Admin | `0xE5e69c567516C6C3E88ABEb2455d1228d2aF35F1` | `0xf2024347d89be67338b62344010fb2ebc5db60cad2ff591a92a30b8215f87f22` |
| Deployer | `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266` | `0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80` |

## Running L1→L2 Executor

```bash
# Via L1SyncedCounter (indirect proxy call)
cd synchronous_surge
npx tsx scripts/l1-to-l2-executor.ts 42

# Direct proxy call from arbitrary L1 address
npx tsx scripts/direct-proxy-call.ts 0x7B2e78D4dFaABA045A167a70dA285E30E8FcA196 7
```

## Production Deployment

For production, replace `AdminProofVerifier` with:
- **ZK Verifier**: Verify SNARK/STARK proofs of L2 execution
- **TEE Verifier**: Verify SGX/TDX attestations

The `IProofVerifier` interface supports any verification mechanism:

```solidity
interface IProofVerifier {
    function verifyProof(
        bytes32 prevBlockHash,
        bytes calldata callData,
        bytes32 postExecutionStateHash,
        OutgoingCall[] calldata outgoingCalls,
        bytes[] calldata expectedResults,
        bytes32 finalStateHash,
        bytes calldata proof
    ) external view returns (bool);
}
```

## License

MIT
