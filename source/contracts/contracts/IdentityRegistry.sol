// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControlled} from "./AccessControlled.sol";

/**
 * On-chain identity anchoring.
 *
 * Stores COMMITMENTS ONLY — a keccak/sha commitment of the DID, never the DID string,
 * never a name, never an email. Anyone reading the chain sees opaque 32-byte values;
 * only a party who already knows the DID can confirm a match. This keeps the registry
 * useful for verification while making it useless as a directory of who works where,
 * and it means the chain is not a personal-data store subject to erasure requests it
 * could never satisfy.
 */
contract IdentityRegistry is AccessControlled {
    enum Status { NONE, ACTIVE, SUSPENDED, REVOKED }

    struct Identity {
        Status status;
        uint64 registeredAt;
        uint64 updatedAt;
        bytes32 orgCommitment;
    }

    mapping(bytes32 => Identity) private _identities;
    uint256 public identityCount;

    event IdentityRegistered(bytes32 indexed didCommitment, bytes32 indexed orgCommitment, uint64 at);
    event IdentityStatusChanged(bytes32 indexed didCommitment, Status previous, Status current, uint64 at);

    error AlreadyRegistered();
    error UnknownIdentity();
    error RevocationIsFinal();
    error InvalidCommitment();

    constructor(address initialAdmin) AccessControlled(initialAdmin) {}

    function registerIdentity(bytes32 didCommitment, bytes32 orgCommitment) external onlyWriter {
        if (didCommitment == bytes32(0)) revert InvalidCommitment();
        if (_identities[didCommitment].status != Status.NONE) revert AlreadyRegistered();

        _identities[didCommitment] = Identity({
            status: Status.ACTIVE,
            registeredAt: uint64(block.timestamp),
            updatedAt: uint64(block.timestamp),
            orgCommitment: orgCommitment
        });
        unchecked { identityCount++; }
        emit IdentityRegistered(didCommitment, orgCommitment, uint64(block.timestamp));
    }

    /**
     * Revocation is terminal. A revoked identity cannot be reactivated, on-chain or off:
     * if the private key behind a DID is compromised, "un-revoking" it would restore the
     * attacker's access, so recovery means issuing a new identity rather than resurrecting
     * the old one. The backend enforces the same rule, and this is the backstop.
     */
    function setIdentityStatus(bytes32 didCommitment, Status status) external onlyWriter {
        Identity storage identity = _identities[didCommitment];
        if (identity.status == Status.NONE) revert UnknownIdentity();
        if (identity.status == Status.REVOKED) revert RevocationIsFinal();
        if (status == Status.NONE) revert UnknownIdentity();

        Status previous = identity.status;
        identity.status = status;
        identity.updatedAt = uint64(block.timestamp);
        emit IdentityStatusChanged(didCommitment, previous, status, uint64(block.timestamp));
    }

    function getIdentity(bytes32 didCommitment)
        external view
        returns (bool exists, Status status, uint64 registeredAt, uint64 updatedAt, bytes32 orgCommitment)
    {
        Identity memory identity = _identities[didCommitment];
        return (identity.status != Status.NONE, identity.status, identity.registeredAt, identity.updatedAt, identity.orgCommitment);
    }

    function isActive(bytes32 didCommitment) external view returns (bool) {
        return _identities[didCommitment].status == Status.ACTIVE;
    }
}
