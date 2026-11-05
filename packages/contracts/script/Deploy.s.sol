// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {DefectArena} from "../src/DefectArena.sol";

/// Deploys DefectArena (build plan §8.7). USDC association is a separate `cast send` (see scripts/deploy.mjs):
/// forge's local simulation cannot emulate Hedera's token facade, so it can't run associateUsdc().
/// Env: DEPLOYER_PRIVATE_KEY, USDC_ADDRESS, OPERATOR_ADDRESS, RUNNER_ADDRESS, TREASURY_ADDRESS, WINDOW_SECONDS.
/// Run through `pnpm deploy:demo` (or deploy:prod) in packages/contracts, which also records the address.
contract Deploy is Script {
    function run() external returns (DefectArena arena) {
        uint256 key = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address usdc = vm.envAddress("USDC_ADDRESS");
        address operator = vm.envAddress("OPERATOR_ADDRESS");
        address runner = vm.envAddress("RUNNER_ADDRESS");
        address treasury = vm.envAddress("TREASURY_ADDRESS");
        uint64 windowSeconds = uint64(vm.envUint("WINDOW_SECONDS"));

        vm.startBroadcast(key);
        arena = new DefectArena(usdc, operator, runner, treasury, windowSeconds);
        vm.stopBroadcast();

        console2.log("DefectArena", address(arena));
        console2.log("windowSeconds", windowSeconds);
    }
}
