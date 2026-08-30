// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControlled} from "./AccessControlled.sol";

/**
 * Asset / NFT registry.
 *
 * A deliberately narrow ownership model rather than full ERC-721: these tokens
 * represent *organizationally controlled* assets — a company laptop, a software seat —
 * and must not be freely transferable by whoever happens to hold them. There is no
 * `approve`, no operator delegation, and no owner-initiated transfer. Every state
 * change is a governed write from the backend, which has already run the authorization
 * engine, policy checks and (where required) human approval.
 *
 * Making these ERC-721 would hand every holder an unconditional `transferFrom` and
 * silently defeat the entire authorization model.
 */
contract AssetRegistry is AccessControlled {
    struct Asset {
        bool exists;
        bool frozen;
        bool revoked;
        bytes32 ownerCommitment;
        bytes32 metadataCommitment;
        uint64 mintedAt;
        uint64 updatedAt;
    }

    mapping(bytes32 => Asset) private _assets;
    uint256 public assetCount;

    event AssetMinted(bytes32 indexed tokenId, bytes32 indexed ownerCommitment, bytes32 metadataCommitment, uint64 at);
    event AssetTransferred(bytes32 indexed tokenId, bytes32 indexed from, bytes32 indexed to, uint64 at);
    event AssetFrozenSet(bytes32 indexed tokenId, bool frozen, uint64 at);
    event AssetRevoked(bytes32 indexed tokenId, uint64 at);
    event AssetMetadataUpdated(bytes32 indexed tokenId, bytes32 previous, bytes32 current, uint64 at);

    error AlreadyMinted();
    error UnknownAsset();
    error AssetIsFrozen();
    error AssetIsRevoked();
    error InvalidCommitment();
    error SameOwner();

    constructor(address initialAdmin) AccessControlled(initialAdmin) {}

    function mint(bytes32 tokenId, bytes32 ownerCommitment, bytes32 metadataCommitment) external onlyWriter {
        if (tokenId == bytes32(0) || ownerCommitment == bytes32(0)) revert InvalidCommitment();
        if (_assets[tokenId].exists) revert AlreadyMinted();

        _assets[tokenId] = Asset({
            exists: true, frozen: false, revoked: false,
            ownerCommitment: ownerCommitment,
            metadataCommitment: metadataCommitment,
            mintedAt: uint64(block.timestamp),
            updatedAt: uint64(block.timestamp)
        });
        unchecked { assetCount++; }
        emit AssetMinted(tokenId, ownerCommitment, metadataCommitment, uint64(block.timestamp));
    }

    /** Frozen and revoked assets cannot move. The freeze check is what makes the
     *  admin console's "freeze asset" control meaningful rather than cosmetic. */
    function transfer(bytes32 tokenId, bytes32 newOwnerCommitment) external onlyWriter {
        Asset storage asset = _mutable(tokenId);
        if (newOwnerCommitment == bytes32(0)) revert InvalidCommitment();
        if (asset.ownerCommitment == newOwnerCommitment) revert SameOwner();

        bytes32 previous = asset.ownerCommitment;
        asset.ownerCommitment = newOwnerCommitment;
        asset.updatedAt = uint64(block.timestamp);
        emit AssetTransferred(tokenId, previous, newOwnerCommitment, uint64(block.timestamp));
    }

    function setFrozen(bytes32 tokenId, bool frozen) external onlyWriter {
        Asset storage asset = _assets[tokenId];
        if (!asset.exists) revert UnknownAsset();
        if (asset.revoked) revert AssetIsRevoked();
        asset.frozen = frozen;
        asset.updatedAt = uint64(block.timestamp);
        emit AssetFrozenSet(tokenId, frozen, uint64(block.timestamp));
    }

    /** Terminal, like identity revocation: a revoked asset accepts no further writes. */
    function revoke(bytes32 tokenId) external onlyWriter {
        Asset storage asset = _assets[tokenId];
        if (!asset.exists) revert UnknownAsset();
        if (asset.revoked) revert AssetIsRevoked();
        asset.revoked = true;
        asset.updatedAt = uint64(block.timestamp);
        emit AssetRevoked(tokenId, uint64(block.timestamp));
    }

    function updateMetadata(bytes32 tokenId, bytes32 metadataCommitment) external onlyWriter {
        Asset storage asset = _mutable(tokenId);
        bytes32 previous = asset.metadataCommitment;
        asset.metadataCommitment = metadataCommitment;
        asset.updatedAt = uint64(block.timestamp);
        emit AssetMetadataUpdated(tokenId, previous, metadataCommitment, uint64(block.timestamp));
    }

    function getAsset(bytes32 tokenId)
        external view
        returns (bool exists, bytes32 ownerCommitment, bytes32 metadataCommitment, bool frozen, bool revoked, uint64 mintedAt, uint64 updatedAt)
    {
        Asset memory asset = _assets[tokenId];
        return (asset.exists, asset.ownerCommitment, asset.metadataCommitment, asset.frozen, asset.revoked, asset.mintedAt, asset.updatedAt);
    }

    function _mutable(bytes32 tokenId) private view returns (Asset storage asset) {
        asset = _assets[tokenId];
        if (!asset.exists) revert UnknownAsset();
        if (asset.revoked) revert AssetIsRevoked();
        if (asset.frozen) revert AssetIsFrozen();
    }
}
