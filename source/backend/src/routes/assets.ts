import type { FastifyInstance } from "fastify";
import * as S from "../schemas/index.js";
import { validate } from "./_helpers.js";
import { requireActor, requireHuman } from "../auth/middleware.js";
import * as assetService from "../services/assetService.js";
import * as authz from "../services/authorizationService.js";
import * as audit from "../services/auditService.js";
import * as proofService from "../services/proofService.js";
import { notFound } from "../core/errors.js";

export async function assetRoutes(app: FastifyInstance) {
  app.get("/api/assets", async (req) => {
    const actor = requireActor(req);
    await authz.enforce({ actor, action: "ASSET_READ", resource: { type: "ASSET", query: true }, ip: req.ip });
    const q = req.query as any;
    let rows = await assetService.listAssets(actor.organizationId, q);

    // Scope-filter the *list*, not just individual reads. A Manager confined to Finance
    // must not be able to enumerate HR asset names, which a per-item check on the detail
    // route alone would still allow.
    const filtered = [];
    for (const row of rows) {
      const decision = await authz.check({
        actor, action: "ASSET_READ",
        resource: {
          type: "ASSET", id: row.id, organizationId: row.organization_id,
          departmentId: row.department_id, collectionId: row.collection_id, ownerDid: row.owner_did,
        },
      });
      if (decision.decision !== "DENY") {
        filtered.push(row);
      }
    }
    return { assets: filtered.map(assetService.toApi) };
  });

  app.get("/api/assets/:id", async (req) => {
    const actor = requireActor(req);
    const { id } = req.params as { id: string };
    const asset = await assetService.getAsset(actor.organizationId, id);
    if (!asset) throw notFound("Asset not found.");
    await authz.enforce({
      actor, action: "ASSET_READ",
      resource: { type: "ASSET", id, organizationId: asset.organization_id, departmentId: asset.department_id, collectionId: asset.collection_id, ownerDid: asset.owner_did },
      ip: req.ip,
    });
    return {
      asset: assetService.toApi(asset),
      history: (await assetService.assetHistory(id)).map(assetService.eventToApi),
      proofs: (await proofService.listProofs(actor.organizationId, { subjectType: "ASSET", subjectId: id })).map(proofService.toApi),
    };
  });

  app.get("/api/assets/:id/verify", async (req) => {
    const actor = requireActor(req);
    const { id } = req.params as { id: string };
    await authz.enforce({ actor, action: "PROOF_VERIFY", resource: { type: "ASSET", id }, ip: req.ip });
    return assetService.verifyAssetOnChain(actor.organizationId, id);
  });

  app.post("/api/assets", async (req, reply) => {
    const actor = requireHuman(req);
    const body = validate(S.createAsset, req.body);
    const enforcement = await authz.enforce({
      actor, action: "ASSET_CREATE",
      resource: { type: "ASSET", departmentId: body.departmentId ?? null, collectionId: body.collectionId ?? null },
      ip: req.ip, payload: { name: body.name, assetType: body.assetType },
    });
    const asset = await assetService.createAsset(actor, enforcement.traceId, body);
    audit.record({
      organizationId: actor.organizationId, traceId: enforcement.traceId, actorId: actor.identityId,
      actorDid: actor.did, action: "ASSET_CREATED", resourceType: "ASSET", resourceId: asset.id,
      decision: "EXECUTED", payload: { name: body.name, metadataHash: asset.metadata_hash },
    });
    return reply.code(201).send({ asset: assetService.toApi(asset) });
  });

  app.post("/api/assets/:id/mint", async (req) => {
    const actor = requireHuman(req);
    const { id } = req.params as { id: string };
    const asset = await assetService.getAsset(actor.organizationId, id);
    if (!asset) throw notFound("Asset not found.");
    const enforcement = await authz.enforce({
      actor, action: "ASSET_MINT",
      resource: { type: "ASSET", id, organizationId: asset.organization_id, departmentId: asset.department_id, collectionId: asset.collection_id },
      ip: req.ip,
    });
    const { asset: minted, receipt } = await assetService.mintAsset(actor, enforcement.traceId, id);
    audit.record({
      organizationId: actor.organizationId, traceId: enforcement.traceId, actorId: actor.identityId,
      actorDid: actor.did, action: "ASSET_MINTED", resourceType: "ASSET", resourceId: id,
      decision: "EXECUTED", executionRef: receipt.txHash,
      payload: { tokenId: (await minted).nft_token_id, txHash: receipt.txHash, chainId: receipt.chainId, simulated: receipt.simulated },
    });
    return { asset: assetService.toApi(minted), receipt };
  });

  app.post("/api/assets/:id/assign", async (req) => {
    const actor = requireHuman(req);
    const { id } = req.params as { id: string };
    const body = validate(S.assetOwner, req.body);
    const asset = await assetService.getAsset(actor.organizationId, id);
    if (!asset) throw notFound("Asset not found.");
    const enforcement = await authz.enforce({
      actor, action: "ASSET_ASSIGN",
      resource: { type: "ASSET", id, organizationId: asset.organization_id, departmentId: asset.department_id, collectionId: asset.collection_id },
      ip: req.ip,
    });
    const updated = assetService.assignAsset(actor, enforcement.traceId, id, body.ownerDid);
    audit.record({
      organizationId: actor.organizationId, traceId: enforcement.traceId, actorId: actor.identityId,
      actorDid: actor.did, action: "ASSET_ASSIGNED", resourceType: "ASSET", resourceId: id,
      decision: "EXECUTED", payload: { ownerDid: body.ownerDid, previousOwner: asset.owner_did },
    });
    return { asset: assetService.toApi(updated) };
  });

  app.post("/api/assets/:id/transfer", async (req) => {
    const actor = requireHuman(req);
    const { id } = req.params as { id: string };
    const body = validate(S.assetTransfer, req.body);
    const asset = await assetService.getAsset(actor.organizationId, id);
    if (!asset) throw notFound("Asset not found.");
    const enforcement = await authz.enforce({
      actor, action: "ASSET_TRANSFER",
      resource: { type: "ASSET", id, organizationId: asset.organization_id, departmentId: asset.department_id, collectionId: asset.collection_id, ownerDid: asset.owner_did },
      ip: req.ip, payload: { newOwnerDid: body.newOwnerDid },
    });
    const updated = await assetService.transferAsset(actor, enforcement.traceId, id, body.newOwnerDid);
    audit.record({
      organizationId: actor.organizationId, traceId: enforcement.traceId, actorId: actor.identityId,
      actorDid: actor.did, action: "ASSET_TRANSFERRED", resourceType: "ASSET", resourceId: id,
      decision: "EXECUTED", payload: { from: asset.owner_did, to: body.newOwnerDid, reason: body.reason },
    });
    return { asset: assetService.toApi(updated) };
  });

  app.post("/api/assets/:id/freeze", async (req) => {
    const actor = requireHuman(req);
    const { id } = req.params as { id: string };
    const body = validate(S.assetFreeze, req.body);
    const asset = await assetService.getAsset(actor.organizationId, id);
    if (!asset) throw notFound("Asset not found.");
    const enforcement = await authz.enforce({
      actor, action: "ASSET_FREEZE",
      resource: { type: "ASSET", id, organizationId: asset.organization_id, departmentId: asset.department_id },
      ip: req.ip,
    });
    const updated = await assetService.setFrozen(actor, enforcement.traceId, id, body.frozen, body.reason);
    audit.record({
      organizationId: actor.organizationId, traceId: enforcement.traceId, actorId: actor.identityId,
      actorDid: actor.did, action: body.frozen ? "ASSET_FROZEN" : "ASSET_UNFROZEN",
      resourceType: "ASSET", resourceId: id, decision: "EXECUTED", payload: { reason: body.reason },
    });
    return { asset: assetService.toApi(updated) };
  });

  app.post("/api/assets/:id/revoke", async (req) => {
    const actor = requireHuman(req);
    const { id } = req.params as { id: string };
    const body = validate(S.assetRevoke, req.body);
    const asset = await assetService.getAsset(actor.organizationId, id);
    if (!asset) throw notFound("Asset not found.");
    const enforcement = await authz.enforce({
      actor, action: "ASSET_REVOKE",
      resource: { type: "ASSET", id, organizationId: asset.organization_id, departmentId: asset.department_id },
      ip: req.ip,
    });
    const updated = await assetService.revokeAsset(actor, enforcement.traceId, id, body.reason);
    audit.record({
      organizationId: actor.organizationId, traceId: enforcement.traceId, actorId: actor.identityId,
      actorDid: actor.did, action: "ASSET_REVOKED", resourceType: "ASSET", resourceId: id,
      decision: "EXECUTED", payload: { reason: body.reason },
    });
    return { asset: assetService.toApi(updated) };
  });

  app.get("/api/collections", async (req) => {
    const actor = requireActor(req);
    await authz.enforce({ actor, action: "ASSET_READ", resource: { type: "ASSET", query: true }, ip: req.ip });
    return { collections: assetService.listCollections(actor.organizationId) };
  });

  app.post("/api/collections", async (req, reply) => {
    const actor = requireHuman(req);
    const body = validate(S.createCollection, req.body);
    await authz.enforce({ actor, action: "ASSET_CREATE", resource: { type: "ASSET" }, ip: req.ip });
    return reply.code(201).send({ collection: assetService.createCollection(actor.organizationId, body.name, body.description) });
  });
}
