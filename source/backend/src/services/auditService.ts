import { one, many, run, j } from "../db/clientV2.js";
import { newId } from "../core/ids.js";
import { nowIso } from "../core/time.js";
import { hashObject, canonicalStringify, sha256Hex } from "../core/hash.js";

/**
 * Canonical audit service (SRD §13).
 *
 * The baseline hash-chained audit events *per payment intent*. That left a real hole:
 * deleting an intent's entire event group broke nothing, because each group was its
 * own independent chain with its own genesis. Here the chain is per *organization* —
 * every event links to the previous event in the org regardless of what it was about —
 * so removing any row, or any contiguous block of rows, breaks the chain from that
 * point forward and `verifyChain` reports exactly where.
 *
 * What this does and does not prove: it makes tampering with recorded history
 * *detectable*, and combined with the on-chain anchor in proofService it makes it
 * detectable by someone who does not trust this database at all. It does not prove
 * the recorded events were themselves correct — only that they have not changed since
 * they were written.
 */

export type AuditDecision = "ALLOW" | "DENY" | "REQUIRE_APPROVAL" | "EXECUTED" | "FAILED" | "INFO";

export interface AuditInput {
  organizationId: string;
  traceId: string;
  actorId?: string | null;
  actorDid?: string | null;
  actorKind?: string;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  decision: AuditDecision;
  reasonCodes?: string[];
  policyId?: string | null;
  policyVersion?: number | null;
  approvalId?: string | null;
  executionRef?: string | null;
  payload?: Record<string, unknown>;
  ip?: string | null;
}

export interface AuditEventRow {
  id: string;
  organization_id: string;
  seq: number;
  trace_id: string;
  actor_id: string | null;
  actor_did: string | null;
  actor_kind: string;
  action: string;
  resource_type: string;
  resource_id: string | null;
  decision: string;
  reason_codes: string;
  policy_id: string | null;
  policy_version: number | null;
  approval_id: string | null;
  execution_ref: string | null;
  payload_json: string;
  payload_hash: string;
  prev_event_hash: string;
  event_hash: string;
  ip: string | null;
  timestamp: string;
}

export const GENESIS_HASH = "sha256:genesis";

/**
 * Event hash covers the sequence number and the previous hash as well as the content.
 * Including `seq` is what stops a deleted event from being covered up by renumbering:
 * a forger would have to recompute every subsequent hash, and the last hash is the one
 * anchored on-chain.
 */
export function computeEventHash(input: {
  seq: number; organizationId: string; traceId: string; action: string;
  resourceType: string; resourceId: string | null; decision: string;
  actorId: string | null; payloadHash: string; timestamp: string; prevEventHash: string;
}): string {
  return `sha256:${sha256Hex(canonicalStringify(input))}`;
}

export async function record(input: AuditInput): Promise<AuditEventRow> {
  const last = await one<{ seq: number; event_hash: string }>(
    `SELECT seq, event_hash FROM audit_events WHERE organization_id = ? ORDER BY seq DESC LIMIT 1`,
    input.organizationId,
  );
  const seq = (last?.seq ?? -1) + 1;
  const prevEventHash = last?.event_hash ?? GENESIS_HASH;
  const timestamp = nowIso();
  const payload = input.payload ?? {};
  const payloadHash = hashObject(payload);

  const eventHash = computeEventHash({
    seq,
    organizationId: input.organizationId,
    traceId: input.traceId,
    action: input.action,
    resourceType: input.resourceType,
    resourceId: input.resourceId ?? null,
    decision: input.decision,
    actorId: input.actorId ?? null,
    payloadHash,
    timestamp,
    prevEventHash,
  });

  const id = newId("aud");
  await run(
    `INSERT INTO audit_events
      (id, organization_id, seq, trace_id, actor_id, actor_did, actor_kind, action,
       resource_type, resource_id, decision, reason_codes, policy_id, policy_version,
       approval_id, execution_ref, payload_json, payload_hash, prev_event_hash, event_hash, ip, timestamp)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, input.organizationId, seq, input.traceId, input.actorId ?? null, input.actorDid ?? null,
    input.actorKind ?? "HUMAN", input.action, input.resourceType, input.resourceId ?? null,
    input.decision, j.enc(input.reasonCodes ?? []), input.policyId ?? null, input.policyVersion ?? null,
    input.approvalId ?? null, input.executionRef ?? null, j.enc(payload), payloadHash,
    prevEventHash, eventHash, input.ip ?? null, timestamp,
  );

  return (await one<AuditEventRow>(
    `SELECT * FROM audit_events WHERE organization_id = ? AND id = ?`,
    input.organizationId, id,
  ))!;
}

export interface ChainVerification {
  valid: boolean;
  eventCount: number;
  brokenAtSeq: number | null;
  reason: string | null;
  headHash: string | null;
}

/**
 * Recompute the whole chain from genesis and report the first divergence. Called by
 * the Audit UI on every load and by `GET /api/audit/verify-chain`.
 */
export async function verifyChain(organizationId: string): Promise<ChainVerification> {
  const events = await many<AuditEventRow>(
    `SELECT * FROM audit_events WHERE organization_id = ? ORDER BY seq ASC`,
    organizationId,
  );
  if (events.length === 0) {
    return { valid: true, eventCount: 0, brokenAtSeq: null, reason: null, headHash: null };
  }

  let expectedPrev = GENESIS_HASH;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];

    if (e.seq !== i) {
      return { valid: false, eventCount: events.length, brokenAtSeq: i, headHash: null,
        reason: `Sequence gap: expected #${i}, found #${e.seq}. An event was deleted or renumbered.` };
    }
    if (e.prev_event_hash !== expectedPrev) {
      return { valid: false, eventCount: events.length, brokenAtSeq: e.seq, headHash: null,
        reason: `Event #${e.seq} does not link to the previous event's hash.` };
    }

    // Recompute the payload hash too — otherwise editing payload_json and its stored
    // payload_hash together would slip past a link-only check.
    const recomputedPayloadHash = hashObject(j.dec<Record<string, unknown>>(e.payload_json, {}));
    if (recomputedPayloadHash !== e.payload_hash) {
      return { valid: false, eventCount: events.length, brokenAtSeq: e.seq, headHash: null,
        reason: `Event #${e.seq} payload does not match its recorded payload hash.` };
    }

    const recomputed = computeEventHash({
      seq: e.seq, organizationId: e.organization_id, traceId: e.trace_id, action: e.action,
      resourceType: e.resource_type, resourceId: e.resource_id, decision: e.decision,
      actorId: e.actor_id, payloadHash: e.payload_hash, timestamp: e.timestamp,
      prevEventHash: e.prev_event_hash,
    });
    if (recomputed !== e.event_hash) {
      return { valid: false, eventCount: events.length, brokenAtSeq: e.seq, headHash: null,
        reason: `Event #${e.seq} content does not match its recorded hash.` };
    }
    expectedPrev = e.event_hash;
  }

  return { valid: true, eventCount: events.length, brokenAtSeq: null, reason: null, headHash: expectedPrev };
}

export interface AuditQuery {
  organizationId: string;
  actorId?: string;
  action?: string;
  resourceType?: string;
  resourceId?: string;
  decision?: string;
  traceId?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export async function query(q: AuditQuery): Promise<{ events: AuditEventRow[]; total: number }> {
  const where: string[] = ["organization_id = ?"];
  const params: unknown[] = [q.organizationId];
  const add = (clause: string, value: unknown) => {
    if (value !== undefined && value !== null && value !== "") { where.push(clause); params.push(value); }
  };
  add("actor_id = ?", q.actorId);
  add("action = ?", q.action);
  add("resource_type = ?", q.resourceType);
  add("resource_id = ?", q.resourceId);
  add("decision = ?", q.decision);
  add("trace_id = ?", q.traceId);
  add("timestamp >= ?", q.from);
  add("timestamp <= ?", q.to);

  const clause = where.join(" AND ");
  const total = (await one<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_events WHERE ${clause}`, ...params))?.n ?? 0;
  const limit = Math.min(q.limit ?? 50, 500);
  const offset = q.offset ?? 0;
  const events = await many<AuditEventRow>(
    `SELECT * FROM audit_events WHERE ${clause} ORDER BY seq DESC LIMIT ? OFFSET ?`,
    ...params, limit, offset,
  );
  return { events, total };
}

export async function byId(organizationId: string, id: string): Promise<AuditEventRow | null> {
  return await one<AuditEventRow>(`SELECT * FROM audit_events WHERE organization_id = ? AND id = ?`, organizationId, id);
}

export async function byTrace(organizationId: string, traceId: string): Promise<AuditEventRow[]> {
  return await many<AuditEventRow>(
    `SELECT * FROM audit_events WHERE organization_id = ? AND trace_id = ? ORDER BY seq ASC`,
    organizationId, traceId,
  );
}

export function toApi(e: AuditEventRow) {
  return {
    id: e.id, seq: e.seq, traceId: e.trace_id,
    actorId: e.actor_id, actorDid: e.actor_did, actorKind: e.actor_kind,
    action: e.action, resourceType: e.resource_type, resourceId: e.resource_id,
    decision: e.decision, reasonCodes: j.dec<string[]>(e.reason_codes, []),
    policyId: e.policy_id, policyVersion: e.policy_version,
    approvalId: e.approval_id, executionRef: e.execution_ref,
    payload: j.dec<Record<string, unknown>>(e.payload_json, {}),
    payloadHash: e.payload_hash, prevEventHash: e.prev_event_hash, eventHash: e.event_hash,
    timestamp: e.timestamp,
  };
}
