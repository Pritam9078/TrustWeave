import type { FastifyInstance } from "fastify";
import * as S from "../schemas/index.js";
import * as identityService from "../services/identityService.js";
import * as orgService from "../services/orgService.js";
import { requireActor } from "../auth/middleware.js";
import { validate } from "./_helpers.js";
import * as audit from "../services/auditService.js";
import { newTraceId } from "../core/ids.js";
import { env } from "../config/env.js";

export async function authRoutes(app: FastifyInstance) {
  /** Step 1 of DID auth. Rate-limited harder than the rest of the API. */
  app.post("/api/auth/challenge", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req) => {
    const body = validate(S.didLoginStart, req.body);
    const challenge = await identityService.createChallenge(body.did);
    // `known` is intentionally not returned to the client — see createChallenge.
    return { challengeId: challenge.challengeId, nonce: challenge.nonce, message: challenge.message, expiresInSeconds: challenge.expiresInSeconds };
  });

  app.post("/api/auth/verify", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req, reply) => {
    const body = validate(S.didLoginVerify, req.body);
    const { session, identity } = await identityService.verifyChallengeAndLogin({
      ...body, ip: req.ip, userAgent: String(req.headers["user-agent"] ?? ""),
    });
    audit.record({
      organizationId: identity.organization_id, traceId: newTraceId(),
      actorId: identity.id, actorDid: identity.did, actorKind: identity.kind,
      action: "AUTH_LOGIN", resourceType: "SESSION", resourceId: session.sessionId,
      decision: "ALLOW", reasonCodes: ["DID_SIGNATURE"], ip: req.ip,
      payload: { method: "did-challenge" },
    });
    return reply.send(await sessionResponse(session, identity));
  });

  app.post("/api/auth/login", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req, reply) => {
    const body = validate(S.passwordLogin, req.body);
    const { session, identity } = await identityService.passwordLogin({
      ...body, ip: req.ip, userAgent: String(req.headers["user-agent"] ?? ""),
    });
    audit.record({
      organizationId: identity.organization_id, traceId: newTraceId(),
      actorId: identity.id, actorDid: identity.did, actorKind: identity.kind,
      action: "AUTH_LOGIN", resourceType: "SESSION", resourceId: session.sessionId,
      decision: "ALLOW", reasonCodes: ["PASSWORD"], ip: req.ip,
      payload: { method: "password", note: "Development-only authentication path." },
    });
    return reply.send(await sessionResponse(session, identity));
  });

  /** The client's source of truth for what to render. Recomputed live, never cached. */
  app.get("/api/session", async (req) => {
    const actor = requireActor(req);
    const perms = (await identityService.effectivePermissions(actor.identityId, actor.organizationId))!;
    const org = orgService.getOrganization(actor.organizationId);
    return {
      identity: {
        id: actor.identityId, did: actor.did, kind: actor.kind,
        displayName: perms.roles.length ? undefined : undefined,
      },
      organization: org ? { id: (await org).id, name: (await org).name, slug: (await org).slug } : null,
      departmentId: actor.departmentId,
      roles: perms.roles,
      capabilities: perms.capabilities,
      scopes: perms.scopes,
      workspace: pickWorkspace(perms.roles.map((r) => r.name)),
      agent: actor.agent ? { id: actor.agent.id, status: actor.agent.status, tools: actor.agent.tools, limits: actor.agent.limits } : null,
    };
  });

  app.post("/api/auth/logout", async (req) => {
    const actor = requireActor(req);
    await identityService.revokeAllSessionsFor(actor.identityId);
    audit.record({
      organizationId: actor.organizationId, traceId: newTraceId(),
      actorId: actor.identityId, actorDid: actor.did, actorKind: actor.kind,
      action: "AUTH_LOGOUT", resourceType: "SESSION", decision: "INFO",
    });
    return { ok: true };
  });

  app.get("/api/auth/config", async () => ({
    passwordLoginEnabled: env.ALLOW_PASSWORD_LOGIN,
    didAuthEnabled: true,
    challengeTtlSeconds: env.CHALLENGE_TTL_SECONDS,
  }));
}

async function sessionResponse(session: { token: string; sessionId: string; expiresAt: string }, identity: any) {
  const perms = (await identityService.effectivePermissions(identity.id, identity.organization_id))!;
  return {
    token: session.token,
    expiresAt: session.expiresAt,
    identity: identityService.toApiIdentity(identity),
    roles: perms.roles,
    capabilities: perms.capabilities,
    scopes: perms.scopes,
    workspace: pickWorkspace(perms.roles.map((r) => r.name)),
  };
}

/**
 * Landing workspace resolution (Frontend §5). Ordered by authority so someone holding
 * both Admin and Manager lands in the Admin console rather than whichever role happened
 * to be assigned first.
 */
export function pickWorkspace(roleNames: string[]): "admin" | "manager" | "auditor" | "user" {
  if (roleNames.includes("Admin")) return "admin";
  if (roleNames.includes("Manager")) return "manager";
  if (roleNames.includes("Auditor")) return "auditor";
  return "user";
}
