import type { FastifyRequest, FastifyReply } from "fastify";
import { resolveActorFromToken, buildActorContext } from "../services/identityService.js";
import { resolveAgentToken } from "../services/agentService.js";
import { unauthorized, forbidden } from "../core/errors.js";
import type { ActorContext } from "../authorization/types.js";

declare module "fastify" {
  interface FastifyRequest {
    actor?: ActorContext;
    rawBodyString?: string;
  }
}

/**
 * Attach an ActorContext to the request, if a valid credential is present.
 *
 * Two credential types, both resolving to the *same* ActorContext shape so downstream
 * code cannot tell a human from an agent except by inspecting `kind`:
 *   Authorization: Bearer <session token>   — humans
 *   x-agent-key: apk_...                    — AI agents
 *
 * Nothing about the actor comes from the request body or from headers other than the
 * credential itself. There is no `x-role` or `x-org` header anywhere in this codebase,
 * which is what makes a forged role claim impossible rather than merely rejected.
 */
export async function attachActor(request: FastifyRequest) {
  const agentKey = request.headers["x-agent-key"];
  if (typeof agentKey === "string" && agentKey.length > 0) {
    const resolved = resolveAgentToken(agentKey);
    if (resolved) {
      const actor = buildActorContext(resolved.identityId, resolved.organizationId);
      if (actor) request.actor = actor;
    }
    return;
  }

  const header = request.headers.authorization;
  if (typeof header === "string" && header.startsWith("Bearer ")) {
    const token = header.slice(7).trim();
    const actor = resolveActorFromToken(token);
    if (actor) request.actor = actor;
  }
}

/** Require any authenticated actor. Route handlers use `req.actor!` after this. */
export function requireActor(request: FastifyRequest): ActorContext {
  if (!request.actor) throw unauthorized("A valid session or agent credential is required.");
  if (request.actor.identityStatus !== "ACTIVE") {
    throw forbidden("IDENTITY_INACTIVE", `This identity is ${request.actor.identityStatus}.`);
  }
  return request.actor;
}

/** Require a human session specifically — used for approvals and admin governance,
 *  where an agent must never be the acting party even if it somehow held the capability. */
export function requireHuman(request: FastifyRequest): ActorContext {
  const actor = requireActor(request);
  if (actor.kind === "AGENT") {
    throw forbidden("HUMAN_REQUIRED", "This operation requires a human operator; agent credentials are not accepted.");
  }
  return actor;
}
