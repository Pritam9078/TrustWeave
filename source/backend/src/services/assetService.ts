import { one, many, run, tx, j } from "../db/clientV2.js";
import { newId } from "../core/ids.js";
import { nowIso } from "../core/time.js";
import { hashObject } from "../core/hash.js";
import { didCommitment } from "../auth/did.js";
import { getBlockchainAdapter } from "../adapters/blockchain/index.js";
import { badRequest, conflict, notFound, unprocessable } from "../core/errors.js";
import * as audit from "./auditService.js";
import * as proofService from "./proofService.js";
import type { ActorContext } from "../authorization/types.js";

/**
 * Digital asset lifecycle (PRD §5.5).
 *
 * DRAFT → MINTED → ACTIVE → (FROZEN ⇄ ACTIVE) → REVOKED
 *
 * Off-chain/on-chain split, enforced by construction rather than by discipline:
 * `metadata_json` (which may contain private organizational detail) stays in the
 * database, and only `metadata_hash` — a commitment that reveals nothing — is passed
 * to the chain adapter. The adapter interface has no parameter capable of carrying
 * the metadata itself, so there is no call site at which private data *could* be sent.
 */

export interface CreateAssetInput {
  name: string;
  assetType: string;
  departmentId?: string | null;
  collectionId?: string | null;
  metadata?: Record<string, unknown>;
  ownerDid?: string | null;
}

export async function listAssets(organizationId: string, opts: { status?: string; departmentId?: string; ownerDid?: string; collectionId?: string; q?: string } = {}) {
  const where = ["a.organization_id = ?"];
  const params: unknown[] = [organizationId];
  if (opts.status) { where.push("a.status = ?"); params.push(opts.status); }
  if (opts.departmentId) { where.push("a.department_id = ?"); params.push(opts.departmentId); }
  if (opts.ownerDid) { where.push("a.owner_did = ?"); params.push(opts.ownerDid); }
  if (opts.collectionId) { where.push("a.collection_id = ?"); params.push(opts.collectionId); }
  if (opts.q) { where.push("(a.name LIKE ? OR a.asset_type LIKE ?)"); params.push(`%${opts.q}%`, `%${opts.q}%`); }
  return await many<any>(
    `SELECT a.*, d.name AS department_name, c.name AS collection_name
     FROM assets a
     LEFT JOIN departments d ON d.id = a.department_id
     LEFT JOIN asset_collections c ON c.id = a.collection_id
     WHERE ${where.join(" AND ")} ORDER BY a.created_at DESC LIMIT 500`,
    ...params,
  );
}

export async function getAsset(organizationId: string, id: string) {
  return await one<any>(
    `SELECT a.*, d.name AS department_name, c.name AS collection_name
     FROM assets a
     LEFT JOIN departments d ON d.id = a.department_id
     LEFT JOIN asset_collections c ON c.id = a.collection_id
     WHERE a.organization_id = ? AND a.id = ?`,
    organizationId, id,
  );
}

export async function assetHistory(assetId: string) {
  return await many<any>(`SELECT * FROM asset_events WHERE asset_id = ? ORDER BY timestamp ASC`, assetId);
}

async function recordAssetEvent(input: {
  assetId: string; eventType: string; fromDid?: string | null; toDid?: string | null;
  actorId: string; traceId: string; txHash?: string | null; detail?: Record<string, unknown>;
}) {
  await run(
    `INSERT INTO asset_events (id, asset_id, event_type, from_did, to_did, actor_id, trace_id, tx_hash, detail_json, timestamp)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    newId("aevt"), input.assetId, input.eventType, input.fromDid ?? null, input.toDid ?? null,
    input.actorId, input.traceId, input.txHash ?? null, j.enc(input.detail ?? {}), nowIso(),
  );
}

export async function createAsset(actor: ActorContext, traceId: string, input: CreateAssetInput) {
  const metadata = input.metadata ?? {};
  const metadataHash = hashObject(metadata);
  const id = newId("asset");
  const ts = nowIso();

  await tx(async () => {
    await run(
      `INSERT INTO assets (id, organization_id, department_id, collection_id, name, asset_type,
        metadata_ref, metadata_json, metadata_hash, owner_did, status, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, actor.organizationId, input.departmentId ?? null, input.collectionId ?? null,
      input.name, input.assetType, `trustweave://assets/${id}/metadata`,
      j.enc(metadata), metadataHash, input.ownerDid ?? null, "DRAFT", actor.identityId, ts, ts,
    );
    recordAssetEvent({ assetId: id, eventType: "CREATED", actorId: actor.identityId, traceId, toDid: input.ownerDid ?? null });
  });

  return getAsset(actor.organizationId, id)!;
}

/**
 * Mint. The database write and the chain write cannot be a single atomic unit — there
 * is no distributed transaction across a blockchain — so ordering matters: the chain
 * write happens FIRST and the row is only promoted to MINTED once it has succeeded.
 * A chain failure therefore leaves a DRAFT asset that can be retried, rather than a
 * database row claiming a token that does not exist on-chain.
 */
export async function mintAsset(actor: ActorContext, traceId: string, assetId: string) {
  const asset = await getAsset(actor.organizationId, assetId);
  if (!asset) throw notFound("Asset not found.");
  if (asset.nft_token_id) throw conflict("ALREADY_MINTED", "This asset already has an NFT token.");
  if (asset.status === "REVOKED") throw unprocessable("ASSET_REVOKED", "A revoked asset cannot be minted.");
  if (!asset.owner_did) throw badRequest("OWNER_REQUIRED", "Assign an owner DID before minting.");

  const chain = getBlockchainAdapter();
  const tokenId = `apt-${assetId}`;
  const ownerCommitment = await didCommitment(asset.owner_did);

  const receipt = await chain.mintAsset({
    tokenId,
    ownerCommitment,
    metadataCommitment: "0x" + asset.metadata_hash.replace(/^sha256:/, ""),
  });

  await tx(async () => {
    await run(`UPDATE assets SET nft_token_id = ?, status = 'ACTIVE', chain_tx_hash = ?, updated_at = ? WHERE id = ?`,
      tokenId, receipt.txHash, nowIso(), assetId);
    recordAssetEvent({
      assetId, eventType: "MINTED", actorId: actor.identityId, traceId,
      txHash: receipt.txHash, toDid: asset.owner_did,
      detail: { tokenId, chainId: receipt.chainId, simulated: receipt.simulated },
    });
  });

  proofService.anchor({
    organizationId: actor.organizationId,
    subjectType: "ASSET",
    subjectId: assetId,
    payload: { assetId, tokenId, ownerCommitment, metadataHash: asset.metadata_hash, action: "MINT" },
  }).catch(() => { /* anchoring is best-effort and retryable; the mint itself already succeeded */ });

  return { asset: getAsset(actor.organizationId, assetId)!, receipt };
}

export async function assignAsset(actor: ActorContext, traceId: string, assetId: string, ownerDid: string) {
  const asset = await getAsset(actor.organizationId, assetId);
  if (!asset) throw notFound("Asset not found.");
  if (asset.status === "REVOKED") throw unprocessable("ASSET_REVOKED", "A revoked asset cannot be reassigned.");
  if (asset.status === "FROZEN") throw unprocessable("ASSET_FROZEN", "Unfreeze the asset before reassigning it.");

  const previous = asset.owner_did;
  await tx(async () => {
    await run(`UPDATE assets SET owner_did = ?, updated_at = ? WHERE id = ?`, ownerDid, nowIso(), assetId);
    recordAssetEvent({ assetId, eventType: "ASSIGNED", actorId: actor.identityId, traceId, fromDid: previous, toDid: ownerDid });
  });
  return getAsset(actor.organizationId, assetId)!;
}

export async function transferAsset(actor: ActorContext, traceId: string, assetId: string, newOwnerDid: string) {
  const asset = await getAsset(actor.organizationId, assetId);
  if (!asset) throw notFound("Asset not found.");
  if (asset.status === "REVOKED") throw unprocessable("ASSET_REVOKED", "A revoked asset cannot be transferred.");
  if (asset.status === "FROZEN") throw unprocessable("ASSET_FROZEN", "This asset is frozen and cannot be transferred.");
  if (asset.owner_did === newOwnerDid) throw badRequest("NO_OP_TRANSFER", "The asset is already owned by that DID.");

  const previous = asset.owner_did;
  let txHash: string | null = null;

  if (asset.nft_token_id) {
    const receipt = await getBlockchainAdapter().transferAsset({
      tokenId: asset.nft_token_id,
      newOwnerCommitment: didCommitment(newOwnerDid),
    });
    txHash = receipt.txHash;
  }

  await tx(async () => {
    await run(`UPDATE assets SET owner_did = ?, chain_tx_hash = COALESCE(?, chain_tx_hash), updated_at = ? WHERE id = ?`,
      newOwnerDid, txHash, nowIso(), assetId);
    recordAssetEvent({ assetId, eventType: "TRANSFERRED", actorId: actor.identityId, traceId, fromDid: previous, toDid: newOwnerDid, txHash });
  });

  proofService.anchor({
    organizationId: actor.organizationId,
    subjectType: "ASSET",
    subjectId: assetId,
    payload: { assetId, from: previous, to: newOwnerDid, action: "TRANSFER" },
  }).catch(() => {});

  return getAsset(actor.organizationId, assetId)!;
}

export async function setFrozen(actor: ActorContext, traceId: string, assetId: string, frozen: boolean, reason: string) {
  const asset = await getAsset(actor.organizationId, assetId);
  if (!asset) throw notFound("Asset not found.");
  if (asset.status === "REVOKED") throw unprocessable("ASSET_REVOKED", "A revoked asset cannot change freeze state.");

  let txHash: string | null = null;
  if (asset.nft_token_id) {
    const receipt = await getBlockchainAdapter().setAssetFrozen(asset.nft_token_id, frozen);
    txHash = receipt.txHash;
  }

  await tx(async () => {
    await run(`UPDATE assets SET status = ?, updated_at = ? WHERE id = ?`, frozen ? "FROZEN" : "ACTIVE", nowIso(), assetId);
    recordAssetEvent({
      assetId, eventType: frozen ? "FROZEN" : "UNFROZEN",
      actorId: actor.identityId, traceId, txHash, detail: { reason },
    });
  });
  return getAsset(actor.organizationId, assetId)!;
}

export async function revokeAsset(actor: ActorContext, traceId: string, assetId: string, reason: string) {
  const asset = await getAsset(actor.organizationId, assetId);
  if (!asset) throw notFound("Asset not found.");
  if (asset.status === "REVOKED") return asset;

  let txHash: string | null = null;
  if (asset.nft_token_id) {
    const receipt = await getBlockchainAdapter().revokeAsset(asset.nft_token_id);
    txHash = receipt.txHash;
  }

  await tx(async () => {
    await run(`UPDATE assets SET status = 'REVOKED', updated_at = ? WHERE id = ?`, nowIso(), assetId);
    recordAssetEvent({ assetId, eventType: "REVOKED", actorId: actor.identityId, traceId, txHash, detail: { reason } });
  });
  return getAsset(actor.organizationId, assetId)!;
}

/**
 * Independent verification: read the chain and compare it against the database.
 * Reported field-by-field rather than as a single boolean, because "owner differs" and
 * "metadata differs" are very different incidents and collapsing them loses the signal.
 */
export async function verifyAssetOnChain(organizationId: string, assetId: string) {
  const asset = await getAsset(organizationId, assetId);
  if (!asset) throw notFound("Asset not found.");
  if (!asset.nft_token_id) {
    return { verified: false, reason: "Asset has not been minted; there is nothing on-chain to compare against.", onChain: null, checks: [] };
  }
  const chain = getBlockchainAdapter();
  const onChain = await chain.getAsset(asset.nft_token_id);

  const expectedOwner = asset.owner_did ? didCommitment(asset.owner_did) : null;
  const expectedMetadata = "0x" + asset.metadata_hash.replace(/^sha256:/, "");

  const checks = [
    { name: "Token exists on-chain", pass: onChain.exists, detail: onChain.exists ? asset.nft_token_id : "Token not found on-chain." },
    { name: "Owner commitment matches", pass: onChain.ownerCommitment?.toLowerCase() === expectedOwner?.toLowerCase(),
      detail: `on-chain ${onChain.ownerCommitment} vs database ${expectedOwner}` },
    { name: "Metadata commitment matches", pass: onChain.metadataCommitment?.toLowerCase() === expectedMetadata.toLowerCase(),
      detail: `on-chain ${onChain.metadataCommitment} vs database ${expectedMetadata}` },
    { name: "Freeze state matches", pass: onChain.frozen === (asset.status === "FROZEN"),
      detail: `on-chain frozen=${onChain.frozen}, database status=${asset.status}` },
  ];

  return {
    verified: checks.every((c) => c.pass),
    reason: checks.every((c) => c.pass) ? null : "One or more on-chain values diverge from the database record.",
    onChain, checks, adapterKind: chain.kind,
  };
}

/* ---------------------------------------------------------------- collections */

export async function listCollections(organizationId: string) {
  return await many<any>(
    `SELECT c.*, (SELECT COUNT(*) FROM assets a WHERE a.collection_id = c.id) AS asset_count
     FROM asset_collections c WHERE c.organization_id = ? ORDER BY c.name`,
    organizationId,
  );
}

export async function createCollection(organizationId: string, name: string, description = "") {
  if (await one(`SELECT id FROM asset_collections WHERE organization_id = ? AND name = ?`, organizationId, name)) {
    throw conflict("COLLECTION_EXISTS", `A collection named "${name}" already exists.`);
  }
  const id = newId("asset");
  await run(`INSERT INTO asset_collections (id, organization_id, name, description, created_at) VALUES (?,?,?,?,?)`,
    id, organizationId, name, description, nowIso());
  return await one<any>(`SELECT * FROM asset_collections WHERE id = ?`, id);
}

export async function toApi(row: any) {
  return {
    id: row.id, name: row.name, assetType: row.asset_type,
    departmentId: row.department_id, departmentName: row.department_name ?? null,
    collectionId: row.collection_id, collectionName: row.collection_name ?? null,
    metadataRef: row.metadata_ref, metadataHash: row.metadata_hash,
    metadata: j.dec(row.metadata_json, {}),
    nftTokenId: row.nft_token_id, ownerDid: row.owner_did, status: row.status,
    chainTxHash: row.chain_tx_hash, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

export async function eventToApi(row: any) {
  return {
    id: row.id, assetId: row.asset_id, eventType: row.event_type,
    fromDid: row.from_did, toDid: row.to_did, actorId: row.actor_id,
    traceId: row.trace_id, txHash: row.tx_hash,
    detail: j.dec(row.detail_json, {}), timestamp: row.timestamp,
  };
}
