// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * Shared admin/writer control for the AgentProof registries.
 *
 * Deliberately hand-rolled and minimal rather than pulling in a full role framework:
 * there are exactly two privilege levels here, and a reviewer can verify the whole
 * access model by reading forty lines.
 *
 * The separation matters. The `admin` governs *who may write*; a `writer` is the
 * backend's signing key, which may record facts but may never grant privileges or
 * pause the contract. If the backend key leaks, the attacker can write junk records —
 * they cannot lock out the admin, promote themselves, or disable the pause switch.
 */
abstract contract AccessControlled {
    address public admin;
    address public pendingAdmin;
    bool public paused;

    mapping(address => bool) public writers;

    event AdminTransferStarted(address indexed from, address indexed to);
    event AdminTransferred(address indexed from, address indexed to);
    event WriterSet(address indexed writer, bool allowed);
    event PausedSet(bool paused);

    error NotAdmin();
    error NotWriter();
    error ContractPaused();
    error ZeroAddress();

    constructor(address initialAdmin) {
        if (initialAdmin == address(0)) revert ZeroAddress();
        admin = initialAdmin;
        writers[initialAdmin] = true;
        emit AdminTransferred(address(0), initialAdmin);
        emit WriterSet(initialAdmin, true);
    }

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    /** Writes require an authorised writer AND an unpaused contract. Pausing is the
     *  on-chain half of the emergency freeze exposed in the admin console. */
    modifier onlyWriter() {
        if (!writers[msg.sender]) revert NotWriter();
        if (paused) revert ContractPaused();
        _;
    }

    function setWriter(address writer, bool allowed) external onlyAdmin {
        if (writer == address(0)) revert ZeroAddress();
        writers[writer] = allowed;
        emit WriterSet(writer, allowed);
    }

    function setPaused(bool value) external onlyAdmin {
        paused = value;
        emit PausedSet(value);
    }

    /**
     * Two-step admin handover. A single-step transfer to a mistyped address would brick
     * governance permanently, and these registries have no recovery path.
     */
    function transferAdmin(address newAdmin) external onlyAdmin {
        if (newAdmin == address(0)) revert ZeroAddress();
        pendingAdmin = newAdmin;
        emit AdminTransferStarted(msg.sender, newAdmin);
    }

    function acceptAdmin() external {
        if (msg.sender != pendingAdmin) revert NotAdmin();
        address previous = admin;
        admin = pendingAdmin;
        pendingAdmin = address(0);
        emit AdminTransferred(previous, admin);
    }
}
