// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {Erc8004Bootstrap} from "../src/erc8004/Erc8004Bootstrap.sol";
import {IdentityRegistryUpgradeable} from "../src/erc8004/IdentityRegistryUpgradeable.sol";
import {ReputationRegistryUpgradeable} from "../src/erc8004/ReputationRegistryUpgradeable.sol";

/// Deploys the ERC-8004 IdentityRegistry and ReputationRegistry as UUPS proxies (same flow as test/Erc8004.t.sol).
/// Each proxy starts on Erc8004Bootstrap (owner = deployer) and is upgraded in place to the real registry.
/// The two ERC1967Proxy CREATEs in the broadcast are, in order, identity then reputation; scripts/deploy-erc8004.mjs
/// reads them from there. Env: DEPLOYER_PRIVATE_KEY. Run through `pnpm deploy:erc8004` in packages/contracts.
contract DeployErc8004 is Script {
    function run() external returns (address identityProxy, address reputationProxy) {
        uint256 key = vm.envUint("DEPLOYER_PRIVATE_KEY");

        vm.startBroadcast(key);
        Erc8004Bootstrap bootstrap = new Erc8004Bootstrap();
        IdentityRegistryUpgradeable identityImpl = new IdentityRegistryUpgradeable();
        ReputationRegistryUpgradeable reputationImpl = new ReputationRegistryUpgradeable();

        identityProxy = address(new ERC1967Proxy(address(bootstrap), abi.encodeCall(Erc8004Bootstrap.initialize, (address(0)))));
        UUPSUpgradeable(identityProxy).upgradeToAndCall(
            address(identityImpl), abi.encodeCall(IdentityRegistryUpgradeable.initialize, ())
        );

        reputationProxy =
            address(new ERC1967Proxy(address(bootstrap), abi.encodeCall(Erc8004Bootstrap.initialize, (identityProxy))));
        UUPSUpgradeable(reputationProxy).upgradeToAndCall(
            address(reputationImpl), abi.encodeCall(ReputationRegistryUpgradeable.initialize, (identityProxy))
        );
        vm.stopBroadcast();

        console2.log("IdentityRegistry proxy", identityProxy);
        console2.log("ReputationRegistry proxy", reputationProxy);
    }
}
