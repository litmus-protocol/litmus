// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title IDefectAttestations: the frozen external interface of DefectAttestations on Ethereum Sepolia (build plan §13.2).
/// @notice The Chainlink CRE auditor writes one attestation per finished contest. The contract also inherits
///         Chainlink's ReceiverTemplate (onReport), which is not part of this interface.
interface IDefectAttestations {
    /// `status` is the DefectArena.Status enum value (Broken 2, Held 3, Void 4, Cancelled 5), not the phase() code.
    struct Attestation {
        uint8 status;
        bytes32 logHash;
        bool logHashMatches;
        bool canaryHashMatches;
        bool secretsMatch;
        uint32 messageCount;
        uint32 attemptsInLog;
        address winner;
        uint256 attestedAt; // 0 means not attested yet
    }

    event Attested(
        uint256 indexed contestId, uint8 status, bytes32 logHash, bool logHashMatches, bool canaryHashMatches, bool secretsMatch
    );
    event AlreadyAttested(uint256 indexed contestId);

    function attestations(uint256 contestId)
        external
        view
        returns (
            uint8 status,
            bytes32 logHash,
            bool logHashMatches,
            bool canaryHashMatches,
            bool secretsMatch,
            uint32 messageCount,
            uint32 attemptsInLog,
            address winner,
            uint256 attestedAt
        );
}
