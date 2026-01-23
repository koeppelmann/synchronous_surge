// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Call, IProofVerifier} from "./interfaces/IProofVerifier.sol";
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
    /// @dev Flattened execution - builder pre-computes entire execution trace
    /// @param prevL2BlockHash The L2 block hash before this transition
    /// @param callData The input data that was "called" on L2
    /// @param resultL2BlockHash The L2 block hash after execution
    /// @param outgoingCalls Array of L1 calls triggered by L2 execution
    /// @param expectedResults Expected return data for each outgoing call
    /// @param proof Proof of valid L2 state transition
    function processCallOnL2(
        bytes32 prevL2BlockHash,
        bytes calldata callData,
        bytes32 resultL2BlockHash,
        Call[] calldata outgoingCalls,
        bytes[] calldata expectedResults,
        bytes calldata proof
    ) external payable noReentrancy {
        // Verify we're building on the current L2 state
        if (prevL2BlockHash != l2BlockHash) {
            revert InvalidPrevBlockHash(l2BlockHash, prevL2BlockHash);
        }

        // Verify the proof
        if (!proofVerifier.verifyProof(
            prevL2BlockHash,
            callData,
            resultL2BlockHash,
            outgoingCalls,
            expectedResults,
            proof
        )) {
            revert ProofVerificationFailed();
        }

        // Note: msg.value represents deposits into the rollup
        // Outgoing calls use previously deposited funds from contract balance
        // The proof system ensures the state transition is valid

        // Commit new state
        bytes32 prevHash = l2BlockHash;
        l2BlockHash = resultL2BlockHash;
        l2BlockNumber++;

        emit L2BlockProcessed(l2BlockNumber, prevHash, resultL2BlockHash, outgoingCalls.length);

        // Execute outgoing L1 calls through L2SenderProxy contracts
        for (uint256 i = 0; i < outgoingCalls.length; i++) {
            Call calldata c = outgoingCalls[i];

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
        }
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
