import { one, many, run, tx, j } from "../db/clientV2.js";
import { newId } from "../core/ids.js";
import { nowIso } from "../core/time.js";
import { randomHex, sha256Hex, hashObject } from "../core/hash.js";
import { didCommitment } from "../auth/did.js";
import { getBlockchainAdapter } from "../adapters/blockchain/index.js";
import { capabilityId, isKnownCapability } from "../authorization/capabilities.js";
import { badRequest, conflict, notFound } from "../core/errors.js";
import { createIdentity, revokeAllSessionsFor } from "./identityService.js";
import { ALLOWED_TOOLS } from "./toolRegistry.js";
import type { ActorContext, AgentLimits } from "../authorization/types.js";

/**
 * AI agent management (PRD §5.6).
 *
 * An agent is an identity with kind='AGENT' plus a grant set. It authenticates with a
 * bearer token and then travels the *same* authorization pipeline as a human — there
 * is no agent-specific bypass anywhere in the codebase.
 *
 * Two containment layers that are deliberately separate:
 *   capabilities — what the agent may cause to happen
 *   tools        — which callable surface it may reach
 * An agent holding PAYMENT_CREATE but without `create_payment_intent` allowlisted is
 * still denied. Keeping them independent means a compromised agent credential cannot
 * reach a tool merely because a capability was over-granted somewhere.
 */

export interface RegisterAgentInput {
  name: string;
  ownerIdentityId?: string | null;
  departmentId?: string | null;
  capabilities?: string[];
  scopeIds?: string[];
  tools?: string[];
  limits?: AgentLimits;
}

export async function listAgents(organizationId: string) {
  const rows = await many<any>(
    `SELECT a.*, i.did, i.status AS identity_status, d.name AS department_name, o.display_name AS owner_name
     FROM agents a
     JOIN identities i ON i.id = a.identity_id
     LEFT JOIN departments d ON d.id = a.department_id
     LEFT JOIN identities o ON o.id = a.owner_identity_id
     WHERE a.organization_id = ? ORDER BY a.created_at DESC`,
    organizationId,
  );
  return rows.map((r) => ({ ...r, capabilities: agentCapabilities(r.id), tools: agentTools(r.id), scopeIds: agentScopeIds(r.id) }));
}

export async function getAgent(organizationId: string, id: string) {
  const row = await one<any>(
    `SELECT a.*, i.did, i.status AS identity_status, d.name AS department_name, o.display_name AS owner_name
     FROM agents a
     JOIN identities i ON i.id = a.identity_id
     LEFT JOIN departments d ON d.id = a.department_id
     LEFT JOIN identities o ON o.id = a.owner_identity_id
     WHERE a.organization_id = ? AND a.id = ?`,
    organizationId, id,
  );
  if (!row) return null;
  return { ...row, capabilities: agentCapabilities(id), tools: agentTools(id), scopeIds: agentScopeIds(id) };
}

export async function agentCapabilities(agentId: string): Promise<string[]>{
  return (await many<{ action: string }>(
    `SELECT c.action FROM capabilities c JOIN agent_capabilities ac ON ac.capability_id = c.id WHERE ac.agent_id = ? ORDER BY c.action`,
    agentId,
  )).map((r: any) => r.action);
}

export async function agentTools(agentId: string): Promise<string[]>{
  return (await many<{ tool_name: string }>(`SELECT tool_name FROM agent_tools WHERE agent_id = ? ORDER BY tool_name`, agentId)).map((r: any) => r.tool_name);
}

export async function agentScopeIds(agentId: string): Promise<string[]>{
  return (await many<{ scope_id: string }>(`SELECT scope_id FROM agent_scopes WHERE agent_id = ?`, agentId)).map((r: any) => r.scope_id);
}

export async function registerAgent(actor: ActorContext, input: RegisterAgentInput) {
  if (await one(`SELECT id FROM agents WHERE organization_id = ? AND name = ?`, actor.organizationId, input.name)) {
    throw conflict("AGENT_EXISTS", `An agent named "${input.name}" already exists.`);
  }
  validateGrants(input.capabilities ?? [], input.tools ?? []);

  // The agent gets its own DID and its own identity row. Reusing a human's identity
  // would make it impossible to attribute an action to the agent rather than its owner.
  const { identity } = await createIdentity({
    organizationId: actor.organizationId,
    displayName: input.name,
    kind: "AGENT",
    departmentId: input.departmentId ?? null,
    status: "ACTIVE",
  });

  const agentId = newId("agent");
  const token = `apk_${randomHex(24)}`;
  const ts = nowIso();
  const limits = input.limits ?? {};

  await tx(async () => {
    await run(
      `INSERT INTO agents (id, organization_id, identity_id, name, owner_identity_id, department_id, status, limits_json, token_hash, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      agentId, actor.organizationId, identity.id, input.name,
      input.ownerIdentityId ?? actor.identityId, input.departmentId ?? null,
      "ACTIVE", j.enc(limits), sha256Hex(token), ts, ts,
    );
    for (const action of input.capabilities ?? []) {
      await run(`INSERT INTO agent_capabilities (agent_id, capability_id) VALUES (?,?) ON CONFLICT DO NOTHING`, agentId, capabilityId(action));
    }
    for (const scopeId of input.scopeIds ?? []) {
      await run(`INSERT INTO agent_scopes (agent_id, scope_id) VALUES (?,?) ON CONFLICT DO NOTHING`, agentId, scopeId);
    }
    for (const tool of input.tools ?? []) {
      await run(`INSERT INTO agent_tools (agent_id, tool_name) VALUES (?,?) ON CONFLICT DO NOTHING`, agentId, tool);
    }
  });

  // Anchor the agent's DID and its grant-set commitment. The commitment lets an auditor
  // detect that an agent's permissions changed even if the database says otherwise.
  let chainTx: string | null = null;
  try {
    const receipt = await getBlockchainAdapter().registerAgent({
      agentCommitment: didCommitment(agentId),
      didCommitment: didCommitment(identity.did),
      policyCommitment: "0x" + hashObject({ capabilities: input.capabilities ?? [], limits }).replace(/^sha256:/, ""),
    });
    chainTx = receipt.txHash;
    await run(`UPDATE agents SET chain_tx_hash = ? WHERE id = ?`, chainTx, agentId);
  } catch { /* registration succeeds regardless; the chain write is retryable from the UI */ }

  // The token is returned exactly once and only its hash is stored.
  return { agent: getAgent(actor.organizationId, agentId)!, token };
}

async function validateGrants(capabilities: string[], tools: string[]) {
  const unknownCaps = capabilities.filter((c) => !isKnownCapability(c));
  if (unknownCaps.length) throw badRequest("CAPABILITY_UNKNOWN", `Unknown capabilities: ${unknownCaps.join(", ")}`);
  const unknownTools = tools.filter((t) => !ALLOWED_TOOLS.includes(t));
  if (unknownTools.length) throw badRequest("TOOL_UNKNOWN", `Unknown tools: ${unknownTools.join(", ")}. Known: ${ALLOWED_TOOLS.join(", ")}`);
}

export async function configureAgent(organizationId: string, agentId: string, patch: {
  capabilities?: string[]; scopeIds?: string[]; tools?: string[]; limits?: AgentLimits; departmentId?: string | null;
}) {
  const agent = await getAgent(organizationId, agentId);
  if (!agent) throw notFound("Agent not found.");
  validateGrants(patch.capabilities ?? [], patch.tools ?? []);

  await tx(async () => {
    if (patch.capabilities) {
      await run(`DELETE FROM agent_capabilities WHERE agent_id = ?`, agentId);
      for (const a of patch.capabilities) await run(`INSERT INTO agent_capabilities (agent_id, capability_id) VALUES (?,?) ON CONFLICT DO NOTHING`, agentId, capabilityId(a));
    }
    if (patch.scopeIds) {
      await run(`DELETE FROM agent_scopes WHERE agent_id = ?`, agentId);
      for (const s of patch.scopeIds) await run(`INSERT INTO agent_scopes (agent_id, scope_id) VALUES (?,?) ON CONFLICT DO NOTHING`, agentId, s);
    }
    if (patch.tools) {
      await run(`DELETE FROM agent_tools WHERE agent_id = ?`, agentId);
      for (const t of patch.tools) await run(`INSERT INTO agent_tools (agent_id, tool_name) VALUES (?,?) ON CONFLICT DO NOTHING`, agentId, t);
    }
    if (patch.limits) await run(`UPDATE agents SET limits_json = ? WHERE id = ?`, j.enc(patch.limits), agentId);
    if (patch.departmentId !== undefined) await run(`UPDATE agents SET department_id = ? WHERE id = ?`, patch.departmentId, agentId);
    await run(`UPDATE agents SET updated_at = ? WHERE id = ?`, nowIso(), agentId);
  });

  return getAgent(organizationId, agentId)!;
}

/**
 * Freeze. Takes effect on the very next request: `resolveActorFromToken` reads agent
 * status live from the database, and the engine's agent-state gate runs before any
 * policy is loaded. Sessions are revoked too, so an in-flight session cannot outlive
 * the freeze.
 */
export async function setAgentStatus(organizationId: string, agentId: string, status: "ACTIVE" | "FROZEN" | "REVOKED", actorId: string, reason: string) {
  const agent = await getAgent(organizationId, agentId);
  if (!agent) throw notFound("Agent not found.");
  if ((await agent).status === "REVOKED") throw badRequest("AGENT_REVOKED", "A revoked agent cannot be reactivated.");

  const ts = nowIso();
  await tx(async () => {
    await run(`UPDATE agents SET status = ?, freeze_reason = ?, frozen_by = ?, frozen_at = ?, updated_at = ? WHERE id = ?`,
      status, status === "ACTIVE" ? null : reason, status === "ACTIVE" ? null : actorId,
      status === "ACTIVE" ? null : ts, ts, agentId);
    if (status === "REVOKED") {
      // Revocation is terminal: the underlying identity dies with the agent, so the
      // credential stops resolving at the door.
      await run(`UPDATE identities SET status = await 'REVOKED', updated_at = ? WHERE id = ?`, ts, (await agent).identity_id);
      revokeAllSessionsFor((await agent).identity_id);
    } else if (status === "FROZEN") {
      // A freeze deliberately leaves the identity ACTIVE. The credential still resolves,
      // so the authorization engine gets to run and record an explicit AGENT_FROZEN
      // denial against the attempted action. Suspending the identity instead would block
      // the call one layer earlier and leave the audit trail saying only "inactive
      // identity" — losing which tool the frozen agent reached for, which is exactly the
      // forensic detail an incident review needs.
      revokeAllSessionsFor((await agent).identity_id);
    } else {
      await run(`UPDATE identities SET status = 'ACTIVE', updated_at = ? WHERE id = ?`, ts, (await agent).identity_id);
    }
  });

  try {
    await getBlockchainAdapter().setAgentActive(didCommitment(agentId), status === "ACTIVE");
  } catch { /* the local status change is authoritative for enforcement; chain state is a mirror */ }

  return getAgent(organizationId, agentId)!;
}

/** Resolve an agent bearer token to its identity. Constant-work lookup on the hash. */
export async function resolveAgentToken(token: string): Promise<{ agentId: string; identityId: string; organizationId: string; } | null> {
  const row = await one<any>(`SELECT id, identity_id, organization_id, status FROM agents WHERE token_hash = ?`, sha256Hex(token));
  if (!row) return null;
  return { agentId: row.id, identityId: row.identity_id, organizationId: row.organization_id };
}

export async function rotateToken(organizationId: string, agentId: string) {
  const agent = await getAgent(organizationId, agentId);
  if (!agent) throw notFound("Agent not found.");
  const token = `apk_${randomHex(24)}`;
  await run(`UPDATE agents SET token_hash = ?, updated_at = ? WHERE id = ?`, sha256Hex(token), nowIso(), agentId);
  return { token };
}

export async function toolCallHistory(agentId: string, limit = 100) {
  return await many<any>(`SELECT * FROM agent_tool_calls WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?`, agentId, limit);
}

export async function toApi(row: any) {
  return {
    id: row.id, name: row.name, did: row.did, status: row.status,
    identityId: row.identity_id, identityStatus: row.identity_status,
    ownerIdentityId: row.owner_identity_id, ownerName: row.owner_name ?? null,
    departmentId: row.department_id, departmentName: row.department_name ?? null,
    limits: j.dec<AgentLimits>(row.limits_json, {}),
    capabilities: row.capabilities ?? [], tools: row.tools ?? [], scopeIds: row.scopeIds ?? [],
    freezeReason: row.freeze_reason, frozenBy: row.frozen_by, frozenAt: row.frozen_at,
    chainTxHash: row.chain_tx_hash, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}
