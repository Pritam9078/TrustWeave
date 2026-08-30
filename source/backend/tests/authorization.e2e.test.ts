import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHarness, destroyHarness, asUser, asAgent, type Harness } from "./helpers.js";

/**
 * The mandatory authorization matrix.
 *
 * Each test names a specific way the trust model could fail and asserts it does not.
 * They deliberately go through HTTP (via inject) rather than calling services directly,
 * because the claim being tested is "the API cannot be made to do this", not "the
 * service function returns DENY when called correctly".
 */

let h: Harness;
beforeAll(async () => { h = await createHarness("authz"); }, 60_000);
afterAll(async () => { await destroyHarness(h); });

describe("Unauthorized user cannot reach admin functions", () => {
  it("denies a plain User creating an identity", async () => {
    const res = await asUser(h, "user")("POST", "/api/identities", { displayName: "Mallory" });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("CAPABILITY_MISSING");
  });

  it("denies a plain User creating a role", async () => {
    const res = await asUser(h, "user")("POST", "/api/roles", { name: "Superuser", capabilities: [] });
    expect(res.statusCode).toBe(403);
  });

  it("shows a plain User only their own team, never the whole directory", async () => {
    // IDENTITY_READ means "read the identities you are entitled to see", not "read
    // everyone". Visibility is filtered row-by-row through the actor's scopes, so an
    // Operations user sees Operations colleagues and no one from Finance or Legal.
    const res = await asUser(h, "user")("GET", "/api/identities");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.scopeFiltered).toBe(true);
    expect(body.hiddenByScope).toBeGreaterThan(0);

    const names = body.identities.map((i: any) => i.displayName);
    expect(names).toContain("Ravi User");        // self
    expect(names).toContain("Priya OpsManager"); // same department
    expect(names).not.toContain("Meera Manager");// Finance
    expect(names).not.toContain("Ada Admin");    // no department, org-scope only
  });

  it("shows an access administrator the full directory", async () => {
    const res = await asUser(h, "admin")("GET", "/api/identities");
    expect(res.statusCode).toBe(200);
    expect(res.json().scopeFiltered).toBe(false);
    expect(res.json().identities.length).toBeGreaterThanOrEqual(5);
  });

  it("denies a plain User toggling an emergency flag", async () => {
    const res = await asUser(h, "user")("POST", "/api/security/emergency", { flagKey: "PAYMENTS_DISABLED", enabled: true });
    expect(res.statusCode).toBe(403);
  });

  it("rejects a request with no credential at all", async () => {
    const res = await h.app.inject({ method: "GET", url: "/api/identities" });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a forged bearer token", async () => {
    const res = await h.app.inject({
      method: "GET", url: "/api/identities",
      headers: { authorization: "Bearer sess_not_a_real_token_at_all" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("ignores client-supplied role headers entirely", async () => {
    // The classic frontend-trust bug: claim a role in a header and hope the server reads it.
    const res = await h.app.inject({
      method: "POST", url: "/api/identities",
      headers: {
        authorization: `Bearer ${h.tokens.user}`,
        "x-role": "Admin", "x-capabilities": "IDENTITY_CREATE", "x-organization-id": h.orgId,
      },
      payload: { displayName: "Mallory" },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("Manager acting outside assigned scope is denied", () => {
  it("denies a Finance Manager freezing an Operations asset", async () => {
    const res = await asUser(h, "manager")("POST", `/api/assets/${h.assets.operations}/freeze`, { frozen: true, reason: "test" });
    expect(res.statusCode).toBe(403);
    expect(["SCOPE_VIOLATION", "CAPABILITY_MISSING"]).toContain(res.json().error);
  });

  it("denies a Finance Manager reading a Legal asset detail", async () => {
    const res = await asUser(h, "manager")("GET", `/api/assets/${h.assets.legal}`);
    expect(res.statusCode).toBe(403);
  });

  it("excludes out-of-scope assets from the list, not just the detail route", async () => {
    const res = await asUser(h, "manager")("GET", "/api/assets");
    expect(res.statusCode).toBe(200);
    const names = res.json().assets.map((a: any) => a.name);
    expect(names).toContain("Finance Laptop");
    expect(names).not.toContain("Legal Laptop");
    expect(names).not.toContain("Ops Monitor");
  });

  it("allows the same Manager to act inside their own department", async () => {
    const res = await asUser(h, "manager")("GET", `/api/assets/${h.assets.finance}`);
    expect(res.statusCode).toBe(200);
  });

  it("denies a payment above the Manager's scope amount constraint", async () => {
    // Refused at creation: the amount already breaches the scope constraint, so no
    // draft is stored that could later be mistaken for a pending request.
    const create = await asUser(h, "manager")("POST", "/api/payment-intents", {
      merchant: "Acme Cloud Services", amount: 750000, currency: "INR", purpose: "over scope cap",
    });
    expect(create.statusCode).toBe(403);
    expect(create.json().details.reasonCodes.length).toBeGreaterThan(0);
  });
});

describe("Auditor cannot mutate anything", () => {
  const mutations: [string, string, unknown][] = [
    ["POST", "/api/policies", { policyKey: "sneaky", name: "Sneaky", conditions: { rules: [] } }],
    ["POST", "/api/roles", { name: "Sneaky", capabilities: [] }],
    ["POST", "/api/identities", { displayName: "Sneaky" }],
    ["POST", "/api/collections", { name: "Sneaky" }],
    ["POST", "/api/security/emergency", { flagKey: "AGENTS_DISABLED", enabled: true }],
  ];

  for (const [method, url, payload] of mutations) {
    it(`denies ${method} ${url}`, async () => {
      const res = await asUser(h, "auditor")(method, url, payload);
      expect(res.statusCode).toBe(403);
    });
  }

  it("denies freezing an asset", async () => {
    const res = await asUser(h, "auditor")("POST", `/api/assets/${h.assets.finance}/freeze`, { frozen: true, reason: "x" });
    expect(res.statusCode).toBe(403);
  });

  it("denies approving a payment", async () => {
    const create = await asUser(h, "manager")("POST", "/api/payment-intents", {
      merchant: "Acme Cloud Services", amount: 92000, currency: "INR", purpose: "needs approval",
    });
    const id = create.json().intent.id;
    await asUser(h, "manager")("POST", `/api/payment-intents/${id}/authorize`);
    const approvals = await asUser(h, "admin")("GET", "/api/approvals?status=PENDING");
    const approval = approvals.json().approvals.find((a: any) => a.requestId === id);
    expect(approval).toBeTruthy();
    const res = await asUser(h, "auditor")("POST", `/api/approvals/${approval.id}/decide`, { decision: "APPROVED", note: "" });
    expect(res.statusCode).toBe(403);
  });

  it("still permits the Auditor to read the audit trail", async () => {
    const res = await asUser(h, "auditor")("GET", "/api/audit/events");
    expect(res.statusCode).toBe(200);
    expect(res.json().events.length).toBeGreaterThan(0);
  });

  it("has no mutating capability in the Auditor role template at all", async () => {
    const res = await asUser(h, "auditor")("GET", "/api/session");
    const caps: string[] = res.json().capabilities;
    const mutating = caps.filter((c) => /_(CREATE|UPDATE|DELETE|MINT|TRANSFER|FREEZE|REVOKE|APPROVE|EXECUTE|ASSIGN|ACTIVATE|DISABLE|MANAGE|REGISTER|CONFIGURE)$/.test(c));
    expect(mutating).toEqual([]);
  });
});

describe("Agent cannot escalate its own privileges", () => {
  it("denies an agent creating an identity", async () => {
    const res = await asAgent(h)("POST", "/api/identities", { displayName: "AgentSpawn" });
    expect(res.statusCode).toBe(403);
  });

  it("denies an agent granting itself a capability", async () => {
    const res = await asAgent(h)("PATCH", `/api/agents/${h.agentId}/policy`, {
      capabilities: ["PAYMENT_APPROVE", "IDENTITY_CREATE", "ORG_MANAGE"],
    });
    expect(res.statusCode).toBe(403);
  });

  it("denies an agent adding a tool to its own allowlist", async () => {
    const res = await asAgent(h)("PATCH", `/api/agents/${h.agentId}/policy`, {
      tools: ["get_policy", "get_asset", "search_knowledge", "create_payment_intent", "request_asset_transfer"],
    });
    expect(res.statusCode).toBe(403);
  });

  it("denies an agent raising its own transaction limit", async () => {
    const res = await asAgent(h)("PATCH", `/api/agents/${h.agentId}/policy`, {
      limits: { transactionLimit: 10_000_000 },
    });
    expect(res.statusCode).toBe(403);
  });

  it("denies an agent approving a payment even if it created it", async () => {
    const created = await asAgent(h)("POST", "/api/agents/tools/invoke", {
      tool: "create_payment_intent",
      args: { merchant: "Acme Cloud Services", amount: 92000, currency: "INR", purpose: "self approve attempt", evidenceIds: ["x"] },
    });
    const approvalId = created.json().approvalId;
    if (approvalId) {
      const res = await asAgent(h)("POST", `/api/approvals/${approvalId}/decide`, { decision: "APPROVED", note: "" });
      expect(res.statusCode).toBe(403);
    }
  });

  it("denies an agent calling a tool outside its allowlist", async () => {
    const res = await asAgent(h)("POST", "/api/agents/tools/invoke", {
      tool: "request_asset_transfer",
      args: { assetId: h.assets.finance, newOwnerDid: h.dids.user, reason: "not on my allowlist" },
    });
    expect(res.json().decision).toBe("DENY");
    expect(res.json().reasonCodes).toContain("AGENT_TOOL_NOT_ALLOWED");
  });

  it("denies a tool that does not exist in the registry", async () => {
    const res = await asAgent(h)("POST", "/api/agents/tools/invoke", {
      tool: "execute_arbitrary_sql", args: { sql: "DROP TABLE identities" },
    });
    expect(res.json().decision).toBe("DENY");
    expect(res.json().reasonCodes).toContain("TOOL_UNKNOWN");
  });

  it("rejects an admin granting an agent a capability the admin lacks", async () => {
    // The Manager holds PAYMENT_APPROVE but not ORG_MANAGE.
    const res = await asUser(h, "manager")("POST", "/api/agents", {
      name: "OverreachAgent", capabilities: ["ORG_MANAGE"], tools: [], scopeIds: [], limits: {},
    });
    expect(res.statusCode).toBe(403);
  });
});
