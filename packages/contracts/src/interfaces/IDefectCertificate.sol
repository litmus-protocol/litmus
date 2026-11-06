// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title IDefectCertificate: soulbound "Held" certificates for agents nobody broke (build plan §8.9).
/// @notice One ERC-721 token per Held contest of one DefectArena deployment, minted to that contest's Warden.
///         tokenId == contestId. Every field except `uniqueBreakers` and `agentName` is read from DefectArena at
///         mint time, so nobody can mint a certificate for a contest that did not end Held or inflate its numbers.
///         `uniqueBreakers` and `agentName` are reported once by the arena operator (they are not stored on chain
///         by DefectArena) and are labelled as reported. Tokens cannot be transferred or approved (ERC-5192 locked).
interface IDefectCertificate {
    struct Certificate {
        address warden;
        uint64 startTime;
        uint64 endTime;
        uint64 mintedAt; // 0 = not minted
        uint32 messageCount; // paid messages the agent survived
        uint32 uniqueBreakers; // reported by the operator; valid only when reported == true
        bool reported;
        uint8 ruleKinds; // bit (1 << IDefectArena.Kind): 2 = Secret, 4 = TransferLimit, 8 = ForbiddenTool
        uint256 poolAtStake; // USDC base units: initial pool + the pool share of every message fee
        bytes32 packageHash; // fingerprint of the exact agent version that held
        string agentName; // reported by the operator; empty until reported
    }

    event CertificateMinted(
        uint256 indexed contestId, address indexed warden, uint32 messageCount, uint64 secondsTested, uint256 poolAtStake
    );
    event ReportSet(uint256 indexed contestId, uint32 uniqueBreakers, string agentName);
    /// ERC-5192: emitted once per token at mint; tokens are locked forever.
    event Locked(uint256 tokenId);

    error NotHeld();
    error AlreadyMinted();
    error NotMinted();
    error AlreadyReported();
    error NotOperator();
    error BadReport();
    error Soulbound();
    error ZeroAddress();

    function arena() external view returns (address);
    function operator() external view returns (address);
    function totalMinted() external view returns (uint256);

    /// Operator only, once the contest is Held. The gateway calls it after the contest's Chainlink CRE attestation on
    /// Sepolia passed every check. Mints tokenId == contestId to the contest's Warden.
    function mint(uint256 contestId) external returns (uint256 tokenId);

    /// Operator only, once per certificate. uniqueBreakers <= messageCount; agentName 1–40 chars of [A-Za-z0-9 ._-].
    function setReport(uint256 contestId, uint32 uniqueBreakers, string calldata agentName) external;

    function getCertificate(uint256 contestId) external view returns (Certificate memory);

    /// ERC-5192: always true for an existing token.
    function locked(uint256 tokenId) external view returns (bool);

    /// data:application/json;base64 metadata with an on-chain SVG image (= base64 of tokenJson).
    function tokenURI(uint256 tokenId) external view returns (string memory);

    /// The same metadata as plain JSON, for apps that don't want to decode the data URI.
    function tokenJson(uint256 tokenId) external view returns (string memory);

    function ownerOf(uint256 tokenId) external view returns (address);
}
