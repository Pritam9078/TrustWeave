import { createHmac } from "node:crypto";
import type { RazorpayAdapter, RazorpayOrder, RazorpayPayment, RazorpayRefund } from "./types.js";

/**
 * Live Razorpay adapter over the REST API (fetch, no SDK dependency).
 *
 * Selected automatically when RAZORPAY_KEY_ID/SECRET are present. Guard rail: the
 * constructor refuses a key id that does not start with `rzp_test_` unless
 * ALLOW_LIVE_KEYS is explicitly set, so a production key pasted into a demo
 * environment fails loudly at boot rather than moving real money at 2am.
 */
export class LiveRazorpayAdapter implements RazorpayAdapter {
  readonly kind = "live" as const;
  private auth: string;

  constructor(
    private keyId: string,
    keySecret: string,
    private webhookSecret: string,
    private baseUrl = "https://api.razorpay.com/v1",
  ) {
    if (!keyId.startsWith("rzp_test_") && process.env.ALLOW_LIVE_KEYS !== "true") {
      throw new Error(
        "RAZORPAY_KEY_ID is not a test key. TrustWeave refuses live keys unless ALLOW_LIVE_KEYS=true is set deliberately.",
      );
    }
    this.auth = "Basic " + Buffer.from(`${keyId}:${keySecret}`).toString("base64");
  }

  private async call(path: string, init: RequestInit = {}): Promise<any> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", Authorization: this.auth, ...(init.headers ?? {}) },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Razorpay ${res.status}: ${(body as any)?.error?.description ?? res.statusText}`);
    return body;
  }

  async createOrder(p: { amountMinor: number; currency: string; receipt: string; notes?: Record<string, string>; idempotencyKey: string }): Promise<RazorpayOrder> {
    return this.call("/orders", {
      method: "POST",
      headers: { "X-Razorpay-Idempotency-Key": p.idempotencyKey },
      body: JSON.stringify({ amount: p.amountMinor, currency: p.currency, receipt: p.receipt, notes: p.notes ?? {} }),
    });
  }

  async fetchPayment(paymentId: string): Promise<RazorpayPayment | null> {
    try { return await this.call(`/payments/${paymentId}`); } catch { return null; }
  }

  async capturePayment(paymentId: string, amountMinor: number, currency: string): Promise<RazorpayPayment> {
    return this.call(`/payments/${paymentId}/capture`, { method: "POST", body: JSON.stringify({ amount: amountMinor, currency }) });
  }

  async createRefund(paymentId: string, amountMinor: number): Promise<RazorpayRefund> {
    return this.call(`/payments/${paymentId}/refund`, { method: "POST", body: JSON.stringify({ amount: amountMinor }) });
  }

  verifyWebhookSignature(rawBody: string, signature: string): boolean {
    const expected = createHmac("sha256", this.webhookSecret).update(rawBody).digest("hex");
    if (expected.length !== signature.length) return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
    return diff === 0;
  }

  async health() {
    try {
      await this.call("/payments?count=1");
      return { ok: true, detail: `Connected to Razorpay as ${this.keyId}.` };
    } catch (e: any) {
      return { ok: false, detail: `Razorpay unreachable: ${e?.message ?? e}` };
    }
  }
}
