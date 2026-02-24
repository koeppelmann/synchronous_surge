# CLAUDE.md

Project-specific instructions for Claude Code.

## Contract Verification on Gnosisscan (Etherscan V2 API)

Etherscan has migrated to API V2. Forge's built-in verification does not yet support V2, so use curl directly.


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

## Current Deployment (February 2026)

| Contract | Address | Gnosisscan | Blockscout |
|----------|---------|------------|------------|
| NativeRollupCore | `0x2F685bc8f4C4c5faBEe6817a9764Edee7B1bc26C` | [View](https://gnosisscan.io/address/0x2F685bc8f4C4c5faBEe6817a9764Edee7B1bc26C#code) | [View](https://gnosis.blockscout.com/address/0x2F685bc8f4C4c5faBEe6817a9764Edee7B1bc26C) |
| AdminProofVerifier | `0xfA817b7BF6DE448818B52709A3939Ae7046B0223` | [View](https://gnosisscan.io/address/0xfA817b7BF6DE448818B52709A3939Ae7046B0223#code) | [View](https://gnosis.blockscout.com/address/0xfA817b7BF6DE448818B52709A3939Ae7046B0223) |
| TokenBridgeVault (L1) | `0x69c02E7dBD6388d006Da932DF90F3215F54A4368` | [View](https://gnosisscan.io/address/0x69c02E7dBD6388d006Da932DF90F3215F54A4368#code) | [View](https://gnosis.blockscout.com/address/0x69c02E7dBD6388d006Da932DF90F3215F54A4368) |
| LoggerWithStorage (L1) | `0xd988A3c2465aDc0fc210739988f24E2d29daA7D8` | [View](https://gnosisscan.io/address/0xd988A3c2465aDc0fc210739988f24E2d29daA7D8#code) | [View](https://gnosis.blockscout.com/address/0xd988A3c2465aDc0fc210739988f24E2d29daA7D8) |

**L2 Contracts:**
| Contract | Address |
|----------|---------|
| TokenBridgeL2 | `0xFf03cC4d43ea9d033f7A4c9FB87057e9fbC143Ea` |
| Counter | `0x8e8f5880BaCF9DCbE786623E5D4724B96D80A56f` |
| Counter L2SenderProxy (L1) | `0x226e4ef684612F65C7849e3866df5a745470064A` |

**Deployment Details:**
- Deployment Block: `44613529`
- Genesis Hash: `0x30909382f429ea0dbe44c276c1cd2b7bd1d23a21ed301a9a61833c3e814f1bb3`
- Compiler: solc 0.8.27
- EVM Version: cancun

## Deployment Accounts

| Role | Address | Private Key |
|------|---------|-------------|
| Admin/Owner | `0xE5e69c567516C6C3E88ABEb2455d1228d2aF35F1` | 
