import type { FastifyInstance } from "fastify";
import * as paymentService from "../services/paymentService.js";
import * as orgService from "../services/orgService.js";
import { getRazorpayAdapter } from "../adapters/razorpay/index.js";
import { one } from "../db/client.js";

/**
 * Provider webhooks.
 *
 * This is the one route that is NOT session-authenticated — the provider has no
 * session. It is authenticated by HMAC signature over the exact raw bytes instead,
 * which is why `app.ts` installs a raw-body parser for this path: re-serialising the
 * parsed JSON would produce different bytes and every legitimate signature would fail.
 *
 * An invalid signature is recorded and raises a security event rather than being
 * silently dropped. Someone probing the webhook endpoint is information worth having.
 */
export async function webhookRoutes(app: FastifyInstance) {
  app.post("/api/webhooks/razorpay", { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (req, reply) => {
    const razorpay = getRazorpayAdapter();
    const signature = String(req.headers["x-razorpay-signature"] ?? "");
    const rawBody = req.rawBodyString ?? "";

    if (!signature || !rawBody) {
      return reply.code(400).send({ error: "MISSING_SIGNATURE", message: "A signature header and body are required." });
    }

    const valid = razorpay.verifyWebhookSignature(rawBody, signature);
    let parsed: any = {};
    try { parsed = JSON.parse(rawBody); } catch { /* logged below as an unparseable delivery */ }

    const eventType = parsed?.event ?? "unknown";
    const entity = parsed?.payload?.payment?.entity ?? {};
    const providerEventId = parsed?.id ?? entity?.id ?? null;

    const recorded = paymentService.recordWebhook({
      provider: "razorpay", providerEventId, eventType,
      signatureValid: valid, rawBody, outcome: valid ? null : "INVALID_SIGNATURE",
    });

    if (!valid) {
      const intent = entity?.order_id
        ? one<any>(`SELECT organization_id FROM payment_intents WHERE provider_order_id = ?`, entity.order_id)
        : null;
      if (intent) {
        orgService.recordSecurityEvent({
          organizationId: intent.organization_id, kind: "WEBHOOK_SIGNATURE_INVALID", severity: "CRITICAL",
          summary: `A webhook for order ${entity.order_id} failed signature verification and was rejected.`,
          detail: { eventType, providerEventId },
        });
      }
      return reply.code(401).send({ error: "INVALID_SIGNATURE", message: "Webhook signature verification failed. No state was changed." });
    }

    if (recorded.duplicate) {
      // Provider retries are expected. Acknowledge without reprocessing.
      return reply.code(200).send({ ok: true, duplicate: true, message: "This event was already processed." });
    }

    const orderId = entity?.order_id;
    if (!orderId) return reply.code(200).send({ ok: true, ignored: true, message: "No order reference in payload." });

    const intentRow = one<any>(`SELECT organization_id FROM payment_intents WHERE provider_order_id = ?`, orderId);
    if (!intentRow) return reply.code(200).send({ ok: true, ignored: true, message: "No matching payment intent." });

    const result = paymentService.reconcileFromWebhook({
      organizationId: intentRow.organization_id,
      orderId, paymentId: entity.id, event: eventType,
      amountMinor: Number(entity.amount ?? 0), currency: String(entity.currency ?? "INR"),
      providerEventId, rawBody,
    });

    return reply.code(200).send({ ok: true, outcome: result.outcome, matched: result.matched });
  });
}
