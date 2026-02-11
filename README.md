# Synchronous Rollup

A minimal implementation of **Synchronous Rollups** - L2s where state is a pure function of L1 state, proven and verified atomically with block submission.

## Quick Start

### Local Testnet

Start a complete local environment with a single command:

```bash
./tools/start.sh
```

This starts:
- **L1 Anvil** (port 8545) - Local Ethereum chain
- **L2 Fullnode** (port 9546) - Deterministic L2 derived from L1
- **Builder** (port 3200) - Processes transactions and submits proofs
- **L1 RPC Proxy** (port 8546) - Routes wallet transactions through builder
- **L2 RPC Proxy** (port 9548) - Routes L2 transactions through builder
- **Frontend** (port 8080) - Web UI for deposits/withdrawals

### Gnosis Mainnet

Run against the live Gnosis Chain deployment:

```bash
cp .env.example .env
# Edit .env — set ADMIN_PRIVATE_KEY for full mode, or leave it out for read-only
./tools/startGnosis.sh
```

**Read-only mode** (no `ADMIN_PRIVATE_KEY`): starts fullnode + frontend only — observe L2 state derived from L1 events.

**Full mode** (with `ADMIN_PRIVATE_KEY`): also starts builder + RPC proxies for submitting transactions.

| Service | Port | Description |
|---------|------|-------------|
| L2 Fullnode RPC | 9547 | Read-only L2 state |
| Frontend | 8180 | Web UI |
| L1 RPC Proxy | 8646 | Use in wallet (full mode) |
| L2 RPC Proxy | 9648 | Use in wallet (full mode) |
| Builder API | 3200 | Transaction submission (full mode) |

### Wallet Setup

Add these networks to your wallet (e.g., MetaMask, Rabby):

| Network | Chain ID | RPC URL |
|---------|----------|---------|
| L1 (local) | 31337 | `http://localhost:8546` |
| L1 (Gnosis) | 100 | `http://localhost:8646` |
| L2 | 10200200 | `http://localhost:9548` (local) or `http://localhost:9648` (Gnosis) |

**Important:** Use the proxy ports, not the direct RPC ports, so transactions are routed through the builder.

### Stop Everything

```bash
./tools/stop.sh
# or just Ctrl+C in the terminal running start.sh / startGnosis.sh
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
3. May trigger outgoing L1 calls (with return values fed back to L2)
4. Is proven and verified atomically in a single transaction

### Key Features

- **Instant Finality**: No withdrawal delays - state is proven immediately
- **L2→L1 Calls**: L2 contracts can call L1 contracts synchronously and use return values
- **L1→L2 Calls**: L1 contracts can call L2 contracts via pre-registered responses
- **Proper `msg.sender`**: Each address has a deterministic proxy for correct caller identity
- **Real State Roots**: L1 commitment always matches actual L2 state root
- **Queue-Based Call Registry**: Supports repeated identical calls with different return values
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
│  │  - processSingleTxOnL2                                  │
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
                     │    Builder      │
                     │  (TypeScript)   │
                     │  - Detect calls │
                     │  - Simulate L1  │
                     │  - Submit proof │
                     └────────┬────────┘
                              │
┌──────────────────┐          │          ┌──────────────────┐
│   L2 Fullnode    │◀─────────┘          │   L2 Fullnode    │
│   (read-only)    │                     │  (builder's)     │
│   Derives state  │                     │  For simulation  │
│   from L1 events │                     │  and discovery   │
└──────────────────┘                     └──────────────────┘
```

### Dual Fullnode Architecture

The system runs two independent L2 fullnodes:

1. **Read-only fullnode** — Derives L2 state purely by replaying L1 events. This is what observers and the frontend connect to.
2. **Builder's private fullnode** — Used by the builder for transaction simulation, outgoing call detection, and state root computation before submitting to L1.

Both fullnodes independently derive identical state from L1 events.

## Contracts

| Contract | Description |
|----------|-------------|
| `NativeRollupCore` | Main rollup contract - tracks L2 state, processes blocks, executes L1 calls |
| `L2SenderProxy` | Minimal proxy deployed per L2 address for proper `msg.sender` on L1 |
| `L1SenderProxyL2` | L2-side proxy for L1 addresses, routes calls through the call registry |
| `L2CallRegistry` | Queue-based registry mapping L2→L1 call keys to pre-registered return values |
| `L1SenderProxyL2Factory` | Factory for deploying L1 sender proxies on L2 |
| `IProofVerifier` | Interface for proof verification (ZK, TEE, or admin signature) |
| `AdminProofVerifier` | POC verifier using admin signatures (replace for production) |

### L2CallRegistry (Queue-Based)

When an L2 contract calls an L1 contract, the return value must be known in advance. The `L2CallRegistry` stores these pre-registered return values in a queue per call key (`keccak256(l1Address, l2Caller, callData)`):

- **`registerReturnValue(key, data)`** — Appends a return value to the queue for a call key
- **`getReturnValue(key)`** — Consumes the next return value from the queue (FIFO)
- **`clearReturnValues(keys)`** — Clears stale entries before re-registering (prevents stale data)

This design supports:
- Updated return values across transactions (clear + re-register)
- Multiple identical calls within one transaction (each gets the next queued value)

## Components

### Fullnode (`l2fullnode/l2-fullnode.ts`)

The L2 Fullnode deterministically syncs L2 state from L1. It:
- Watches L1 for `L2BlockProcessed` and `IncomingCallHandled` events
- Replays all state transitions on a local Anvil instance
- Deploys L2 system contracts (L2CallRegistry, L1SenderProxyL2Factory) at genesis
- Maintains the invariant: L2 state root == `l2BlockHash` on L1

### Builder (`builder/builder.ts`)

The Builder is an HTTP server that processes transactions:

**POST `/submit`** — Submit a transaction for processing
```json
{
  "signedTx": "0x...",
  "sourceChain": "L2",
  "hints": { "l1TargetAddress": "0x..." }
}
```

**GET `/status`** — Check builder and sync status

For L2 transactions with outgoing L1 calls, the builder:
1. Detects outgoing L2→L1 calls by tracing the transaction
2. Simulates each L1 call to get return values
3. Pre-registers return values in the L2CallRegistry
4. Executes the L2 transaction (outgoing calls now succeed via registry)
5. Submits `processSingleTxOnL2` to L1 with proof

### RPC Proxies

- **`builder/rpc-proxy.ts`** — L1 RPC proxy, intercepts `eth_sendRawTransaction` and routes through builder
- **`builder/l2-rpc-proxy.ts`** — L2 RPC proxy, intercepts L2 transactions and routes through builder

## Scripts

| Script | Description |
|--------|-------------|
| `tools/start.sh` | Start local testnet (L1 Anvil + full stack) |
| `tools/startGnosis.sh` | Start against Gnosis mainnet (reads `.env`) |
| `tools/stop.sh` | Stop all running components |
| `builder/builder.ts` | Builder HTTP server |
| `builder/rpc-proxy.ts` | L1 RPC proxy |
| `builder/l2-rpc-proxy.ts` | L2 RPC proxy |
| `deploy/deploy-gnosis.ts` | Deploy contracts to Gnosis mainnet |
| `deploy/test-registry-queue.ts` | End-to-end test for L2CallRegistry queue fix |

## Usage

### Build

```bash
forge build
```

### Test

```bash
# Solidity tests
forge test

# End-to-end registry queue test (starts local L1 + fullnode + builder)
npx tsx deploy/test-registry-queue.ts
```

### Run Full Stack

```bash
# Local testnet
./tools/start.sh

# Gnosis mainnet
cp .env.example .env   # Configure addresses and optionally ADMIN_PRIVATE_KEY
./tools/startGnosis.sh
```

### Run Components Manually

```bash
# Terminal 1: Start L1
anvil --port 8545 --chain-id 31337

# Terminal 2: Start L2 Fullnode (after deploying contracts)
npx tsx l2fullnode/l2-fullnode.ts \
    --l1-rpc http://localhost:8545 \
    --rollup <ROLLUP_ADDRESS> \
    --l2-port 9546 \
    --rpc-port 9547

# Terminal 3: Start Builder
npx tsx builder/builder.ts \
    --l1-rpc http://localhost:8545 \
    --fullnode http://localhost:9547 \
    --rollup <ROLLUP_ADDRESS> \
    --admin-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
    --port 3200

# Terminal 4: Start RPC Proxies
npx tsx builder/rpc-proxy.ts --rpc http://localhost:8545 --builder http://localhost:3200 --port 8546
npx tsx builder/l2-rpc-proxy.ts --rpc http://localhost:9547 --builder http://localhost:3200 --port 9548
```

### Deploy to Gnosis

```bash
ADMIN_PK=0x... npx tsx deploy/deploy-gnosis.ts --deploy
```

This deploys `NativeRollupCore` and `AdminProofVerifier` to Gnosis Chain and writes `gnosis-deployment.json`.

## Bidirectional L1↔L2 Composability

### L2→L1: Outgoing Calls

L2 contracts can call L1 contracts synchronously. The builder detects these calls, simulates them on L1, and pre-registers the return values so the L2 execution succeeds:

```solidity
// L2 contract calls an L1 contract through its proxy
uint256 value = ITarget(l2ProxyOfL1Contract).get();
// 'value' contains the actual L1 return value
```

Under the hood:
1. Builder traces the L2 tx, finds calls to L1SenderProxyL2 contracts
2. Simulates each call on L1 to get return values
3. Registers return values in L2CallRegistry (queue-based)
4. Executes the L2 tx — proxy reads return value from registry
5. Submits to L1 with outgoing calls — L1 verifies results match

### L1→L2: Incoming Calls

L1 contracts can call L2 contracts by:

1. **Prover registers expected L2 response** (off-chain execution first):
```solidity
nativeRollupCore.registerIncomingCall(
    l2Address,           // L2 contract being called
    currentStateHash,    // Current L2 state (must match l2BlockHash)
    callData,            // The call to simulate
    response,            // Pre-computed L2 response with state transition
    proof                // Admin signature (or ZK proof in production)
);
```

2. **L1 contract calls L2 proxy**:
```solidity
(bool success, bytes memory result) = l2Proxy.call(callData);
```

### State Root Commitment

**Critical Invariant**: The `l2BlockHash` on L1 always matches the actual L2 state root.

The builder ensures this by:
1. Executing the L2 transaction on its private fullnode
2. Reading the actual state root from the L2 EVM
3. Submitting that exact state root as the commitment to L1
4. The read-only fullnode independently derives the same state by replaying L1 events

## Current Deployment

**Gnosis Mainnet (February 2026):**

### Core Contracts

| Contract | Address | Explorer |
|----------|---------|----------|
| NativeRollupCore | `0x2F685bc8f4C4c5faBEe6817a9764Edee7B1bc26C` | [Gnosisscan](https://gnosisscan.io/address/0x2F685bc8f4C4c5faBEe6817a9764Edee7B1bc26C) |
| AdminProofVerifier | `0xfA817b7BF6DE448818B52709A3939Ae7046B0223` | [Gnosisscan](https://gnosisscan.io/address/0xfA817b7BF6DE448818B52709A3939Ae7046B0223) |

### Bridge Contracts

| Contract | Address | Layer |
|----------|---------|-------|
| TokenBridgeVault | `0x69c02E7dBD6388d006Da932DF90F3215F54A4368` | L1 |
| TokenBridgeL2 | `0xFf03cC4d43ea9d033f7A4c9FB87057e9fbC143Ea` | L2 |
| L2SenderProxy (Bridge) | `0x007Cf8A73fccD751f27c02D6eA5917f1AAa5c7BD` | L1 |
| L1SenderProxyL2 (Vault) | `0x68c6f743461e8ac7b7848388B79c46b07535ec57` | L2 |
| BridgedUSDC | `0x84E91d42ac8fcF49Bc777BC9ea15F82dDC60bB1a` | L2 |

### L2 System Contracts

| Contract | Address |
|----------|---------|
| L2CallRegistry | `0xF2E246BB76DF876Cef8b38ae84130F4F55De395b` |
| L1SenderProxyL2Factory | `0x2946259E0334f33A064106302415aD3391BeD384` |

### Example Contracts

| Contract | Address | Layer | Description |
|----------|---------|-------|-------------|
| Counter | `0x8e8f5880BaCF9DCbE786623E5D4724B96D80A56f` | L2 | Simple counter, increments on each call |
| Counter L2SenderProxy | `0x226e4ef684612F65C7849e3866df5a745470064A` | L1 | Proxy for calling Counter from L1 |
| LoggerWithStorage | `0xd988A3c2465aDc0fc210739988f24E2d29daA7D8` | L1 | Logs L1→L2 calls with return values |

**Deployment Details:**
- Deployment Block: `44613529`
- Genesis State Root: `0x30909382f429ea0dbe44c276c1cd2b7bd1d23a21ed301a9a61833c3e814f1bb3`
- Admin/Owner: `0xE5e69c567516C6C3E88ABEb2455d1228d2aF35F1`
- L2 Chain ID: `10200200`
- Compiler: solc 0.8.27, EVM: cancun

**Local Testnet (via `start.sh`):**

Contracts are deployed fresh each time. The NativeRollupCore address is printed in the startup output.

## L2 Proxy Address Computation

### L2SenderProxy (for L2 addresses calling L1)

```solidity
// Deployed by NativeRollupCore via CREATE2
proxyAddress = CREATE2(
    salt: keccak256(abi.encode(PROXY_SALT, l2Address)),
    bytecode: L2SenderProxy(nativeRollup, l2Address)
)
```

### L1SenderProxyL2 (for L1 addresses calling L2)

```solidity
// Deployed by L1SenderProxyL2Factory via CREATE2
proxyAddress = CREATE2(
    salt: keccak256(abi.encode(l1Address)),
    bytecode: L1SenderProxyL2(l1Address, callRegistry)
)
```

## Configuration

### `.env` file (for Gnosis deployment)

```bash
cp .env.example .env
```

See `.env.example` for all available options. Key settings:

| Variable | Required | Description |
|----------|----------|-------------|
| `ADMIN_PRIVATE_KEY` | No | Admin key for builder (omit for read-only mode) |
| `ROLLUP_ADDRESS` | Yes | NativeRollupCore contract address |
| `DEPLOYMENT_BLOCK` | Yes | Block number of contract deployment |
| `L1_RPC` | No | L1 RPC URL (default: `https://rpc.gnosischain.com`) |

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
