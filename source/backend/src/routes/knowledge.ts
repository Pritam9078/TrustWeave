import type { FastifyInstance } from "fastify";
import * as S from "../schemas/index.js";
import { validate } from "./_helpers.js";
import { requireActor, requireHuman } from "../auth/middleware.js";
import * as ragService from "../services/ragService.js";
import * as authz from "../services/authorizationService.js";
import * as audit from "../services/auditService.js";

export async function knowledgeRoutes(app: FastifyInstance) {
  app.get("/api/knowledge/documents", async (req) => {
    const actor = requireActor(req);
    await authz.enforce({ actor, action: "KNOWLEDGE_READ", resource: { type: "DOCUMENT", query: true }, ip: req.ip });
    return { documents: (await ragService.listDocuments(actor.organizationId, req.query as any)).map(ragService.toApiDocument) };
  });

  app.post("/api/knowledge/documents", async (req, reply) => {
    const actor = requireHuman(req);
    const body = validate(S.ingestDocument, req.body);
    const enforcement = await authz.enforce({ actor, action: "KNOWLEDGE_MANAGE", resource: { type: "DOCUMENT", query: true }, ip: req.ip, payload: { title: body.title } });
    const doc = await ragService.ingest({ organizationId: actor.organizationId, ...body });
    await audit.record({
      organizationId: actor.organizationId, traceId: enforcement.traceId, actorId: actor.identityId,
      actorDid: actor.did, action: "DOCUMENT_INGESTED", resourceType: "DOCUMENT", resourceId: doc.id,
      decision: "EXECUTED", payload: { title: body.title, classification: body.classification, sourceType: body.sourceType },
    });
    return reply.code(201).send({ document: ragService.toApiDocument(doc) });
  });

  app.delete("/api/knowledge/documents/:id", async (req) => {
    const actor = requireHuman(req);
    const { id } = req.params as { id: string };
    const enforcement = await authz.enforce({ actor, action: "KNOWLEDGE_MANAGE", resource: { type: "DOCUMENT", id }, ip: req.ip });
    await ragService.deleteDocument(actor.organizationId, id);
    await audit.record({
      organizationId: actor.organizationId, traceId: enforcement.traceId, actorId: actor.identityId,
      actorDid: actor.did, action: "DOCUMENT_DELETED", resourceType: "DOCUMENT", resourceId: id, decision: "EXECUTED",
    });
    return { ok: true };
  });

  /**
   * Search. Returns the exclusion diagnostics alongside the hits so a reviewer can see
   * the access filter working — "3 documents were excluded because they belong to
   * another department" is far more convincing than an unexplained short result list.
   */
  app.post("/api/knowledge/search", async (req) => {
    const actor = requireActor(req);
    const { query, limit } = (req.body ?? {}) as { query?: string; limit?: number };
    await authz.enforce({ actor, action: "KNOWLEDGE_READ", resource: { type: "DOCUMENT", query: true }, ip: req.ip });
    if (!query) return { chunks: [], filtered: { totalDocuments: 0, accessibleDocuments: 0, excluded: [] } };
    return await ragService.retrieveForActor(actor, query, Math.min(limit ?? 5, 10));
  });
}
