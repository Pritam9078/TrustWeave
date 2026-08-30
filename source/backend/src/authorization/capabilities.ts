/**
 * The capability catalog — the complete vocabulary of privileged actions the
 * authorization engine understands (PRD §6.2).
 *
 * This lives in code, not in an admin-editable table, and that is a deliberate
 * security property: if capabilities were user-creatable, an Admin could invent
 * `PAYMENT_EXECUTE_UNCHECKED`, attach it to a role, and the engine would have no
 * opinion about it. Roles are composed by organizations; the vocabulary itself is
 * fixed by the system. The `capabilities` table is a seeded projection of this list
 * so joins work, never a source of truth.
 */

export type CapabilityDomain =
  | "IDENTITY" | "ACCESS" | "ASSETS" | "AGENTS" | "PAYMENTS" | "POLICY" | "AUDIT" | "ORG";

export interface CapabilityDef {
  action: string;
  resourceType: string;
  domain: CapabilityDomain;
  description: string;
  /** Read-only capabilities are still authorized, but are not treated as privileged
   *  mutations for the purposes of approval routing and emergency freezes. */
  isPrivileged: boolean;
}

export const CAPABILITIES: CapabilityDef[] = [
  // Identity
  { action: "IDENTITY_READ", resourceType: "IDENTITY", domain: "IDENTITY", description: "View identities and DIDs", isPrivileged: false },
  { action: "IDENTITY_CREATE", resourceType: "IDENTITY", domain: "IDENTITY", description: "Create organizational identities", isPrivileged: true },
  { action: "IDENTITY_UPDATE", resourceType: "IDENTITY", domain: "IDENTITY", description: "Update identity attributes", isPrivileged: true },
  { action: "IDENTITY_SUSPEND", resourceType: "IDENTITY", domain: "IDENTITY", description: "Suspend an identity", isPrivileged: true },
  { action: "IDENTITY_REVOKE", resourceType: "IDENTITY", domain: "IDENTITY", description: "Permanently revoke an identity", isPrivileged: true },

  // Access control
  { action: "ROLE_READ", resourceType: "ROLE", domain: "ACCESS", description: "View roles", isPrivileged: false },
  { action: "ROLE_CREATE", resourceType: "ROLE", domain: "ACCESS", description: "Create roles", isPrivileged: true },
  { action: "ROLE_UPDATE", resourceType: "ROLE", domain: "ACCESS", description: "Edit roles", isPrivileged: true },
  { action: "ROLE_ASSIGN", resourceType: "MEMBERSHIP", domain: "ACCESS", description: "Assign roles to members", isPrivileged: true },
  { action: "CAPABILITY_READ", resourceType: "CAPABILITY", domain: "ACCESS", description: "View the capability catalog", isPrivileged: false },
  { action: "CAPABILITY_ASSIGN", resourceType: "ROLE", domain: "ACCESS", description: "Attach capabilities to roles", isPrivileged: true },
  { action: "SCOPE_READ", resourceType: "SCOPE", domain: "ACCESS", description: "View resource scopes", isPrivileged: false },
  { action: "SCOPE_CREATE", resourceType: "SCOPE", domain: "ACCESS", description: "Create resource scopes", isPrivileged: true },
  { action: "SCOPE_ASSIGN", resourceType: "SCOPE", domain: "ACCESS", description: "Attach scopes to roles or members", isPrivileged: true },
  { action: "PERMISSION_SIMULATE", resourceType: "PERMISSION", domain: "ACCESS", description: "Run the permission simulator", isPrivileged: false },

  // Assets
  { action: "ASSET_READ", resourceType: "ASSET", domain: "ASSETS", description: "View assets", isPrivileged: false },
  { action: "ASSET_CREATE", resourceType: "ASSET", domain: "ASSETS", description: "Create asset records", isPrivileged: true },
  { action: "ASSET_MINT", resourceType: "ASSET", domain: "ASSETS", description: "Mint an NFT for an asset", isPrivileged: true },
  { action: "ASSET_ASSIGN", resourceType: "ASSET", domain: "ASSETS", description: "Assign an asset to an owner DID", isPrivileged: true },
  { action: "ASSET_TRANSFER", resourceType: "ASSET", domain: "ASSETS", description: "Transfer asset ownership", isPrivileged: true },
  { action: "ASSET_FREEZE", resourceType: "ASSET", domain: "ASSETS", description: "Freeze/unfreeze an asset", isPrivileged: true },
  { action: "ASSET_REVOKE", resourceType: "ASSET", domain: "ASSETS", description: "Revoke an asset", isPrivileged: true },

  // Agents
  { action: "AGENT_READ", resourceType: "AGENT", domain: "AGENTS", description: "View AI agents", isPrivileged: false },
  { action: "AGENT_REGISTER", resourceType: "AGENT", domain: "AGENTS", description: "Register an AI agent identity", isPrivileged: true },
  { action: "AGENT_CONFIGURE", resourceType: "AGENT", domain: "AGENTS", description: "Configure agent capabilities, scopes and limits", isPrivileged: true },
  { action: "AGENT_FREEZE", resourceType: "AGENT", domain: "AGENTS", description: "Freeze or unfreeze an agent", isPrivileged: true },
  { action: "AGENT_INVOKE", resourceType: "AGENT", domain: "AGENTS", description: "Send a task to an agent", isPrivileged: false },

  // Payments
  { action: "PAYMENT_READ", resourceType: "PAYMENT", domain: "PAYMENTS", description: "View payment intents", isPrivileged: false },
  { action: "PAYMENT_CREATE", resourceType: "PAYMENT", domain: "PAYMENTS", description: "Create a payment intent", isPrivileged: true },
  { action: "PAYMENT_APPROVE", resourceType: "PAYMENT", domain: "PAYMENTS", description: "Approve a held payment", isPrivileged: true },
  { action: "PAYMENT_EXECUTE", resourceType: "PAYMENT", domain: "PAYMENTS", description: "Execute an authorized payment", isPrivileged: true },
  { action: "REFUND_CREATE", resourceType: "PAYMENT", domain: "PAYMENTS", description: "Issue a refund", isPrivileged: true },

  // Policy
  { action: "POLICY_READ", resourceType: "POLICY", domain: "POLICY", description: "View policies", isPrivileged: false },
  { action: "POLICY_CREATE", resourceType: "POLICY", domain: "POLICY", description: "Create a policy version", isPrivileged: true },
  { action: "POLICY_UPDATE", resourceType: "POLICY", domain: "POLICY", description: "Create a new version of a policy", isPrivileged: true },
  { action: "POLICY_ACTIVATE", resourceType: "POLICY", domain: "POLICY", description: "Activate a policy version", isPrivileged: true },
  { action: "POLICY_DISABLE", resourceType: "POLICY", domain: "POLICY", description: "Disable a policy", isPrivileged: true },

  // Audit and proof
  { action: "AUDIT_READ", resourceType: "AUDIT", domain: "AUDIT", description: "Read the audit timeline", isPrivileged: false },
  { action: "PROOF_VERIFY", resourceType: "PROOF", domain: "AUDIT", description: "Verify blockchain proofs", isPrivileged: false },
  { action: "REPORT_EXPORT", resourceType: "AUDIT", domain: "AUDIT", description: "Export audit reports", isPrivileged: false },

  // Knowledge and organization
  { action: "KNOWLEDGE_READ", resourceType: "DOCUMENT", domain: "ORG", description: "Query the knowledge base", isPrivileged: false },
  { action: "KNOWLEDGE_MANAGE", resourceType: "DOCUMENT", domain: "ORG", description: "Ingest and manage knowledge sources", isPrivileged: true },
  { action: "ORG_READ", resourceType: "ORGANIZATION", domain: "ORG", description: "View organization settings", isPrivileged: false },
  { action: "ORG_MANAGE", resourceType: "ORGANIZATION", domain: "ORG", description: "Manage departments and settings", isPrivileged: true },
  { action: "SECURITY_READ", resourceType: "SECURITY", domain: "ORG", description: "View security events", isPrivileged: false },
  { action: "INTEGRATION_READ", resourceType: "INTEGRATION", domain: "ORG", description: "View integration and adapter status", isPrivileged: false },
  { action: "EMERGENCY_CONTROL", resourceType: "ORGANIZATION", domain: "ORG", description: "Operate emergency kill switches", isPrivileged: true },
];

export const CAPABILITY_ACTIONS = CAPABILITIES.map((c) => c.action);
const byAction = new Map(CAPABILITIES.map((c) => [c.action, c]));

export function getCapability(action: string): CapabilityDef | undefined {
  return byAction.get(action);
}

export function isKnownCapability(action: string): boolean {
  return byAction.has(action);
}

/** Deterministic id so seeds are idempotent across runs and machines. */
export function capabilityId(action: string): string {
  return `cap_${action.toLowerCase()}`;
}

/**
 * Default role templates. These are seeded per organization; an org can then edit
 * them freely. Auditor deliberately holds zero privileged capabilities — the spec
 * requires that "Auditor cannot execute privileged mutations" be structurally true,
 * not merely conventional.
 */
export const ROLE_TEMPLATES: Record<string, { description: string; capabilities: string[] }> = {
  Admin: {
    description: "Full organization-wide governance.",
    capabilities: CAPABILITY_ACTIONS,
  },
  Manager: {
    description: "Department-scoped operational management.",
    capabilities: [
      "IDENTITY_READ", "ROLE_READ", "CAPABILITY_READ", "SCOPE_READ", "PERMISSION_SIMULATE",
      "ASSET_READ", "ASSET_CREATE", "ASSET_ASSIGN", "ASSET_TRANSFER",
      "AGENT_READ", "AGENT_INVOKE", "AGENT_FREEZE",
      "PAYMENT_READ", "PAYMENT_CREATE", "PAYMENT_APPROVE", "PAYMENT_EXECUTE",
      "POLICY_READ", "AUDIT_READ", "PROOF_VERIFY", "KNOWLEDGE_READ", "ORG_READ",
    ],
  },
  Auditor: {
    description: "Independent read and verify. No mutation capabilities by design.",
    capabilities: [
      "IDENTITY_READ", "ROLE_READ", "CAPABILITY_READ", "SCOPE_READ",
      "ASSET_READ", "AGENT_READ", "PAYMENT_READ", "POLICY_READ",
      "AUDIT_READ", "PROOF_VERIFY", "REPORT_EXPORT", "SECURITY_READ", "INTEGRATION_READ", "ORG_READ",
    ],
  },
  User: {
    description: "Normal organizational member — own and assigned resources only.",
    capabilities: ["IDENTITY_READ", "ASSET_READ", "PAYMENT_READ", "AUDIT_READ", "KNOWLEDGE_READ", "AGENT_INVOKE"],
  },
};
