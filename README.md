# Synchronous Surge - Native Rollup Core

A minimal implementation of **Native Rollups** - L2s where state is a pure function of L1 state, proven and verified atomically with block submission.

## Overview

Native Rollups eliminate the 7-day withdrawal delays of optimistic rollups by proving each L2 state transition at submission time. This enables **instant L2→L1 bridging** and **synchronous cross-chain composability**.

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
- **Proper `msg.sender`**: Each L2 address has a deterministic L1 proxy for correct caller identity
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
│  │  - processCallOnL2()│                                   │
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
```

## Contracts

| Contract | Description |
|----------|-------------|
| `NativeRollupCore` | Main rollup contract - tracks L2 state, processes blocks, executes L1 calls |
| `L2SenderProxy` | Minimal proxy deployed per L2 address for proper `msg.sender` on L1 |
| `IProofVerifier` | Interface for proof verification (ZK, TEE, or admin signature) |
| `AdminProofVerifier` | POC verifier using admin signatures (replace for production) |

## Usage

### Build

```bash
forge build
```

### Test

```bash
forge test
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

### Process an L2 Block

```solidity
// Process L2 state transition with outgoing L1 calls
nativeRollupCore.processCallOnL2{value: depositAmount}(
    prevL2BlockHash,      // Current L2 state commitment
    callData,             // Input that was "executed" on L2
    resultL2BlockHash,    // New L2 state commitment
    outgoingCalls,        // Array of L1 calls triggered by L2
    expectedResults,      // Expected return data from L1 calls
    proof                 // Proof of valid state transition
);
```

### L2→L1 Call Structure

```solidity
struct Call {
    address from;    // L2 contract initiating the call
    address target;  // L1 contract to call
    uint256 value;   // ETH to send
    uint256 gas;     // Gas limit
    bytes data;      // Calldata
}
```

## Example: L2 Contract Calling Circles on L1

```solidity
// L2 organization contract wants to register on L1 Circles Hub
Call[] memory calls = new Call[](1);
calls[0] = Call({
    from: L2_ORG_ADDRESS,           // L2 contract address
    target: CIRCLES_HUB_V2,         // L1 Circles Hub
    value: 0,
    gas: 200000,
    data: abi.encodeCall(IHub.registerOrganization, ("MyOrg", metadataHash))
});

// The call will be executed from the L2SenderProxy for L2_ORG_ADDRESS
// Circles Hub sees msg.sender = getProxyAddress(L2_ORG_ADDRESS)
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
        bytes32 resultBlockHash,
        Call[] calldata outgoingCalls,
        bytes[] calldata expectedResults,
        bytes calldata proof
    ) external view returns (bool);
}
```

## Current Deployment

**Gnosis Mainnet:**
| Contract | Address |
|----------|---------|
| NativeRollupCore | `0xA18282e7294342477013bfD224Bb66e47ca3164F` |
| AdminProofVerifier | `0xBf0a7308545a0B8edC3326a0F54Cca692C1Ce379` |

## License

MIT
