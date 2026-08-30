import { z } from "zod";

/** Request body schemas. Every mutating route validates against one of these before
 *  any service is reached; `.strict()` rejects unexpected keys rather than ignoring
 *  them, so a client cannot smuggle an extra field past a partial validator. */

export const didLoginStart = z.object({ did: z.string().min(10).max(200) }).strict();

export const didLoginVerify = z.object({
  challengeId: z.string().min(1),
  did: z.string().min(10).max(200),
  signature: z.string().min(1).max(500),
}).strict();

export const passwordLogin = z.object({
  email: z.string().email().max(200),
  password: z.string().min(1).max(200),
}).strict();

export const createIdentity = z.object({
  displayName: z.string().min(1).max(150),
  email: z.string().email().max(200).optional().nullable(),
  kind: z.enum(["HUMAN", "SERVICE"]).default("HUMAN"),
  did: z.string().max(200).optional(),
  departmentId: z.string().max(120).optional().nullable(),
  password: z.string().min(8).max(200).optional(),
  roleIds: z.array(z.string().max(120)).max(20).default([]),
  scopeIds: z.array(z.string().max(120)).max(50).default([]),
}).strict();

export const identityStatus = z.object({
  status: z.enum(["ACTIVE", "SUSPENDED", "REVOKED"]),
  reason: z.string().max(500).default(""),
}).strict();

export const createRole = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(500).default(""),
  capabilities: z.array(z.string().max(80)).max(100).default([]),
}).strict();

export const updateRole = z.object({
  name: z.string().min(1).max(80).optional(),
  description: z.string().max(500).optional(),
  capabilities: z.array(z.string().max(80)).max(100).optional(),
}).strict();

export const createScope = z.object({
  name: z.string().min(1).max(80),
  scopeType: z.enum(["ORGANIZATION", "DEPARTMENT", "COLLECTION", "RESOURCE", "VENDOR"]),
  selector: z.record(z.any()).default({}),
  constraints: z.record(z.any()).default({}),
}).strict();

export const createPolicy = z.object({
  policyKey: z.string().min(1).max(80).regex(/^[a-z0-9_-]+$/i, "policyKey must be alphanumeric with - or _"),
  name: z.string().min(1).max(120),
  description: z.string().max(500).default(""),
  conditions: z.object({ rules: z.array(z.record(z.any())).max(50) }),
  appliesTo: z.record(z.any()).default({}),
  activate: z.boolean().default(false),
}).strict();

export const newPolicyVersion = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(500).optional(),
  conditions: z.object({ rules: z.array(z.record(z.any())).max(50) }),
  appliesTo: z.record(z.any()).optional(),
  activate: z.boolean().default(false),
}).strict();

export const createAsset = z.object({
  name: z.string().min(1).max(150),
  assetType: z.string().min(1).max(80),
  departmentId: z.string().max(120).optional().nullable(),
  collectionId: z.string().max(120).optional().nullable(),
  ownerDid: z.string().max(200).optional().nullable(),
  metadata: z.record(z.any()).default({}),
}).strict();

export const assetOwner = z.object({ ownerDid: z.string().min(10).max(200) }).strict();
export const assetTransfer = z.object({ newOwnerDid: z.string().min(10).max(200), reason: z.string().max(500).default("") }).strict();
export const assetFreeze = z.object({ frozen: z.boolean(), reason: z.string().max(500).default("") }).strict();
export const assetRevoke = z.object({ reason: z.string().max(500).default("") }).strict();

export const registerAgent = z.object({
  name: z.string().min(1).max(120),
  ownerIdentityId: z.string().max(120).optional().nullable(),
  departmentId: z.string().max(120).optional().nullable(),
  capabilities: z.array(z.string().max(80)).max(50).default([]),
  scopeIds: z.array(z.string().max(120)).max(50).default([]),
  tools: z.array(z.string().max(80)).max(50).default([]),
  limits: z.object({
    transactionLimit: z.number().positive().optional(),
    approvalThreshold: z.number().positive().optional(),
    dailyLimit: z.number().positive().optional(),
    velocityCountPerDay: z.number().int().positive().optional(),
  }).default({}),
}).strict();

export const configureAgent = z.object({
  capabilities: z.array(z.string().max(80)).max(50).optional(),
  scopeIds: z.array(z.string().max(120)).max(50).optional(),
  tools: z.array(z.string().max(80)).max(50).optional(),
  departmentId: z.string().max(120).optional().nullable(),
  limits: z.object({
    transactionLimit: z.number().positive().optional(),
    approvalThreshold: z.number().positive().optional(),
    dailyLimit: z.number().positive().optional(),
    velocityCountPerDay: z.number().int().positive().optional(),
  }).optional(),
}).strict();

export const agentStatus = z.object({
  status: z.enum(["ACTIVE", "FROZEN", "REVOKED"]),
  reason: z.string().max(500).default(""),
}).strict();

export const createPaymentIntent = z.object({
  merchant: z.string().min(1).max(200),
  amount: z.number().positive().finite().max(1_000_000_000),
  currency: z.string().length(3).default("INR"),
  purpose: z.string().max(500).default(""),
  invoiceRef: z.string().max(120).optional().nullable(),
  departmentId: z.string().max(120).optional().nullable(),
  evidence: z.array(z.string().max(120)).max(20).default([]),
  rawRequest: z.string().max(5000).optional().nullable(),
  idempotencyKey: z.string().max(200).optional().nullable(),
}).strict();

export const approvalDecision = z.object({
  decision: z.enum(["APPROVED", "REJECTED"]),
  note: z.string().max(1000).default(""),
}).strict();

export const simulate = z.object({
  identityId: z.string().max(120).optional(),
  agentId: z.string().max(120).optional(),
  action: z.string().min(1).max(80),
  resource: z.object({
    type: z.string().min(1).max(60),
    id: z.string().max(120).optional().nullable(),
    departmentId: z.string().max(120).optional().nullable(),
    collectionId: z.string().max(120).optional().nullable(),
    ownerDid: z.string().max(200).optional().nullable(),
    vendor: z.string().max(200).optional().nullable(),
  }),
  context: z.object({
    amount: z.number().optional(),
    currency: z.string().max(3).optional(),
    merchant: z.string().max(200).optional(),
    evidenceCount: z.number().int().optional(),
  }).default({}),
}).strict();

export const toolInvoke = z.object({
  tool: z.string().min(1).max(80),
  args: z.record(z.any()).default({}),
}).strict();

export const agentTask = z.object({
  instruction: z.string().min(1).max(5000),
  execute: z.boolean().default(false),
}).strict();

export const ingestDocument = z.object({
  sourceType: z.string().min(1).max(60),
  title: z.string().min(1).max(200),
  content: z.string().min(1).max(200_000),
  departmentId: z.string().max(120).optional().nullable(),
  classification: z.enum(["PUBLIC", "INTERNAL", "RESTRICTED"]).default("INTERNAL"),
  scope: z.record(z.any()).default({}),
  requiredCapability: z.string().max(80).optional().nullable(),
  // Links this document to the policy it restates, enabling staleness detection.
  sourcePolicyKey: z.string().max(80).optional().nullable(),
}).strict();

export const emergencyFlag = z.object({
  flagKey: z.enum(["AGENTS_DISABLED", "PAYMENTS_DISABLED", "MINTING_DISABLED"]),
  enabled: z.boolean(),
  reason: z.string().max(500).default(""),
}).strict();

export const createDepartment = z.object({
  name: z.string().min(1).max(120),
  code: z.string().min(1).max(30).regex(/^[A-Z0-9_-]+$/i),
}).strict();

export const createCollection = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).default(""),
}).strict();
