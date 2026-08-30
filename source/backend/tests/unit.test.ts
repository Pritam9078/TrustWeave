import { describe, it, expect } from "vitest";
import { evaluatePolicy } from "../src/authorization/policy.js";
import { scopeMatches, findMatchingScope, withinTimeWindow } from "../src/authorization/scope.js";
import { canonicalStringify, sha256Hex, hashObject, safeEqual } from "../src/core/hash.js";
import { generateKeypair, signChallenge, verifyChallenge, challengeMessage } from "../src/auth/did.js";
import { CAPABILITIES, ROLE_TEMPLATES } from "../src/authorization/capabilities.js";

/** Unit coverage for the pure, dependency-free layers. */

describe("canonical hashing", () => {
  it("is insensitive to key order", () => {
    expect(canonicalStringify({ b: 1, a: 2 })).toBe(canonicalStringify({ a: 2, b: 1 }));
  });

  it("is sensitive to value changes", () => {
    expect(hashObject({ amount: 1000 })).not.toBe(hashObject({ amount: 1001 }));
  });

  it("distinguishes nested reorderings from real edits", () => {
    const a = hashObject({ x: { p: 1, q: 2 }, y: [1, 2] });
    const b = hashObject({ y: [1, 2], x: { q: 2, p: 1 } });
    const c = hashObject({ y: [2, 1], x: { q: 2, p: 1 } });
    expect(a).toBe(b);      // key order is not information
    expect(a).not.toBe(c);  // array order is
  });

  it("compares digests without leaking timing", () => {
    const h = sha256Hex("x");
    expect(safeEqual(h, h)).toBe(true);
    expect(safeEqual(h, sha256Hex("y"))).toBe(false);
    expect(safeEqual(h, "short")).toBe(false);
  });
});

describe("DID challenge/response", () => {
  it("accepts a correctly signed challenge", () => {
    const { did, privateKeyB64 } = generateKeypair();
    const signature = signChallenge(privateKeyB64, did, "nonce-1");
    expect(verifyChallenge(did, "nonce-1", signature)).toBe(true);
  });

  it("rejects a signature made by a different key", () => {
    const a = generateKeypair();
    const b = generateKeypair();
    const signature = signChallenge(b.privateKeyB64, a.did, "nonce-2");
    expect(verifyChallenge(a.did, "nonce-2", signature)).toBe(false);
  });

  it("rejects replay of a signature against a different nonce", () => {
    // The nonce is bound into the signed message, so a signature harvested from one
    // login cannot be replayed against a fresh challenge.
    const { did, privateKeyB64 } = generateKeypair();
    const signature = signChallenge(privateKeyB64, did, "nonce-3");
    expect(verifyChallenge(did, "nonce-4", signature)).toBe(false);
  });

  it("binds the signature to the DID, not just the nonce", () => {
    const a = generateKeypair();
    const b = generateKeypair();
    const signature = signChallenge(a.privateKeyB64, a.did, "shared-nonce");
    expect(verifyChallenge(b.did, "shared-nonce", signature)).toBe(false);
  });

  it("returns false on malformed input instead of throwing", () => {
    const { did } = generateKeypair();
    expect(verifyChallenge(did, "n", "not-a-signature")).toBe(false);
    expect(verifyChallenge("did:key:nonsense", "n", "aGk")).toBe(false);
    expect(verifyChallenge("", "", "")).toBe(false);
  });

  it("builds the same challenge message on both sides", () => {
    const { did } = generateKeypair();
    expect(challengeMessage(did, "n1")).toBe(challengeMessage(did, "n1"));
    expect(challengeMessage(did, "n1")).not.toBe(challengeMessage(did, "n2"));
  });
});

describe("scope matching fails closed", () => {
  const dept = { id: "s1", organizationId: "org1", name: "Finance", scopeType: "DEPARTMENT", selector: { departmentIds: ["d-fin"] }, constraints: {} };

  it("matches a resource inside the department", () => {
    expect(scopeMatches(dept as any, { type: "ASSET", departmentId: "d-fin", organizationId: "org1" })).toBe(true);
  });

  it("refuses a resource in another department", () => {
    expect(scopeMatches(dept as any, { type: "ASSET", departmentId: "d-ops", organizationId: "org1" })).toBe(false);
  });

  it("refuses a resource with no department at all", () => {
    expect(scopeMatches(dept as any, { type: "ASSET", organizationId: "org1" })).toBe(false);
  });

  it("refuses an unknown scope type rather than defaulting to allow", () => {
    const weird = { ...dept, scopeType: "GALAXY" };
    expect(scopeMatches(weird as any, { type: "ASSET", departmentId: "d-fin", organizationId: "org1" })).toBe(false);
  });

  it("denies when the actor holds no scopes at all", () => {
    expect(findMatchingScope([], { type: "ASSET", departmentId: "d-fin", organizationId: "org1" }).matched).toBe(false);
  });
});

describe("time windows", () => {
  const at = (h: number, m = 0) => { const d = new Date(); d.setHours(h, m, 0, 0); return d; };

  it("accepts a time inside a normal window", () => {
    expect(withinTimeWindow({ from: "09:00", to: "17:00" }, at(12))).toBe(true);
  });

  it("rejects a time outside it", () => {
    expect(withinTimeWindow({ from: "09:00", to: "17:00" }, at(20))).toBe(false);
  });

  it("interprets the window in its declared timezone, not the server's", () => {
    // 12:00 UTC is 17:30 IST. A 17:00–18:00 IST window must accept it, and a 17:00–18:00
    // window with no declared offset must not (on a UTC server).
    const noon = new Date(Date.UTC(2026, 0, 15, 12, 0, 0));
    expect(withinTimeWindow({ from: "17:00", to: "18:00", timezoneOffsetMinutes: 330 }, noon)).toBe(true);
    expect(withinTimeWindow({ from: "11:00", to: "13:00", timezoneOffsetMinutes: 330 }, noon)).toBe(false);
  });

  it("fails closed on a malformed window instead of throwing", () => {
    // A misconfigured window must deny, never crash the engine — a 500 would leave the
    // caller unable to tell a denial from a broken check.
    expect(withinTimeWindow({ from: "9:00", to: "notatime" }, at(12))).toBe(false);
    expect(withinTimeWindow({}, at(12))).toBe(false);
    expect(withinTimeWindow(null, at(12))).toBe(false);
    expect(withinTimeWindow({ from: "25:00", to: "26:00" }, at(12))).toBe(false);
  });

  it("handles a window that crosses midnight", () => {
    expect(withinTimeWindow({ from: "22:00", to: "06:00" }, at(23))).toBe(true);
    expect(withinTimeWindow({ from: "22:00", to: "06:00" }, at(3))).toBe(true);
    expect(withinTimeWindow({ from: "22:00", to: "06:00" }, at(12))).toBe(false);
  });
});

describe("policy evaluation", () => {
  const policy = (rules: any[]) => ({
    id: "p1", policyKey: "k", organizationId: "org1", name: "P", version: 1,
    status: "ACTIVE", conditions: { rules }, appliesTo: {}, hash: "h",
  }) as any;

  const params = (over: any = {}) => ({
    actorDepartmentId: "d-fin",
    resource: { type: "PAYMENT", departmentId: "d-fin" } as any,
    context: { amount: 10000, currency: "INR", merchant: "Acme", ...over },
  });

  it("allows when every rule passes", () => {
    expect(evaluatePolicy(policy([{ type: "AMOUNT_MAX", value: 50000 }]), params()).decision).toBe("ALLOW");
  });

  it("denies above a hard maximum", () => {
    expect(evaluatePolicy(policy([{ type: "AMOUNT_MAX", value: 5000, onFail: "DENY" }]), params()).decision).toBe("DENY");
  });

  it("routes to approval above a threshold", () => {
    expect(evaluatePolicy(policy([{ type: "APPROVAL_THRESHOLD", value: 5000 }]), params()).decision).toBe("REQUIRE_APPROVAL");
  });

  it("lets DENY beat REQUIRE_APPROVAL when both fire", () => {
    // A blocked vendor is not something an approver may wave through, so the harder
    // outcome has to win regardless of rule order.
    const r = evaluatePolicy(policy([
      { type: "APPROVAL_THRESHOLD", value: 5000 },
      { type: "MERCHANT_BLOCKLIST", values: ["Acme"], onFail: "DENY" },
    ]), params());
    expect(r.decision).toBe("DENY");
  });

  it("fails closed on an unrecognised rule type", () => {
    expect(evaluatePolicy(policy([{ type: "SOMETHING_NEW", value: 1 }]), params()).decision).toBe("DENY");
  });

  it("evaluates every rule rather than stopping at the first pass", () => {
    const r = evaluatePolicy(policy([
      { type: "AMOUNT_MAX", value: 999999 },
      { type: "CURRENCY_ALLOWLIST", values: ["INR"], onFail: "DENY" },
      { type: "MERCHANT_BLOCKLIST", values: ["Acme"], onFail: "DENY" },
    ]), params());
    expect(r.decision).toBe("DENY");
    expect(r.steps.length).toBeGreaterThanOrEqual(3);
  });

  it("denies a currency outside the allowlist", () => {
    const r = evaluatePolicy(policy([{ type: "CURRENCY_ALLOWLIST", values: ["INR"], onFail: "DENY" }]), params({ currency: "USD" }));
    expect(r.decision).toBe("DENY");
  });

  it("requires evidence when the rule demands it", () => {
    const r = evaluatePolicy(policy([{ type: "REQUIRE_EVIDENCE", min: 1, onFail: "DENY" }]), params({ evidenceCount: 0 }));
    expect(r.decision).toBe("DENY");
  });

  it("is deterministic across repeated evaluation", () => {
    const p = policy([{ type: "APPROVAL_THRESHOLD", value: 5000 }]);
    const a = evaluatePolicy(p, params());
    const b = evaluatePolicy(p, params());
    expect(a.decision).toBe(b.decision);
    expect(a.reasonCodes).toEqual(b.reasonCodes);
  });
});

describe("capability catalog integrity", () => {
  it("has no duplicate capability keys", () => {
    const keys = CAPABILITIES.map((c) => c.action);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("only references catalog capabilities in role templates", () => {
    const known = new Set(CAPABILITIES.map((c) => c.action));
    for (const [role, tpl] of Object.entries(ROLE_TEMPLATES)) {
      for (const cap of tpl.capabilities) {
        expect(known.has(cap), `${role} references unknown capability ${cap}`).toBe(true);
      }
    }
  });

  it("gives the Auditor role no mutating capability", () => {
    const mutating = ROLE_TEMPLATES.Auditor.capabilities.filter((c) =>
      /_(CREATE|UPDATE|DELETE|MINT|TRANSFER|FREEZE|REVOKE|APPROVE|EXECUTE|ASSIGN|ACTIVATE|DISABLE|MANAGE|REGISTER|CONFIGURE|SUSPEND|INVOKE|CONTROL)$/.test(c));
    expect(mutating).toEqual([]);
  });

  it("gives the plain User role no administrative capability", () => {
    const admin = ROLE_TEMPLATES.User.capabilities.filter((c) =>
      /^(IDENTITY_CREATE|ROLE_|CAPABILITY_ASSIGN|SCOPE_CREATE|POLICY_(CREATE|UPDATE|ACTIVATE|DISABLE)|ORG_MANAGE|EMERGENCY_)/.test(c));
    expect(admin).toEqual([]);
  });
});
