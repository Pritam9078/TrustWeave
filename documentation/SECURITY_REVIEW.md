# TrustWeave — Security Review

**Review date:** 26 August 2026
**Scope:** the implemented codebase (`backend/`, `frontend/`, `contracts/`) at finalization.
**Method:** boundary tracing against the running system, not source skim. Every claim below
is backed either by an executing test (named), a live HTTP transcript, or a specific file and
line. Categories with nothing to report say so explicitly rather than padding the document.

**Baseline at review:** 183 backend tests, 36 smart-contract tests on a real EVM, Solidity
compiling with 0 errors / 0 warnings, frontend building clean.

---

## Summary of findings

| # | Finding | Severity | Component | Status |
|---|---|---|---|---|
| F-01 | `PAYMENT_CREATE` was not enforced at draft creation | Medium | `routes/payments.ts` | **Fixed** |
| F-02 | No `.gitignore`; `.env` was tracked | Medium | repository root | **Fixed** |
| F-03 | `.env.example` documented variables the code no longer reads | Low | `backend/.env.example` | **Fixed** |
| F-04 | Stale infra/docs contradicted the implementation | Low | repository root | **Fixed** |
| F-05 | Scope selectors written in a key the matcher never read | High | `services/orgService.ts` | **Fixed** (earlier phase) |
| F-06 | Malformed time window threw inside the engine → HTTP 500 | High | `authorization/scope.ts` | **Fixed** (earlier phase) |
| F-07 | Time windows evaluated in server-local time | Medium | `authorization/scope.ts` | **Fixed** (earlier phase) |
| F-08 | `INTEGRATION_READ` enforced but absent from the catalog | Medium | `authorization/capabilities.ts` | **Fixed** (earlier phase) |
| F-09 | Approval evaluated against a resource with no department | High | `routes/payments.ts` | **Fixed** (earlier phase) |
| F-10 | AI denial originated from schema validation, not the engine | Medium | `adapters/llm/mockProvider.ts` | **Fixed** (earlier phase) |
| F-11 | Agent freeze suspended the identity, losing forensic detail | Low | `services/agentService.ts` | **Fixed** (earlier phase) |
| F-12 | Approval idempotency lookup had no tenant predicate | Medium | `services/approvalService.ts` | **Fixed** |
| F-13 | Payment idempotency keys were a global namespace | Medium | `db/migrations/001_core.sql` | **Fixed** |
| F-14 | `acknowledgeSecurityEvent` read a row back without its tenant predicate | Low | `services/orgService.ts` | **Fixed** |
| F-15 | Executed payments did not record or expose which adapter ran | Medium | `services/paymentService.ts` | **Fixed** |

No unresolved finding is carried into the final package. Residual limitations that are design
choices rather than defects are listed in section L.

---

## A. Authentication

**Implementation note.** The specification references Supabase. The implementation does **not**
use Supabase. Authentication is implemented directly: Ed25519 DID challenge/response as the
primary path, with an optional development-only password path. This deviation is documented in
`DELTA_REPORT.md` §A. It is called out here because a reader expecting Supabase Auth would
otherwise look for controls that do not exist in this codebase — and would miss the ones that do.

**Traced.**

- **Challenge/response.** `auth/did.ts` binds both the DID *and* a single-use nonce into the
  signed message (`challengeMessage`). A signature captured from one login cannot be replayed
  against a fresh challenge, and a signature made for one DID cannot be presented for another.
  Evidence: `tests/unit.test.ts` — "rejects replay of a signature against a different nonce",
  "binds the signature to the DID, not just the nonce".
- **Nonce consumption.** `verifyChallengeAndLogin` consumes the nonce *before* verifying the
  signature, so a failed verification still burns the challenge and cannot be retried.
- **No DID enumeration.** `createChallenge` issues a challenge regardless of whether the DID
  exists, and does not report existence to the caller (`routes/auth.ts` returns only
  `challengeId`, `nonce`, `message`). An attacker cannot use the endpoint to discover valid DIDs.
- **Password path.** `passwordLogin` performs a timing-safe comparison against a decoy hash when
  the account does not exist, so response timing does not distinguish "no such user" from
  "wrong password". The path is refused outright at startup when `NODE_ENV=production`
  (`config/env.ts` → `assertSafeConfig`).
- **Token storage.** Session and agent credentials are stored as SHA-256 hashes, never in
  plaintext (`identityService.ts:230`, `agentService.ts:107`). A database disclosure does not
  yield usable credentials.
- **Session validation.** `resolveActorFromToken` re-derives roles, capabilities and scopes on
  every request. A stored snapshot exists for forensics but is explicitly **not** trusted for
  authorization, so a permission revoked mid-session takes effect on the next request.
- **Expiry and revocation.** Suspending or revoking an identity deletes live sessions
  (`setIdentityStatus` → `revokeAllSessionsFor`). Evidence: `tests/tenancy.e2e.test.ts` —
  "invalidates the session the moment the identity is suspended".
- **Logout.** `POST /api/auth/logout` revokes server-side sessions; the client additionally
  clears its token. Logout is not client-only.
- **Header hygiene.** `app.ts` redacts `authorization`, `x-agent-key` and
  `x-razorpay-signature` from logs.

**Finding:** No finding identified during implementation review.

---

## B. Multi-tenancy

**Implementation note.** There is no Supabase and therefore **no Postgres RLS**. Isolation is
enforced in the application layer: every query is parameterised by `organization_id`, and the
authorization engine runs a dedicated `TENANT_BOUNDARY` gate before any resource logic
(`authorization/engine.ts`). This is a genuine architectural difference from the specification
and is recorded in `DELTA_REPORT.md` §E. It is weaker than RLS in one specific respect: a future
query that forgets its `organization_id` predicate would not be caught by the database. The
mitigation is that resource loads flow through service functions that take `organizationId` as a
required argument, and the boundary is covered by tests.

**Traced.** A second organization ("Eastwind Rival Ltd") is created inside the *same database and
process* so isolation is tested where it actually matters rather than assumed.

- Reading another tenant's asset by id returns **404**, not 403 — existence is not confirmed.
- The rival admin, holding *every* capability in their own org, cannot read our asset.
- Mutating another tenant's asset is refused.
- Lists never leak foreign rows (assets, identities, audit events).
- A forged `organizationId` in the request body is ignored; the organization comes from the
  session only.
- An agent key cannot reach another tenant's resources.
- Each organization's audit chain verifies independently with distinct head hashes.

Evidence: `tests/tenancy.e2e.test.ts` — 22 tests, all passing.

### F-12 — Approval idempotency lookup had no tenant predicate
- **Severity:** Medium · **Component:** `services/approvalService.ts`
- **Evidence:** Found by the new static tenant-predicate scan (`tests/tenant-guard.test.ts`).
  `createApproval` deduplicated on `(request_type, request_id)` with no `organization_id`.
- **Impact:** The idempotency window spanned organizations. Request ids are globally unique
  prefixed strings, so this was not trivially exploitable — but a lookup that *can* see another
  tenant's approval is a lookup that can return one, and it defeats the tenant boundary by design
  rather than by accident.
- **Remediation:** Tenant predicate added. **Status: Fixed**, covered by
  "scopes approval idempotency to one organization".

### F-13 — Payment idempotency keys were a global namespace
- **Severity:** Medium · **Component:** `db/migrations/001_core.sql`, `services/paymentService.ts`
- **Evidence:** `idempotency_key TEXT UNIQUE` — a single global uniqueness constraint.
- **Impact:** One tenant's client-chosen key could collide with another's, turning a routine retry
  into either a cross-tenant read or an unexplainable `IDEMPOTENCY_CONFLICT`. Payment providers
  namespace these per account for exactly this reason.
- **Remediation:** Composite unique index on `(organization_id, idempotency_key)`, and the lookup
  is now tenant-scoped. **Status: Fixed**, covered by
  "namespaces idempotency keys per organization".

### F-14 — Unscoped read-back in `acknowledgeSecurityEvent`
- **Severity:** Low · **Component:** `services/orgService.ts`
- **Evidence:** The `UPDATE` was correctly tenant-scoped; the `SELECT` that returned the row was
  not.
- **Impact:** Latent rather than live — the route discards the return value, so no leak was
  reachable through the API. It would have become real the moment anyone returned it.
- **Remediation:** Predicate added to the read-back. **Status: Fixed.**

**Finding:** The three above were found during this pass and fixed. See §L-1 for the RLS
limitation and the static guard that now mitigates it.

---

## C. RBAC

Capabilities are defined **in server code** (`authorization/capabilities.ts`) and mirrored into
the database at boot. An administrator can compose roles freely but cannot invent a permission
the enforcement layer has never heard of.

| Role | Capabilities | Verified denials |
|---|---|---|
| **Admin** | Full catalog | Cannot suspend own identity (self-lockout guard); cannot grant an agent a capability the admin lacks |
| **Manager** | Department-scoped ops incl. `PAYMENT_APPROVE`, `PAYMENT_EXECUTE` | Denied on out-of-department assets, denied above scope amount cap, denied self-approval |
| **Auditor** | Read/verify only | Denied on policy, role, identity, collection, emergency, asset freeze, approval decision, **and payment draft creation** (F-01) |
| **User** | Own resources | Denied on all admin-plane mutations; directory scope-filtered to own department |
| **Agent** | Own narrow set, never the owner's | Denied on self-escalation, tool allowlist changes, limit changes, self-approval |

**Frontend guards are not security.** `components/Shell.jsx` filters navigation and
`RequireCapability` explains denials, but both are presentation. The backend enforces
independently. Verified: a `User` session sending `x-role: Admin`, `x-capabilities:
IDENTITY_CREATE` and `x-organization-id` headers is still refused — no code path reads a role
from a header (`tests/authorization.e2e.test.ts` — "ignores client-supplied role headers
entirely"). Direct URL access to every admin-only endpoint is refused server-side
(`tests/tenancy.e2e.test.ts` — "Direct URL access cannot bypass the frontend").

Role inheritance is **not implemented**; roles are flat capability sets. This is a deliberate
simplification — inheritance makes effective-permission reasoning harder to audit, and the
permission simulator exists to answer those questions directly instead.

### F-01 — `PAYMENT_CREATE` was not enforced at draft creation
- **Severity:** Medium
- **Component:** `backend/src/routes/payments.ts`
- **Evidence:** Probe against the running harness returned `201 Created` for both the Auditor
  and a plain User posting to `POST /api/payment-intents`. Neither holds `PAYMENT_CREATE`.
- **Impact:** No privilege escalation — a draft cannot execute, because `authorizeIntent`
  re-evaluates from the stored row and would refuse it. But it let a capability-less actor write
  rows into `payment_intents` and place records in front of an approver, and it directly
  contradicted the Auditor's defining guarantee of zero mutations, which is asserted elsewhere
  in the suite.
- **Remediation:** `authz.enforce({ action: "PAYMENT_CREATE", … })` added at the route before
  the service is reached, with the merchant, amount and currency in context. A payment the
  policy forbids outright is now refused at creation rather than stored as a doomed draft.
- **Status:** **Fixed.** Pinned by four tests in `tests/regressions.test.ts`.

---

## D. Authorization Engine

Eleven ordered gates in `authorization/engine.ts`: capability catalog → identity status →
membership → tenant boundary → emergency lockdown → agent state and tool allowlist → capability
held → scope → scope constraints → agent limits → policies.

- **Fail-closed throughout.** An unknown scope type returns `false` rather than defaulting to
  allow; an unrecognised policy rule type denies; an actor with no scopes is refused;
  a malformed time window returns `false` instead of throwing. Evidence: `tests/unit.test.ts`
  — "refuses an unknown scope type rather than defaulting to allow", "fails closed on an
  unrecognised rule type", "fails closed on a malformed window instead of throwing".
- **Unknown capability.** Rejected at gate 1 with `CAPABILITY_UNKNOWN`. This is what surfaced
  F-08, and `tests/regressions.test.ts` now scans route sources to prove no route enforces a
  capability the catalog does not define.
- **Rule precedence.** All rules are evaluated; `DENY` always beats `REQUIRE_APPROVAL`, so a
  blocklisted vendor cannot be waved through by an approver. Verified at both the unit level and
  live: `Sanctioned Holdings Ltd` at ₹5,000 denies with `MERCHANT_ALLOWLIST`.
- **Gate ordering is deliberate and unchanged.** Cheaper checks precede expensive ones. A
  consequence worth stating plainly: an over-limit payment to a blocklisted vendor reports
  `LIMIT_EXCEEDED` rather than the blocklist, because `AGENT_LIMITS` runs first. Both gates were
  verified to fire independently, so this is a reporting-order property, not a gap.
- **Collection queries.** Marked `query: true` and recorded as `SCOPE_CHECK: DEFERRED`; row-level
  filtering then applies at the call site. The trace never implies a scope check that did not
  happen.
- **Approval integrity.** Self-approval is refused; the approver must hold the required
  capability; `UPDATE … AND status='PENDING'` with a changes-count guard makes a double-approval
  race unwinnable.

**Finding:** No further finding identified during implementation review.

---

## E. AI Security

**The structural claim:** the model's only output channel is a typed schema, and the only path
from a proposal to a domain service is `services/toolGateway.ts`. No route calls a domain
mutation on an agent's behalf except through it.

Seven ordered steps per call: authenticate → resolve against a closed allowlist → check *this*
agent's allowlist → strict schema validation → central re-authorization → approval routing →
audit. Steps 3–5 are deliberately separate so a hallucinated tool, a compromised agent, and a
legitimate-but-over-limit call are distinguishable in the audit trail.

Attacks tested (`tests/ai-safety.e2e.test.ts`, `tests/demo-scenarios.e2e.test.ts`):

| Attack | Result |
|---|---|
| Prompt injection ×5 (role claims, "system override", CEO authority, fake XML admin tags, "limits removed") | All produce **well-formed** proposals that the engine then **denies**; agent capabilities and limits verified unchanged after each |
| Excessive payment amount | `DENY` / `LIMIT_EXCEEDED`, naming the breached ceiling |
| Merchant substitution to a blocklisted vendor | `DENY` / `MERCHANT_ALLOWLIST` |
| Unauthorized tool (not on agent's allowlist) | `DENY` / `AGENT_TOOL_NOT_ALLOWED` |
| Non-existent tool | `DENY` / `TOOL_UNKNOWN` + security event |
| Extra/unknown arguments (`bypassApproval: true`) | `DENY` / `INVALID_ARGUMENTS` — `.strict()` schemas reject rather than ignore |
| Agent granting itself capabilities / tools / higher limits | `403` on all three |
| Agent approving its own payment | `403` — approvals require a human (`requireHuman`) |
| Malformed / incomplete proposal | Not dispatched; reported as incomplete, **no authorization decision claimed** |

**On F-10, which is the most important lesson in this review.** The injection tests originally
passed for the wrong reason: the mock extractor failed to parse the injected text, so the
proposal was malformed and died at schema validation. That *looks* like a successful block but
means the authorization engine was never consulted. Three extractor defects were fixed (invoice
regex matching the literal word "invoice"; money transfers not classified as payments;
first-match-wins selecting the injected verb phrase "bypass the approval threshold" as the
vendor). The engine now receives a confident, correctly-parsed proposal and refuses it on policy
grounds. Additionally, `agentOrchestrator.ts` now refuses to dispatch an incomplete proposal at
all, so a parse failure can never again masquerade as a security control.

**Injected text never becomes fact.** `mockProvider` never copies the raw instruction into
`purpose`; `toolGateway.redact()` truncates long strings before they enter an audit payload
where an operator or another model might later read them as instruction.

**Injection detection is a reporting control, not the boundary.** `ragService.detectInjection`
raises a security event; it is explicitly not what makes the system safe, and the tests assert
the engine's decision is identical either way.

**Finding:** No unresolved finding. F-10 fixed.

---

## F. RAG Security

The required chain — identity → tenant → role → permissions → scope → authorized retrieval →
LLM — is implemented in `ragService.retrieveForActor`, and **no unfiltered retrieval function
exists in the codebase**. There is no "search everything then ask the model to be discreet"
path to accidentally call.

Two-stage filter: a SQL pre-filter on organization and department, then the *same* `scopeMatches`
predicate the authorization engine uses, so retrieval cannot drift from authorization.
Documents may additionally require a capability (`requiredCapability`).

Live evidence, agent scoped to Finance:

```
returned 3 chunk(s); withheld:
  ('Compensation Bands FY2026 (Restricted)', 'Requires capability ORG_MANAGE.')
  ('Asset Handling Standard',                'Belongs to another department.')
```

The response reports *why* each document was withheld, which makes the boundary demonstrable
rather than merely claimed. Verified for both an agent and a plain User.

**Finding:** No finding identified during implementation review.

---

## G. Payments

Enforced path: AI → Tool Gateway → authorization → approval if required → execution. There is no
route that lets a model reach Razorpay directly; `create_payment_intent` is a registry tool whose
handler calls `paymentService`, which re-authorizes.

- **Amount integrity.** `executeIntent` re-checks authorization *immediately before* the provider
  call and reads the amount from the stored row, so the executed amount always equals the
  authorized amount.
- **Idempotency.** Client key or a derived minute-bucket hash prevents double-click duplicates;
  execution is replay-safe (`replayed: true` returns the original order).
- **Webhook signatures.** Verified by HMAC over the **exact raw bytes** — `app.ts` installs a
  raw-body parser precisely because re-serialising parsed JSON would break every legitimate
  signature. Unsigned → 400; forged → 401; neither changes state. Invalid attempts are recorded
  and raise a security event rather than being silently dropped.
- **Amount/currency cross-check.** A validly-signed webhook whose amount disagrees with the
  intent is treated as a **CRITICAL security event**, not a success.
- **Live-key guard.** `liveAdapter` refuses any key not prefixed `rzp_test_` unless
  `ALLOW_LIVE_KEYS=true`.

**Finding:** No finding identified during implementation review.

---

## H. Blockchain

Four registries on a shared `AccessControlled` base, 36 tests on a real in-process EVM.

- **Two-tier privilege.** `admin` governs who may write; a `writer` (the backend key) may record
  facts but cannot pause, appoint writers, or re-govern. A leaked backend key can write junk —
  it cannot disable the pause switch that would contain the incident. Verified: a writer
  attempting `setPaused` reverts with `NotAdmin`.
- **Unauthorized operations revert.** Mint, transfer, freeze, revoke, agent pause/revoke,
  capability change and proof anchoring all revert with `NotWriter` for an attacker.
- **No ERC-721 approval surface.** `AssetRegistry` deliberately exposes no `approve`,
  `setApprovalForAll` or `transferFrom`. These assets are organizationally controlled; inheriting
  ERC-721 would hand every holder an unconditional transfer and silently defeat the authorization
  model. The *absence* of those functions is asserted as a test.
- **Terminal states.** Identity revocation, asset revocation and agent revocation are
  irreversible on-chain — a compromised key is never resurrected.
- **Proof immutability.** `ProofRegistry.anchor` has no overwrite or delete path, for anyone,
  including the admin. Asserted by scanning the ABI for mutator names.
- **Replay.** Duplicate registration, double mint and re-anchoring the same commitment all
  revert rather than silently updating.
- **Two-step admin handover** prevents a mistyped address bricking governance permanently.
- **Minimal on-chain data.** Only commitments cross the boundary — never a DID string, name,
  email, amount, vendor or metadata body. The chain is useful for verification and useless as a
  directory of who works where. Capability *sets* are stored as a commitment, not a list, so the
  chain does not advertise which credential is worth stealing.

**Finding:** No finding identified during implementation review.

---

## I. Secrets

- **No secret is committed.** The only tracked configuration files are `.env.example` templates
  containing empty placeholders.
- **F-02 — no `.gitignore` existed** and `backend/.env` was tracked. It happened to contain only
  a database path, so nothing sensitive leaked, but the next developer to add a real Razorpay or
  chain key would have committed it. **Fixed:** a `.gitignore` now excludes `.env`, `*.pem`,
  `*.key`, `*.db` and build output, and the tracked `.env` was removed.
- **F-03 — `.env.example` was stale**, documenting `DATABASE_URL`, `REDIS_URL`,
  `CHAIN_CONTRACT_ADDRESS` and a Drizzle/Postgres swap that the code no longer reads. Anyone
  following it would have configured a system that ignored them. **Fixed:** regenerated from the
  variables `config/env.ts` actually reads, with `SERVER-ONLY SECRET` marked inline.
- **Frontend receives only public configuration.** The single variable is
  `VITE_API_BASE_URL`. Everything in a `VITE_*` variable is compiled into the browser bundle;
  `frontend/.env.example` states this explicitly. The frontend holds **no** API keys and calls
  no third party directly — Razorpay, the LLM and the chain are reached only through the backend.
- **Startup guards.** Production refuses to boot with password login enabled, wildcard CORS, or a
  missing webhook secret.
- **One-time secrets.** Generated private keys and agent tokens are returned exactly once and
  never persisted in recoverable form (only a hash is stored). The UI labels them accordingly.

---

## J. Audit

Org-wide append-only hash chain. Each entry commits to its predecessor; `verifyChain` recomputes
payload hashes as well as links, so altering a stored payload breaks verification.

Audited: authentication (login/logout), **every authorization decision including denials**,
payment create/authorize/execute/reconcile, approval decisions, asset create/mint/assign/
transfer/freeze/revoke, identity create/status/role/scope changes, agent register/configure/
freeze/token-rotate, policy create/version/activate/disable, role capability **diffs** (added and
removed named explicitly — "role changed" alone would not tell an auditor whether a privilege was
granted), emergency controls, document ingest/delete, tool calls (allowed and denied), and
blockchain anchoring including failures.

- **Denials are recorded before the error is thrown**, so a refusal cannot be lost.
- Every step of a payment lifecycle shares one `traceId`.
- Tamper detection is demonstrated, not asserted: a test rewrites a payload directly in the
  database and the chain reports `valid: false` with the breaking sequence — and proofs anchored
  in the broken chain then correctly fail verification too.
- Visibility follows role: Admin/Auditor/Manager see org-wide events, a plain User sees only
  their own. The filter is server-side and cannot be widened by a query parameter.

**Finding:** No finding identified during implementation review.

---

## K. Fixed findings from earlier phases

Recorded here so the package carries a complete history rather than only the final state.

- **F-05 (High) — scope selectors silently dead.** Scopes were written with `departmentId`
  while the fail-closed matcher read `departmentIds`. Every department-scoped actor was denied
  everything, and the symptom looked nothing like the cause. Fixed by canonicalising and
  **validating at write time**, so a bad selector now fails loudly at configuration instead of
  failing closed at request time.
- **F-06 (High) — malformed time window threw inside the engine**, surfacing as HTTP 500. This
  is the worst failure mode available here: the caller cannot distinguish a denial from a check
  that never ran. Now fails closed and is rejected at write time.
- **F-07 (Medium) — time windows used server-local time**, so a window written as business hours
  IST silently meant those hours in UTC. Now honours a declared `timezoneOffsetMinutes`.
- **F-08 (Medium) — `INTEGRATION_READ` enforced but undefined**, making the page unreachable for
  everyone including Admin. Now defined, and a regression test scans route sources to prevent
  recurrence.
- **F-09 (High) — approvals evaluated against a resource with no department**, so no
  department-scoped approver ever matched a scope and only an org-wide Admin could approve
  anything. Delegated approval was effectively broken. Now hydrated from the underlying payment.
- **F-11 (Low) — agent freeze suspended the underlying identity**, blocking the credential at the
  door and reducing the audit record to "inactive identity" — losing which tool the frozen agent
  reached for. Freeze now leaves the identity active so the engine records an explicit
  `AGENT_FROZEN` denial against the attempted action. Revocation remains terminal.

Note that F-05, F-06 and F-07 are the same shape: configuration written in one vocabulary and
read in another. Validation now sits at the write boundary in all three places.

---

## L. Residual limitations (design choices, not defects)

1. **No database-level RLS.** Isolation is application-enforced. PostgreSQL migration was
   assessed and **deliberately declined**: it touches 18 files and 227 raw SQL statements, and
   PostgreSQL could not be installed in this environment, so it would have shipped as an untested
   rewrite of the data layer. See `docs/POSTGRES_RLS_MIGRATION.md` for the full plan and the
   reasoning.

   The specific risk this creates — a future query omitting its predicate — is now mitigated by
   `tests/tenant-guard.test.ts`, a static scan that fails the build if any `SELECT` touching a
   tenant-scoped table does not constrain the tenant. Exemptions require a written justification.
   Running it for the first time found F-12, F-13 and F-14, none of which 171 passing tests had
   caught. This is weaker than RLS — it is a static check, not a runtime kernel, and it cannot
   constrain a query issued from outside this codebase — but it is tested and shipped.
2. **Password login exists** as a development convenience. Refused at startup in production.
3. **Default adapters are simulated.** Chain, payments and LLM run locally unless credentials are
   supplied. Every simulated receipt carries `simulated: true` and the Integrations page shows
   `SIMULATED` vs `LIVE` — nothing pretends to have reached a real provider.
4. **Injection detection is heuristic** (7 patterns). It is a reporting control; containment is
   structural.
5. **The local embedder is a 256-dimension hashing embedder**, adequate for demonstration
   retrieval but not semantically strong. The security boundary does not depend on it.
6. **Gate ordering means the first failing gate is the reported reason.** Both gates in a
   multi-violation request were verified to fire independently.
7. **No role inheritance.** Flat capability sets, by choice.
