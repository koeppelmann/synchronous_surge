# Native Rollup L2 Fullnode

The Fullnode deterministically syncs L2 state from L1. It watches L1 events and replays all state transitions on L2, maintaining the invariant:

```
L2 state root == l2BlockHash on L1
```

## Core Principle

**L2 state is a pure function of L1 state.**

The Fullnode doesn't need to trust anyone - it can independently reconstruct the entire L2 state by watching L1 events. This is what makes Native Rollups trustless.

## How It Works

The Fullnode watches two types of L1 events:

### 1. `L2BlockProcessed` (L2→L1 flow)

When `processCallOnL2()` is called on L1:
- Decode the `callData` from the transaction
- Execute it on L2 (as a raw transaction if RLP-encoded)

### 2. `IncomingCallHandled` (L1→L2 flow)

When an L1 contract calls an L2 proxy:
- Determine which L1 contract made the call (via `debug_traceTransaction`)
- Compute the L1 caller's proxy address on L2
- Impersonate that proxy and execute the call on L2
- For deposits: mint the value to the proxy, then transfer to recipient

## Installation

```bash
cd fullnode
npm install
```

## Configuration

Set environment variables or use defaults:

```bash
export L1_RPC=http://localhost:9545        # L1 RPC endpoint
export L2_RPC=http://localhost:9546        # L2 RPC endpoint
export ROLLUP_ADDRESS=0x...                # NativeRollupCore address
```

## Running

```bash
npx tsx index.ts
```

The fullnode will:
1. Connect to L1 and L2
2. Sync all past events
3. Watch for new events
4. Keep L2 in sync with L1

## Output Example

```
=== Native Rollup L2 Fullnode ===
L1 RPC: http://localhost:9545
L2 RPC: http://localhost:9546
NativeRollupCore: 0xfb2179498F657A1E7dE72cE29221c3a9d483a62b

L2 State on L1:
  Block number: 0
  Block hash:   0x9c8eaf493f8b4edce2ba1647343eadcc0989cf461e712c0a6253ff2ca1842bb7
  Synced:       YES

Syncing past events...
Found 0 L2BlockProcessed events
Found 1 IncomingCallHandled events
Processing incoming call to 0x7B2e78D4dFaABA045A167a70dA285E30E8FcA196...
  Value: 1.0 ETH
  L1 Caller: 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
  L2 Target: 0x7B2e78D4dFaABA045A167a70dA285E30E8FcA196
  L2 proxy of L1 caller: 0xf334baacec997bf072113826ebc2e5e4577f5a49
  L2 call result: success
  ✓ Incoming call processed
Past events synced.
Fullnode running, watching for L1 events...
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                          L1                                  │
│                                                              │
│  NativeRollupCore                                           │
│    ├─ L2BlockProcessed events                               │
│    └─ IncomingCallHandled events                            │
│                                                              │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           │ Watch events
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                       Fullnode                               │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  syncPastEvents()                                           │
│    └─▶ Query all historical events                          │
│                                                              │
│  watchEvents()                                              │
│    └─▶ Subscribe to new events                              │
│                                                              │
│  handleL2BlockProcessed()                                   │
│    └─▶ Execute L2 transaction                               │
│                                                              │
│  handleIncomingCallHandled()                                │
│    └─▶ Execute L1→L2 call with value                        │
│                                                              │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           │ Replay transactions
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                          L2                                  │
│                                                              │
│  State is deterministically reconstructed                   │
│  from L1 events                                             │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

## Programmatic Usage

```typescript
import { L2Fullnode } from './index';

const fullnode = new L2Fullnode({
  l1Rpc: 'http://localhost:9545',
  l2Rpc: 'http://localhost:9546',
  rollupAddress: '0x...',
});

// Set callbacks
fullnode.onBlock((blockNumber, hash) => {
  console.log(`Block ${blockNumber} finalized`);
});

fullnode.onIncomingCall((l2Address, caller) => {
  console.log(`Call to ${l2Address} from ${caller}`);
});

// Start syncing
await fullnode.start();

// Get status
const status = await fullnode.getStatus();
console.log(`Synced: ${status.isSynced}`);

// Stop
fullnode.stop();
```

## Notes

- Uses Anvil's `anvil_impersonateAccount` for L2 execution (POC only)
- In production, would use a proper L2 execution client
- The fullnode can verify state by comparing `l2BlockHash` on L1 with actual L2 state root
