import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHarness, destroyHarness, asUser, type Harness } from "./helpers.js";
import { withinTimeWindow, scopeMatches } from "../src/authorization/scope.js";
import { normalizeSelector, normalizeConstraints } from "../src/services/orgService.js";
import { CAPABILITIES } from "../src/authorization/capabilities.js";
import { many } from "../src/db/client.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Regression tests for bugs found during the rebuild.
 *
 * Each one pins the *specific* defect, so a future refactor that reintroduces it fails
 * here with a name that says what broke rather than surfacing as a mysterious denial
 * three layers away.
 */

let h: Harness;
beforeAll(async () => { h = await createHarness("regress"); }, 60_000);
afterAll(async () => { await destroyHarness(h); });

describe("Regression: every capability referenced by a route exists in the catalog", () => {
  // INTEGRATION_READ was enforced by a route but never defined, so the engine rejected it
  // as unknown and the page was unreachable for everyone including Admin.
  it("defines INTEGRATION_READ", () => {
    expect(CAPABILITIES.map((c) => c.action)).toContain("INTEGRATION_READ");
  });

  it("allows a permitted user to read integration status", async () => {
    for (const who of ["admin", "auditor"] as const) {
      const res = await asUser(h, who)("GET", "/api/integrations/status");
      expect(res.statusCode, `${who} should be allowed`).toBe(200);
      expect(res.json().blockchain.mode).toBeTruthy();
    }
  });

  it("denies it to a plain User", async () => {
    const res = await asUser(h, "user")("GET", "/api/integrations/status");
    expect(res.statusCode).toBe(403);
  });

  it("has no route enforcing a capability the catalog does not define", () => {
    // Scans the route sources for authz.enforce({ action: "X" }) and cross-checks the
    // catalog, so a future route cannot quietly enforce a capability that can never pass.
    const known = new Set(CAPABILITIES.map((c) => c.action));
    const routeDir = join(process.cwd(), "src", "routes");
    const files = ["admin.ts", "assets.ts", "agents.ts", "payments.ts", "audit.ts", "knowledge.ts", "dashboard.ts"];
    const missing: string[] = [];
    let enforced = 0;

    for (const file of files) {
      const source = readFileSync(join(routeDir, file), "utf8");
      // Only the `action` passed to authz.enforce/check is a capability. The identically
      // named field on audit.record is a free-text event name (IDENTITY_CREATED etc.) and
      // is deliberately not constrained to the catalog.
      for (const call of source.matchAll(/authz\.(?:enforce|check)\(\s*\{/g)) {
        const window = source.slice(call.index!, call.index! + 400);
        const literal = /action:\s*"([A-Z_]+)"/.exec(window);
        if (!literal) continue;  // dynamic, e.g. approval.required_capability
        enforced++;
        if (!known.has(literal[1])) missing.push(`${file}: ${literal[1]}`);
      }
    }

    expect(enforced, "the scan should have found enforced capabilities").toBeGreaterThan(10);
    expect(missing).toEqual([]);
  });
});

describe("Regression: payment_intents uses `state`, not `status`", () => {
  // The dashboard queried a column that does not exist, returning a hard 500 on the
  // primary landing page for every role.
  it("has a `state` column and no `status` column", () => {
    const columns = many<any>(`PRAGMA table_info(payment_intents)`).map((c: any) => c.name);
    expect(columns).toContain("state");
    expect(columns).not.toContain("status");
  });

  it("loads the dashboard for every role without error", async () => {
    for (const who of ["admin", "manager", "auditor", "user"] as const) {
      const res = await asUser(h, who)("GET", "/api/dashboard");
      expect(res.statusCode, `${who} dashboard`).toBe(200);
    }
  });

  it("counts payments by state on the dashboard", async () => {
    await asUser(h, "manager")("POST", "/api/payment-intents", {
      merchant: "Acme Cloud Services", amount: 4000, currency: "INR", purpose: "regression",
    });
    const res = await asUser(h, "admin")("GET", "/api/dashboard");
    expect(res.json().payments).toBeTruthy();
    expect(typeof res.json().payments.pendingApproval).toBe("number");
  });
});

describe("Regression: scope selectors are canonicalised at write time", () => {
  // Scopes were written with a singular key the matcher never read, so every
  // department-scoped actor was silently denied everything.
  it("accepts the singular form and stores the plural the matcher reads", () => {
    const selector = normalizeSelector("DEPARTMENT", { departmentId: "d-fin" });
    expect(selector).toEqual({ departmentIds: ["d-fin"] });
  });

  it("rejects a selector with no recognisable key instead of silently denying later", () => {
    expect(() => normalizeSelector("DEPARTMENT", { department: "d-fin" })).toThrow();
    expect(() => normalizeSelector("VENDOR", {})).toThrow();
  });

  it("rejects an empty selector, which would match nothing", () => {
    expect(() => normalizeSelector("DEPARTMENT", { departmentIds: [] })).toThrow();
  });

  it("produces a scope that actually matches its department", () => {
    const scope = {
      id: "s1", organizationId: "org1", name: "Finance", scopeType: "DEPARTMENT",
      selector: normalizeSelector("DEPARTMENT", { departmentId: "d-fin" }), constraints: {},
    };
    expect(scopeMatches(scope as any, { type: "ASSET", departmentId: "d-fin", organizationId: "org1" })).toBe(true);
    expect(scopeMatches(scope as any, { type: "ASSET", departmentId: "d-ops", organizationId: "org1" })).toBe(false);
  });

  it("lets a department-scoped Manager reach their own department end to end", async () => {
    const res = await asUser(h, "manager")("GET", `/api/assets/${h.assets.finance}`);
    expect(res.statusCode).toBe(200);
  });
});

describe("Regression: time-window constraints are normalised and timezone-aware", () => {
  // Windows were written as {start,end} but read as {from,to}, which threw inside the
  // engine and surfaced as a 500 — indistinguishable from a denial to the caller.
  it("canonicalises {start,end} to {from,to}", () => {
    const constraints = normalizeConstraints({ timeWindow: { start: "09:00", end: "18:00" } });
    expect(constraints.timeWindow).toEqual({ from: "09:00", to: "18:00" });
  });

  it("rejects an unparseable window at write time", () => {
    expect(() => normalizeConstraints({ timeWindow: { from: "9am", to: "6pm" } })).toThrow();
    expect(() => normalizeConstraints({ timeWindow: { from: "09:00" } })).toThrow();
  });

  it("fails closed rather than throwing when a window is malformed", () => {
    const noon = new Date(Date.UTC(2026, 0, 15, 12, 0, 0));
    expect(withinTimeWindow({ from: "09:00", to: "bad" }, noon)).toBe(false);
    expect(withinTimeWindow(null, noon)).toBe(false);
    expect(withinTimeWindow({ from: "25:00", to: "26:00" }, noon)).toBe(false);
  });

  it("interprets 09:00–17:00 IST as IST, not as server-local time", () => {
    const window = { from: "09:00", to: "17:00", timezoneOffsetMinutes: 330 };
    // 05:00 UTC = 10:30 IST — inside the window.
    expect(withinTimeWindow(window, new Date(Date.UTC(2026, 0, 15, 5, 0, 0)))).toBe(true);
    // 14:00 UTC = 19:30 IST — outside it.
    expect(withinTimeWindow(window, new Date(Date.UTC(2026, 0, 15, 14, 0, 0)))).toBe(false);
    // 23:00 UTC = 04:30 IST next day — outside it.
    expect(withinTimeWindow(window, new Date(Date.UTC(2026, 0, 15, 23, 0, 0)))).toBe(false);
  });

  it("still handles a midnight-crossing window in a declared timezone", () => {
    const nightShift = { from: "22:00", to: "06:00", timezoneOffsetMinutes: 330 };
    // 18:00 UTC = 23:30 IST — inside.
    expect(withinTimeWindow(nightShift, new Date(Date.UTC(2026, 0, 15, 18, 0, 0)))).toBe(true);
    // 06:00 UTC = 11:30 IST — outside.
    expect(withinTimeWindow(nightShift, new Date(Date.UTC(2026, 0, 15, 6, 0, 0)))).toBe(false);
  });

  it("creates a working scope through the API using the singular/start-end forms", async () => {
    const res = await asUser(h, "admin")("POST", "/api/scopes", {
      name: "Regression scope", scopeType: "DEPARTMENT",
      selector: { departmentId: h.departments.operations },
      constraints: { maxAmount: 1000, timeWindow: { start: "00:00", end: "23:59" } },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().scope.selector).toEqual({ departmentIds: [h.departments.operations] });
    expect(res.json().scope.constraints.timeWindow).toEqual({ from: "00:00", to: "23:59" });
  });
});

describe("Regression: an AI denial must come from the engine, not the parser", () => {
  it("does not report INVALID_ARGUMENTS for a well-formed over-limit request", async () => {
    const res = await h.app.inject({
      method: "POST", url: "/api/agents/task",
      headers: { "x-agent-key": h.agentKey },
      payload: { instruction: "Pay Acme Cloud Services 250000 INR for a renewal.", execute: true },
    });
    const body = res.json();
    expect(body.toolCall).toBeTruthy();
    expect(body.toolCall.reasonCodes).not.toContain("INVALID_ARGUMENTS");
    expect(body.toolCall.decision).toBe("DENY");
  });
});

describe("Regression: PAYMENT_CREATE is enforced at draft creation, not only at authorization", () => {
  // A draft could previously be written by any authenticated actor. It could never
  // execute, but it let the read-only Auditor mutate state and put rows in front of an
  // approver — contradicting the guarantee the Auditor role exists to provide.
  it("denies an Auditor creating a payment intent", async () => {
    const res = await asUser(h, "auditor")("POST", "/api/payment-intents", {
      merchant: "Acme Cloud Services", amount: 1000, currency: "INR", purpose: "regression",
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("CAPABILITY_MISSING");
  });

  it("denies a plain User creating a payment intent", async () => {
    const res = await asUser(h, "user")("POST", "/api/payment-intents", {
      merchant: "Acme Cloud Services", amount: 1000, currency: "INR", purpose: "regression",
    });
    expect(res.statusCode).toBe(403);
  });

  it("still allows a Manager who holds the capability", async () => {
    const res = await asUser(h, "manager")("POST", "/api/payment-intents", {
      merchant: "Acme Cloud Services", amount: 1000, currency: "INR", purpose: "regression",
    });
    expect(res.statusCode).toBe(201);
  });

  it("writes the refusal to the audit trail", async () => {
    await asUser(h, "auditor")("POST", "/api/payment-intents", {
      merchant: "Acme Cloud Services", amount: 2500, currency: "INR", purpose: "audited denial",
    });
    const events = await asUser(h, "auditor")("GET", "/api/audit/events?decision=DENY");
    expect(events.json().events.length).toBeGreaterThan(0);
  });
});
