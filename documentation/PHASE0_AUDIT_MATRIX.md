# Phase 0 — Repository Audit & Requirements-to-Code Matrix

Baseline inspected: `trustweave-monorepo` (83 files, 2,247 LOC backend, 12 frontend screens,
1 Solidity contract, 50 backend tests claimed).

## 0.1 What the baseline actually is

The existing repo implements **one vertical slice**: *an AI agent proposes a payment, a
deterministic policy engine evaluates it, a contract anchors the decision hash, Razorpay
(mock) executes, a hash-chained audit log records it.*

It is a good slice. It is also **not the product described in the v3.0 specifications**.
The v3.0 PRD/SRD describe an *organizational trust platform* — identity, RBAC + capability +
scope + policy, NFT-backed digital assets, an Admin Control Plane, four role workspaces, an
AI Tool Gateway, and an approval service — in which governed payments are **one module of
nine**.

Concretely, the baseline has **no concept of a user**. There is no login, no session, no
organization, no role, no capability, no scope, no department, no asset, no NFT, no admin
plane. `config/auth.ts` is a single shared `x-api-key` string for the entire system. The
"policy engine" is a payment-amount checker, not the multi-dimensional authorization engine
in SRD §5.

## 0.2 Verified state of the baseline

| Check | Result |
|---|---|
| Backend installs | ❌ **Fails.** `better-sqlite3@13` requires node-gyp compilation; prebuilt binary download is blocked in this environment and no prebuilt exists for Node 22.22. |
| Backend tests run | ❌ Blocked by the above (cannot reach `npm test`). |
| Frontend installs/builds | ✅ Pure-JS dependency tree. |
| Contracts compile | ❌ `solc` binary download unavailable in sandbox (documented, not a code defect). |
| Secrets committed | ✅ Clean — `backend/.env` contains only `DATABASE_URL`. |
| Frontend-only authorization | ⚠️ N/A — there is no authorization to enforce; every screen is reachable. |

**Decision:** replace `better-sqlite3` + Drizzle with a thin repository layer over Node's
built-in `node:sqlite` (Node ≥ 22.5). This removes the only native-compilation dependency in
the project, which is the difference between "clones and runs" and "clones and fails on
`npm install`". Rationale recorded in the Delta Report.

## 0.3 Requirements-to-code matrix

Legend: **REUSE** = kept, possibly refactored · **EXTEND** = kept as a component of something
larger · **NEW** = did not exist.

### PRD §5 — Core functional modules

| Requirement | Current code | Gap | Action |
|---|---|---|---|
| 5.1 Identity & DID management | — none — | Total | **NEW** `auth/did.ts`, `services/identityService.ts`, `identities`/`memberships` tables, did:key + Ed25519 challenge-response |
| 5.2 Role & capability management | — none — | Total | **NEW** `services/roleService.ts`, `capabilityService.ts`, 44-capability catalog |
| 5.3 Resource scope management | — none — | Total | **NEW** `authorization/scope.ts`, `scopes`/`role_scopes`/`agent_scopes` |
| 5.4 Policy engine | `services/policyEngine.ts` — payment-only, fixed fields | Not versioned, not condition-driven, payment-coupled | **EXTEND** → `authorization/policy.ts` JSON rule DSL + `policies` table with versions |
| 5.5 Digital asset / NFT | — none — | Total | **NEW** `services/assetService.ts`, `AssetRegistry.sol`, asset lifecycle + provenance |
| 5.6 AI agent management | `services/agentService.ts` — name/status/policyId only | No DID, capabilities, scopes, tools, limits, freeze | **EXTEND** |
| 5.7 RAG knowledge layer | `services/ragService.ts` — chunking + retrieval | **No access filtering** (spec-critical) | **EXTEND** → scope-filtered retrieval |
| 5.8 PayIntent & Razorpay | `paymentService.ts`, `razorpayClient.ts`, `webhooks.ts` | Mock-only client; no capability/scope; client-trusted amount | **REUSE + harden** |
| 5.9 Audit & proof | `auditService.ts` (hash chain), `proofService.ts` | Scoped to payment intents only | **EXTEND** → org-wide canonical events |

### PRD §6 — Authorization model

| Requirement | Current | Action |
|---|---|---|
| Permission tuple (actor+role+capability+scope+policy+context) | Absent | **NEW** `authorization/engine.ts` |
| Reason codes (SRD §5) | 7 payment codes | **EXTEND** to full SRD set incl. `SCOPE_MISMATCH`, `AGENT_FROZEN`, `SESSION_INVALID` |
| ALLOW / DENY / REQUIRE_APPROVAL | APPROVE/BLOCK/HUMAN_APPROVAL | **REFACTOR** to spec vocabulary |

### PRD §8 / Frontend §6 — Admin Control Plane

Dashboard, Identity & Access, Roles, Capabilities, Scopes, Policies, Assets, Agents,
Approvals, Payments, Audit & Proof, Organization, Security. **All NEW** — zero coverage.

### Frontend §5 — Role workspaces

Admin / Manager / Auditor / User workspaces + role router. **All NEW.** Baseline has one
flat, unauthenticated console.

### SRD §3 — Service decomposition

| Service | Baseline | Action |
|---|---|---|
| API Gateway | Fastify + single shared key | **REFACTOR** → session auth + per-agent tokens |
| Identity / Authorization / Policy / Approval / Proof services | Absent | **NEW** |
| Asset / Agent / Payment / Audit / RAG / Blockchain adapter | Partial | **EXTEND** |
| Tool Gateway | Absent | **NEW** — spec-critical |

### Reusable assets carried forward

`utils/hash.ts` (canonical stringify + sha256) · audit hash-chain construction ·
`blockchainAdapter` interface + memory/viem split · `llm/providerFactory` + forced-tool-call
extraction · Razorpay HMAC webhook verification · `TrustWeaveRegistry.sol` (becomes
`AgentRegistry.sol`) · RAG chunking · eval harness shape.

## 0.4 Ordered gap list driving Phases 1-10

1. Data layer rewrite (removes native build) — **blocking everything**
2. Identity/DID + challenge auth + sessions + tenancy
3. Capability catalog, roles, scopes, versioned policies
4. Central authorization engine + effective permissions
5. Canonical org-wide audit + proof anchoring
6. Asset/NFT lifecycle + contracts
7. Agent identity, tool allowlist, Tool Gateway, freeze
8. Scope-filtered RAG + structured proposals + injection defense
9. Payment hardening (server-derived amounts, idempotency, reconciliation)
10. Full frontend: public flow, role router, 5 workspaces, Admin Control Center
11. Test matrix + E2E
