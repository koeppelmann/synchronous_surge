// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {NativeRollupCore} from "../src/NativeRollupCore.sol";
import {AdminProofVerifier} from "../src/verifiers/AdminProofVerifier.sol";
import {OutgoingCall, IProofVerifier} from "../src/interfaces/IProofVerifier.sol";
import {TokenBridgeVault, IERC20} from "../src/bridge/TokenBridgeVault.sol";
import {TokenBridgeL2} from "../src/bridge/TokenBridgeL2.sol";
import {BridgedERC20} from "../src/bridge/BridgedERC20.sol";

/// @title Token Bridge Tests
/// @notice Tests deposit (L1→L2) and withdraw (L2→L1) flows for ERC20 bridging
contract TokenBridgeTest is Test {
    NativeRollupCore public rollup;
    AdminProofVerifier public verifier;
    TokenBridgeVault public vault;
    TokenBridgeL2 public l2Bridge;
    MockERC20 public token;

    // Addresses
    address constant L2_BRIDGE_ADDRESS = address(0xB1D6e0000000000000000000000000000000B1D6);
    uint256 constant ADMIN_PK = 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef;
    address admin;
    address user;
    address l2User;

    bytes32 constant GENESIS_HASH = keccak256("genesis");
    bytes32 constant STATE_1 = keccak256("state1");
    bytes32 constant STATE_2 = keccak256("state2");

    function setUp() public {
        admin = vm.addr(ADMIN_PK);
        user = makeAddr("user");
        l2User = makeAddr("l2User");

        // Deploy rollup infrastructure
        verifier = new AdminProofVerifier(admin, address(this));
        rollup = new NativeRollupCore(GENESIS_HASH, address(verifier), address(this));

        // Deploy mock ERC20 on L1
        token = new MockERC20("Test Token", "TKN", 18);
        token.mint(user, 1000 ether);

        // Get the L2SenderProxy address for L2 bridge on L1
        address l2BridgeProxy = rollup.getProxyAddress(L2_BRIDGE_ADDRESS);

        // Deploy vault on L1 (no constructor args now)
        vault = new TokenBridgeVault();
        // Initialize vault with L2 bridge proxy
        vault.initialize(l2BridgeProxy);

        // Deploy L2 bridge (in real system this is on L2, here we test the logic)
        // The l1VaultProxy is the L1SenderProxyL2 for the vault address on L2
        // For testing, we simulate the auth by pranking from that address
        l2Bridge = new TokenBridgeL2();
        // Initialize L2 bridge with vault address (simplified: vault address acts as proxy in test)
        l2Bridge.initialize(address(vault));

        // Fund rollup for outgoing calls
        vm.deal(address(rollup), 100 ether);
    }

    // ============ BridgedERC20 Tests ============

    function test_BridgedERC20_OnlyBridgeCanMint() public {
        BridgedERC20 bridged = new BridgedERC20(address(this), address(token), "Bridged TKN", "bTKN", 18);

        bridged.mint(user, 100 ether);
        assertEq(bridged.balanceOf(user), 100 ether);
        assertEq(bridged.totalSupply(), 100 ether);

        vm.prank(user);
        vm.expectRevert(BridgedERC20.OnlyBridge.selector);
        bridged.mint(user, 100 ether);
    }

    function test_BridgedERC20_OnlyBridgeCanBurn() public {
        BridgedERC20 bridged = new BridgedERC20(address(this), address(token), "Bridged TKN", "bTKN", 18);
        bridged.mint(user, 100 ether);

        bridged.burn(user, 50 ether);
        assertEq(bridged.balanceOf(user), 50 ether);
        assertEq(bridged.totalSupply(), 50 ether);

        vm.prank(user);
        vm.expectRevert(BridgedERC20.OnlyBridge.selector);
        bridged.burn(user, 50 ether);
    }

    function test_BridgedERC20_Transfer() public {
        BridgedERC20 bridged = new BridgedERC20(address(this), address(token), "Bridged TKN", "bTKN", 18);
        bridged.mint(user, 100 ether);

        vm.prank(user);
        bridged.transfer(l2User, 30 ether);
        assertEq(bridged.balanceOf(user), 70 ether);
        assertEq(bridged.balanceOf(l2User), 30 ether);
    }

    function test_BridgedERC20_Approve_TransferFrom() public {
        BridgedERC20 bridged = new BridgedERC20(address(this), address(token), "Bridged TKN", "bTKN", 18);
        bridged.mint(user, 100 ether);

        vm.prank(user);
        bridged.approve(l2User, 50 ether);
        assertEq(bridged.allowance(user, l2User), 50 ether);

        vm.prank(l2User);
        bridged.transferFrom(user, l2User, 30 ether);
        assertEq(bridged.balanceOf(user), 70 ether);
        assertEq(bridged.balanceOf(l2User), 30 ether);
        assertEq(bridged.allowance(user, l2User), 20 ether);
    }

    function test_BridgedERC20_InfiniteApproval() public {
        BridgedERC20 bridged = new BridgedERC20(address(this), address(token), "Bridged TKN", "bTKN", 18);
        bridged.mint(user, 100 ether);

        vm.prank(user);
        bridged.approve(l2User, type(uint256).max);

        vm.prank(l2User);
        bridged.transferFrom(user, l2User, 50 ether);
        // Allowance should remain max
        assertEq(bridged.allowance(user, l2User), type(uint256).max);
    }

    // ============ TokenBridgeL2 Tests ============

    function test_L2Bridge_MintDeploysBridgedToken() public {
        // Simulate an incoming call from the vault (via L1SenderProxyL2)
        vm.prank(address(vault));
        l2Bridge.mint(address(token), l2User, 100 ether, "Bridged Test Token", "bTKN", 18);

        // Check bridged token was deployed
        address bridgedToken = l2Bridge.bridgedTokens(address(token));
        assertTrue(bridgedToken != address(0), "Bridged token not deployed");

        // Check balance
        assertEq(BridgedERC20(bridgedToken).balanceOf(l2User), 100 ether);
        assertEq(BridgedERC20(bridgedToken).name(), "Bridged Test Token");
        assertEq(BridgedERC20(bridgedToken).symbol(), "bTKN");
        assertEq(BridgedERC20(bridgedToken).decimals(), 18);
        assertEq(BridgedERC20(bridgedToken).l1Token(), address(token));
    }

    function test_L2Bridge_MintReusesBridgedToken() public {
        // First mint deploys the token
        vm.prank(address(vault));
        l2Bridge.mint(address(token), l2User, 100 ether, "Bridged Test Token", "bTKN", 18);
        address bridgedToken1 = l2Bridge.bridgedTokens(address(token));

        // Second mint reuses existing token
        vm.prank(address(vault));
        l2Bridge.mint(address(token), user, 50 ether, "Bridged Test Token", "bTKN", 18);
        address bridgedToken2 = l2Bridge.bridgedTokens(address(token));

        assertEq(bridgedToken1, bridgedToken2, "Should reuse same bridged token");
        assertEq(BridgedERC20(bridgedToken1).balanceOf(l2User), 100 ether);
        assertEq(BridgedERC20(bridgedToken1).balanceOf(user), 50 ether);
        assertEq(BridgedERC20(bridgedToken1).totalSupply(), 150 ether);
    }

    function test_L2Bridge_MintRevertsIfNotVaultProxy() public {
        vm.prank(user);
        vm.expectRevert(TokenBridgeL2.OnlyVaultProxy.selector);
        l2Bridge.mint(address(token), l2User, 100 ether, "Bridged Test Token", "bTKN", 18);
    }

    function test_L2Bridge_WithdrawRevertsIfTokenNotBridged() public {
        vm.prank(user);
        vm.expectRevert(TokenBridgeL2.TokenNotBridged.selector);
        l2Bridge.withdraw(address(token), 100 ether, user);
    }

    function test_L2Bridge_ComputeBridgedTokenAddress() public {
        address predicted = l2Bridge.computeBridgedTokenAddress(
            address(token), "Bridged Test Token", "bTKN", 18
        );

        vm.prank(address(vault));
        l2Bridge.mint(address(token), l2User, 100 ether, "Bridged Test Token", "bTKN", 18);

        address actual = l2Bridge.bridgedTokens(address(token));
        assertEq(predicted, actual, "CREATE2 address prediction mismatch");
    }

    function test_L2Bridge_MultipleDifferentTokens() public {
        MockERC20 token2 = new MockERC20("Token 2", "TK2", 8);

        vm.prank(address(vault));
        l2Bridge.mint(address(token), l2User, 100 ether, "Bridged Test Token", "bTKN", 18);

        vm.prank(address(vault));
        l2Bridge.mint(address(token2), l2User, 200e8, "Bridged Token 2", "bTK2", 8);

        address bridged1 = l2Bridge.bridgedTokens(address(token));
        address bridged2 = l2Bridge.bridgedTokens(address(token2));

        assertTrue(bridged1 != bridged2, "Different tokens should get different bridged tokens");
        assertEq(BridgedERC20(bridged1).balanceOf(l2User), 100 ether);
        assertEq(BridgedERC20(bridged2).balanceOf(l2User), 200e8);
        assertEq(BridgedERC20(bridged2).decimals(), 8);
    }

    // ============ Initialization Tests ============

    function test_Vault_CannotInitializeTwice() public {
        TokenBridgeVault newVault = new TokenBridgeVault();
        newVault.initialize(address(1));

        vm.expectRevert(TokenBridgeVault.AlreadyInitialized.selector);
        newVault.initialize(address(2));
    }

    function test_Vault_OnlyOwnerCanInitialize() public {
        TokenBridgeVault newVault = new TokenBridgeVault();

        vm.prank(user);
        vm.expectRevert(TokenBridgeVault.OnlyOwner.selector);
        newVault.initialize(address(1));
    }

    function test_Vault_CannotDepositBeforeInitialize() public {
        TokenBridgeVault newVault = new TokenBridgeVault();

        vm.prank(user);
        vm.expectRevert(TokenBridgeVault.NotInitialized.selector);
        newVault.deposit(address(token), 100 ether, l2User);
    }

    function test_L2Bridge_CannotInitializeTwice() public {
        TokenBridgeL2 newBridge = new TokenBridgeL2();
        newBridge.initialize(address(1));

        vm.expectRevert(TokenBridgeL2.AlreadyInitialized.selector);
        newBridge.initialize(address(2));
    }

    function test_L2Bridge_OnlyOwnerCanInitialize() public {
        TokenBridgeL2 newBridge = new TokenBridgeL2();

        vm.prank(user);
        vm.expectRevert(TokenBridgeL2.OnlyOwner.selector);
        newBridge.initialize(address(1));
    }

    function test_L2Bridge_CannotMintBeforeInitialize() public {
        TokenBridgeL2 newBridge = new TokenBridgeL2();

        vm.expectRevert(TokenBridgeL2.NotInitialized.selector);
        newBridge.mint(address(token), l2User, 100 ether, "Bridged Test Token", "bTKN", 18);
    }

    function test_L2Bridge_CannotWithdrawBeforeInitialize() public {
        TokenBridgeL2 newBridge = new TokenBridgeL2();

        vm.expectRevert(TokenBridgeL2.NotInitialized.selector);
        newBridge.withdraw(address(token), 100 ether, user);
    }

    // ============ TokenBridgeVault Tests ============

    function test_Vault_ReleaseRevertsIfNotProxy() public {
        vm.prank(user);
        vm.expectRevert(TokenBridgeVault.OnlyL2BridgeProxy.selector);
        vault.release(address(token), 100 ether, user);
    }

    function test_Vault_TokenMetadataReading() public {
        // Test that vault reads token metadata correctly
        // This is implicitly tested in the deposit flow but we verify the token
        assertEq(token.name(), "Test Token");
        assertEq(token.symbol(), "TKN");
        assertEq(token.decimals(), 18);
    }

    // ============ Full Flow Test (Withdraw via L2→L1 outgoing call) ============

    function test_WithdrawFlow_BurnAndRelease() public {
        // Setup: mint some bridged tokens first
        vm.prank(address(vault));
        l2Bridge.mint(address(token), l2User, 100 ether, "Bridged Test Token", "bTKN", 18);
        address bridgedToken = l2Bridge.bridgedTokens(address(token));

        // Fund the vault with tokens (simulating previous deposits)
        token.mint(address(vault), 100 ether);

        // Get the L2SenderProxy for L2 bridge
        address l2BridgeProxy = rollup.getProxyAddress(L2_BRIDGE_ADDRESS);

        // Simulate the release being called via L2SenderProxy
        // In the real system, NativeRollupCore calls L2SenderProxy.execute(vault, release(...))
        // which calls vault.release() with msg.sender = l2BridgeProxy
        vm.prank(l2BridgeProxy);
        vault.release(address(token), 50 ether, user);

        assertEq(token.balanceOf(user), 1050 ether); // 1000 initial + 50 released
        assertEq(token.balanceOf(address(vault)), 50 ether); // 100 - 50
    }

    // ============ Deposit Integration Test ============

    /// @notice Test the deposit flow: user locks tokens, vault calls L2 via proxy
    /// @dev This tests the L1 side only - the L2 mint is pre-registered as incoming call response
    function test_DepositFlow_LockAndCallL2() public {
        // Deploy the L2 proxy for L2_BRIDGE_ADDRESS
        rollup.deployProxy(L2_BRIDGE_ADDRESS);
        address l2BridgeProxy = rollup.getProxyAddress(L2_BRIDGE_ADDRESS);

        // The callData that the vault will send to the L2 bridge
        bytes memory mintCallData = abi.encodeWithSignature(
            "mint(address,address,uint256,string,string,uint8)",
            address(token), l2User, uint256(100 ether),
            "Bridged Test Token", "bTKN", uint8(18)
        );

        // Register the incoming call response (what the builder would do)
        NativeRollupCore.IncomingCallResponse memory response = NativeRollupCore.IncomingCallResponse({
            preOutgoingCallsStateHash: STATE_1,
            outgoingCalls: new OutgoingCall[](0),
            expectedResults: new bytes[](0),
            returnValue: "",  // mint returns void
            finalStateHash: STATE_1
        });

        bytes memory proof = _signIncomingCallProof(
            L2_BRIDGE_ADDRESS,
            GENESIS_HASH,
            mintCallData,
            response
        );

        rollup.registerIncomingCall(
            L2_BRIDGE_ADDRESS,
            GENESIS_HASH,
            mintCallData,
            response,
            proof
        );

        // User approves and deposits
        vm.startPrank(user);
        token.approve(address(vault), 100 ether);
        vault.deposit(address(token), 100 ether, l2User);
        vm.stopPrank();

        // Verify tokens locked in vault
        assertEq(token.balanceOf(address(vault)), 100 ether);
        assertEq(token.balanceOf(user), 900 ether);

        // Verify L2 state was updated
        assertEq(rollup.l2BlockHash(), STATE_1);
    }

    // ============ Helpers ============

    function _signIncomingCallProof(
        address l2Address,
        bytes32 stateHash,
        bytes memory callData,
        NativeRollupCore.IncomingCallResponse memory response
    ) internal pure returns (bytes memory) {
        bytes32 messageHash = keccak256(abi.encode(
            l2Address,
            stateHash,
            keccak256(callData),
            response.preOutgoingCallsStateHash,
            _hashCalls(response.outgoingCalls),
            _hashResults(response.expectedResults),
            keccak256(response.returnValue),
            response.finalStateHash
        ));

        bytes32 ethSignedMessageHash = keccak256(abi.encodePacked(
            "\x19Ethereum Signed Message:\n32",
            messageHash
        ));

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ADMIN_PK, ethSignedMessageHash);
        return abi.encodePacked(r, s, v);
    }

    function _hashCalls(OutgoingCall[] memory calls) internal pure returns (bytes32) {
        bytes memory encoded;
        for (uint256 i = 0; i < calls.length; i++) {
            encoded = abi.encodePacked(
                encoded,
                calls[i].from,
                calls[i].target,
                calls[i].value,
                calls[i].gas,
                keccak256(calls[i].data),
                calls[i].postCallStateHash
            );
        }
        return keccak256(encoded);
    }

    function _hashResults(bytes[] memory results) internal pure returns (bytes32) {
        bytes memory encoded;
        for (uint256 i = 0; i < results.length; i++) {
            encoded = abi.encodePacked(encoded, keccak256(results[i]));
        }
        return keccak256(encoded);
    }
}

// ============ Mock ERC20 ============

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
}
