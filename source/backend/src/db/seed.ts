import { initDb, run, one, j } from "./client.js";
import { migrate } from "./migrate.js";
import { env } from "../config/env.js";
import { newId, newTraceId } from "../core/ids.js";
import { nowIso } from "../core/time.js";
import * as orgService from "../services/orgService.js";
import * as identityService from "../services/identityService.js";
import * as policyService from "../services/policyService.js";
import * as assetService from "../services/assetService.js";
import * as agentService from "../services/agentService.js";
import * as ragService from "../services/ragService.js";
import { ROLE_TEMPLATES } from "../authorization/capabilities.js";
import type { ActorContext } from "../authorization/types.js";

/**
 * Seeds a demo organization that makes every scenario in the test matrix reproducible
 * without hand-setup: a Manager confined to Finance, an Auditor with read-only
 * capabilities, a plain User, and one agent whose limits sit deliberately below the
 * amounts used in the demo so both the approval path and the denial path are reachable.
 */

const DEMO_PASSWORD = process.env.SEED_PASSWORD ?? "TrustWeave!2026";

/**
 * The seed creates accounts with a known password and prints private keys to stdout.
 * That is exactly what a reviewer needs locally and exactly what must never run against
 * a production database, so refuse rather than rely on nobody typing the command.
 */
if (process.env.NODE_ENV === "production") {
  console.error(
    "Refusing to seed: NODE_ENV=production.\n" +
    "This script creates demo identities with a shared password and prints their private keys.",
  );
  process.exit(1);
}

async function seed() {
  await initDb(env.DATABASE_URL);
  await migrate();
  await orgService.syncCapabilityCatalog();

  const existing = await one<any>(`SELECT id FROM organizations WHERE slug = 'northwind'`);
  if (existing) {
    console.log("Organization 'northwind' already exists. Run `npm run db:reset` first for a clean seed.");
    return;
  }

  /* ------------------------------------------------------------ organization */
  const orgId = newId("org");
  await run(`INSERT INTO organizations (id, name, slug, created_at) VALUES (?,?,?,?)`,
    orgId, "Northwind Industries", "northwind", nowIso());

  const finance = orgService.createDepartment(orgId, "Finance", "FIN");
  const operations = orgService.createDepartment(orgId, "Operations", "OPS");
  const legal = orgService.createDepartment(orgId, "Legal", "LEG");

  /* ------------------------------------------------------------------ roles */
  const roles: Record<string, string> = {};
  for (const [name, template] of Object.entries(ROLE_TEMPLATES)) {
    const role = orgService.createRole(orgId, {
      name, description: template.description, capabilities: [...template.capabilities],
    });
    roles[name] = (await role).id;
  }

  /* ----------------------------------------------------------------- scopes */
  const orgScope = orgService.createScope(orgId, {
    name: "Whole organization", scopeType: "ORGANIZATION",
    selector: { organizationId: orgId }, constraints: {},
  });
  const financeScope = orgService.createScope(orgId, {
    name: "Finance department", scopeType: "DEPARTMENT",
    selector: { departmentId: (await finance).id },
    // Business-hours constraint: proves the time-window gate with something visible.
    constraints: { maxAmount: 500000, timeWindow: { start: "06:00", end: "23:59", timezoneOffsetMinutes: 330 } },
  });
  const opsScope = orgService.createScope(orgId, {
    name: "Operations department", scopeType: "DEPARTMENT",
    selector: { departmentId: (await operations).id }, constraints: { maxAmount: 200000 },
  });
  const agentVendorScope = orgService.createScope(orgId, {
    name: "Approved vendors (agent)", scopeType: "VENDOR",
    selector: { vendors: ["Acme Cloud Services", "Globex Logistics", "Initech Software", "Umbrella Supplies"] },
    constraints: { maxAmount: 100000 },
  });

  orgService.attachScopeToRole(roles.Admin, (await orgScope).id);
  orgService.attachScopeToRole(roles.Auditor, (await orgScope).id);
  // The User role gets no organization-wide scope on purpose. A plain member sees only
  // their own department, granted through their membership, so departmental isolation
  // is real rather than nominal.

  /* --------------------------------------------------------------- policies */
  const policies = [
    {
      policyKey: "payment-limits",
      name: "Payment limits and approval thresholds",
      description: "Payments above \u20b950,000 require human approval; nothing above \u20b95,00,000 may be raised at all.",
      conditions: { rules: [
        { type: "AMOUNT_MAX", value: 500000, onFail: "DENY" },
        { type: "APPROVAL_THRESHOLD", value: 50000 },
        { type: "CURRENCY_ALLOWLIST", values: ["INR"], onFail: "DENY" },
      ] },
      appliesTo: { actions: ["PAYMENT_CREATE", "PAYMENT_EXECUTE"] },
      activate: true,
    },
    {
      policyKey: "vendor-controls",
      name: "Vendor allow/block controls",
      description: "Blocks payments to sanctioned or disputed vendors regardless of amount or approval.",
      conditions: { rules: [
        { type: "MERCHANT_BLOCKLIST", values: ["Sanctioned Holdings Ltd", "Disputed Vendor Co"], onFail: "DENY" },
      ] },
      appliesTo: { actions: ["PAYMENT_CREATE", "PAYMENT_EXECUTE"] },
      activate: true,
    },
    {
      policyKey: "agent-vendor-allowlist",
      name: "Agent approved vendors",
      description: "An automated agent may only pay vendors on the approved list. Which resources an agent may touch is a scope question; which vendors it may pay is a business rule, so it lives in policy.",
      conditions: { rules: [
        { type: "MERCHANT_ALLOWLIST", values: ["Acme Cloud Services", "Globex Logistics", "Initech Software", "Umbrella Supplies"], onFail: "DENY" },
      ] },
      appliesTo: { actions: ["PAYMENT_CREATE"], actorKinds: ["AGENT"] },
      activate: true,
    },
    {
      policyKey: "agent-velocity",
      name: "Agent spending velocity",
      description: "Caps how much and how often an automated agent may transact in a rolling 24-hour window.",
      conditions: { rules: [
        { type: "VELOCITY", window: "1d", maxCount: 10, maxAmount: 200000, onFail: "DENY" },
      ] },
      appliesTo: { actions: ["PAYMENT_CREATE"], actorKinds: ["AGENT"] },
      activate: true,
    },
    {
      policyKey: "evidence-required",
      name: "Evidence required for agent payments",
      description: "An agent-initiated payment must cite at least one retrieved document.",
      conditions: { rules: [
        { type: "REQUIRE_EVIDENCE", min: 1, onFail: "REQUIRE_APPROVAL" },
      ] },
      appliesTo: { actions: ["PAYMENT_CREATE"], actorKinds: ["AGENT"] },
      activate: true,
    },
    {
      policyKey: "high-value-dual-approval",
      name: "Dual approval for high-value payments",
      description: "Payments above \u20b93,00,000 need two distinct approvers.",
      conditions: { rules: [
        { type: "DUAL_APPROVAL_ABOVE", value: 300000 },
      ] },
      appliesTo: { actions: ["PAYMENT_CREATE"] },
      activate: true,
    },
  ];

  for (const p of policies) await policyService.createPolicy(orgId, "system", p as any);

  /* ------------------------------------------------------------- identities */
  const people = [
    { key: "admin",   name: "Ada Sharma",     email: "admin@northwind.test",   role: "Admin",   dept: null,            scopes: [] },
    { key: "manager", name: "Meera Iyer",     email: "manager@northwind.test", role: "Manager", dept: (await finance).id,      scopes: [(await financeScope).id] },
    { key: "auditor", name: "Arun Verma",     email: "auditor@northwind.test", role: "Auditor", dept: null,            scopes: [] },
    { key: "user",    name: "Ravi Nair",      email: "user@northwind.test",    role: "User",    dept: (await operations).id,   scopes: [(await opsScope).id] },
    { key: "opsmgr",  name: "Priya Deshpande",email: "opsmgr@northwind.test",  role: "Manager", dept: (await operations).id,   scopes: [(await opsScope).id] },
  ];

  const created: Record<string, { id: string; did: string; privateKey: string | null }> = {};
  for (const p of people) {
    const { identity, privateKey } = await identityService.createIdentity({
      organizationId: orgId, displayName: p.name, email: p.email,
      kind: "HUMAN", departmentId: p.dept, password: DEMO_PASSWORD, status: "ACTIVE",
    });
    const membership = (await identityService.getMembership(identity.id, orgId))!;
    await identityService.assignRole(membership.id, roles[p.role], "system");
    for (const s of p.scopes) await identityService.assignScopeToMembership(membership.id, s);
    created[p.key] = { id: identity.id, did: identity.did, privateKey };
  }

  const adminActor = (await identityService.buildActorContext(created.admin.id, orgId))! as ActorContext;

  /* ------------------------------------------------------------- collections & assets */
  const equipment = await assetService.createCollection(orgId, "IT Equipment", "Laptops, monitors and peripherals issued to staff.");
  const licences = await assetService.createCollection(orgId, "Software Licences", "Per-seat software entitlements.");
  const vehicles = await assetService.createCollection(orgId, "Fleet Vehicles", "Company-owned vehicles.");

  const assetSpecs = [
    { name: "MacBook Pro 16in — NW-0417", assetType: "LAPTOP",  collectionId: equipment.id, departmentId: (await finance).id,    owner: created.manager.did, mint: true,  metadata: { serial: "NW-0417", purchaseDate: "2025-03-11", value: 289000 } },
    { name: "Dell UltraSharp U2723 — NW-0512", assetType: "MONITOR", collectionId: equipment.id, departmentId: (await operations).id, owner: created.user.did, mint: true, metadata: { serial: "NW-0512", purchaseDate: "2025-06-02", value: 42000 } },
    { name: "Figma Organization Seat #14", assetType: "LICENCE", collectionId: licences.id, departmentId: (await operations).id, owner: created.user.did, mint: true, metadata: { seat: 14, renewal: "2026-11-01", value: 45000 } },
    { name: "Adobe CC Seat #3", assetType: "LICENCE", collectionId: licences.id, departmentId: (await finance).id, owner: created.manager.did, mint: false, metadata: { seat: 3, renewal: "2026-09-15", value: 62000 } },
    { name: "Tata Nexon EV — MH01 AB 4417", assetType: "VEHICLE", collectionId: vehicles.id, departmentId: (await operations).id, owner: created.admin.did, mint: true, metadata: { registration: "MH01AB4417", value: 1750000 } },
    { name: "ThinkPad X1 Carbon — NW-0633", assetType: "LAPTOP", collectionId: equipment.id, departmentId: (await legal).id, owner: null, mint: false, metadata: { serial: "NW-0633", purchaseDate: "2026-01-20", value: 198000 } },
  ];

  for (const spec of assetSpecs) {
    const asset = await assetService.createAsset(adminActor, newTraceId(), {
      name: spec.name, assetType: spec.assetType, collectionId: spec.collectionId,
      departmentId: spec.departmentId, ownerDid: spec.owner, metadata: spec.metadata,
    });
    if (spec.mint) await assetService.mintAsset(adminActor, newTraceId(), asset.id);
  }

  /* ------------------------------------------------------------------ agent */
  const { agent, token } = await agentService.registerAgent(adminActor, {
    name: "FinanceAgent-01",
    ownerIdentityId: created.manager.id,
    departmentId: (await finance).id,
    capabilities: ["PAYMENT_CREATE", "PAYMENT_READ", "ASSET_READ", "KNOWLEDGE_READ", "POLICY_READ", "AGENT_INVOKE"],
    scopeIds: [(await financeScope).id],
    tools: ["get_policy", "get_invoice", "get_asset", "search_knowledge", "create_payment_intent"],
    limits: { transactionLimit: 200000, approvalThreshold: 50000, dailyLimit: 500000, velocityCountPerDay: 10 },
  });

  /* -------------------------------------------------------------- knowledge */
  const documents = [
    {
      sourceType: "POLICY_DOC", title: "Procurement Policy 2026", classification: "INTERNAL" as const,
      departmentId: null, scope: {},
      // Restates payment-limits. Re-versioning that policy makes this document provably
      // stale, which the orchestrator then refuses to act on.
      sourcePolicyKey: "payment-limits",
      content: `Northwind Industries Procurement Policy, effective 1 January 2026.

All purchases must be raised against an approved vendor. Payments up to fifty thousand rupees may be executed directly by an authorised requester or automated agent. Payments above fifty thousand rupees require approval from a departmental Manager or an Administrator before execution.

Payments above three hundred thousand rupees require two distinct approvers. No single person may both raise and approve the same payment, under any circumstances.

Vendors placed on the compliance blocklist may not be paid regardless of amount, approval, or urgency. A blocklist entry cannot be overridden by an approver.

Automated agents must cite at least one supporting document for every payment they propose. An agent proposal without evidence will be refused by the authorization engine before it reaches the payment provider.`,
    },
    {
      sourceType: "INVOICE", title: "Invoice INV-2026-0042 — Acme Cloud Services", classification: "INTERNAL" as const,
      departmentId: (await finance).id, scope: { departmentId: (await finance).id },
      content: `Invoice INV-2026-0042
Vendor: Acme Cloud Services
Date: 3 August 2026
Amount due: INR 38,500
Currency: INR
Description: Managed Kubernetes hosting, July 2026 billing period.
Payment terms: Net 30. Purchase order PO-2026-0189.
Approved budget line: Finance / Cloud Infrastructure.`,
    },
    {
      sourceType: "INVOICE", title: "Invoice INV-2026-0043 — Globex Logistics", classification: "INTERNAL" as const,
      departmentId: (await finance).id, scope: { departmentId: (await finance).id },
      content: `Invoice INV-2026-0043
Vendor: Globex Logistics
Date: 9 August 2026
Amount due: INR 92,000
Currency: INR
Description: Q3 freight and warehousing charges.
Payment terms: Net 15. Purchase order PO-2026-0201.
Note: This amount exceeds the fifty thousand rupee direct-payment threshold and will require managerial approval.`,
    },
    {
      sourceType: "HR_DOC", title: "Compensation Bands FY2026 (Restricted)", classification: "RESTRICTED" as const,
      departmentId: (await legal).id, scope: { departmentId: (await legal).id }, requiredCapability: "ORG_MANAGE",
      content: `Restricted document. Compensation bands for FY2026 by grade and location. This document exists in the corpus specifically to demonstrate access filtering: an agent or user scoped to Finance or Operations must never see this content in a retrieval result, and the retrieval response should report it as excluded.`,
    },
    {
      sourceType: "VENDOR_NOTE", title: "Compliance Notice — Sanctioned Holdings Ltd", classification: "INTERNAL" as const,
      departmentId: null, scope: {},
      content: `Compliance notice, 12 June 2026. Sanctioned Holdings Ltd has been added to the payment blocklist following a regulatory designation. All open purchase orders are suspended. Any payment request naming this vendor must be refused. This restriction is enforced by policy and is not subject to approver discretion.`,
    },
    {
      sourceType: "OPERATIONS", title: "Asset Handling Standard", classification: "INTERNAL" as const,
      departmentId: (await operations).id, scope: { departmentId: (await operations).id },
      content: `Asset handling standard. Every issued device is registered as an on-chain asset record with a metadata commitment. Transfers between employees must be recorded through the TrustWeave console so the ownership history remains verifiable. An automated agent may propose a transfer but may never execute one; a human holding ASSET_TRANSFER must approve it. Frozen assets cannot be transferred until unfrozen by an Administrator.`,
    },
  ];

  for (const doc of documents) await ragService.ingest({ organizationId: orgId, ...doc } as any);

  /* ------------------------------------------------------------------ report */
  console.log(`
TrustWeave v3.0 — demo data seeded
──────────────────────────────────────────────────────────────────────
Organization : Northwind Industries (${orgId})
Departments  : Finance, Operations, Legal
Roles        : ${Object.keys(roles).join(", ")}
Policies     : ${policies.length} active
Assets       : ${assetSpecs.length} (${assetSpecs.filter((a) => a.mint).length} minted)
Documents    : ${documents.length} (1 RESTRICTED, used to demonstrate retrieval filtering)

Sign-in (password, development only) — password for all accounts: ${DEMO_PASSWORD}
  Admin    admin@northwind.test     Ada Sharma        full control plane
  Manager  manager@northwind.test   Meera Iyer        Finance only, ₹5,00,000 scope cap
  Auditor  auditor@northwind.test   Arun Verma        read-only, zero mutating capabilities
  User     user@northwind.test      Ravi Nair         Operations, own records only
  Manager  opsmgr@northwind.test    Priya Deshpande   Operations only

DID sign-in keys (shown once, not stored):
${Object.entries(created).map(([k, v]) => `  ${k.padEnd(8)} ${v.did}\n           ${v.privateKey}`).join("\n")}

Agent key for FinanceAgent-01 (header: x-agent-key) — shown once:
  ${token}
  limits: ₹2,00,000 hard ceiling, approval required above ₹50,000, ₹5,00,000/day, 10 calls/day

Try these:
  • Pay Acme Cloud Services ₹38,500  → allowed outright
  • Pay Globex Logistics ₹92,000     → requires approval
  • Pay Sanctioned Holdings Ltd      → denied by policy, approval cannot override
  • Ask the agent for compensation bands → excluded by retrieval filtering
──────────────────────────────────────────────────────────────────────
`);
}

seed().catch((err) => { console.error("Seed failed:", err); process.exit(1); });
