// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControlled} from "./AccessControlled.sol";

/**
 * Proof anchoring.
 *
 * Append-only by construction: a commitment can be written once and never altered or
 * deleted, by anyone, including the admin. That immutability is the whole product —
 * an anchor that could be rewritten would prove nothing, and an admin able to erase an
 * inconvenient record would make the audit trail worthless precisely when it matters.
 *
 * Note what an anchor does and does not establish. It shows a specific record existed
 * in a specific form at a specific block. It says nothing about whether the underlying
 * business decision was correct, and this contract does not pretend otherwise.
 */
contract ProofRegistry is AccessControlled {
    struct Proof {
        bool exists;
        bytes32 subjectCommitment;
        uint64 anchoredAt;
        uint256 blockNumber;
    }

    mapping(bytes32 => Proof) private _proofs;
    uint256 public proofCount;

    event ProofAnchored(bytes32 indexed commitment, bytes32 indexed subjectCommitment, uint64 at, uint256 blockNumber);

    error AlreadyAnchored();
    error InvalidCommitment();

    constructor(address initialAdmin) AccessControlled(initialAdmin) {}

    function anchor(bytes32 commitment, bytes32 subjectCommitment) external onlyWriter {
        if (commitment == bytes32(0)) revert InvalidCommitment();
        // No overwrite path exists — not for a writer, not for the admin. Re-anchoring
        // the same commitment is a no-op error rather than a silent update.
        if (_proofs[commitment].exists) revert AlreadyAnchored();

        _proofs[commitment] = Proof({
            exists: true,
            subjectCommitment: subjectCommitment,
            anchoredAt: uint64(block.timestamp),
            blockNumber: block.number
        });
        unchecked { proofCount++; }
        emit ProofAnchored(commitment, subjectCommitment, uint64(block.timestamp), block.number);
    }

    function verify(bytes32 commitment)
        external view
        returns (bool exists, bytes32 subjectCommitment, uint64 anchoredAt, uint256 blockNumber)
    {
        Proof memory proof = _proofs[commitment];
        return (proof.exists, proof.subjectCommitment, proof.anchoredAt, proof.blockNumber);
    }

    function isAnchored(bytes32 commitment) external view returns (bool) {
        return _proofs[commitment].exists;
    }
}
