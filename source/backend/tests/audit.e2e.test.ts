import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHarness, destroyHarness, asUser, asAgent, type Harness } from "./helpers.js";
import { run } from "../src/db/client.js";

/** Audit integrity, blockchain anchoring and proof verification. */

let h: Harness;
beforeAll(async () => { h = await createHarness("audit"); }, 60_000);
afterAll(async () => { await destroyHarness(h); });

describe("Every critical operation is audited", () => {
  const cases: [string, () => Promise<unknown>, string][] = [
    ["asset mint", async () => {
      const created = await asUser(h, "admin")("POST", "/api/assets", { name: "Audited Asset", assetType: "LAPTOP", departmentId: h.departments.finance, ownerDid: h.dids.manager, metadata: {} });
      return asUser(h, "admin")("POST", `/api/assets/${created.json().asset.id}/mint`);
    }, "ASSET_MINTED"],
    ["policy creation", async () =>
      asUser(h, "admin")("POST", "/api/policies", { policyKey: "audited-policy", name: "Audited", conditions: { rules: [{ type: "AMOUNT_MAX", value: 1000 }] } }),
      "POLICY_CREATED"],
    ["role change", async () =>
      asUser(h, "admin")("POST", "/api/roles", { name: "Audited Role", capabilities: ["ASSET_READ"] }),
      "ROLE_CREATED"],
    ["emergency control", async () =>
      asUser(h, "admin")("POST", "/api/security/emergency", { flagKey: "MINTING_DISABLED", enabled: false, reason: "audit test" }),
      "EMERGENCY_DISABLED"],
  ];

  for (const [label, action, expectedAction] of cases) {
    it(`records ${label}`, async () => {
      await action();
      const res = await asUser(h, "auditor")("GET", `/api/audit/events?action=${expectedAction}`);
      expect(res.json().events.length).toBeGreaterThan(0);
    });
  }

  it("records denials, not just successes", async () => {
    await asUser(h, "user")("POST", "/api/identities", { displayName: "Denied Person" });
    const res = await asUser(h, "auditor")("GET", "/api/audit/events?decision=DENY");
    expect(res.json().events.length).toBeGreaterThan(0);
  });

  it("links every event in a payment lifecycle under one trace id", async () => {
    const create = await asUser(h, "manager")("POST", "/api/payment-intents", { merchant: "Acme Cloud Services", amount: 15000, currency: "INR", purpose: "trace test" });
    const id = create.json().intent.id;
    await asUser(h, "manager")("POST", `/api/payment-intents/${id}/authorize`);
    await asUser(h, "manager")("POST", `/api/payment-intents/${id}/execute`);

    const detail = await asUser(h, "manager")("GET", `/api/payment-intents/${id}`);
    const timeline = detail.json().timeline;
    expect(timeline.length).toBeGreaterThan(1);
    const traceIds = new Set(timeline.map((e: any) => e.traceId));
    expect(traceIds.size).toBe(1);
  });
});

describe("Proof verification", () => {
  let assetId: string;

  it("anchors a proof when an asset is minted", async () => {
    const created = await asUser(h, "admin")("POST", "/api/assets", {
      name: "Proof Asset", assetType: "LAPTOP", departmentId: h.departments.finance,
      ownerDid: h.dids.manager, metadata: { serial: "PRF-1" },
    });
    assetId = created.json().asset.id;
    const mint = await asUser(h, "admin")("POST", `/api/assets/${assetId}/mint`);
    expect(mint.statusCode).toBe(200);
    expect(mint.json().receipt.txHash).toBeTruthy();

    const detail = await asUser(h, "admin")("GET", `/api/assets/${assetId}`);
    expect(detail.json().proofs.length).toBeGreaterThan(0);
  });

  it("verifies a proof against the chain record", async () => {
    const detail = await asUser(h, "admin")("GET", `/api/assets/${assetId}`);
    const proofId = detail.json().proofs[0].id;
    const res = await asUser(h, "auditor")("POST", `/api/proofs/${proofId}/verify`);
    expect(res.statusCode).toBe(200);
    expect(res.json().verified).toBe(true);
    expect(res.json().checks.length).toBeGreaterThan(0);
    expect(res.json().checks.every((c: any) => c.pass)).toBe(true);
  });

  it("confirms on-chain asset state matches the database", async () => {
    const res = await asUser(h, "admin")("GET", `/api/assets/${assetId}/verify`);
    expect(res.json().verified).toBe(true);
    expect(res.json().checks.every((c: any) => c.pass)).toBe(true);
  });

  it("states plainly what a proof does and does not attest to", async () => {
    const detail = await asUser(h, "admin")("GET", `/api/assets/${assetId}`);
    const proofId = detail.json().proofs[0].id;
    const res = await asUser(h, "auditor")("POST", `/api/proofs/${proofId}/verify`);
    // A proof shows a record existed and is unaltered. It cannot show the underlying
    // business decision was correct, and the API should not let a reader assume it does.
    expect(res.json().scope ?? res.json().disclaimer).toBeTruthy();
  });
});

describe("Audit visibility follows role", () => {
  it("lets an Auditor read organization-wide events", async () => {
    const res = await asUser(h, "auditor")("GET", "/api/audit/events");
    const actors = new Set(res.json().events.map((e: any) => e.actorId));
    expect(actors.size).toBeGreaterThan(1);
  });

  it("limits a plain User to their own events", async () => {
    const res = await asUser(h, "user")("GET", "/api/audit/events");
    expect(res.statusCode).toBe(200);
    const foreign = res.json().events.filter((e: any) => e.actorId && e.actorId !== h.ids.user);
    expect(foreign).toEqual([]);
  });

  it("exports CSV for a capability holder and refuses everyone else", async () => {
    const ok = await asUser(h, "auditor")("GET", "/api/audit/export");
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["content-type"]).toContain("text/csv");

    const denied = await asUser(h, "user")("GET", "/api/audit/export");
    expect(denied.statusCode).toBe(403);
  });
});

/**
 * Deliberately runs last. The tamper case rewrites history in the database on purpose,
 * which permanently breaks the chain for this harness — and correctly causes every
 * subsequent proof verification to fail, since a proof is only as trustworthy as the
 * chain it is anchored in. Placing it earlier would make the later suites fail for a
 * reason that has nothing to do with what they are testing.
 */
describe("The audit chain is tamper-evident", () => {
  it("verifies intact under normal operation", async () => {
    const res = await asUser(h, "auditor")("GET", "/api/audit/verify-chain");
    expect(res.json().valid).toBe(true);
    expect(res.json().eventCount).toBeGreaterThan(0);
  });

  it("detects a tampered payload", async () => {
    const before = await asUser(h, "auditor")("GET", "/api/audit/verify-chain");
    expect(before.json().valid).toBe(true);

    // Reach past the API and rewrite history directly in the database — the exact
    // attack an append-only hash chain exists to make detectable.
    run(`UPDATE audit_events SET payload_json = ? WHERE seq = (SELECT MIN(seq) FROM audit_events WHERE organization_id = ?)`,
      JSON.stringify({ tampered: true }), h.orgId);

    const after = await asUser(h, "auditor")("GET", "/api/audit/verify-chain");
    expect(after.json().valid).toBe(false);
    expect(after.json().brokenAtSeq).not.toBeNull();
    expect(after.json().reason).toBeTruthy();
  });

  it("makes proofs anchored in the broken chain fail verification too", async () => {
    // A proof asserts "this record is unaltered and was anchored". Once the chain it
    // sits in is provably corrupted, that assertion can no longer be honoured — and the
    // system must say so rather than continuing to report a green tick.
    const proofs = await asUser(h, "auditor")("GET", "/api/proofs");
    const proofId = proofs.json().proofs[0]?.id;
    if (!proofId) return;
    const res = await asUser(h, "auditor")("POST", `/api/proofs/${proofId}/verify`);
    expect(res.json().verified).toBe(false);
    expect(res.json().checks.some((c: any) => !c.pass)).toBe(true);
  });
});
