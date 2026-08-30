import { it, expect } from "vitest";
import { createHarness, asUser, destroyHarness } from "./helpers.js";

/** Verifies every endpoint the frontend calls exists and returns the expected shape. */
it("frontend contract", async () => {
  const h = await createHarness("contract");
  const admin = asUser(h, "admin");
  const checks: [string, string, any?][] = [
    ["GET", "/api/session"], ["GET", "/api/dashboard"], ["GET", "/api/auth/config"],
    ["GET", "/api/identities"], ["GET", `/api/identities/${h.ids.manager}`],
    ["GET", "/api/roles"], ["GET", "/api/capabilities"], ["GET", "/api/scopes"],
    ["GET", "/api/policies"], ["GET", "/api/organization"],
    ["GET", "/api/assets"], ["GET", `/api/assets/${h.assets.finance}`], ["GET", "/api/collections"],
    ["GET", "/api/agents"], ["GET", "/api/agents/tools"], ["GET", `/api/agents/${h.agentId}`],
    ["GET", `/api/agents/${h.agentId}/on-chain`],
    ["GET", "/api/payment-intents"], ["GET", "/api/approvals"],
    ["GET", "/api/payments/reconciliation"],
    ["GET", "/api/audit/events"], ["GET", "/api/audit/verify-chain"], ["GET", "/api/audit/export"],
    ["GET", "/api/proofs"], ["GET", "/api/knowledge/documents"],
    ["GET", "/api/security/events"], ["GET", "/api/security/emergency"],
    ["GET", "/api/integrations/status"], ["GET", "/api/health"],
  ];
  const failures: string[] = [];
  for (const [method, url] of checks) {
    const res = await admin(method, url);
    if (res.statusCode >= 400) failures.push(`${method} ${url} -> ${res.statusCode} ${res.body.slice(0, 120)}`);
  }
  const post = await admin("POST", "/api/authorize/simulate", {
    identityId: h.ids.manager, action: "PAYMENT_CREATE",
    resource: { type: "PAYMENT", departmentId: h.departments.finance }, context: { amount: 1000 },
  });
  if (post.statusCode >= 400) failures.push(`simulate -> ${post.statusCode} ${post.body.slice(0,200)}`);
  const search = await admin("POST", "/api/knowledge/search", { query: "invoice" });
  if (search.statusCode >= 400) failures.push(`search -> ${search.statusCode}`);

  // Field-name checks for things the UI reads directly.
  const dash = (await admin("GET", "/api/dashboard")).json();
  const assets = (await admin("GET", "/api/assets")).json();
  const agents = (await admin("GET", "/api/agents")).json();
  const roles = (await admin("GET", "/api/roles")).json();
  const scopes = (await admin("GET", "/api/scopes")).json();
  const policies = (await admin("GET", "/api/policies")).json();
  const audit = (await admin("GET", "/api/audit/events")).json();
  const caps = (await admin("GET", "/api/capabilities")).json();
  const shape = {
    "dashboard.auditChain.eventCount": dash.auditChain?.eventCount,
    "assets[0].nftTokenId": assets.assets[0]?.nftTokenId,
    "assets[0].metadataHash": assets.assets[0]?.metadataHash,
    "agents[0].limits.transactionLimit": agents.agents[0]?.limits?.transactionLimit,
    "agents[0].tools": agents.agents[0]?.tools,
    "roles[0].capabilities": roles.roles[0]?.capabilities,
    "roles[0].version": roles.roles[0]?.version,
    "scopes[0].scopeType": scopes.scopes[0]?.scopeType,
    "scopes[0].selector": scopes.scopes[0]?.selector,
    "policies[0].conditions.rules": policies.policies[0]?.conditions?.rules,
    "policies[0].policyKey": policies.policies[0]?.policyKey,
    "audit.events[0].eventHash": audit.events[0]?.eventHash,
    "audit.events[0].seq": audit.events[0]?.seq,
    "capabilities[0].action": caps.capabilities[0]?.action,
    "capabilities[0].domain": caps.capabilities[0]?.domain,
  };
  for (const [k, v] of Object.entries(shape)) {
    if (v === undefined) failures.push(`MISSING FIELD: ${k}`);
  }
  console.log(failures.length ? "FAILURES:\n" + failures.join("\n") : "ALL CONTRACT CHECKS PASSED");
  await destroyHarness(h);
  expect(failures).toEqual([]);
}, 60000);
