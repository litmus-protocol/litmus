// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {DefectCertificate} from "../src/DefectCertificate.sol";
import {IDefectArena} from "../src/interfaces/IDefectArena.sol";
import {IDefectCertificate} from "../src/interfaces/IDefectCertificate.sol";
import {DefectArenaHarness} from "./DefectArena.t.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

contract DefectCertificateTest is Test {
    uint64 constant WINDOW = 900;
    uint256 constant POOL = 1e6;
    uint256 constant VAULT = 0.6e6;
    uint256 constant BOND = 0.2e6;
    uint256 constant PRICE = 50_000;
    bytes32 constant PKG = keccak256("package");
    bytes32 constant CAN = keccak256("canaries");

    MockUSDC usdc;
    DefectArenaHarness arena;
    DefectCertificate cert;
    address operator = makeAddr("operator");
    address runner = makeAddr("runner");
    address treasury = makeAddr("treasury");
    address warden = makeAddr("warden");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    function setUp() public {
        vm.warp(1_762_400_000);
        vm.roll(1_000);
        usdc = new MockUSDC();
        arena = new DefectArenaHarness(address(usdc), operator, runner, treasury, WINDOW);
        arena.associateUsdc();
        cert = new DefectCertificate(address(arena));
        usdc.mint(warden, 100e6);
        vm.prank(warden);
        usdc.approve(address(arena), type(uint256).max);
        usdc.mint(operator, 100e6);
        vm.prank(operator);
        usdc.approve(address(arena), type(uint256).max);
    }

    // ------------------------------------------------------------------ helpers

    function _invs() internal pure returns (IDefectArena.Invariant[] memory invs) {
        invs = new IDefectArena.Invariant[](3);
        invs[0] = IDefectArena.Invariant(IDefectArena.Kind.TransferLimit, bytes32(0), 10e6);
        invs[1] = IDefectArena.Invariant(IDefectArena.Kind.Secret, keccak256("DFT-AAAAAAAAAAAAAAAAAAAAAAAAAA"), 0);
        invs[2] = IDefectArena.Invariant(IDefectArena.Kind.ForbiddenTool, bytes32(0), 0);
    }

    /// Creates a contest, opens it, deposits `messages` fees, and returns its id (still Active).
    function _contestWithMessages(uint256 messages) internal returns (uint256 id) {
        vm.prank(warden);
        id = arena.createContest(PKG, CAN, _invs(), uint64(block.timestamp + 60), PRICE, POOL, VAULT, BOND);
        vm.warp(block.timestamp + 60);
        for (uint256 i = 0; i < messages; i++) {
            vm.prank(operator);
            arena.depositFee(id, i % 2 == 0 ? alice : bob, PRICE, keccak256(abi.encode(i)));
        }
    }

    function _held(uint256 messages) internal returns (uint256 id) {
        id = _contestWithMessages(messages);
        vm.warp(arena.getContest(id).endTime + arena.REVEAL_GRACE() + 1);
        arena.closeHeld(id);
    }

    function _mint(uint256 id) internal {
        vm.prank(operator);
        cert.mint(id);
    }

    /// Metadata JSON, after checking that tokenURI is exactly its base64 data URI.
    function _decodeTokenJson(uint256 id) internal view returns (string memory json) {
        json = cert.tokenJson(id);
        assertEq(cert.tokenURI(id), string.concat("data:application/json;base64,", Base64.encode(bytes(json))));
    }

    function _contains(string memory hay, string memory needle) internal pure returns (bool) {
        bytes memory h = bytes(hay);
        bytes memory n = bytes(needle);
        if (n.length > h.length) return false;
        for (uint256 i = 0; i <= h.length - n.length; i++) {
            bool ok = true;
            for (uint256 j = 0; j < n.length; j++) {
                if (h[i + j] != n[j]) {
                    ok = false;
                    break;
                }
            }
            if (ok) return true;
        }
        return false;
    }

    // ------------------------------------------------------------------ tests

    function test_MintHeldStoresArenaNumbersAndGoesToWarden() public {
        uint256 id = _held(4);
        vm.prank(operator);
        uint256 tokenId = cert.mint(id);

        assertEq(tokenId, id);
        assertEq(cert.ownerOf(id), warden);
        assertEq(cert.balanceOf(warden), 1);
        assertEq(cert.totalMinted(), 1);
        assertTrue(cert.locked(id));

        IDefectCertificate.Certificate memory c = cert.getCertificate(id);
        assertEq(c.warden, warden);
        assertEq(c.messageCount, 4);
        assertEq(c.endTime - c.startTime, WINDOW);
        assertEq(c.poolAtStake, POOL + 4 * 35_000); // 70% of each 0.05 USDC fee
        assertEq(c.ruleKinds, 2 | 4 | 8);
        assertEq(c.packageHash, PKG);
        assertFalse(c.reported);
    }

    function test_MintRevertsUnlessHeld() public {
        uint256 active = _contestWithMessages(1);
        vm.prank(operator);
        vm.expectRevert(IDefectCertificate.NotHeld.selector);
        cert.mint(active);

        // Broken contest: an over-limit vault send.
        vm.prank(runner);
        arena.vaultSend(active, alice, 11e6, alice, keccak256("a"));
        assertEq(uint8(arena.getContest(active).status), uint8(IDefectArena.Status.Broken));
        vm.prank(operator);
        vm.expectRevert(IDefectCertificate.NotHeld.selector);
        cert.mint(active);

        // Unknown contest.
        vm.prank(operator);
        vm.expectRevert(IDefectCertificate.NotHeld.selector);
        cert.mint(999);
    }

    function test_MintOperatorOnly() public {
        uint256 id = _held(1);
        vm.prank(warden);
        vm.expectRevert(IDefectCertificate.NotOperator.selector);
        cert.mint(id);
        vm.prank(alice);
        vm.expectRevert(IDefectCertificate.NotOperator.selector);
        cert.mint(id);
        assertEq(cert.totalMinted(), 0);
    }

    function test_MintOnlyOnce() public {
        uint256 id = _held(0);
        _mint(id);
        vm.prank(operator);
        vm.expectRevert(IDefectCertificate.AlreadyMinted.selector);
        cert.mint(id);
    }

    function test_Soulbound() public {
        uint256 id = _held(1);
        _mint(id);
        vm.startPrank(warden);
        vm.expectRevert(IDefectCertificate.Soulbound.selector);
        cert.transferFrom(warden, alice, id);
        vm.expectRevert(IDefectCertificate.Soulbound.selector);
        cert.safeTransferFrom(warden, alice, id);
        vm.expectRevert(IDefectCertificate.Soulbound.selector);
        cert.approve(alice, id);
        vm.expectRevert(IDefectCertificate.Soulbound.selector);
        cert.setApprovalForAll(alice, true);
        vm.stopPrank();
        assertEq(cert.ownerOf(id), warden);
        assertTrue(cert.supportsInterface(0xb45a3c0e)); // ERC-5192
        assertTrue(cert.supportsInterface(0x80ac58cd)); // ERC-721
    }

    function test_SetReportOperatorOnlyOnceAndValidated() public {
        uint256 id = _held(4);

        vm.prank(operator);
        vm.expectRevert(IDefectCertificate.NotMinted.selector);
        cert.setReport(id, 2, "TreasuryBot");

        _mint(id);

        vm.prank(alice);
        vm.expectRevert(IDefectCertificate.NotOperator.selector);
        cert.setReport(id, 2, "TreasuryBot");

        vm.startPrank(operator);
        vm.expectRevert(IDefectCertificate.BadReport.selector);
        cert.setReport(id, 5, "TreasuryBot"); // more breakers than messages
        vm.expectRevert(IDefectCertificate.BadReport.selector);
        cert.setReport(id, 2, ""); // empty name
        vm.expectRevert(IDefectCertificate.BadReport.selector);
        cert.setReport(id, 2, 'Bot"><script>'); // unsafe characters
        vm.expectRevert(IDefectCertificate.BadReport.selector);
        cert.setReport(id, 2, "ABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNO"); // 41 chars

        cert.setReport(id, 2, "TreasuryBot v1.0");
        vm.expectRevert(IDefectCertificate.AlreadyReported.selector);
        cert.setReport(id, 1, "Other");
        vm.stopPrank();

        IDefectCertificate.Certificate memory c = cert.getCertificate(id);
        assertTrue(c.reported);
        assertEq(c.uniqueBreakers, 2);
        assertEq(c.agentName, "TreasuryBot v1.0");
    }

    function test_TokenUriMetadata() public {
        uint256 id = _held(4);
        _mint(id);

        string memory before = _decodeTokenJson(id);
        assertTrue(_contains(before, '"name":"Litmus Held Certificate: Contest #1"'));
        assertTrue(_contains(before, '"value":"15 minutes"'));
        assertTrue(_contains(before, '"trait_type":"Messages survived","display_type":"number","value":4'));
        assertTrue(_contains(before, '"value":"1.14"')); // 1 + 4 x 0.035
        assertTrue(_contains(before, '"value":"Transfer limit, Secret, Forbidden tool"'));
        assertTrue(_contains(before, '"trait_type":"Unique Breakers (reported)","value":"not reported"'));
        assertTrue(_contains(before, '"value":"not posted yet"'));
        assertTrue(_contains(before, "data:image/svg+xml;base64,"));

        vm.prank(operator);
        cert.setReport(id, 2, "TreasuryBot");
        vm.prank(operator);
        arena.postLogHash(id, keccak256("log"));

        string memory afterReport = _decodeTokenJson(id);
        assertTrue(_contains(afterReport, '"name":"Litmus Held Certificate: TreasuryBot"'));
        assertTrue(_contains(afterReport, '"trait_type":"Unique Breakers (reported)","value":2'));
        assertFalse(_contains(afterReport, "not posted yet"));
    }

    function test_TokenUriShowsLiveLogHash() public {
        uint256 id = _held(0);
        _mint(id);
        bytes32 h = keccak256("log");
        vm.prank(operator);
        arena.postLogHash(id, h);
        assertTrue(_contains(_decodeTokenJson(id), vm.toString(h)));
    }

    function test_TokenUriRevertsForMissingToken() public {
        vm.expectRevert();
        cert.tokenURI(1);
        vm.expectRevert();
        cert.locked(1);
    }

    function test_DurationAndUsdcFormatting() public {
        // 8-hour window deployment.
        DefectArenaHarness longArena = new DefectArenaHarness(address(usdc), operator, runner, treasury, 28_800);
        longArena.associateUsdc();
        DefectCertificate longCert = new DefectCertificate(address(longArena));
        vm.prank(warden);
        usdc.approve(address(longArena), type(uint256).max);
        vm.prank(warden);
        uint256 id = longArena.createContest(PKG, CAN, _invs(), uint64(block.timestamp + 60), PRICE, 2e6, VAULT, 0.4e6);
        vm.warp(longArena.getContest(id).endTime + 601);
        longArena.closeHeld(id);
        vm.prank(operator);
        longCert.mint(id);

        string memory json = longCert.tokenJson(id);
        assertTrue(_contains(json, '"value":"8 hours"'));
        assertTrue(_contains(json, '"trait_type":"Pool at stake (USDC)","value":"2"'));
    }

    function test_ConstructorReadsOperator() public view {
        assertEq(cert.operator(), operator);
        assertEq(cert.arena(), address(arena));
    }

    /// The card is plain SVG built from the certificate's data. This also prints the token JSON (run with -vv) so the
    /// image can be extracted and looked at: `forge test --match-test test_RenderCard -vv`.
    function test_RenderCard() public {
        uint256 id = _held(12);
        _mint(id);
        vm.prank(operator);
        cert.setReport(id, 2, "VaultKeeper");
        string memory json = cert.tokenJson(id);
        console2.log("TOKENJSON_BEGIN_12");
        console2.log(json);
        console2.log("TOKENJSON_END");
        assertTrue(_contains(json, '"name":"Litmus Held Certificate: VaultKeeper"'));
        assertTrue(_contains(json, "data:image/svg+xml;base64,"));

        // One attack: the singular form, and a contest whose agent name was never reported.
        uint256 id2 = _held(1);
        _mint(id2);
        console2.log("TOKENJSON_BEGIN_1");
        console2.log(cert.tokenJson(id2));
        console2.log("TOKENJSON_END");
    }
}
