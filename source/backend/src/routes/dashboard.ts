import type { FastifyInstance } from "fastify";
import { requireActor } from "../auth/middleware.js";
import * as authz from "../services/authorizationService.js";
import * as audit from "../services/auditService.js";
import * as orgService from "../services/orgService.js";
import { one, many } from "../db/client.js";
import { getBlockchainAdapter } from "../adapters/blockchain/index.js";
import { getRazorpayAdapter } from "../adapters/razorpay/index.js";
import { getLLMProvider } from "../adapters/llm/index.js";
import { env } from "../config/env.js";

/**
 * Dashboard aggregates. Each role's landing page gets exactly the numbers it is
 * entitled to see — the counts themselves are computed with the actor's own
 * constraints applied, so a Manager's "pending approvals" figure never includes work
 * from a department they cannot access.
 */
export async function dashboardRoutes(app: FastifyInstance) {
  app.get("/api/dashboard", async (req) => {
    const actor = requireActor(req);
    const org = actor.organizationId;
    const canSeeOrgWide = actor.roleNames.some((r) => ["Admin", "Auditor"].includes(r));
    const deptFilter = canSeeOrgWide ? null : actor.departmentId;

    const count = async (sql: string, ...params: unknown[]) => Number((await one<any>(sql, ...params))?.n ?? 0);

    const identities = actor.capabilities.has("IDENTITY_READ")
      ? {
          total: await count(`SELECT COUNT(*) n FROM identities WHERE organization_id = ?`, org),
          active: await count(`SELECT COUNT(*) n FROM identities WHERE organization_id = ? AND status = 'ACTIVE'`, org),
          suspended: await count(`SELECT COUNT(*) n FROM identities WHERE organization_id = ? AND status = 'SUSPENDED'`, org),
          revoked: await count(`SELECT COUNT(*) n FROM identities WHERE organization_id = ? AND status = 'REVOKED'`, org),
        }
      : null;

    const agents = actor.capabilities.has("AGENT_READ")
      ? {
          total: await count(`SELECT COUNT(*) n FROM agents WHERE organization_id = ?`, org),
          active: await count(`SELECT COUNT(*) n FROM agents WHERE organization_id = ? AND status = 'ACTIVE'`, org),
          frozen: await count(`SELECT COUNT(*) n FROM agents WHERE organization_id = ? AND status = 'FROZEN'`, org),
          callsToday: await count(
            `SELECT COUNT(*) n FROM agent_tool_calls c JOIN agents a ON a.id = c.agent_id
             WHERE a.organization_id = ? AND c.created_at >= date('now')`, org),
          deniedToday: await count(
            `SELECT COUNT(*) n FROM agent_tool_calls c JOIN agents a ON a.id = c.agent_id
             WHERE a.organization_id = ? AND c.decision = 'DENY' AND c.created_at >= date('now')`, org),
        }
      : null;

    const assets = actor.capabilities.has("ASSET_READ")
      ? {
          total: await count(`SELECT COUNT(*) n FROM assets WHERE organization_id = ?` + (deptFilter ? ` AND department_id = ?` : ``), ...(deptFilter ? [org, deptFilter] : [org])),
          minted: await count(`SELECT COUNT(*) n FROM assets WHERE organization_id = ? AND nft_token_id IS NOT NULL`, org),
          frozen: await count(`SELECT COUNT(*) n FROM assets WHERE organization_id = ? AND status = 'FROZEN'`, org),
          revoked: await count(`SELECT COUNT(*) n FROM assets WHERE organization_id = ? AND status = 'REVOKED'`, org),
        }
      : null;

    const payments = actor.capabilities.has("PAYMENT_READ")
      ? {
          pendingApproval: await count(
            `SELECT COUNT(*) n FROM payment_intents WHERE organization_id = ? AND state = 'AWAITING_APPROVAL'`
            + (deptFilter ? ` AND department_id = ?` : ``), ...(deptFilter ? [org, deptFilter] : [org])),
          executed: await count(`SELECT COUNT(*) n FROM payment_intents WHERE organization_id = ? AND state IN ('EXECUTED','RECONCILED')`, org),
          denied: await count(`SELECT COUNT(*) n FROM payment_intents WHERE organization_id = ? AND state = 'DENIED'`, org),
          unreconciled: await count(`SELECT COUNT(*) n FROM payment_intents WHERE organization_id = ? AND state = 'EXECUTED'`, org),
          valueExecuted: Number((await one<any>(
            `SELECT COALESCE(SUM(amount),0) n FROM payment_intents WHERE organization_id = ? AND state IN ('EXECUTED','RECONCILED')`, org))?.n ?? 0),
        }
      : null;

    const myApprovals = (await many<any>(
      `SELECT * FROM approvals WHERE organization_id = ? AND status = 'PENDING' AND requested_by != ?
       ORDER BY created_at DESC LIMIT 10`, org, actor.identityId))
      .filter((a) => actor.capabilities.has(a.required_capability));

    const security = actor.capabilities.has("SECURITY_READ")
      ? await (async () => {
          const events = await orgService.listSecurityEvents(org, 5);
          return {
            open: await count(`SELECT COUNT(*) n FROM security_events WHERE organization_id = ? AND acknowledged_at IS NULL`, org),
            critical: await count(`SELECT COUNT(*) n FROM security_events WHERE organization_id = ? AND severity = 'CRITICAL' AND acknowledged_at IS NULL`, org),
            recent: events.map((e) => ({ id: e.id, kind: e.kind, severity: e.severity, summary: e.summary, createdAt: e.created_at })),
          };
        })()
      : null;

    const decisions = (await many<any>(
      `SELECT decision, COUNT(*) n FROM audit_events WHERE organization_id = ? AND timestamp >= datetime('now','-7 days') GROUP BY decision`, org))
      .reduce((acc: Record<string, number>, r) => { acc[r.decision] = Number(r.n); return acc; }, {});

    return {
      workspace: actor.roleNames,
      identities, agents, assets, payments, security, decisions,
      pendingForMe: myApprovals.map((a) => ({
        id: a.id, requestType: a.request_type, requestId: a.request_id,
        reason: a.reason, requiredCapability: a.required_capability, createdAt: a.created_at,
      })),
      recentActivity: (await audit.query({
        organizationId: org,
        actorId: actor.roleNames.some((r) => ["Admin", "Auditor", "Manager"].includes(r)) ? undefined : actor.identityId,
        limit: 15,
      })).events.map(audit.toApi),
      auditChain: actor.capabilities.has("AUDIT_READ") ? await audit.verifyChain(org) : null,
      emergencyFlags: await orgService.listEmergencyFlags(org),
    };
  });

  /** Integration health — shows exactly which adapters are live vs simulated, so a
   *  reviewer is never left guessing whether a "successful" payment touched a provider. */
  app.get("/api/integrations/status", async (req) => {
    const actor = requireActor(req);
    await authz.enforce({ actor, action: "INTEGRATION_READ", resource: { type: "INTEGRATION", query: true }, ip: req.ip });
    const chain = getBlockchainAdapter();
    const razorpay = getRazorpayAdapter();
    const llm = getLLMProvider();
    return {
      blockchain: {
        adapter: chain.kind, chainId: chain.chainId,
        mode: chain.kind === "memory" ? "SIMULATED" : "LIVE",
        rpcConfigured: !!env.CHAIN_RPC_URL,
        contracts: chain.addresses,
        note: chain.kind === "memory"
          ? "In-memory chain simulation. Enforces the same invariants as the Solidity contracts; receipts are marked simulated:true."
          : "Connected to a live EVM RPC endpoint.",
      },
      payments: {
        adapter: razorpay.kind,
        mode: razorpay.kind === "test" ? "SIMULATED" : "LIVE",
        keyConfigured: !!env.RAZORPAY_KEY_ID,
        webhookSecretConfigured: !!env.RAZORPAY_WEBHOOK_SECRET,
        note: razorpay.kind === "test"
          ? "Deterministic local provider. Signature verification and idempotency are real; no network call is made."
          : "Calling the Razorpay REST API with the configured test keys.",
      },
      ai: {
        provider: llm.name,
        mode: llm.name === "mock" ? "SIMULATED" : "LIVE",
        keyConfigured: !!env.LLM_API_KEY,
        note: llm.name === "mock"
          ? "Deterministic rule-based proposal extractor. Produces the same structured output shape as the live model."
          : "Calling the Anthropic Messages API with a forced tool call.",
      },
    };
  });

  app.get("/api/health", async () => {
    let dbStatus = "unavailable";
    try {
      await one(`SELECT 1 n`);
      dbStatus = "connected";
    } catch {
      // ignore
    }
    return {
      status: "ok",
      version: "3.0.0",
      time: new Date().toISOString(),
      database: dbStatus,
    };
  });

  app.get("/api/metrics", async (req) => {
    const actor = requireActor(req);
    const org = actor.organizationId;
    const count = async (sql: string, ...params: unknown[]) => Number((await one<any>(sql, ...params))?.n ?? 0);
  
    const paymentsRequested = await count(`SELECT COUNT(*) n FROM payment_intents WHERE organization_id = ?`, org);
    const executed = await count(`SELECT COUNT(*) n FROM payment_intents WHERE organization_id = ? AND state IN ('EXECUTED', 'RECONCILED')`, org);
    const blocked = await count(`SELECT COUNT(*) n FROM payment_intents WHERE organization_id = ? AND state = 'DENIED'`, org);
    const humanApprovals = await count(`SELECT COUNT(*) n FROM payment_intents WHERE organization_id = ? AND state = 'AWAITING_APPROVAL'`, org);
    const executionFailures = await count(`SELECT COUNT(*) n FROM payment_intents WHERE organization_id = ? AND state = 'FAILED'`, org);
    const blockRate = paymentsRequested > 0 ? blocked / paymentsRequested : 0;
  
    return {
      paymentsRequested,
      executed,
      blocked,
      humanApprovals,
      executionFailures,
      blockRate
    };
  });
}
