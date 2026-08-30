export interface RazorpayOrder {
  id: string;
  amount: number;       // paise (minor units)
  currency: string;
  receipt: string;
  status: string;
  created_at: number;
}

export interface RazorpayPayment {
  id: string;
  order_id: string;
  amount: number;
  currency: string;
  status: string;       // created | authorized | captured | failed | refunded
  method?: string;
}

export interface RazorpayRefund { id: string; payment_id: string; amount: number; status: string; }

/**
 * Provider port. The test adapter and the live SDK adapter implement this identically,
 * so `paymentService` contains no branch on which one is in use.
 */
export interface RazorpayAdapter {
  readonly kind: "test" | "live";
  createOrder(params: { amountMinor: number; currency: string; receipt: string; notes?: Record<string, string>; idempotencyKey: string }): Promise<RazorpayOrder>;
  fetchPayment(paymentId: string): Promise<RazorpayPayment | null>;
  capturePayment(paymentId: string, amountMinor: number, currency: string): Promise<RazorpayPayment>;
  createRefund(paymentId: string, amountMinor: number): Promise<RazorpayRefund>;
  verifyWebhookSignature(rawBody: string, signature: string): boolean;
  /** Test-only: fabricate a provider callback so the reconciliation path is exercisable
   *  without a browser checkout. Absent on the live adapter. */
  simulateWebhook?(params: { orderId: string; paymentId?: string; event: string; amountMinor: number; currency: string }): { body: string; signature: string };
  health(): Promise<{ ok: boolean; detail: string }>;
}
