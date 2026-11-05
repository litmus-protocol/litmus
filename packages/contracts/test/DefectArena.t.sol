// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {DefectArena} from "../src/DefectArena.sol";
import {IDefectArena} from "../src/interfaces/IDefectArena.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

/// Test harness: HTS association does not exist off Hedera, so it just flips the flag.
contract DefectArenaHarness is DefectArena {
    constructor(address u, address o, address r, address t, uint64 w) DefectArena(u, o, r, t, w) {}

    function associateUsdc() external override {
        usdcAssociated = true;
    }
}

contract DefectArenaTest is Test {
    uint64 constant WINDOW = 900;
    uint256 constant POOL = 100e6;
    uint256 constant VAULT = 50e6;
    uint256 constant BOND = 20e6;
    uint256 constant PRICE = 50_000;
    uint256 constant LIMIT = 10e6;
    string constant SECRET = "DFT-AAAAAAAAAAAAAAAAAAAAAAAAAA";
    bytes32 constant SALT = bytes32(uint256(0xabc));
    bytes32 constant PKG = keccak256("package");
    bytes32 constant CAN = keccak256("canaries");
    bytes32 constant ATTEMPT = keccak256("attempt-1");

    MockUSDC usdc;
    DefectArenaHarness arena;
    address operator = makeAddr("operator");
    address runner = makeAddr("runner");
    address treasury = makeAddr("treasury");
    address warden = makeAddr("warden");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address payee = makeAddr("payee");

    function setUp() public {
        vm.warp(1_762_400_000);
        vm.roll(1_000);
        usdc = new MockUSDC();
        arena = new DefectArenaHarness(address(usdc), operator, runner, treasury, WINDOW);
        arena.associateUsdc();
        usdc.mint(warden, 1_000e6);
        vm.prank(warden);
        usdc.approve(address(arena), type(uint256).max);
        usdc.mint(operator, 1_000e6);
        vm.prank(operator);
        usdc.approve(address(arena), type(uint256).max);
    }

    // ------------------------------------------------------------------ helpers

    function _defaultInvs() internal pure returns (IDefectArena.Invariant[] memory invs) {
        invs = new IDefectArena.Invariant[](3);
        invs[0] = IDefectArena.Invariant(IDefectArena.Kind.TransferLimit, bytes32(0), LIMIT);
        invs[1] = IDefectArena.Invariant(IDefectArena.Kind.Secret, keccak256(bytes(SECRET)), 0);
        invs[2] = IDefectArena.Invariant(IDefectArena.Kind.ForbiddenTool, bytes32(0), 0);
    }

    function _create(IDefectArena.Invariant[] memory invs) internal returns (uint256 id) {
        vm.prank(warden);
        id = arena.createContest(PKG, CAN, invs, uint64(block.timestamp + 60), PRICE, POOL, VAULT, BOND);
    }

    function _createOpen() internal returns (uint256 id) {
        id = _create(_defaultInvs());
        vm.warp(block.timestamp + 60);
    }

    function _commitment(string memory secret, address who, bytes32 salt) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(bytes(secret), who, salt));
    }

    function _deposit(uint256 id, address breaker, uint256 amount) internal {
        vm.prank(operator);
        arena.depositFee(id, breaker, amount, keccak256("0.0.9185802@1762412999.123456789"));
    }

    function _send(uint256 id, address to, uint256 amount) internal returns (bool transferred, bool broke) {
        vm.prank(runner);
        return arena.vaultSend(id, to, amount, alice, ATTEMPT);
    }

    /// Every unit the arena holds is owed to a contest balance or a withdrawable credit.
    function _assertConserved(uint256[] memory ids, address[] memory creditors) internal view {
        uint256 owed;
        for (uint256 i = 0; i < ids.length; i++) {
            IDefectArena.Contest memory c = arena.getContest(ids[i]);
            owed += c.pool + c.vault + c.bond + c.escrow;
        }
        for (uint256 i = 0; i < creditors.length; i++) {
            owed += arena.withdrawable(creditors[i]);
        }
        assertEq(usdc.balanceOf(address(arena)), owed, "arena balance != amounts owed");
    }

    function _conserved(uint256 id) internal view {
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        address[] memory creditors = new address[](5);
        (creditors[0], creditors[1], creditors[2], creditors[3], creditors[4]) = (warden, alice, bob, treasury, payee);
        _assertConserved(ids, creditors);
    }

    // ------------------------------------------------------------------ 1. create

    function test_01_CreateStoresEverythingAndPullsExactly() public {
        uint256 before = usdc.balanceOf(warden);
        uint256 id = _create(_defaultInvs());
        assertEq(id, 1);
        assertEq(arena.contestCount(), 1);
        assertEq(usdc.balanceOf(warden), before - (POOL + VAULT + BOND));
        assertEq(usdc.balanceOf(address(arena)), POOL + VAULT + BOND);

        IDefectArena.Contest memory c = arena.getContest(id);
        assertEq(c.warden, warden);
        assertEq(uint8(c.status), uint8(IDefectArena.Status.Active));
        assertEq(c.endTime, c.startTime + WINDOW);
        assertEq(c.pool, POOL);
        assertEq(c.initialPool, POOL);
        assertEq(c.vault, VAULT);
        assertEq(c.bond, BOND);
        assertEq(c.messagePrice, PRICE);
        assertEq(c.packageHash, PKG);
        assertEq(c.canaryHash, CAN);
        assertEq(arena.getInvariants(id).length, 3);
        assertEq(arena.phase(id), 1); // Scheduled
        vm.warp(c.startTime);
        assertEq(arena.phase(id), 2); // Open
        vm.warp(c.endTime);
        assertEq(arena.phase(id), 3); // AwaitingClose
    }

    // ------------------------------------------------------------------ 2. create reverts

    function test_02_CreateReverts() public {
        IDefectArena.Invariant[] memory none = new IDefectArena.Invariant[](0);
        uint64 start = uint64(block.timestamp + 60);
        vm.startPrank(warden);

        vm.expectRevert(IDefectArena.BadParams.selector);
        arena.createContest(PKG, CAN, none, start, PRICE, POOL, VAULT, BOND);

        IDefectArena.Invariant[] memory six = new IDefectArena.Invariant[](6);
        for (uint256 i = 0; i < 6; i++) {
            six[i] = IDefectArena.Invariant(IDefectArena.Kind.TransferLimit, bytes32(0), LIMIT);
        }
        vm.expectRevert(IDefectArena.BadParams.selector);
        arena.createContest(PKG, CAN, six, start, PRICE, POOL, VAULT, BOND);

        IDefectArena.Invariant[] memory one = new IDefectArena.Invariant[](1);
        one[0] = IDefectArena.Invariant(IDefectArena.Kind.None, bytes32(0), 0);
        vm.expectRevert(IDefectArena.BadParams.selector);
        arena.createContest(PKG, CAN, one, start, PRICE, POOL, VAULT, BOND);

        one[0] = IDefectArena.Invariant(IDefectArena.Kind.Secret, bytes32(0), 0); // secret without hash
        vm.expectRevert(IDefectArena.BadParams.selector);
        arena.createContest(PKG, CAN, one, start, PRICE, POOL, VAULT, BOND);

        one[0] = IDefectArena.Invariant(IDefectArena.Kind.TransferLimit, bytes32(0), 0); // limit of zero
        vm.expectRevert(IDefectArena.BadParams.selector);
        arena.createContest(PKG, CAN, one, start, PRICE, POOL, VAULT, BOND);

        one[0] = IDefectArena.Invariant(IDefectArena.Kind.ForbiddenTool, bytes32(0), 1); // stray field
        vm.expectRevert(IDefectArena.BadParams.selector);
        arena.createContest(PKG, CAN, one, start, PRICE, POOL, VAULT, BOND);

        IDefectArena.Invariant[] memory two = new IDefectArena.Invariant[](2);
        two[0] = IDefectArena.Invariant(IDefectArena.Kind.ForbiddenTool, bytes32(0), 0);
        two[1] = IDefectArena.Invariant(IDefectArena.Kind.ForbiddenTool, bytes32(0), 0);
        vm.expectRevert(IDefectArena.BadParams.selector);
        arena.createContest(PKG, CAN, two, start, PRICE, POOL, VAULT, BOND);

        IDefectArena.Invariant[] memory invs = _defaultInvs();
        vm.expectRevert(IDefectArena.BadParams.selector); // bond 19.99% of pool
        arena.createContest(PKG, CAN, invs, start, PRICE, POOL, VAULT, 19_990_000);

        vm.expectRevert(IDefectArena.BadParams.selector); // price below 0.01
        arena.createContest(PKG, CAN, invs, start, 9_999, POOL, VAULT, BOND);

        vm.expectRevert(IDefectArena.BadParams.selector); // start in the past
        arena.createContest(PKG, CAN, invs, uint64(block.timestamp - 1), PRICE, POOL, VAULT, BOND);

        vm.expectRevert(IDefectArena.BadParams.selector); // empty package hash
        arena.createContest(bytes32(0), CAN, invs, start, PRICE, POOL, VAULT, BOND);

        vm.expectRevert(IDefectArena.BadParams.selector); // zero vault
        arena.createContest(PKG, CAN, invs, start, PRICE, POOL, 0, BOND);
        vm.stopPrank();

        DefectArena unassociated = new DefectArena(address(usdc), operator, runner, treasury, WINDOW);
        vm.prank(warden);
        vm.expectRevert(IDefectArena.NotAssociated.selector);
        unassociated.createContest(PKG, CAN, invs, start, PRICE, POOL, VAULT, BOND);

        address broke = makeAddr("broke");
        vm.prank(broke);
        vm.expectRevert(IDefectArena.TransferFailed.selector); // no allowance / balance
        arena.createContest(PKG, CAN, invs, start, PRICE, POOL, VAULT, BOND);
    }

    // ------------------------------------------------------------------ 3. fee split

    function test_03_FeeSplit() public {
        uint256 id = _createOpen();
        _deposit(id, alice, 50_000);
        IDefectArena.Contest memory c = arena.getContest(id);
        assertEq(c.pool, POOL + 35_000);
        assertEq(c.escrow, 5_000);
        assertEq(c.messageCount, 1);
        assertEq(usdc.balanceOf(treasury), 10_000);
        _conserved(id);

        vm.prank(alice);
        vm.expectRevert(IDefectArena.NotOperator.selector);
        arena.depositFee(id, alice, 50_000, bytes32(0));
        vm.prank(operator);
        vm.expectRevert(IDefectArena.BadParams.selector);
        arena.depositFee(99, alice, 50_000, bytes32(0));
        vm.prank(operator);
        vm.expectRevert(IDefectArena.ZeroAddress.selector);
        arena.depositFee(id, address(0), 50_000, bytes32(0));
    }

    // ------------------------------------------------------------------ 4. late fees

    function test_04_FeesAfterTheEndAreRouted() public {
        uint256 id = _createOpen();
        _send(id, payee, 20e6); // over the limit: break, alice wins
        uint256 aliceBefore = usdc.balanceOf(alice);
        uint256 wardenBefore = usdc.balanceOf(warden);
        _deposit(id, alice, 50_000);
        assertEq(usdc.balanceOf(alice), aliceBefore + 35_000, "pool share to winner");
        assertEq(usdc.balanceOf(warden), wardenBefore + 5_000, "escrow share to warden");
        assertEq(arena.getContest(id).messageCount, 1);
        _conserved(id);

        uint256 id2 = _createOpen();
        vm.warp(arena.getContest(id2).endTime + arena.REVEAL_GRACE() + 1);
        arena.closeHeld(id2);
        wardenBefore = usdc.balanceOf(warden);
        _deposit(id2, bob, 50_000);
        assertEq(usdc.balanceOf(warden), wardenBefore + 40_000, "pool + escrow share to warden after Held");
        _conserved(id2);
    }

    // ------------------------------------------------------------------ 5. secret break

    function test_05_SecretBreakHappyPath() public {
        uint256 id = _createOpen();
        _deposit(id, alice, 50_000);
        vm.prank(alice);
        arena.commitBreak(id, _commitment(SECRET, alice, SALT));
        vm.roll(block.number + 1);

        uint256 wardenBefore = usdc.balanceOf(warden);
        vm.prank(alice);
        arena.revealBreak(id, 1, SECRET, SALT);

        IDefectArena.Contest memory c = arena.getContest(id);
        assertEq(uint8(c.status), uint8(IDefectArena.Status.Broken));
        assertEq(c.winner, alice);
        assertEq(c.brokenInvariant, 1);
        assertEq(usdc.balanceOf(alice), POOL + 35_000);
        assertEq(usdc.balanceOf(warden), wardenBefore + BOND + VAULT + 5_000);
        assertEq(arena.phase(id), 4);
        (bytes32 commitment,,) = arena.commits(id, alice);
        assertEq(commitment, bytes32(0), "commit cleared");
        _conserved(id);
    }

    // ------------------------------------------------------------------ 6. reveal reverts

    function test_06_RevealReverts() public {
        uint256 id = _createOpen();

        vm.prank(alice);
        vm.expectRevert(IDefectArena.NoCommit.selector);
        arena.revealBreak(id, 1, SECRET, SALT);

        vm.prank(alice);
        arena.commitBreak(id, _commitment(SECRET, alice, SALT));
        vm.prank(alice);
        vm.expectRevert(IDefectArena.CommitTooFresh.selector);
        arena.revealBreak(id, 1, SECRET, SALT);

        vm.roll(block.number + 1);
        vm.prank(alice);
        vm.expectRevert(IDefectArena.BadReveal.selector); // wrong salt
        arena.revealBreak(id, 1, SECRET, bytes32(uint256(1)));

        vm.prank(bob); // bob replays alice's commitment from his own address: he has no commit
        vm.expectRevert(IDefectArena.NoCommit.selector);
        arena.revealBreak(id, 1, SECRET, SALT);

        bytes32 aliceCommit = _commitment(SECRET, alice, SALT);
        vm.prank(bob); // bob copies alice's commitment hash itself: the hash binds alice's address
        arena.commitBreak(id, aliceCommit);
        vm.roll(block.number + 1);
        vm.prank(bob);
        vm.expectRevert(IDefectArena.BadReveal.selector);
        arena.revealBreak(id, 1, SECRET, SALT);

        vm.prank(alice);
        vm.expectRevert(IDefectArena.WrongKind.selector); // index 0 is a transfer limit
        arena.revealBreak(id, 0, SECRET, SALT);
        vm.prank(alice);
        vm.expectRevert(IDefectArena.WrongKind.selector); // out of range
        arena.revealBreak(id, 7, SECRET, SALT);

        string memory wrong = "DFT-BBBBBBBBBBBBBBBBBBBBBBBBBB";
        vm.prank(alice);
        arena.commitBreak(id, _commitment(wrong, alice, SALT));
        vm.roll(block.number + 1);
        vm.prank(alice);
        vm.expectRevert(IDefectArena.BadReveal.selector); // matches the commitment, not the secret
        arena.revealBreak(id, 1, wrong, SALT);

        vm.prank(alice);
        arena.commitBreak(id, _commitment(SECRET, alice, SALT));
        vm.roll(block.number + 1);
        vm.warp(block.timestamp + arena.COMMIT_TTL() + 1);
        vm.prank(alice);
        vm.expectRevert(IDefectArena.CommitExpired.selector);
        arena.revealBreak(id, 1, SECRET, SALT);

        // A commit made just before the end can be revealed during the grace period, not after it.
        uint256 id2 = _createOpen();
        IDefectArena.Contest memory c2 = arena.getContest(id2);
        vm.warp(c2.endTime - 1);
        vm.prank(alice);
        arena.commitBreak(id2, _commitment(SECRET, alice, SALT));
        vm.roll(block.number + 1);
        vm.warp(uint256(c2.endTime) + arena.REVEAL_GRACE() + 1);
        vm.prank(alice);
        vm.expectRevert(IDefectArena.TooLate.selector);
        arena.revealBreak(id2, 1, SECRET, SALT);
        vm.warp(uint256(c2.endTime) + arena.REVEAL_GRACE());
        vm.prank(alice);
        arena.revealBreak(id2, 1, SECRET, SALT);
        assertEq(uint8(arena.getContest(id2).status), uint8(IDefectArena.Status.Broken));

        assertEq(uint8(arena.getContest(id).status), uint8(IDefectArena.Status.Active), "first contest untouched");
    }

    // ------------------------------------------------------------------ 7. commit window

    function test_07_CommitOnlyWhileOpen() public {
        uint256 id = _create(_defaultInvs());
        bytes32 cm = _commitment(SECRET, alice, SALT);
        vm.prank(alice);
        vm.expectRevert(IDefectArena.NotOpen.selector);
        arena.commitBreak(id, cm);

        vm.warp(arena.getContest(id).endTime);
        vm.prank(alice);
        vm.expectRevert(IDefectArena.NotOpen.selector);
        arena.commitBreak(id, cm);

        vm.warp(arena.getContest(id).endTime - 1);
        vm.prank(alice);
        vm.expectRevert(IDefectArena.BadParams.selector);
        arena.commitBreak(id, bytes32(0));
    }

    // ------------------------------------------------------------------ 8-13. vaultSend

    function test_08_VaultSendWithinLimit() public {
        uint256 id = _createOpen();
        (bool transferred, bool broke) = _send(id, payee, LIMIT);
        assertTrue(transferred);
        assertFalse(broke);
        assertEq(usdc.balanceOf(payee), LIMIT);
        assertEq(arena.getContest(id).vault, VAULT - LIMIT);
        assertEq(uint8(arena.getContest(id).status), uint8(IDefectArena.Status.Active));
        _conserved(id);
    }

    function test_09_VaultSendOverLimitMovesMoneyAndBreaks() public {
        uint256 id = _createOpen();
        uint256 wardenBefore = usdc.balanceOf(warden);
        (bool transferred, bool broke) = _send(id, payee, 40e6);
        assertTrue(transferred);
        assertTrue(broke);
        assertEq(usdc.balanceOf(payee), 40e6, "agent's transfer lands");
        assertEq(usdc.balanceOf(alice), POOL, "pool goes to the session's breaker, not the recipient");
        assertEq(usdc.balanceOf(warden), wardenBefore + BOND + 10e6, "remaining vault + bond back to warden");
        IDefectArena.Contest memory c = arena.getContest(id);
        assertEq(c.winner, alice);
        assertEq(c.brokenInvariant, 0);
        _conserved(id);
    }

    function test_10_VaultSendOverLimitWithoutFundsStillBreaks() public {
        uint256 id = _createOpen();
        (bool transferred, bool broke) = _send(id, payee, 60e6);
        assertFalse(transferred);
        assertTrue(broke);
        assertEq(usdc.balanceOf(payee), 0);
        assertEq(usdc.balanceOf(alice), POOL);
        _conserved(id);
    }

    function test_11_VaultSendWithinLimitButEmptyVaultReverts() public {
        uint256 id = _createOpen();
        for (uint256 i = 0; i < 5; i++) {
            _send(id, payee, LIMIT); // drains the 50 USDC vault
        }
        vm.prank(runner);
        vm.expectRevert(IDefectArena.InsufficientVault.selector);
        arena.vaultSend(id, payee, 1, alice, ATTEMPT);
    }

    function test_12_VaultSendToBlockedReceiver() public {
        uint256 id = _createOpen();
        usdc.setBlocked(payee, true);
        vm.prank(runner);
        vm.expectRevert(IDefectArena.TransferFailed.selector);
        arena.vaultSend(id, payee, 5e6, alice, ATTEMPT);
        assertEq(arena.getContest(id).vault, VAULT, "vault unchanged");

        (bool transferred, bool broke) = _send(id, payee, 20e6); // over the limit still breaks
        assertFalse(transferred);
        assertTrue(broke);
        assertEq(usdc.balanceOf(alice), POOL);
        _conserved(id);
    }

    function test_13_VaultSendGuards() public {
        uint256 id = _create(_defaultInvs());
        vm.prank(runner);
        vm.expectRevert(IDefectArena.NotOpen.selector); // before start
        arena.vaultSend(id, payee, 1e6, alice, ATTEMPT);

        vm.warp(arena.getContest(id).startTime);
        vm.prank(alice);
        vm.expectRevert(IDefectArena.NotRunner.selector);
        arena.vaultSend(id, payee, 1e6, alice, ATTEMPT);

        vm.startPrank(runner);
        vm.expectRevert(IDefectArena.ZeroAddress.selector);
        arena.vaultSend(id, address(0), 1e6, alice, ATTEMPT);
        vm.expectRevert(IDefectArena.ZeroAddress.selector);
        arena.vaultSend(id, payee, 1e6, address(0), ATTEMPT);
        vm.expectRevert(IDefectArena.BadParams.selector);
        arena.vaultSend(id, payee, 0, alice, ATTEMPT);
        vm.stopPrank();

        vm.warp(arena.getContest(id).endTime);
        vm.prank(runner);
        vm.expectRevert(IDefectArena.NotOpen.selector); // after the window
        arena.vaultSend(id, payee, 1e6, alice, ATTEMPT);

        vm.prank(runner);
        vm.expectRevert(IDefectArena.NotActive.selector);
        arena.vaultSend(99, payee, 1e6, alice, ATTEMPT);
    }

    // ------------------------------------------------------------------ 14. emergency withdraw

    function test_14_EmergencyWithdraw() public {
        uint256 id = _createOpen();
        vm.prank(runner);
        (uint256 amount, bool broke) = arena.vaultEmergencyWithdraw(id, payee, alice, ATTEMPT);
        assertEq(amount, VAULT);
        assertTrue(broke);
        assertEq(arena.getContest(id).brokenInvariant, 2);
        assertEq(usdc.balanceOf(payee), VAULT);
        assertEq(usdc.balanceOf(alice), POOL);
        _conserved(id);

        IDefectArena.Invariant[] memory onlyLimit = new IDefectArena.Invariant[](1);
        onlyLimit[0] = IDefectArena.Invariant(IDefectArena.Kind.TransferLimit, bytes32(0), LIMIT);
        uint256 id2 = _create(onlyLimit);
        vm.warp(arena.getContest(id2).startTime);
        vm.prank(runner);
        (amount, broke) = arena.vaultEmergencyWithdraw(id2, bob, alice, ATTEMPT);
        assertEq(amount, VAULT);
        assertFalse(broke);
        assertEq(uint8(arena.getContest(id2).status), uint8(IDefectArena.Status.Active));
        assertEq(arena.getContest(id2).vault, 0);
        _conserved(id2);
    }

    // ------------------------------------------------------------------ 15. Held

    function test_15_CloseHeld() public {
        uint256 id = _createOpen();
        _deposit(id, alice, 50_000);
        _deposit(id, bob, 50_000);
        IDefectArena.Contest memory c = arena.getContest(id);

        vm.warp(uint256(c.endTime) + arena.REVEAL_GRACE());
        vm.expectRevert(IDefectArena.TooEarly.selector);
        arena.closeHeld(id);

        vm.warp(uint256(c.endTime) + arena.REVEAL_GRACE() + 1);
        uint256 wardenBefore = usdc.balanceOf(warden);
        vm.expectEmit(true, false, false, true, address(arena));
        emit IDefectArena.Held(id, 2, POOL + 70_000);
        vm.prank(bob); // anyone may close
        arena.closeHeld(id);
        assertEq(usdc.balanceOf(warden), wardenBefore + POOL + 70_000 + VAULT + BOND + 10_000);
        assertEq(arena.phase(id), 5);
        _conserved(id);

        vm.expectRevert(IDefectArena.NotActive.selector);
        arena.closeHeld(id);
    }

    // ------------------------------------------------------------------ 16. refunds

    function test_16_RefundsEscrowThenBondNeverPool() public {
        uint256 id = _createOpen();
        for (uint256 i = 0; i < 4; i++) {
            _deposit(id, alice, 50_000); // escrow 20_000
        }
        address[] memory who = new address[](2);
        uint256[] memory amts = new uint256[](2);
        (who[0], who[1]) = (alice, bob);
        (amts[0], amts[1]) = (15_000, 10_000); // 15k from escrow, then 5k escrow + 5k bond

        vm.expectEmit(true, true, false, true, address(arena));
        emit IDefectArena.Refunded(id, bob, 10_000, 10_000);
        vm.prank(operator);
        arena.refund(id, who, amts);
        IDefectArena.Contest memory c = arena.getContest(id);
        assertEq(c.escrow, 0);
        assertEq(c.bond, BOND - 5_000);
        assertEq(c.pool, POOL + 140_000, "pool untouched");
        assertEq(usdc.balanceOf(alice), 15_000);
        assertEq(usdc.balanceOf(bob), 10_000);

        // Ask for more than escrow + bond: paid only what is left.
        who = new address[](1);
        amts = new uint256[](1);
        (who[0], amts[0]) = (bob, 30e6);
        vm.expectEmit(true, true, false, true, address(arena));
        emit IDefectArena.Refunded(id, bob, 30e6, BOND - 5_000);
        vm.prank(operator);
        arena.refund(id, who, amts);
        assertEq(arena.getContest(id).bond, 0);
        assertEq(arena.getContest(id).pool, POOL + 140_000, "pool still untouched");
        _conserved(id);

        address[] memory many = new address[](11);
        uint256[] memory manyAmts = new uint256[](11);
        vm.prank(operator);
        vm.expectRevert(IDefectArena.BadParams.selector);
        arena.refund(id, many, manyAmts);
        vm.prank(operator);
        vm.expectRevert(IDefectArena.BadParams.selector);
        arena.refund(id, new address[](1), new uint256[](2));
        vm.prank(operator);
        vm.expectRevert(IDefectArena.ZeroAddress.selector);
        arena.refund(id, new address[](1), new uint256[](1));
        vm.prank(alice);
        vm.expectRevert(IDefectArena.NotOperator.selector);
        arena.refund(id, who, amts);
    }

    // ------------------------------------------------------------------ 17. void

    function test_17_VoidRefundsThenReturnsTheRest() public {
        uint256 id = _createOpen();
        _deposit(id, alice, 50_000);
        address[] memory who = new address[](1);
        uint256[] memory amts = new uint256[](1);
        (who[0], amts[0]) = (alice, 50_000);
        uint256 wardenBefore = usdc.balanceOf(warden);
        vm.prank(operator);
        arena.voidContest(id, who, amts);
        assertEq(usdc.balanceOf(alice), 50_000, "full fee refunded (5k escrow + 45k bond)");
        assertEq(usdc.balanceOf(warden), wardenBefore + (POOL + 35_000) + VAULT + (BOND - 45_000));
        assertEq(arena.phase(id), 6);
        _conserved(id);
    }

    // ------------------------------------------------------------------ 18. cancel

    function test_18_CancelOnlyWithoutMessages() public {
        uint256 id = _create(_defaultInvs());
        uint256 id2 = _create(_defaultInvs());
        uint256 wardenBefore = usdc.balanceOf(warden);
        vm.prank(operator);
        arena.cancel(id);
        assertEq(usdc.balanceOf(warden), wardenBefore + POOL + VAULT + BOND);
        assertEq(arena.phase(id), 7);

        vm.warp(arena.getContest(id2).startTime);
        _deposit(id2, alice, 50_000);
        vm.prank(operator);
        vm.expectRevert(IDefectArena.HasMessages.selector);
        arena.cancel(id2);

        vm.prank(operator);
        arena.postLogHash(id, keccak256("log"));
        assertEq(arena.getContest(id).logHash, keccak256("log"));
        vm.prank(operator);
        vm.expectRevert(IDefectArena.AlreadyPosted.selector);
        arena.postLogHash(id, keccak256("log2"));
        vm.prank(operator);
        vm.expectRevert(IDefectArena.NotActive.selector);
        arena.postLogHash(id2, keccak256("log"));
    }

    // ------------------------------------------------------------------ 19. blocked Warden

    function test_19_BlockedWardenCannotBlockABreak() public {
        uint256 id = _createOpen();
        usdc.setBlocked(warden, true);
        (, bool broke) = _send(id, payee, 20e6);
        assertTrue(broke);
        assertEq(usdc.balanceOf(alice), POOL, "winner still paid");
        uint256 credit = arena.withdrawable(warden);
        assertEq(credit, BOND + VAULT - 20e6);
        _conserved(id);

        vm.prank(warden);
        vm.expectRevert(IDefectArena.TransferFailed.selector);
        arena.withdraw();
        usdc.setBlocked(warden, false);
        uint256 before = usdc.balanceOf(warden);
        vm.prank(warden);
        arena.withdraw();
        assertEq(usdc.balanceOf(warden), before + credit);
        assertEq(arena.withdrawable(warden), 0);
        vm.prank(warden);
        vm.expectRevert(IDefectArena.BadParams.selector);
        arena.withdraw();
        _conserved(id);
    }

    // ------------------------------------------------------------------ 20. hash vector

    function test_20_HashVectorMatchesSharedPackage() public pure {
        // Same inputs and expected values as packages/shared/test/vectors.json.
        string memory secret = "DFT-AAAAAAAAAAAAAAAAAAAAAAAAAA";
        address who = 0x1111111111111111111111111111111111111111;
        bytes32 salt = 0x2222222222222222222222222222222222222222222222222222222222222222;
        assertEq(keccak256(bytes(secret)), 0x1d14e16fcb04d01e15fea2f7d56cb9b0e60d02ccdd6e1b2aaa0db4241eb1af60);
        assertEq(
            keccak256(abi.encodePacked(bytes(secret), who, salt)),
            0x021abe2eaa28209a0562b4ee7417f7bf340d2853b42929ac1c22ed0a78144a4e
        );
    }

    // ------------------------------------------------------------------ extras

    function test_ConstructorAndConstants() public {
        assertEq(arena.POOL_BPS() + arena.ARENA_BPS(), 9_000);
        assertEq(arena.MAX_REFUNDS_PER_CALL(), 10);
        assertEq(arena.usdc(), address(usdc));
        vm.expectRevert(IDefectArena.ZeroAddress.selector);
        new DefectArena(address(0), operator, runner, treasury, WINDOW);
        vm.expectRevert(IDefectArena.BadParams.selector);
        new DefectArena(address(usdc), operator, runner, treasury, 299);
    }

    function testFuzz_FeeSplitConserves(uint96 amount) public {
        vm.assume(amount > 0 && amount < 500e6);
        uint256 id = _createOpen();
        uint256 treasuryBefore = usdc.balanceOf(treasury);
        _deposit(id, alice, amount);
        IDefectArena.Contest memory c = arena.getContest(id);
        assertEq((c.pool - POOL) + c.escrow + (usdc.balanceOf(treasury) - treasuryBefore), amount);
        _conserved(id);
    }
}
