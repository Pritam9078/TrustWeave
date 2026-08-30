# TrustWeave — Implementation Delta Report

**Date:** 26 August 2026
**Purpose:** an honest account of how the implemented system differs from the original plan,
including every deviation, addition and deferral. The codebase is the source of truth; where a
specification and the implementation disagree, this document records the implementation and
explains why.

**Verified baseline at the time of writing:**

| Measure | Value |
|---|---|
| Backend tests | **183 passing** (11 suites) |
| Smart-contract tests | **36 passing** on a real in-process EVM |
| Solidity compilation | **0 errors, 0 warnings** (solc 0.8.24) |
| Frontend build | Clean (306 kB JS, 87 kB gzipped) |
| Frontend routes | **28 addressable** + 2 redirects |
| Backend endpoints | **85** |
| Capabilities | **47** |
| Smart contracts | 5 (4 registries + 1 base) |

---

## A. Original planned architecture vs final implemented architecture

### The single largest deviation: no Supabase, no Postgres, no Redis

**Planned.** Supabase authentication, PostgreSQL with row-level security, Redis, Drizzle ORM,
NestJS/FastAPI.

**Implemented.** Fastify + TypeScript, Node's built-in SQLite (`node:sqlite`) behind a thin
repository layer, direct Ed25519 DID authentication, no Redis, no ORM.

**Why.** The baseline repository could not install. `better-sqlite3@13` requires `node-gyp` and
has no prebuilt binary for Node 22.22; header downloads were blocked. That single native
dependency made `npm install` fail outright, which meant nothing else could be verified. Node
≥22.5 ships SQLite in core, so replacing Drizzle + `better-sqlite3` with a repository layer over
`node:sqlite` removed the only native-compilation dependency in the project. The driver still
prefers `better-sqlite3` when present, so a deployment that wants it keeps it.

Supabase was not adopted because the authorization model needs to evaluate capability, scope,
policy, agent limits and approval state together, in a defined order, and return an *explainable
trace*. That is the product. Delegating authentication to Supabase would have been reasonable in
isolation, but the DID challenge/response layer is itself a specified pillar of the system
(verifiable identity), so implementing it directly rather than layering it over a second identity
provider avoided two competing sources of identity truth.

**What this costs, stated plainly.** There is **no database-level RLS**. Tenant isolation is
enforced in the application: a dedicated `TENANT_BOUNDARY` gate in the authorization engine plus
`organization_id` predicates on every query. This is weaker than RLS in one specific way — a
future query that forgets its predicate would not be caught by the database. It is covered by 19
cross-tenant tests, but moving to Postgres with RLS is the correct hardening step for production
and is recorded as limitation L-1 in `SECURITY_REVIEW.md`.

### Structural comparison

| Layer | Planned | Implemented | Status |
|---|---|---|---|
| Frontend | Next.js | React 18 + Vite + React Router 6 + Tailwind | Changed |
| Backend | NestJS / FastAPI | Fastify + TypeScript (ESM, strict) | Changed |
| Database | PostgreSQL + RLS | SQLite via `node:sqlite`, repository layer | **Changed — see above** |
| ORM | Drizzle | None (parameterised SQL) | Removed |
| Queue | Redis / BullMQ | None | Removed |
| Auth | Supabase | Ed25519 DID challenge/response | **Changed** |
| Vector DB | Dedicated vector database | Local 256-dim hashing embedder in SQLite | Simplified |
| Chain | EVM testnet | EVM adapter + in-memory adapter enforcing identical invariants | Extended |
| Contracts | 1 registry (`TrustWeaveRegistry`) | 4 registries + `AccessControlled` base | **Extended** |
| Payments | Razorpay | Razorpay live adapter + deterministic test adapter | Extended |

---

## B. Changed authorization architecture

**Planned.** Role → capability → scope → policy → approval.

**Implemented.** The same conceptual model, expanded into **eleven ordered, individually-traced
gates** in `authorization/engine.ts`:

1. capability catalog → 2. identity status → 3. membership → 4. **tenant boundary** →
5. **emergency lockdown** → 6. **agent state and tool allowlist** → 7. capability held →
8. scope → 9. **scope constraints** → 10. **agent limits** → 11. policies

Gates 4, 5, 6, 9 and 10 were not in the original plan. Each returns a step in an evaluation
trace, which is what makes a denial explainable to the user rather than an opaque 403.

**Additions beyond plan:**

- **Fail-closed everywhere.** Unknown scope type, unknown rule type, unknown capability, absent
  scopes, malformed time window — all deny. Asserted by unit tests rather than assumed.
- **Collection queries** (`query: true`) recorded as `SCOPE_CHECK: DEFERRED`, with row-level
  filtering at the call site. The trace never implies a check that did not occur.
- **Pure/impure split.** `engine.ts` and `policy.ts` are pure functions with no I/O, so they are
  unit-testable without a database. `authorizationService.ts` holds the I/O half.
- **`check` vs `enforce`.** `check` returns a decision without auditing (used by the permission
  simulator); `enforce` audits *before* throwing on denial, so a refusal can never be lost.
- **Permission simulator** — "what would happen if X tried Y?" answered without doing it.

---

## C. Changed AI architecture

**Planned.** AI → RAG → structured action → Tool Gateway → authorization.

**Implemented.** The same flow, with the gateway split into **seven explicitly separated steps**
so that a hallucinated tool, a compromised agent reaching for an ungranted tool, and a
well-formed but over-limit call are *distinguishable in the audit trail*. Collapsing them would
lose the ability to tell those three incidents apart.

**Additions beyond plan:**

- **Explainable additive risk scoring** (`agentOrchestrator.classifyRisk`) — deliberately simple
  so a reviewer can reconstruct any score by hand. Risk **informs**; it never decides.
- **Capabilities and tools as separate containment layers.** A tool is unusable unless the agent
  holds both the tool grant *and* the capability behind it.
- **Agents receive their own DID and identity row**, never their owner's permissions.
- **Escalation guard:** an administrator cannot grant an agent a capability the administrator
  does not hold.
- **Argument schemas are `.strict()`** — unknown keys are rejected, not ignored, so
  `bypassApproval: true` fails rather than being silently dropped.
- **Audit redaction:** long free-text arguments are truncated before entering an audit payload,
  so injected text cannot later be read as fact by an operator or another model.

---

## D. Changed blockchain implementation

**Planned.** One `TrustWeaveRegistry` contract.

**Implemented.** Five contracts — `AccessControlled` (base), `IdentityRegistry`,
`AssetRegistry`, `AgentRegistry`, `ProofRegistry`.

**Why split.** A single contract would have coupled identity, asset and proof state into one
pause switch and one upgrade surface. Separating them means freezing asset operations during an
incident does not also halt proof anchoring, and the proof registry can be genuinely
append-only while the asset registry remains mutable.

**Deliberate design decisions worth stating:**

- **`AssetRegistry` is not ERC-721.** No `approve`, no `setApprovalForAll`, no `transferFrom`.
  These assets are organizationally controlled; inheriting ERC-721 would hand every holder an
  unconditional transfer and silently defeat the entire authorization model. The *absence* of
  those functions is asserted as a test.
- **Two-tier privilege.** `admin` governs; `writer` (the backend key) records facts only. A
  leaked backend key can write junk but cannot pause, appoint writers, or re-govern — it cannot
  disable the switch that would contain the incident.
- **Commitments only.** No DID string, name, email, amount, vendor or metadata body ever reaches
  the chain. Agent capability *sets* are stored as a commitment rather than a list, so the chain
  does not advertise which credential is worth stealing.
- **Terminal revocation** for identities, assets and agents — a compromised key is never
  resurrected.
- **Two-step admin handover** so a mistyped address cannot brick governance permanently.

---

## E. Changed database architecture

33 tables, replacing the baseline's payments-only schema. Notable structural decisions:

- **Org-wide audit hash chain.** The baseline chained per-payment-intent, which meant deleting an
  intent removed its entire chain with no trace. The chain is now organization-wide.
- **Policies are versioned and immutable once `ACTIVE`.** Editing creates a new version, so a
  past decision can always be explained by the rules in force at the time.
- **Sessions store a permission snapshot for forensics but it is never trusted** — permissions
  are recomputed live on every request.
- **Credentials stored as SHA-256 hashes only.** Private keys and agent tokens are returned once
  and are not recoverable.
- **Field naming:** `payment_intents.state` (not `status`) — this inconsistency caused a real
  500 and is now pinned by a schema regression test.

---

## F. Changed frontend routing

**Planned/baseline.** 12 flat screens on a hash router, no route guards.

**Implemented.** **28 addressable routes** on React Router 6, every guarded route declaring its
required capability explicitly.

> **Correction to a previously reported figure.** An earlier progress note said "27 routes". The
> actual count extracted from `App.jsx` is **28 addressable routes** plus 2 redirects (`/` and
> `*`), i.e. 30 `<Route>` elements. The correct figure is 28 and is used throughout the final
> documentation.

**Additions beyond plan:**

- **A denial panel that renders the engine's full evaluation trace.** A 403 explains *which gate
  failed and why* instead of saying "Forbidden". This turns the security model into something a
  user and an auditor can read.
- **Five distinct render states** per data surface — loading, empty, error, **denied**, success.
  Denied is deliberately not folded into error: a 403 is a *result*, not a failure.
- **Route guards are explicitly documented as presentation, not security**, in code comments and
  in the PDFs. Every guarded route's endpoints are enforced independently server-side.

---

## G. Changed testing strategy

**Planned.** A test matrix of ~10 scenarios.

**Implemented.** 183 backend tests across 11 suites, plus 36 contract tests.

| Suite | Tests | Purpose |
|---|---|---|
| `authorization.e2e` | 30 | Role/scope/capability denials over HTTP |
| `payments.e2e` | 21 | Lifecycle, approval, idempotency, webhook signatures |
| `ai-safety.e2e` | 21 | Injection, RAG filtering, agent freeze, strict args |
| `tenancy.e2e` | 22 | Cross-tenant isolation, session resolution, direct URL access |
| `regressions` | 23 | Pinned defects from this rebuild |
| `unit` | 33 | Pure logic: hashing, DID, scope, policy, time windows |
| `audit.e2e` | 16 | Chain integrity, tamper detection, proof verification |
| `demo-scenarios.e2e` | 7 | Cases A/B/C end to end |
| `contract` | 1 | Every endpoint the frontend calls, and its field names |

**Strategy additions beyond plan:**

- **An API contract test** that calls every endpoint the frontend uses and asserts field names.
  This caught two real bugs (a 500 and an undefined capability) that no unit test would have.
- **Tests go through HTTP via `app.inject`**, not direct service calls, because the claim being
  tested is "the API cannot be made to do this", not "the function returns DENY when called
  correctly".
- **Per-suite isolated databases**, because chain-verification tests are meaningless if another
  suite appends concurrently.
- **A source-scanning regression test** that parses route files and proves no route enforces a
  capability the catalog does not define.

---

## H. Improvements made during implementation

Each was driven by a concrete failure, not speculation.

### Explicitly requested for documentation

1. **Prompt-injection extraction fixes.** Three defects in the mock extractor: the invoice regex
   matched the literal word "invoice" (`INV` + `oice`); money transfers were classified as
   lookups; and first-match-wins selected the injected verb phrase "bypass the approval
   threshold" as the vendor. **Consequence before the fix:** injected requests produced malformed
   proposals that died at schema validation. That looked like a successful security block but
   meant the authorization engine was never consulted — the demo proved nothing.
2. **Candidate scoring for proper-noun merchant selection.** Vendor names in this domain are
   proper nouns; candidates that are mostly lowercase are sentence fragments. Scoring by
   capitalisation ratio, corporate suffix and pattern specificity keeps the real payee intact so
   the engine gets to refuse it on the record.
3. **Incomplete proposal handling.** The orchestrator now refuses to dispatch a proposal missing
   required fields and says so explicitly, so a parse failure can never again masquerade as a
   policy denial.
4. **Offline Solidity compilation.** A `TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD` override points
   Hardhat at the npm `solc` WASM build. Contract tests went from *documented as unverifiable* to
   **36 actually passing**. Also useful for any air-gapped CI.
5. **Exact compiler pinning.** solc 0.8.24 is resolved from `node_modules` rather than whatever a
   remote version list returns.
6. **Capability catalog correction.** `INTEGRATION_READ` was enforced by a route but never
   defined, so the engine rejected it as unknown and the page was unreachable for everyone
   including Admin.
7. **Payment `state`/`status` correction.** The dashboard queried a non-existent column — a hard
   500 on the primary landing page for every role.
8. **Scope normalisation.** Scopes were written with `departmentId` while the fail-closed matcher
   read `departmentIds`, silently denying every department-scoped actor everything. Now
   canonicalised and validated at write time, so a bad selector fails loudly at configuration
   rather than failing closed at request time.
9. **Fail-closed authorization matcher.** A malformed time window threw inside the engine,
   surfacing as HTTP 500 — the worst outcome available, because the caller cannot distinguish a
   denial from a check that never ran.
10. **Timezone-aware policy evaluation.** Windows were evaluated in server-local time, so a
    window written as business hours IST silently meant those hours in UTC.
11. **Additional regression tests.** 23 tests pinning each defect by name.
12. **Increased backend test count.** From a baseline with no meaningful coverage to 183.
13. **Real-EVM contract verification.** 36 behavioural tests, not a syntax check.

### Additional improvements not previously listed

14. **`PAYMENT_CREATE` enforced at draft creation** (finding F-01). The Auditor — whose defining
    guarantee is zero mutations — could write payment drafts. No execution path existed, but it
    contradicted the role's invariant and let any session place records in front of an approver.
15. **Approval resource hydration** (F-09). Approvals were evaluated against a bare `{type, id}`
    with no department, so no department-scoped approver ever matched a scope and **only an
    org-wide Admin could approve anything** — delegated approval was effectively broken.
16. **Agent freeze semantics** (F-11). Freezing suspended the underlying identity, blocking the
    credential at the door and reducing the audit record to "inactive identity" — losing which
    tool the frozen agent reached for, exactly the forensic detail an incident review needs.
    Freeze now leaves the identity active so the engine records an explicit `AGENT_FROZEN`
    denial. Revocation remains terminal.
17. **Identity directory row-level filtering.** Replaced an all-or-nothing gate; a plain User now
    sees their own department, never the whole organization.
18. **Org-wide User scope removed.** The demo seed granted the `User` role an organization-wide
    scope, making departmental isolation nominal rather than real.
19. **Agent vendor restriction moved from scope to policy.** Which *resources* an agent may touch
    is a scope question; which *vendors* it may pay is a business rule. Putting it in scope made
    the two conflict.
20. **Agent limits reconfigured** so the approval band is reachable — `transactionLimit` equalled
    `approvalThreshold`, so the band between them was empty and everything above the threshold
    hard-denied. The approval path was untestable.
21. **`.gitignore` added and tracked `.env` removed** (F-02). Nothing sensitive had leaked, but
    the next developer to add a real key would have committed it.
22. **`.env.example` regenerated** (F-03) from the variables the code actually reads, with
    `SERVER-ONLY SECRET` marked inline. The old file documented `DATABASE_URL`, `REDIS_URL` and a
    Drizzle/Postgres swap that no longer exists.
23. **Idempotent payment creation** via client key or derived minute-bucket hash, closing a
    double-click duplicate gap in the baseline.
24. **Webhook amount/currency cross-check** — a validly-signed webhook whose amount disagrees
    with the intent is a CRITICAL security event, not a success.
25. **Raw-body signature verification** — re-serialising parsed JSON is not byte-identical, so
    verifying against it would reject every legitimate delivery.
26. **Self-lockout guard** preventing an admin suspending their own identity.
27. **Rate limiting keyed by credential**, not IP, so agents behind one egress address do not
    throttle each other.
28. **Live-key guard** — the Razorpay live adapter refuses any key not prefixed `rzp_test_`.

### Added during final pre-submission hardening

29. **Static tenant-predicate guard** (`tests/tenant-guard.test.ts`). Scans every SQL statement in
    the backend and fails the build if a `SELECT` on a tenant-scoped table does not constrain the
    tenant. It found three real defects on first run (below) that 171 passing tests had not.
30. **Approval idempotency scoped to the tenant** — the dedupe window previously spanned
    organizations.
31. **Payment idempotency keys namespaced per organization** — previously a global `UNIQUE`, so
    one tenant's client key could collide with another's.
32. **Unscoped security-event read-back fixed** — latent, not live, but one refactor from real.
33. **Executed payments record and expose their adapter.** `provider_adapter` is persisted and the
    API returns `simulated: true | false | null`. Previously nothing distinguished a payment
    executed against the deterministic local provider from one that moved real money, and the UI
    said "Sent to the provider" either way.
34. **Mobile navigation drawer** below the `lg` breakpoint, with Escape-to-close, focus management
    and focus return. Desktop markup is unchanged.
35. **Accessibility pass** — `role="status"`/`role="alert"` on async and error surfaces,
    `aria-hidden` on decorative icons, keyboard-operable table rows, visible focus rings,
    `scope="col"` headers, and contrast raised on body text that used `text-slate-400`.
36. **Deterministic demo script** (`backend/scripts/demo.sh`) — resets and reseeds, and runs the
    admin control-plane scenario **last** because it creates governing configuration that
    otherwise constrains the payment scenarios. An earlier version failed for exactly that
    reason.
37. **`POSTGRES_RLS_MIGRATION.md`** — the migration specified rather than hand-waved, clearly
    marked NOT IMPLEMENTED.
38. **Seed refuses to run when `NODE_ENV=production`** — it creates shared-password accounts and
    prints private keys.

---

## I. Removed / deferred features

**Removed deliberately:**

- **Drizzle ORM and `better-sqlite3`** — the only native dependency, and it broke installation.
- **Redis / BullMQ** — the webhook path is synchronous and idempotent; a queue added operational
  weight without addressing a demonstrated problem.
- **`docker-compose.yml`, `SUBMISSION.md`, `AUDIT_AND_ROADMAP.md`** — all described a
  Drizzle/Postgres/Redis architecture that no longer exists. Left in place they would have
  contradicted the implementation, which is worse than absent documentation.
- **Dedicated vector database** — replaced by a local hashing embedder. The security boundary
  does not depend on embedding quality.

**Deferred, and honestly so:**

- **Postgres with RLS** (limitation L-1) — the correct production hardening step.
- **Role inheritance** — flat capability sets, by choice: inheritance makes effective-permission
  reasoning harder to audit, and the permission simulator answers those questions directly.
- **Refunds** — specified in the plan's admin navigation, not implemented.
- **Access-request workflow** (user requests a permission, admin grants) — not implemented.
- **Deployment to a public testnet** — the EVM adapter is implemented and the deploy script
  handles all four registries, but no live deployment was performed. Default runs use the
  in-memory chain, and every simulated receipt carries `simulated: true`.
- **Semantic embeddings, real LLM by default** — both are configuration switches, not code
  changes.

---

## J. Deviations a reviewer should specifically note

1. **Supabase is not used.** Documentation referencing Supabase Auth or RLS does not describe
   this system.
2. **Isolation is application-enforced, not database-enforced.**
3. **The frontend route count is 28**, not 27.
4. **The default runtime is fully simulated** for chain, payments and AI. This is surfaced in the
   UI as `SIMULATED` vs `LIVE` rather than hidden.
5. **Gate ordering means the first failing gate is the reported reason.** An over-limit payment to
   a blocklisted vendor reports `LIMIT_EXCEEDED`, not the blocklist. Both gates were verified to
   fire independently; this is a reporting-order property, not a gap. Ordering was left unchanged
   because cheaper checks legitimately precede expensive ones.
