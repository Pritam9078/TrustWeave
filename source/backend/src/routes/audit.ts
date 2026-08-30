import type { FastifyInstance } from "fastify";
import { requireActor } from "../auth/middleware.js";
import * as audit from "../services/auditService.js";
import * as proofService from "../services/proofService.js";
import * as authz from "../services/authorizationService.js";
import { intParam } from "./_helpers.js";
import { notFound } from "../core/errors.js";

export async function auditRoutes(app: FastifyInstance) {
  app.get("/api/audit/events", async (req) => {
    const actor = requireActor(req);
    authz.enforce({ actor, action: "AUDIT_READ", resource: { type: "AUDIT", query: true }, ip: req.ip });
    const q = req.query as any;

    // Without AUDIT-wide visibility a plain User sees only their own events. The filter
    // is applied server-side; a client cannot widen it by changing a query parameter.
    const canSeeAll = actor.roleNames.some((r) => ["Admin", "Auditor", "Manager"].includes(r));
    const events = audit.query({
      organizationId: actor.organizationId,
      actorId: canSeeAll ? q.actorId : actor.identityId,
      action: q.action, resourceType: q.resourceType, resourceId: q.resourceId,
      decision: q.decision, traceId: q.traceId, from: q.from, to: q.to,
      limit: intParam(q.limit, 50), offset: intParam(q.offset, 0),
    });
    return { ...events, events: events.events.map(audit.toApi), chain: audit.verifyChain(actor.organizationId) };
  });

  app.get("/api/audit/events/:id", async (req) => {
    const actor = requireActor(req);
    const { id } = req.params as { id: string };
    authz.enforce({ actor, action: "AUDIT_READ", resource: { type: "AUDIT", id }, ip: req.ip });
    const event = audit.byId(actor.organizationId, id);
    if (!event) throw notFound("Audit event not found.");
    return {
      event: audit.toApi(event),
      trace: audit.byTrace(actor.organizationId, event.trace_id).map(audit.toApi),
      proofs: proofService.listProofs(actor.organizationId, { subjectId: event.resource_id ?? undefined }).map(proofService.toApi),
    };
  });

  app.get("/api/audit/verify-chain", async (req) => {
    const actor = requireActor(req);
    authz.enforce({ actor, action: "AUDIT_READ", resource: { type: "AUDIT", query: true }, ip: req.ip });
    return audit.verifyChain(actor.organizationId);
  });

  app.get("/api/audit/export", async (req, reply) => {
    const actor = requireActor(req);
    authz.enforce({ actor, action: "REPORT_EXPORT", resource: { type: "AUDIT", query: true }, ip: req.ip });
    const q = req.query as any;
    const { events } = audit.query({ organizationId: actor.organizationId, ...q, limit: 500 });
    const header = "seq,timestamp,actor_did,action,resource_type,resource_id,decision,reason_codes,policy_version,event_hash";
    const rows = events.map((e) => [
      e.seq, e.timestamp, e.actor_did ?? "", e.action, e.resource_type, e.resource_id ?? "",
      e.decision, JSON.parse(e.reason_codes || "[]").join("|"), e.policy_version ?? "", e.event_hash,
    ].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","));
    reply.header("content-type", "text/csv; charset=utf-8");
    reply.header("content-disposition", `attachment; filename="trustweave-audit-${Date.now()}.csv"`);
    return [header, ...rows].join("\n");
  });

  app.get("/api/proofs", async (req) => {
    const actor = requireActor(req);
    authz.enforce({ actor, action: "PROOF_VERIFY", resource: { type: "PROOF", query: true }, ip: req.ip });
    const q = req.query as any;
    return { proofs: proofService.listProofs(actor.organizationId, q).map(proofService.toApi) };
  });

  app.get("/api/proofs/:id", async (req) => {
    const actor = requireActor(req);
    const { id } = req.params as { id: string };
    authz.enforce({ actor, action: "PROOF_VERIFY", resource: { type: "PROOF", id }, ip: req.ip });
    const proof = proofService.getProof(actor.organizationId, id);
    if (!proof) throw notFound("Proof not found.");
    return { proof: proofService.toApi(proof) };
  });

  app.post("/api/proofs/:id/verify", async (req) => {
    const actor = requireActor(req);
    const { id } = req.params as { id: string };
    authz.enforce({ actor, action: "PROOF_VERIFY", resource: { type: "PROOF", id }, ip: req.ip });
    return proofService.verifyProof(actor.organizationId, id);
  });
}
