import { one, many, j } from "../db/clientV2.js";
import { authorize as runEngine } from "../authorization/engine.js";
import type { ScopeRecord } from "../authorization/scope.js";
import type { PolicyRecord } from "../authorization/policy.js";
import type {
  ActorContext, AuthorizationContext, AuthorizationResult, ResourceDescriptor,
} from "../authorization/types.js";
import { DENY_MESSAGES } from "../authorization/types.js";
import { windowStart } from "../core/time.js";
import { newTraceId } from "../core/ids.js";
import * as audit from "./auditService.js";
import { forbidden } from "../core/errors.js";
import { getCapability } from "../authorization/capabilities.js";

/**
 * The I/O half of authorization. It gathers the actor's scopes, the org's active
 * policy versions, rolling spend figures and emergency flags, hands them to the pure
 * engine, then writes the audit record.
 *
 * Every protected route calls `enforce()`. Nothing calls the engine directly except
 * the permission simulator, which needs a decision without an execution.
 */

export async function loadScopesForActor(actor: ActorContext): Promise<ScopeRecord[]> {
  if (actor.scopeIds.length === 0) return [];
  const placeholders = actor.scopeIds.map(() => "?").join(",");
  const rows = await many<any>(
    `SELECT * FROM scopes WHERE organization_id = ? AND id IN (${placeholders})`,
    actor.organizationId, ...actor.scopeIds,
  );
  return rows.map(toScopeRecord);
}

export function toScopeRecord(row: any): ScopeRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    scopeType: row.scope_type,
    selector: j.dec(row.selector_json, {}),
    constraints: j.dec(row.constraints_json, {}),
  };
}

export async function loadActivePolicies(organizationId: string): Promise<PolicyRecord[]> {
  const rows = await many<any>(
    `SELECT * FROM policies WHERE organization_id = ? AND status = 'ACTIVE' ORDER BY policy_key, version DESC`,
    organizationId,
  );
  // Defensive: if two versions of the same policy_key are somehow both ACTIVE, only
  // the highest version is used. A mis-click in the admin UI must not produce two
  // simultaneously-binding versions of one policy.
  const seen = new Set<string>();
  const out: PolicyRecord[] = [];
  for (const row of rows) {
    if (seen.has(row.policy_key)) continue;
    seen.add(row.policy_key);
    out.push(toPolicyRecord(row));
  }
  return out;
}

export function toPolicyRecord(row: any): PolicyRecord {
  return {
    id: row.id,
    policyKey: row.policy_key,
    organizationId: row.organization_id,
    name: row.name,
    version: row.version,
    status: row.status,
    conditions: j.dec(row.conditions_json, { rules: [] }),
    appliesTo: j.dec(row.applies_to_json, {}),
    hash: row.hash,
  };
}

export async function loadEmergencyFlags(organizationId: string): Promise<Record<string, boolean>> {
  const rows = await many<{ flag_key: string; enabled: number }>(
    `SELECT flag_key, enabled FROM emergency_flags WHERE organization_id = ?`,
    organizationId,
  );
  const out: Record<string, boolean> = {};
  for (const r of rows) out[r.flag_key] = !!r.enabled;
  return out;
}

/**
 * Rolling spend for velocity rules. Counts only intents that actually reached the
 * provider (EXECUTING or later) — a denied or still-pending intent has not consumed
 * budget, and counting it would let a burst of blocked requests lock out a legitimate one.
 */
export async function loadRollingSpend(
  organizationId: string,
  actorIdentityId: string,
  agentId: string | null,
  window: "1h" | "1d" | "7d" | "30d" = "1d",
): Promise<{ windowAmount: number; windowCount: number; window: "1h" | "1d" | "7d" | "30d" }> {
  const since = windowStart(window);
  const executedStates = "('EXECUTING','EXECUTED','SETTLED','RECONCILED')";
  const row = agentId
    ? await one<{ total: number; n: number }>(
        `SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS n FROM payment_intents
         WHERE organization_id = ? AND agent_id = ? AND state IN ${executedStates} AND created_at >= ?`,
        organizationId, agentId, since,
      )
    : await one<{ total: number; n: number }>(
        `SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS n FROM payment_intents
         WHERE organization_id = ? AND actor_identity_id = ? AND state IN ${executedStates} AND created_at >= ?`,
        organizationId, actorIdentityId, since,
      );
  return { windowAmount: Number(row?.total ?? 0), windowCount: Number(row?.n ?? 0), window };
}

export interface CheckParams {
  actor: ActorContext;
  action: string;
  resource: ResourceDescriptor;
  context?: AuthorizationContext;
  traceId?: string;
}

/** Evaluate without recording anything. Used by the permission simulator. */
export async function check(params: CheckParams): Promise<AuthorizationResult> {
  const { actor, action, resource } = params;
  const context: AuthorizationContext = { ...(params.context ?? {}) };

  if (context.amount !== undefined && context.spend === undefined) {
    context.spend = await loadRollingSpend(actor.organizationId, actor.identityId, actor.agent?.id ?? null, "1d");
  }

  return runEngine({
    actor,
    action,
    resource: { ...resource, organizationId: resource.organizationId ?? actor.organizationId },
    context,
    scopes: await loadScopesForActor(actor),
    policies: await loadActivePolicies(actor.organizationId),
    emergencyFlags: await loadEmergencyFlags(actor.organizationId),
    traceId: params.traceId ?? newTraceId(),
  });
}

export interface EnforceResult extends AuthorizationResult {
  auditEventId: string;
}

/**
 * Evaluate, audit, and throw on DENY.
 *
 * Denials are audited before the throw, not after — the audit record is the point of
 * a denial, and a `throw` that skipped it would make blocked attacks invisible. The
 * PRD requires both allow and deny decisions on protected operations to be recorded.
 */
export async function enforce(params: CheckParams & { ip?: string | null; payload?: Record<string, unknown> }): Promise<EnforceResult> {
  const result = await check(params);
  const cap = getCapability(params.action);

  const event = await audit.record({
    organizationId: params.actor.organizationId,
    traceId: result.traceId,
    actorId: params.actor.identityId,
    actorDid: params.actor.did,
    actorKind: params.actor.kind,
    action: params.action,
    resourceType: params.resource.type,
    resourceId: params.resource.id ?? null,
    decision: result.decision,
    reasonCodes: result.reasonCodes,
    policyId: result.policyId,
    policyVersion: result.policyVersion,
    ip: params.ip ?? null,
    payload: {
      ...(params.payload ?? {}),
      privileged: cap?.isPrivileged ?? true,
      matchedScopeId: result.matchedScopeId,
      evaluation: result.evaluation,
    },
  });

  if (result.decision === "DENY") {
    const primary = result.reasonCodes[0] ?? "POLICY_VIOLATION";
    throw forbidden(primary, DENY_MESSAGES[primary] ?? "This action is not permitted.", {
      traceId: result.traceId,
      reasonCodes: result.reasonCodes,
      evaluation: result.evaluation,
      auditEventId: event.id,
    });
  }

  return { ...result, auditEventId: event.id };
}

/**
 * Convenience for read endpoints: enforce a read capability without the amount/policy
 * machinery, but still with the full identity/membership/scope pipeline and an audit
 * record for non-trivial reads.
 */
export async function enforceRead(actor: ActorContext, action: string, resource: ResourceDescriptor, ip?: string | null) {
  return await enforce({ actor, action, resource, ip });
}
