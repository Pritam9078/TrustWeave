import { createHash, createHmac, randomBytes } from "node:crypto";
import type { RazorpayAdapter, RazorpayOrder, RazorpayPayment, RazorpayRefund } from "./types.js";

/**
 * Deterministic test adapter.
 *
 * It implements the *real* HMAC-SHA256 webhook signature scheme Razorpay uses, not a
 * bypass — `verifyWebhookSignature` here is the same computation the live adapter
 * performs, so the webhook verification path is genuinely exercised by tests and a
 * forged signature is rejected here exactly as it would be in production. That is the
 * part that actually matters for security; only the network call is simulated.
 *
 * Limitation, stated in the API and surfaced in the Integrations UI: no money moves
 * and no external system can confirm these order ids.
 */
export class TestRazorpayAdapter implements RazorpayAdapter {
  readonly kind = "test" as const;
  private orders = new Map<string, RazorpayOrder>();
  private payments = new Map<string, RazorpayPayment>();
  private refunds = new Map<string, RazorpayRefund>();
  private idempotency = new Map<string, string>();

  constructor(private webhookSecret: string = "trustweave_test_webhook_secret") {}

  private id(prefix: string, seed: string): string {
    return `${prefix}_${createHash("sha256").update(seed).digest("hex").slice(0, 14)}`;
  }

  async createOrder(p: { amountMinor: number; currency: string; receipt: string; notes?: Record<string, string>; idempotencyKey: string }): Promise<RazorpayOrder> {
    // Idempotency is enforced by the provider port as well as by the payment service.
    // A retried network call must not create a second order even if the caller's own
    // dedupe failed.
    const existing = this.idempotency.get(p.idempotencyKey);
    if (existing) return this.orders.get(existing)!;

    const orderId = this.id("order", p.idempotencyKey);
    const order: RazorpayOrder = {
      id: orderId, amount: p.amountMinor, currency: p.currency,
      receipt: p.receipt, status: "created", created_at: Math.floor(Date.now() / 1000),
    };
    this.orders.set(orderId, order);
    this.idempotency.set(p.idempotencyKey, orderId);
    return order;
  }

  async fetchPayment(paymentId: string): Promise<RazorpayPayment | null> {
    return this.payments.get(paymentId) ?? null;
  }

  async capturePayment(paymentId: string, amountMinor: number, currency: string): Promise<RazorpayPayment> {
    const existing = this.payments.get(paymentId);
    const payment: RazorpayPayment = {
      id: paymentId, order_id: existing?.order_id ?? "", amount: amountMinor,
      currency, status: "captured", method: "netbanking",
    };
    this.payments.set(paymentId, payment);
    return payment;
  }

  async createRefund(paymentId: string, amountMinor: number): Promise<RazorpayRefund> {
    const refund: RazorpayRefund = {
      id: this.id("rfnd", paymentId + amountMinor), payment_id: paymentId, amount: amountMinor, status: "processed",
    };
    this.refunds.set(refund.id, refund);
    return refund;
  }

  verifyWebhookSignature(rawBody: string, signature: string): boolean {
    const expected = createHmac("sha256", this.webhookSecret).update(rawBody).digest("hex");
    if (expected.length !== signature.length) return false;
    // Constant-time compare; a length-safe equality check on hex strings.
    let diff = 0;
    for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
    return diff === 0;
  }

  simulateWebhook(p: { orderId: string; paymentId?: string; event: string; amountMinor: number; currency: string }) {
    const paymentId = p.paymentId ?? this.id("pay", p.orderId + randomBytes(4).toString("hex"));
    this.payments.set(paymentId, {
      id: paymentId, order_id: p.orderId, amount: p.amountMinor, currency: p.currency,
      status: p.event === "payment.failed" ? "failed" : "captured", method: "netbanking",
    });
    const body = JSON.stringify({
      entity: "event",
      event: p.event,
      created_at: Math.floor(Date.now() / 1000),
      payload: {
        payment: {
          entity: {
            id: paymentId, order_id: p.orderId, amount: p.amountMinor,
            currency: p.currency, status: p.event === "payment.failed" ? "failed" : "captured",
          },
        },
      },
    });
    return { body, signature: createHmac("sha256", this.webhookSecret).update(body).digest("hex") };
  }

  async health() {
    return { ok: true, detail: "Deterministic test adapter. Real HMAC-SHA256 webhook verification; no network calls and no money movement." };
  }
}
