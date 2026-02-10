// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BridgedERC20} from "./BridgedERC20.sol";

/// @title TokenBridgeL2
/// @notice L2 side of the token bridge - mints/burns bridged ERC20 tokens
/// @dev Receives mint calls from L1 vault (via L1SenderProxyL2) and handles withdrawals back to L1
contract TokenBridgeL2 {
    /// @notice The deployer/owner who can initialize the contract
    address public immutable owner;

    /// @notice The L1SenderProxyL2 address for the L1 vault contract
    /// @dev This is both the authorized caller for mints and the target for withdraw calls
    address public l1VaultProxy;

    /// @notice Whether the contract has been initialized
    bool public initialized;

    /// @notice Mapping from L1 token address to deployed BridgedERC20 on L2
    mapping(address => address) public bridgedTokens;

    bytes32 public constant SALT_PREFIX = keccak256("TokenBridge.BridgedERC20.v1");

    event BridgedTokenDeployed(address indexed l1Token, address indexed bridgedToken);
    event TokenMinted(address indexed l1Token, address indexed recipient, uint256 amount);
    event TokenBurned(address indexed l1Token, address indexed sender, uint256 amount, address indexed l1Recipient);
    event Initialized(address indexed l1VaultProxy);

    error OnlyVaultProxy();
    error TokenNotBridged();
    error AlreadyInitialized();
    error OnlyOwner();
    error NotInitialized();

    constructor() {
        owner = msg.sender;
    }

    /// @notice Initialize the bridge with the L1 vault proxy address
    /// @dev Can only be called once by the owner
    /// @param _l1VaultProxy The L1SenderProxyL2 address for the L1 vault
    function initialize(address _l1VaultProxy) external {
        if (msg.sender != owner) revert OnlyOwner();
        if (initialized) revert AlreadyInitialized();

        l1VaultProxy = _l1VaultProxy;
        initialized = true;

        emit Initialized(_l1VaultProxy);
    }

    /// @notice Mint bridged tokens on L2 (called by L1 vault via L1SenderProxyL2)
    /// @param l1Token The L1 token address being bridged
    /// @param recipient The L2 address to receive tokens
    /// @param amount The amount to mint
    /// @param name Token name for first-time deployment
    /// @param symbol Token symbol for first-time deployment
    /// @param decimals Token decimals for first-time deployment
    function mint(
        address l1Token,
        address recipient,
        uint256 amount,
        string calldata name,
        string calldata symbol,
        uint8 decimals
    ) external {
        if (!initialized) revert NotInitialized();
        if (msg.sender != l1VaultProxy) revert OnlyVaultProxy();

        address bridgedToken = bridgedTokens[l1Token];
        if (bridgedToken == address(0)) {
            bridgedToken = _deployBridgedToken(l1Token, name, symbol, decimals);
        }

        BridgedERC20(bridgedToken).mint(recipient, amount);
        emit TokenMinted(l1Token, recipient, amount);
    }

    /// @notice Withdraw: burn L2 tokens and trigger L1 release
    /// @param l1Token The L1 token address
    /// @param amount The amount to withdraw
    /// @param l1Recipient The L1 address to receive tokens
    function withdraw(address l1Token, uint256 amount, address l1Recipient) external {
        if (!initialized) revert NotInitialized();

        address bridgedToken = bridgedTokens[l1Token];
        if (bridgedToken == address(0)) revert TokenNotBridged();

        // Burn the caller's tokens
        BridgedERC20(bridgedToken).burn(msg.sender, amount);
        emit TokenBurned(l1Token, msg.sender, amount, l1Recipient);

        // Call L1 vault via L1SenderProxyL2 to release tokens
        // The proxy looks up the pre-registered return value from L2CallRegistry
        (bool success,) = l1VaultProxy.call(
            abi.encodeWithSignature("release(address,uint256,address)", l1Token, amount, l1Recipient)
        );
        require(success, "L1 release call failed");
    }

    /// @notice Deploy a new BridgedERC20 via CREATE2
    function _deployBridgedToken(
        address l1Token,
        string calldata name,
        string calldata symbol,
        uint8 decimals
    ) internal returns (address) {
        bytes32 salt = keccak256(abi.encodePacked(SALT_PREFIX, l1Token));
        BridgedERC20 token = new BridgedERC20{salt: salt}(address(this), l1Token, name, symbol, decimals);
        bridgedTokens[l1Token] = address(token);
        emit BridgedTokenDeployed(l1Token, address(token));
        return address(token);
    }

    /// @notice Compute the address a BridgedERC20 would be deployed to
    function computeBridgedTokenAddress(
        address l1Token,
        string calldata name,
        string calldata symbol,
        uint8 decimals
    ) external view returns (address) {
        bytes32 salt = keccak256(abi.encodePacked(SALT_PREFIX, l1Token));
        bytes memory bytecode = abi.encodePacked(
            type(BridgedERC20).creationCode,
            abi.encode(address(this), l1Token, name, symbol, decimals)
        );
        return address(uint160(uint256(keccak256(
            abi.encodePacked(bytes1(0xff), address(this), salt, keccak256(bytecode))
        ))));
    }
}
