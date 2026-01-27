// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/NativeRollupCore.sol";
import "../src/verifiers/AdminProofVerifier.sol";

contract DeployScript is Script {
    function run() external {
        bytes32 genesisHash = vm.envBytes32("GENESIS_HASH");
        address admin = vm.envAddress("ADMIN");
        
        vm.startBroadcast();
        
        AdminProofVerifier verifier = new AdminProofVerifier(admin, admin);
        console.log("AdminProofVerifier:", address(verifier));
        
        NativeRollupCore rollup = new NativeRollupCore(genesisHash, address(verifier), admin);
        console.log("NativeRollupCore:", address(rollup));
        console.log("Genesis hash:", vm.toString(rollup.l2BlockHash()));
        
        vm.stopBroadcast();
    }
}
