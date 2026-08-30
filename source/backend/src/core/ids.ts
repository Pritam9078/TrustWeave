import { randomBytes, randomUUID } from "node:crypto";

/**
 * Prefixed identifiers. The prefix is not decorative: it makes a mis-wired foreign
 * key obvious at a glance in logs and audit trails — an `asset_...` where an
 * `agent_...` was expected fails loudly instead of silently resolving to nothing.
 */
const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

function base36(bytes: number): string {
  const buf = randomBytes(bytes);
  let out = "";
  for (const b of buf) out += ALPHABET[b % 36];
  return out;
}

export type IdPrefix =
  | "org" | "dept" | "idn" | "mem" | "role" | "cap" | "scope" | "pol"
  | "asset" | "aevt" | "agent" | "pi" | "apr" | "aud" | "prf" | "doc"
  | "chunk" | "sess" | "chal" | "tool" | "sec" | "exec";

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${Date.now().toString(36)}${base36(8)}`;
}

export function newTraceId(): string {
  return `trace_${randomUUID()}`;
}
