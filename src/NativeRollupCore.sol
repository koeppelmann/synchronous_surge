// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {OutgoingCall, IProofVerifier} from "./interfaces/IProofVerifier.sol";
import {L2SenderProxy} from "./L2SenderProxy.sol";

/// @title NativeRollupCore
/// @author Gnosis / Nethermind
/// @notice Minimal Native Rollup core contract with L2 sender proxies
///
/// @dev CORE CONCEPT:
/// L2 state is a pure function of L1 state. Every L2 block is:
/// - Computed deterministically from previous L2 state + input calldata
/// - Proven and verified atomically with submission
/// - Able to trigger L1 calls with proper msg.sender via L2SenderProxy
///
/// SYNCHRONOUS COMPOSABILITY:
/// L1 calls can affect L2 state (e.g., deposits, callbacks). To handle this:
/// - State is committed BEFORE each L1 call executes
/// - Each outgoing call specifies its expected post-call L2 state hash
/// - This allows L1 contracts to read consistent L2 state during execution
///
/// STATE TRANSITION CHAIN:
/// prevBlockHash → postExecutionStateHash → call[0].postCallStateHash → call[1].postCallStateHash → ...
///
/// OUTGOING CALLS:
/// Each outgoing call specifies a `from` address (the L2 contract initiating the call).
/// The call is routed through a deterministic CREATE2 proxy for that L2 address.
/// This ensures L1 contracts see the correct msg.sender for each L2 caller.
///
/// @custom:security-contact security@nethermind.io
contract NativeRollupCore {
    /// @notice Current L2 block hash (the entire L2 state commitment)
    bytes32 public l2BlockHash;

    /// @notice Current L2 block number
    uint256 public l2BlockNumber;

    /// @notice Proof verifier contract
    IProofVerifier public proofVerifier;

    /// @notice Owner who can upgrade the proof verifier
    address public owner;

    /// @notice Reentrancy lock
    bool private _locked;

    /// @notice Salt used for CREATE2 proxy deployment
    bytes32 public constant PROXY_SALT = keccak256("NativeRollup.L2SenderProxy.v1");

    /// @notice Emitted when L2 state transitions
    event L2BlockProcessed(
        uint256 indexed blockNumber,
        bytes32 indexed prevBlockHash,
        bytes32 indexed newBlockHash,
        uint256 outgoingCallsCount
    );

    /// @notice Emitted when L2 state is updated (includes intermediate states)
    event L2StateUpdated(
        uint256 indexed blockNumber,
        bytes32 indexed newStateHash,
        uint256 callIndex  // 0 = post-execution, 1+ = after outgoing call
    );

    /// @notice Emitted when an outgoing L1 call is executed
    event OutgoingCallExecuted(
        uint256 indexed blockNumber,
        uint256 indexed callIndex,
        address indexed from,
        address target,
        bool success
    );

    /// @notice Emitted when a new L2SenderProxy is deployed
    event L2SenderProxyDeployed(address indexed l2Address, address indexed proxyAddress);

    /// @notice Emitted when proof verifier is upgraded
    event ProofVerifierUpgraded(address indexed oldVerifier, address indexed newVerifier);

    error InvalidPrevBlockHash(bytes32 expected, bytes32 provided);
    error ProofVerificationFailed();
    error Reentrancy();
    error OutgoingCallFailed(uint256 index, address from, address target);
    error UnexpectedCallResult(uint256 index, bytes32 expected, bytes32 actual);
    error OnlyOwner();

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    modifier noReentrancy() {
        if (_locked) revert Reentrancy();
        _locked = true;
        _;
        _locked = false;
    }

    constructor(
        bytes32 _genesisBlockHash,
        address _proofVerifier,
        address _owner
    ) {
        l2BlockHash = _genesisBlockHash;
        l2BlockNumber = 0;
        proofVerifier = IProofVerifier(_proofVerifier);
        owner = _owner;
    }

    /// @notice Process a call on L2 and execute resulting L1 calls
    /// @dev State is committed BEFORE each L1 call for synchronous composability
    /// @param prevL2BlockHash The L2 block hash before this transition
    /// @param callData The input data that was "called" on L2
    /// @param postExecutionStateHash The L2 state hash after L2 execution, BEFORE any L1 calls
    /// @param outgoingCalls Array of L1 calls, each with its expected post-call state hash
    /// @param expectedResults Expected return data for each outgoing call
    /// @param proof Proof of valid L2 state transition chain
    function processCallOnL2(
        bytes32 prevL2BlockHash,
        bytes calldata callData,
        bytes32 postExecutionStateHash,
        OutgoingCall[] calldata outgoingCalls,
        bytes[] calldata expectedResults,
        bytes calldata proof
    ) external payable noReentrancy {
        // Verify we're building on the current L2 state
        if (prevL2BlockHash != l2BlockHash) {
            revert InvalidPrevBlockHash(l2BlockHash, prevL2BlockHash);
        }

        // Verify the proof covers the entire state transition chain
        if (!proofVerifier.verifyProof(
            prevL2BlockHash,
            callData,
            postExecutionStateHash,
            outgoingCalls,
            expectedResults,
            proof
        )) {
            revert ProofVerificationFailed();
        }

        // Increment block number
        l2BlockNumber++;
        bytes32 prevHash = l2BlockHash;

        // Commit post-execution state BEFORE any L1 calls
        // This ensures L1 contracts see the L2 state that includes this block's execution
        l2BlockHash = postExecutionStateHash;
        emit L2StateUpdated(l2BlockNumber, postExecutionStateHash, 0);

        // Execute outgoing L1 calls through L2SenderProxy contracts
        for (uint256 i = 0; i < outgoingCalls.length; i++) {
            OutgoingCall calldata c = outgoingCalls[i];

            // Get or deploy the proxy for this L2 sender
            address proxy = _getOrDeployProxy(c.from);

            // Execute call through proxy with specified gas limit
            (bool success, bytes memory result) = L2SenderProxy(payable(proxy)).execute{value: c.value, gas: c.gas}(
                c.target,
                c.data
            );

            emit OutgoingCallExecuted(l2BlockNumber, i, c.from, c.target, success);

            if (!success) {
                revert OutgoingCallFailed(i, c.from, c.target);
            }

            // Verify the result matches expectation
            bytes32 actualHash = keccak256(result);
            bytes32 expectedHash = keccak256(expectedResults[i]);
            if (actualHash != expectedHash) {
                revert UnexpectedCallResult(i, expectedHash, actualHash);
            }

            // Commit the post-call L2 state
            // This captures any L2 state changes caused by this L1 call (e.g., deposits)
            l2BlockHash = c.postCallStateHash;
            emit L2StateUpdated(l2BlockNumber, c.postCallStateHash, i + 1);
        }

        // Emit the final block processed event
        // Final state is either last call's postCallStateHash or postExecutionStateHash if no calls
        emit L2BlockProcessed(l2BlockNumber, prevHash, l2BlockHash, outgoingCalls.length);
    }

    /// @notice Get the deterministic proxy address for an L2 address
    /// @param l2Address The L2 contract address
    /// @return The L1 proxy address that will be msg.sender for calls from this L2 address
    function getProxyAddress(address l2Address) public view returns (address) {
        bytes32 bytecodeHash = keccak256(abi.encodePacked(
            type(L2SenderProxy).creationCode,
            abi.encode(address(this), l2Address)
        ));

        return address(uint160(uint256(keccak256(abi.encodePacked(
            bytes1(0xff),
            address(this),
            keccak256(abi.encode(PROXY_SALT, l2Address)),
            bytecodeHash
        )))));
    }

    /// @notice Check if a proxy is deployed for an L2 address
    /// @param l2Address The L2 contract address
    /// @return True if proxy exists
    function isProxyDeployed(address l2Address) public view returns (bool) {
        address proxy = getProxyAddress(l2Address);
        uint256 size;
        assembly {
            size := extcodesize(proxy)
        }
        return size > 0;
    }

    /// @notice Get or deploy a proxy for an L2 address
    /// @param l2Address The L2 contract address
    /// @return proxy The proxy address
    function _getOrDeployProxy(address l2Address) internal returns (address proxy) {
        proxy = getProxyAddress(l2Address);

        uint256 size;
        assembly {
            size := extcodesize(proxy)
        }

        if (size == 0) {
            // Deploy new proxy
            bytes memory bytecode = abi.encodePacked(
                type(L2SenderProxy).creationCode,
                abi.encode(address(this), l2Address)
            );

            bytes32 salt = keccak256(abi.encode(PROXY_SALT, l2Address));

            assembly {
                proxy := create2(0, add(bytecode, 32), mload(bytecode), salt)
            }

            require(proxy != address(0), "Proxy deployment failed");
            emit L2SenderProxyDeployed(l2Address, proxy);
        }
    }

    /// @notice Upgrade the proof verifier
    /// @param _newVerifier Address of the new proof verifier
    function upgradeProofVerifier(address _newVerifier) external onlyOwner {
        address oldVerifier = address(proofVerifier);
        proofVerifier = IProofVerifier(_newVerifier);
        emit ProofVerifierUpgraded(oldVerifier, _newVerifier);
    }

    /// @notice Transfer ownership
    /// @param _newOwner Address of the new owner
    function transferOwnership(address _newOwner) external onlyOwner {
        owner = _newOwner;
    }

    /// @notice Allow receiving ETH for outgoing calls with value
    receive() external payable {}
}
