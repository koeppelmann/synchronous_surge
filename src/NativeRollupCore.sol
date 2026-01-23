// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {OutgoingCall, IProofVerifier} from "./interfaces/IProofVerifier.sol";
import {L2SenderProxy} from "./L2SenderProxy.sol";
import {AdminProofVerifier} from "./verifiers/AdminProofVerifier.sol";

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
/// - State is committed BEFORE any L1 call executes (postExecutionStateHash)
/// - Each outgoing call specifies its expected post-call L2 state hash
/// - After each L1 call, we VERIFY l2BlockHash matches the expected post-call state
/// - If the L1 call modified l2BlockHash (via callback), it must match expectation
/// - If the L1 call didn't modify it, postCallStateHash should equal the pre-call state
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

    /// @notice Registered incoming call responses
    /// @dev Key: keccak256(l2Address, l2StateHash, callDataHash)
    mapping(bytes32 => IncomingCallResponse) public incomingCallResponses;

    /// @notice Whether an incoming call response is registered
    mapping(bytes32 => bool) public incomingCallRegistered;

    /// @notice Incoming call response structure
    /// @dev Contains the pre-computed response for an L1→L2 call
    struct IncomingCallResponse {
        bytes32 preOutgoingCallsStateHash;  // L2 state before outgoing calls
        OutgoingCall[] outgoingCalls;        // Outgoing L1 calls with per-call state hashes
        bytes[] expectedResults;             // Expected results for each outgoing call
        bytes returnValue;                   // Value to return to caller
        bytes32 finalStateHash;              // Final L2 state after all calls complete
    }

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

    /// @notice Emitted when an incoming call response is registered
    event IncomingCallRegistered(
        address indexed l2Address,
        bytes32 indexed stateHash,
        bytes32 indexed callDataHash,
        bytes32 responseKey
    );

    /// @notice Emitted when an incoming call is handled
    event IncomingCallHandled(
        address indexed l2Address,
        bytes32 indexed responseKey,
        uint256 outgoingCallsCount
    );

    error InvalidPrevBlockHash(bytes32 expected, bytes32 provided);
    error ProofVerificationFailed();
    error Reentrancy();
    error OutgoingCallFailed(uint256 index, address from, address target);
    error UnexpectedCallResult(uint256 index, bytes32 expected, bytes32 actual);
    error UnexpectedPostCallState(uint256 index, bytes32 expected, bytes32 actual);
    error OnlyOwner();
    error IncomingCallNotRegistered(bytes32 responseKey);
    error IncomingCallAlreadyRegistered(bytes32 responseKey);
    error IncomingCallProofFailed();
    error UnexpectedPreOutgoingState(bytes32 expected, bytes32 actual);
    error UnexpectedFinalState(bytes32 expected, bytes32 actual);
    error OnlyProxy();

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
    /// @param finalStateHash The final L2 state hash after all outgoing calls complete
    /// @param proof Proof of valid L2 state transition chain
    function processCallOnL2(
        bytes32 prevL2BlockHash,
        bytes calldata callData,
        bytes32 postExecutionStateHash,
        OutgoingCall[] calldata outgoingCalls,
        bytes[] calldata expectedResults,
        bytes32 finalStateHash,
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
            finalStateHash,
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

            // Verify the return data matches expectation
            bytes32 actualResultHash = keccak256(result);
            bytes32 expectedResultHash = keccak256(expectedResults[i]);
            if (actualResultHash != expectedResultHash) {
                revert UnexpectedCallResult(i, expectedResultHash, actualResultHash);
            }

            // Verify the post-call L2 state matches expectation
            // The L1 call may have modified l2BlockHash as a side effect (e.g., deposit callback)
            // If no side effect occurred, l2BlockHash should still equal the pre-call state
            // Either way, it must match the expected postCallStateHash
            if (l2BlockHash != c.postCallStateHash) {
                revert UnexpectedPostCallState(i, c.postCallStateHash, l2BlockHash);
            }

            emit L2StateUpdated(l2BlockNumber, l2BlockHash, i + 1);
        }

        // Set final state after all outgoing calls
        l2BlockHash = finalStateHash;

        // Verify final state matches expectation
        if (l2BlockHash != finalStateHash) {
            revert UnexpectedFinalState(finalStateHash, l2BlockHash);
        }

        // Emit the final block processed event
        emit L2BlockProcessed(l2BlockNumber, prevHash, l2BlockHash, outgoingCalls.length);
    }

    /// @notice Register an incoming call response
    /// @dev Anyone can register but must provide a valid proof
    /// @param l2Address The L2 contract address that will "receive" the call
    /// @param stateHash The L2 state hash at which this response is valid
    /// @param callData The calldata that triggers this response
    /// @param response The pre-computed response
    /// @param proof Proof that this response is correct (admin signature for POC)
    function registerIncomingCall(
        address l2Address,
        bytes32 stateHash,
        bytes calldata callData,
        IncomingCallResponse calldata response,
        bytes calldata proof
    ) external {
        bytes32 responseKey = _getResponseKey(l2Address, stateHash, callData);

        if (incomingCallRegistered[responseKey]) {
            revert IncomingCallAlreadyRegistered(responseKey);
        }

        // Verify the proof (admin signature for POC)
        if (!_verifyIncomingCallProof(l2Address, stateHash, callData, response, proof)) {
            revert IncomingCallProofFailed();
        }

        // Store the response
        IncomingCallResponse storage stored = incomingCallResponses[responseKey];
        stored.preOutgoingCallsStateHash = response.preOutgoingCallsStateHash;
        stored.returnValue = response.returnValue;
        stored.finalStateHash = response.finalStateHash;

        // Copy outgoing calls and expected results
        for (uint256 i = 0; i < response.outgoingCalls.length; i++) {
            stored.outgoingCalls.push(response.outgoingCalls[i]);
            stored.expectedResults.push(response.expectedResults[i]);
        }

        incomingCallRegistered[responseKey] = true;

        emit IncomingCallRegistered(l2Address, stateHash, keccak256(callData), responseKey);
    }

    /// @notice Handle an incoming call to an L2 address
    /// @dev Called by L2SenderProxy when it receives a call
    /// @param l2Address The L2 contract address being called
    /// @param callData The calldata of the incoming call
    /// @return returnData The pre-registered return value
    function handleIncomingCall(
        address l2Address,
        bytes calldata callData
    ) external returns (bytes memory returnData) {
        // Only callable by the proxy for this L2 address
        address expectedProxy = getProxyAddress(l2Address);
        if (msg.sender != expectedProxy) {
            revert OnlyProxy();
        }

        bytes32 responseKey = _getResponseKey(l2Address, l2BlockHash, callData);

        if (!incomingCallRegistered[responseKey]) {
            revert IncomingCallNotRegistered(responseKey);
        }

        IncomingCallResponse storage response = incomingCallResponses[responseKey];

        // Update state to pre-outgoing-calls state
        l2BlockHash = response.preOutgoingCallsStateHash;

        // Verify the state was updated correctly
        if (l2BlockHash != response.preOutgoingCallsStateHash) {
            revert UnexpectedPreOutgoingState(response.preOutgoingCallsStateHash, l2BlockHash);
        }

        // Execute outgoing calls (these may recursively call back)
        for (uint256 i = 0; i < response.outgoingCalls.length; i++) {
            OutgoingCall storage c = response.outgoingCalls[i];

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

            // Verify the return data matches expectation
            bytes32 actualResultHash = keccak256(result);
            bytes32 expectedResultHash = keccak256(response.expectedResults[i]);
            if (actualResultHash != expectedResultHash) {
                revert UnexpectedCallResult(i, expectedResultHash, actualResultHash);
            }

            // Verify the post-call L2 state matches expectation
            if (l2BlockHash != c.postCallStateHash) {
                revert UnexpectedPostCallState(i, c.postCallStateHash, l2BlockHash);
            }
        }

        // Update to final state after all outgoing calls
        l2BlockHash = response.finalStateHash;

        // Verify final state
        if (l2BlockHash != response.finalStateHash) {
            revert UnexpectedFinalState(response.finalStateHash, l2BlockHash);
        }

        emit IncomingCallHandled(l2Address, responseKey, response.outgoingCalls.length);

        return response.returnValue;
    }

    /// @notice Get the response key for an incoming call
    /// @param l2Address The L2 contract address
    /// @param stateHash The L2 state hash
    /// @param callData The calldata
    /// @return The response key
    function _getResponseKey(
        address l2Address,
        bytes32 stateHash,
        bytes calldata callData
    ) internal pure returns (bytes32) {
        return keccak256(abi.encode(l2Address, stateHash, keccak256(callData)));
    }

    /// @notice Get the response key (public view for external queries)
    function getResponseKey(
        address l2Address,
        bytes32 stateHash,
        bytes calldata callData
    ) external pure returns (bytes32) {
        return _getResponseKey(l2Address, stateHash, callData);
    }

    /// @notice Verify an incoming call proof (admin signature for POC)
    function _verifyIncomingCallProof(
        address l2Address,
        bytes32 stateHash,
        bytes calldata callData,
        IncomingCallResponse calldata response,
        bytes calldata proof
    ) internal view returns (bool) {
        // Hash the response data
        bytes32 messageHash = keccak256(abi.encode(
            l2Address,
            stateHash,
            keccak256(callData),
            response.preOutgoingCallsStateHash,
            _hashOutgoingCalls(response.outgoingCalls),
            _hashResults(response.expectedResults),
            keccak256(response.returnValue),
            response.finalStateHash
        ));

        bytes32 ethSignedMessageHash = keccak256(abi.encodePacked(
            "\x19Ethereum Signed Message:\n32",
            messageHash
        ));

        address signer = _recoverSigner(ethSignedMessageHash, proof);

        // For POC, we check against the proof verifier's admin
        // In production, this would use ZK proofs
        return signer == AdminProofVerifier(address(proofVerifier)).admin();
    }

    /// @notice Hash outgoing calls for proof verification
    function _hashOutgoingCalls(OutgoingCall[] calldata calls) internal pure returns (bytes32) {
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

    /// @notice Hash expected results for proof verification
    function _hashResults(bytes[] calldata results) internal pure returns (bytes32) {
        bytes memory encoded;
        for (uint256 i = 0; i < results.length; i++) {
            encoded = abi.encodePacked(encoded, keccak256(results[i]));
        }
        return keccak256(encoded);
    }

    /// @notice Recover signer from signature
    function _recoverSigner(bytes32 hash, bytes calldata signature) internal pure returns (address) {
        if (signature.length != 65) return address(0);

        bytes32 r;
        bytes32 s;
        uint8 v;

        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }

        if (v < 27) v += 27;

        return ecrecover(hash, v, r, s);
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
