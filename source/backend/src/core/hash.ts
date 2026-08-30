import { createHash, randomBytes, timingSafeEqual, createHmac } from "node:crypto";

/**
 * Canonical JSON: recursively sorts object keys so the same logical value always
 * hashes identically regardless of key insertion order. Every commitment, audit
 * event hash and policy hash in the system flows through this, which is what makes
 * a proof independently recomputable by a third party.
 *
 * Carried forward from the baseline repo (backend/src/utils/hash.ts) unchanged in
 * behaviour — it was correct and the on-chain proof format depends on it.
 */
export function canonicalStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Deterministic hash of any JSON-serialisable value, prefixed for display. */
export function hashObject(value: unknown): string {
  return `sha256:${sha256Hex(canonicalStringify(value))}`;
}

export function randomHex(bytes = 32): string {
  return randomBytes(bytes).toString("hex");
}

/** Constant-time compare — used for session tokens and agent bearer tokens. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function hmacSha256Hex(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

/**
 * Policy commitment. Version is part of the hash on purpose: two policies with
 * identical conditions but different versions must not collide, otherwise an
 * authorization recorded under v1 would appear to verify against v2.
 */
export function computePolicyHash(policy: { id: string; version: number; conditions: unknown }): string {
  return hashObject({ id: policy.id, version: policy.version, conditions: policy.conditions });
}

/** Recomputable decision commitment for a single authorization outcome. */
export function computeDecisionHash(input: {
  traceId: string;
  actorDid: string;
  action: string;
  resourceType: string;
  resourceId: string;
  decision: string;
  reasonCodes: string[];
  policyVersion: number | null;
}): string {
  return hashObject({ ...input, reasonCodes: [...input.reasonCodes].sort() });
}
