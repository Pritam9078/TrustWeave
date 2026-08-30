# PostgreSQL + Row-Level Security — Migration Plan

> **STATUS: NOT IMPLEMENTED.** This document describes work that has *not* been done. Nothing in
> the shipped codebase uses PostgreSQL, Supabase, or row-level security. It exists so the
> hardening step is specified rather than hand-waved, and so a reader can see exactly what would
> change. Do not cite it as a description of the running system.

## Why it was not implemented

Migrating the data layer was assessed and deliberately declined. The reasoning, so it can be
disagreed with:

| Factor | Finding |
|---|---|
| Blast radius | **18 source files, 227 raw SQL statements**, plus the full schema |
| Verifiability here | **Zero.** PostgreSQL could not be installed in this environment — `apt-get install postgresql` fails with 404s on the archive, and there is no network path to a hosted instance |
| What shipping it would mean | An **untested rewrite of the entire data layer** of a system whose sole value is verified authorization |
| Current state | 177 backend tests + 36 contract tests passing, including 22 cross-tenant isolation tests |

Replacing a verified data layer with an unverifiable one would trade a demonstrated property for
an asserted one. The brief was explicit that a dangerous architectural rewrite should be stopped
and reported rather than attempted, and this is that report.

## What was done instead

The absence of RLS creates exactly one concrete risk, stated in the security review: *a future
query that omits its `organization_id` predicate would not be caught by the database.* That risk
was closed at the point it is actually introduced — when the query is written.

**`tests/tenant-guard.test.ts`** statically scans every SQL statement in the backend source and
fails the build if a `SELECT` touching a tenant-scoped table does not constrain the tenant.
Exemptions require an explicit entry with a written justification, so an exception is a decision
on the record rather than an oversight.

Running it for the first time found **two real defects** that 171 passing tests had not:

1. **Approval idempotency spanned tenants.** `createApproval` deduplicated on
   `(request_type, request_id)` with no organization predicate, so the dedupe window crossed
   organizations.
2. **Payment idempotency keys were a global namespace.** `idempotency_key` carried a global
   `UNIQUE` constraint, so one tenant's client-chosen key could collide with another's — turning
   a routine retry into either a cross-tenant read or an unexplainable conflict. Now a composite
   unique index on `(organization_id, idempotency_key)`.

A third, latent leak was also fixed: `acknowledgeSecurityEvent` scoped its `UPDATE` correctly but
read the row back without the predicate. The route discarded the value, so it was not live — but
it would have become real the moment anyone returned it.

This is a weaker guarantee than RLS. It is a static check, not a runtime kernel, and it cannot
constrain a raw query issued by something other than this codebase. It is, however, tested,
shipped and honest about its own limits.

---

## The migration, if it is undertaken

### Step 1 — Schema translation

`001_core.sql` is SQLite. Changes required:

| SQLite | PostgreSQL |
|---|---|
| `TEXT PRIMARY KEY` | unchanged (ids are application-generated prefixed strings) |
| `INTEGER` booleans | `BOOLEAN` |
| `datetime('now')`, `date('now')` | `now()`, `current_date` |
| `INTEGER PRIMARY KEY AUTOINCREMENT` (audit `seq`) | `BIGSERIAL` |
| `PRAGMA table_info` | `information_schema.columns` |
| String concat `\|\|` | unchanged |
| JSON stored as `TEXT` | `JSONB`, or leave as `TEXT` to minimise the diff |

Recommendation: keep JSON as `TEXT` for the first pass. Converting to `JSONB` changes the
serialisation contract in `db/client.ts` (`j.enc`/`j.dec`) and every hash computed over a stored
payload — which would invalidate the audit chain. That is a separate, later migration with its
own verification.

### Step 2 — Driver

Replace `db/driver.ts` with a `pg` `Pool`. The repository surface (`one`, `many`, `run`, `tx`)
already isolates callers, so this is the only file that must change shape. Placeholders move from
`?` to `$1..$n`; the driver can rewrite them centrally rather than editing 227 statements.

### Step 3 — Tenant context

RLS needs the current organization on the connection. Set it once per request, inside the same
transaction as the work:

```sql
SET LOCAL app.current_organization = '<organization id from the session>';
```

`SET LOCAL` scopes to the transaction, so a pooled connection cannot leak context between
requests. **The value must come from the resolved session, never from a request body or header** —
that is the same rule the application layer already follows.

### Step 4 — Policies

For each of the 17 tenant-scoped tables:

```sql
ALTER TABLE assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE assets FORCE ROW LEVEL SECURITY;   -- applies to the table owner too

CREATE POLICY assets_tenant_isolation ON assets
  USING      (organization_id = current_setting('app.current_organization', true))
  WITH CHECK (organization_id = current_setting('app.current_organization', true));
```

`USING` filters reads; `WITH CHECK` prevents writing a row into another tenant. `FORCE` matters:
without it the table owner bypasses the policy, and the application user is often the owner.

Tables requiring policies: `departments`, `identities`, `memberships`, `roles`, `scopes`,
`policies`, `asset_collections`, `assets`, `agents`, `payment_intents`, `approvals`,
`audit_events`, `proofs`, `documents`, `sessions`, `security_events`, `emergency_flags`.

### Step 5 — Pre-authentication paths

Three lookups legitimately run before an organization is known, and RLS would break them:

- `identities WHERE email = ?` — password sign-in
- `identities WHERE did = ?` — DID challenge
- `sessions WHERE token_hash = ?` / `agents WHERE token_hash = ?` — credential resolution
- `payment_intents WHERE provider_order_id = ?` — webhook reconciliation, which carries no session

Handle these with a dedicated role holding `BYPASSRLS`, used **only** by the credential-resolution
and webhook paths, or with `SECURITY DEFINER` functions narrowly scoped to those lookups. Do not
grant `BYPASSRLS` to the general application role — that would silently disable every policy.

### Step 6 — Verification

The migration is not complete until these pass:

1. All 177 existing backend tests, unchanged.
2. A new suite proving isolation **at the database layer**: connect directly as the application
   role with `app.current_organization` set to org A, issue a deliberately unconstrained
   `SELECT * FROM assets`, and assert only org A rows return. This is the test that distinguishes
   real RLS from application filtering, and it is the reason the current guard is a mitigation
   rather than an equivalent.
3. A test asserting `WITH CHECK` blocks inserting a row with a foreign `organization_id`.
4. A test asserting the pre-authentication paths still resolve.
5. The audit chain verifies after migration — payload hashes must be byte-identical, which is why
   the `JSONB` conversion is deferred.

### Step 7 — Supabase specifically

Supabase is PostgreSQL plus an auth service. If Supabase is adopted:

- The database work above is unchanged; Supabase RLS *is* PostgreSQL RLS.
- Supabase Auth would **replace** the DID challenge/response layer, which is itself a specified
  pillar of this product. Running both creates two competing sources of identity truth. That is a
  product decision, not a technical one, and it should be made explicitly rather than by adopting
  a platform default.
- Supabase's `auth.uid()` would need mapping to an TrustWeave identity, and the eleven-gate
  authorization engine would remain unchanged — it is deliberately independent of how the actor
  was authenticated.

## Estimated effort

Schema translation and driver: 1–2 days. Policies and tenant context: 1 day. Pre-authentication
carve-outs: 1 day. Verification and fixing what the new tests find: 2–3 days. Call it a week with
a real PostgreSQL instance available, and do not attempt it without one.
