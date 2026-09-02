import { one, many, run, tx, j } from "../db/client.js";
import { newId } from "../core/ids.js";
import { nowIso, plusMinutes, isExpired } from "../core/time.js";
import { sha256Hex, randomHex, safeEqual } from "../core/hash.js";
import { generateKeypair, isValidDid, verifyChallenge, newNonce, challengeMessage } from "../auth/did.js";
import { hashPassword, verifyPassword } from "../auth/password.js";
import { env } from "../config/env.js";
import { badRequest, conflict, notFound, unauthorized, forbidden } from "../core/errors.js";
import type { ActorContext } from "../authorization/types.js";
import type { AgentLimits } from "../authorization/types.js";

/**
 * Identity, session and actor resolution.
 *
 * The single most important function here is `resolveActor`. It is the only place an
 * `ActorContext` is ever constructed, and it builds one exclusively from server-side
 * state reached through the session token. No field of it can be influenced by a
 * request body or header, which is what makes "never trust a client role claim"
 * structurally true rather than a convention every route has to remember.
 */

/* ------------------------------------------------------------------ identities */

export interface CreateIdentityInput {
  organizationId: string;
  displayName: string;
  email?: string | null;
  kind?: "HUMAN" | "AGENT" | "SERVICE";
  did?: string;
  publicKey?: string | null;
  departmentId?: string | null;
  status?: string;
  password?: string;
}

export async function createIdentity(input: CreateIdentityInput) {
  let did = input.did;
  let publicKey = input.publicKey ?? null;
  let generated: { privateKeyB64: string } | null = null;

  if (did) {
    if (!isValidDid(did)) throw badRequest("INVALID_DID", "The supplied DID is not a valid Ed25519 did:key.");
  } else {
    // Generating server-side is a convenience for the demo/admin flow. The private key
    // is returned exactly once in the create response and never persisted — there is no
    // column for it, so it cannot leak later from the database.
    const kp = generateKeypair();
    did = kp.did;
    publicKey = kp.publicKeyB64;
    generated = { privateKeyB64: kp.privateKeyB64 };
  }

  if (await one(`SELECT id FROM identities WHERE did = ?`, did)) {
    throw conflict("DID_EXISTS", "An identity with this DID already exists.");
  }

  const id = newId("idn");
  const ts = nowIso();

  await tx(async () => {
    await run(
      `INSERT INTO identities (id, organization_id, did, public_key, kind, display_name, email, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      id, input.organizationId, did, publicKey, input.kind ?? "HUMAN",
      input.displayName, input.email ?? null, input.status ?? "ACTIVE", ts, ts,
    );
    await run(
      `INSERT INTO memberships (id, identity_id, organization_id, department_id, status, created_at)
       VALUES (?,?,?,?,?,?)`,
      newId("mem"), id, input.organizationId, input.departmentId ?? null, "ACTIVE", ts,
    );
    if (input.password) {
      const { hash, salt } = hashPassword(input.password);
      await run(
        `INSERT INTO credentials (identity_id, password_hash, salt, algo, updated_at) VALUES (?,?,?,?,?)`,
        id, hash, salt, "scrypt", ts,
      );
    }
  });

  return { identity: await getIdentity(input.organizationId, id)!, privateKey: generated?.privateKeyB64 ?? null };
}

export async function getIdentity(organizationId: string, id: string) {
  return await one<any>(`SELECT * FROM identities WHERE organization_id = ? AND id = ?`, organizationId, id);
}

export async function getIdentityByDid(did: string) {
  return await one<any>(`SELECT * FROM identities WHERE did = ?`, did);
}

export async function listIdentities(organizationId: string, opts: { q?: string; status?: string; kind?: string } = {}) {
  const where = ["organization_id = ?"];
  const params: unknown[] = [organizationId];
  if (opts.status) { where.push("status = ?"); params.push(opts.status); }
  if (opts.kind) { where.push("kind = ?"); params.push(opts.kind); }
  if (opts.q) { where.push("(display_name LIKE ? OR email LIKE ? OR did LIKE ?)"); params.push(`%${opts.q}%`, `%${opts.q}%`, `%${opts.q}%`); }
  return await many<any>(`SELECT * FROM identities WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT 500`, ...params);
}

/**
 * Status changes revoke live sessions immediately. Without this, suspending someone
 * would only take effect when their current session happened to expire — the SRD calls
 * this out explicitly, and it is the difference between a real suspend and a cosmetic one.
 */
export async function setIdentityStatus(organizationId: string, id: string, status: string) {
  const identity = await getIdentity(organizationId, id);
  if (!identity) throw notFound("Identity not found.");
  const ts = nowIso();
  await tx(async () => {
    await run(
      `UPDATE identities SET status = ?, updated_at = ?, revoked_at = ? WHERE id = ?`,
      status, ts, status === "REVOKED" ? ts : identity.revoked_at, id,
    );
    if (status !== "ACTIVE") {
      await run(`UPDATE sessions SET revoked_at = ? WHERE identity_id = ? AND revoked_at IS NULL`, ts, id);
    }
  });
  return await getIdentity(organizationId, id)!;
}

/* ---------------------------------------------------------------- memberships */

export async function getMembership(identityId: string, organizationId: string) {
  return await one<any>(`SELECT * FROM memberships WHERE identity_id = ? AND organization_id = ?`, identityId, organizationId);
}

export async function setMembershipDepartment(membershipId: string, departmentId: string | null) {
  await run(`UPDATE memberships SET department_id = ? WHERE id = ?`, departmentId, membershipId);
}

export async function assignRole(membershipId: string, roleId: string, assignedBy: string) {
  await run(
    `INSERT INTO membership_roles (membership_id, role_id, assigned_by, assigned_at) VALUES (?,?,?,?) ON CONFLICT DO NOTHING`,
    membershipId, roleId, assignedBy, nowIso(),
  );
}

export async function removeRole(membershipId: string, roleId: string) {
  await run(`DELETE FROM membership_roles WHERE membership_id = ? AND role_id = ?`, membershipId, roleId);
}

export async function assignScopeToMembership(membershipId: string, scopeId: string) {
  await run(`INSERT INTO membership_scopes (membership_id, scope_id) VALUES (?,?) ON CONFLICT DO NOTHING`, membershipId, scopeId);
}

export async function removeScopeFromMembership(membershipId: string, scopeId: string) {
  await run(`DELETE FROM membership_scopes WHERE membership_id = ? AND scope_id = ?`, membershipId, scopeId);
}

/* ------------------------------------------------- effective permission resolution */

export interface EffectivePermissions {
  identityId: string;
  did: string;
  organizationId: string;
  departmentId: string | null;
  identityStatus: string;
  membershipStatus: string;
  roles: { id: string; name: string }[];
  capabilities: string[];
  scopes: { id: string; name: string; scopeType: string }[];
}

/**
 * Resolve everything an identity can do, right now, from the database.
 *
 * Capabilities come only from roles; scopes come from roles *and* from the membership
 * directly (union). The union is what lets two people share a "Manager" role while being
 * confined to different departments, without minting a role per department.
 */
export async function effectivePermissions(identityId: string, organizationId: string): Promise<EffectivePermissions | null> {
  const identity = await one<any>(`SELECT * FROM identities WHERE id = ? AND organization_id = ?`, identityId, organizationId);
  if (!identity) return null;
  const membership = await getMembership(identityId, organizationId);
  if (!membership) return null;

  const roles = await many<{ id: string; name: string }>(
    `SELECT r.id, r.name FROM roles r
     JOIN membership_roles mr ON mr.role_id = r.id
     WHERE mr.membership_id = ?`,
    membership.id,
  );

  const capabilities = roles.length
    ? (await many<{ action: string }>(
        `SELECT DISTINCT c.action FROM capabilities c
         JOIN role_capabilities rc ON rc.capability_id = c.id
         JOIN membership_roles mr ON mr.role_id = rc.role_id
         WHERE mr.membership_id = ?`,
        membership.id,
      )).map((r) => r.action)
    : [];

  const scopes = await many<{ id: string; name: string; scope_type: string }>(
    `SELECT DISTINCT s.id, s.name, s.scope_type FROM scopes s
     WHERE s.id IN (
       SELECT scope_id FROM role_scopes WHERE role_id IN (SELECT role_id FROM membership_roles WHERE membership_id = ?)
       UNION
       SELECT scope_id FROM membership_scopes WHERE membership_id = ?
     )`,
    membership.id, membership.id,
  );

  return {
    identityId, did: identity.did, organizationId,
    departmentId: membership.department_id ?? null,
    identityStatus: identity.status,
    membershipStatus: membership.status,
    roles,
    capabilities: capabilities.sort(),
    scopes: scopes.map((s) => ({ id: s.id, name: s.name, scopeType: s.scope_type })),
  };
}

/* -------------------------------------------------------------------- sessions */

export interface SessionIssue { token: string; sessionId: string; expiresAt: string; }

export async function issueSession(identityId: string, organizationId: string, meta: { ip?: string | null; userAgent?: string | null } = {}): Promise<SessionIssue> {
  const token = randomHex(32);
  const id = newId("sess");
  const issuedAt = nowIso();
  const expiresAt = plusMinutes(env.SESSION_TTL_MINUTES);
  const snapshot = await effectivePermissions(identityId, organizationId);

  await run(
    `INSERT INTO sessions (id, identity_id, organization_id, token_hash, snapshot_json, issued_at, expires_at, user_agent, ip)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    id, identityId, organizationId, sha256Hex(token), j.enc(snapshot),
    issuedAt, expiresAt, meta.userAgent ?? null, meta.ip ?? null,
  );
  return { token, sessionId: id, expiresAt };
}

export async function revokeSession(sessionId: string) {
  await run(`UPDATE sessions SET revoked_at = ? WHERE id = ?`, nowIso(), sessionId);
}

export async function revokeAllSessionsFor(identityId: string) {
  await run(`UPDATE sessions SET revoked_at = ? WHERE identity_id = ? AND revoked_at IS NULL`, nowIso(), identityId);
}

/**
 * Resolve a bearer token to a live actor.
 *
 * The stored `snapshot_json` is *not* used for authorization — permissions are
 * re-resolved from the database on every request. The snapshot exists only so the UI
 * can show what changed since sign-in. Trusting a cached snapshot would mean a role
 * revoked five minutes ago still worked until the session expired.
 */
export async function resolveActorFromToken(token: string): Promise<ActorContext | null> {
  const tokenHash = sha256Hex(token);
  const session = await one<any>(`SELECT * FROM sessions WHERE token_hash = ?`, tokenHash);
  if (!session) return null;
  if (session.revoked_at) return null;
  if (isExpired(session.expires_at)) return null;
  if (!safeEqual(session.token_hash, tokenHash)) return null;

  return await buildActorContext(session.identity_id, session.organization_id);
}

export async function buildActorContext(identityId: string, organizationId: string): Promise<ActorContext | null> {
  const perms = await effectivePermissions(identityId, organizationId);
  if (!perms) return null;
  const identity = await one<any>(`SELECT * FROM identities WHERE id = ?`, identityId);
  if (!identity) return null;

  const actor: ActorContext = {
    identityId,
    did: perms.did,
    kind: identity.kind,
    organizationId,
    departmentId: perms.departmentId,
    identityStatus: perms.identityStatus,
    membershipStatus: perms.membershipStatus,
    roleIds: perms.roles.map((r) => r.id),
    roleNames: perms.roles.map((r) => r.name),
    capabilities: new Set(perms.capabilities),
    scopeIds: perms.scopes.map((s) => s.id),
  };

  if (identity.kind === "AGENT") {
    const agent = await one<any>(`SELECT * FROM agents WHERE identity_id = ?`, identityId);
    if (agent) {
      // An agent's capabilities and scopes come from its own grants, not from roles.
      // Union'ing them with role capabilities would let an agent inherit a human's
      // permissions by sharing a membership — the escalation path this avoids.
      const agentCaps = (await many<{ action: string }>(
        `SELECT c.action FROM capabilities c JOIN agent_capabilities ac ON ac.capability_id = c.id WHERE ac.agent_id = ?`,
        agent.id,
      )).map((r) => r.action);
      const agentScopes = (await many<{ scope_id: string }>(`SELECT scope_id FROM agent_scopes WHERE agent_id = ?`, agent.id))
        .map((r) => r.scope_id);
      const tools = (await many<{ tool_name: string }>(`SELECT tool_name FROM agent_tools WHERE agent_id = ?`, agent.id))
        .map((r) => r.tool_name);

      actor.capabilities = new Set(agentCaps);
      actor.scopeIds = agentScopes;
      actor.departmentId = agent.department_id ?? actor.departmentId;
      actor.agent = {
        id: agent.id,
        status: agent.status,
        limits: j.dec<AgentLimits>(agent.limits_json, {}),
        tools,
      };
    }
  }

  return actor;
}

/* --------------------------------------------------------- authentication flows */

/** Step 1 of DID auth: hand out a single-use, short-lived nonce. */
export async function createChallenge(did: string) {
  if (!isValidDid(did)) throw badRequest("INVALID_DID", "Not a valid Ed25519 did:key identifier.");
  const identity = await getIdentityByDid(did);
  // Deliberately does not reveal whether the DID is registered — an unregistered DID
  // gets a well-formed challenge that will simply fail at verification. Otherwise this
  // endpoint becomes an oracle for enumerating an organization's members.
  const id = newId("chal");
  const nonce = newNonce();
  const created = nowIso();
  await run(
    `INSERT INTO auth_challenges (id, did, nonce, created_at, expires_at) VALUES (?,?,?,?,?)`,
    id, did, nonce, created, new Date(Date.now() + env.CHALLENGE_TTL_SECONDS * 1000).toISOString(),
  );
  return { challengeId: id, nonce, message: challengeMessage(did, nonce), expiresInSeconds: env.CHALLENGE_TTL_SECONDS, known: !!identity };
}

/** Step 2: verify the signature, consume the nonce, issue a session. */
export async function verifyChallengeAndLogin(params: { challengeId: string; did: string; signature: string; ip?: string | null; userAgent?: string | null }) {
  const challenge = await one<any>(`SELECT * FROM auth_challenges WHERE id = ?`, params.challengeId);
  if (!challenge) throw unauthorized("Challenge not found.");
  if (challenge.consumed_at) throw unauthorized("This challenge has already been used.");
  if (isExpired(challenge.expires_at)) throw unauthorized("Challenge expired. Request a new one.");
  if (challenge.did !== params.did) throw unauthorized("Challenge does not belong to this DID.");

  // Consume before verifying, so a failed attempt burns the nonce too. Otherwise an
  // attacker could grind signatures against one long-lived challenge.
  await run(`UPDATE auth_challenges SET consumed_at = ? WHERE id = ?`, nowIso(), challenge.id);

  if (!verifyChallenge(params.did, challenge.nonce, params.signature)) {
    throw unauthorized("Signature verification failed.");
  }

  const identity = await getIdentityByDid(params.did);
  if (!identity) throw unauthorized("No identity is registered for this DID.");
  if (identity.status !== "ACTIVE") throw forbidden("IDENTITY_INACTIVE", `This identity is ${identity.status}.`);

  const session = await issueSession(identity.id, identity.organization_id, { ip: params.ip, userAgent: params.userAgent });
  return { session, identity };
}

/** Development-only password path. Refused outright when disabled. */
export async function passwordLogin(params: { email: string; password: string; ip?: string | null; userAgent?: string | null }) {
  if (!env.ALLOW_PASSWORD_LOGIN) {
    throw forbidden("PASSWORD_LOGIN_DISABLED", "Password login is disabled. Use DID challenge authentication.");
  }
  const identity = await one<any>(`SELECT * FROM identities WHERE email = ? AND kind = 'HUMAN'`, params.email.toLowerCase().trim());
  const creds = identity ? await one<any>(`SELECT * FROM credentials WHERE identity_id = ?`, identity.id) : null;

  // Always run a verification, even with no matching identity, so response timing does
  // not distinguish "no such user" from "wrong password".
  const ok = creds
    ? verifyPassword(params.password, creds.password_hash, creds.salt)
    : (verifyPassword(params.password, sha256Hex("decoy").padEnd(128, "0"), "decoy"), false);

  if (!identity || !ok) throw unauthorized("Invalid email or password.");
  if (identity.status !== "ACTIVE") throw forbidden("IDENTITY_INACTIVE", `This identity is ${identity.status}.`);

  const session = await issueSession(identity.id, identity.organization_id, { ip: params.ip, userAgent: params.userAgent });
  return { session, identity };
}

export function toApiIdentity(row: any) {
  return {
    id: row.id, did: row.did, organizationId: row.organization_id,
    kind: row.kind, displayName: row.display_name, email: row.email,
    status: row.status, publicKey: row.public_key, chainTxHash: row.chain_tx_hash,
    createdAt: row.created_at, updatedAt: row.updated_at, revokedAt: row.revoked_at,
  };
}
