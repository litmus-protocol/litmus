// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReceiverTemplate} from "./cre/ReceiverTemplate.sol";
import {IDefectAttestations} from "./interfaces/IDefectAttestations.sol";

/// @title DefectAttestations: independent audit results for finished Defect contests (build plan §13.2).
/// @notice Deployed on Ethereum Sepolia. The Chainlink CRE auditor workflow checks a finished contest's published
///         log, canaries and secrets against DefectArena on Hedera and delivers one report per contest through the
///         Chainlink forwarder. Only the forwarder can call onReport (enforced by ReceiverTemplate).
contract DefectAttestations is ReceiverTemplate, IDefectAttestations {
    /// The report payload, ABI-encoded by the workflow as a flat tuple (all fields static, so it decodes as a struct).
    struct Report {
        uint256 contestId;
        uint8 status;
        bytes32 logHash;
        bool logHashMatches;
        bool canaryHashMatches;
        bool secretsMatch;
        uint32 messageCount;
        uint32 attemptsInLog;
        address winner;
    }

    mapping(uint256 => Attestation) internal _attestations;

    constructor(address forwarder) ReceiverTemplate(forwarder) {}

    /// @inheritdoc IDefectAttestations
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
        )
    {
        Attestation storage a = _attestations[contestId];
        return (
            a.status,
            a.logHash,
            a.logHashMatches,
            a.canaryHashMatches,
            a.secretsMatch,
            a.messageCount,
            a.attemptsInLog,
            a.winner,
            a.attestedAt
        );
    }

    /// The first report for a contest is final. A second one is ignored (event, no revert), so a re-run of the
    /// workflow never fails its write.
    function _processReport(bytes calldata report) internal override {
        Report memory r = abi.decode(report, (Report));
        Attestation storage a = _attestations[r.contestId];
        if (a.attestedAt != 0) {
            emit AlreadyAttested(r.contestId);
            return;
        }
        a.status = r.status;
        a.logHash = r.logHash;
        a.logHashMatches = r.logHashMatches;
        a.canaryHashMatches = r.canaryHashMatches;
        a.secretsMatch = r.secretsMatch;
        a.messageCount = r.messageCount;
        a.attemptsInLog = r.attemptsInLog;
        a.winner = r.winner;
        a.attestedAt = block.timestamp;
        emit Attested(r.contestId, r.status, r.logHash, r.logHashMatches, r.canaryHashMatches, r.secretsMatch);
    }
}
