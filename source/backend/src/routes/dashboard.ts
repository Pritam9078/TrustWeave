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

    const count = (sql: string, ...params: unknown[]) => Number(one<any>(sql, ...params)?.n ?? 0);

    const identities = actor.capabilities.has("IDENTITY_READ")
      ? {
          total: count(`SELECT COUNT(*) n FROM identities WHERE organization_id = ?`, org),
          active: count(`SELECT COUNT(*) n FROM identities WHERE organization_id = ? AND status = 'ACTIVE'`, org),
          suspended: count(`SELECT COUNT(*) n FROM identities WHERE organization_id = ? AND status = 'SUSPENDED'`, org),
          revoked: count(`SELECT COUNT(*) n FROM identities WHERE organization_id = ? AND status = 'REVOKED'`, org),
        }
      : null;

    const agents = actor.capabilities.has("AGENT_READ")
      ? {
          total: count(`SELECT COUNT(*) n FROM agents WHERE organization_id = ?`, org),
          active: count(`SELECT COUNT(*) n FROM agents WHERE organization_id = ? AND status = 'ACTIVE'`, org),
          frozen: count(`SELECT COUNT(*) n FROM agents WHERE organization_id = ? AND status = 'FROZEN'`, org),
          callsToday: count(
            `SELECT COUNT(*) n FROM agent_tool_calls c JOIN agents a ON a.id = c.agent_id
             WHERE a.organization_id = ? AND c.created_at >= date('now')`, org),
          deniedToday: count(
            `SELECT COUNT(*) n FROM agent_tool_calls c JOIN agents a ON a.id = c.agent_id
             WHERE a.organization_id = ? AND c.decision = 'DENY' AND c.created_at >= date('now')`, org),
        }
      : null;

    const assets = actor.capabilities.has("ASSET_READ")
      ? {
          total: count(`SELECT COUNT(*) n FROM assets WHERE organization_id = ?` + (deptFilter ? ` AND department_id = ?` : ``), ...(deptFilter ? [org, deptFilter] : [org])),
          minted: count(`SELECT COUNT(*) n FROM assets WHERE organization_id = ? AND nft_token_id IS NOT NULL`, org),
          frozen: count(`SELECT COUNT(*) n FROM assets WHERE organization_id = ? AND status = 'FROZEN'`, org),
          revoked: count(`SELECT COUNT(*) n FROM assets WHERE organization_id = ? AND status = 'REVOKED'`, org),
        }
      : null;

    const payments = actor.capabilities.has("PAYMENT_READ")
      ? {
          pendingApproval: count(
            `SELECT COUNT(*) n FROM payment_intents WHERE organization_id = ? AND state = 'AWAITING_APPROVAL'`
            + (deptFilter ? ` AND department_id = ?` : ``), ...(deptFilter ? [org, deptFilter] : [org])),
          executed: count(`SELECT COUNT(*) n FROM payment_intents WHERE organization_id = ? AND state IN ('EXECUTED','RECONCILED')`, org),
          denied: count(`SELECT COUNT(*) n FROM payment_intents WHERE organization_id = ? AND state = 'DENIED'`, org),
          unreconciled: count(`SELECT COUNT(*) n FROM payment_intents WHERE organization_id = ? AND state = 'EXECUTED'`, org),
          valueExecuted: Number(one<any>(
            `SELECT COALESCE(SUM(amount),0) n FROM payment_intents WHERE organization_id = ? AND state IN ('EXECUTED','RECONCILED')`, org)?.n ?? 0),
        }
      : null;

    const myApprovals = many<any>(
      `SELECT * FROM approvals WHERE organization_id = ? AND status = 'PENDING' AND requested_by != ?
       ORDER BY created_at DESC LIMIT 10`, org, actor.identityId)
      .filter((a) => actor.capabilities.has(a.required_capability));

    const security = actor.capabilities.has("SECURITY_READ")
      ? {
          open: count(`SELECT COUNT(*) n FROM security_events WHERE organization_id = ? AND acknowledged_at IS NULL`, org),
          critical: count(`SELECT COUNT(*) n FROM security_events WHERE organization_id = ? AND severity = 'CRITICAL' AND acknowledged_at IS NULL`, org),
          recent: orgService.listSecurityEvents(org, 5).map((e) => ({ id: e.id, kind: e.kind, severity: e.severity, summary: e.summary, createdAt: e.created_at })),
        }
      : null;

    const decisions = many<any>(
      `SELECT decision, COUNT(*) n FROM audit_events WHERE organization_id = ? AND timestamp >= datetime('now','-7 days') GROUP BY decision`, org)
      .reduce((acc: Record<string, number>, r) => { acc[r.decision] = Number(r.n); return acc; }, {});

    return {
      workspace: actor.roleNames,
      identities, agents, assets, payments, security, decisions,
      pendingForMe: myApprovals.map((a) => ({
        id: a.id, requestType: a.request_type, requestId: a.request_id,
        reason: a.reason, requiredCapability: a.required_capability, createdAt: a.created_at,
      })),
      recentActivity: audit.query({
        organizationId: org,
        actorId: actor.roleNames.some((r) => ["Admin", "Auditor", "Manager"].includes(r)) ? undefined : actor.identityId,
        limit: 15,
      }).events.map(audit.toApi),
      auditChain: actor.capabilities.has("AUDIT_READ") ? audit.verifyChain(org) : null,
      emergencyFlags: orgService.listEmergencyFlags(org),
    };
  });

  /** Integration health — shows exactly which adapters are live vs simulated, so a
   *  reviewer is never left guessing whether a "successful" payment touched a provider. */
  app.get("/api/integrations/status", async (req) => {
    const actor = requireActor(req);
    authz.enforce({ actor, action: "INTEGRATION_READ", resource: { type: "INTEGRATION", query: true }, ip: req.ip });
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

  app.get("/api/health", async () => ({
    status: "ok",
    version: "3.0.0",
    time: new Date().toISOString(),
    database: (() => { try { one(`SELECT 1 n`); return "connected"; } catch { return "unavailable"; } })(),
  }));
}
