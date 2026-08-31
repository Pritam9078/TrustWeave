import type { FastifyInstance } from "fastify";
import * as S from "../schemas/index.js";
import { validate } from "./_helpers.js";
import { requireActor, requireHuman } from "../auth/middleware.js";
import * as paymentService from "../services/paymentService.js";
import * as approvalService from "../services/approvalService.js";
import * as authz from "../services/authorizationService.js";
import * as audit from "../services/auditService.js";
import * as proofService from "../services/proofService.js";
import { getRazorpayAdapter } from "../adapters/razorpay/index.js";
import { notFound, badRequest } from "../core/errors.js";

/**
 * Describes the resource an approval actually concerns, so the authorization engine
 * evaluates the approver against the payment's department and vendor rather than
 * against an abstract "approval" with no scope attributes of its own.
 */
async function approvalResource(actor: any, approval: any, intent: any) {
  if (approval.request_type === "PAYMENT" && intent) {
    return {
      type: "PAYMENT", id: intent.id,
      organizationId: intent.organization_id,
      departmentId: intent.department_id,
      vendor: intent.merchant,
    };
  }
  if (approval.request_type === "ASSET_TRANSFER") {
    const evidence = await (await approvalService.toApi(approval)).evidence as any;
    return { type: "ASSET", id: approval.request_id, organizationId: actor.organizationId, departmentId: evidence?.departmentId ?? null };
  }
  return { type: approval.request_type, id: approval.request_id, organizationId: actor.organizationId };
}

export async function paymentRoutes(app: FastifyInstance) {
  app.get("/api/payment-intents", async (req) => {
    const actor = requireActor(req);
    await authz.enforce({ actor, action: "PAYMENT_READ", resource: { type: "PAYMENT", query: true }, ip: req.ip });
    const q = req.query as any;
    // A plain User sees only their own intents, regardless of what they filter by.
    const scoped = actor.capabilities.has("PAYMENT_APPROVE") || actor.roleNames.includes("Auditor") || actor.roleNames.includes("Admin")
      ? q : { ...q, actorId: actor.identityId };
    return { intents: (await paymentService.listIntents(actor.organizationId, scoped)).map(paymentService.toApi) };
  });

  app.get("/api/payment-intents/:id", async (req) => {
    const actor = requireActor(req);
    const { id } = req.params as { id: string };
    const intent = await paymentService.getIntent(actor.organizationId, id);
    if (!intent) throw notFound("Payment intent not found.");
    await authz.enforce({
      actor, action: "PAYMENT_READ",
      resource: { type: "PAYMENT", id, organizationId: intent.organization_id, departmentId: intent.department_id, vendor: intent.merchant },
      ip: req.ip,
    });
    const approval = intent.approval_id ? await approvalService.getApproval(actor.organizationId, intent.approval_id) : null;
    return {
      intent: paymentService.toApi(intent),
      approval: approval ? approvalService.toApi(approval) : null,
      timeline: (await audit.byTrace(actor.organizationId, intent.trace_id)).map(audit.toApi),
      auditChain: await audit.verifyChain(actor.organizationId),
      proofs: (await proofService.listProofs(actor.organizationId, { subjectType: "PAYMENT", subjectId: id })).map(proofService.toApi),
    };
  });

  app.post("/api/payment-intents", async (req, reply) => {
    const actor = requireActor(req);
    const body = validate(S.createPaymentIntent, req.body);

    // PAYMENT_CREATE is enforced here, at draft creation, not only at authorization.
    // A draft cannot execute — authorizeIntent re-evaluates everything and would refuse
    // it — but allowing a capability-less actor to write payment rows contradicts the
    // Auditor's defining guarantee of zero mutations, and lets anyone with a session put
    // records in front of an approver. Refusing at the door keeps the read-only role
    // genuinely read-only.
    await authz.enforce({
      actor, action: "PAYMENT_CREATE",
      resource: {
        type: "PAYMENT",
        organizationId: actor.organizationId,
        departmentId: body.departmentId ?? actor.departmentId,
        vendor: body.merchant,
      },
      context: { amount: body.amount, currency: body.currency, merchant: body.merchant },
      ip: req.ip,
      payload: { merchant: body.merchant, amount: body.amount },
    });

    const { intent, deduplicated } = await paymentService.createIntent(actor, body);
    return reply.code(deduplicated ? 200 : 201).send({ intent: paymentService.toApi(intent), deduplicated });
  });

  app.post("/api/payment-intents/:id/authorize", async (req) => {
    const actor = requireActor(req);
    const { id } = req.params as { id: string };
    const result = await paymentService.authorizeIntent(actor, id, req.ip);
    return {
      intent: paymentService.toApi(result.intent),
      decision: result.decision,
      reasonCodes: result.reasonCodes ?? [],
      evaluation: result.evaluation,
      approval: result.approval,
      alreadyAuthorized: result.alreadyAuthorized,
    };
  });

  app.post("/api/payment-intents/:id/execute", async (req) => {
    const actor = requireActor(req);
    const { id } = req.params as { id: string };
    const result = await paymentService.executeIntent(actor, id, req.ip);
    return { intent: paymentService.toApi(result.intent), order: result.order, replayed: result.replayed };
  });

  /* --------------------------------------------------------------- approvals */

  app.get("/api/approvals", async (req) => {
    const actor = requireActor(req);
    await authz.enforce({ actor, action: "PAYMENT_READ", resource: { type: "PAYMENT", query: true }, ip: req.ip });
    const q = req.query as any;
    return { approvals: (await approvalService.listApprovals(actor.organizationId, q)).map(approvalService.toApi) };
  });

  app.get("/api/approvals/:id", async (req) => {
    const actor = requireActor(req);
    const { id } = req.params as { id: string };
    const approval = await approvalService.getApproval(actor.organizationId, id);
    if (!approval) throw notFound("Approval not found.");
    const intent = approval.request_type === "PAYMENT" ? await paymentService.getIntent(actor.organizationId, approval.request_id) : null;
    await authz.enforce({ actor, action: "PAYMENT_READ", resource: await approvalResource(actor, approval, intent), ip: req.ip });
    return {
      approval: approvalService.toApi(approval),
      intent: intent ? paymentService.toApi(intent) : null,
      timeline: (await audit.byTrace(actor.organizationId, approval.trace_id)).map(audit.toApi),
      // Whether THIS viewer may act on it — drives the UI, but the real check is in decide().
      canDecide: actor.capabilities.has(approval.required_capability) && approval.requested_by !== actor.identityId && approval.status === "PENDING",
      cannotDecideReason: approval.requested_by === actor.identityId
        ? "You raised this request and cannot approve it."
        : !actor.capabilities.has(approval.required_capability)
          ? `Requires the ${approval.required_capability} capability.`
          : approval.status !== "PENDING" ? `Already ${approval.status}.` : null,
    };
  });

  app.post("/api/approvals/:id/decide", async (req) => {
    const actor = requireHuman(req);
    const { id } = req.params as { id: string };
    const body = validate(S.approvalDecision, req.body);

    const approval = await approvalService.getApproval(actor.organizationId, id);
    if (!approval) throw notFound("Approval not found.");

    // The approval must be evaluated against the *underlying resource*, not against a
    // bare {type, id}. Without the department and vendor of the payment being approved,
    // a department-scoped approver matches no scope and is refused — meaning only an
    // org-wide Admin could ever approve anything, which defeats delegated approval.
    const subject = approval.request_type === "PAYMENT"
      ? await paymentService.getIntent(actor.organizationId, approval.request_id) : null;

    await authz.enforce({
      actor, action: approval.required_capability,
      resource: await approvalResource(actor, approval, subject),
      context: subject ? { amount: subject.amount, currency: subject.currency, merchant: subject.merchant } : {},
      ip: req.ip, payload: { approvalId: id, decision: body.decision },
    });

    const { approval: decided, alreadyDecided } = await approvalService.decide(actor, id, body.decision, body.note);
    if (alreadyDecided) {
      return { approval: approvalService.toApi(decided), alreadyDecided: true, note: "This request had already been decided; no duplicate action was taken." };
    }

    let intent = null;
    if (decided.request_type === "PAYMENT") {
      intent = await paymentService.applyApprovalOutcome(actor.organizationId, decided.request_id, body.decision === "APPROVED");
    }
    if (decided.request_type === "ASSET_TRANSFER" && body.decision === "APPROVED") {
      const assetService = await import("../services/assetService.js");
      const evidence = await (await approvalService.toApi(decided)).evidence as any;
      await (assetService as any).transferAsset(actor, decided.trace_id, decided.request_id, evidence.newOwnerDid);
    }

    return {
      approval: approvalService.toApi(decided),
      intent: intent ? paymentService.toApi(intent) : null,
      alreadyDecided: false,
    };
  });

  /* ------------------------------------------------ reconciliation & webhooks */

  app.get("/api/payments/reconciliation", async (req) => {
    const actor = requireActor(req);
    await authz.enforce({ actor, action: "PAYMENT_READ", resource: { type: "PAYMENT", query: true }, ip: req.ip });
    return {
      unreconciled: (await paymentService.unreconciled(actor.organizationId)).map(paymentService.toApi),
      webhooks: (await paymentService.listWebhooks(50)).map((w: any) => ({
        id: w.id, provider: w.provider, eventType: w.event_type,
        signatureValid: !!w.signature_valid, paymentIntentId: w.payment_intent_id,
        outcome: w.outcome, createdAt: w.created_at,
      })),
      adapter: getRazorpayAdapter().kind,
    };
  });

  /**
   * Test-only: fabricate a provider callback so the reconciliation path is exercisable
   * without a browser checkout. It generates a REAL signature and posts through the
   * same verification code as a genuine webhook — it does not bypass verification, and
   * it is unavailable when the live adapter is in use.
   */
  app.post("/api/payments/:id/simulate-webhook", async (req) => {
    const actor = requireHuman(req);
    const { id } = req.params as { id: string };
    const { event = "payment.captured", paymentId } = (req.body ?? {}) as { event?: string; paymentId?: string };
    await authz.enforce({ actor, action: "PAYMENT_EXECUTE", resource: { type: "PAYMENT", id }, ip: req.ip });

    const razorpay = getRazorpayAdapter();
    if (!razorpay.simulateWebhook) throw badRequest("NOT_AVAILABLE", "Webhook simulation is unavailable when the live Razorpay adapter is active.");
    const intent = await paymentService.getIntent(actor.organizationId, id);
    if (!intent) throw notFound("Payment intent not found.");
    if (!intent.provider_order_id) throw badRequest("NOT_EXECUTED", "This intent has not been sent to the provider yet.");

    // Passing an explicit paymentId re-delivers a byte-identical event, which is how a
    // real provider retry looks — that is what exercises idempotency, whereas a fresh
    // payment id would be a genuinely new event and *should* be processed again.
    const { body, signature } = razorpay.simulateWebhook({
      orderId: intent.provider_order_id, event, paymentId,
      amountMinor: Math.round(intent.amount * 100), currency: intent.currency,
    });
    const res = await app.inject({
      method: "POST", url: "/api/webhooks/razorpay",
      headers: { "content-type": "application/json", "x-razorpay-signature": signature },
      payload: body,
    });
    return { simulated: true, forwarded: res.statusCode, paymentId: JSON.parse(body).payload.payment.entity.id, result: res.json() };
  });
}
