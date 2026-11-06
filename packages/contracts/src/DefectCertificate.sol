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

    constructor(address arena_) ERC721("Litmus Held Certificate", "LITMUS-HELD") {
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
            '{"name":"Litmus Held Certificate: ',
            title,
            '","description":"This agent ran a Litmus contest on Hedera and nobody broke its rules. Every number except',
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

    // ---------------------------------------------------------------- the card (Litmus medallion)

    /// The certificate image: the Litmus medallion on black. LITMUS CERTIFIED over an eight-petal mandala, the facts
    /// running round its rim as a sentence, the agent name, and a prompt slip. Everything is plain SVG shapes
    /// (no fonts, scripts or images to load), 340 x 425, drawn from data this contract or the arena holds.
    function _svg(uint256 contestId, Certificate storage cert, string memory title)
        internal
        view
        returns (string memory)
    {
        return string.concat(_svgFrame(), _svgMedallion(), _svgRim(cert, title), _svgCaption(contestId, cert, title));
    }

    function _svgFrame() internal pure returns (string memory) {
        return string.concat(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 340 425" font-family="ui-monospace,Menlo,monospace" fill="#fff">',
            '<rect width="340" height="425" fill="#0b0b0c"/>',
            '<rect x="12" y="12" width="316" height="401" fill="none" stroke="#fff" stroke-opacity=".2"/>',
            '<text x="170" y="31" font-size="10.5" letter-spacing="2.6" text-anchor="middle" fill-opacity=".9">LITMUS CERTIFIED</text>'
        );
    }

    /// Two rings, then the mandala: eight petals fading outwards, eight dots between them, sixteen dots on a ring.
    /// The dotted rings are one circle each with a round-capped dash pattern, which keeps the card small.
    function _svgMedallion() internal pure returns (string memory) {
        string memory defs = string.concat(
            '<defs><radialGradient id="g" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="36">',
            '<stop offset=".1" stop-color="#fff"/><stop offset="1" stop-color="#fff" stop-opacity=".2"/></radialGradient>',
            '<path id="r" d="M170,162 m-105,0 a105,105 0 1,1 210,0 a105,105 0 1,1 -210,0"/>',
            '<ellipse id="p" cx="22" cy="0" rx="13" ry="5.2" fill="url(#g)" stroke="#fff" stroke-width="1.1"/></defs>',
            '<circle cx="170" cy="162" r="116" fill="none" stroke="#fff" stroke-opacity=".5"/>',
            '<circle cx="170" cy="162" r="92" fill="none" stroke="#fff" stroke-opacity=".28"/>'
        );
        string memory rings = string.concat(
            '<g transform="translate(170 162)" fill="none" stroke="#fff"><circle r="62" stroke-opacity=".5" stroke-dasharray="1 3.5"/>',
            '<circle r="56" stroke-width="1.4"/><circle r="42" stroke-width="1.4"/><circle r="7.4" stroke-width="1.4"/>',
            '<circle r="48.6" stroke-width="3.8" stroke-linecap="round" stroke-dasharray="0 19.0875"/>',
            '<circle r="28" stroke-width="4.2" stroke-linecap="round" stroke-dasharray="0 21.99" transform="rotate(22.5)"/>'
        );
        string memory petals = string.concat(
            '<use href="#p"/><use href="#p" transform="rotate(45)"/><use href="#p" transform="rotate(90)"/>',
            '<use href="#p" transform="rotate(135)"/><use href="#p" transform="rotate(180)"/>',
            '<use href="#p" transform="rotate(225)"/><use href="#p" transform="rotate(270)"/>',
            '<use href="#p" transform="rotate(315)"/><circle r="3.6" fill="#fff" stroke="none"/></g>'
        );
        return string.concat(defs, rings, petals);
    }

    /// The rim sentence, set on a circle: agent, attacks refused, time tested, pool, and who stands behind it.
    function _svgRim(Certificate storage cert, string memory title) internal view returns (string memory) {
        string memory sentence = string.concat(
            _upper(_clip(title, 14)),
            " &#183; ",
            _plural(cert.messageCount, "ATTACK"),
            " REFUSED &#183; ",
            _upper(_duration(cert.endTime - cert.startTime)),
            " &#183; POOL ",
            _usdc(cert.poolAtStake),
            " USDC &#183; RUN ON 0G &#183; AUDITED BY CHAINLINK &#183; SEALED ON HEDERA &#183; "
        );
        return string.concat(
            '<text font-size="9"><textPath href="#r" textLength="655" lengthAdjust="spacing">AGENT ', sentence, "</textPath></text>"
        );
    }

    /// The agent name, the one-line verdict, and the prompt slip (counts, the verdict word, the contest number).
    function _svgCaption(uint256 contestId, Certificate storage cert, string memory title)
        internal
        view
        returns (string memory)
    {
        string memory head = string.concat(
            '<text x="170" y="311" font-family="Satoshi,Helvetica Neue,Arial,sans-serif" font-size="25" font-weight="900" letter-spacing="-.3" text-anchor="middle">',
            _clip(title, 20),
            '</text><text x="170" y="331" font-size="10" letter-spacing="2.5" text-anchor="middle" fill-opacity=".8">HELD &#183; SURVIVED ',
            _upper(_plural(cert.messageCount, "attack")),
            "</text>"
        );
        string memory slip = string.concat(
            '<rect x="24" y="350" width="292" height="50" fill-opacity=".04" stroke="#fff" stroke-opacity=".28"/>',
            '<text x="35" y="370" font-size="9.5" letter-spacing=".7">&gt; ',
            _upper(_plural(cert.messageCount, "attack")),
            " &#183; ",
            _upper(_duration(cert.endTime - cert.startTime)),
            " &#183; ",
            _upper(_plural(_ruleCount(cert.ruleKinds), "rule")),
            " HELD</text>"
        );
        return string.concat(
            head,
            slip,
            '<text x="35" y="388" font-size="9.5" letter-spacing=".7" fill-opacity=".9">&lt; REFUSED</text>',
            '<rect x="98" y="379.5" width="5.5" height="10"/>',
            '<text x="305" y="388" font-size="9" letter-spacing="1.8" text-anchor="end" fill-opacity=".55">N&#186; ',
            _pad3(contestId),
            "</text></svg>"
        );
    }

    function _plural(uint256 n, string memory word) internal pure returns (string memory) {
        return string.concat(n.toString(), " ", word, n == 1 ? "" : "S");
    }

    function _ruleCount(uint8 kinds) internal pure returns (uint256 n) {
        for (; kinds != 0; kinds &= kinds - 1) n++;
    }

    /// "9" -> "009"; larger ids are left as they are.
    function _pad3(uint256 n) internal pure returns (string memory) {
        string memory d = n.toString();
        uint256 len = bytes(d).length;
        return len >= 3 ? d : string.concat(len == 1 ? "00" : "0", d);
    }

    /// ASCII upper-case (names are validated to [A-Za-z0-9 ._-]).
    function _upper(string memory s) internal pure returns (string memory) {
        bytes memory b = bytes(s);
        bytes memory out = new bytes(b.length);
        for (uint256 i = 0; i < b.length; i++) {
            bytes1 ch = b[i];
            out[i] = (ch >= "a" && ch <= "z") ? bytes1(uint8(ch) - 32) : ch;
        }
        return string(out);
    }

    /// The first n bytes (ASCII only, so a cut never splits a character).
    function _clip(string memory s, uint256 n) internal pure returns (string memory) {
        bytes memory b = bytes(s);
        if (b.length <= n) return s;
        bytes memory out = new bytes(n);
        for (uint256 i = 0; i < n; i++) {
            out[i] = b[i];
        }
        return string(out);
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
