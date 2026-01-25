# Native Rollup Builder

The Builder is responsible for creating L2 state transitions and submitting them to L1. It handles two types of operations:

1. **L2 EOA Transactions** - User transactions executed on L2
2. **L1→L2 Contract Calls** - L1 contracts calling L2 contracts (including deposits)

## How It Works

The Builder acts as a "prover" in POC mode:

1. **Execute on L2 first** - Runs the transaction on L2 to get the resulting state root
2. **Sign proof** - Signs the state transition with the admin key (ZK proof in production)
3. **Submit to L1** - Calls `registerIncomingCall()` or `processCallOnL2()` on NativeRollupCore
4. **Execute L1 call** - For L1→L2 calls, triggers the proxy call on L1

This ensures the L1 commitment always matches the actual L2 state root.

## Installation

```bash
cd builder
npm install
```

## Configuration

Set environment variables or use defaults:

```bash
export L1_RPC=http://localhost:9545        # L1 RPC endpoint
export L2_RPC=http://localhost:9546        # L2 RPC endpoint
export ROLLUP_ADDRESS=0x...                # NativeRollupCore address
export ADMIN_PK=0x...                      # Admin private key for signing proofs
```

## Commands

### Check Status

```bash
npx tsx index.ts status
```

Shows current L2 state on L1 vs actual L2 state root, and whether they match.

### Deposit xDAI to L2

Bridge xDAI from L1 to an L2 EOA:

```bash
npx tsx index.ts deposit <l1Caller> <l2Recipient> <amountWei>

# Example: Deposit 1 xDAI
npx tsx index.ts deposit \
  0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 \
  0x7B2e78D4dFaABA045A167a70dA285E30E8FcA196 \
  1000000000000000000
```

- `l1Caller`: Any L1 address (will be impersonated to send the deposit)
- `l2Recipient`: The EOA on L2 that receives the xDAI
- `amountWei`: Amount in wei (1 xDAI = 1000000000000000000)

### L2 EOA Transaction

Execute a transaction on L2 from an EOA:

```bash
npx tsx index.ts l2-tx <from> <to> [value] [data]

# Example: Transfer 0.5 ETH on L2
npx tsx index.ts l2-tx \
  0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 \
  0x70997970C51812dc3A010C7d01b50e0d17dc79C8 \
  500000000000000000
```

### L1→L2 Contract Call

Have an L1 contract call an L2 contract:

```bash
npx tsx index.ts l1-to-l2 <l1Caller> <l2Target> [callData]

# Example: Call setValue(42) on L2SyncedCounter
npx tsx index.ts l1-to-l2 \
  0xd30bF3219A0416602bE8D482E0396eF332b0494E \
  0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512 \
  0x55241077000000000000000000000000000000000000000000000000000000000000002a
```

### Prepare Only (Don't Execute L1)

Register the incoming call response without executing the L1 call:

```bash
npx tsx index.ts prepare <l1Caller> <l2Target> [callData]
```

## Architecture

```
User Request
     │
     ▼
┌─────────────────────────────────────────────────────────────┐
│                        Builder                               │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  1. Execute on L2 (via impersonation)                       │
│     └─▶ Get actual L2 state root                            │
│                                                              │
│  2. Sign proof (admin signature in POC)                     │
│     └─▶ In production: ZK proof of execution                │
│                                                              │
│  3. Register on L1                                          │
│     └─▶ registerIncomingCall() or processCallOnL2()         │
│                                                              │
│  4. Execute L1 call (for L1→L2)                             │
│     └─▶ Call the L2 proxy on L1                             │
│                                                              │
└─────────────────────────────────────────────────────────────┘
     │
     ▼
L1 commitment == L2 state root (invariant maintained)
```

## Notes

- The Builder uses Anvil's `anvil_impersonateAccount` for testing
- In production, users would sign real transactions
- The admin key is only for POC - production uses ZK proofs
