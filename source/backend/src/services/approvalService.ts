import { one, many, run, tx, j } from "../db/clientV2.js";
import { newId } from "../core/ids.js";
import { nowIso } from "../core/time.js";
import { badRequest, conflict, forbidden, notFound } from "../core/errors.js";
import * as audit from "./auditService.js";
import type { ActorContext } from "../authorization/types.js";

/**
 * Approval service (SRD §12).
 *
 * Three properties the spec calls out, each enforced structurally rather than by
 * convention:
 *  - approver eligibility is itself authorization-controlled (the approver must hold
 *    the capability the pending request names, not merely "an approve button");
 *  - a requester cannot approve their own request;
 *  - a duplicate approval cannot produce a duplicate execution — the status transition
 *    is guarded inside the same transaction that records the decision, so two
 *    concurrent approvals cannot both observe PENDING and both proceed.
 */

export interface CreateApprovalInput {
  organizationId: string;
  requestType: "PAYMENT" | "ASSET_TRANSFER" | "ROLE_ASSIGN";
  requestId: string;
  requestedBy: string;
  reason: string;
  requiredCapability: string;
  evidence?: Record<string, unknown>;
  policyId?: string | null;
  policyVersion?: number | null;
  traceId: string;
}

export async function createApproval(input: CreateApprovalInput) {
  // The tenant predicate matters here even though request ids are globally unique: this
  // is the idempotency check, and without it the dedupe window spans organizations. A
  // lookup that can see another tenant's approval is a lookup that can return one.
  const existing = await one<any>(
    `SELECT * FROM approvals WHERE organization_id = ? AND request_type = ? AND request_id = ?`,
    input.organizationId, input.requestType, input.requestId,
  );
  // Idempotent: re-authorizing the same held request returns the same approval rather
  // than stacking duplicates in the reviewer's queue.
  if (existing) return existing;

  const id = newId("apr");
  await run(
    `INSERT INTO approvals (id, organization_id, request_type, request_id, requested_by, reason,
      required_capability, evidence_json, policy_id, policy_version, status, trace_id, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, input.organizationId, input.requestType, input.requestId, input.requestedBy,
    input.reason, input.requiredCapability, j.enc(input.evidence ?? {}),
    input.policyId ?? null, input.policyVersion ?? null, "PENDING", input.traceId, nowIso(),
  );
  return await one<any>(`SELECT * FROM approvals WHERE organization_id = ? AND id = ?`, input.organizationId, id)!;
}

export async function listApprovals(organizationId: string, opts: { status?: string; requestType?: string } = {}) {
  const where = ["a.organization_id = ?"];
  const params: unknown[] = [organizationId];
  if (opts.status) { where.push("a.status = ?"); params.push(opts.status); }
  if (opts.requestType) { where.push("a.request_type = ?"); params.push(opts.requestType); }
  return await many<any>(
    `SELECT a.*, r.display_name AS requester_name, r.did AS requester_did,
            ap.display_name AS approver_name
     FROM approvals a
     LEFT JOIN identities r ON r.id = a.requested_by
     LEFT JOIN identities ap ON ap.id = a.approver_id
     WHERE ${where.join(" AND ")} ORDER BY a.created_at DESC LIMIT 300`,
    ...params,
  );
}

export async function getApproval(organizationId: string, id: string) {
  return await one<any>(
    `SELECT a.*, r.display_name AS requester_name, r.did AS requester_did, ap.display_name AS approver_name
     FROM approvals a
     LEFT JOIN identities r ON r.id = a.requested_by
     LEFT JOIN identities ap ON ap.id = a.approver_id
     WHERE a.organization_id = ? AND a.id = ?`,
    organizationId, id,
  );
}

export async function pendingFor(organizationId: string, requestType: string, requestId: string) {
  return await one<any>(
    `SELECT * FROM approvals WHERE organization_id = ? AND request_type = ? AND request_id = ? AND status = 'PENDING'`,
    organizationId, requestType, requestId,
  );
}

export interface DecideResult { approval: any; alreadyDecided: boolean; }

/**
 * Record an approve/reject decision.
 *
 * The eligibility checks run before the transaction; the status guard runs inside it.
 * The UPDATE carries `AND status = 'PENDING'` in its WHERE clause and the affected-row
 * count is checked — that is what makes the double-approval race unwinnable rather
 * than merely unlikely.
 */
export async function decide(actor: ActorContext, approvalId: string, decision: "APPROVED" | "REJECTED", note: string): Promise<DecideResult>{
  const approval = await getApproval(actor.organizationId, approvalId);
  if (!approval) throw notFound("Approval request not found.");

  if (approval.status !== "PENDING") {
    return { approval, alreadyDecided: true };
  }
  if (approval.requested_by === actor.identityId) {
    throw forbidden("SELF_APPROVAL_FORBIDDEN", "You cannot approve a request you raised.");
  }
  if (!actor.capabilities.has(approval.required_capability)) {
    throw forbidden("CAPABILITY_MISSING", `Approving this request requires the ${approval.required_capability} capability.`);
  }

  let changed = 0;
  await tx(async () => {
    const result = await run(
      `UPDATE approvals SET status = ?, approver_id = ?, decision_note = ?, decided_at = ?
       WHERE id = ? AND status = 'PENDING'`,
      decision, actor.identityId, note, nowIso(), approvalId,
    );
    changed = result.changes;
  });

  if (changed === 0) {
    // Another approver won the race between our read and our write.
    return { approval: getApproval(actor.organizationId, approvalId)!, alreadyDecided: true };
  }

  audit.record({
    organizationId: actor.organizationId,
    traceId: approval.trace_id,
    actorId: actor.identityId,
    actorDid: actor.did,
    actorKind: actor.kind,
    action: decision === "APPROVED" ? "APPROVAL_GRANTED" : "APPROVAL_REJECTED",
    resourceType: approval.request_type,
    resourceId: approval.request_id,
    decision: decision === "APPROVED" ? "ALLOW" : "DENY",
    reasonCodes: [decision],
    approvalId,
    policyId: approval.policy_id,
    policyVersion: approval.policy_version,
    payload: { note, requiredCapability: approval.required_capability, requestedBy: approval.requested_by },
  });

  return { approval: getApproval(actor.organizationId, approvalId)!, alreadyDecided: false };
}

export async function toApi(row: any) {
  return {
    id: row.id, requestType: row.request_type, requestId: row.request_id,
    requestedBy: row.requested_by, requesterName: row.requester_name ?? null, requesterDid: row.requester_did ?? null,
    reason: row.reason, requiredCapability: row.required_capability,
    evidence: j.dec(row.evidence_json, {}),
    policyId: row.policy_id, policyVersion: row.policy_version,
    status: row.status, approverId: row.approver_id, approverName: row.approver_name ?? null,
    decisionNote: row.decision_note, decidedAt: row.decided_at,
    traceId: row.trace_id, createdAt: row.created_at,
  };
}
