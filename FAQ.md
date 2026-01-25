# Frequently Asked Questions

## What is a Native Rollup?

A Native Rollup is an L2 where **every block is proven and verified atomically** in a single L1 transaction. This eliminates the 7-day withdrawal delays of optimistic rollups because:

- There's no "challenge period" - state is proven immediately
- L2 state is a **pure function** of L1 state
- Anyone can independently verify L2 state by watching L1

## How do I bridge xDAI from L1 to L2?

Use the Builder's `deposit` command:

```bash
cd builder

# Deposit 1 xDAI to an L2 address
ROLLUP_ADDRESS=<rollup_address> npx tsx index.ts deposit \
  <any_l1_address> \
  <l2_recipient> \
  1000000000000000000

# Example:
ROLLUP_ADDRESS=0xfb2179498F657A1E7dE72cE29221c3a9d483a62b npx tsx index.ts deposit \
  0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 \
  0x7B2e78D4dFaABA045A167a70dA285E30E8FcA196 \
  1000000000000000000
```

**How it works:**
1. A proxy for the L2 recipient is deployed on L1 (if not already)
2. xDAI is sent to that proxy with value
3. The proxy forwards to `NativeRollupCore.handleIncomingCall()`
4. On L2, the value is "minted" to the L1 caller's proxy
5. The proxy transfers the xDAI to the recipient EOA

The entire process is atomic and the L2 balance is available immediately.

## How do I bridge xDAI from L2 to L1?

L2→L1 withdrawals use the `processCallOnL2` function with an outgoing call:

1. L2 contract initiates withdrawal (outgoing call to L1)
2. Builder submits `processCallOnL2` with the outgoing call
3. L1 receives the xDAI immediately (no waiting period!)

This is the key advantage of Native Rollups - **instant withdrawals**.

## What's the difference between Fullnode and Builder?

| Component | Purpose | Who runs it |
|-----------|---------|-------------|
| **Fullnode** | Syncs L2 state from L1 | Anyone who wants to verify/read L2 state |
| **Builder** | Creates and submits L2 state transitions | Sequencer/Prover (centralized in POC) |

The Fullnode is **trustless** - anyone can run it and verify the L2 state.

The Builder is **trusted** in POC mode (admin signatures), but would be trustless with ZK proofs.

## How does L1→L2 composability work?

L1 contracts can call L2 contracts synchronously:

1. **Pre-register response**: Builder executes on L2 first, registers the expected response
2. **L1 calls proxy**: L1 contract calls the L2 contract's proxy on L1
3. **Proxy returns**: The pre-registered return value is returned
4. **State updates**: L2 state root is updated atomically

```solidity
// L1 contract can call L2 contract like this:
(bool success, bytes memory result) = l2ContractProxy.call(
    abi.encodeCall(IL2Contract.someFunction, (arg1, arg2))
);
// result contains the L2 contract's return value!
```

## How does L2→L1 composability work?

L2 contracts can call L1 contracts via outgoing calls:

1. L2 transaction includes `OutgoingCall[]` array
2. Builder submits to L1 via `processCallOnL2()`
3. Each outgoing call is executed on L1 via `L2SenderProxy`
4. Return values are verified against expectations

The `msg.sender` on L1 is the L2 contract's deterministic proxy address.

## What is the L2SenderProxy?

Each L2 address has a corresponding proxy on L1, deployed via CREATE2:

```
L2 Address: 0x1234...
L1 Proxy:   getProxyAddress(0x1234...) → 0xABCD...
```

When L2 contract `0x1234` calls L1, the call comes from `0xABCD`. This ensures proper `msg.sender` identity on L1.

## What is the L1SenderProxy (on L2)?

Each L1 address has a corresponding proxy address on L2, computed deterministically:

```typescript
const l1ProxyOnL2 = keccak256(
  encode(["string", "address"], ["NativeRollup.L1SenderProxy.v1", l1Address])
).slice(-40);
```

When L1 contract `0x1234` calls L2, the `msg.sender` on L2 is this deterministic proxy address.

## How do I run the local testnet?

```bash
# Terminal 1: Start L1 (Gnosis fork)
anvil --fork-url https://rpc.gnosischain.com --port 9545

# Terminal 2: Start L2 (fresh chain)
anvil --chain-id 10200200 --port 9546

# Terminal 3: Deploy contracts
cd synchronous_surge
PRIVATE_KEY=0x... GENESIS_BLOCK_HASH=<l2_state_root> \
  forge script script/Deploy.s.sol --rpc-url http://localhost:9545 --broadcast

# Terminal 4: Run fullnode (optional)
cd fullnode && ROLLUP_ADDRESS=<address> npx tsx index.ts
```

## Why does L2 state root need to match l2BlockHash on L1?

This is the **core invariant** of Native Rollups:

```
L2 state root == l2BlockHash on L1
```

If they ever diverge, it means:
- Either the Builder submitted an invalid state transition
- Or the Fullnode has a bug

Anyone can verify this by:
1. Running a Fullnode to get actual L2 state root
2. Reading `l2BlockHash` from L1
3. Comparing them

## What happens if I run the Fullnode on a fresh L2?

The Fullnode will:
1. Query all past L1 events
2. Replay each state transition on L2
3. End up with the same L2 state as the Builder submitted

This is how you can independently verify the L2 state is correct.

## Is this production-ready?

**No.** This is a POC (Proof of Concept) with:

- Admin signatures instead of ZK proofs
- Anvil impersonation instead of real transaction signing
- No fraud proofs or slashing
- Centralized Builder

For production, you would need:
- ZK proof verification (SP1, Risc0, etc.)
- Decentralized sequencing
- Proper L2 execution client (not Anvil)
- Economic security (staking, slashing)

## How is this different from optimistic rollups?

| Feature | Native Rollup | Optimistic Rollup |
|---------|---------------|-------------------|
| Withdrawal time | **Instant** | 7 days |
| State verification | Every block | Only if challenged |
| Trust assumption | Cryptographic proof | Economic (fraud proofs) |
| L1→L2 composability | **Synchronous** | Asynchronous |
| L2→L1 composability | **Synchronous** | Asynchronous (7 day delay) |
