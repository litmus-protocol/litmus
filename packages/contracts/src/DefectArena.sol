// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IDefectArena} from "./interfaces/IDefectArena.sol";

/// HIP-719 token facade (github.com/hiero-ledger/hiero-contracts, IHRC719.sol).
interface IHRC719 {
    function associate() external returns (uint256 responseCode);
    function isAssociated() external view returns (bool);
}

interface IERC20Like {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @title DefectArena
/// @notice Holds every Defect contest and all of its USDC. Breaks are proven by code and paid in the
///         same transaction that proves them. Behavior is specified in build plan §8.
contract DefectArena is IDefectArena {
    struct Commit {
        bytes32 commitment;
        uint64 blockNumber;
        uint64 time;
    }

    uint256 public constant BPS = 10_000;
    uint256 public constant POOL_BPS = 7_000; // D12
    uint256 public constant ARENA_BPS = 2_000; // D12; escrow gets the remainder (10%)
    uint256 public constant MIN_BOND_PERCENT = 20; // D14
    uint256 public constant MIN_MESSAGE_PRICE = 10_000; // 0.01 USDC, D11
    uint64 public constant REVEAL_GRACE = 600; // 10 min, D17
    uint64 public constant COMMIT_TTL = 1_800; // 30 min, D17
    uint256 public constant MAX_INVARIANTS = 5;
    uint256 public constant MAX_REFUNDS_PER_CALL = 10; // each refund is an HTS transfer (~700k gas)

    // HTS response codes accepted from associate()
    uint256 private constant HTS_SUCCESS = 22;
    uint256 private constant HTS_ALREADY_ASSOCIATED = 194;

    address public immutable usdc;
    address public immutable operator;
    address public immutable runner;
    address public immutable treasury;
    uint64 public immutable windowSeconds;

    uint256 public nextContestId = 1;
    bool public usdcAssociated;
    mapping(uint256 => Contest) internal _contests;
    mapping(uint256 => Invariant[]) internal _invariants;
    mapping(uint256 => mapping(address => Commit)) public commits;
    mapping(address => uint256) public withdrawable;
    uint256 private _lock = 1;

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    modifier onlyRunner() {
        if (msg.sender != runner) revert NotRunner();
        _;
    }

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(address usdc_, address operator_, address runner_, address treasury_, uint64 windowSeconds_) {
        if (usdc_ == address(0) || operator_ == address(0) || runner_ == address(0) || treasury_ == address(0)) {
            revert ZeroAddress();
        }
        if (windowSeconds_ < 300) revert BadParams();
        usdc = usdc_;
        operator = operator_;
        runner = runner_;
        treasury = treasury_;
        windowSeconds = windowSeconds_;
    }

    // ------------------------------------------------------------------ setup

    /// @inheritdoc IDefectArena
    function associateUsdc() external virtual {
        (bool ok, bytes memory data) = usdc.call(abi.encodeWithSelector(IHRC719.associate.selector));
        if (!ok || data.length < 32) revert NotAssociated();
        uint256 code = abi.decode(data, (uint256));
        if (code != HTS_SUCCESS && code != HTS_ALREADY_ASSOCIATED) revert NotAssociated();
        usdcAssociated = true;
    }

    // ------------------------------------------------------------------ Warden

    /// @inheritdoc IDefectArena
    function createContest(
        bytes32 packageHash,
        bytes32 canaryHash,
        Invariant[] calldata invs,
        uint64 startTime,
        uint256 messagePrice,
        uint256 pool,
        uint256 vaultAmount,
        uint256 bond
    ) external nonReentrant returns (uint256 id) {
        if (!usdcAssociated) revert NotAssociated();
        if (invs.length == 0 || invs.length > MAX_INVARIANTS) revert BadParams();
        if (packageHash == bytes32(0) || canaryHash == bytes32(0)) revert BadParams();
        if (startTime < block.timestamp) revert BadParams();
        if (pool == 0 || vaultAmount == 0) revert BadParams();
        if (bond * 100 < pool * MIN_BOND_PERCENT) revert BadParams();
        if (messagePrice < MIN_MESSAGE_PRICE) revert BadParams();
        _validateInvariants(invs);

        id = nextContestId++;
        Contest storage c = _contests[id];
        c.warden = msg.sender;
        c.status = Status.Active;
        c.startTime = startTime;
        c.endTime = startTime + windowSeconds;
        c.messagePrice = messagePrice;
        c.initialPool = pool;
        c.pool = pool;
        c.vault = vaultAmount;
        c.bond = bond;
        c.packageHash = packageHash;
        c.canaryHash = canaryHash;
        for (uint256 i = 0; i < invs.length; i++) {
            _invariants[id].push(invs[i]);
        }

        _pull(msg.sender, pool + vaultAmount + bond);
        _emitCreated(id);
    }

    // ------------------------------------------------------------------ operator (gateway)

    /// @inheritdoc IDefectArena
    function depositFee(uint256 id, address breaker, uint256 amount, bytes32 paymentRef)
        external
        onlyOperator
        nonReentrant
    {
        Contest storage c = _contests[id];
        if (c.status == Status.None || amount == 0) revert BadParams();
        if (breaker == address(0)) revert ZeroAddress();

        uint256 poolShare = amount * POOL_BPS / BPS;
        uint256 arenaShare = amount * ARENA_BPS / BPS;
        uint256 escrowShare = amount - poolShare - arenaShare;

        _pull(msg.sender, amount);
        c.messageCount++;

        if (c.status == Status.Active) {
            c.pool += poolShare;
            c.escrow += escrowShare;
        } else if (c.status == Status.Broken) {
            _payOrCredit(c.winner, poolShare);
            _payOrCredit(c.warden, escrowShare);
        } else {
            _payOrCredit(c.warden, poolShare + escrowShare);
        }
        _payOrCredit(treasury, arenaShare);

        emit FeeDeposited(id, breaker, amount, poolShare, arenaShare, escrowShare, paymentRef);
    }

    /// @inheritdoc IDefectArena
    function refund(uint256 id, address[] calldata breakers, uint256[] calldata amounts)
        external
        onlyOperator
        nonReentrant
    {
        _checkRefundArgs(id, breakers, amounts);
        for (uint256 i = 0; i < breakers.length; i++) {
            _refundOne(id, breakers[i], amounts[i]);
        }
    }

    /// @inheritdoc IDefectArena
    function voidContest(uint256 id, address[] calldata breakers, uint256[] calldata amounts)
        external
        onlyOperator
        nonReentrant
    {
        _checkRefundArgs(id, breakers, amounts);
        for (uint256 i = 0; i < breakers.length; i++) {
            _refundOne(id, breakers[i], amounts[i]);
        }
        Contest storage c = _contests[id];
        c.status = Status.Void;
        _payOrCredit(c.warden, _drain(c));
        emit Voided(id);
    }

    /// @inheritdoc IDefectArena
    function cancel(uint256 id) external onlyOperator nonReentrant {
        Contest storage c = _contests[id];
        if (c.status != Status.Active) revert NotActive();
        if (c.messageCount != 0) revert HasMessages();
        c.status = Status.Cancelled;
        _payOrCredit(c.warden, _drain(c));
        emit Cancelled(id);
    }

    /// @inheritdoc IDefectArena
    function postLogHash(uint256 id, bytes32 logHash) external onlyOperator {
        Contest storage c = _contests[id];
        if (c.status == Status.None || logHash == bytes32(0)) revert BadParams();
        if (c.status == Status.Active) revert NotActive();
        if (c.logHash != bytes32(0)) revert AlreadyPosted();
        c.logHash = logHash;
        emit LogHashPosted(id, logHash);
    }

    // ------------------------------------------------------------------ Breaker

    /// @inheritdoc IDefectArena
    function commitBreak(uint256 id, bytes32 commitment) external {
        Contest storage c = _contests[id];
        if (c.status != Status.Active) revert NotActive();
        if (block.timestamp < c.startTime || block.timestamp >= c.endTime) revert NotOpen();
        if (commitment == bytes32(0)) revert BadParams();
        commits[id][msg.sender] = Commit(commitment, uint64(block.number), uint64(block.timestamp));
        emit BreakCommitted(id, msg.sender, commitment);
    }

    /// @inheritdoc IDefectArena
    function revealBreak(uint256 id, uint8 invariantIndex, string calldata secret, bytes32 salt)
        external
        nonReentrant
    {
        Contest storage c = _contests[id];
        if (c.status != Status.Active) revert NotActive();
        Commit storage cm = commits[id][msg.sender];
        if (cm.commitment == bytes32(0)) revert NoCommit();
        // A later block, so nobody can copy a secret out of a pending reveal.
        if (block.number <= cm.blockNumber) revert CommitTooFresh();
        if (block.timestamp > uint256(cm.time) + COMMIT_TTL) revert CommitExpired();
        if (block.timestamp > uint256(c.endTime) + REVEAL_GRACE) revert TooLate();
        if (keccak256(abi.encodePacked(bytes(secret), msg.sender, salt)) != cm.commitment) revert BadReveal();
        Invariant[] storage invs = _invariants[id];
        if (invariantIndex >= invs.length || invs[invariantIndex].kind != Kind.Secret) revert WrongKind();
        if (keccak256(bytes(secret)) != invs[invariantIndex].secretHash) revert BadReveal();

        delete commits[id][msg.sender];
        _break(id, invariantIndex, msg.sender);
    }

    // ------------------------------------------------------------------ runner (the agent's vault)

    /// @inheritdoc IDefectArena
    function vaultSend(uint256 id, address to, uint256 amount, address breaker, bytes32 attemptId)
        external
        onlyRunner
        nonReentrant
        returns (bool transferred, bool broke)
    {
        Contest storage c = _checkVaultCall(id, to, breaker);
        if (amount == 0) revert BadParams();

        bool overLimit;
        uint8 idx;
        Invariant[] storage invs = _invariants[id];
        for (uint256 i = 0; i < invs.length; i++) {
            if (invs[i].kind == Kind.TransferLimit && amount > invs[i].maxAmount) {
                overLimit = true;
                idx = uint8(i);
                break;
            }
        }

        if (amount <= c.vault) {
            c.vault -= amount;
            transferred = _tryTransfer(to, amount);
            if (!transferred) {
                c.vault += amount;
                if (!overLimit) revert TransferFailed();
            }
        } else if (!overLimit) {
            revert InsufficientVault();
        }
        // D7: an over-limit request without the funds still counts.

        emit VaultSend(id, attemptId, breaker, to, amount, transferred);

        if (overLimit) {
            _break(id, idx, breaker);
            broke = true;
        }
    }

    /// @inheritdoc IDefectArena
    function vaultEmergencyWithdraw(uint256 id, address to, address breaker, bytes32 attemptId)
        external
        onlyRunner
        nonReentrant
        returns (uint256 amount, bool broke)
    {
        Contest storage c = _checkVaultCall(id, to, breaker);

        amount = c.vault;
        bool transferred;
        if (amount > 0) {
            c.vault = 0;
            transferred = _tryTransfer(to, amount);
            if (!transferred) c.vault = amount;
        }

        emit VaultEmergencyWithdraw(id, attemptId, breaker, to, amount, transferred);

        Invariant[] storage invs = _invariants[id];
        for (uint256 i = 0; i < invs.length; i++) {
            if (invs[i].kind == Kind.ForbiddenTool) {
                _break(id, uint8(i), breaker);
                broke = true;
                break;
            }
        }
    }

    // ------------------------------------------------------------------ anyone

    /// @inheritdoc IDefectArena
    function closeHeld(uint256 id) external nonReentrant {
        Contest storage c = _contests[id];
        if (c.status != Status.Active) revert NotActive();
        if (block.timestamp <= uint256(c.endTime) + REVEAL_GRACE) revert TooEarly();
        c.status = Status.Held;
        uint256 poolReturned = c.pool;
        _payOrCredit(c.warden, _drain(c));
        emit Held(id, c.messageCount, poolReturned);
    }

    /// @inheritdoc IDefectArena
    function withdraw() external nonReentrant {
        uint256 amount = withdrawable[msg.sender];
        if (amount == 0) revert BadParams();
        withdrawable[msg.sender] = 0;
        if (!_tryTransfer(msg.sender, amount)) revert TransferFailed();
        emit Withdrawn(msg.sender, amount);
    }

    // ------------------------------------------------------------------ views

    function getContest(uint256 id) external view returns (Contest memory) {
        return _contests[id];
    }

    function getInvariants(uint256 id) external view returns (Invariant[] memory) {
        return _invariants[id];
    }

    function contestCount() external view returns (uint256) {
        return nextContestId - 1;
    }

    /// 0 None, 1 Scheduled, 2 Open, 3 AwaitingClose, 4 Broken, 5 Held, 6 Void, 7 Cancelled
    function phase(uint256 id) external view returns (uint8) {
        Contest storage c = _contests[id];
        Status s = c.status;
        if (s == Status.None) return 0;
        if (s == Status.Active) {
            if (block.timestamp < c.startTime) return 1;
            if (block.timestamp < c.endTime) return 2;
            return 3;
        }
        if (s == Status.Broken) return 4;
        if (s == Status.Held) return 5;
        if (s == Status.Void) return 6;
        return 7;
    }

    // ------------------------------------------------------------------ internal

    function _validateInvariants(Invariant[] calldata invs) internal pure {
        bool hasForbidden;
        for (uint256 i = 0; i < invs.length; i++) {
            Invariant calldata inv = invs[i];
            if (inv.kind == Kind.Secret) {
                if (inv.secretHash == bytes32(0) || inv.maxAmount != 0) revert BadParams();
            } else if (inv.kind == Kind.TransferLimit) {
                if (inv.maxAmount == 0 || inv.secretHash != bytes32(0)) revert BadParams();
            } else if (inv.kind == Kind.ForbiddenTool) {
                if (inv.maxAmount != 0 || inv.secretHash != bytes32(0) || hasForbidden) revert BadParams();
                hasForbidden = true;
            } else {
                revert BadParams();
            }
        }
    }

    function _emitCreated(uint256 id) internal {
        Contest storage c = _contests[id];
        emit ContestCreated(
            id, c.warden, c.startTime, c.endTime, c.pool, c.vault, c.bond, c.messagePrice, c.packageHash, c.canaryHash
        );
    }

    function _checkVaultCall(uint256 id, address to, address breaker) internal view returns (Contest storage c) {
        c = _contests[id];
        if (c.status != Status.Active) revert NotActive();
        if (block.timestamp < c.startTime || block.timestamp >= c.endTime) revert NotOpen();
        if (to == address(0) || breaker == address(0)) revert ZeroAddress();
    }

    function _checkRefundArgs(uint256 id, address[] calldata breakers, uint256[] calldata amounts) internal view {
        if (_contests[id].status != Status.Active) revert NotActive();
        if (breakers.length != amounts.length || breakers.length > MAX_REFUNDS_PER_CALL) revert BadParams();
        for (uint256 i = 0; i < breakers.length; i++) {
            if (breakers[i] == address(0)) revert ZeroAddress();
        }
    }

    function _break(uint256 id, uint8 idx, address breaker) internal {
        Contest storage c = _contests[id];
        c.status = Status.Broken;
        c.winner = breaker;
        c.brokenInvariant = idx;
        uint256 payout = c.pool;
        c.pool = 0;
        uint256 back = c.escrow + c.bond + c.vault;
        c.escrow = 0;
        c.bond = 0;
        c.vault = 0;
        _payOrCredit(breaker, payout);
        _payOrCredit(c.warden, back);
        emit Broken(id, idx, breaker, payout);
    }

    function _refundOne(uint256 id, address breaker, uint256 amount) internal {
        Contest storage c = _contests[id];
        uint256 fromEscrow = amount <= c.escrow ? amount : c.escrow;
        c.escrow -= fromEscrow;
        uint256 rest = amount - fromEscrow;
        uint256 fromBond = rest <= c.bond ? rest : c.bond;
        c.bond -= fromBond;
        uint256 paid = fromEscrow + fromBond;
        if (paid > 0) _payOrCredit(breaker, paid);
        emit Refunded(id, breaker, amount, paid);
    }

    /// Zeroes pool, escrow, bond and vault, returning their sum.
    function _drain(Contest storage c) internal returns (uint256 total) {
        total = c.pool + c.escrow + c.bond + c.vault;
        c.pool = 0;
        c.escrow = 0;
        c.bond = 0;
        c.vault = 0;
    }

    function _pull(address from, uint256 amount) internal {
        (bool ok, bytes memory data) =
            usdc.call(abi.encodeWithSelector(IERC20Like.transferFrom.selector, from, address(this), amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _tryTransfer(address to, uint256 amount) internal returns (bool) {
        (bool ok, bytes memory data) = usdc.call(abi.encodeWithSelector(IERC20Like.transfer.selector, to, amount));
        return ok && (data.length == 0 || abi.decode(data, (bool)));
    }

    /// Payments never block state changes: a failed transfer becomes a withdrawable credit.
    function _payOrCredit(address to, uint256 amount) internal {
        if (amount == 0) return;
        if (!_tryTransfer(to, amount)) {
            withdrawable[to] += amount;
            emit Credited(to, amount);
        }
    }
}
