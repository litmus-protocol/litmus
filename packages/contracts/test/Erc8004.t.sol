// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {Erc8004Bootstrap} from "../src/erc8004/Erc8004Bootstrap.sol";
import {IdentityRegistryUpgradeable} from "../src/erc8004/IdentityRegistryUpgradeable.sol";
import {ReputationRegistryUpgradeable} from "../src/erc8004/ReputationRegistryUpgradeable.sol";

contract Erc8004Test is Test {
    address deployer = makeAddr("deployer");
    address warden = makeAddr("warden");
    address operator = makeAddr("operator");

    IdentityRegistryUpgradeable identity;
    ReputationRegistryUpgradeable reputation;

    string constant URI = "data:application/json;base64,e30=";

    function setUp() public {
        (identity, reputation) = _deploy();
    }

    /// Same flow as script/DeployErc8004.s.sol: bootstrap impl, one proxy per registry, upgrade each in place.
    function _deploy() internal returns (IdentityRegistryUpgradeable id, ReputationRegistryUpgradeable rep) {
        vm.startPrank(deployer);
        Erc8004Bootstrap bootstrap = new Erc8004Bootstrap();
        IdentityRegistryUpgradeable identityImpl = new IdentityRegistryUpgradeable();
        ReputationRegistryUpgradeable reputationImpl = new ReputationRegistryUpgradeable();

        ERC1967Proxy identityProxy =
            new ERC1967Proxy(address(bootstrap), abi.encodeCall(Erc8004Bootstrap.initialize, (address(0))));
        UUPSUpgradeable(address(identityProxy)).upgradeToAndCall(
            address(identityImpl), abi.encodeCall(IdentityRegistryUpgradeable.initialize, ())
        );

        ERC1967Proxy reputationProxy =
            new ERC1967Proxy(address(bootstrap), abi.encodeCall(Erc8004Bootstrap.initialize, (address(identityProxy))));
        UUPSUpgradeable(address(reputationProxy)).upgradeToAndCall(
            address(reputationImpl), abi.encodeCall(ReputationRegistryUpgradeable.initialize, (address(identityProxy)))
        );
        vm.stopPrank();

        id = IdentityRegistryUpgradeable(address(identityProxy));
        rep = ReputationRegistryUpgradeable(address(reputationProxy));
    }

    function _register() internal returns (uint256 agentId) {
        vm.prank(warden);
        agentId = identity.register(URI);
    }

    function _feedback(address from) internal {
        vm.prank(from);
        reputation.giveFeedback(0, 100, 0, "defect.held", "prod:12", "https://x/contests/12", URI, keccak256("f"));
    }

    function test_registerMintsToCaller() public {
        uint256 agentId = _register();
        assertEq(agentId, 0);
        assertEq(identity.ownerOf(0), warden);
        assertEq(identity.tokenURI(0), URI);
        assertEq(identity.getAgentWallet(0), warden);
    }

    function test_operatorCanGiveFeedback() public {
        _register();
        _feedback(operator);

        address[] memory clients = new address[](1);
        clients[0] = operator;
        (
            address[] memory outClients,
            uint64[] memory indexes,
            int128[] memory values,
            uint8[] memory decimals,
            string[] memory tag1s,
            string[] memory tag2s,
            bool[] memory revoked
        ) = reputation.readAllFeedback(0, clients, "", "", false);

        assertEq(outClients.length, 1);
        assertEq(outClients[0], operator);
        assertEq(indexes[0], 1);
        assertEq(values[0], 100);
        assertEq(decimals[0], 0);
        assertEq(tag1s[0], "defect.held");
        assertEq(tag2s[0], "prod:12");
        assertFalse(revoked[0]);
        assertEq(reputation.getLastIndex(0, operator), 1);
    }

    function test_ownerCannotGiveFeedback() public {
        _register();
        vm.expectRevert(bytes("Self-feedback not allowed"));
        _feedback(warden);
    }

    function test_approvedOperatorIsBlocked() public {
        _register();
        vm.prank(warden);
        identity.approve(operator, 0);
        assertTrue(identity.isAuthorizedOrOwner(operator, 0));

        vm.expectRevert(bytes("Self-feedback not allowed"));
        _feedback(operator);
    }

    function test_registriesAreOwnedByDeployer() public view {
        assertEq(OwnableUpgradeable(address(identity)).owner(), deployer);
        assertEq(OwnableUpgradeable(address(reputation)).owner(), deployer);
        assertEq(reputation.getIdentityRegistry(), address(identity));
    }
}
