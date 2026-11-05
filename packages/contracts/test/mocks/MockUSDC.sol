// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// Minimal 6-decimal ERC-20 standing in for Hedera's USDC facade. `setBlocked` makes transfers *to* an
/// address return false, like sending an HTS token to an account that is not associated with it.
contract MockUSDC {
    string public constant name = "USD Coin";
    string public constant symbol = "USDC";
    uint8 public constant decimals = 6;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public blocked;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function setBlocked(address account, bool isBlocked) external {
        blocked[account] = isBlocked;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        return _move(msg.sender, to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (allowance[from][msg.sender] < amount) return false;
        if (!_move(from, to, amount)) return false;
        allowance[from][msg.sender] -= amount;
        return true;
    }

    function _move(address from, address to, uint256 amount) internal returns (bool) {
        if (blocked[to] || balanceOf[from] < amount) return false;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}
