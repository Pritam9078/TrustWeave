import { one, many, run, tx } from "../db/clientV2.js";
import { newId } from "../core/ids.js";
import { nowIso } from "../core/time.js";
import { CAPABILITIES, capabilityId, isKnownCapability } from "../authorization/capabilities.js";
import { badRequest, conflict, notFound } from "../core/errors.js";

/** Organizations, departments, roles, capabilities and scopes. */

export async function getOrganization(id: string) {
  return await one<any>(`SELECT * FROM organizations WHERE id = $1`, id);
}

export async function listDepartments(organizationId: string) {
  return await many<any>(`SELECT * FROM departments WHERE organization_id = $1 ORDER BY name`, organizationId);
}

export async function createDepartment(organizationId: string, name: string, code: string) {
  if (await one(`SELECT id FROM departments WHERE organization_id = $1 AND code = $2`, organizationId, code)) {
    throw conflict("DEPARTMENT_EXISTS", `A department with code "${code}" already exists.`);
  }
  const id = newId("dept");
  await run(`INSERT INTO departments (id, organization_id, name, code, created_at) VALUES ($1,$2,$3,$4,$5)`,
    id, organizationId, name, code, nowIso());
  return await one<any>(`SELECT * FROM departments WHERE id = $1`, id);
}

/* -------------------------------------------------------------- capabilities */

/**
 * Sync the capability table from the code catalog. Idempotent, and safe to run on
 * every boot: the catalog in code is authoritative, so a row someone inserted by hand
 * is never treated as a real capability by the engine (see authorization/engine.ts,
 * gate 1) even if it survives here.
 */
export async function syncCapabilityCatalog() {
  for (const cap of CAPABILITIES) {
    const id = capabilityId(cap.action);
    const existing = await one(`SELECT id FROM capabilities WHERE id = $1`, id);
    if (existing) {
      await run(`UPDATE capabilities SET resource_type = $1, domain = $2, description = $3, is_privileged = $4 WHERE id = $5`,
        cap.resourceType, cap.domain, cap.description, cap.isPrivileged ? 1 : 0, id);
    } else {
      await run(`INSERT INTO capabilities (id, action, resource_type, domain, description, is_privileged) VALUES ($1,$2,$3,$4,$5,$6)`,
        id, cap.action, cap.resourceType, cap.domain, cap.description, cap.isPrivileged ? 1 : 0);
    }
  }
}

export async function listCapabilities() {
  return await many<any>(`SELECT * FROM capabilities ORDER BY domain, action`);
}

/* --------------------------------------------------------------------- roles */

export async function listRoles(organizationId: string) {
  const roles = await many<any>(`SELECT * FROM roles WHERE organization_id = ? ORDER BY name`, organizationId);
  return Promise.all(roles.map(async (r) => ({ ...r, capabilities: await roleCapabilities(r.id), scopes: await roleScopes(r.id), memberCount: await roleMemberCount(r.id) })));
}

export async function getRole(organizationId: string, id: string) {
  const role = await one<any>(`SELECT * FROM roles WHERE organization_id = ? AND id = ?`, organizationId, id);
  if (!role) return null;
  return { ...role, capabilities: await roleCapabilities(id), scopes: await roleScopes(id), memberCount: await roleMemberCount(id) };
}

export async function roleCapabilities(roleId: string): Promise<string[]> {
  const capabilities = await many<{ action: string }>(
    `SELECT c.action FROM capabilities c JOIN role_capabilities rc ON rc.capability_id = c.id WHERE rc.role_id = ? ORDER BY c.action`,
    roleId,
  );
  return capabilities.map((r) => r.action);
}

export async function roleScopes(roleId: string) {
  return await many<any>(
    `SELECT s.* FROM scopes s JOIN role_scopes rs ON rs.scope_id = s.id WHERE rs.role_id = ?`,
    roleId,
  );
}

async function roleMemberCount(roleId: string): Promise<number> {
  const result = await one<{ n: number }>(`SELECT COUNT(*) AS n FROM membership_roles WHERE role_id = ?`, roleId);
  return result?.n ?? 0;
}

export async function createRole(organizationId: string, input: { name: string; description?: string; capabilities?: string[]; isSystem?: boolean }) {
  if (await one(`SELECT id FROM roles WHERE organization_id = ? AND name = ?`, organizationId, input.name)) {
    throw conflict("ROLE_EXISTS", `A role named "${input.name}" already exists.`);
  }
  const id = newId("role");
  const ts = nowIso();
  await tx(async () => {
    await run(`INSERT INTO roles (id, organization_id, name, description, version, is_system, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`,
      id, organizationId, input.name, input.description ?? "", 1, input.isSystem ? 1 : 0, ts, ts);
    for (const action of input.capabilities ?? []) await attachCapability(id, action);
  });
  return await getRole(organizationId, id)!;
}

/**
 * Replacing a role's capability set bumps its version. The version is what an audit
 * event references, so "which permissions did this role carry when that action was
 * allowed?" stays answerable after an edit.
 */
export async function setRoleCapabilities(organizationId: string, roleId: string, actions: string[]) {
  const role = await one<any>(`SELECT * FROM roles WHERE organization_id = ? AND id = ?`, organizationId, roleId);
  if (!role) throw notFound("Role not found.");
  const unknown = actions.filter((a) => !isKnownCapability(a));
  if (unknown.length) throw badRequest("CAPABILITY_UNKNOWN", `Unknown capabilities: ${unknown.join(", ")}`);

  await tx(async () => {
    await run(`DELETE FROM role_capabilities WHERE role_id = ?`, roleId);
    for (const action of actions) await attachCapability(roleId, action);
    await run(`UPDATE roles SET version = version + 1, updated_at = ? WHERE id = ?`, nowIso(), roleId);
  });
  return await getRole(organizationId, roleId)!;
}

async function attachCapability(roleId: string, action: string) {
  if (!isKnownCapability(action)) throw badRequest("CAPABILITY_UNKNOWN", `Unknown capability: ${action}`);
  await run(`INSERT INTO role_capabilities (role_id, capability_id) VALUES (?,?) ON CONFLICT DO NOTHING`, roleId, capabilityId(action));
}

export async function updateRole(organizationId: string, roleId: string, patch: { name?: string; description?: string }) {
  const role = await one<any>(`SELECT * FROM roles WHERE organization_id = ? AND id = ?`, organizationId, roleId);
  if (!role) throw notFound("Role not found.");
  await run(`UPDATE roles SET name = ?, description = ?, updated_at = ? WHERE id = ?`,
    patch.name ?? role.name, patch.description ?? role.description, nowIso(), roleId);
  return await getRole(organizationId, roleId)!;
}

export async function deleteRole(organizationId: string, roleId: string) {
  const role = await one<any>(`SELECT * FROM roles WHERE organization_id = ? AND id = ?`, organizationId, roleId);
  if (!role) throw notFound("Role not found.");
  if (role.is_system) throw badRequest("SYSTEM_ROLE", "System roles cannot be deleted.");
  const members = await roleMemberCount(roleId);
  if (members > 0) throw conflict("ROLE_IN_USE", `${members} member(s) still hold this role. Unassign them first.`);
  await tx(async () => {
    await run(`DELETE FROM role_capabilities WHERE role_id = ?`, roleId);
    await run(`DELETE FROM role_scopes WHERE role_id = ?`, roleId);
    await run(`DELETE FROM roles WHERE id = ?`, roleId);
  });
}

/* -------------------------------------------------------------------- scopes */

export async function listScopes(organizationId: string) {
  return await many<any>(`SELECT * FROM scopes WHERE organization_id = ? ORDER BY name`, organizationId);
}

export async function getScope(organizationId: string, id: string) {
  return await one<any>(`SELECT * FROM scopes WHERE organization_id = ? AND id = ?`, organizationId, id);
}

const SCOPE_TYPES = ["ORGANIZATION", "DEPARTMENT", "COLLECTION", "RESOURCE", "VENDOR"];

/**
 * The selector key each scope type is matched on. Kept here rather than inferred,
 * because the failure mode of getting it wrong is silent and severe: a scope whose
 * selector uses an unrecognised key matches nothing, the fail-closed matcher denies
 * every request, and the symptom ("this Manager can't see their own department")
 * looks nothing like the cause. Validating at write time turns that into an
 * immediate, legible error.
 */
const SELECTOR_KEY: Record<string, string> = {
  ORGANIZATION: "organizationId",
  DEPARTMENT: "departmentIds",
  COLLECTION: "collectionIds",
  RESOURCE: "resourceIds",
  VENDOR: "vendors",
};

/**
 * Canonicalises scope constraints. `timeWindow` is accepted as {from,to} or {start,end}
 * and normalised to {from,to}; anything unparseable is rejected here rather than
 * silently producing a window that denies everything at request time.
 */
export function normalizeConstraints(raw: unknown): Record<string, unknown> {
  const input = { ...(raw as Record<string, any> ?? {}) };
  const out: Record<string, unknown> = {};

  if (input.maxAmount !== undefined && input.maxAmount !== null) {
    const amount = Number(input.maxAmount);
    if (!Number.isFinite(amount) || amount <= 0) throw badRequest("INVALID_CONSTRAINT", "maxAmount must be a positive number.");
    out.maxAmount = amount;
  }

  const window = input.timeWindow;
  if (window) {
    const from = window.from ?? window.start;
    const to = window.to ?? window.end;
    const valid = (v: unknown) => typeof v === "string" && /^\d{1,2}:\d{2}$/.test(v.trim());
    if (!valid(from) || !valid(to)) {
      throw badRequest("INVALID_CONSTRAINT", 'timeWindow needs "from" and "to" as HH:MM strings (or "start"/"end").');
    }
    out.timeWindow = { from: String(from).trim(), to: String(to).trim() };
    if (window.timezoneOffsetMinutes !== undefined) out.timeWindow = { ...out.timeWindow as object, timezoneOffsetMinutes: Number(window.timezoneOffsetMinutes) };
  }

  for (const [k, v] of Object.entries(input)) {
    if (k !== "maxAmount" && k !== "timeWindow") out[k] = v;
  }
  return out;
}

/** Accepts the singular convenience form (`departmentId: "x"`) and canonicalises it to
 *  the plural array the matcher reads. Anything unrecognised is rejected outright. */
export function normalizeSelector(scopeType: string, raw: unknown): Record<string, unknown> {
  const sel = { ...(raw as Record<string, unknown> ?? {}) };
  const key = SELECTOR_KEY[scopeType];

  if (scopeType === "ORGANIZATION") {
    // An org-wide scope with an empty selector legitimately means "this organization".
    return sel.organizationId ? { organizationId: sel.organizationId } : {};
  }

  const singular = key.replace(/Ids$/, "Id").replace(/^vendors$/, "vendor");
  let values = sel[key] ?? sel[singular];
  if (values === undefined || values === null) {
    throw badRequest("INVALID_SELECTOR",
      `A ${scopeType} scope requires a "${key}" array (or the singular "${singular}"). Received keys: ${Object.keys(sel).join(", ") || "none"}.`);
  }
  if (!Array.isArray(values)) values = [values];
  if (!(values as unknown[]).length) {
    throw badRequest("INVALID_SELECTOR", `"${key}" cannot be empty — an empty selector would match nothing and deny every request.`);
  }
  return { [key]: values };
}

export async function createScope(organizationId: string, input: { name: string; scopeType: string; selector?: unknown; constraints?: unknown }) {
  if (!SCOPE_TYPES.includes(input.scopeType)) {
    throw badRequest("INVALID_SCOPE_TYPE", `scopeType must be one of ${SCOPE_TYPES.join(", ")}.`);
  }
  if (await one(`SELECT id FROM scopes WHERE organization_id = ? AND name = ?`, organizationId, input.name)) {
    throw conflict("SCOPE_EXISTS", `A scope named "${input.name}" already exists.`);
  }
  const selector = normalizeSelector(input.scopeType, input.selector);
  const id = newId("scope");
  await run(`INSERT INTO scopes (id, organization_id, name, scope_type, selector_json, constraints_json, created_at) VALUES (?,?,?,?,?,?,?)`,
    id, organizationId, input.name, input.scopeType,
    JSON.stringify(selector), JSON.stringify(normalizeConstraints(input.constraints)), nowIso());
  return await getScope(organizationId, id)!;
}

export async function updateScope(organizationId: string, id: string, patch: { name?: string; selector?: unknown; constraints?: unknown }) {
  const scope = await getScope(organizationId, id);
  if (!scope) throw notFound("Scope not found.");
  await run(`UPDATE scopes SET name = ?, selector_json = ?, constraints_json = ? WHERE id = ?`,
    patch.name ?? scope.name,
    patch.selector !== undefined ? JSON.stringify(normalizeSelector(scope.scope_type, patch.selector)) : scope.selector_json,
    patch.constraints !== undefined ? JSON.stringify(normalizeConstraints(patch.constraints)) : scope.constraints_json,
    id);
  return await getScope(organizationId, id)!;
}

export async function attachScopeToRole(roleId: string, scopeId: string) {
  await run(`INSERT INTO role_scopes (role_id, scope_id) VALUES (?,?) ON CONFLICT DO NOTHING`, roleId, scopeId);
}

export async function detachScopeFromRole(roleId: string, scopeId: string) {
  await run(`DELETE FROM role_scopes WHERE role_id = ? AND scope_id = ?`, roleId, scopeId);
}

/* --------------------------------------------------------- emergency controls */

export const EMERGENCY_FLAGS = ["AGENTS_DISABLED", "PAYMENTS_DISABLED", "MINTING_DISABLED"] as const;

export async function listEmergencyFlags(organizationId: string) {
  const rows = await many<any>(`SELECT * FROM emergency_flags WHERE organization_id = ?`, organizationId);
  const byKey = new Map(rows.map((r) => [r.flag_key, r]));
  return EMERGENCY_FLAGS.map((key) => {
    const row = byKey.get(key);
    return {
      flagKey: key,
      enabled: !!row?.enabled,
      reason: row?.reason ?? null,
      actorId: row?.actor_id ?? null,
      updatedAt: row?.updated_at ?? null,
    };
  });
}

export async function setEmergencyFlag(organizationId: string, flagKey: string, enabled: boolean, actorId: string, reason: string) {
  if (!(EMERGENCY_FLAGS as readonly string[]).includes(flagKey)) {
    throw badRequest("UNKNOWN_FLAG", `Unknown emergency flag: ${flagKey}`);
  }
  const ts = nowIso();
  const existing = await one(`SELECT flag_key FROM emergency_flags WHERE organization_id = ? AND flag_key = ?`, organizationId, flagKey);
  if (existing) {
    await run(`UPDATE emergency_flags SET enabled = ?, reason = ?, actor_id = ?, updated_at = ? WHERE organization_id = ? AND flag_key = ?`,
      enabled ? 1 : 0, reason, actorId, ts, organizationId, flagKey);
  } else {
    await run(`INSERT INTO emergency_flags (organization_id, flag_key, enabled, reason, actor_id, updated_at) VALUES (?,?,?,?,?,?)`,
      organizationId, flagKey, enabled ? 1 : 0, reason, actorId, ts);
  }
  const flags = await listEmergencyFlags(organizationId);
  return flags.find((f) => f.flagKey === flagKey)!;
}

/* ---------------------------------------------------------- security events */

export async function recordSecurityEvent(input: {
  organizationId: string; kind: string; severity?: string;
  actorId?: string | null; summary: string; detail?: Record<string, unknown>;
}) {
  const id = newId("sec");
  await run(`INSERT INTO security_events (id, organization_id, kind, severity, actor_id, summary, detail_json, created_at) VALUES (?,?,?,?,?,?,?,?)`,
    id, input.organizationId, input.kind, input.severity ?? "MEDIUM",
    input.actorId ?? null, input.summary, JSON.stringify(input.detail ?? {}), nowIso());
  return await one<any>(`SELECT * FROM security_events WHERE organization_id = ? AND id = ?`, input.organizationId, id);
}

export async function listSecurityEvents(organizationId: string, limit = 100) {
  return await many<any>(`SELECT * FROM security_events WHERE organization_id = ? ORDER BY created_at DESC LIMIT ?`, organizationId, limit);
}

export async function acknowledgeSecurityEvent(organizationId: string, id: string) {
  await run(`UPDATE security_events SET acknowledged_at = ? WHERE organization_id = ? AND id = ?`, nowIso(), organizationId, id);
  // Read back with the tenant predicate too. The UPDATE above is correctly scoped, so an
  // id from another organization changes nothing — but an unscoped read-back would still
  // hand that row to the caller. The current route discards this value, which means the
  // leak is latent rather than live; it is exactly the kind of thing that becomes real
  // the moment someone starts returning it.
  return await one<any>(`SELECT * FROM security_events WHERE organization_id = ? AND id = ?`, organizationId, id);
}
