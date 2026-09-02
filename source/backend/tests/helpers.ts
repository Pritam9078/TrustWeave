import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { initDb, closeDb, run, one } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { newId, newTraceId } from "../src/core/ids.js";
import { nowIso } from "../src/core/time.js";
import * as orgService from "../src/services/orgService.js";
import * as identityService from "../src/services/identityService.js";
import * as policyService from "../src/services/policyService.js";
import * as assetService from "../src/services/assetService.js";
import * as agentService from "../src/services/agentService.js";
import * as ragService from "../src/services/ragService.js";
import { ROLE_TEMPLATES } from "../src/authorization/capabilities.js";
import { rmSync } from "node:fs";

export interface Harness {
  app: FastifyInstance;
  orgId: string;
  departments: { finance: string; operations: string; legal: string };
  tokens: Record<"admin" | "manager" | "auditor" | "user" | "opsmgr", string>;
  ids: Record<string, string>;
  dids: Record<string, string>;
  agentKey: string;
  agentId: string;
  agentDid: string;
  assets: Record<string, string>;
  scopes: Record<string, string>;
  roles: Record<string, string>;
  dbFile: string;
}

const PASSWORD = "TestPassword!2026";

/**
 * Builds a complete, isolated organization per test file. Each harness gets its own
 * database file so suites cannot contaminate one another's audit chains — the chain
 * verification tests in particular are meaningless if another suite is appending rows
 * concurrently.
 */
export async function createHarness(label: string): Promise<Harness> {
  const dbFile = `/tmp/trustweave-test-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`;
  process.env.DATABASE_FILE = dbFile;
  process.env.ALLOW_PASSWORD_LOGIN = "true";
  process.env.NODE_ENV = "test";
  process.env.BLOCKCHAIN_ADAPTER = "memory";
  const { setBlockchainAdapter, InMemoryBlockchainAdapter } = await import("../src/adapters/blockchain/index.js");
  setBlockchainAdapter(new InMemoryBlockchainAdapter());

  await initDb(dbFile);
  await migrate();
  await orgService.syncCapabilityCatalog();

  const orgId = newId("org");
  run(`INSERT INTO organizations (id, name, slug, created_at) VALUES (?,?,?,?)`,
    orgId, "Testwind Ltd", `testwind-${Math.random().toString(36).slice(2, 8)}`, nowIso());

  const finance = await orgService.createDepartment(orgId, "Finance", "FIN");
  const operations = await orgService.createDepartment(orgId, "Operations", "OPS");
  const legal = await orgService.createDepartment(orgId, "Legal", "LEG");

  const roles: Record<string, string> = {};
  for (const [name, template] of Object.entries(ROLE_TEMPLATES)) {
    roles[name] = (await orgService.createRole(orgId, { name, description: template.description, capabilities: [...template.capabilities] })).id;
  }

  const orgScope = await orgService.createScope(orgId, { name: "Whole org", scopeType: "ORGANIZATION", selector: { organizationId: orgId }, constraints: {} });
  const financeScope = await orgService.createScope(orgId, {
    name: "Finance dept", scopeType: "DEPARTMENT", selector: { departmentId: finance.id }, constraints: { maxAmount: 500000 },
  });
  const opsScope = await orgService.createScope(orgId, {
    name: "Operations dept", scopeType: "DEPARTMENT", selector: { departmentId: operations.id }, constraints: { maxAmount: 200000 },
  });
  const vendorScope = await orgService.createScope(orgId, {
    name: "Agent vendors", scopeType: "VENDOR",
    selector: { vendors: ["Acme Cloud Services", "Globex Logistics"] }, constraints: { maxAmount: 100000 },
  });

  await orgService.attachScopeToRole(roles.Admin, orgScope.id);
  await orgService.attachScopeToRole(roles.Auditor, orgScope.id);
  // Deliberately NOT attached to User: a plain member is confined to their own
  // department scope, which is what makes departmental isolation testable.

  for (const p of [
    { policyKey: "payment-limits", name: "Payment limits", description: "", activate: true,
      conditions: { rules: [
        { type: "AMOUNT_MAX", value: 500000, onFail: "DENY" },
        { type: "APPROVAL_THRESHOLD", value: 50000 },
        { type: "CURRENCY_ALLOWLIST", values: ["INR"], onFail: "DENY" },
      ] },
      appliesTo: { actions: ["PAYMENT_CREATE", "PAYMENT_EXECUTE"] } },
    { policyKey: "vendor-controls", name: "Vendor controls", description: "", activate: true,
      conditions: { rules: [{ type: "MERCHANT_BLOCKLIST", values: ["Sanctioned Holdings Ltd"], onFail: "DENY" }] },
      appliesTo: { actions: ["PAYMENT_CREATE", "PAYMENT_EXECUTE"] } },
    { policyKey: "agent-vendor-allowlist", name: "Agent approved vendors", description: "", activate: true,
      conditions: { rules: [{ type: "MERCHANT_ALLOWLIST", values: ["Acme Cloud Services", "Globex Logistics"], onFail: "DENY" }] },
      appliesTo: { actions: ["PAYMENT_CREATE"], actorKinds: ["AGENT"] } },
  ]) await policyService.createPolicy(orgId, "system", p as any);

  const people = [
    { key: "admin", name: "Ada Admin", role: "Admin", dept: null, scopes: [] as string[] },
    { key: "manager", name: "Meera Manager", role: "Manager", dept: finance.id, scopes: [financeScope.id] },
    { key: "auditor", name: "Arun Auditor", role: "Auditor", dept: null, scopes: [] },
    { key: "user", name: "Ravi User", role: "User", dept: operations.id, scopes: [opsScope.id] },
    { key: "opsmgr", name: "Priya OpsManager", role: "Manager", dept: operations.id, scopes: [opsScope.id] },
  ];

  const ids: Record<string, string> = {};
  const dids: Record<string, string> = {};
  for (const p of people) {
    const { identity } = await identityService.createIdentity({
      organizationId: orgId, displayName: p.name, email: `${p.key}@testwind.test`,
      kind: "HUMAN", departmentId: p.dept, password: PASSWORD, status: "ACTIVE",
    });
    const m = (await identityService.getMembership(identity.id, orgId))!;
    await identityService.assignRole(m.id, roles[p.role], "system");
    for (const s of p.scopes) await identityService.assignScopeToMembership(m.id, s);
    ids[p.key] = identity.id;
    dids[p.key] = identity.did;
  }

  const adminActor = (await identityService.buildActorContext(ids.admin, orgId))!;

  const collection = await assetService.createCollection(orgId, "IT Equipment", "");
  const assets: Record<string, string> = {};
  const financeAsset = await assetService.createAsset(adminActor, newTraceId(), {
    name: "Finance Laptop", assetType: "LAPTOP", collectionId: collection.id,
    departmentId: finance.id, ownerDid: dids.manager, metadata: { serial: "FIN-1" },
  });
  await assetService.mintAsset(adminActor, newTraceId(), financeAsset.id);
  assets.finance = financeAsset.id;

  const opsAsset = await assetService.createAsset(adminActor, newTraceId(), {
    name: "Ops Monitor", assetType: "MONITOR", collectionId: collection.id,
    departmentId: operations.id, ownerDid: dids.user, metadata: { serial: "OPS-1" },
  });
  await assetService.mintAsset(adminActor, newTraceId(), opsAsset.id);
  assets.operations = opsAsset.id;

  const legalAsset = await assetService.createAsset(adminActor, newTraceId(), {
    name: "Legal Laptop", assetType: "LAPTOP", collectionId: collection.id,
    departmentId: legal.id, ownerDid: null, metadata: { serial: "LEG-1" },
  });
  assets.legal = legalAsset.id;

  const { agent, token: agentKey } = await agentService.registerAgent(adminActor, {
    name: "TestAgent-01", ownerIdentityId: ids.manager, departmentId: finance.id,
    capabilities: ["PAYMENT_CREATE", "PAYMENT_READ", "ASSET_READ", "KNOWLEDGE_READ", "POLICY_READ", "AGENT_INVOKE"],
    scopeIds: [financeScope.id],
    tools: ["get_policy", "get_asset", "search_knowledge", "create_payment_intent"],
    limits: { transactionLimit: 200000, approvalThreshold: 50000, dailyLimit: 500000, velocityCountPerDay: 10 },
  });

  await ragService.ingest({
    organizationId: orgId, sourceType: "INVOICE", title: "Invoice INV-1 Acme",
    content: "Invoice INV-1. Vendor: Acme Cloud Services. Amount due: INR 38500. Cloud hosting for July.",
    departmentId: finance.id, classification: "INTERNAL", scope: { departmentId: finance.id },
  } as any);
  await ragService.ingest({
    organizationId: orgId, sourceType: "HR_DOC", title: "Compensation Bands (Restricted)",
    content: "RESTRICTED. Salary bands by grade. This must never appear in a Finance-scoped retrieval result.",
    departmentId: legal.id, classification: "RESTRICTED", scope: { departmentId: legal.id }, requiredCapability: "ORG_MANAGE",
  } as any);

  const app = await buildApp({ logger: false });
  await app.ready();

  const tokens: any = {};
  for (const p of people) {
    const res = await app.inject({
      method: "POST", url: "/api/auth/login",
      payload: { email: `${p.key}@testwind.test`, password: PASSWORD },
    });
    tokens[p.key] = res.json().token;
  }

  return {
    app, orgId,
    departments: { finance: finance.id, operations: operations.id, legal: legal.id },
    tokens, ids, dids, agentKey, agentId: agent.id, agentDid: agent.did, assets,
    scopes: { org: orgScope.id, finance: financeScope.id, operations: opsScope.id, vendor: vendorScope.id },
    roles, dbFile,
  };
}

export async function destroyHarness(h: Harness) {
  await h.app.close();
  await closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    try { rmSync(`${h.dbFile}${suffix}`, { force: true }); } catch { /* best effort */ }
  }
}

/** Authenticated request helpers — `as` picks the credential, never a role header. */
export function asUser(h: Harness, who: keyof Harness["tokens"]) {
  return (method: any, url: string, payload?: unknown) =>
    h.app.inject({ method, url, headers: { authorization: `Bearer ${h.tokens[who]}` }, payload: payload as any });
}

export function asAgent(h: Harness) {
  return (method: any, url: string, payload?: unknown) =>
    h.app.inject({ method, url, headers: { "x-agent-key": h.agentKey }, payload: payload as any });
}

export { PASSWORD };
