import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHarness, destroyHarness, asUser, type Harness } from "./helpers.js";

/**
 * A simulated payment must never be presentable as a real one.
 *
 * The test adapter performs real signature verification and real idempotency, which is
 * exactly what makes it useful — and exactly what makes it dangerous to mislabel. A
 * reviewer looking at an executed payment has to be able to tell, without knowing the
 * deployment's configuration, whether money actually moved.
 */

let h: Harness;
beforeAll(async () => { h = await createHarness("simlabel"); }, 60_000);
afterAll(async () => { await destroyHarness(h); });

describe("Simulated payments are labelled as simulated", () => {
  let intentId: string;

  it("reports nothing before execution rather than guessing", async () => {
    const create = await asUser(h, "manager")("POST", "/api/payment-intents", {
      merchant: "Acme Cloud Services", amount: 2500, currency: "INR", purpose: "labelling",
    });
    intentId = create.json().intent.id;
    // Null, not false: an unexecuted payment has no provider, and claiming "not
    // simulated" would be a claim about something that never happened.
    expect(create.json().intent.simulated).toBeNull();
  });

  it("marks an executed payment as simulated when the test adapter ran", async () => {
    await asUser(h, "manager")("POST", `/api/payment-intents/${intentId}/authorize`);
    const exec = await asUser(h, "manager")("POST", `/api/payment-intents/${intentId}/execute`);
    expect(exec.statusCode).toBe(200);
    expect(exec.json().intent.simulated).toBe(true);
    expect(exec.json().intent.providerAdapter).toBe("test");
  });

  it("keeps the label on subsequent reads and in list views", async () => {
    const detail = await asUser(h, "admin")("GET", `/api/payment-intents/${intentId}`);
    expect(detail.json().intent.simulated).toBe(true);

    const list = await asUser(h, "admin")("GET", "/api/payment-intents");
    const row = list.json().intents.find((p: any) => p.id === intentId);
    expect(row.simulated).toBe(true);
  });

  it("survives reconciliation — a reconciled payment is still a simulated one", async () => {
    await asUser(h, "admin")("POST", `/api/payments/${intentId}/simulate-webhook`, { event: "payment.captured" });
    const after = await asUser(h, "admin")("GET", `/api/payment-intents/${intentId}`);
    expect(after.json().intent.state).toBe("RECONCILED");
    expect(after.json().intent.simulated).toBe(true);
  });

  it("reports the adapter mode on the integrations surface", async () => {
    const res = await asUser(h, "admin")("GET", "/api/integrations/status");
    expect(res.json().payments.mode).toBe("SIMULATED");
    expect(res.json().blockchain.mode).toBe("SIMULATED");
    expect(res.json().ai.mode).toBe("SIMULATED");
  });

  it("marks chain receipts as simulated too", async () => {
    const created = await asUser(h, "admin")("POST", "/api/assets", {
      name: "Label Asset", assetType: "LAPTOP", departmentId: h.departments.finance,
      ownerDid: h.dids.manager, metadata: {},
    });
    const mint = await asUser(h, "admin")("POST", `/api/assets/${created.json().asset.id}/mint`);
    expect(mint.json().receipt.simulated).toBe(true);
  });
});
