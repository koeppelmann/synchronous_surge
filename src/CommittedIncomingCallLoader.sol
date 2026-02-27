// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {NativeRollupCore} from "./NativeRollupCore.sol";
import {OutgoingCall} from "./interfaces/IProofVerifier.sol";

/// @title CommittedIncomingCallLoader
/// @notice Commit-reveal wrapper for NativeRollupCore.registerIncomingCall
///
/// @dev MOTIVATION — BIDIRECTIONAL MEV PROTECTION:
///   Pre-computed state transitions are vulnerable to builder front-running
///   regardless of buffering direction:
///     - L2→L1: Jordi Baylina's sync-rollups buffers execution tables via
///       loadL2Executions(). A builder observing the mempool can extract or
///       reorder these submissions.
///     - L1→L2: Martin Köppelmann's synchronous_surge buffers incoming call
///       responses via registerIncomingCall(). Same vulnerability.
///
///   This contract implements a commit-reveal scheme (adapted from ENS name
///   registration) that works for EITHER direction. The user commits an opaque
///   hash first, then reveals the actual data after a delay, preventing the
///   builder from front-running the submission in the same block.
///
/// @dev KNOWN LIMITATION:
///   In the current native rollup architecture, the block builder typically
///   constructs the execution proofs (since proof generation requires knowing
///   pending L1 state). This means the builder IS the committer in many cases,
///   reducing the immediate effectiveness of commit-reveal against the builder
///   itself. However, this contract serves as critical infrastructure for a
///   future decentralized prover market where independent parties submit
///   proven state transitions.
///
/// @dev FLOW:
///   1. User computes commitment = keccak256(l2Address, stateHash, callData,
///      response, proof, secret)
///   2. User submits opaque commitment on-chain via commit()
///   3. After MIN_COMMITMENT_AGE (1 block), user reveals via revealAndRegister()
///   4. Contract verifies hash, checks timing, and calls registerIncomingCall()
contract CommittedIncomingCallLoader {
    NativeRollupCore public immutable rollupCore;

    /// @notice Minimum age before a commitment can be revealed (1 block)
    uint256 public constant MIN_COMMITMENT_AGE = 1;

    /// @notice Maximum age before a commitment expires (256 blocks)
    uint256 public constant MAX_COMMITMENT_AGE = 256;

    /// @notice Mapping from commitment hash to block number when committed
    mapping(bytes32 => uint256) public commitments;

    /// @notice Mapping from commitment hash to the address that submitted it
    /// @dev Only the original committer can reveal, preventing leaked-secret exploitation
    mapping(bytes32 => address) public commitmentOwner;

    /// @notice Emitted when a new commitment is made
    event CommitmentMade(bytes32 indexed commitHash, address indexed committer);

    /// @notice Emitted when a commitment is revealed and the call is registered
    event CommitmentRevealed(
        bytes32 indexed commitHash,
        bytes32 indexed responseKey
    );

    error CommitmentTooNew();
    error CommitmentExpired();
    error CommitmentNotFound();
    error InvalidCommitment();

    constructor(address _rollupCore) {
        rollupCore = NativeRollupCore(payable(_rollupCore));
    }

    /// @notice Submit an opaque commitment
    /// @param commitHash The commitment hash
    function commit(bytes32 commitHash) external {
        commitments[commitHash] = block.number;
        commitmentOwner[commitHash] = msg.sender;
        emit CommitmentMade(commitHash, msg.sender);
    }

    /// @notice Reveal a commitment and register the incoming call
    /// @param l2Address The L2 contract address
    /// @param stateHash The L2 state hash at which this response is valid
    /// @param callData The calldata that triggers this response
    /// @param response The pre-computed response
    /// @param proof Proof of valid response
    /// @param secret The secret used in the commitment
    function revealAndRegister(
        address l2Address,
        bytes32 stateHash,
        bytes calldata callData,
        NativeRollupCore.IncomingCallResponse calldata response,
        bytes calldata proof,
        bytes32 secret
    ) external {
        // Compute commitment hash
        bytes32 commitHash = makeCommitment(
            l2Address,
            stateHash,
            callData,
            response,
            proof,
            secret
        );

        // Verify commitment exists
        uint256 commitBlock = commitments[commitHash];
        if (commitBlock == 0) {
            revert CommitmentNotFound();
        }

        // Verify only the original committer can reveal
        if (msg.sender != commitmentOwner[commitHash]) {
            revert CommitmentNotFound();
        }

        // Verify timing: must wait at least MIN_COMMITMENT_AGE blocks
        if (block.number < commitBlock + MIN_COMMITMENT_AGE) {
            revert CommitmentTooNew();
        }

        // Verify not expired
        if (block.number > commitBlock + MAX_COMMITMENT_AGE) {
            revert CommitmentExpired();
        }

        // Consume commitment (prevent replay)
        delete commitments[commitHash];
        delete commitmentOwner[commitHash];

        // Register the incoming call on the core contract
        rollupCore.registerIncomingCall(
            l2Address,
            stateHash,
            callData,
            response,
            proof
        );

        bytes32 responseKey = rollupCore.getResponseKey(
            l2Address,
            stateHash,
            callData
        );
        emit CommitmentRevealed(commitHash, responseKey);
    }

    /// @notice Compute a commitment hash
    /// @dev Pure function — can be called off-chain
    function makeCommitment(
        address l2Address,
        bytes32 stateHash,
        bytes calldata callData,
        NativeRollupCore.IncomingCallResponse calldata response,
        bytes calldata proof,
        bytes32 secret
    ) public pure returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    l2Address,
                    stateHash,
                    keccak256(callData),
                    keccak256(
                        abi.encode(
                            response.preOutgoingCallsStateHash,
                            response.returnValue,
                            response.finalStateHash
                        )
                    ),
                    keccak256(proof),
                    secret
                )
            );
    }
}
