// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title L1SenderProxyL2
 * @notice Proxy contract deployed on L2 that represents an L1 address
 * @dev This proxy serves two purposes:
 *
 * 1. INCOMING CALLS (L1 → L2):
 *    When an L1 address calls an L2 contract, the call flows:
 *    L1: A → B* (L2's proxy on L1) → NativeRollupCore
 *    L2: SystemAddress → A* (this proxy) → B
 *    The msg.sender from B's perspective is this proxy (A*), preserving caller identity.
 *
 * 2. OUTGOING CALLS (L2 → L1):
 *    When an L2 contract wants to call an L1 address, it calls this proxy.
 *    The proxy looks up the pre-registered return value and returns it.
 *    The actual L1 execution happens separately and must match.
 *
 * Security:
 * - Only the L2 System Address can trigger incoming calls (L1 → L2 direction)
 * - Anyone can call for outgoing direction, but they get pre-registered return values
 */
contract L1SenderProxyL2 {
    /// @notice The L2 system address (proxy of L1 NativeRollupCore)
    /// @dev This is the only address allowed to initiate L1→L2 calls through this proxy
    address public immutable systemAddress;

    /// @notice The L1 address this proxy represents
    address public immutable l1Address;

    /// @notice Reference to the L2 call registry for outgoing calls
    IL2CallRegistry public immutable callRegistry;

    /// @notice Emitted when an L1→L2 call is forwarded
    event IncomingCallForwarded(address indexed target, uint256 value, bytes data, bool success, bytes returnData);

    /// @notice Emitted when an L2→L1 call is handled (return value from registry)
    event OutgoingCallHandled(bytes4 indexed selector, bytes returnData);

    error OnlySystemAddress();
    error CallFailed(bytes returnData);
    error OutgoingCallNotRegistered();

    constructor(address _systemAddress, address _l1Address, address _callRegistry) {
        systemAddress = _systemAddress;
        l1Address = _l1Address;
        callRegistry = IL2CallRegistry(_callRegistry);
    }

    /**
     * @notice Handle incoming calls
     * @dev If called by system address: forward to target (L1→L2 direction)
     *      If called by anyone else: lookup return value from registry (L2→L1 direction)
     */
    fallback() external payable {
        if (msg.sender == systemAddress) {
            // L1 → L2 direction: System is forwarding a call from L1
            // The calldata format is: target (20 bytes) + actualCalldata
            require(msg.data.length >= 20, "Invalid calldata");

            address target;
            bytes memory data;

            assembly {
                // First 20 bytes of calldata is the target address
                target := shr(96, calldataload(0))
                // Rest is the actual calldata
                let dataLen := sub(calldatasize(), 20)
                data := mload(0x40)
                mstore(0x40, add(add(data, 0x20), dataLen))
                mstore(data, dataLen)
                calldatacopy(add(data, 0x20), 20, dataLen)
            }

            // Forward the call to the target
            (bool success, bytes memory returnData) = target.call{value: msg.value}(data);

            emit IncomingCallForwarded(target, msg.value, data, success, returnData);

            if (!success) {
                revert CallFailed(returnData);
            }

            // Return the data
            assembly {
                return(add(returnData, 0x20), mload(returnData))
            }
        } else {
            // L2 → L1 direction: Someone on L2 is calling an L1 address
            // Look up the pre-registered return value
            bytes32 callKey = keccak256(abi.encodePacked(l1Address, msg.sender, msg.data));

            (bool registered, bytes memory returnData) = callRegistry.getReturnValue(callKey);

            if (!registered) {
                revert OutgoingCallNotRegistered();
            }

            emit OutgoingCallHandled(bytes4(msg.data), returnData);

            // Return the pre-registered value
            assembly {
                return(add(returnData, 0x20), mload(returnData))
            }
        }
    }

    receive() external payable {
        if (msg.sender == systemAddress) {
            // L1 → L2 direction: System is forwarding a value transfer from L1
            // No calldata, just accept the ETH
            return;
        }

        // L2 → L1 direction: Someone on L2 is sending value to an L1 address
        // Look up the pre-registered return value (with empty calldata)
        bytes32 callKey = keccak256(abi.encodePacked(l1Address, msg.sender, bytes("")));

        (bool registered, ) = callRegistry.getReturnValue(callKey);

        if (!registered) {
            revert OutgoingCallNotRegistered();
        }

        emit OutgoingCallHandled(bytes4(0), bytes(""));
    }
}

/**
 * @title IL2CallRegistry
 * @notice Interface for the L2 call registry that stores return values for L2→L1 calls
 */
interface IL2CallRegistry {
    /**
     * @notice Get the pre-registered return value for an outgoing call
     * @param callKey The unique key for the call (hash of target, caller, calldata)
     * @return registered Whether the return value is registered
     * @return returnData The pre-registered return data
     */
    function getReturnValue(bytes32 callKey) external returns (bool registered, bytes memory returnData);
}

/**
 * @title L2CallRegistry
 * @notice Registry for pre-registered return values of L2→L1 calls
 * @dev The prover registers return values before L2 execution
 *      During L2 execution, contracts call L1 proxies which lookup values here
 */
contract L2CallRegistry is IL2CallRegistry {
    /// @notice The L2 system address - only it can register return values
    address public immutable systemAddress;

    /// @notice Queue of return values per call key (indexed by registration order)
    mapping(bytes32 => mapping(uint256 => bytes)) public returnValues;

    /// @notice Number of return values registered for each call key
    mapping(bytes32 => uint256) public callCount;

    /// @notice Number of return values consumed (popped) for each call key
    mapping(bytes32 => uint256) public consumed;

    event ReturnValueRegistered(bytes32 indexed callKey, uint256 index, bytes returnData);

    error OnlySystemAddress();

    constructor(address _systemAddress) {
        systemAddress = _systemAddress;
    }

    /**
     * @notice Register a return value for an upcoming L2→L1 call
     * @dev Appends to a queue — the same callKey can be registered multiple times
     *      with different return values for repeated calls within a single tx.
     * @param callKey The base key for the call (hash of l1Address, l2Caller, callData)
     * @param returnData The return data to provide
     */
    function registerReturnValue(bytes32 callKey, bytes calldata returnData) external {
        if (msg.sender != systemAddress) revert OnlySystemAddress();

        uint256 idx = callCount[callKey];
        returnValues[callKey][idx] = returnData;
        callCount[callKey] = idx + 1;

        emit ReturnValueRegistered(callKey, idx, returnData);
    }

    /**
     * @notice Get and consume the next pre-registered return value
     * @dev Each call advances the consumed pointer, so repeated calls
     *      with the same key get sequential return values.
     * @param callKey The base key for the call
     */
    function getReturnValue(bytes32 callKey) external override returns (bool registered, bytes memory returnData) {
        uint256 idx = consumed[callKey];
        registered = idx < callCount[callKey];
        if (registered) {
            returnData = returnValues[callKey][idx];
            consumed[callKey] = idx + 1;
        }
    }

    /**
     * @notice Check if there are unconsumed return values for a call key
     * @param callKey The base key for the call
     */
    function isRegistered(bytes32 callKey) external view returns (bool) {
        return consumed[callKey] < callCount[callKey];
    }

    /**
     * @notice Clear return values after block execution
     * @param callKeys The keys to clear
     */
    function clearReturnValues(bytes32[] calldata callKeys) external {
        if (msg.sender != systemAddress) revert OnlySystemAddress();

        for (uint256 i = 0; i < callKeys.length; i++) {
            bytes32 key = callKeys[i];
            uint256 count = callCount[key];
            for (uint256 j = 0; j < count; j++) {
                delete returnValues[key][j];
            }
            delete callCount[key];
            delete consumed[key];
        }
    }
}

/**
 * @title L1SenderProxyL2Factory
 * @notice Factory for deploying L1SenderProxyL2 contracts with deterministic addresses
 * @dev Uses CREATE2 for deterministic deployment based on L1 address
 */
contract L1SenderProxyL2Factory {
    /// @notice The L2 system address
    address public immutable systemAddress;

    /// @notice The L2 call registry
    address public immutable callRegistry;

    /// @notice Salt prefix for CREATE2
    bytes32 public constant SALT_PREFIX = keccak256("NativeRollup.L1SenderProxyL2.v1");

    /// @notice Mapping of L1 address to deployed proxy
    mapping(address => address) public proxies;

    event ProxyDeployed(address indexed l1Address, address indexed proxyAddress);

    error ProxyAlreadyDeployed();
    error OnlySystemAddress();

    constructor(address _systemAddress, address _callRegistry) {
        systemAddress = _systemAddress;
        callRegistry = _callRegistry;
    }

    /**
     * @notice Deploy a proxy for an L1 address
     * @param l1Address The L1 address to create a proxy for
     * @return proxy The deployed proxy address
     */
    function deployProxy(address l1Address) external returns (address proxy) {
        if (msg.sender != systemAddress) revert OnlySystemAddress();
        if (proxies[l1Address] != address(0)) revert ProxyAlreadyDeployed();

        bytes32 salt = keccak256(abi.encodePacked(SALT_PREFIX, l1Address));

        proxy = address(new L1SenderProxyL2{salt: salt}(systemAddress, l1Address, callRegistry));

        proxies[l1Address] = proxy;

        emit ProxyDeployed(l1Address, proxy);
    }

    /**
     * @notice Compute the proxy address for an L1 address (without deploying)
     * @param l1Address The L1 address
     * @return The deterministic proxy address
     */
    function computeProxyAddress(address l1Address) external view returns (address) {
        bytes32 salt = keccak256(abi.encodePacked(SALT_PREFIX, l1Address));

        bytes memory bytecode = abi.encodePacked(
            type(L1SenderProxyL2).creationCode,
            abi.encode(systemAddress, l1Address, callRegistry)
        );

        bytes32 hash = keccak256(
            abi.encodePacked(bytes1(0xff), address(this), salt, keccak256(bytecode))
        );

        return address(uint160(uint256(hash)));
    }

    /**
     * @notice Check if a proxy is deployed for an L1 address
     * @param l1Address The L1 address
     */
    function isProxyDeployed(address l1Address) external view returns (bool) {
        return proxies[l1Address] != address(0);
    }

    /**
     * @notice Get proxy address, returns zero if not deployed
     * @param l1Address The L1 address
     */
    function getProxy(address l1Address) external view returns (address) {
        return proxies[l1Address];
    }
}
