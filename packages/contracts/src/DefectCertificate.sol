// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {IDefectArena} from "./interfaces/IDefectArena.sol";
import {IDefectCertificate} from "./interfaces/IDefectCertificate.sol";

/// @title DefectCertificate: soulbound "Held" certificate NFTs (build plan §8.9).
/// @notice A separate contract so DefectArena and its contests stay untouched. It reads everything it can verify
///         straight from the arena; the operator only adds the two fields the arena does not store. Only the operator
///         mints, and only once the contest's Chainlink CRE audit has passed.
contract DefectCertificate is ERC721, IDefectCertificate {
    using Strings for uint256;

    uint256 public constant MAX_NAME_BYTES = 40;
    bytes4 private constant ERC5192_INTERFACE_ID = 0xb45a3c0e;

    IDefectArena internal immutable _arena;
    address public immutable operator;
    uint256 public totalMinted;

    mapping(uint256 => Certificate) internal _certs;

    constructor(address arena_) ERC721("Defect Held Certificate", "DEFECT-HELD") {
        if (arena_ == address(0)) revert ZeroAddress();
        _arena = IDefectArena(arena_);
        operator = IDefectArena(arena_).operator();
    }

    function arena() external view returns (address) {
        return address(_arena);
    }

    // ---------------------------------------------------------------- mint and report

    /// @inheritdoc IDefectCertificate
    function mint(uint256 contestId) external returns (uint256 tokenId) {
        // Operator only: the gateway mints after the Chainlink CRE audit of this contest passed on Sepolia, which this
        // contract cannot read from Hedera. Without the check a Warden could mint before (or despite) the audit.
        if (msg.sender != operator) revert NotOperator();
        IDefectArena.Contest memory c = _arena.getContest(contestId);
        if (c.status != IDefectArena.Status.Held) revert NotHeld();
        Certificate storage cert = _certs[contestId];
        if (cert.mintedAt != 0) revert AlreadyMinted();

        IDefectArena.Invariant[] memory invs = _arena.getInvariants(contestId);
        uint8 kinds = 0;
        for (uint256 i = 0; i < invs.length; i++) {
            kinds |= uint8(1 << uint8(invs[i].kind));
        }
        // Every fee is exactly messagePrice and the arena adds the same pool share for each (§8.5 depositFee).
        // A fee deposited after the Held close still counts in messageCount but went to the Warden, not the pool;
        // the gateway deposits within seconds of a message, so in practice this does not happen.
        uint256 poolShare = (c.messagePrice * _arena.POOL_BPS()) / _arena.BPS();

        cert.warden = c.warden;
        cert.startTime = c.startTime;
        cert.endTime = c.endTime;
        cert.mintedAt = uint64(block.timestamp);
        cert.messageCount = c.messageCount;
        cert.ruleKinds = kinds;
        // Rounding per fee (not over the total) on purpose: that is exactly what the arena added to the pool.
        // forge-lint: disable-next-line(divide-before-multiply)
        cert.poolAtStake = c.initialPool + uint256(c.messageCount) * poolShare;
        cert.packageHash = c.packageHash;
        totalMinted++;

        tokenId = contestId;
        // Plain _mint on purpose: a Warden that is a contract without onERC721Received must still get its
        // certificate, and a soulbound token is never moved again, so the receiver check buys nothing.
        // forge-lint: disable-next-line(unsafe-oz-erc721-mint)
        _mint(c.warden, tokenId);
        emit Locked(tokenId);
        emit CertificateMinted(contestId, c.warden, c.messageCount, c.endTime - c.startTime, cert.poolAtStake);
    }

    /// @inheritdoc IDefectCertificate
    function setReport(uint256 contestId, uint32 uniqueBreakers, string calldata agentName) external {
        if (msg.sender != operator) revert NotOperator();
        Certificate storage cert = _certs[contestId];
        if (cert.mintedAt == 0) revert NotMinted();
        if (cert.reported) revert AlreadyReported();
        if (uniqueBreakers > cert.messageCount || !_validName(bytes(agentName))) revert BadReport();
        cert.uniqueBreakers = uniqueBreakers;
        cert.agentName = agentName;
        cert.reported = true;
        emit ReportSet(contestId, uniqueBreakers, agentName);
    }

    // ---------------------------------------------------------------- views

    function getCertificate(uint256 contestId) external view returns (Certificate memory) {
        return _certs[contestId];
    }

    function locked(uint256 tokenId) external view returns (bool) {
        _requireOwned(tokenId);
        return true;
    }

    function ownerOf(uint256 tokenId) public view override(ERC721, IDefectCertificate) returns (address) {
        return super.ownerOf(tokenId);
    }

    function supportsInterface(bytes4 interfaceId) public view override returns (bool) {
        return interfaceId == ERC5192_INTERFACE_ID || super.supportsInterface(interfaceId);
    }

    function tokenURI(uint256 tokenId) public view override(ERC721, IDefectCertificate) returns (string memory) {
        return string.concat("data:application/json;base64,", Base64.encode(bytes(tokenJson(tokenId))));
    }

    /// @inheritdoc IDefectCertificate
    function tokenJson(uint256 tokenId) public view returns (string memory) {
        _requireOwned(tokenId);
        Certificate storage cert = _certs[tokenId];
        bytes32 logHash = _arena.getContest(tokenId).logHash;
        string memory title = cert.reported ? cert.agentName : string.concat("Contest #", tokenId.toString());
        return string.concat(
            '{"name":"Defect Held Certificate: ',
            title,
            '","description":"This agent ran a Defect contest on Hedera and nobody broke its rules. Every number except',
            ' Unique Breakers and the agent name is read from the DefectArena contract.","image":"data:image/svg+xml;base64,',
            Base64.encode(bytes(_svg(tokenId, cert, title))),
            '","attributes":',
            _attributes(tokenId, cert, logHash),
            "}"
        );
    }

    // ---------------------------------------------------------------- soulbound

    /// Only mints pass: a certificate can never move to another wallet.
    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        if (_ownerOf(tokenId) != address(0)) revert Soulbound();
        return super._update(to, tokenId, auth);
    }

    function approve(address, uint256) public pure override {
        revert Soulbound();
    }

    function setApprovalForAll(address, bool) public pure override {
        revert Soulbound();
    }

    // ---------------------------------------------------------------- metadata helpers

    function _attributes(uint256 contestId, Certificate storage cert, bytes32 logHash)
        internal
        view
        returns (string memory)
    {
        // Split into parts: one long string.concat runs out of stack without via-IR.
        uint64 secs = cert.endTime - cert.startTime;
        string memory part1 = string.concat(
            '[{"trait_type":"Contest","value":',
            contestId.toString(),
            '},{"trait_type":"Time tested","value":"',
            _duration(secs),
            '"},{"trait_type":"Seconds tested","display_type":"number","value":',
            uint256(secs).toString()
        );
        string memory part2 = string.concat(
            '},{"trait_type":"Messages survived","display_type":"number","value":',
            uint256(cert.messageCount).toString(),
            '},{"trait_type":"Unique Breakers (reported)","value":',
            cert.reported ? uint256(cert.uniqueBreakers).toString() : '"not reported"',
            '},{"trait_type":"Pool at stake (USDC)","value":"',
            _usdc(cert.poolAtStake)
        );
        string memory part3 = string.concat(
            '"},{"trait_type":"Rules held","value":"',
            _rules(cert.ruleKinds),
            '"},{"trait_type":"Agent fingerprint","value":"',
            Strings.toHexString(uint256(cert.packageHash), 32),
            '"},{"trait_type":"Log hash","value":"',
            logHash == bytes32(0) ? "not posted yet" : Strings.toHexString(uint256(logHash), 32),
            '"}]'
        );
        return string.concat(part1, part2, part3);
    }

    function _svg(uint256 contestId, Certificate storage cert, string memory title)
        internal
        view
        returns (string memory)
    {
        string memory head = string.concat(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 380" font-family="ui-monospace,Menlo,monospace">',
            '<rect width="600" height="380" rx="20" fill="#0d1013"/><rect x="10" y="10" width="580" height="360" rx="14" fill="none" stroke="#d7f75b" stroke-opacity=".5"/>',
            '<text x="36" y="58" fill="#d7f75b" font-size="14" letter-spacing="3">DEFECT / HELD CERTIFICATE</text>',
            '<text x="36" y="104" fill="#f2f4f3" font-size="30" font-weight="700">',
            title,
            "</text>"
        );
        string memory stats = string.concat(
            _svgStat("36", "MESSAGES SURVIVED", uint256(cert.messageCount).toString()),
            _svgStat("220", "TIME TESTED", _duration(cert.endTime - cert.startTime)),
            _svgStat("404", "POOL AT STAKE", string.concat(_usdc(cert.poolAtStake), " USDC"))
        );
        return string.concat(head, stats, _svgRules(cert), _svgFoot(contestId, cert.packageHash));
    }

    function _svgStat(string memory x, string memory label, string memory value) internal pure returns (string memory) {
        string memory l = string.concat('<text x="', x, '" y="168" fill="#8b949e" font-size="11" letter-spacing="2">', label, "</text>");
        return string.concat(l, '<text x="', x, '" y="198" fill="#f2f4f3" font-size="22" font-weight="600">', value, "</text>");
    }

    function _svgRules(Certificate storage cert) internal view returns (string memory) {
        return string.concat(
            '<text x="36" y="252" fill="#8b949e" font-size="13">Rules held: <tspan fill="#f2f4f3">',
            _rules(cert.ruleKinds),
            '</tspan></text><text x="36" y="280" fill="#8b949e" font-size="13">Unique Breakers (reported): <tspan fill="#f2f4f3">',
            cert.reported ? uint256(cert.uniqueBreakers).toString() : "-",
            "</tspan></text>"
        );
    }

    function _svgFoot(uint256 contestId, bytes32 packageHash) internal view returns (string memory) {
        // Two lines: a contest/agent line and the arena address. They no longer share a row, so they can't overlap.
        string memory line1 = string.concat(
            '<text x="36" y="318" fill="#8b949e" font-size="11">Contest #',
            contestId.toString(),
            " / agent ",
            _short(packageHash),
            " / soulbound</text>"
        );
        return string.concat(
            line1,
            '<text x="36" y="340" fill="#d7f75b" font-size="11">arena ',
            Strings.toHexString(address(_arena)),
            "</text></svg>"
        );
    }

    /// "8 hours", "1 hour", "15 minutes" or "90 seconds".
    function _duration(uint64 secs) internal pure returns (string memory) {
        if (secs >= 3600 && secs % 3600 == 0) {
            return secs == 3600 ? "1 hour" : string.concat(uint256(secs / 3600).toString(), " hours");
        }
        if (secs >= 60 && secs % 60 == 0) {
            return secs == 60 ? "1 minute" : string.concat(uint256(secs / 60).toString(), " minutes");
        }
        return string.concat(uint256(secs).toString(), " seconds");
    }

    /// USDC base units (6 decimals) as a decimal string without trailing zeros: 1105000 -> "1.105".
    function _usdc(uint256 units) internal pure returns (string memory) {
        uint256 whole = units / 1e6;
        uint256 frac = units % 1e6;
        if (frac == 0) return whole.toString();
        bytes memory digits = bytes(frac.toString());
        bytes memory padded = new bytes(6);
        uint256 pad = 6 - digits.length;
        for (uint256 i = 0; i < 6; i++) {
            padded[i] = i < pad ? bytes1("0") : digits[i - pad];
        }
        uint256 len = 6;
        while (padded[len - 1] == "0") len--;
        bytes memory trimmed = new bytes(len);
        for (uint256 i = 0; i < len; i++) {
            trimmed[i] = padded[i];
        }
        return string.concat(whole.toString(), ".", string(trimmed));
    }

    function _rules(uint8 kinds) internal pure returns (string memory out) {
        if (kinds & (1 << uint8(IDefectArena.Kind.TransferLimit)) != 0) out = "Transfer limit";
        if (kinds & (1 << uint8(IDefectArena.Kind.Secret)) != 0) out = _join(out, "Secret");
        if (kinds & (1 << uint8(IDefectArena.Kind.ForbiddenTool)) != 0) out = _join(out, "Forbidden tool");
    }

    function _join(string memory a, string memory b) internal pure returns (string memory) {
        return bytes(a).length == 0 ? b : string.concat(a, ", ", b);
    }

    /// "0x1234abcd...ef01"
    function _short(bytes32 h) internal pure returns (string memory) {
        bytes memory full = bytes(Strings.toHexString(uint256(h), 32));
        bytes memory out = new bytes(17);
        for (uint256 i = 0; i < 10; i++) {
            out[i] = full[i];
        }
        out[10] = ".";
        out[11] = ".";
        out[12] = ".";
        for (uint256 i = 0; i < 4; i++) {
            out[13 + i] = full[62 + i];
        }
        return string(out);
    }

    /// 1–40 bytes of [A-Za-z0-9 ._-], so the name is always safe inside JSON and SVG.
    function _validName(bytes memory b) internal pure returns (bool) {
        if (b.length == 0 || b.length > MAX_NAME_BYTES) return false;
        for (uint256 i = 0; i < b.length; i++) {
            bytes1 ch = b[i];
            bool ok = (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || (ch >= "0" && ch <= "9") || ch == " "
                || ch == "." || ch == "_" || ch == "-";
            if (!ok) return false;
        }
        return true;
    }
}
