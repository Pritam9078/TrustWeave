import { newTraceId } from "../core/ids.js";
import { isKnownCapability } from "./capabilities.js";
import { findMatchingScope, withinTimeWindow, type ScopeRecord } from "./scope.js";
import { evaluatePolicy, policyApplies, type PolicyRecord } from "./policy.js";
import type {
  ActorContext, AuthorizationContext, AuthorizationResult, Decision,
  EvaluationStep, ReasonCode, ResourceDescriptor,
} from "./types.js";

/**
 * The authorization engine — the single decision point for every protected operation
 * in TrustWeave (SRD §5).
 *
 * It is a pure function. Everything it needs (the actor's resolved capabilities and
 * scopes, the applicable policy versions, rolling spend figures, emergency flags) is
 * passed in by `services/authorizationService.ts`, which does the I/O. Keeping the
 * decision logic free of database access is what makes the whole authorization matrix
 * testable as plain data, and it means there is no code path where a query failure
 * silently degrades into an ALLOW.
 *
 * Gate order is fixed and matches SRD §5's evaluation order. It runs cheapest-and-most-
 * absolute first: a frozen agent is rejected before any policy is loaded, so freezing
 * an agent cannot be raced by a request that has already passed a policy check.
 */

export interface AuthorizeInput {
  actor: ActorContext;
  action: string;
  resource: ResourceDescriptor;
  context?: AuthorizationContext;
  scopes: ScopeRecord[];
  policies: PolicyRecord[];
  emergencyFlags?: Record<string, boolean>;
  traceId?: string;
}

/** Which kill switch, if any, governs a given action. */
function lockdownFlagFor(action: string): string | null {
  if (action.startsWith("PAYMENT_") || action === "REFUND_CREATE") return "PAYMENTS_DISABLED";
  if (action === "ASSET_MINT") return "MINTING_DISABLED";
  return null;
}

export function authorize(input: AuthorizeInput): AuthorizationResult {
  const {
    actor, action, resource,
    context = {}, scopes, policies,
    emergencyFlags = {},
  } = input;
  const traceId = input.traceId ?? newTraceId();
  const evaluation: EvaluationStep[] = [];

  const deny = (code: ReasonCode, detail: string, step: string): AuthorizationResult => {
    evaluation.push({ step, outcome: "FAIL", detail });
    return {
      decision: "DENY", reasonCodes: [code], policyId: null, policyVersion: null,
      approvalRequired: false, traceId, evaluation, matchedScopeId: null,
    };
  };

  // ---- Gate 1: is the capability even part of the system's vocabulary? ----
  // Catches typos in route wiring and, more importantly, refuses to honour an
  // invented capability name that somehow reached a role.
  if (!isKnownCapability(action)) {
    return deny("CAPABILITY_UNKNOWN", `"${action}" is not in the capability catalog.`, "CAPABILITY_CATALOG");
  }
  evaluation.push({ step: "CAPABILITY_CATALOG", outcome: "PASS", detail: `${action} is a recognised capability.` });

  // ---- Gate 2: actor identity status ----
  if (actor.identityStatus !== "ACTIVE") {
    return deny("IDENTITY_INACTIVE", `Identity status is ${actor.identityStatus}.`, "IDENTITY_STATUS");
  }
  evaluation.push({ step: "IDENTITY_STATUS", outcome: "PASS", detail: "Identity is ACTIVE." });

  // ---- Gate 3: organization membership ----
  if (actor.membershipStatus !== "ACTIVE") {
    return deny("MEMBERSHIP_INACTIVE", `Membership status is ${actor.membershipStatus}.`, "MEMBERSHIP");
  }
  evaluation.push({ step: "MEMBERSHIP", outcome: "PASS", detail: "Organization membership is ACTIVE." });

  // ---- Gate 4: tenant boundary ----
  // Checked here as well as in every repository query. Defence in depth: a single
  // forgotten WHERE clause downstream still cannot produce a cross-tenant ALLOW.
  if (resource.organizationId && resource.organizationId !== actor.organizationId) {
    return deny("ORG_MISMATCH", "Resource belongs to a different organization.", "TENANT_BOUNDARY");
  }
  evaluation.push({ step: "TENANT_BOUNDARY", outcome: "PASS", detail: "Resource is inside the actor's organization." });

  // ---- Gate 5: emergency lockdown ----
  // Before capability resolution so a kill switch beats every permission an actor holds.
  const flag = lockdownFlagFor(action);
  if (flag && emergencyFlags[flag]) {
    return deny("EMERGENCY_LOCKDOWN", `Administrator has enabled ${flag}.`, "EMERGENCY_CONTROLS");
  }
  if (actor.kind === "AGENT" && emergencyFlags.AGENTS_DISABLED) {
    return deny("EMERGENCY_LOCKDOWN", "Administrator has disabled all agent execution.", "EMERGENCY_CONTROLS");
  }
  evaluation.push({ step: "EMERGENCY_CONTROLS", outcome: "PASS", detail: "No emergency lockdown applies." });

  // ---- Gate 6: agent-specific state ----
  if (actor.kind === "AGENT") {
    const agent = actor.agent;
    if (!agent) return deny("AGENT_FROZEN", "Agent record could not be resolved.", "AGENT_STATE");
    if (agent.status !== "ACTIVE") {
      return deny("AGENT_FROZEN", `Agent status is ${agent.status}.`, "AGENT_STATE");
    }
    if (context.toolName && !agent.tools.includes(context.toolName)) {
      return deny("AGENT_TOOL_NOT_ALLOWED", `Tool "${context.toolName}" is not on this agent's allowlist.`, "AGENT_TOOL_ALLOWLIST");
    }
    evaluation.push({ step: "AGENT_STATE", outcome: "PASS", detail: "Agent is ACTIVE and the tool is allowlisted." });
  }

  // ---- Gate 7: capability held? ----
  if (!actor.capabilities.has(action)) {
    return deny("CAPABILITY_MISSING", `Actor does not hold ${action}. Held: ${[...actor.capabilities].sort().join(", ") || "none"}.`, "CAPABILITY_CHECK");
  }
  evaluation.push({ step: "CAPABILITY_CHECK", outcome: "PASS", detail: `Actor holds ${action}.` });

  // ---- Gate 8: resource scope ----
  // A collection query is authorized at the capability level only; each returned row is
  // then evaluated individually by the caller. Recorded explicitly so the trace never
  // implies a scope check happened when it did not.
  if (resource.query) {
    if (!scopes.length) {
      evaluation.push({ step: "SCOPE_CHECK", outcome: "FAIL", detail: "Collection query refused: the actor has no assigned scopes, so no row could be visible." });
      return {
        decision: "DENY", reasonCodes: ["SCOPE_MISMATCH"], policyId: null, policyVersion: null,
        approvalRequired: false, traceId, evaluation, matchedScopeId: null,
      };
    }
    evaluation.push({
      step: "SCOPE_CHECK", outcome: "DEFERRED",
      detail: `Collection query over ${resource.type}. Capability granted; visibility of each row is decided individually against ${scopes.length} assigned scope(s).`,
    });
    return {
      decision: "ALLOW", reasonCodes: [], policyId: null, policyVersion: null,
      approvalRequired: false, traceId, evaluation, matchedScopeId: null,
    };
  }

  const scopeMatch = findMatchingScope(scopes, { ...resource, organizationId: resource.organizationId ?? actor.organizationId });
  if (!scopeMatch.matched) {
    evaluation.push({ step: "SCOPE_CHECK", outcome: "FAIL", detail: scopeMatch.reason });
    return {
      decision: "DENY", reasonCodes: ["SCOPE_MISMATCH"], policyId: null, policyVersion: null,
      approvalRequired: false, traceId, evaluation, matchedScopeId: null,
    };
  }
  evaluation.push({ step: "SCOPE_CHECK", outcome: "PASS", detail: scopeMatch.reason });

  // ---- Gate 9: scope-level constraints ----
  const constraints = scopeMatch.scope?.constraints ?? {};
  const at = context.at ?? new Date();
  if (constraints.maxAmount !== undefined && context.amount !== undefined && context.amount > constraints.maxAmount) {
    evaluation.push({ step: "SCOPE_CONSTRAINTS", outcome: "FAIL", detail: `Amount ${context.amount} exceeds the scope cap of ${constraints.maxAmount}.` });
    return {
      decision: "DENY", reasonCodes: ["LIMIT_EXCEEDED"], policyId: null, policyVersion: null,
      approvalRequired: false, traceId, evaluation, matchedScopeId: scopeMatch.scope?.id ?? null,
    };
  }
  if (constraints.timeWindow && !withinTimeWindow(constraints.timeWindow, at)) {
    evaluation.push({ step: "SCOPE_CONSTRAINTS", outcome: "FAIL", detail: `Outside the scope time window ${constraints.timeWindow.from}–${constraints.timeWindow.to}.` });
    return {
      decision: "DENY", reasonCodes: ["TIME_WINDOW_VIOLATION"], policyId: null, policyVersion: null,
      approvalRequired: false, traceId, evaluation, matchedScopeId: scopeMatch.scope?.id ?? null,
    };
  }
  evaluation.push({ step: "SCOPE_CONSTRAINTS", outcome: "PASS", detail: "Scope constraints satisfied." });

  // ---- Gate 10: agent limits ----
  // Enforced separately from policy so an agent's own ceiling still binds even when
  // no org policy happens to cover this action. An agent with no matching policy is
  // not therefore unlimited.
  let decision: Decision = "ALLOW";
  const reasonCodes: ReasonCode[] = [];
  let approvalRequired = false;

  if (actor.kind === "AGENT" && actor.agent && context.amount !== undefined) {
    const limits = actor.agent.limits ?? {};
    if (limits.transactionLimit !== undefined && context.amount > limits.transactionLimit) {
      evaluation.push({ step: "AGENT_LIMITS", outcome: "FAIL", detail: `Amount ${context.amount} exceeds the agent transaction limit of ${limits.transactionLimit}.` });
      return {
        decision: "DENY", reasonCodes: ["LIMIT_EXCEEDED"], policyId: null, policyVersion: null,
        approvalRequired: false, traceId, evaluation, matchedScopeId: scopeMatch.scope?.id ?? null,
      };
    }
    if (limits.dailyLimit !== undefined && context.spend && context.spend.windowAmount + context.amount > limits.dailyLimit) {
      evaluation.push({ step: "AGENT_LIMITS", outcome: "FAIL", detail: `Rolling daily spend would exceed the agent daily limit of ${limits.dailyLimit}.` });
      return {
        decision: "DENY", reasonCodes: ["VELOCITY_EXCEEDED"], policyId: null, policyVersion: null,
        approvalRequired: false, traceId, evaluation, matchedScopeId: scopeMatch.scope?.id ?? null,
      };
    }
    if (limits.velocityCountPerDay !== undefined && context.spend && context.spend.windowCount + 1 > limits.velocityCountPerDay) {
      evaluation.push({ step: "AGENT_LIMITS", outcome: "FAIL", detail: `Transaction count would exceed the agent daily cap of ${limits.velocityCountPerDay}.` });
      return {
        decision: "DENY", reasonCodes: ["VELOCITY_EXCEEDED"], policyId: null, policyVersion: null,
        approvalRequired: false, traceId, evaluation, matchedScopeId: scopeMatch.scope?.id ?? null,
      };
    }
    if (limits.approvalThreshold !== undefined && context.amount > limits.approvalThreshold) {
      approvalRequired = true;
      decision = "REQUIRE_APPROVAL";
      reasonCodes.push("APPROVAL_REQUIRED");
      evaluation.push({ step: "AGENT_LIMITS", outcome: "HOLD", detail: `Amount ${context.amount} is above the agent approval threshold of ${limits.approvalThreshold}.` });
    } else {
      evaluation.push({ step: "AGENT_LIMITS", outcome: "PASS", detail: "Within all configured agent limits." });
    }
  }

  // ---- Gate 11: applicable policy versions ----
  const applicable = policies.filter((p) => policyApplies(p, action, resource, actor.kind));
  let policyId: string | null = null;
  let policyVersion: number | null = null;

  if (applicable.length === 0) {
    evaluation.push({ step: "POLICY_EVALUATION", outcome: "SKIP", detail: "No active policy governs this action; capability and scope checks stand alone." });
  } else {
    for (const policy of applicable) {
      const result = evaluatePolicy(policy, {
        actorDepartmentId: actor.departmentId,
        resource,
        context,
      });
      evaluation.push(...result.steps.map((s) => ({ ...s, step: `${policy.name} v${policy.version} · ${s.step}` })));
      policyId ??= policy.id;
      policyVersion ??= policy.version;

      if (result.decision === "DENY") {
        return {
          decision: "DENY",
          reasonCodes: result.reasonCodes,
          policyId: policy.id, policyVersion: policy.version,
          approvalRequired: false, traceId, evaluation,
          matchedScopeId: scopeMatch.scope?.id ?? null,
        };
      }
      if (result.decision === "REQUIRE_APPROVAL") {
        approvalRequired = true;
        decision = "REQUIRE_APPROVAL";
        for (const c of result.reasonCodes) if (!reasonCodes.includes(c)) reasonCodes.push(c);
        policyId = policy.id;
        policyVersion = policy.version;
      }
    }
  }

  if (decision === "ALLOW") reasonCodes.push("OK");
  evaluation.push({
    step: "DECISION",
    outcome: decision === "ALLOW" ? "PASS" : "HOLD",
    detail: decision === "ALLOW" ? "All gates passed." : "Routed to the Approval Center.",
  });

  return {
    decision, reasonCodes, policyId, policyVersion,
    approvalRequired, traceId, evaluation,
    matchedScopeId: scopeMatch.scope?.id ?? null,
  };
}
