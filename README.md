# TrustWeave

**Verifiable identity, authorization, digital assets and governed AI actions.**

> Authenticate the identity. Authorize the action. Verify the asset. Prove everything.

Every actor — human or AI — holds a cryptographically verifiable identity, and every
consequential action is decided by a server-side authorization engine before anything happens.
The engine evaluates capability, resource scope, policy, agent limits and approval requirements
in a fixed order and returns an explainable trace.

The central commitment is one sentence: **AI proposes, the authorization engine decides.** A
model's output is a typed proposal with no authority of its own. The only path from a proposal to
a domain service is the Tool Gateway, which re-authorizes from scratch.

| | |
|---|---|
| Backend tests | **183 passing** across 11 suites |
| Smart-contract tests | **36 passing** on a real in-process EVM |
| Solidity | **0 errors, 0 warnings** (solc 0.8.24, pinned) |
| Frontend build | Clean — 306 kB JS / 87 kB gzipped |
| Routes / endpoints | 28 frontend routes · 85 backend endpoints |

---

## Architecture

```
Frontend (React 18 + Vite + React Router 6)
        |  Bearer session token — no role/capability headers exist
        v
Backend (Fastify + TypeScript)
  routes/         validate (zod .strict) -> authz.enforce -> service
  authorization/  11-gate engine + policy DSL   (pure, no I/O)
  services/       identity, org, policy, asset, agent, payment, approval,
                  audit, proof, rag, toolGateway, orchestrator
  adapters/       blockchain | razorpay | llm      (ports, swappable)
  db/             node:sqlite via a thin repository layer
        |
        +--> EVM registries: Identity | Asset | Agent | Proof
```

**The eleven gates**, in order: capability catalog → identity status → membership → tenant
boundary → emergency lockdown → agent state and tool allowlist → capability held → scope → scope
constraints → agent limits → policies. Every gate returns a step in an evaluation trace, which is
what lets a refusal explain itself instead of showing a bare 403.

### Two deviations from the original specification

The plan called for Supabase and PostgreSQL with row-level security. **Neither is used.**

- **Authentication** is implemented directly as Ed25519 DID challenge/response. There is no
  Supabase SDK anywhere in this repository.
- **Storage** is Node's built-in SQLite (`node:sqlite`, Node ≥ 22.5). The baseline could not
  install at all — `better-sqlite3@13` needs node-gyp with no prebuilt binary for Node 22.22 —
  and removing it removed the only native compilation step in the project.

**What the second deviation costs, stated plainly:** there is **no database-level RLS**. Tenant
isolation is enforced in the application, by a dedicated `TENANT_BOUNDARY` gate plus
`organization_id` predicates on every query. A future query that forgets its predicate would not
be caught by the database. It is covered by 22 cross-tenant tests, and migrating to Postgres with
RLS is the correct production hardening step. See `SECURITY_REVIEW.md` §B and `DELTA_REPORT.md`
§A.

---

## Prerequisites

| Requirement | Version | Why |
|---|---|---|
| **Node.js** | **≥ 22.5** (tested on 22.22) | `node:sqlite` is a core module from 22.5 |
| npm | ≥ 10 | Package scripts |
| A modern browser | Chrome 137+ / Firefox 129+ / Safari 17+ | Web Crypto Ed25519 for DID sign-in |

No database server, no Redis, no Docker. Nothing else to install.

> **Supabase is not required.** If you are following a document that asks you to create a Supabase
> project, that document describes the original plan rather than this implementation.

---

## Quick start

```bash
# 1. Backend
cd backend
cp .env.example .env          # works as-is; every value has a default
npm install
npm run db:migrate
npm run db:seed               # prints demo credentials — read this output
npm run dev                   # http://localhost:4000

# 2. Frontend (second terminal)
cd frontend
cp .env.example .env
npm install
npm run dev                   # http://localhost:5173
```

Open http://localhost:5173 and sign in with any account printed by the seed.

The system runs **fully end to end with an empty `.env`**: SQLite for storage, an in-memory chain,
a deterministic payment provider and a rule-based proposal extractor. Adding real credentials
swaps each adapter for its live counterpart with no code change.

---

## Environment variables

### Public — safe to expose

Everything in a Vite `VITE_*` variable is compiled into the browser bundle and is therefore
public. **No secret may ever be placed there.** The frontend holds no API keys and calls no third
party directly.

| Variable | Location | Default |
|---|---|---|
| `VITE_API_BASE_URL` | `frontend/.env` | `http://localhost:4000` |

### Server-only — never commit, never send to the browser

| Variable | Purpose | Notes |
|---|---|---|
| `LLM_API_KEY` | Anthropic API key | **SECRET.** Only when `LLM_PROVIDER=anthropic` |
| `RAZORPAY_KEY_SECRET` | Razorpay secret | **SECRET.** Test keys only |
| `RAZORPAY_WEBHOOK_SECRET` | Webhook HMAC secret | **SECRET.** Required at startup in production |
| `CHAIN_PRIVATE_KEY` | Backend writer key | **SECRET.** Not the contract admin key — keep them separate |
| `SEED_PASSWORD` | Demo account password | Development only |

### Server configuration — not secret

| Variable | Default | Purpose |
|---|---|---|
| `NODE_ENV` | `development` | `production` enables the startup safety guards |
| `PORT` / `HOST` | `4000` / `0.0.0.0` | Listener |
| `DATABASE_FILE` | `./trustweave.db` | A **file path**, not a connection URL |
| `CORS_ORIGIN` | `http://localhost:5173,…` | Wildcard is refused in production |
| `SESSION_TTL_MINUTES` | `480` | Session lifetime |
| `CHALLENGE_TTL_SECONDS` | `120` | DID challenge lifetime |
| `ALLOW_PASSWORD_LOGIN` | `true` | **Server refuses to start with this enabled in production** |
| `LLM_PROVIDER` | `mock` | `mock` \| `anthropic` |
| `RAZORPAY_ADAPTER` | `test` | `test` \| `live` |
| `RAZORPAY_KEY_ID` | — | `rzp_test_…` — the live adapter refuses non-test keys |
| `BLOCKCHAIN_ADAPTER` | `memory` | `memory` \| `evm` |
| `CHAIN_RPC_URL` / `CHAIN_ID` | — | EVM endpoint |
| `*_REGISTRY_ADDRESS` | — | Written by `npm run wire-backend` after a deploy |

**Never commit a populated `.env`.** It is listed in `.gitignore` alongside `*.pem`, `*.key` and
`*.db`.

---

## API keys — what you need for what

**Nothing is required to run the full demo.** Every integration has a working local adapter.

| Integration | Without a key | With a key |
|---|---|---|
| **AI** | Deterministic rule-based extractor producing the same structured proposal shape a live model would | Set `LLM_PROVIDER=anthropic` and `LLM_API_KEY`. Uses a forced tool call, so the output is still a typed proposal |
| **Payments** | Local provider performing **real** HMAC signature verification and **real** idempotency, with no network call | Set `RAZORPAY_ADAPTER=live`, `RAZORPAY_KEY_ID` (`rzp_test_…`), `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` |
| **Blockchain** | In-memory chain enforcing the same invariants as the Solidity contracts; receipts marked `simulated: true` | Deploy the registries, then `npm run wire-backend`. Set `CHAIN_RPC_URL` and `CHAIN_PRIVATE_KEY` |

The Integrations page shows each adapter as `SIMULATED` or `LIVE`, so a reviewer is never left
guessing whether a "successful" payment actually reached a provider.

### Razorpay test setup

1. Create a Razorpay account and stay in **Test Mode**.
2. Copy the test key id (`rzp_test_…`) and secret into `backend/.env`.
3. Create a webhook pointing at `POST /api/webhooks/razorpay`, subscribe to `payment.captured`
   and `payment.failed`, and copy the webhook secret into `RAZORPAY_WEBHOOK_SECRET`.
4. For local development use a tunnel (ngrok or similar) so Razorpay can reach your machine — or
   skip all of this and use the built-in webhook simulator described below.

The live adapter **refuses any key not prefixed `rzp_test_`**. This is deliberate.

---

## Demo accounts

Printed by `npm run db:seed`. Password sign-in is a development convenience; DID
challenge/response is the supported path, and the seed also prints a one-time private key for
each identity.

| Role | Email | Character |
|---|---|---|
| Admin | `admin@northwind.test` | Full control plane |
| Manager | `manager@northwind.test` | Finance only, ₹5,00,000 scope cap |
| Auditor | `auditor@northwind.test` | Read-only — zero mutating capabilities |
| User | `user@northwind.test` | Operations department, own records only |
| Manager | `opsmgr@northwind.test` | Operations only |

Default password: `TrustWeave!2026` (override with `SEED_PASSWORD`).

The seed also creates **FinanceAgent-01** and prints its agent key once. Use it as
`x-agent-key: apk_…`. Its limits: approval required above ₹50,000, hard ceiling ₹2,00,000,
₹5,00,000 per day, 10 calls per day.

### Things worth trying

| Try | Expect |
|---|---|
| Pay Acme Cloud Services ₹38,500 | Allowed outright |
| Pay Globex Logistics ₹92,000 | Requires approval — and you cannot approve your own |
| Pay Sanctioned Holdings Ltd | Denied by policy; approval cannot override it |
| Ask the agent for compensation bands | Withheld by retrieval filtering, with the reason shown |
| Sign in as Auditor, try to change anything | Refused, with the failing gate named |
| Open `/app/admin/simulator` | Ask "what would happen if X tried Y?" without doing it |

---

## Commands

### Backend

```bash
npm run dev          # watch mode
npm run build        # tsc
npm run typecheck    # tsc --noEmit
npm test             # 183 tests across 11 suites
npm run db:migrate
npm run db:seed
npm run db:reset     # delete the database file
```

### Contracts

```bash
npm install
npm test                 # 36 tests on a real in-process EVM
npm run compile:offline  # verify compilation without Hardhat's downloader
npm run node             # local EVM node
npm run deploy:local     # deploy all four registries
npm run wire-backend     # copy addresses into backend/.env
```

#### Offline Solidity compilation

Hardhat downloads solc from `binaries.soliditylang.org`, which is unreachable from locked-down CI
runners and corporate egress allowlists — and when it fails the build dies for reasons unrelated
to the contracts. `hardhat.config.ts` overrides `TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD` to use the
npm `solc` package, which ships the identical compiler as WebAssembly and installs from the normal
registry. This also **pins the exact compiler version** rather than trusting whatever a remote
list resolves to. If `solc` is absent the override defers to Hardhat's normal download path.

`npm run compile:offline` verifies compilation and reports deployed bytecode sizes against the
EIP-170 limit without involving Hardhat at all.

### Frontend

```bash
npm run dev
npm run build
npm run preview
```

---

## Testing the payment flow without a browser checkout

`POST /api/payments/:id/simulate-webhook` generates a **genuinely signed** provider callback and
posts it through the same verification path a real webhook takes. It does not bypass signature
verification, and it is unavailable when the live adapter is active.

To reproduce a provider **retry** (and see idempotency working), pass the `paymentId` returned by
the first call — a fresh id is a genuinely new event and *should* be processed again.

---

## Deploying the contracts

```bash
cd contracts
npx hardhat node                                                # terminal 1
BACKEND_WRITER_ADDRESS=0xYourBackendKey npm run deploy:local     # terminal 2
npm run wire-backend
```

Set `BACKEND_WRITER_ADDRESS` to the address of the key in `CHAIN_PRIVATE_KEY`. **Keep the admin
and writer keys separate.** The admin governs who may write; the writer records facts. If the
backend key leaks, the attacker can write junk records but cannot pause the contracts, appoint
writers, or lock out the admin — which is exactly the containment you want during an incident. The
deploy script warns when both are the same key.

---

## Repository layout

```
backend/     Fastify API, authorization engine, services, adapters, 183 tests
frontend/    React console — 28 routes, role-aware, denial traces rendered
contracts/   4 registries + AccessControlled base, 36 tests, deploy scripts
docs/        The four implemented PDFs and the phase-0 audit matrix
testing/     Raw test-runner output captured from executed runs
```

## Documentation

| Document | Contents |
|---|---|
| `docs/TrustWeave_01_PRD_IMPLEMENTED.pdf` | The product as built: model, workflows, limitations |
| `docs/TrustWeave_02_FRONTEND_IMPLEMENTED.pdf` | Router, workspaces, all 28 routes with capabilities |
| `docs/TrustWeave_03_BACKEND_BLOCKCHAIN_IMPLEMENTED.pdf` | Services, engine, gateway, all 85 endpoints, contracts |
| `docs/TrustWeave_04_SECURITY_AND_TEST_REPORT.pdf` | Findings and executed test evidence |
| `SECURITY_REVIEW.md` | Boundary-by-boundary review with remediation |
| `DELTA_REPORT.md` | Every deviation from the original plan |

## Troubleshooting

| Symptom | Cause |
|---|---|
| `Cannot find module 'node:sqlite'` | Node < 22.5. Upgrade. |
| "This browser does not support Ed25519 signing" | Use Chrome 137+/Firefox 129+/Safari 17+, or the development password path. |
| Cannot reach the API | Check `VITE_API_BASE_URL` and that the backend is on port 4000. |
| `Organization 'northwind' already exists` | Run `npm run db:reset` before re-seeding. |
| Hardhat fails downloading a compiler | Run `npm install` in `contracts/` so the local `solc` package is present. |
| Every request denied for one user | Check their scopes — an actor with no scope matching a resource is refused by design. Use the permission simulator. |
