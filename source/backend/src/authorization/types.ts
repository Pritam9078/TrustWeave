/** Shared authorization vocabulary. SRD §5. */

export type Decision = "ALLOW" | "DENY" | "REQUIRE_APPROVAL";

export type ReasonCode =
  | "OK"
  | "SESSION_INVALID"
  | "IDENTITY_INACTIVE"
  | "MEMBERSHIP_INACTIVE"
  | "ORG_MISMATCH"
  | "CAPABILITY_MISSING"
  | "CAPABILITY_UNKNOWN"
  | "SCOPE_MISMATCH"
  | "POLICY_VIOLATION"
  | "LIMIT_EXCEEDED"
  | "VELOCITY_EXCEEDED"
  | "APPROVAL_REQUIRED"
  | "RESOURCE_NOT_FOUND"
  | "AGENT_FROZEN"
  | "AGENT_TOOL_NOT_ALLOWED"
  | "EMERGENCY_LOCKDOWN"
  | "SELF_APPROVAL_FORBIDDEN"
  | "TIME_WINDOW_VIOLATION"
  | "EVIDENCE_MISSING";

export type ActorKind = "HUMAN" | "AGENT" | "SERVICE";

/** Everything the engine knows about who is asking. Assembled by the session layer,
 *  never by a route handler and never from a request body. */
export interface ActorContext {
  identityId: string;
  did: string;
  kind: ActorKind;
  organizationId: string;
  departmentId: string | null;
  identityStatus: string;
  membershipStatus: string;
  roleIds: string[];
  roleNames: string[];
  capabilities: Set<string>;
  scopeIds: string[];
  /** Present only when the actor is an AI agent. */
  agent?: {
    id: string;
    status: string;
    limits: AgentLimits;
    tools: string[];
  };
}

export interface AgentLimits {
  transactionLimit?: number;
  approvalThreshold?: number;
  dailyLimit?: number;
  velocityCountPerDay?: number;
}

/** The thing being acted upon, described richly enough for scope matching. */
export interface ResourceDescriptor {
  type: string;
  id?: string | null;
  organizationId?: string | null;
  departmentId?: string | null;
  collectionId?: string | null;
  ownerDid?: string | null;
  vendor?: string | null;
  tags?: string[];
  /**
   * Marks a collection query ("list the assets I may see") rather than an operation on
   * one concrete resource. A query has no department or collection of its own, so the
   * per-resource scope gate has nothing to match and would deny every list request.
   * When this is set the engine checks the capability and defers the scope decision to
   * row-level filtering at the call site — which MUST then filter, or the listing leaks.
   * Never set this for a mutation.
   */
  query?: boolean;
}

/** Contextual facts a policy rule may test. */
export interface AuthorizationContext {
  amount?: number;
  currency?: string;
  merchant?: string;
  evidenceCount?: number;
  toolName?: string;
  at?: Date;
  /** Rolling spend/count for velocity rules, supplied by the caller so the engine
   *  itself stays free of I/O and remains unit-testable in isolation. */
  spend?: { windowAmount: number; windowCount: number; window: "1h" | "1d" | "7d" | "30d" };
  [key: string]: unknown;
}

export interface EvaluationStep {
  step: string;
  outcome: "PASS" | "FAIL" | "SKIP" | "HOLD" | "DEFERRED";
  detail: string;
}

export interface AuthorizationResult {
  decision: Decision;
  reasonCodes: ReasonCode[];
  policyId: string | null;
  policyVersion: number | null;
  approvalRequired: boolean;
  traceId: string;
  /** Human-readable trace of every gate, in order. Surfaced verbatim in the UI's
   *  "why was this denied" panel and in the audit record. */
  evaluation: EvaluationStep[];
  matchedScopeId: string | null;
}

export const DENY_MESSAGES: Record<ReasonCode, string> = {
  OK: "Authorized.",
  SESSION_INVALID: "Your session is no longer valid. Sign in again.",
  IDENTITY_INACTIVE: "This identity is suspended or revoked.",
  MEMBERSHIP_INACTIVE: "This organization membership is not active.",
  ORG_MISMATCH: "The resource belongs to a different organization.",
  CAPABILITY_MISSING: "You do not hold the capability required for this action.",
  CAPABILITY_UNKNOWN: "The requested action is not a recognised capability.",
  SCOPE_MISMATCH: "This resource is outside your authorized scope.",
  POLICY_VIOLATION: "An active policy condition blocks this action.",
  LIMIT_EXCEEDED: "The amount exceeds the configured limit.",
  VELOCITY_EXCEEDED: "The rolling velocity limit for this actor has been reached.",
  APPROVAL_REQUIRED: "This action requires human approval before it can execute.",
  RESOURCE_NOT_FOUND: "The referenced resource does not exist.",
  AGENT_FROZEN: "This agent is frozen. All privileged execution is disabled.",
  AGENT_TOOL_NOT_ALLOWED: "This tool is not on the agent's allowlist.",
  EMERGENCY_LOCKDOWN: "An administrator has disabled this class of operation.",
  SELF_APPROVAL_FORBIDDEN: "You cannot approve a request you raised.",
  TIME_WINDOW_VIOLATION: "This action is outside its permitted time window.",
  EVIDENCE_MISSING: "Required supporting evidence was not provided.",
};
