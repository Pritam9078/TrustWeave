import { initDb, run, one } from "./clientV2.js";
import { env } from "../config/env.js";
import { newId, newTraceId } from "../core/ids.js";

function randomDate(startDaysAgo: number, endDaysAgo: number) {
  const now = new Date();
  const start = new Date(now.getTime() - startDaysAgo * 24 * 60 * 60 * 1000);
  const end = new Date(now.getTime() - endDaysAgo * 24 * 60 * 60 * 1000);
  return new Date(start.getTime() + Math.random() * (end.getTime() - start.getTime())).toISOString();
}

const MERCHANTS = [
  "Acme Cloud Services",
  "Globex Logistics",
  "Initech Software",
  "Umbrella Supplies",
  "Sanctioned Holdings Ltd", // for blocks
  "Disputed Vendor Co", // for blocks
  "Stark Industries",
  "Wayne Enterprises"
];

const PURPOSES = [
  "Cloud hosting fees",
  "Freight charges",
  "Software licenses",
  "Office supplies",
  "Consulting fees",
  "Legal services",
  "Hardware procurement"
];

async function seedHistory() {
  await initDb(env.DATABASE_URL);

  const org = await one<any>(`SELECT id FROM organizations WHERE slug = 'northwind'`);
  if (!org) {
    console.error("Organization not found. Seed the db first.");
    process.exit(1);
  }
  const orgId = org.id;

  const actor = await one<any>(`SELECT id, did FROM identities WHERE email = 'manager@northwind.test'`);
  if (!actor) {
    console.error("Actor not found.");
    process.exit(1);
  }

  const agent = await one<any>(`SELECT id FROM agents WHERE name = 'FinanceAgent-01'`);
  const agentId = agent ? agent.id : null;

  const policy = await one<any>(`SELECT id, version FROM policies WHERE policy_key = 'vendor-controls' LIMIT 1`);

  console.log("Generating 50 historical payment intents...");

  for (let i = 0; i < 50; i++) {
    const traceId = newTraceId();
    const intentId = newId("pi");
    const date = randomDate(30, 0); // last 30 days
    const isBlock = Math.random() < 0.15; // 15% blocked
    const isPending = Math.random() < 0.1; // 10% pending
    const isDenied = Math.random() < 0.05; // 5% denied

    const merchant = isBlock ? "Sanctioned Holdings Ltd" : MERCHANTS[Math.floor(Math.random() * MERCHANTS.length)];
    const amount = Math.floor(Math.random() * (isPending || isDenied ? 90000 : 45000)) + 5000;
    const purpose = PURPOSES[Math.floor(Math.random() * PURPOSES.length)];
    const raw_request = `Pay ${merchant} ${amount} INR for ${purpose}`;

    let state = "EXECUTED";
    let decision = "ALLOW";
    let reason_codes = "[]";
    let policyId = null;
    let policyVer = null;

    if (isBlock) {
      state = "BLOCKED";
      decision = "DENY";
      reason_codes = JSON.stringify(["MERCHANT_BLOCKLIST"]);
      policyId = policy?.id;
      policyVer = policy?.version;
    } else if (isDenied) {
      state = "DENIED";
      decision = "REQUIRE_APPROVAL";
      reason_codes = JSON.stringify(["APPROVAL_THRESHOLD"]);
    } else if (isPending) {
      state = "PENDING_APPROVAL";
      decision = "REQUIRE_APPROVAL";
      reason_codes = JSON.stringify(["APPROVAL_THRESHOLD"]);
    }

    await run(`
      INSERT INTO payment_intents (
        id, organization_id, actor_identity_id, agent_id,
        raw_request, merchant, merchant_ref, amount, currency, purpose, invoice_ref,
        evidence_json, state, decision, reason_codes, policy_id, policy_version,
        trace_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      intentId, orgId, actor.id, agentId,
      raw_request, merchant, `INV-${Math.floor(Math.random() * 10000)}`, amount, "INR", purpose, `INV-${Math.floor(Math.random() * 10000)}`,
      "[]", state, decision, reason_codes, policyId, policyVer,
      traceId, date, date
    );

    // Also add a basic audit event
    const eventId = newId("aud");
    const nextSeq = (await one<any>(`SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM audit_events WHERE organization_id = ?`, orgId)).seq;
    
    await run(`
      INSERT INTO audit_events (
        id, organization_id, seq, trace_id, actor_id, actor_did, actor_kind, action,
        resource_type, resource_id, decision, reason_codes, policy_id, policy_version,
        payload_json, payload_hash, prev_event_hash, event_hash, timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      eventId, orgId, nextSeq, traceId, actor.id, actor.did, "HUMAN", "PAYMENT_CREATE",
      "PAYMENT_INTENT", intentId, decision, reason_codes, policyId, policyVer,
      "{}", "dummypayloadhash", "dummypreveventhash", "dummyeventhash", date
    );
  }

  console.log("Historical data seeded successfully!");
}

seedHistory().catch(console.error);
