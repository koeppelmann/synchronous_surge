/**
 * E2E Test: Token Bridge (Deposit L1→L2 and Withdraw L2→L1)
 *
 * Sets up a complete local environment:
 *   1. L1 Anvil + deploy NativeRollupCore
 *   2. L2 Fullnode (builder mode)
 *   3. Builder
 *   4. Deploy MockERC20 + TokenBridgeVault on L1
 *   5. Deploy TokenBridgeL2 on L2 (via builder)
 *
 * Test scenarios:
 *   TEST 1: Deposit - Lock ERC20 on L1, mint bridged tokens on L2
 *   TEST 2: Withdraw - Burn bridged tokens on L2, release ERC20 on L1
 *
 * Usage:
 *   npx tsx deploy/test-token-bridge.ts
 */

import {
  ethers,
  JsonRpcProvider,
  Wallet,
  Contract,
  ContractFactory,
  Transaction,
} from "ethers";
import { spawn, ChildProcess, execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

// Ports (avoid clashing with running services)
const L1_PORT = 18545;
const L2_EVM_PORT = 19546;
const FULLNODE_RPC_PORT = 19547;
const BUILDER_L2_PORT = 19549;
const BUILDER_FULLNODE_PORT = 19550;
const BUILDER_PORT = 13200;

// Test accounts (Anvil defaults)
const ADMIN_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const USER_PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const SYSTEM_PK = "0x0000000000000000000000000000000000000000000000000000000000000001";

const L2_CHAIN_ID = 10200200;

// Colors
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const BLUE = "\x1b[34m";
const NC = "\x1b[0m";

function log(msg: string) { console.log(`${BLUE}[TEST]${NC} ${msg}`); }
function pass(msg: string) { console.log(`${GREEN}[PASS]${NC} ${msg}`); }
function fail(msg: string) { console.log(`${RED}[FAIL]${NC} ${msg}`); }

const processes: ChildProcess[] = [];

function getArtifact(contractPath: string, contractName: string) {
  const p = path.join(process.cwd(), `out/${contractPath}/${contractName}.json`);
  if (!fs.existsSync(p)) {
    execSync("forge build", { stdio: "inherit" });
  }
  const a = JSON.parse(fs.readFileSync(p, "utf8"));
  return { abi: a.abi, bytecode: a.bytecode.object };
}

async function waitForRpc(url: string, maxMs = 15000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const p = new JsonRpcProvider(url, undefined, { staticNetwork: true });
      await p.getBlockNumber();
      return;
    } catch { await new Promise(r => setTimeout(r, 300)); }
  }
  throw new Error(`Timeout waiting for RPC at ${url}`);
}

// ─── Start L1 Anvil ──────────────────────────────────────────────
async function startL1(): Promise<JsonRpcProvider> {
  log("Starting L1 Anvil...");
  const p = spawn("anvil", [
    "--port", L1_PORT.toString(),
    "--chain-id", "31337",
    "--block-time", "1",
    "--silent",
  ], { stdio: "pipe" });
  processes.push(p);
  await waitForRpc(`http://localhost:${L1_PORT}`);
  pass("L1 started");
  return new JsonRpcProvider(`http://localhost:${L1_PORT}`, undefined, { staticNetwork: true });
}

// ─── Deploy NativeRollupCore + Verifier ──────────────────────────
async function deployRollup(l1: JsonRpcProvider): Promise<{ rollupAddr: string; rollupContract: Contract }> {
  log("Deploying NativeRollupCore to L1...");
  const admin = new Wallet(ADMIN_PK, l1);

  // Compute genesis state root
  const genesisAnvil = spawn("anvil", [
    "--port", "19553",
    "--chain-id", L2_CHAIN_ID.toString(),
    "--accounts", "0",
    "--gas-price", "0",
    "--base-fee", "0",
    "--no-mining",
    "--silent",
  ], { stdio: "pipe" });
  processes.push(genesisAnvil);
  await waitForRpc("http://localhost:19553");

  const gp = new JsonRpcProvider("http://localhost:19553");
  const sysWallet = new Wallet(SYSTEM_PK, gp);
  const sysAddr = sysWallet.address;
  await gp.send("anvil_setBalance", [sysAddr, "0x" + ethers.parseEther("10000000000").toString(16)]);

  const regArt = getArtifact("L1SenderProxyL2.sol", "L2CallRegistry");
  const regFac = new ContractFactory(regArt.abi, regArt.bytecode, sysWallet);
  await regFac.deploy(sysAddr, { nonce: 0 });

  const facArt = getArtifact("L1SenderProxyL2.sol", "L1SenderProxyL2Factory");
  const facFac = new ContractFactory(facArt.abi, facArt.bytecode, sysWallet);
  const regAddr = ethers.getCreateAddress({ from: sysAddr, nonce: 0 });
  await facFac.deploy(sysAddr, regAddr, { nonce: 1 });

  await gp.send("evm_mine", []);
  const rawBlock = await gp.send("eth_getBlockByNumber", ["latest", false]);
  const genesisRoot = rawBlock.stateRoot as string;
  log(`Genesis state root: ${genesisRoot}`);

  genesisAnvil.kill();
  await new Promise(r => setTimeout(r, 500));

  // Deploy verifier
  const vArt = getArtifact("AdminProofVerifier.sol", "AdminProofVerifier");
  const vFac = new ContractFactory(vArt.abi, vArt.bytecode, admin);
  const verifier = await vFac.deploy(admin.address, admin.address);
  await verifier.waitForDeployment();
  log(`Verifier: ${await verifier.getAddress()}`);

  // Deploy rollup
  const rArt = getArtifact("NativeRollupCore.sol", "NativeRollupCore");
  const rFac = new ContractFactory(rArt.abi, rArt.bytecode, admin);
  const rollup = await rFac.deploy(genesisRoot, await verifier.getAddress(), admin.address);
  await rollup.waitForDeployment();
  const rollupAddr = await rollup.getAddress();
  log(`Rollup: ${rollupAddr}`);

  pass("NativeRollupCore deployed");
  return { rollupAddr, rollupContract: rollup };
}

// ─── Start fullnode + builder ────────────────────────────────────
async function startFullnodeAndBuilder(rollupAddr: string): Promise<void> {
  log("Starting builder fullnode...");
  const fn = spawn("npx", [
    "tsx", "l2fullnode/l2-fullnode.ts",
    "--l1-rpc", `http://localhost:${L1_PORT}`,
    "--rollup", rollupAddr,
    "--l2-port", BUILDER_L2_PORT.toString(),
    "--rpc-port", BUILDER_FULLNODE_PORT.toString(),
  ], { stdio: "pipe", cwd: process.cwd() });
  processes.push(fn);
  fn.stdout?.on("data", d => process.stdout.write(`${YELLOW}[FN]${NC} ${d}`));
  fn.stderr?.on("data", d => process.stderr.write(`${YELLOW}[FN]${NC} ${d}`));
  await waitForRpc(`http://localhost:${BUILDER_FULLNODE_PORT}`);
  pass("Builder fullnode started");

  log("Starting builder...");
  const b = spawn("npx", [
    "tsx", "builder/builder.ts",
    "--l1-rpc", `http://localhost:${L1_PORT}`,
    "--fullnode", `http://localhost:${BUILDER_FULLNODE_PORT}`,
    "--rollup", rollupAddr,
    "--admin-key", ADMIN_PK,
    "--port", BUILDER_PORT.toString(),
  ], { stdio: "pipe", cwd: process.cwd() });
  processes.push(b);
  b.stdout?.on("data", d => process.stdout.write(`${YELLOW}[BUILDER]${NC} ${d}`));
  b.stderr?.on("data", d => process.stderr.write(`${YELLOW}[BUILDER]${NC} ${d}`));
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://localhost:${BUILDER_PORT}/status`);
      if (res.ok) { pass("Builder started"); return; }
    } catch {}
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error("Builder failed to start");
}

// ─── Deploy MockERC20 on L1 ─────────────────────────────────────
async function deployMockERC20(l1: JsonRpcProvider): Promise<Contract> {
  log("Deploying MockERC20 on L1...");
  const admin = new Wallet(ADMIN_PK, l1);

  const solCode = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
contract MockERC20 {
    string public name;
    string public symbol;
    uint8 public decimals;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(string memory _name, string memory _symbol, uint8 _decimals) {
        name = _name;
        symbol = _symbol;
        decimals = _decimals;
    }

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            allowance[from][msg.sender] = allowed - amount;
        }
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}`;

  const tmpDir = path.join(process.cwd(), "tmp-test-bridge");
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(path.join(tmpDir, "MockERC20.sol"), solCode);
  execSync(`forge build --contracts tmp-test-bridge -o tmp-test-bridge/out`, { stdio: "pipe", cwd: process.cwd() });
  const art = JSON.parse(fs.readFileSync(path.join(tmpDir, "out/MockERC20.sol/MockERC20.json"), "utf8"));
  fs.rmSync(tmpDir, { recursive: true, force: true });

  const factory = new ContractFactory(art.abi, art.bytecode.object, admin);
  const contract = await factory.deploy("Test Token", "TKN", 18);
  await contract.waitForDeployment();
  const addr = await contract.getAddress();

  // Mint tokens to user
  const user = new Wallet(USER_PK, l1);
  const mintTx = await (contract as any).mint(user.address, ethers.parseEther("1000"));
  await mintTx.wait();

  log(`MockERC20 deployed at ${addr}, minted 1000 TKN to user`);
  pass("MockERC20 deployed");

  const abi = [
    "function name() view returns (string)",
    "function symbol() view returns (string)",
    "function decimals() view returns (uint8)",
    "function totalSupply() view returns (uint256)",
    "function balanceOf(address) view returns (uint256)",
    "function allowance(address,address) view returns (uint256)",
    "function mint(address,uint256)",
    "function transfer(address,uint256) returns (bool)",
    "function approve(address,uint256) returns (bool)",
    "function transferFrom(address,address,uint256) returns (bool)",
  ];
  return new Contract(addr, abi, admin);
}

// ─── Deploy TokenBridgeVault on L1 ──────────────────────────────
async function deployVault(
  l1: JsonRpcProvider,
  rollupContract: Contract,
  l2BridgeAddress: string,
): Promise<Contract> {
  log("Deploying TokenBridgeVault on L1...");
  const admin = new Wallet(ADMIN_PK, l1);

  // Deploy L2SenderProxy for the L2 bridge on L1
  const isDeployed = await rollupContract.isProxyDeployed(l2BridgeAddress);
  if (!isDeployed) {
    const deployProxyTx = await rollupContract.deployProxy(l2BridgeAddress);
    await deployProxyTx.wait();
    log(`Deployed L2SenderProxy for L2 bridge`);
  }
  const l2BridgeProxy = await rollupContract.getProxyAddress(l2BridgeAddress);
  log(`L2 bridge proxy on L1: ${l2BridgeProxy}`);

  const art = getArtifact("TokenBridgeVault.sol", "TokenBridgeVault");
  const factory = new ContractFactory(art.abi, art.bytecode, admin);
  const vault = await factory.deploy(l2BridgeProxy);
  await vault.waitForDeployment();
  const addr = await vault.getAddress();
  log(`TokenBridgeVault deployed at ${addr}`);
  pass("TokenBridgeVault deployed");

  return new Contract(addr, art.abi, admin);
}

// ─── Deploy TokenBridgeL2 on L2 (via builder) ───────────────────
async function deployL2Bridge(vaultAddress: string): Promise<{ address: string; l2Nonce: number }> {
  log("Deploying TokenBridgeL2 on L2...");

  // The L2 bridge needs the L1SenderProxyL2 address for the vault
  // Ask the fullnode for this address
  const fullnodeRpc = new JsonRpcProvider(`http://localhost:${BUILDER_FULLNODE_PORT}`, undefined, { staticNetwork: true });
  const l1VaultProxy = await fullnodeRpc.send("nativerollup_getL1SenderProxyL2", [vaultAddress]);
  log(`L1 vault proxy on L2: ${l1VaultProxy}`);

  const art = getArtifact("TokenBridgeL2.sol", "TokenBridgeL2");
  const factory = new ContractFactory(art.abi, art.bytecode);
  const deployTx = await factory.getDeployTransaction(l1VaultProxy);

  const user = new Wallet(USER_PK);
  const nonce = 0;
  const signedTx = await user.signTransaction({
    type: 2,
    chainId: L2_CHAIN_ID,
    nonce,
    to: null,
    data: deployTx.data,
    gasLimit: 5000000,
    maxFeePerGas: 0,
    maxPriorityFeePerGas: 0,
    value: 0,
  });

  const res = await fetch(`http://localhost:${BUILDER_PORT}/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ signedTx, sourceChain: "L2" }),
  });
  const result = await res.json() as any;
  if (!result.l1TxHash) {
    throw new Error(`Deploy L2 bridge failed: ${JSON.stringify(result)}`);
  }

  const l1 = new JsonRpcProvider(`http://localhost:${L1_PORT}`, undefined, { staticNetwork: true });
  await l1.waitForTransaction(result.l1TxHash, 1, 30000);

  const l2BridgeAddr = ethers.getCreateAddress({ from: user.address, nonce: 0 });

  // Verify deployment
  const l2Provider = new JsonRpcProvider(`http://localhost:${BUILDER_L2_PORT}`, L2_CHAIN_ID, { staticNetwork: true });
  const code = await l2Provider.getCode(l2BridgeAddr);
  if (code === "0x") throw new Error("TokenBridgeL2 not deployed on L2");

  log(`TokenBridgeL2 deployed at ${l2BridgeAddr}`);
  pass("TokenBridgeL2 deployed on L2");

  return { address: l2BridgeAddr, l2Nonce: 1 };
}

// ─── Submit L1 tx through builder ────────────────────────────────
async function submitL1Tx(signedTx: string, l2Addresses?: string[]): Promise<any> {
  const body: any = { signedTx, sourceChain: "L1" };
  if (l2Addresses) {
    body.hints = { l2Addresses };
  }
  const res = await fetch(`http://localhost:${BUILDER_PORT}/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

// ─── Submit L2 tx through builder ────────────────────────────────
async function submitL2Tx(signedTx: string, l1TargetAddress?: string): Promise<any> {
  const body: any = { signedTx, sourceChain: "L2" };
  if (l1TargetAddress) {
    body.hints = { l1TargetAddress };
  }
  const res = await fetch(`http://localhost:${BUILDER_PORT}/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

// ─── TESTS ───────────────────────────────────────────────────────

async function test1_Deposit(
  token: Contract,
  vault: Contract,
  l2BridgeAddr: string,
  rollupContract: Contract,
): Promise<boolean> {
  console.log("\n" + "=".repeat(60));
  log("TEST 1: Deposit - Lock ERC20 on L1, mint bridged tokens on L2");
  console.log("=".repeat(60));

  const l1 = new JsonRpcProvider(`http://localhost:${L1_PORT}`, undefined, { staticNetwork: true });
  const l2Provider = new JsonRpcProvider(`http://localhost:${BUILDER_L2_PORT}`, L2_CHAIN_ID, { staticNetwork: true });
  const user = new Wallet(USER_PK, l1);
  const l2User = user.address; // same address on L2

  const tokenAddr = await token.getAddress();
  const vaultAddr = await vault.getAddress();
  const depositAmount = ethers.parseEther("100");

  // Step 1: User approves vault
  log("User approving vault for 100 TKN...");
  const approveTx = await token.connect(user).approve(vaultAddr, depositAmount);
  await approveTx.wait();
  pass("Approved");

  // Step 2: User calls vault.deposit() — this is an L1 tx that calls L2
  log("User calling vault.deposit()...");
  const depositCalldata = vault.interface.encodeFunctionData("deposit", [
    tokenAddr, depositAmount, l2User,
  ]);

  const nonce = await l1.getTransactionCount(user.address);
  const signedTx = await user.signTransaction({
    type: 2,
    chainId: 31337,
    nonce,
    to: vaultAddr,
    data: depositCalldata,
    gasLimit: 2000000,
    maxFeePerGas: ethers.parseUnits("10", "gwei"),
    maxPriorityFeePerGas: ethers.parseUnits("1", "gwei"),
    value: 0,
  });

  const result = await submitL1Tx(signedTx, [l2BridgeAddr]);
  if (!result.l1TxHash) {
    fail(`Deposit failed: ${JSON.stringify(result)}`);
    return false;
  }
  await l1.waitForTransaction(result.l1TxHash, 1, 30000);
  log(`Deposit L1 tx: ${result.l1TxHash}`);

  // Step 3: Verify L1 side - tokens locked in vault
  const vaultBalance = await token.balanceOf(vaultAddr);
  const userBalance = await token.balanceOf(user.address);
  log(`Vault balance: ${ethers.formatEther(vaultBalance)} TKN`);
  log(`User L1 balance: ${ethers.formatEther(userBalance)} TKN`);

  if (vaultBalance !== depositAmount) {
    fail(`Expected vault balance = 100, got ${ethers.formatEther(vaultBalance)}`);
    return false;
  }
  pass("L1: Tokens locked in vault ✓");

  // Step 4: Verify L2 side - bridged tokens minted
  // Wait for fullnode to sync the L1 event
  log("Waiting for fullnode to sync L2 state...");
  await new Promise(r => setTimeout(r, 5000));

  // Read the TokenBridgeL2 to find the bridged token address
  const l2BridgeArt = getArtifact("TokenBridgeL2.sol", "TokenBridgeL2");
  const l2Bridge = new Contract(l2BridgeAddr, l2BridgeArt.abi, l2Provider);
  const bridgedTokenAddr = await l2Bridge.bridgedTokens(tokenAddr);
  log(`Bridged token on L2: ${bridgedTokenAddr}`);

  if (bridgedTokenAddr === ethers.ZeroAddress) {
    fail("Bridged token not deployed on L2");
    return false;
  }

  const bridgedArt = getArtifact("BridgedERC20.sol", "BridgedERC20");
  const bridgedToken = new Contract(bridgedTokenAddr, bridgedArt.abi, l2Provider);
  const l2Balance = await bridgedToken.balanceOf(l2User);
  log(`User L2 bridged balance: ${ethers.formatEther(l2Balance)} bTKN`);

  if (l2Balance !== depositAmount) {
    fail(`Expected L2 balance = 100, got ${ethers.formatEther(l2Balance)}`);
    return false;
  }
  pass("L2: Bridged tokens minted ✓");

  // Verify token metadata
  const bName = await bridgedToken.name();
  const bSymbol = await bridgedToken.symbol();
  const bDecimals = await bridgedToken.decimals();
  log(`Bridged token: name="${bName}", symbol="${bSymbol}", decimals=${bDecimals}`);
  pass("Token metadata bridged correctly ✓");

  return true;
}

async function test2_Withdraw(
  token: Contract,
  vault: Contract,
  l2BridgeAddr: string,
  l2Nonce: number,
): Promise<boolean> {
  console.log("\n" + "=".repeat(60));
  log("TEST 2: Withdraw - Burn bridged tokens on L2, release ERC20 on L1");
  console.log("=".repeat(60));

  const l1 = new JsonRpcProvider(`http://localhost:${L1_PORT}`, undefined, { staticNetwork: true });
  const l2Provider = new JsonRpcProvider(`http://localhost:${BUILDER_L2_PORT}`, L2_CHAIN_ID, { staticNetwork: true });
  const user = new Wallet(USER_PK);
  const tokenAddr = await token.getAddress();
  const vaultAddr = await vault.getAddress();
  const withdrawAmount = ethers.parseEther("30");

  // Read bridged token from L2 bridge
  const l2BridgeArt = getArtifact("TokenBridgeL2.sol", "TokenBridgeL2");
  const l2Bridge = new Contract(l2BridgeAddr, l2BridgeArt.abi, l2Provider);
  const bridgedTokenAddr = await l2Bridge.bridgedTokens(tokenAddr);

  const bridgedArt = getArtifact("BridgedERC20.sol", "BridgedERC20");
  const bridgedToken = new Contract(bridgedTokenAddr, bridgedArt.abi, l2Provider);

  const l2BalanceBefore = await bridgedToken.balanceOf(user.address);
  log(`User L2 balance before: ${ethers.formatEther(l2BalanceBefore)} bTKN`);

  // Step 1: User calls l2Bridge.withdraw() on L2
  log("User calling withdraw(30 TKN)...");
  const withdrawCalldata = l2Bridge.interface.encodeFunctionData("withdraw", [
    tokenAddr, withdrawAmount, user.address,
  ]);

  const signedTx = await user.signTransaction({
    type: 2,
    chainId: L2_CHAIN_ID,
    nonce: l2Nonce,
    to: l2BridgeAddr,
    data: withdrawCalldata,
    gasLimit: 5000000,
    maxFeePerGas: 0,
    maxPriorityFeePerGas: 0,
    value: 0,
  });

  const result = await submitL2Tx(signedTx, vaultAddr);
  if (!result.l1TxHash) {
    fail(`Withdraw failed: ${JSON.stringify(result)}`);
    return false;
  }
  await l1.waitForTransaction(result.l1TxHash, 1, 30000);
  log(`Withdraw L1 tx: ${result.l1TxHash}`);

  // Step 2: Verify L2 - tokens burned
  const l2BalanceAfter = await bridgedToken.balanceOf(user.address);
  log(`User L2 balance after: ${ethers.formatEther(l2BalanceAfter)} bTKN`);

  const expectedL2 = l2BalanceBefore - withdrawAmount;
  if (l2BalanceAfter !== expectedL2) {
    fail(`Expected L2 balance = ${ethers.formatEther(expectedL2)}, got ${ethers.formatEther(l2BalanceAfter)}`);
    return false;
  }
  pass("L2: Tokens burned ✓");

  // Step 3: Verify L1 - tokens released to user
  const userL1Balance = await token.balanceOf(user.address);
  const vaultBalance = await token.balanceOf(vaultAddr);
  log(`User L1 balance: ${ethers.formatEther(userL1Balance)} TKN`);
  log(`Vault balance: ${ethers.formatEther(vaultBalance)} TKN`);

  // User started with 1000, deposited 100, got back 30 → 930
  const expectedUserBalance = ethers.parseEther("930");
  if (userL1Balance !== expectedUserBalance) {
    fail(`Expected user L1 balance = 930, got ${ethers.formatEther(userL1Balance)}`);
    return false;
  }
  pass("L1: Tokens released to user ✓");

  // Vault should have 70 remaining (100 deposited - 30 withdrawn)
  const expectedVaultBalance = ethers.parseEther("70");
  if (vaultBalance !== expectedVaultBalance) {
    fail(`Expected vault balance = 70, got ${ethers.formatEther(vaultBalance)}`);
    return false;
  }
  pass("L1: Vault balance correct ✓");

  return true;
}

// ─── Main ────────────────────────────────────────────────────────

async function killPortProcesses() {
  const ports = [L1_PORT, L2_EVM_PORT, FULLNODE_RPC_PORT, BUILDER_L2_PORT, BUILDER_FULLNODE_PORT, BUILDER_PORT, 19553];
  for (const port of ports) {
    try { execSync(`lsof -ti :${port} | xargs kill -9 2>/dev/null`, { stdio: "pipe" }); } catch {}
  }
  await new Promise(r => setTimeout(r, 1000));
}

async function main() {
  let allPassed = true;

  try {
    // Kill stale processes
    log("Killing stale processes...");
    await killPortProcesses();

    // Setup infrastructure
    const l1 = await startL1();
    const { rollupAddr, rollupContract } = await deployRollup(l1);
    await startFullnodeAndBuilder(rollupAddr);

    // Deploy contracts
    // Order matters: precompute L2 bridge address, deploy vault on L1, then deploy L2 bridge
    const token = await deployMockERC20(l1);
    const user = new Wallet(USER_PK);
    const l2BridgeAddr = ethers.getCreateAddress({ from: user.address, nonce: 0 });
    log(`Precomputed L2 bridge address: ${l2BridgeAddr}`);
    const vault = await deployVault(l1, rollupContract, l2BridgeAddr);
    const vaultAddr = await vault.getAddress();
    const { l2Nonce } = await deployL2Bridge(vaultAddr);

    // Run tests
    const t1 = await test1_Deposit(token, vault, l2BridgeAddr, rollupContract);
    allPassed = allPassed && t1;

    if (t1) {
      // Only run withdraw if deposit succeeded (needs bridged tokens)
      const t2 = await test2_Withdraw(token, vault, l2BridgeAddr, l2Nonce);
      allPassed = allPassed && t2;
    }

  } catch (err) {
    fail(`Unexpected error: ${err}`);
    console.error(err);
    allPassed = false;
  } finally {
    log("Cleaning up...");
    for (const p of processes) {
      try { p.kill(); } catch {}
    }
    await new Promise(r => setTimeout(r, 1000));
  }

  console.log("\n" + "=".repeat(60));
  if (allPassed) {
    pass("ALL TESTS PASSED");
  } else {
    fail("SOME TESTS FAILED");
  }
  console.log("=".repeat(60));
  process.exit(allPassed ? 0 : 1);
}

main();
