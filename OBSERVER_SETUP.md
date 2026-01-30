# Surge Observer Node & Dashboard Setup (Gnosis)

Run a read-only L2 fullnode and dashboard to observe the Surge synchronous rollup on Gnosis — no builder keys or admin access required.

## What You Get

- **L2 Fullnode** — deterministically reconstructs all L2 state from L1 events
- **Dashboard** — shows L2 state history, balances, block explorer with Gnosisscan links
- You can view all L2 blocks, transactions, outgoing L1 calls, and their results
- You **cannot** submit new transactions (that requires the builder)

## Prerequisites

- **Node.js** v20+ and npm
- **Foundry** (`forge`, `cast`, `anvil`) — https://book.getfoundry.sh/getting-started/installation
- **Python 3** (for the dashboard HTTP server)
- **Git**

## Gnosis Deployment (January 2026)

| Contract | Address | Explorer |
|----------|---------|----------|
| NativeRollupCore | `0x7c7aBBd57007E86323F28744808C51385e8010E4` | [Gnosisscan](https://gnosisscan.io/address/0x7c7aBBd57007E86323F28744808C51385e8010E4) |
| AdminProofVerifier | `0xe0Cc4B78051aE9D39227895c3CC3CCA4C6649b50` | [Gnosisscan](https://gnosisscan.io/address/0xe0Cc4B78051aE9D39227895c3CC3CCA4C6649b50) |

- **Deployment Block:** `44428519`
- **L2 Chain ID:** `10200200`
- **Genesis State Root:** `0x473cf0cc2c7fd6e37abf75db24443096e184b9790b87d7515114729cffe2a964`

## Setup Steps

### 1. Clone the Repository

```bash
git clone https://github.com/koeppelmann/synchronous_surge.git
cd synchronous_surge
```

### 2. Compile Solidity Contracts

The fullnode needs compiled contract artifacts to deploy L2 system contracts (L2CallRegistry, L1SenderProxyL2Factory) on its internal L2 EVM.

```bash
forge build
```

This creates `out/L1SenderProxyL2.sol/` with the required JSON artifacts.

### 3. Install Node Dependencies

```bash
cd fullnode
npm install
cd ..
```

### 4. Start the L2 Fullnode

The fullnode runs an internal Anvil instance and replays all L1 events to reconstruct L2 state.

```bash
mkdir -p logs

npx tsx l2fullnode/l2-fullnode.ts \
    --l1-rpc https://rpc.gnosischain.com \
    --rollup 0x7c7aBBd57007E86323F28744808C51385e8010E4 \
    --l2-port 9546 \
    --rpc-port 9547 \
    --l1-start-block 44428519 \
    > logs/fullnode.log 2>&1 &

echo "Fullnode starting... check logs/fullnode.log"
```

**What happens:**
1. Starts an Anvil instance on port `9546` (L2 chain ID 10200200)
2. Deploys L2 system contracts (L2CallRegistry, L1SenderProxyL2Factory)
3. Fetches all `L2BlockProcessed` and `IncomingCallHandled` events from L1 starting at block `44428519`
4. Replays each event to reconstruct the exact L2 state
5. Starts polling L1 every 2 seconds for new events
6. Exposes the fullnode RPC on port `9547`

**Wait for sync (watch the log):**

```bash
tail -f logs/fullnode.log
```

You should see messages like:
```
[Fullnode] Replaying L2BlockProcessed from L1 #44423992
[Fullnode] Synced! State: 0xb7a2233b...
[Fullnode] RPC server listening on http://localhost:9547
[Fullnode] Watching L1 events (polling mode)...
```

### 5. Verify Sync

Compare your fullnode's state against the L1 contract:

```bash
# L1 contract's view of L2 state
cast call 0x7c7aBBd57007E86323F28744808C51385e8010E4 \
    "l2BlockHash()" \
    --rpc-url https://rpc.gnosischain.com

# Your fullnode's L2 state
curl -s http://localhost:9547 -X POST \
    -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","method":"nativerollup_getStateRoot","params":[],"id":1}' | python3 -m json.tool
```

Both should return the same hash. If they don't match, the fullnode is still syncing — wait a few seconds and try again.

### 6. Start the Dashboard

```bash
cd ui
python3 -m http.server 8180 > ../logs/frontend.log 2>&1 &
cd ..

echo "Dashboard at http://localhost:8180"
```

Open **http://localhost:8180** in your browser.

### 7. Configure the Dashboard

The dashboard auto-detects Gnosis mode when served on port `8180`. It will:
- Set the rollup address to `0x7c7aBBd57007E86323F28744808C51385e8010E4`
- Show Gnosisscan links for all L1 addresses and transactions
- Display values in xDAI instead of ETH

**If you need to adjust RPC endpoints**, click **"Show"** next to Settings and update:

| Setting | Value | Purpose |
|---------|-------|---------|
| L1 RPC | `https://rpc.gnosischain.com` | Direct Gnosis RPC (read-only) |
| L2 Fullnode | `http://localhost:9547` | Your local fullnode |
| L2 Proxy RPC | `http://localhost:9547` | Same as fullnode (no proxy needed) |

**Important:** Since you're not running a builder or RPC proxies, set **both** the L1 RPC and L1 Proxy RPC fields to `https://rpc.gnosischain.com` (or your preferred Gnosis RPC endpoint).

## What You'll See

### L2 State History (newest first)
- **L2 TX** blocks — L2 transactions processed via `processCallOnL2`
- **INCOMING** blocks — L1→L2 calls handled via `registerIncomingCall`
- Each block shows: state transition hash, from/to addresses, decoded calldata
- Outgoing L2→L1 calls with decoded return values (e.g., `get() ⇒ 2`)
- Address type badges: `EOA`, `L2 Contract`, `L1 Contract Proxy`, `L1 EOA Proxy`

### Chain Status
- L1 and L2 block numbers
- Current L2 state hash (verified against L1 contract)
- Sync status indicator

### Balance Table
- Auto-discovers addresses from L2 events
- Shows L1 and L2 balances side by side

## Architecture

```
┌──────────────────────┐
│    Gnosis L1         │ ← Public blockchain
│  NativeRollupCore    │
│  (events & state)    │
└──────────┬───────────┘
           │ polls every 2s
           ▼
┌──────────────────────┐
│  L2 Fullnode         │ ← Your machine
│  (Anvil + sync)      │
│  Port 9547 (RPC)     │
│  Port 9546 (EVM)     │
└──────────┬───────────┘
           │ queries
           ▼
┌──────────────────────┐
│  Dashboard           │ ← Your browser
│  http://localhost:8180│
└──────────────────────┘
```

The fullnode derives **all** L2 state purely from L1 events. No trust assumptions — you can independently verify every state transition.

## Useful Commands

```bash
# Check L2 block number
curl -s http://localhost:9547 -X POST \
    -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' | python3 -m json.tool

# Check an L2 balance
cast balance 0x7B2e78D4dFaABA045A167a70dA285E30E8FcA196 --rpc-url http://localhost:9547

# Check L2 contract code
cast code 0xC709f9dDcDC486BCCbab4d089de60c4483b6bae1 --rpc-url http://localhost:9547

# View fullnode logs
tail -f logs/fullnode.log

# Stop everything
kill $(lsof -ti:9546) $(lsof -ti:9547) $(lsof -ti:8180) 2>/dev/null
```

## Alternative: Use Your Own Gnosis RPC

The default `https://rpc.gnosischain.com` may be rate-limited. For better performance, use:

- [Ankr](https://rpc.ankr.com/gnosis) — `https://rpc.ankr.com/gnosis`
- [POKT](https://gnosischain-rpc.gateway.pokt.network) — `https://gnosischain-rpc.gateway.pokt.network`
- Run your own Gnosis node (Nethermind/Erigon + Lighthouse)

Pass your preferred RPC URL with `--l1-rpc`:

```bash
npx tsx l2fullnode/l2-fullnode.ts \
    --l1-rpc https://rpc.ankr.com/gnosis \
    --rollup 0x7c7aBBd57007E86323F28744808C51385e8010E4 \
    --l2-port 9546 \
    --rpc-port 9547 \
    --l1-start-block 44428519
```

## Troubleshooting

### "Could not find artifact for L2CallRegistry"
Run `forge build` in the repository root. The fullnode needs compiled Solidity artifacts in `out/`.

### State root mismatch after sync
The fullnode may still be replaying historical events. Wait until you see `Synced!` in the log, then compare again.

### Dashboard shows "—" for L2 values
Check that the fullnode is running on port `9547`. Open browser console (F12) for error details.

### Rate limiting from Gnosis RPC
Use an alternative RPC provider (see above) or add a small delay by running your own Gnosis node.

### Dashboard doesn't show Gnosisscan links
Make sure you're accessing the dashboard on port `8180` — Gnosis mode is auto-detected from this port.
