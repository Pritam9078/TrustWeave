import { z } from "zod";

/**
 * The tool registry. Every callable surface an AI agent can reach is declared here with
 * a strict argument schema and the capability it requires.
 *
 * Two properties this gives us:
 *  1. The allowlist is *closed*. A tool name not in this map cannot be invoked at all,
 *     so a model hallucinating `delete_all_assets` reaches nothing.
 *  2. Arguments are schema-validated before authorization runs, so a malformed or
 *     over-specified argument object is rejected as data rather than reaching a service.
 */

export interface ToolDef {
  name: string;
  description: string;
  capability: string;
  resourceType: string;
  mutating: boolean;
  schema: z.ZodTypeAny;
}

export const TOOLS: Record<string, ToolDef> = {
  get_policy: {
    name: "get_policy",
    description: "Read an organization policy the agent is permitted to see.",
    capability: "POLICY_READ",
    resourceType: "POLICY",
    mutating: false,
    schema: z.object({ policyId: z.string().min(1).max(120) }).strict(),
  },
  get_invoice: {
    name: "get_invoice",
    description: "Look up an invoice reference in the knowledge base.",
    capability: "KNOWLEDGE_READ",
    resourceType: "DOCUMENT",
    mutating: false,
    schema: z.object({ invoiceRef: z.string().min(1).max(120) }).strict(),
  },
  get_asset: {
    name: "get_asset",
    description: "Read an asset record.",
    capability: "ASSET_READ",
    resourceType: "ASSET",
    mutating: false,
    schema: z.object({ assetId: z.string().min(1).max(120) }).strict(),
  },
  search_knowledge: {
    name: "search_knowledge",
    description: "Scope-filtered retrieval over the organizational knowledge base.",
    capability: "KNOWLEDGE_READ",
    resourceType: "DOCUMENT",
    mutating: false,
    schema: z.object({ query: z.string().min(1).max(2000), limit: z.number().int().min(1).max(10).optional() }).strict(),
  },
  create_payment_intent: {
    name: "create_payment_intent",
    description: "Propose a payment. Subject to full authorization, policy and approval.",
    capability: "PAYMENT_CREATE",
    resourceType: "PAYMENT",
    mutating: true,
    schema: z.object({
      merchant: z.string().min(1).max(200),
      amount: z.number().positive().finite().max(1_000_000_000),
      currency: z.string().length(3).default("INR"),
      invoiceRef: z.string().max(120).optional().nullable(),
      purpose: z.string().max(500).default(""),
      evidenceIds: z.array(z.string().max(120)).max(20).default([]),
    }).strict(),
  },
  request_asset_transfer: {
    name: "request_asset_transfer",
    description: "Propose an asset ownership transfer. Subject to full authorization.",
    capability: "ASSET_TRANSFER",
    resourceType: "ASSET",
    mutating: true,
    schema: z.object({
      assetId: z.string().min(1).max(120),
      newOwnerDid: z.string().min(10).max(200),
      reason: z.string().max(500).default(""),
    }).strict(),
  },
};

export const ALLOWED_TOOLS = Object.keys(TOOLS);

export function getTool(name: string): ToolDef | null {
  return Object.prototype.hasOwnProperty.call(TOOLS, name) ? TOOLS[name] : null;
}

export function toolCatalog() {
  return Object.values(TOOLS).map((t) => ({
    name: t.name, description: t.description, capability: t.capability,
    resourceType: t.resourceType, mutating: t.mutating,
  }));
}
