import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";
import { createHash, randomBytes } from "node:crypto";

// @noble/ed25519 v2 needs a sha512 implementation wired in for the sync API.
(ed as any).etc.sha512Sync = (...m: Uint8Array[]) => sha512((ed as any).etc.concatBytes(...m));

/**
 * did:key over Ed25519 (multicodec 0xed01), which is the interoperable form of
 * "a DID that is nothing but a public key". No registry lookup and no network call
 * is needed to resolve one — the key material *is* the identifier — which is what
 * makes challenge/response authentication verifiable offline.
 *
 * We deliberately do not invent a custom DID method. A reviewer can paste one of
 * these into any did:key resolver and get the same public key back.
 */

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Encode(bytes: Uint8Array): string {
  if (bytes.length === 0) return "";
  const digits: number[] = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let out = "";
  for (const b of bytes) { if (b === 0) out += "1"; else break; }
  for (let i = digits.length - 1; i >= 0; i--) out += BASE58[digits[i]];
  return out;
}

function base58Decode(str: string): Uint8Array {
  const bytes: number[] = [0];
  for (const ch of str) {
    const value = BASE58.indexOf(ch);
    if (value === -1) throw new Error(`Invalid base58 character: ${ch}`);
    let carry = value;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  for (const ch of str) { if (ch === "1") bytes.push(0); else break; }
  return new Uint8Array(bytes.reverse());
}

const MULTICODEC_ED25519_PUB = new Uint8Array([0xed, 0x01]);

export function publicKeyToDid(publicKey: Uint8Array): string {
  const prefixed = new Uint8Array(MULTICODEC_ED25519_PUB.length + publicKey.length);
  prefixed.set(MULTICODEC_ED25519_PUB, 0);
  prefixed.set(publicKey, MULTICODEC_ED25519_PUB.length);
  return `did:key:z${base58Encode(prefixed)}`;
}

export function didToPublicKey(did: string): Uint8Array {
  const m = /^did:key:z([1-9A-HJ-NP-Za-km-z]+)$/.exec(did.trim());
  if (!m) throw new Error("Malformed did:key identifier.");
  const decoded = base58Decode(m[1]);
  if (decoded[0] !== 0xed || decoded[1] !== 0x01) throw new Error("DID is not an Ed25519 did:key.");
  return decoded.slice(2);
}

export function isValidDid(did: string): boolean {
  try { didToPublicKey(did); return true; } catch { return false; }
}

export interface Keypair { did: string; publicKeyB64: string; privateKeyB64: string; }

export function generateKeypair(): Keypair {
  const priv = ed.utils.randomPrivateKey();
  const pub = ed.getPublicKey(priv);
  return {
    did: publicKeyToDid(pub),
    publicKeyB64: Buffer.from(pub).toString("base64url"),
    privateKeyB64: Buffer.from(priv).toString("base64url"),
  };
}

/**
 * Canonical challenge string. Both sides build it the same way, and it binds the
 * signature to a specific DID *and* a specific nonce — so a signature harvested
 * from one login attempt cannot be replayed against another.
 */
export function challengeMessage(did: string, nonce: string): string {
  return `TrustWeave Authentication\nDID: ${did}\nNonce: ${nonce}`;
}

export function signChallenge(privateKeyB64: string, did: string, nonce: string): string {
  const priv = Buffer.from(privateKeyB64, "base64url");
  const msg = new TextEncoder().encode(challengeMessage(did, nonce));
  return Buffer.from(ed.sign(msg, priv)).toString("base64url");
}

export function verifyChallenge(did: string, nonce: string, signatureB64: string): boolean {
  try {
    const pub = didToPublicKey(did);
    const msg = new TextEncoder().encode(challengeMessage(did, nonce));
    const sig = Buffer.from(signatureB64, "base64url");
    return ed.verify(sig, msg, pub);
  } catch {
    return false;
  }
}

export function newNonce(): string {
  return randomBytes(24).toString("base64url");
}

/** bytes32 commitment of a DID, for on-chain identity anchoring (no PII on chain). */
export function didCommitment(did: string): string {
  return "0x" + createHash("sha256").update(did).digest("hex");
}
