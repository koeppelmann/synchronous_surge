# CLAUDE.md

Project-specific instructions for Claude Code.

## Contract Verification on Gnosisscan (Etherscan V2 API)

Etherscan has migrated to API V2. Forge's built-in verification does not yet support V2, so use curl directly.

### API Key
```
3ARSB3HVTB4W5MW463BDJU35J4H94FTJRR
```

### Step 1: Generate Standard JSON Input
```bash
forge verify-contract <ADDRESS> <CONTRACT_PATH>:<CONTRACT_NAME> --show-standard-json-input > /tmp/contract_standard_json.json
```

### Step 2: Submit Verification via Curl
```bash
curl -X POST "https://api.etherscan.io/v2/api?chainid=100" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "module=contract" \
  --data-urlencode "action=verifysourcecode" \
  --data-urlencode "apikey=3ARSB3HVTB4W5MW463BDJU35J4H94FTJRR" \
  --data-urlencode "contractaddress=<CONTRACT_ADDRESS>" \
  --data-urlencode "sourceCode@/tmp/contract_standard_json.json" \
  --data-urlencode "codeformat=solidity-standard-json-input" \
  --data-urlencode "contractname=<PATH>:<NAME>" \
  --data-urlencode "compilerversion=v0.8.27+commit.40a35a09" \
  --data-urlencode "constructorArguements=<ABI_ENCODED_ARGS_WITHOUT_0x>"
```

**Note:** `constructorArguements` is intentionally misspelled (Etherscan API quirk).

### Step 3: Check Verification Status
```bash
curl "https://api.etherscan.io/v2/api?chainid=100&module=contract&action=checkverifystatus&guid=<GUID_FROM_STEP_2>&apikey=3ARSB3HVTB4W5MW463BDJU35J4H94FTJRR"
```

### Generating Constructor Arguments
```bash
cast abi-encode "constructor(bytes32,address,address)" 0x... 0x... 0x...
# Remove the leading 0x for the API call
```

### Supported Chain IDs
- Gnosis: 100
- Ethereum Mainnet: 1
- Full list: https://api.etherscan.io/v2/chainlist

### Blockscout Verification (Alternative)
Blockscout verification still works with forge:
```bash
forge verify-contract <ADDRESS> <CONTRACT> --verifier blockscout --verifier-url "https://gnosis.blockscout.com/api/" --chain-id 100
```

### Sourcify Verification (Alternative)
```bash
forge verify-contract <ADDRESS> <CONTRACT> --verifier sourcify --chain-id 100
```

## Current Deployment (January 2026)

| Contract | Address | Gnosisscan | Blockscout |
|----------|---------|------------|------------|
| NativeRollupCore | `0x5E87A156F55c85e765C81af1312C76f8a9a1bc7d` | [View](https://gnosisscan.io/address/0x5E87A156F55c85e765C81af1312C76f8a9a1bc7d#code) | [View](https://gnosis.blockscout.com/address/0x5E87A156F55c85e765C81af1312C76f8a9a1bc7d) |
| AdminProofVerifier | `0x797dEe9c58b9F685a2B5bfa8dA6AE16875F8Ef8C` | [View](https://gnosisscan.io/address/0x797dEe9c58b9F685a2B5bfa8dA6AE16875F8Ef8C#code) | [View](https://gnosis.blockscout.com/address/0x797dEe9c58b9F685a2B5bfa8dA6AE16875F8Ef8C) |

**Deployment Details:**
- Genesis Hash: `0x0000000000000000000000000000000000000000000000000000000000000000` (matches Anvil block 0)
- Compiler: solc 0.8.27
- EVM Version: cancun

## Deployment Accounts

| Role | Address | Private Key |
|------|---------|-------------|
| Admin/Owner | `0xE5e69c567516C6C3E88ABEb2455d1228d2aF35F1` | `0xf2024347d89be67338b62344010fb2ebc5db60cad2ff591a92a30b8215f87f22` |
