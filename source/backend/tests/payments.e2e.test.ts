import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHarness, destroyHarness, asUser, asAgent, type Harness } from "./helpers.js";

/** The governed-payment lifecycle: limits, approval routing, execution, reconciliation. */

let h: Harness;
beforeAll(async () => { h = await createHarness("pay"); }, 60_000);
afterAll(async () => { await destroyHarness(h); });

/**
 * Create then authorize. A payment the policy forbids outright is now refused at
 * creation rather than being stored as a doomed draft, so a create-time 403 is a
 * legitimate DENY and is normalised into the same shape the authorize step returns.
 */
async function createAndAuthorize(who: any, payload: any) {
  const create = await asUser(h, who)("POST", "/api/payment-intents", payload);
  if (create.statusCode === 403) {
    const body = create.json();
    return {
      id: null,
      auth: { decision: "DENY", reasonCodes: body.details?.reasonCodes ?? [], evaluation: body.details?.evaluation ?? [], approval: null, deniedAtCreation: true },
    };
  }
  const id = create.json().intent.id;
  const auth = await asUser(h, who)("POST", `/api/payment-intents/${id}/authorize`);
  return { id, auth: auth.json() };
}

describe("Payment below the threshold executes without approval", () => {
  it("authorizes outright", async () => {
    const { auth } = await createAndAuthorize("manager", {
      merchant: "Acme Cloud Services", amount: 38500, currency: "INR", purpose: "cloud hosting",
    });
    expect(auth.decision).toBe("ALLOW");
    expect(auth.intent.state).toBe("AUTHORIZED");
  });

  it("executes and reaches the provider", async () => {
    const { id, auth } = await createAndAuthorize("manager", {
      merchant: "Acme Cloud Services", amount: 12000, currency: "INR", purpose: "small spend",
    });
    expect(auth.decision).toBe("ALLOW");
    const exec = await asUser(h, "manager")("POST", `/api/payment-intents/${id}/execute`);
    expect(exec.statusCode).toBe(200);
    expect(exec.json().intent.state).toBe("EXECUTED");
    expect(exec.json().intent.providerOrderId).toBeTruthy();
  });
});

describe("Over-limit payment requires approval and cannot self-execute", () => {
  let intentId: string;
  let approvalId: string;

  it("routes to approval instead of authorizing", async () => {
    const { id, auth } = await createAndAuthorize("manager", {
      merchant: "Globex Logistics", amount: 92000, currency: "INR", purpose: "freight",
    });
    intentId = id;
    expect(auth.decision).toBe("REQUIRE_APPROVAL");
    expect(auth.intent.state).toBe("AWAITING_APPROVAL");
    approvalId = auth.approval.id;
  });

  it("refuses execution while the approval is pending", async () => {
    const exec = await asUser(h, "manager")("POST", `/api/payment-intents/${intentId}/execute`);
    expect(exec.statusCode).toBeGreaterThanOrEqual(400);
  });

  it("forbids the requester approving their own payment", async () => {
    const res = await asUser(h, "manager")("POST", `/api/approvals/${approvalId}/decide`, { decision: "APPROVED", note: "me" });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("SELF_APPROVAL_FORBIDDEN");
  });

  it("executes once a different authorised approver decides", async () => {
    const decide = await asUser(h, "admin")("POST", `/api/approvals/${approvalId}/decide`, { decision: "APPROVED", note: "checked the invoice" });
    expect(decide.statusCode).toBe(200);
    expect(decide.json().approval.status).toBe("APPROVED");

    const exec = await asUser(h, "manager")("POST", `/api/payment-intents/${intentId}/execute`);
    expect(exec.statusCode).toBe(200);
    expect(exec.json().intent.state).toBe("EXECUTED");
  });

  let deliveredPaymentId: string;

  it("reconciles from a signed provider webhook", async () => {
    const sim = await asUser(h, "admin")("POST", `/api/payments/${intentId}/simulate-webhook`, { event: "payment.captured" });
    expect(sim.statusCode).toBe(200);
    expect(sim.json().result.ok).toBe(true);
    deliveredPaymentId = sim.json().paymentId;

    const after = await asUser(h, "admin")("GET", `/api/payment-intents/${intentId}`);
    expect(after.json().intent.state).toBe("RECONCILED");
  });

  it("is idempotent when the provider retries the same webhook", async () => {
    const again = await asUser(h, "admin")("POST", `/api/payments/${intentId}/simulate-webhook`, {
      event: "payment.captured", paymentId: deliveredPaymentId,
    });
    expect(again.json().result.duplicate).toBe(true);
  });

  it("does not double-apply a repeated approval decision", async () => {
    const again = await asUser(h, "admin")("POST", `/api/approvals/${approvalId}/decide`, { decision: "REJECTED", note: "changed my mind" });
    expect(again.json().alreadyDecided).toBe(true);
    expect(again.json().approval.status).toBe("APPROVED");
  });
});

describe("Rejected approval blocks execution permanently", () => {
  it("denies execution after rejection", async () => {
    const { id, auth } = await createAndAuthorize("manager", {
      merchant: "Globex Logistics", amount: 88000, currency: "INR", purpose: "to be rejected",
    });
    await asUser(h, "admin")("POST", `/api/approvals/${auth.approval.id}/decide`, { decision: "REJECTED", note: "not budgeted" });
    const exec = await asUser(h, "manager")("POST", `/api/payment-intents/${id}/execute`);
    expect(exec.statusCode).toBeGreaterThanOrEqual(400);
  });
});

describe("Hard policy limits cannot be reached by approval", () => {
  it("denies a blocklisted vendor outright, with no approval offered", async () => {
    const { auth } = await createAndAuthorize("manager", {
      merchant: "Sanctioned Holdings Ltd", amount: 1000, currency: "INR", purpose: "blocked vendor",
    });
    expect(auth.decision).toBe("DENY");
    expect(auth.approval).toBeFalsy();
  });

  it("denies an amount above the hard maximum", async () => {
    const { auth } = await createAndAuthorize("admin", {
      merchant: "Acme Cloud Services", amount: 900000, currency: "INR", purpose: "over max",
    });
    expect(auth.decision).toBe("DENY");
  });

  it("denies a currency outside the allowlist", async () => {
    const { auth } = await createAndAuthorize("admin", {
      merchant: "Acme Cloud Services", amount: 5000, currency: "USD", purpose: "wrong currency",
    });
    expect(auth.decision).toBe("DENY");
  });
});

describe("Idempotency", () => {
  it("deduplicates repeated creates with the same idempotency key", async () => {
    const payload = {
      merchant: "Acme Cloud Services", amount: 4321, currency: "INR",
      purpose: "double click", idempotencyKey: "fixed-key-001",
    };
    const first = await asUser(h, "manager")("POST", "/api/payment-intents", payload);
    const second = await asUser(h, "manager")("POST", "/api/payment-intents", payload);
    expect(second.json().deduplicated).toBe(true);
    expect(second.json().intent.id).toBe(first.json().intent.id);
  });

  it("does not execute the same intent twice", async () => {
    const { id, auth } = await createAndAuthorize("manager", {
      merchant: "Acme Cloud Services", amount: 7777, currency: "INR", purpose: "replay check",
    });
    expect(auth.decision).toBe("ALLOW");
    const first = await asUser(h, "manager")("POST", `/api/payment-intents/${id}/execute`);
    const second = await asUser(h, "manager")("POST", `/api/payment-intents/${id}/execute`);
    expect(first.json().intent.providerOrderId).toBe(second.json().intent.providerOrderId);
    expect(second.json().replayed).toBe(true);
  });
});

describe("Webhook signature enforcement", () => {
  it("rejects an unsigned webhook", async () => {
    const res = await h.app.inject({
      method: "POST", url: "/api/webhooks/razorpay",
      headers: { "content-type": "application/json" },
      payload: { event: "payment.captured", payload: { payment: { entity: { order_id: "order_fake", amount: 100 } } } },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a webhook with a forged signature", async () => {
    const res = await h.app.inject({
      method: "POST", url: "/api/webhooks/razorpay",
      headers: { "content-type": "application/json", "x-razorpay-signature": "deadbeef" },
      payload: { event: "payment.captured", payload: { payment: { entity: { order_id: "order_fake", amount: 100 } } } },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("INVALID_SIGNATURE");
  });
});

describe("Agent payment limits", () => {
  it("denies an agent payment above its hard transaction ceiling", async () => {
    const res = await asAgent(h)("POST", "/api/agents/tools/invoke", {
      tool: "create_payment_intent",
      args: { merchant: "Acme Cloud Services", amount: 250000, currency: "INR", purpose: "above ceiling", evidenceIds: ["e1"] },
    });
    expect(res.json().decision).toBe("DENY");
  });

  it("routes an agent payment above its threshold to approval, not execution", async () => {
    const res = await asAgent(h)("POST", "/api/agents/tools/invoke", {
      tool: "create_payment_intent",
      args: { merchant: "Acme Cloud Services", amount: 92000, currency: "INR", purpose: "over agent limit", evidenceIds: ["e1"] },
    });
    expect(res.json().decision).toBe("REQUIRE_APPROVAL");
  });

  it("denies an agent paying a vendor outside its vendor scope", async () => {
    const res = await asAgent(h)("POST", "/api/agents/tools/invoke", {
      tool: "create_payment_intent",
      args: { merchant: "Unknown Vendor Pvt Ltd", amount: 1000, currency: "INR", purpose: "off-scope vendor", evidenceIds: ["e1"] },
    });
    expect(res.json().decision).toBe("DENY");
  });

  it("blocks all agent payments when the emergency flag is set", async () => {
    await asUser(h, "admin")("POST", "/api/security/emergency", { flagKey: "PAYMENTS_DISABLED", enabled: true, reason: "drill" });
    const res = await asAgent(h)("POST", "/api/agents/tools/invoke", {
      tool: "create_payment_intent",
      args: { merchant: "Acme Cloud Services", amount: 1000, currency: "INR", purpose: "during lockdown", evidenceIds: ["e1"] },
    });
    expect(res.json().decision).toBe("DENY");
    await asUser(h, "admin")("POST", "/api/security/emergency", { flagKey: "PAYMENTS_DISABLED", enabled: false, reason: "drill over" });
  });
});
