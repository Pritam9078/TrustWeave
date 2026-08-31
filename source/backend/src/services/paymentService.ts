import { one, many, run, tx, j } from "../db/clientV2.js";
import { newId, newTraceId } from "../core/ids.js";
import { nowIso } from "../core/time.js";
import { hashObject, sha256Hex } from "../core/hash.js";
import { badRequest, conflict, notFound, unprocessable } from "../core/errors.js";
import { getRazorpayAdapter } from "../adapters/razorpay/index.js";
import * as authz from "./authorizationService.js";
import * as approvalService from "./approvalService.js";
import * as audit from "./auditService.js";
import * as proofService from "./proofService.js";
import * as orgService from "./orgService.js";
import type { ActorContext } from "../authorization/types.js";

/**
 * PayIntent state machine (SRD §11).
 *
 * DRAFT → AUTHORIZING → (DENIED | AWAITING_APPROVAL | AUTHORIZED)
 *       AWAITING_APPROVAL → (AUTHORIZED | DENIED)
 *       AUTHORIZED → EXECUTING → (EXECUTED → RECONCILED | FAILED)
 *
 * The rule that shapes everything below: **no client value is trusted**. The amount,
 * merchant and currency used for authorization and for the provider call are read from
 * the server's own row, never from the request that triggers execution. A client that
 * creates a ₹1,000 intent and then calls execute with `amount: 1` changes nothing —
 * `execute` does not accept an amount at all.
 */

export type PaymentState =
  | "DRAFT" | "AUTHORIZING" | "DENIED" | "AWAITING_APPROVAL"
  | "AUTHORIZED" | "EXECUTING" | "EXECUTED" | "RECONCILED" | "FAILED";

const TERMINAL: PaymentState[] = ["DENIED", "RECONCILED", "FAILED"];

export interface CreateIntentInput {
  merchant: string;
  amount: number;
  currency?: string;
  purpose?: string;
  invoiceRef?: string | null;
  departmentId?: string | null;
  evidence?: string[];
  rawRequest?: string | null;
  agentId?: string | null;
  idempotencyKey?: string | null;
}

export async function getIntent(organizationId: string, id: string) {
  return await one<any>(
    `SELECT p.*, i.display_name AS actor_name, i.did AS actor_did, ag.name AS agent_name, d.name AS department_name
     FROM payment_intents p
     LEFT JOIN identities i ON i.id = p.actor_identity_id
     LEFT JOIN agents ag ON ag.id = p.agent_id
     LEFT JOIN departments d ON d.id = p.department_id
     WHERE p.organization_id = ? AND p.id = ?`,
    organizationId, id,
  );
}

export async function listIntents(organizationId: string, opts: { state?: string; agentId?: string; actorId?: string; limit?: number } = {}) {
  const where = ["p.organization_id = ?"];
  const params: unknown[] = [organizationId];
  if (opts.state) { where.push("p.state = ?"); params.push(opts.state); }
  if (opts.agentId) { where.push("p.agent_id = ?"); params.push(opts.agentId); }
  if (opts.actorId) { where.push("p.actor_identity_id = ?"); params.push(opts.actorId); }
  return await many<any>(
    `SELECT p.*, i.display_name AS actor_name, i.did AS actor_did, ag.name AS agent_name, d.name AS department_name
     FROM payment_intents p
     LEFT JOIN identities i ON i.id = p.actor_identity_id
     LEFT JOIN agents ag ON ag.id = p.agent_id
     LEFT JOIN departments d ON d.id = p.department_id
     WHERE ${where.join(" AND ")} ORDER BY p.created_at DESC LIMIT ?`,
    ...params, opts.limit ?? 200,
  );
}

/**
 * Create a DRAFT intent. Creation is idempotent on an optional client key — the
 * baseline's "double-click creates two intents" gap. Without a key we derive one from
 * (actor, merchant, amount, invoice, minute), which collapses accidental resubmits
 * while still allowing a genuine second identical payment a minute later.
 */
export async function createIntent(actor: ActorContext, input: CreateIntentInput) {
  if (!Number.isFinite(input.amount) || input.amount <= 0) {
    throw badRequest("INVALID_AMOUNT", "Amount must be a positive number.");
  }
  const currency = (input.currency ?? "INR").toUpperCase();
  const minuteBucket = new Date().toISOString().slice(0, 16);
  const idempotencyKey = input.idempotencyKey
    ?? sha256Hex(`${actor.identityId}:${input.merchant}:${input.amount}:${input.invoiceRef ?? ""}:${minuteBucket}`);

  // Idempotency keys are namespaced per organization, matching how payment providers
  // scope them. A globally unique key would mean one tenant's client-chosen key could
  // collide with another's — turning a routine retry into either a cross-tenant read or
  // a spurious conflict, neither of which the caller could explain.
  const existing = await one<any>(
    `SELECT * FROM payment_intents WHERE organization_id = ? AND idempotency_key = ?`,
    actor.organizationId, idempotencyKey,
  );
  if (existing) {
    return { intent: await getIntent(actor.organizationId, existing.id)!, deduplicated: true };
  }

  const id = newId("pi");
  const traceId = newTraceId();
  const ts = nowIso();

  await run(
    `INSERT INTO payment_intents (id, organization_id, actor_identity_id, agent_id, department_id, raw_request,
      merchant, amount, currency, purpose, invoice_ref, evidence_json, state, idempotency_key, trace_id, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, actor.organizationId, actor.identityId, input.agentId ?? actor.agent?.id ?? null,
    input.departmentId ?? actor.departmentId ?? null, input.rawRequest ?? null,
    input.merchant, input.amount, currency, input.purpose ?? "", input.invoiceRef ?? null,
    j.enc(input.evidence ?? []), "DRAFT", idempotencyKey, traceId, ts, ts,
  );

  await audit.record({
    organizationId: actor.organizationId, traceId,
    actorId: actor.identityId, actorDid: actor.did, actorKind: actor.kind,
    action: "PAYMENT_INTENT_CREATED", resourceType: "PAYMENT", resourceId: id,
    decision: "INFO",
    payload: { merchant: input.merchant, amount: input.amount, currency, invoiceRef: input.invoiceRef ?? null },
  });

  return { intent: await getIntent(actor.organizationId, id)!, deduplicated: false };
}

/**
 * Authorize a DRAFT intent.
 *
 * Note the amount handed to the engine comes from `intent.amount` (the stored row),
 * not from any caller-supplied field. This function takes no amount parameter, so
 * there is no way to authorize one figure and execute another.
 */
export async function authorizeIntent(actor: ActorContext, intentId: string, ip?: string | null) {
  const intent = await getIntent(actor.organizationId, intentId);
  if (!intent) throw notFound("Payment intent not found.");
  if (TERMINAL.includes(intent.state)) throw unprocessable("TERMINAL_STATE", `This intent is already ${intent.state}.`);
  if (["AUTHORIZED", "EXECUTING", "EXECUTED"].includes(intent.state)) {
    return { intent, decision: intent.decision, alreadyAuthorized: true, evaluation: [] as any[], approval: null };
  }

  await run(`UPDATE payment_intents SET state = 'AUTHORIZING', updated_at = ? WHERE id = ?`, nowIso(), intentId);

  const evidence = j.dec<string[]>(intent.evidence_json, []);
  const result = await authz.check({
    actor,
    action: "PAYMENT_CREATE",
    resource: {
      type: "PAYMENT", id: intentId,
      organizationId: intent.organization_id,
      departmentId: intent.department_id,
      vendor: intent.merchant,
    },
    context: {
      amount: intent.amount,
      currency: intent.currency,
      merchant: intent.merchant,
      evidenceCount: evidence.length,
    },
    traceId: intent.trace_id,
  });

  const auditEvent = await audit.record({
    organizationId: actor.organizationId, traceId: intent.trace_id,
    actorId: actor.identityId, actorDid: actor.did, actorKind: actor.kind,
    action: "PAYMENT_AUTHORIZE", resourceType: "PAYMENT", resourceId: intentId,
    decision: result.decision, reasonCodes: result.reasonCodes,
    policyId: result.policyId, policyVersion: result.policyVersion, ip: ip ?? null,
    payload: {
      merchant: intent.merchant, amount: intent.amount, currency: intent.currency,
      evaluation: result.evaluation, matchedScopeId: result.matchedScopeId,
    },
  });

  let approval: any = null;
  let nextState: PaymentState;

  if (result.decision === "DENY") {
    nextState = "DENIED";
  } else if (result.decision === "REQUIRE_APPROVAL") {
    nextState = "AWAITING_APPROVAL";
    approval = await approvalService.createApproval({
      organizationId: actor.organizationId,
      requestType: "PAYMENT", requestId: intentId,
      requestedBy: actor.identityId,
      reason: result.evaluation.filter((e) => e.outcome === "HOLD").map((e) => e.detail).join(" ") || "Above the approval threshold.",
      requiredCapability: "PAYMENT_APPROVE",
      evidence: { merchant: intent.merchant, amount: intent.amount, currency: intent.currency, invoiceRef: intent.invoice_ref, evidenceIds: evidence },
      policyId: result.policyId, policyVersion: result.policyVersion,
      traceId: intent.trace_id,
    });
  } else {
    nextState = "AUTHORIZED";
  }

  await run(
    `UPDATE payment_intents SET state = ?, decision = ?, reason_codes = ?, policy_id = ?, policy_version = ?, approval_id = ?, updated_at = ? WHERE id = ?`,
    nextState, result.decision, j.enc(result.reasonCodes), result.policyId, result.policyVersion,
    approval?.id ?? null, nowIso(), intentId,
  );

  if (result.decision === "DENY") {
    orgService.recordSecurityEvent({
      organizationId: actor.organizationId,
      kind: "PAYMENT_DENIED", severity: actor.kind === "AGENT" ? "HIGH" : "MEDIUM",
      actorId: actor.identityId,
      summary: `Payment of ${intent.currency} ${intent.amount} to ${intent.merchant} was denied (${result.reasonCodes.join(", ")}).`,
      detail: { intentId, reasonCodes: result.reasonCodes },
    });
  }

  return {
    intent: await getIntent(actor.organizationId, intentId)!,
    decision: result.decision,
    reasonCodes: result.reasonCodes,
    evaluation: result.evaluation,
    approval: approval ? approvalService.toApi(approval) : null,
    auditEventId: auditEvent.id,
    alreadyAuthorized: false,
  };
}

/** Called after an approval decision, to move the intent forward or close it. */
export async function applyApprovalOutcome(organizationId: string, intentId: string, approved: boolean) {
  const intent = await getIntent(organizationId, intentId);
  if (!intent) throw notFound("Payment intent not found.");
  if (intent.state !== "AWAITING_APPROVAL") return intent;
  await run(`UPDATE payment_intents SET state = ?, updated_at = ? WHERE id = ?`,
    approved ? "AUTHORIZED" : "DENIED", nowIso(), intentId);
  return await getIntent(organizationId, intentId)!;
}

/**
 * Execute an AUTHORIZED intent.
 *
 * Re-checks authorization immediately before calling the provider. That second check
 * is not redundant: an agent can be frozen, a policy superseded or an emergency switch
 * flipped between authorization and execution, and without it a stale AUTHORIZED row
 * would still be spendable.
 */
export async function executeIntent(actor: ActorContext, intentId: string, ip?: string | null) {
  const intent = await getIntent(actor.organizationId, intentId);
  if (!intent) throw notFound("Payment intent not found.");

  // Idempotent replay: a repeated execute returns the existing execution rather than
  // creating a second provider order.
  if (["EXECUTING", "EXECUTED", "RECONCILED"].includes(intent.state)) {
    return { intent, replayed: true, order: { id: intent.provider_order_id } };
  }
  if (intent.state !== "AUTHORIZED") {
    throw unprocessable("NOT_AUTHORIZED", `Intent is ${intent.state}; only AUTHORIZED intents can execute.`);
  }
  if (intent.approval_id) {
    const approval = await one<any>(
      `SELECT * FROM approvals WHERE organization_id = ? AND id = ?`,
      intent.organization_id, intent.approval_id,
    );
    if (approval && approval.status !== "APPROVED") {
      throw unprocessable("APPROVAL_PENDING", "The linked approval has not been granted.");
    }
  }

  await authz.enforce({
    actor, action: "PAYMENT_EXECUTE",
    resource: { type: "PAYMENT", id: intentId, organizationId: intent.organization_id, departmentId: intent.department_id, vendor: intent.merchant },
    context: { amount: intent.amount, currency: intent.currency, merchant: intent.merchant },
    traceId: intent.trace_id, ip,
    payload: { stage: "pre-execution re-check" },
  });

  await run(`UPDATE payment_intents SET state = 'EXECUTING', updated_at = ? WHERE id = ?`, nowIso(), intentId);

  const razorpay = getRazorpayAdapter();
  try {
    const order = await razorpay.createOrder({
      // Minor units, computed server-side from the stored amount.
      amountMinor: Math.round(intent.amount * 100),
      currency: intent.currency,
      receipt: intentId,
      notes: { intentId, invoiceRef: intent.invoice_ref ?? "", merchant: intent.merchant },
      idempotencyKey: intent.idempotency_key,
    });

    // Record which adapter actually executed this. Without it, a payment created against
    // the deterministic local provider is indistinguishable from one that moved real
    // money — and the whole point of the test adapter is that no money moved.
    await run(`UPDATE payment_intents SET provider_order_id = ?, provider_state = ?, provider_adapter = ?, state = 'EXECUTED', updated_at = ? WHERE id = ?`,
      order.id, order.status, razorpay.kind, nowIso(), intentId);

    await audit.record({
      organizationId: actor.organizationId, traceId: intent.trace_id,
      actorId: actor.identityId, actorDid: actor.did, actorKind: actor.kind,
      action: "PAYMENT_EXECUTED", resourceType: "PAYMENT", resourceId: intentId,
      decision: "EXECUTED", executionRef: order.id, ip: ip ?? null,
      payload: { orderId: order.id, amountMinor: order.amount, currency: order.currency, adapter: razorpay.kind },
    });

    await proofService.anchor({
      organizationId: actor.organizationId,
      subjectType: "PAYMENT", subjectId: intentId,
      payload: {
        intentId, merchant: intent.merchant, amount: intent.amount, currency: intent.currency,
        decision: intent.decision, policyVersion: intent.policy_version, orderId: order.id,
      },
    }).catch(() => {});

    return { intent: await getIntent(actor.organizationId, intentId)!, replayed: false, order };
  } catch (err: any) {
    await run(`UPDATE payment_intents SET state = 'FAILED', failure_reason = ?, updated_at = ? WHERE id = ?`,
      String(err?.message ?? err), nowIso(), intentId);
    await audit.record({
      organizationId: actor.organizationId, traceId: intent.trace_id,
      actorId: actor.identityId, actorDid: actor.did, actorKind: actor.kind,
      action: "PAYMENT_EXECUTION_FAILED", resourceType: "PAYMENT", resourceId: intentId,
      decision: "FAILED", reasonCodes: ["PROVIDER_ERROR"],
      payload: { error: String(err?.message ?? err) },
    });
    throw err;
  }
}

/**
 * Webhook reconciliation.
 *
 * Signature verification happens in the route before this is reached. Here we do the
 * part that signature verification alone does not cover: confirm the provider's stated
 * amount and currency match what we authorized. A validly-signed webhook claiming a
 * different amount is a reconciliation mismatch, not a success — the spec's "never
 * trust client success state" applies to the provider too.
 */
export async function reconcileFromWebhook(params: {
  organizationId: string;
  orderId: string;
  paymentId: string;
  event: string;
  amountMinor: number;
  currency: string;
  providerEventId?: string | null;
  rawBody: string;
}) {
  const intent = await one<any>(
    `SELECT * FROM payment_intents WHERE organization_id = ? AND provider_order_id = ?`,
    params.organizationId, params.orderId,
  );
  if (!intent) {
    return { matched: false, outcome: "NO_MATCHING_INTENT", intent: null };
  }

  const expectedMinor = Math.round(intent.amount * 100);
  const amountMatches = params.amountMinor === expectedMinor;
  const currencyMatches = params.currency.toUpperCase() === String(intent.currency).toUpperCase();

  if (!amountMatches || !currencyMatches) {
    await run(`UPDATE payment_intents SET provider_state = ?, failure_reason = ?, updated_at = ? WHERE id = ?`,
      params.event, `Reconciliation mismatch: provider reported ${params.currency} ${params.amountMinor / 100}, authorized ${intent.currency} ${intent.amount}.`,
      nowIso(), intent.id);
    await audit.record({
      organizationId: params.organizationId, traceId: intent.trace_id,
      action: "PAYMENT_RECONCILIATION_MISMATCH", resourceType: "PAYMENT", resourceId: intent.id,
      decision: "FAILED", reasonCodes: ["RECONCILIATION_MISMATCH"],
      executionRef: params.paymentId,
      payload: { expectedMinor, reportedMinor: params.amountMinor, expectedCurrency: intent.currency, reportedCurrency: params.currency },
    });
    orgService.recordSecurityEvent({
      organizationId: params.organizationId, kind: "RECONCILIATION_MISMATCH", severity: "CRITICAL",
      summary: `Webhook for ${params.orderId} reported an amount that does not match the authorized intent.`,
      detail: { intentId: intent.id, expectedMinor, reportedMinor: params.amountMinor },
    });
    return { matched: true, outcome: "MISMATCH", intent: await getIntent(params.organizationId, intent.id) };
  }

  const failed = params.event === "payment.failed";
  const nextState: PaymentState = failed ? "FAILED" : "RECONCILED";

  await run(`UPDATE payment_intents SET state = ?, provider_payment_id = ?, provider_state = ?, updated_at = ? WHERE id = ?`,
    nextState, params.paymentId, params.event, nowIso(), intent.id);

  await audit.record({
    organizationId: params.organizationId, traceId: intent.trace_id,
    action: failed ? "PAYMENT_FAILED" : "PAYMENT_RECONCILED",
    resourceType: "PAYMENT", resourceId: intent.id,
    decision: failed ? "FAILED" : "EXECUTED",
    executionRef: params.paymentId,
    payload: { event: params.event, orderId: params.orderId, paymentId: params.paymentId, amountMinor: params.amountMinor },
  });

  if (!failed) {
    await proofService.anchor({
      organizationId: params.organizationId, subjectType: "PAYMENT", subjectId: intent.id,
      payload: { intentId: intent.id, orderId: params.orderId, paymentId: params.paymentId, event: params.event, amountMinor: params.amountMinor },
    }).catch(() => {});
  }

  return { matched: true, outcome: failed ? "FAILED" : "RECONCILED", intent: await getIntent(params.organizationId, intent.id) };
}

/** Persist every webhook, valid or not. An invalid-signature attempt is itself a signal. */
export async function recordWebhook(input: {
  provider: string; providerEventId: string | null; eventType: string;
  signatureValid: boolean; rawBody: string; paymentIntentId?: string | null; outcome?: string | null;
}) {
  const id = newId("exec");
  try {
    await run(
      `INSERT INTO webhook_events (id, provider, provider_event_id, event_type, signature_valid, payload_json, payment_intent_id, processed_at, outcome, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      id, input.provider, input.providerEventId, input.eventType, input.signatureValid ? 1 : 0,
      input.rawBody, input.paymentIntentId ?? null, nowIso(), input.outcome ?? null, nowIso(),
    );
    return { id, duplicate: false };
  } catch {
    // UNIQUE(provider, provider_event_id) violated — the provider retried a delivery
    // we have already processed. Idempotent by construction.
    return { id: null, duplicate: true };
  }
}

export async function listWebhooks(limit = 100) {
  return await many<any>(`SELECT * FROM webhook_events ORDER BY created_at DESC LIMIT ?`, limit);
}

/** Intents that executed but never reconciled — the operator's stuck-payment queue. */
export async function unreconciled(organizationId: string) {
  return await many<any>(
    `SELECT * FROM payment_intents WHERE organization_id = ? AND state IN ('EXECUTING','EXECUTED') ORDER BY created_at ASC`,
    organizationId,
  );
}

export function toApi(row: any) {
  return {
    id: row.id, merchant: row.merchant, amount: row.amount, currency: row.currency,
    purpose: row.purpose, invoiceRef: row.invoice_ref, rawRequest: row.raw_request,
    state: row.state, decision: row.decision, reasonCodes: j.dec<string[]>(row.reason_codes, []),
    evidence: j.dec<string[]>(row.evidence_json, []),
    actorIdentityId: row.actor_identity_id, actorName: row.actor_name ?? null, actorDid: row.actor_did ?? null,
    agentId: row.agent_id, agentName: row.agent_name ?? null,
    departmentId: row.department_id, departmentName: row.department_name ?? null,
    policyId: row.policy_id, policyVersion: row.policy_version, approvalId: row.approval_id,
    idempotencyKey: row.idempotency_key,
    providerOrderId: row.provider_order_id, providerPaymentId: row.provider_payment_id,
    providerState: row.provider_state, failureReason: row.failure_reason,
    providerAdapter: row.provider_adapter ?? null,
    // Explicit rather than inferred: a client should never have to know which adapter
    // names mean "real" to decide whether to tell a user money moved.
    simulated: row.provider_adapter ? row.provider_adapter !== "live" : null,
    traceId: row.trace_id, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}
