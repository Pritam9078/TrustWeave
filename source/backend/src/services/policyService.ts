import { one, many, run, tx, j } from "../db/clientV2.js";
import { newId } from "../core/ids.js";
import { nowIso } from "../core/time.js";
import { computePolicyHash } from "../core/hash.js";
import { badRequest, conflict, notFound } from "../core/errors.js";
import { toPolicyRecord } from "./authorizationService.js";
import type { PolicyRule } from "../authorization/policy.js";

/**
 * Policy versioning.
 *
 * The invariant: an ACTIVE policy version is immutable. "Editing" an active policy
 * creates a new version row and supersedes the old one; the old row is never mutated
 * or deleted. That is what keeps a two-year-old audit event replayable against the
 * exact conditions in force when it was decided — if we mutated in place, every
 * historical decision would silently start verifying against today's rules.
 */

const KNOWN_RULE_TYPES = new Set([
  "AMOUNT_MAX", "AMOUNT_MIN", "APPROVAL_THRESHOLD", "MERCHANT_ALLOWLIST", "MERCHANT_BLOCKLIST",
  "VELOCITY", "TIME_WINDOW", "DEPARTMENT_MATCH", "REQUIRE_EVIDENCE", "CURRENCY_ALLOWLIST", "DUAL_APPROVAL_ABOVE",
]);

export function validateRules(rules: unknown): PolicyRule[] {
  if (!Array.isArray(rules)) throw badRequest("INVALID_RULES", "conditions.rules must be an array.");
  for (const rule of rules) {
    if (!rule || typeof rule !== "object") throw badRequest("INVALID_RULES", "Each rule must be an object.");
    const type = (rule as any).type;
    if (!KNOWN_RULE_TYPES.has(type)) {
      throw badRequest("INVALID_RULES", `Unknown rule type "${type}". Known types: ${[...KNOWN_RULE_TYPES].join(", ")}`);
    }
    const numeric = ["AMOUNT_MAX", "AMOUNT_MIN", "APPROVAL_THRESHOLD", "DUAL_APPROVAL_ABOVE"];
    if (numeric.includes(type) && typeof (rule as any).value !== "number") {
      throw badRequest("INVALID_RULES", `Rule ${type} requires a numeric "value".`);
    }
    if (["MERCHANT_ALLOWLIST", "MERCHANT_BLOCKLIST", "CURRENCY_ALLOWLIST"].includes(type) && !Array.isArray((rule as any).values)) {
      throw badRequest("INVALID_RULES", `Rule ${type} requires a "values" array.`);
    }
    if (type === "TIME_WINDOW" && !/^\d{2}:\d{2}$/.test((rule as any).from ?? "")) {
      throw badRequest("INVALID_RULES", `Rule TIME_WINDOW requires "from"/"to" as HH:MM.`);
    }
  }
  return rules as PolicyRule[];
}

/**
 * Surface configurations that are individually valid but jointly contradictory —
 * a policy whose approval threshold sits above its hard maximum can never actually
 * route anything to approval, which is almost always a typo rather than an intent.
 * Reported as warnings, not errors: the admin decides.
 */
export function detectConflicts(rules: PolicyRule[]): string[] {
  const warnings: string[] = [];
  const max = rules.find((r) => r.type === "AMOUNT_MAX") as any;
  const threshold = rules.find((r) => r.type === "APPROVAL_THRESHOLD") as any;
  const dual = rules.find((r) => r.type === "DUAL_APPROVAL_ABOVE") as any;
  const min = rules.find((r) => r.type === "AMOUNT_MIN") as any;

  if (max && threshold && threshold.value >= max.value) {
    warnings.push(`Approval threshold (${threshold.value}) is at or above the hard maximum (${max.value}); no amount can ever reach approval — everything above the threshold is denied outright.`);
  }
  if (max && dual && dual.value >= max.value) {
    warnings.push(`Dual-approval threshold (${dual.value}) is at or above the hard maximum (${max.value}); dual approval will never trigger.`);
  }
  if (max && min && min.value > max.value) {
    warnings.push(`Minimum (${min.value}) exceeds maximum (${max.value}); this policy denies every amount.`);
  }
  const allow = rules.find((r) => r.type === "MERCHANT_ALLOWLIST") as any;
  const block = rules.find((r) => r.type === "MERCHANT_BLOCKLIST") as any;
  if (allow && block) {
    const overlap = allow.values.filter((v: string) => block.values.map((b: string) => b.toLowerCase()).includes(v.toLowerCase()));
    if (overlap.length) warnings.push(`Merchant(s) appear on both the allowlist and blocklist: ${overlap.join(", ")}. The blocklist wins.`);
  }
  return warnings;
}

export async function listPolicies(organizationId: string, opts: { policyKey?: string; status?: string; includeAllVersions?: boolean } = {}) {
  const where = ["organization_id = ?"];
  const params: unknown[] = [organizationId];
  if (opts.policyKey) { where.push("policy_key = ?"); params.push(opts.policyKey); }
  if (opts.status) { where.push("status = ?"); params.push(opts.status); }
  const rows = await many<any>(`SELECT * FROM policies WHERE ${where.join(" AND ")} ORDER BY policy_key, version DESC`, ...params);
  if (opts.includeAllVersions) return rows;
  const seen = new Set<string>();
  return rows.filter((r) => (seen.has(r.policy_key) ? false : (seen.add(r.policy_key), true)));
}

export async function getPolicy(organizationId: string, id: string) {
  return await one<any>(`SELECT * FROM policies WHERE organization_id = ? AND id = ?`, organizationId, id);
}

export async function policyVersions(organizationId: string, policyKey: string) {
  return await many<any>(`SELECT * FROM policies WHERE organization_id = ? AND policy_key = ? ORDER BY version DESC`, organizationId, policyKey);
}

export async function createPolicy(organizationId: string, actorId: string, input: {
  policyKey: string; name: string; description?: string;
  conditions: { rules: unknown }; appliesTo?: unknown; activate?: boolean;
}) {
  const rules = validateRules(input.conditions?.rules ?? []);
  if (await one(`SELECT id FROM policies WHERE organization_id = ? AND policy_key = ? AND version = 1`, organizationId, input.policyKey)) {
    throw conflict("POLICY_EXISTS", `Policy key "${input.policyKey}" already exists. Create a new version instead.`);
  }
  const id = newId("pol");
  const conditions = { rules };
  const hash = computePolicyHash({ id: input.policyKey, version: 1, conditions });
  const ts = nowIso();

  await run(`INSERT INTO policies (id, organization_id, policy_key, name, description, version, conditions_json, applies_to_json, status, hash, created_by, created_at, activated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, organizationId, input.policyKey, input.name, input.description ?? "", 1,
    j.enc(conditions), j.enc(input.appliesTo ?? {}),
    input.activate ? "ACTIVE" : "DRAFT", hash, actorId, ts, input.activate ? ts : null);

  return { policy: await getPolicy(organizationId, id)!, warnings: detectConflicts(rules) };
}

/** Create the next version of an existing policy. Never mutates the current one. */
export async function createVersion(organizationId: string, actorId: string, policyKey: string, input: {
  name?: string; description?: string; conditions: { rules: unknown }; appliesTo?: unknown; activate?: boolean;
}) {
  const versions = await policyVersions(organizationId, policyKey);
  if (versions.length === 0) throw notFound("Policy not found.");
  const latest = versions[0];
  const rules = validateRules(input.conditions?.rules ?? []);
  const nextVersion = latest.version + 1;
  const conditions = { rules };
  const hash = computePolicyHash({ id: policyKey, version: nextVersion, conditions });
  const id = newId("pol");
  const ts = nowIso();

  await tx(async () => {
    await run(`INSERT INTO policies (id, organization_id, policy_key, name, description, version, conditions_json, applies_to_json, status, hash, created_by, created_at, activated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, organizationId, policyKey, input.name ?? latest.name, input.description ?? latest.description,
      nextVersion, j.enc(conditions), j.enc(input.appliesTo ?? j.dec(latest.applies_to_json, {})),
      input.activate ? "ACTIVE" : "DRAFT", hash, actorId, ts, input.activate ? ts : null);

    if (input.activate) {
      await run(`UPDATE policies SET status = 'SUPERSEDED' WHERE organization_id = ? AND policy_key = ? AND id != ? AND status = 'ACTIVE'`,
        organizationId, policyKey, id);
    }
  });

  return { policy: await getPolicy(organizationId, id)!, warnings: detectConflicts(rules) };
}

export async function activatePolicy(organizationId: string, id: string) {
  const policy = await getPolicy(organizationId, id);
  if (!policy) throw notFound("Policy version not found.");
  if (policy.status === "ACTIVE") return policy;
  await tx(async () => {
    await run(`UPDATE policies SET status = 'SUPERSEDED' WHERE organization_id = ? AND policy_key = ? AND status = 'ACTIVE'`,
      organizationId, policy.policy_key);
    await run(`UPDATE policies SET status = 'ACTIVE', activated_at = ? WHERE id = ?`, nowIso(), id);
  });
  return await getPolicy(organizationId, id)!;
}

export async function disablePolicy(organizationId: string, id: string) {
  const policy = await getPolicy(organizationId, id);
  if (!policy) throw notFound("Policy version not found.");
  await run(`UPDATE policies SET status = 'DISABLED' WHERE id = ?`, id);
  return await getPolicy(organizationId, id)!;
}

export function toApi(row: any) {
  const record = toPolicyRecord(row);
  return {
    id: row.id, policyKey: row.policy_key, name: row.name, description: row.description,
    version: row.version, status: row.status, hash: row.hash,
    conditions: record.conditions, appliesTo: record.appliesTo,
    chainTxHash: row.chain_tx_hash, createdBy: row.created_by,
    createdAt: row.created_at, activatedAt: row.activated_at,
    warnings: detectConflicts(record.conditions.rules ?? []),
  };
}

/** Decision history for a policy — which authorizations cited it, and how they went. */
export async function decisionHistory(organizationId: string, policyId: string, limit = 50) {
  return await many<any>(
    `SELECT id, seq, action, resource_type, resource_id, decision, reason_codes, actor_did, timestamp
     FROM audit_events WHERE organization_id = ? AND policy_id = ? ORDER BY seq DESC LIMIT ?`,
    organizationId, policyId, limit,
  );
}
