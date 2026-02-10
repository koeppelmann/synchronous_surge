// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function name() external view returns (string memory);
    function symbol() external view returns (string memory);
    function decimals() external view returns (uint8);
}

/// @title TokenBridgeVault
/// @notice L1 vault that locks ERC20 tokens for bridging to L2
/// @dev Deposits call L2 bridge via L2SenderProxy; releases are triggered by L2 withdrawals
contract TokenBridgeVault {
    /// @notice The deployer/owner who can initialize the contract
    address public immutable owner;

    /// @notice The L2SenderProxy address on L1 for the L2 bridge contract
    /// @dev Used to call L2 (deposit) and to authorize release calls (withdraw)
    address public l2BridgeProxy;

    /// @notice Whether the contract has been initialized
    bool public initialized;

    event Deposited(address indexed token, address indexed depositor, address indexed l2Recipient, uint256 amount);
    event Released(address indexed token, address indexed recipient, uint256 amount);
    event Initialized(address indexed l2BridgeProxy);

    error OnlyL2BridgeProxy();
    error TransferFailed();
    error AlreadyInitialized();
    error OnlyOwner();
    error NotInitialized();

    constructor() {
        owner = msg.sender;
    }

    /// @notice Initialize the vault with the L2 bridge proxy address
    /// @dev Can only be called once by the owner
    /// @param _l2BridgeProxy The L2SenderProxy address for the L2 bridge
    function initialize(address _l2BridgeProxy) external {
        if (msg.sender != owner) revert OnlyOwner();
        if (initialized) revert AlreadyInitialized();

        l2BridgeProxy = _l2BridgeProxy;
        initialized = true;

        emit Initialized(_l2BridgeProxy);
    }

    /// @notice Deposit ERC20 tokens to bridge to L2
    /// @dev User must approve this contract first. Reads token metadata to pass to L2.
    /// @param token The L1 ERC20 token address
    /// @param amount The amount to bridge
    /// @param l2Recipient The L2 address to receive bridged tokens
    function deposit(address token, uint256 amount, address l2Recipient) external {
        if (!initialized) revert NotInitialized();

        // Lock tokens in vault
        if (!IERC20(token).transferFrom(msg.sender, address(this), amount)) {
            revert TransferFailed();
        }

        // Read token metadata for L2 token deployment
        string memory name = _getTokenName(token);
        string memory symbol = _getTokenSymbol(token);
        uint8 decimals = _getTokenDecimals(token);

        // Call L2 bridge via L2SenderProxy to mint bridged tokens
        // L2SenderProxy.fallback() → NativeRollupCore.handleIncomingCall()
        // On L2: L1SenderProxyL2(this) → TokenBridgeL2.mint(token, recipient, amount, name, symbol, decimals)
        (bool success,) = l2BridgeProxy.call(
            abi.encodeWithSignature(
                "mint(address,address,uint256,string,string,uint8)",
                token, l2Recipient, amount, name, symbol, decimals
            )
        );
        require(success, "L2 mint call failed");

        emit Deposited(token, msg.sender, l2Recipient, amount);
    }

    /// @notice Release locked tokens back to L1 recipient
    /// @dev Called by L2 bridge via L2SenderProxy (outgoing L2→L1 call)
    /// @param token The L1 ERC20 token address
    /// @param amount The amount to release
    /// @param recipient The L1 address to receive tokens
    function release(address token, uint256 amount, address recipient) external {
        if (msg.sender != l2BridgeProxy) revert OnlyL2BridgeProxy();

        if (!IERC20(token).transfer(recipient, amount)) {
            revert TransferFailed();
        }

        emit Released(token, recipient, amount);
    }

    /// @dev Safe name() call with fallback
    function _getTokenName(address token) internal view returns (string memory) {
        try IERC20(token).name() returns (string memory n) {
            return string.concat("Bridged ", n);
        } catch {
            return "Bridged Token";
        }
    }

    /// @dev Safe symbol() call with fallback
    function _getTokenSymbol(address token) internal view returns (string memory) {
        try IERC20(token).symbol() returns (string memory s) {
            return string.concat("b", s);
        } catch {
            return "bTKN";
        }
    }

    /// @dev Safe decimals() call with fallback
    function _getTokenDecimals(address token) internal view returns (uint8) {
        try IERC20(token).decimals() returns (uint8 d) {
            return d;
        } catch {
            return 18;
        }
    }
}
