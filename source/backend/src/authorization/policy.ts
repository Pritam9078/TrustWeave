import type { AuthorizationContext, Decision, EvaluationStep, ReasonCode, ResourceDescriptor } from "./types.js";
import { withinTimeWindow } from "./scope.js";

/**
 * The policy rule evaluator.
 *
 * Pure and dependency-free: no I/O, no LLM, no clock reads it wasn't handed, no
 * randomness. Every rolling-window figure it needs arrives as a parameter. That
 * purity is the point — this is the file a reviewer should be able to read top to
 * bottom and trust completely, and it is the reason a prompt-injected instruction
 * has no surface to act on here.
 *
 * Extends the baseline's fixed-field payment checker into a versioned JSON rule DSL
 * so the same evaluator governs assets and role assignments, not just payments.
 */

export type RuleOutcome = "DENY" | "REQUIRE_APPROVAL";

export type PolicyRule =
  | { type: "AMOUNT_MAX"; value: number; onFail?: RuleOutcome }
  | { type: "AMOUNT_MIN"; value: number; onFail?: RuleOutcome }
  | { type: "APPROVAL_THRESHOLD"; value: number }
  | { type: "MERCHANT_ALLOWLIST"; values: string[]; onFail?: RuleOutcome }
  | { type: "MERCHANT_BLOCKLIST"; values: string[]; onFail?: RuleOutcome }
  | { type: "VELOCITY"; window: "1h" | "1d" | "7d" | "30d"; maxAmount?: number; maxCount?: number; onFail?: RuleOutcome }
  | { type: "TIME_WINDOW"; from: string; to: string; onFail?: RuleOutcome }
  | { type: "DEPARTMENT_MATCH"; onFail?: RuleOutcome }
  | { type: "REQUIRE_EVIDENCE"; min?: number; onFail?: RuleOutcome }
  | { type: "CURRENCY_ALLOWLIST"; values: string[]; onFail?: RuleOutcome }
  | { type: "DUAL_APPROVAL_ABOVE"; value: number };

export interface PolicyAppliesTo {
  actions?: string[];
  resourceTypes?: string[];
  departmentIds?: string[];
  actorKinds?: string[];
}

export interface PolicyConditions {
  rules: PolicyRule[];
}

export interface PolicyRecord {
  id: string;
  policyKey: string;
  organizationId: string;
  name: string;
  version: number;
  status: string;
  conditions: PolicyConditions;
  appliesTo: PolicyAppliesTo;
  hash: string;
}

export interface PolicyEvaluation {
  decision: Decision;
  reasonCodes: ReasonCode[];
  steps: EvaluationStep[];
  /** Populated when a rule routed the action to approval rather than denying it. */
  approvalReason: string | null;
  dualApproval: boolean;
}

/**
 * Does this policy govern the request at hand? An empty list on a dimension means
 * "any" — the common case is a policy that applies to one action across the whole org.
 */
export function policyApplies(
  policy: PolicyRecord,
  action: string,
  resource: ResourceDescriptor,
  actorKind: string,
): boolean {
  if (policy.status !== "ACTIVE") return false;
  const a = policy.appliesTo ?? {};
  if (a.actions?.length && !a.actions.includes(action)) return false;
  if (a.resourceTypes?.length && !a.resourceTypes.includes(resource.type)) return false;
  if (a.actorKinds?.length && !a.actorKinds.includes(actorKind)) return false;
  if (a.departmentIds?.length) {
    if (!resource.departmentId || !a.departmentIds.includes(resource.departmentId)) return false;
  }
  return true;
}

const norm = (s: string) => s.trim().toLowerCase();

/**
 * Evaluate one policy version's rules.
 *
 * Ordering rule that matters: a DENY anywhere wins over a REQUIRE_APPROVAL anywhere.
 * We therefore evaluate *every* rule and combine, rather than returning on the first
 * hit. Returning early would let rule ordering decide whether an over-limit payment
 * is blocked or merely held for a human — which is exactly the kind of silent,
 * configuration-dependent security difference that should not exist.
 */
export function evaluatePolicy(
  policy: PolicyRecord,
  params: {
    actorDepartmentId: string | null;
    resource: ResourceDescriptor;
    context: AuthorizationContext;
  },
): PolicyEvaluation {
  const { resource, context, actorDepartmentId } = params;
  const at = context.at ?? new Date();
  const steps: EvaluationStep[] = [];
  const reasons: ReasonCode[] = [];
  let denied = false;
  let approvalNeeded = false;
  let approvalReason: string | null = null;
  let dualApproval = false;

  const fail = (rule: { onFail?: RuleOutcome }, code: ReasonCode, label: string, detail: string) => {
    const outcome = rule.onFail ?? "DENY";
    if (outcome === "DENY") {
      denied = true;
      if (!reasons.includes(code)) reasons.push(code);
      steps.push({ step: label, outcome: "FAIL", detail });
    } else {
      approvalNeeded = true;
      approvalReason ??= detail;
      if (!reasons.includes("APPROVAL_REQUIRED")) reasons.push("APPROVAL_REQUIRED");
      steps.push({ step: label, outcome: "HOLD", detail });
    }
  };

  for (const rule of policy.conditions?.rules ?? []) {
    switch (rule.type) {
      case "AMOUNT_MAX": {
        if (context.amount === undefined) { steps.push({ step: "AMOUNT_MAX", outcome: "SKIP", detail: "No amount in context." }); break; }
        if (context.amount > rule.value) {
          fail(rule, "LIMIT_EXCEEDED", "AMOUNT_MAX", `Amount ${context.amount} exceeds the policy maximum of ${rule.value}.`);
        } else {
          steps.push({ step: "AMOUNT_MAX", outcome: "PASS", detail: `Amount ${context.amount} is within the maximum of ${rule.value}.` });
        }
        break;
      }
      case "AMOUNT_MIN": {
        if (context.amount === undefined) break;
        if (context.amount < rule.value) fail(rule, "POLICY_VIOLATION", "AMOUNT_MIN", `Amount ${context.amount} is below the minimum of ${rule.value}.`);
        else steps.push({ step: "AMOUNT_MIN", outcome: "PASS", detail: `Amount meets the minimum of ${rule.value}.` });
        break;
      }
      case "APPROVAL_THRESHOLD": {
        if (context.amount === undefined) break;
        if (context.amount > rule.value) {
          approvalNeeded = true;
          approvalReason ??= `Amount ${context.amount} is above the approval threshold of ${rule.value}.`;
          if (!reasons.includes("APPROVAL_REQUIRED")) reasons.push("APPROVAL_REQUIRED");
          steps.push({ step: "APPROVAL_THRESHOLD", outcome: "HOLD", detail: approvalReason });
        } else {
          steps.push({ step: "APPROVAL_THRESHOLD", outcome: "PASS", detail: `Amount ${context.amount} is below the approval threshold of ${rule.value}.` });
        }
        break;
      }
      case "DUAL_APPROVAL_ABOVE": {
        if (context.amount === undefined) break;
        if (context.amount > rule.value) {
          dualApproval = true;
          approvalNeeded = true;
          approvalReason ??= `Amount ${context.amount} requires dual approval (threshold ${rule.value}).`;
          if (!reasons.includes("APPROVAL_REQUIRED")) reasons.push("APPROVAL_REQUIRED");
          steps.push({ step: "DUAL_APPROVAL_ABOVE", outcome: "HOLD", detail: approvalReason });
        }
        break;
      }
      case "MERCHANT_ALLOWLIST": {
        const merchant = context.merchant ?? resource.vendor ?? null;
        if (!merchant) { fail(rule, "POLICY_VIOLATION", "MERCHANT_ALLOWLIST", "No merchant was supplied for an allowlist-governed action."); break; }
        if (!rule.values.map(norm).includes(norm(merchant))) {
          fail(rule, "POLICY_VIOLATION", "MERCHANT_ALLOWLIST", `Merchant "${merchant}" is not on the policy allowlist.`);
        } else {
          steps.push({ step: "MERCHANT_ALLOWLIST", outcome: "PASS", detail: `Merchant "${merchant}" is allowlisted.` });
        }
        break;
      }
      case "MERCHANT_BLOCKLIST": {
        const merchant = context.merchant ?? resource.vendor ?? null;
        if (merchant && rule.values.map(norm).includes(norm(merchant))) {
          fail(rule, "POLICY_VIOLATION", "MERCHANT_BLOCKLIST", `Merchant "${merchant}" is explicitly blocked.`);
        } else {
          steps.push({ step: "MERCHANT_BLOCKLIST", outcome: "PASS", detail: "Merchant is not blocklisted." });
        }
        break;
      }
      case "CURRENCY_ALLOWLIST": {
        const cur = context.currency;
        if (!cur) break;
        if (!rule.values.map(norm).includes(norm(cur))) fail(rule, "POLICY_VIOLATION", "CURRENCY_ALLOWLIST", `Currency ${cur} is not permitted.`);
        else steps.push({ step: "CURRENCY_ALLOWLIST", outcome: "PASS", detail: `Currency ${cur} is permitted.` });
        break;
      }
      case "VELOCITY": {
        const spend = context.spend;
        if (!spend || spend.window !== rule.window) {
          steps.push({ step: "VELOCITY", outcome: "SKIP", detail: `No ${rule.window} rolling figures supplied.` });
          break;
        }
        const projectedAmount = spend.windowAmount + (context.amount ?? 0);
        const projectedCount = spend.windowCount + 1;
        if (rule.maxAmount !== undefined && projectedAmount > rule.maxAmount) {
          fail(rule, "VELOCITY_EXCEEDED", "VELOCITY", `Rolling ${rule.window} spend would reach ${projectedAmount}, over the ${rule.maxAmount} cap.`);
        } else if (rule.maxCount !== undefined && projectedCount > rule.maxCount) {
          fail(rule, "VELOCITY_EXCEEDED", "VELOCITY", `Rolling ${rule.window} count would reach ${projectedCount}, over the ${rule.maxCount} cap.`);
        } else {
          steps.push({ step: "VELOCITY", outcome: "PASS", detail: `Within the ${rule.window} rolling limits.` });
        }
        break;
      }
      case "TIME_WINDOW": {
        if (withinTimeWindow({ from: rule.from, to: rule.to }, at)) {
          steps.push({ step: "TIME_WINDOW", outcome: "PASS", detail: `Inside the permitted window ${rule.from}–${rule.to}.` });
        } else {
          fail(rule, "TIME_WINDOW_VIOLATION", "TIME_WINDOW", `Outside the permitted window ${rule.from}–${rule.to}.`);
        }
        break;
      }
      case "DEPARTMENT_MATCH": {
        if (!resource.departmentId) { steps.push({ step: "DEPARTMENT_MATCH", outcome: "SKIP", detail: "Resource has no department." }); break; }
        if (resource.departmentId !== actorDepartmentId) {
          fail(rule, "SCOPE_MISMATCH", "DEPARTMENT_MATCH", "Resource department does not match the actor's department.");
        } else {
          steps.push({ step: "DEPARTMENT_MATCH", outcome: "PASS", detail: "Departments match." });
        }
        break;
      }
      case "REQUIRE_EVIDENCE": {
        const min = rule.min ?? 1;
        const count = context.evidenceCount ?? 0;
        if (count < min) fail(rule, "EVIDENCE_MISSING", "REQUIRE_EVIDENCE", `${count} evidence reference(s) supplied; ${min} required.`);
        else steps.push({ step: "REQUIRE_EVIDENCE", outcome: "PASS", detail: `${count} evidence reference(s) supplied.` });
        break;
      }
      default: {
        // Unknown rule type: fail closed and say so loudly rather than silently
        // treating an unrecognised (possibly newer) rule as satisfied.
        denied = true;
        if (!reasons.includes("POLICY_VIOLATION")) reasons.push("POLICY_VIOLATION");
        steps.push({ step: "UNKNOWN_RULE", outcome: "FAIL", detail: `Unrecognised rule type: ${(rule as any).type}. Failing closed.` });
      }
    }
  }

  const decision: Decision = denied ? "DENY" : approvalNeeded ? "REQUIRE_APPROVAL" : "ALLOW";
  if (decision === "ALLOW" && reasons.length === 0) reasons.push("OK");
  return { decision, reasonCodes: reasons, steps, approvalReason, dualApproval };
}
