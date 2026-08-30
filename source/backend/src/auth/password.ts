import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * scrypt password hashing for the development-only password login path. Node ships
 * scrypt in core, so this adds no dependency; the parameters are the Node defaults
 * with an explicit cost so they are visible rather than implied.
 *
 * The primary authentication path in this product is DID challenge/signature. This
 * exists so a reviewer can sign in without generating a keypair first, and it is
 * refused outright when NODE_ENV=production (see config/env.ts).
 */
const KEYLEN = 64;
const COST = 16384;

export function hashPassword(password: string): { hash: string; salt: string } {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, KEYLEN, { N: COST }).toString("hex");
  return { hash, salt };
}

export function verifyPassword(password: string, hash: string, salt: string): boolean {
  try {
    const derived = scryptSync(password, salt, KEYLEN, { N: COST });
    const stored = Buffer.from(hash, "hex");
    if (derived.length !== stored.length) return false;
    return timingSafeEqual(derived, stored);
  } catch {
    return false;
  }
}
