// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {DefectAttestations} from "../src/DefectAttestations.sol";
import {IDefectAttestations} from "../src/interfaces/IDefectAttestations.sol";
import {ReceiverTemplate} from "../src/cre/ReceiverTemplate.sol";
import {IReceiver} from "../src/cre/IReceiver.sol";
import {IERC165} from "../src/cre/IERC165.sol";

contract DefectAttestationsTest is Test {
    // Chainlink's Sepolia simulation forwarder (MockKeystoneForwarder).
    address constant FORWARDER = 0x15fC6ae953E024d975e77382eEeC56A9101f9F88;
    address constant WINNER = 0x4DE044483C2D6997CDc70555AE3Ade3220E79fA1;
    bytes32 constant LOG_HASH = 0x3c1cfbdbee2c34b05f1ed30ae609dc964725ba4071f3e88eedbc8a9ac8b6676a;

    DefectAttestations att;

    event Attested(
        uint256 indexed contestId, uint8 status, bytes32 logHash, bool logHashMatches, bool canaryHashMatches, bool secretsMatch
    );
    event AlreadyAttested(uint256 indexed contestId);

    function setUp() public {
        att = new DefectAttestations(FORWARDER);
    }

    function _report(uint256 id, bool logOk) internal pure returns (bytes memory) {
        return abi.encode(id, uint8(2), LOG_HASH, logOk, true, true, uint32(4), uint32(4), WINNER);
    }

    function test_storesAttestationFromForwarder() public {
        vm.warp(1_800_000_000);
        vm.expectEmit(true, false, false, true);
        emit Attested(10, 2, LOG_HASH, true, true, true);
        vm.prank(FORWARDER);
        att.onReport("", _report(10, true));

        (
            uint8 status,
            bytes32 logHash,
            bool logOk,
            bool canaryOk,
            bool secretsOk,
            uint32 messageCount,
            uint32 attemptsInLog,
            address winner,
            uint256 attestedAt
        ) = att.attestations(10);
        assertEq(status, 2);
        assertEq(logHash, LOG_HASH);
        assertTrue(logOk && canaryOk && secretsOk);
        assertEq(messageCount, 4);
        assertEq(attemptsInLog, 4);
        assertEq(winner, WINNER);
        assertEq(attestedAt, 1_800_000_000);
    }

    function test_unattestedContestReadsZero() public view {
        (,,,,,,,, uint256 attestedAt) = att.attestations(99);
        assertEq(attestedAt, 0);
    }

    function test_rejectsCallerOtherThanForwarder() public {
        vm.expectRevert(abi.encodeWithSelector(ReceiverTemplate.InvalidSender.selector, address(this), FORWARDER));
        att.onReport("", _report(10, true));
    }

    function test_secondReportIsIgnored() public {
        vm.prank(FORWARDER);
        att.onReport("", _report(10, true));
        (,,,,,,,, uint256 firstAt) = att.attestations(10);

        vm.warp(block.timestamp + 100);
        vm.expectEmit(true, false, false, false);
        emit AlreadyAttested(10);
        vm.prank(FORWARDER);
        att.onReport("", _report(10, false));

        (, , bool logOk,,,,,, uint256 at) = att.attestations(10);
        assertTrue(logOk, "first report stays");
        assertEq(at, firstAt);
    }

    function test_recordsMismatches() public {
        vm.prank(FORWARDER);
        att.onReport("", _report(11, false));
        (, , bool logOk,,,,,,) = att.attestations(11);
        assertFalse(logOk);
    }

    function test_supportsReceiverInterface() public view {
        assertTrue(att.supportsInterface(type(IReceiver).interfaceId));
        assertTrue(att.supportsInterface(type(IERC165).interfaceId));
        assertEq(att.getForwarderAddress(), FORWARDER);
    }

    function test_rejectsZeroForwarder() public {
        vm.expectRevert(ReceiverTemplate.InvalidForwarderAddress.selector);
        new DefectAttestations(address(0));
    }

    function test_matchesFrozenInterface() public view {
        IDefectAttestations i = IDefectAttestations(address(att));
        (,,,,,,,, uint256 attestedAt) = i.attestations(1);
        assertEq(attestedAt, 0);
    }
}
