// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title IDefectArena: the frozen external interface of DefectArena (build plan §8).
/// @notice P2 implements this exactly: `contract DefectArena is IDefectArena`. Apps use the ABI generated
///         from this file (packages/shared/src/abi.ts), so any change here is a breaking change for the gateway,
///         runner, web app and CRE auditor. Behavior of every function is specified in build plan §8.5.
interface IDefectArena {
    // ---------------------------------------------------------------- types

    enum Status {
        None,
        Active,
        Broken,
        Held,
        Void,
        Cancelled
    }

    enum Kind {
        None,
        Secret,
        TransferLimit,
        ForbiddenTool
    }

    struct Invariant {
        Kind kind;
        bytes32 secretHash; // Secret only, else 0
        uint256 maxAmount; // TransferLimit only (USDC base units), else 0
    }

    struct Contest {
        address warden;
        Status status;
        uint64 startTime;
        uint64 endTime; // startTime + windowSeconds
        uint32 messageCount; // number of fee deposits
        uint8 brokenInvariant; // valid only when status == Broken
        address winner; // valid only when status == Broken
        uint256 messagePrice;
        uint256 initialPool;
        uint256 pool;
        uint256 vault;
        uint256 bond;
        uint256 escrow;
        bytes32 packageHash;
        bytes32 canaryHash;
        bytes32 logHash;
    }

    // ---------------------------------------------------------------- events

    event ContestCreated(
        uint256 indexed id,
        address indexed warden,
        uint64 startTime,
        uint64 endTime,
        uint256 pool,
        uint256 vault,
        uint256 bond,
        uint256 messagePrice,
        bytes32 packageHash,
        bytes32 canaryHash
    );
    event FeeDeposited(
        uint256 indexed id,
        address indexed breaker,
        uint256 amount,
        uint256 poolShare,
        uint256 arenaShare,
        uint256 escrowShare,
        bytes32 paymentRef
    );
    event BreakCommitted(uint256 indexed id, address indexed breaker, bytes32 commitment);
    event VaultSend(
        uint256 indexed id, bytes32 indexed attemptId, address indexed breaker, address to, uint256 amount, bool transferred
    );
    event VaultEmergencyWithdraw(
        uint256 indexed id, bytes32 indexed attemptId, address indexed breaker, address to, uint256 amount, bool transferred
    );
    event Broken(uint256 indexed id, uint8 invariantIndex, address indexed breaker, uint256 payout);
    event Held(uint256 indexed id, uint32 messageCount, uint256 poolReturned);
    event Refunded(uint256 indexed id, address indexed breaker, uint256 requested, uint256 paid);
    event Voided(uint256 indexed id);
    event Cancelled(uint256 indexed id);
    event LogHashPosted(uint256 indexed id, bytes32 logHash);
    event Credited(address indexed account, uint256 amount);
    event Withdrawn(address indexed account, uint256 amount);

    // ---------------------------------------------------------------- errors

    error NotOperator();
    error NotRunner();
    error BadParams();
    error NotActive();
    error NotOpen();
    error TooEarly();
    error TooLate();
    error NoCommit();
    error CommitTooFresh();
    error CommitExpired();
    error BadReveal();
    error WrongKind();
    error InsufficientVault();
    error TransferFailed();
    error Reentrancy();
    error AlreadyPosted();
    error HasMessages();
    error ZeroAddress();
    error NotAssociated();

    // ---------------------------------------------------------------- constants and configuration

    function BPS() external view returns (uint256); // 10_000
    function POOL_BPS() external view returns (uint256); // 7_000
    function ARENA_BPS() external view returns (uint256); // 2_000 (escrow gets the remaining 1_000)
    function MIN_BOND_PERCENT() external view returns (uint256); // 20
    function MIN_MESSAGE_PRICE() external view returns (uint256); // 10_000 (0.01 USDC)
    function REVEAL_GRACE() external view returns (uint64); // 600
    function COMMIT_TTL() external view returns (uint64); // 1_800
    function MAX_INVARIANTS() external view returns (uint256); // 5
    function MAX_REFUNDS_PER_CALL() external view returns (uint256); // 10

    function usdc() external view returns (address);
    function operator() external view returns (address);
    function runner() external view returns (address);
    function treasury() external view returns (address);
    function windowSeconds() external view returns (uint64);
    function nextContestId() external view returns (uint256);
    function usdcAssociated() external view returns (bool);

    // ---------------------------------------------------------------- setup

    /// Associates this contract with the USDC HTS token. Anyone may call; accepts response 22 or 194.
    function associateUsdc() external;

    // ---------------------------------------------------------------- Warden

    /// Pulls pool + vaultAmount + bond from msg.sender (approve first). Returns the new contest id.
    function createContest(
        bytes32 packageHash,
        bytes32 canaryHash,
        Invariant[] calldata invs,
        uint64 startTime,
        uint256 messagePrice,
        uint256 pool,
        uint256 vaultAmount,
        uint256 bond
    ) external returns (uint256 id);

    // ---------------------------------------------------------------- Breaker

    function commitBreak(uint256 id, bytes32 commitment) external;

    function revealBreak(uint256 id, uint8 invariantIndex, string calldata secret, bytes32 salt) external;

    // ---------------------------------------------------------------- anyone

    /// After endTime + REVEAL_GRACE with no break: returns everything to the Warden.
    function closeHeld(uint256 id) external;

    /// Claims USDC credited when a direct payout failed.
    function withdraw() external;

    // ---------------------------------------------------------------- operator (gateway)

    function depositFee(uint256 id, address breaker, uint256 amount, bytes32 paymentRef) external;

    function refund(uint256 id, address[] calldata breakers, uint256[] calldata amounts) external;

    function voidContest(uint256 id, address[] calldata breakers, uint256[] calldata amounts) external;

    function cancel(uint256 id) external;

    function postLogHash(uint256 id, bytes32 logHash) external;

    // ---------------------------------------------------------------- runner (the agent's vault)

    function vaultSend(uint256 id, address to, uint256 amount, address breaker, bytes32 attemptId)
        external
        returns (bool transferred, bool broke);

    function vaultEmergencyWithdraw(uint256 id, address to, address breaker, bytes32 attemptId)
        external
        returns (uint256 amount, bool broke);

    // ---------------------------------------------------------------- views

    function getContest(uint256 id) external view returns (Contest memory);

    function getInvariants(uint256 id) external view returns (Invariant[] memory);

    function contestCount() external view returns (uint256);

    /// 0 None, 1 Scheduled, 2 Open, 3 AwaitingClose, 4 Broken, 5 Held, 6 Void, 7 Cancelled
    function phase(uint256 id) external view returns (uint8);

    function commits(uint256 id, address breaker) external view returns (bytes32 commitment, uint64 blockNumber, uint64 time);

    function withdrawable(address account) external view returns (uint256);
}
