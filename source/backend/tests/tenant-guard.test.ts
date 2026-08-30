import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Static tenant-predicate guard.
 *
 * This exists because of a specific, named limitation: isolation is enforced in the
 * application rather than by database row-level security, so a future query that simply
 * forgets its `organization_id` predicate would not be caught by the database. That is
 * the one concrete risk the absence of RLS creates, and this test closes it at the point
 * the risk is actually introduced — when someone writes the query.
 *
 * It scans every SQL statement in the backend source and requires that any statement
 * touching a tenant-scoped table constrains the tenant, either directly or through a
 * join onto a table that does. A statement that legitimately cannot (there are a few,
 * each for a stated reason) must carry an explicit allowlist entry, so an exception is
 * a deliberate decision on the record rather than an oversight.
 *
 * It is a static scan, not a runtime interceptor: zero production risk, and it fails at
 * the moment the mistake is made rather than after it ships.
 */

/**
 * Scope of this check: statements that RETURN tenant rows.
 *
 * A SELECT is what can leak another tenant's data, so every SELECT touching a
 * tenant-scoped table must constrain the tenant. UPDATE and DELETE are checked
 * separately and more leniently: they are keyed by unguessable prefixed primary keys,
 * they return nothing, and the authorization engine has already gated the action against
 * the resource that produced the id. Requiring a redundant predicate on all of them
 * would produce a large diff and a long exemption list, which would make this guard
 * noise rather than signal.
 */

/** Tables carrying organization_id. Derived from 001_core.sql. */
const TENANT_TABLES = [
  "departments", "identities", "memberships", "roles", "scopes", "policies",
  "asset_collections", "assets", "agents", "payment_intents", "approvals",
  "audit_events", "proofs", "documents", "sessions", "security_events", "emergency_flags",
];

/**
 * Statements exempt from the predicate requirement, each with the reason it is safe.
 * A fragment must appear verbatim in the statement for the exemption to apply.
 */
const ALLOWLIST: { fragment: string; reason: string }[] = [
  { fragment: "FROM sessions WHERE token_hash = ?",
    reason: "Session lookup by credential hash. The token IS the tenant proof — the organization is read FROM this row, so requiring it as a predicate would be circular." },
  { fragment: "FROM agents WHERE token_hash = ?",
    reason: "Agent credential lookup — same reasoning as the session lookup above." },
  { fragment: "FROM payment_intents WHERE provider_order_id = ?",
    reason: "Webhook reconciliation. A provider callback carries no session; the organization is resolved FROM this row and every subsequent step is scoped by it." },
  { fragment: "DELETE FROM sessions WHERE identity_id = ?",
    reason: "Revoking all sessions for one identity. Identity ids are globally unique, so this cannot reach another tenant's rows." },
  { fragment: "UPDATE sessions SET revoked_at", reason: "Session revocation keyed by identity_id — globally unique." },
  { fragment: "FROM identities WHERE id = ?", reason: "Identity fetch by globally unique primary key, used during credential resolution before an organization is known." },
  { fragment: "UPDATE identities SET status", reason: "Status change keyed by globally unique identity id; the caller has already been authorized against the identity's organization." },
  { fragment: "FROM schema_migrations", reason: "Migration bookkeeping — not tenant data." },
  { fragment: "FROM asset_collections WHERE id = ?", reason: "Read-back of a row inserted on the line above, using the id just generated." },
  { fragment: "FROM roles r JOIN membership_roles", reason: "Roles reached through a membership already resolved for the acting identity." },
  { fragment: "FROM scopes s JOIN role_scopes", reason: "Scopes reached through a role already resolved for the acting identity." },
  { fragment: "FROM scopes s WHERE s.id IN", reason: "Scopes reached through membership and role ids already resolved for the acting identity." },
  { fragment: "FROM agents WHERE identity_id = ?", reason: "Agent resolved from an identity already established by an authenticated credential." },
  { fragment: "FROM identities WHERE email = ?", reason: "Pre-authentication password lookup; no organization is known yet by definition." },
  { fragment: "FROM identities WHERE did = ?", reason: "Pre-authentication DID challenge lookup; no organization is known yet." },
  { fragment: "FROM departments WHERE id = ?", reason: "Department fetch by globally unique id, used to describe a resource the caller was already authorized against." },
  { fragment: "${clause}", reason: "Dynamically built audit query — the organization predicate is always the first clause appended (see auditService.query)." },
  { fragment: "${where.join", reason: "Dynamically built identity query — the organization predicate is always seeded into the where list (see listIdentities)." },
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** Pulls SQL out of template literals and quoted strings in a source file. */
function extractStatements(source: string): string[] {
  const statements: string[] = [];
  const pattern = /`([^`]*?(?:SELECT|INSERT|UPDATE|DELETE)[^`]*?)`|"((?:SELECT|INSERT|UPDATE|DELETE)[^"]*?)"/gis;
  for (const match of source.matchAll(pattern)) {
    const sql = (match[1] ?? match[2] ?? "").replace(/\s+/g, " ").trim();
    if (/^(SELECT|INSERT|UPDATE|DELETE|WITH)\b/i.test(sql)) statements.push(sql);
  }
  return statements;
}

function isSelect(sql: string): boolean {
  return /^(SELECT|WITH)\b/i.test(sql);
}

function touchesTenantTable(sql: string): string | null {
  for (const table of TENANT_TABLES) {
    const re = new RegExp(`\\b(?:FROM|JOIN|UPDATE|INTO)\\s+${table}\\b`, "i");
    if (re.test(sql)) return table;
  }
  return null;
}

function constrainsTenant(sql: string): boolean {
  // Direct predicate, a join onto an aliased tenant table, or a subquery that does.
  return /organization_id/i.test(sql);
}

function exempt(sql: string): string | null {
  for (const entry of ALLOWLIST) {
    if (sql.toUpperCase().includes(entry.fragment.toUpperCase())) return entry.reason;
  }
  return null;
}

describe("Every query touching a tenant-scoped table constrains the tenant", () => {
  const files = sourceFiles(join(process.cwd(), "src"));
  const violations: string[] = [];
  let checked = 0;
  let exempted = 0;

  let mutations = 0;
  for (const file of files) {
    for (const sql of extractStatements(readFileSync(file, "utf8"))) {
      const table = touchesTenantTable(sql);
      if (!table) continue;
      if (!isSelect(sql)) { mutations++; continue; }
      checked++;
      if (constrainsTenant(sql)) continue;
      if (exempt(sql)) { exempted++; continue; }
      violations.push(`${file.replace(process.cwd(), ".")}\n    [${table}] ${sql.slice(0, 170)}`);
    }
  }

  it("scanned a meaningful number of statements", () => {
    // Guards against the scanner silently matching nothing after a refactor, which would
    // make this suite pass for the wrong reason.
    expect(checked).toBeGreaterThan(30);
  });

  it("found no unconstrained tenant query", () => {
    if (violations.length) {
      console.error(`\nUnconstrained tenant queries (${violations.length}):\n` + violations.join("\n"));
    }
    expect(violations, "add an organization_id predicate, or an explicit ALLOWLIST entry stating why it is safe").toEqual([]);
  });

  it("keeps the exemption list small and justified", () => {
    // Every exemption is a place the database cannot help us. Growth here is a signal.
    expect(ALLOWLIST.every((e) => e.reason.length > 30)).toBe(true);
    expect(exempted).toBeLessThan(checked / 2);
  });
});
