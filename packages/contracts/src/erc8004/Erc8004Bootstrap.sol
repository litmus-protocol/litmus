// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

/**
 * @title Erc8004Bootstrap
 * @dev Placeholder UUPS implementation for the ERC-8004 proxies. Adapted from MinimalUUPS in
 * github.com/erc-8004/erc-8004-contracts @ b9e466c: the only change is that the owner is the
 * initializing caller (msg.sender) instead of a hard-coded address.
 *
 * Each proxy is deployed on this bootstrap, then upgraded to the real registry with
 * upgradeToAndCall. Slot 0 holds the identity registry address, outside the ERC-7201 namespaced
 * storage, which is the layout the real registries expect.
 */
contract Erc8004Bootstrap is OwnableUpgradeable, UUPSUpgradeable {
    /// @dev Identity registry address stored at slot 0 (matches real implementations)
    address private _identityRegistry;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address identityRegistry_) public initializer {
        __Ownable_init(msg.sender);
        __UUPSUpgradeable_init();
        _identityRegistry = identityRegistry_;
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    function getVersion() external pure returns (string memory) {
        return "0.0.1";
    }
}
