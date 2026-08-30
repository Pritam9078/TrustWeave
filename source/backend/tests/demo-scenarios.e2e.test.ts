import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHarness, destroyHarness, asUser, asAgent, type Harness } from "./helpers.js";

/**
 * The three demo scenarios, end to end.
 *
 * These exist to prove the headline claim in a form that can be narrated: an AI produces
 * a well-formed financial action, and the authorization engine — not a parser, not a
 * schema, not the model's own restraint — decides what happens to it.
 */

let h: Harness;
beforeAll(async () => { h = await createHarness("demo"); }, 60_000);
afterAll(async () => { await destroyHarness(h); });

describe("Case A — within policy, executes", () => {
  it("proposes, authorizes, executes and audits a compliant payment", async () => {
    const task = await asAgent(h)("POST", "/api/agents/task", {
      instruction: "Pay Acme Cloud Services 3000 INR for July hosting.",
      execute: true,
    });
    const body = task.json();

    expect(body.proposal.actionType).toBe("CREATE_PAYMENT");
    expect(body.proposal.amount).toBe(3000);
    expect(body.toolCall.decision).toBe("ALLOW");

    const intentId = body.toolCall.data.id;
    const exec = await asUser(h, "manager")("POST", `/api/payment-intents/${intentId}/execute`);
    expect(exec.statusCode).toBe(200);
    expect(exec.json().intent.state).toBe("EXECUTED");
    expect(exec.json().intent.providerOrderId).toBeTruthy();

    // Reconcile through a genuinely signed provider webhook.
    const hook = await asUser(h, "admin")("POST", `/api/payments/${intentId}/simulate-webhook`, { event: "payment.captured" });
    expect(hook.json().result.ok).toBe(true);

    const detail = await asUser(h, "admin")("GET", `/api/payment-intents/${intentId}`);
    expect(detail.json().intent.state).toBe("RECONCILED");

    // Everything under one trace, and the chain still verifies.
    expect(detail.json().timeline.length).toBeGreaterThan(1);
    expect(detail.json().auditChain.valid).toBe(true);
  });
});

describe("Case B — exceeds policy, denied before execution", () => {
  it("blocks a well-formed over-limit proposal at the authorization engine", async () => {
    const task = await asAgent(h)("POST", "/api/agents/task", {
      instruction: "Pay Acme Cloud Services 250000 INR for an annual renewal.",
      execute: true,
    });
    const body = task.json();

    // The proposal itself is valid — this is not a parsing failure.
    expect(body.proposal.merchant).toBe("Acme Cloud Services");
    expect(body.proposal.amount).toBe(250000);
    expect(body.toolCall.reasonCodes).not.toContain("INVALID_ARGUMENTS");

    // The engine refused it, and said which gate failed.
    expect(body.toolCall.decision).toBe("DENY");
    const failed = body.toolCall.evaluation.filter((s: any) => s.outcome === "FAIL");
    expect(failed.length).toBeGreaterThan(0);

    // Nothing was created that could later execute.
    const intents = await asUser(h, "admin")("GET", "/api/payment-intents");
    const live = intents.json().intents.filter((p: any) =>
      p.merchant === "Acme Cloud Services" && p.amount === 250000 && ["AUTHORIZED", "EXECUTED", "RECONCILED"].includes(p.state));
    expect(live).toEqual([]);

    // The denial is on the record.
    const audit = await asUser(h, "auditor")("GET", "/api/audit/events?decision=DENY");
    expect(audit.json().events.length).toBeGreaterThan(0);
  });

  it("raises a security event so an administrator can see the attempt", async () => {
    const events = await asUser(h, "admin")("GET", "/api/security/events");
    const blocked = events.json().events.filter((e: any) => e.kind === "AGENT_ACTION_BLOCKED");
    expect(blocked.length).toBeGreaterThan(0);
  });
});

describe("Case C — above threshold, requires human approval", () => {
  let intentId: string;
  let approvalId: string;

  it("holds the payment instead of executing it", async () => {
    const task = await asAgent(h)("POST", "/api/agents/task", {
      instruction: "Pay Globex Logistics 92000 INR for Q3 freight.",
      execute: true,
    });
    const body = task.json();

    expect(body.proposal.amount).toBe(92000);
    expect(body.toolCall.decision).toBe("REQUIRE_APPROVAL");
    intentId = body.toolCall.data.id;
    approvalId = body.toolCall.approvalId;
    expect(approvalId).toBeTruthy();

    const detail = await asUser(h, "admin")("GET", `/api/payment-intents/${intentId}`);
    expect(detail.json().intent.state).toBe("AWAITING_APPROVAL");
  });

  it("refuses execution while the approval is outstanding", async () => {
    const exec = await asUser(h, "manager")("POST", `/api/payment-intents/${intentId}/execute`);
    expect(exec.statusCode).toBeGreaterThanOrEqual(400);
  });

  it("executes only after a human with the capability approves", async () => {
    const decide = await asUser(h, "admin")("POST", `/api/approvals/${approvalId}/decide`, {
      decision: "APPROVED", note: "Invoice checked against the purchase order.",
    });
    expect(decide.statusCode).toBe(200);

    const exec = await asUser(h, "manager")("POST", `/api/payment-intents/${intentId}/execute`);
    expect(exec.statusCode).toBe(200);
    expect(exec.json().intent.state).toBe("EXECUTED");
  });

  it("anchors a verifiable proof for the completed payment", async () => {
    const proofs = await asUser(h, "auditor")("GET", "/api/proofs");
    expect(proofs.json().proofs.length).toBeGreaterThan(0);
    const verify = await asUser(h, "auditor")("POST", `/api/proofs/${proofs.json().proofs[0].id}/verify`);
    expect(verify.json().verified).toBe(true);
  });
});
