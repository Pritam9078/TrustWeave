import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHarness, destroyHarness, asUser, asAgent, PASSWORD, type Harness } from "./helpers.js";
import { newId, newTraceId } from "../src/core/ids.js";
import { nowIso } from "../src/core/time.js";
import { run } from "../src/db/client.js";
import * as orgService from "../src/services/orgService.js";
import * as identityService from "../src/services/identityService.js";
import * as assetService from "../src/services/assetService.js";
import { ROLE_TEMPLATES } from "../src/authorization/capabilities.js";

/**
 * Cross-tenant isolation and end-to-end sign-in resolution.
 *
 * A second organization is created inside the same database so the tenant boundary is
 * tested where it actually matters — one process, one schema, two orgs — rather than
 * being assumed because the data happens to live elsewhere.
 */

let h: Harness;
let other: { orgId: string; adminId: string; token: string; assetId: string };

beforeAll(async () => {
  h = await createHarness("tenancy");

  const orgId = newId("org");
  run(`INSERT INTO organizations (id, name, slug, created_at) VALUES (?,?,?,?)`,
    orgId, "Eastwind Rival Ltd", `eastwind-${Math.random().toString(36).slice(2, 8)}`, nowIso());

  const dept = orgService.createDepartment(orgId, "Finance", "FIN");
  const adminRole = orgService.createRole(orgId, {
    name: "Admin", description: "rival admin", capabilities: [...ROLE_TEMPLATES.Admin.capabilities],
  });
  const scope = orgService.createScope(orgId, {
    name: "Whole org", scopeType: "ORGANIZATION", selector: { organizationId: orgId }, constraints: {},
  });
  orgService.attachScopeToRole(adminRole.id, scope.id);

  const { identity } = identityService.createIdentity({
    organizationId: orgId, displayName: "Rival Admin", email: "rival@eastwind.test",
    kind: "HUMAN", departmentId: dept.id, password: PASSWORD, status: "ACTIVE",
  });
  const membership = identityService.getMembership(identity.id, orgId)!;
  identityService.assignRole(membership.id, adminRole.id, "system");

  const rivalActor = identityService.buildActorContext(identity.id, orgId)!;
  const asset = assetService.createAsset(rivalActor, newTraceId(), {
    name: "Rival Laptop", assetType: "LAPTOP", collectionId: null,
    departmentId: dept.id, ownerDid: identity.did, metadata: { serial: "RIV-1" },
  });

  const login = await h.app.inject({
    method: "POST", url: "/api/auth/login",
    payload: { email: "rival@eastwind.test", password: PASSWORD },
  });

  other = { orgId, adminId: identity.id, token: login.json().token, assetId: asset.id };
}, 60_000);

afterAll(async () => { await destroyHarness(h); });

const asRival = (method: any, url: string, payload?: unknown) =>
  h.app.inject({ method, url, headers: { authorization: `Bearer ${other.token}` }, payload: payload as any });

describe("Sign-in resolves the full authorization context", () => {
  it("returns identity, organization, roles, capabilities, scopes and workspace", async () => {
    const res = await asUser(h, "manager")("GET", "/api/session");
    expect(res.statusCode).toBe(200);
    const s = res.json();
    expect(s.identity.did).toMatch(/^did:key:/);
    expect(s.organization.id).toBe(h.orgId);
    expect(s.roles.map((r: any) => r.name)).toContain("Manager");
    expect(s.capabilities.length).toBeGreaterThan(0);
    expect(s.scopes.length).toBeGreaterThan(0);
    expect(s.workspace).toBe("manager");
  });

  it("routes each role to its own workspace", async () => {
    const expected: Record<string, string> = { admin: "admin", manager: "manager", auditor: "auditor", user: "user" };
    for (const [who, workspace] of Object.entries(expected)) {
      const res = await asUser(h, who as any)("GET", "/api/session");
      expect(res.json().workspace, `${who} should land in ${workspace}`).toBe(workspace);
    }
  });

  it("invalidates the session the moment the identity is suspended", async () => {
    const before = await asUser(h, "opsmgr")("GET", "/api/session");
    expect(before.statusCode).toBe(200);

    await asUser(h, "admin")("PATCH", `/api/identities/${h.ids.opsmgr}/status`, { status: "SUSPENDED", reason: "test" });

    const after = await asUser(h, "opsmgr")("GET", "/api/session");
    expect(after.statusCode).toBeGreaterThanOrEqual(401);

    await asUser(h, "admin")("PATCH", `/api/identities/${h.ids.opsmgr}/status`, { status: "ACTIVE", reason: "restore" });
  });
});

describe("Cross-tenant access is refused", () => {
  it("denies reading another organization's asset by id", async () => {
    const res = await asUser(h, "admin")("GET", `/api/assets/${other.assetId}`);
    expect(res.statusCode).toBe(404); // not even acknowledged as existing
  });

  it("denies the rival admin reading our asset, despite holding every capability", async () => {
    const res = await asRival("GET", `/api/assets/${h.assets.finance}`);
    expect(res.statusCode).toBe(404);
  });

  it("denies mutating another organization's asset", async () => {
    const res = await asUser(h, "admin")("POST", `/api/assets/${other.assetId}/freeze`, { frozen: true, reason: "x" });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  it("denies reading another organization's identity", async () => {
    const res = await asUser(h, "admin")("GET", `/api/identities/${other.adminId}`);
    expect(res.statusCode).toBe(404);
  });

  it("never leaks another organization's rows into a list", async () => {
    const assets = await asUser(h, "admin")("GET", "/api/assets");
    expect(assets.json().assets.map((a: any) => a.id)).not.toContain(other.assetId);

    const identities = await asUser(h, "admin")("GET", "/api/identities");
    expect(identities.json().identities.map((i: any) => i.id)).not.toContain(other.adminId);

    const audit = await asUser(h, "auditor")("GET", "/api/audit/events");
    const foreign = audit.json().events.filter((e: any) => e.organizationId && e.organizationId !== h.orgId);
    expect(foreign).toEqual([]);
  });

  it("ignores a forged organizationId in the request body", async () => {
    // The organization comes from the session, never from the payload.
    const res = await asRival("POST", "/api/assets", {
      name: "Injected", assetType: "LAPTOP", metadata: {},
      organizationId: h.orgId, departmentId: h.departments.finance,
    });
    // Either rejected as an unknown field, or created inside the rival's own org.
    if (res.statusCode < 300) {
      const created = res.json().asset;
      const ours = await asUser(h, "admin")("GET", `/api/assets/${created.id}`);
      expect(ours.statusCode).toBe(404);
    } else {
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
    }
  });

  it("refuses an agent key against another organization's resources", async () => {
    const res = await asAgent(h)("POST", "/api/agents/tools/invoke", {
      tool: "get_asset", args: { assetId: other.assetId },
    });
    expect(res.json().decision).toBe("DENY");
  });

  it("keeps each organization's audit chain independently valid", async () => {
    const ours = await asUser(h, "auditor")("GET", "/api/audit/verify-chain");
    const theirs = await asRival("GET", "/api/audit/verify-chain");
    expect(ours.json().valid).toBe(true);
    expect(theirs.json().valid).toBe(true);
    expect(ours.json().headHash).not.toBe(theirs.json().headHash);
  });
});

describe("Tenant isolation holds at the data layer", () => {
  it("namespaces idempotency keys per organization", async () => {
    // The same client-chosen key in two organizations must produce two independent
    // payments. A globally unique key would turn one tenant's routine retry into either
    // a cross-tenant read or an unexplainable conflict.
    const key = "shared-client-key-001";
    const ours = await asUser(h, "manager")("POST", "/api/payment-intents", {
      merchant: "Acme Cloud Services", amount: 1500, currency: "INR", purpose: "ours", idempotencyKey: key,
    });
    const theirs = await asRival("POST", "/api/payment-intents", {
      merchant: "Acme Cloud Services", amount: 2500, currency: "INR", purpose: "theirs", idempotencyKey: key,
    });
    expect(ours.statusCode).toBe(201);
    expect(theirs.statusCode).toBe(201);
    expect(theirs.json().deduplicated).toBeFalsy();
    expect(theirs.json().intent.id).not.toBe(ours.json().intent.id);
    expect(theirs.json().intent.amount).toBe(2500);

    // And a genuine retry inside one organization still deduplicates.
    const retry = await asUser(h, "manager")("POST", "/api/payment-intents", {
      merchant: "Acme Cloud Services", amount: 1500, currency: "INR", purpose: "ours", idempotencyKey: key,
    });
    expect(retry.json().deduplicated).toBe(true);
    expect(retry.json().intent.id).toBe(ours.json().intent.id);
  });

  it("scopes approval idempotency to one organization", async () => {
    // createApproval deduplicates on (requestType, requestId). Without a tenant
    // predicate that dedupe window spans organizations.
    const ours = await asUser(h, "manager")("POST", "/api/payment-intents", {
      merchant: "Globex Logistics", amount: 92000, currency: "INR", purpose: "approval scope",
    });
    const id = ours.json().intent.id;
    const auth = await asUser(h, "manager")("POST", `/api/payment-intents/${id}/authorize`);
    expect(auth.json().decision).toBe("REQUIRE_APPROVAL");

    // The rival organization must not see it in its own approval queue.
    const rivalQueue = await asRival("GET", "/api/approvals?status=PENDING");
    expect(rivalQueue.json().approvals.map((a: any) => a.requestId)).not.toContain(id);
  });

  it("does not leak a security event across tenants on acknowledge", async () => {
    const events = await asUser(h, "admin")("GET", "/api/security/events");
    const anyEvent = events.json().events[0];
    if (!anyEvent) return;
    const res = await asRival("POST", `/api/security/events/${anyEvent.id}/acknowledge`, {});
    // Either refused, or a no-op — but never a confirmation that mutated our row.
    const after = await asUser(h, "admin")("GET", "/api/security/events");
    const ours = after.json().events.find((e: any) => e.id === anyEvent.id);
    expect(ours.acknowledgedAt).toBe(anyEvent.acknowledgedAt);
    expect([200, 403, 404]).toContain(res.statusCode);
  });
});

describe("Direct URL access cannot bypass the frontend", () => {
  const adminOnly = [
    "/api/identities", "/api/roles", "/api/scopes", "/api/policies",
    "/api/security/events", "/api/security/emergency", "/api/integrations/status",
  ];

  for (const url of adminOnly) {
    it(`denies a plain User hitting ${url} directly`, async () => {
      const res = await asUser(h, "user")("GET", url);
      // Either refused outright, or scope-filtered to nothing privileged.
      if (res.statusCode === 200) {
        const body = res.json();
        if (Array.isArray(body.identities)) expect(body.scopeFiltered).toBe(true);
        else expect(res.statusCode).toBe(403);
      } else {
        expect(res.statusCode).toBe(403);
      }
    });
  }

  it("denies a User the admin-only mutations regardless of route knowledge", async () => {
    const attempts: [string, string, unknown][] = [
      ["POST", "/api/roles", { name: "x", capabilities: [] }],
      ["POST", "/api/scopes", { name: "x", scopeType: "ORGANIZATION", selector: {} }],
      ["POST", "/api/policies", { policyKey: "x", name: "x", conditions: { rules: [] } }],
      ["POST", "/api/agents", { name: "x", capabilities: [], tools: [], scopeIds: [], limits: {} }],
      ["POST", "/api/security/emergency", { flagKey: "PAYMENTS_DISABLED", enabled: true }],
      ["POST", "/api/knowledge/documents", { sourceType: "X", title: "x", content: "x" }],
    ];
    for (const [method, url, payload] of attempts) {
      const res = await asUser(h, "user")(method, url, payload);
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
  });
});
