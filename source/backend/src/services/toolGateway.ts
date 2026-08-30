import { run, j, one } from "../db/client.js";
import { newId, newTraceId } from "../core/ids.js";
import { nowIso } from "../core/time.js";
import { getTool } from "./toolRegistry.js";
import * as authz from "./authorizationService.js";
import * as audit from "./auditService.js";
import * as paymentService from "./paymentService.js";
import * as assetService from "./assetService.js";
import * as ragService from "./ragService.js";
import * as policyService from "./policyService.js";
import * as orgService from "./orgService.js";
import { DENY_MESSAGES } from "../authorization/types.js";
import type { ActorContext } from "../authorization/types.js";

/**
 * The AI Tool Gateway (SRD §9).
 *
 * This is the single door between an AI agent and every domain service. No route calls
 * a domain mutation on an agent's behalf except through here, which is what makes
 * "the AI cannot bypass authorization" a structural fact rather than a claim.
 *
 * Every call runs the same seven steps, in this order:
 *   1. authenticate the agent (done upstream; an ActorContext with kind=AGENT is required)
 *   2. resolve the tool against a closed allowlist
 *   3. confirm the tool is on THIS agent's allowlist
 *   4. schema-validate the arguments (strict — unknown keys rejected)
 *   5. re-authorize through the central engine, with the tool name in context
 *   6. route through approval when policy demands it
 *   7. audit the outcome, whatever it was
 *
 * Steps 3-5 are separate on purpose. A model that hallucinates a tool fails at 2; a
 * compromised agent reaching for a tool it was never granted fails at 3; a well-formed
 * call that exceeds a limit fails at 5. Collapsing them would lose the ability to tell
 * those three incidents apart in the audit trail.
 */

export interface ToolCallResult {
  ok: boolean;
  tool: string;
  decision: "ALLOW" | "DENY" | "REQUIRE_APPROVAL";
  reasonCodes: string[];
  message: string;
  data: unknown;
  traceId: string;
  evaluation: unknown[];
  approvalId?: string | null;
}

export async function invoke(params: {
  actor: ActorContext;
  toolName: string;
  args: unknown;
  traceId?: string;
  ip?: string | null;
}): Promise<ToolCallResult> {
  const { actor, toolName } = params;
  const traceId = params.traceId ?? newTraceId();
  const started = Date.now();

  const finish = (result: Omit<ToolCallResult, "traceId" | "tool">): ToolCallResult => {
    const full: ToolCallResult = { ...result, traceId, tool: toolName };
    if (actor.agent) {
      run(
        `INSERT INTO agent_tool_calls (id, agent_id, trace_id, tool_name, args_json, decision, reason_codes, result_ref, latency_ms, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        newId("tool"), actor.agent.id, traceId, toolName, j.enc(params.args ?? {}),
        full.decision, j.enc(full.reasonCodes), full.approvalId ?? null, Date.now() - started, nowIso(),
      );
    }
    return full;
  };

  // ---- Step 2: closed allowlist ----
  const tool = getTool(toolName);
  if (!tool) {
    audit.record({
      organizationId: actor.organizationId, traceId, actorId: actor.identityId, actorDid: actor.did,
      actorKind: actor.kind, action: "TOOL_CALL", resourceType: "TOOL", resourceId: toolName,
      decision: "DENY", reasonCodes: ["TOOL_UNKNOWN"],
      payload: { reason: "Tool is not in the registry." },
    });
    orgService.recordSecurityEvent({
      organizationId: actor.organizationId, kind: "UNKNOWN_TOOL_REQUESTED", severity: "HIGH",
      actorId: actor.identityId,
      summary: `Agent requested an unregistered tool "${toolName}".`,
      detail: { toolName, args: params.args },
    });
    return finish({
      ok: false, decision: "DENY", reasonCodes: ["TOOL_UNKNOWN"],
      message: `"${toolName}" is not a registered tool.`, data: null, evaluation: [],
    });
  }

  // ---- Step 3: this agent's allowlist ----
  if (actor.kind === "AGENT" && actor.agent && !actor.agent.tools.includes(toolName)) {
    audit.record({
      organizationId: actor.organizationId, traceId, actorId: actor.identityId, actorDid: actor.did,
      actorKind: actor.kind, action: "TOOL_CALL", resourceType: "TOOL", resourceId: toolName,
      decision: "DENY", reasonCodes: ["AGENT_TOOL_NOT_ALLOWED"],
      payload: { allowlist: actor.agent.tools },
    });
    return finish({
      ok: false, decision: "DENY", reasonCodes: ["AGENT_TOOL_NOT_ALLOWED"],
      message: DENY_MESSAGES.AGENT_TOOL_NOT_ALLOWED, data: null, evaluation: [],
    });
  }

  // ---- Step 4: strict argument validation ----
  const parsed = tool.schema.safeParse(params.args ?? {});
  if (!parsed.success) {
    audit.record({
      organizationId: actor.organizationId, traceId, actorId: actor.identityId, actorDid: actor.did,
      actorKind: actor.kind, action: "TOOL_CALL", resourceType: "TOOL", resourceId: toolName,
      decision: "DENY", reasonCodes: ["INVALID_ARGUMENTS"],
      payload: { issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) },
    });
    return finish({
      ok: false, decision: "DENY", reasonCodes: ["INVALID_ARGUMENTS"],
      message: "Tool arguments failed schema validation.",
      data: { issues: parsed.error.issues }, evaluation: [],
    });
  }
  const args = parsed.data as any;

  // ---- Step 5: re-authorize centrally ----
  const resource = describeResource(actor, tool.resourceType, args);
  const authResult = authz.check({
    actor,
    action: tool.capability,
    resource,
    context: {
      toolName,
      amount: typeof args.amount === "number" ? args.amount : undefined,
      currency: args.currency,
      merchant: args.merchant,
      evidenceCount: Array.isArray(args.evidenceIds) ? args.evidenceIds.length : undefined,
    },
    traceId,
  });

  audit.record({
    organizationId: actor.organizationId, traceId, actorId: actor.identityId, actorDid: actor.did,
    actorKind: actor.kind, action: "TOOL_CALL", resourceType: "TOOL", resourceId: toolName,
    decision: authResult.decision, reasonCodes: authResult.reasonCodes,
    policyId: authResult.policyId, policyVersion: authResult.policyVersion, ip: params.ip ?? null,
    payload: { capability: tool.capability, args: redact(args), evaluation: authResult.evaluation },
  });

  if (authResult.decision === "DENY") {
    if (actor.kind === "AGENT") {
      orgService.recordSecurityEvent({
        organizationId: actor.organizationId, kind: "AGENT_ACTION_BLOCKED",
        severity: authResult.reasonCodes.includes("AGENT_FROZEN") ? "MEDIUM" : "HIGH",
        actorId: actor.identityId,
        summary: `Agent tool call "${toolName}" was blocked: ${authResult.reasonCodes.join(", ")}.`,
        detail: { toolName, reasonCodes: authResult.reasonCodes, args: redact(args) },
      });
    }
    const primary = authResult.reasonCodes[0] ?? "POLICY_VIOLATION";
    return finish({
      ok: false, decision: "DENY", reasonCodes: authResult.reasonCodes,
      message: (DENY_MESSAGES as any)[primary] ?? "This action is not permitted.",
      data: null, evaluation: authResult.evaluation,
    });
  }

  // ---- Steps 6-7: execute (or hold), then audit ----
  try {
    const outcome = await execute(actor, tool.name, args, traceId, authResult);
    return finish({
      ok: outcome.decision !== "DENY",
      decision: outcome.decision,
      reasonCodes: authResult.reasonCodes,
      message: outcome.message,
      data: outcome.data,
      evaluation: authResult.evaluation,
      approvalId: outcome.approvalId ?? null,
    });
  } catch (err: any) {
    audit.record({
      organizationId: actor.organizationId, traceId, actorId: actor.identityId, actorDid: actor.did,
      actorKind: actor.kind, action: "TOOL_EXECUTION_FAILED", resourceType: "TOOL", resourceId: toolName,
      decision: "FAILED", reasonCodes: ["EXECUTION_ERROR"],
      payload: { error: String(err?.message ?? err) },
    });
    return finish({
      ok: false, decision: "DENY", reasonCodes: ["EXECUTION_ERROR"],
      message: String(err?.message ?? err), data: null, evaluation: authResult.evaluation,
    });
  }
}

function describeResource(actor: ActorContext, resourceType: string, args: any) {
  if (resourceType === "ASSET" && args.assetId) {
    const asset = one<any>(`SELECT * FROM assets WHERE id = ? AND organization_id = ?`, args.assetId, actor.organizationId);
    return {
      type: "ASSET", id: args.assetId,
      organizationId: asset?.organization_id ?? actor.organizationId,
      departmentId: asset?.department_id ?? null,
      collectionId: asset?.collection_id ?? null,
      ownerDid: asset?.owner_did ?? null,
    };
  }
  if (resourceType === "DOCUMENT" || resourceType === "POLICY") {
    // Knowledge and policy lookups are collection queries: there is no single document
    // to scope-match against, and the real access boundary is applied per-result inside
    // ragService.retrieveForActor / the policy read. Marking this a query keeps the
    // engine honest — it records SCOPE_CHECK as DEFERRED rather than pretending to have
    // matched a scope it never saw.
    return {
      type: resourceType, id: args.policyId ?? null, query: true,
      organizationId: actor.organizationId, departmentId: actor.departmentId,
    };
  }
  if (resourceType === "PAYMENT") {
    return {
      type: "PAYMENT", id: null,
      organizationId: actor.organizationId,
      departmentId: actor.departmentId,
      vendor: args.merchant ?? null,
    };
  }
  return { type: resourceType, id: args.policyId ?? args.assetId ?? null, organizationId: actor.organizationId, departmentId: actor.departmentId };
}

/** Never write raw free text into an audit payload where it could be re-read as an
 *  instruction by a downstream operator or another model. Truncate and label. */
function redact(args: any) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args ?? {})) {
    out[k] = typeof v === "string" && v.length > 300 ? `${v.slice(0, 300)}… [truncated]` : v;
  }
  return out;
}

async function execute(
  actor: ActorContext, toolName: string, args: any, traceId: string,
  authResult: { decision: string; policyId: string | null; policyVersion: number | null },
): Promise<{ decision: "ALLOW" | "DENY" | "REQUIRE_APPROVAL"; message: string; data: unknown; approvalId?: string | null }> {
  switch (toolName) {
    case "search_knowledge": {
      const result = ragService.retrieveForActor(actor, args.query, args.limit ?? 5);
      return {
        decision: "ALLOW",
        message: `Retrieved ${result.chunks.length} chunk(s) from ${result.filtered.accessibleDocuments} accessible document(s).`,
        data: result,
      };
    }
    case "get_invoice": {
      const result = ragService.retrieveForActor(actor, args.invoiceRef, 3);
      return {
        decision: "ALLOW",
        message: result.chunks.length ? `Found ${result.chunks.length} matching passage(s).` : "No accessible document matched that invoice reference.",
        data: result,
      };
    }
    case "get_asset": {
      const asset = assetService.getAsset(actor.organizationId, args.assetId);
      if (!asset) return { decision: "DENY", message: "Asset not found.", data: null };
      return { decision: "ALLOW", message: "Asset retrieved.", data: assetService.toApi(asset) };
    }
    case "get_policy": {
      const policy = policyService.getPolicy(actor.organizationId, args.policyId);
      if (!policy) return { decision: "DENY", message: "Policy not found.", data: null };
      return { decision: "ALLOW", message: "Policy retrieved.", data: policyService.toApi(policy) };
    }
    case "create_payment_intent": {
      const { intent } = paymentService.createIntent(actor, {
        merchant: args.merchant, amount: args.amount, currency: args.currency,
        purpose: args.purpose, invoiceRef: args.invoiceRef ?? null,
        evidence: args.evidenceIds ?? [], agentId: actor.agent?.id ?? null,
      });
      // Authorization runs again inside authorizeIntent against the *stored* row — the
      // gateway's own check used the same numbers, but re-reading from the row is what
      // guarantees the executed amount equals the authorized amount.
      const authorized = paymentService.authorizeIntent(actor, intent.id);
      if (authorized.decision === "DENY") {
        return { decision: "DENY", message: `Payment denied: ${authorized.reasonCodes?.join(", ")}.`, data: paymentService.toApi(authorized.intent) };
      }
      if (authorized.decision === "REQUIRE_APPROVAL") {
        return {
          decision: "REQUIRE_APPROVAL",
          message: "Payment requires human approval and has been sent to the Approval Center.",
          data: paymentService.toApi(authorized.intent),
          approvalId: authorized.approval?.id ?? null,
        };
      }
      return { decision: "ALLOW", message: "Payment intent authorized and ready to execute.", data: paymentService.toApi(authorized.intent) };
    }
    case "request_asset_transfer": {
      // An agent never performs a transfer directly. It raises a request that a human
      // with ASSET_TRANSFER must approve — the asset equivalent of the payment hold.
      const approval = (await import("./approvalService.js")).createApproval({
        organizationId: actor.organizationId,
        requestType: "ASSET_TRANSFER", requestId: args.assetId,
        requestedBy: actor.identityId,
        reason: args.reason || "Agent-proposed asset transfer.",
        requiredCapability: "ASSET_TRANSFER",
        evidence: { assetId: args.assetId, newOwnerDid: args.newOwnerDid, proposedBy: actor.did },
        policyId: authResult.policyId, policyVersion: authResult.policyVersion,
        traceId,
      });
      return {
        decision: "REQUIRE_APPROVAL",
        message: "Asset transfer proposed. A human with ASSET_TRANSFER must approve it.",
        data: { approvalId: approval.id, assetId: args.assetId, newOwnerDid: args.newOwnerDid },
        approvalId: approval.id,
      };
    }
    default:
      return { decision: "DENY", message: `No handler is wired for tool "${toolName}".`, data: null };
  }
}
