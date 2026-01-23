// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "forge-std/console2.sol";
import {NativeRollupCore} from "../src/NativeRollupCore.sol";
import {AdminProofVerifier} from "../src/verifiers/AdminProofVerifier.sol";

/// @title Deploy
/// @notice Deploys NativeRollupCore and AdminProofVerifier
contract Deploy is Script {
    function run() external {
        // Configuration
        bytes32 genesisBlockHash = vm.envOr("GENESIS_BLOCK_HASH", keccak256("native-rollup-genesis"));
        address admin = vm.envOr("ADMIN_ADDRESS", msg.sender);
        address owner = vm.envOr("OWNER_ADDRESS", msg.sender);

        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);

        console2.log("Deployer:", deployer);
        console2.log("Admin:", admin);
        console2.log("Owner:", owner);
        console2.log("Genesis Block Hash:", vm.toString(genesisBlockHash));

        vm.startBroadcast(deployerPrivateKey);

        // 1. Deploy AdminProofVerifier
        AdminProofVerifier proofVerifier = new AdminProofVerifier(admin, owner);
        console2.log("AdminProofVerifier deployed at:", address(proofVerifier));

        // 2. Deploy NativeRollupCore
        NativeRollupCore nativeRollup = new NativeRollupCore(
            genesisBlockHash,
            address(proofVerifier),
            owner
        );
        console2.log("NativeRollupCore deployed at:", address(nativeRollup));

        vm.stopBroadcast();

        // Output summary
        console2.log("\n=== Deployment Summary ===");
        console2.log("AdminProofVerifier:", address(proofVerifier));
        console2.log("NativeRollupCore:", address(nativeRollup));
    }
}
