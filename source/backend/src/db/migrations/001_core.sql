-- TrustWeave v3.0 core schema.
-- Implements the SRD §7 table list. Naming follows the SRD; JSON-shaped columns are
-- stored as TEXT (they become native jsonb on Postgres without a shape change).
--
-- Tenancy rule enforced throughout: every row that can be read by a user carries an
-- organization_id, and every repository query filters on it. Tenant isolation is a
-- WHERE clause on the data layer, not a check in a route handler.

CREATE TABLE IF NOT EXISTS organizations (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  slug          TEXT NOT NULL UNIQUE,
  status        TEXT NOT NULL DEFAULT 'ACTIVE',      -- ACTIVE | SUSPENDED
  settings_json TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS departments (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  name            TEXT NOT NULL,
  code            TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  UNIQUE (organization_id, code)
);

-- Identities cover humans, AI agents and service principals alike. An AI agent is
-- not a special kind of row bolted onto users; it is an identity with kind='AGENT'
-- that goes through exactly the same authorization pipeline.
CREATE TABLE IF NOT EXISTS identities (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  did             TEXT NOT NULL UNIQUE,
  public_key      TEXT,                                -- base64url Ed25519, null for password-only demo identities
  kind            TEXT NOT NULL DEFAULT 'HUMAN',       -- HUMAN | AGENT | SERVICE
  display_name    TEXT NOT NULL,
  email           TEXT,
  status          TEXT NOT NULL DEFAULT 'PENDING',     -- PENDING | ACTIVE | SUSPENDED | REVOKED
  chain_tx_hash   TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  revoked_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_identities_org ON identities(organization_id);
CREATE INDEX IF NOT EXISTS idx_identities_email ON identities(email);

-- Password material is separated from the identity row so an accidental
-- `SELECT * FROM identities` in a log line can never print a hash.
CREATE TABLE IF NOT EXISTS credentials (
  identity_id   TEXT PRIMARY KEY REFERENCES identities(id),
  password_hash TEXT NOT NULL,
  salt          TEXT NOT NULL,
  algo          TEXT NOT NULL DEFAULT 'scrypt',
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memberships (
  id              TEXT PRIMARY KEY,
  identity_id     TEXT NOT NULL REFERENCES identities(id),
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  department_id   TEXT REFERENCES departments(id),
  status          TEXT NOT NULL DEFAULT 'ACTIVE',      -- ACTIVE | SUSPENDED
  created_at      TEXT NOT NULL,
  UNIQUE (identity_id, organization_id)
);

CREATE TABLE IF NOT EXISTS roles (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  name            TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  version         INTEGER NOT NULL DEFAULT 1,
  is_system       INTEGER NOT NULL DEFAULT 0,          -- system roles cannot be deleted
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (organization_id, name)
);

-- The capability catalog is global and immutable at runtime: capabilities are the
-- vocabulary of the authorization engine, so they are seeded from code (see
-- authorization/capabilities.ts) rather than being user-editable. Roles are what
-- organizations compose; capabilities are what the system understands.
CREATE TABLE IF NOT EXISTS capabilities (
  id            TEXT PRIMARY KEY,
  action        TEXT NOT NULL UNIQUE,
  resource_type TEXT NOT NULL,
  domain        TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  is_privileged INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS role_capabilities (
  role_id       TEXT NOT NULL REFERENCES roles(id),
  capability_id TEXT NOT NULL REFERENCES capabilities(id),
  PRIMARY KEY (role_id, capability_id)
);

CREATE TABLE IF NOT EXISTS membership_roles (
  membership_id TEXT NOT NULL REFERENCES memberships(id),
  role_id       TEXT NOT NULL REFERENCES roles(id),
  assigned_by   TEXT,
  assigned_at   TEXT NOT NULL,
  PRIMARY KEY (membership_id, role_id)
);

-- A scope answers "where does this capability apply?". selector_json is matched
-- against the resource descriptor at authorization time (see authorization/scope.ts).
CREATE TABLE IF NOT EXISTS scopes (
  id               TEXT PRIMARY KEY,
  organization_id  TEXT NOT NULL REFERENCES organizations(id),
  name             TEXT NOT NULL,
  scope_type       TEXT NOT NULL,                      -- ORGANIZATION | DEPARTMENT | COLLECTION | RESOURCE | VENDOR
  selector_json    TEXT NOT NULL DEFAULT '{}',
  constraints_json TEXT NOT NULL DEFAULT '{}',         -- optional maxAmount / timeWindow
  created_at       TEXT NOT NULL,
  UNIQUE (organization_id, name)
);

CREATE TABLE IF NOT EXISTS role_scopes (
  role_id  TEXT NOT NULL REFERENCES roles(id),
  scope_id TEXT NOT NULL REFERENCES scopes(id),
  PRIMARY KEY (role_id, scope_id)
);

-- Scopes attached directly to one person's membership. This is what lets two people
-- hold the same "Manager" role while being confined to different departments —
-- without minting a FinanceManager / HRManager role pair for every department.
CREATE TABLE IF NOT EXISTS membership_scopes (
  membership_id TEXT NOT NULL REFERENCES memberships(id),
  scope_id      TEXT NOT NULL REFERENCES scopes(id),
  PRIMARY KEY (membership_id, scope_id)
);

-- Policies are versioned and immutable once ACTIVE. Editing an active policy creates
-- a new version row; the old row stays so an audit event recorded under v3 can still
-- be replayed against the exact conditions that were in force at the time.
CREATE TABLE IF NOT EXISTS policies (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  policy_key      TEXT NOT NULL,                       -- stable identity across versions
  name            TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  version         INTEGER NOT NULL DEFAULT 1,
  conditions_json TEXT NOT NULL DEFAULT '{}',
  applies_to_json TEXT NOT NULL DEFAULT '{}',
  status          TEXT NOT NULL DEFAULT 'DRAFT',       -- DRAFT | ACTIVE | DISABLED | SUPERSEDED
  hash            TEXT NOT NULL,
  chain_tx_hash   TEXT,
  created_by      TEXT,
  created_at      TEXT NOT NULL,
  activated_at    TEXT,
  UNIQUE (organization_id, policy_key, version)
);
CREATE INDEX IF NOT EXISTS idx_policies_org_status ON policies(organization_id, status);

CREATE TABLE IF NOT EXISTS asset_collections (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  name            TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL,
  UNIQUE (organization_id, name)
);

CREATE TABLE IF NOT EXISTS assets (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  department_id   TEXT REFERENCES departments(id),
  collection_id   TEXT REFERENCES asset_collections(id),
  name            TEXT NOT NULL,
  asset_type      TEXT NOT NULL,
  -- Private metadata stays off-chain. metadata_ref is an opaque pointer, metadata_hash
  -- is the commitment that goes on-chain. Neither reveals the contents.
  metadata_ref    TEXT,
  metadata_json   TEXT NOT NULL DEFAULT '{}',
  metadata_hash   TEXT NOT NULL,
  nft_token_id    TEXT,
  owner_did       TEXT,
  status          TEXT NOT NULL DEFAULT 'DRAFT',       -- DRAFT | MINTED | ACTIVE | FROZEN | REVOKED
  chain_tx_hash   TEXT,
  created_by      TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assets_org ON assets(organization_id);
CREATE INDEX IF NOT EXISTS idx_assets_owner ON assets(owner_did);

CREATE TABLE IF NOT EXISTS asset_events (
  id         TEXT PRIMARY KEY,
  asset_id   TEXT NOT NULL REFERENCES assets(id),
  event_type TEXT NOT NULL,                            -- CREATED | MINTED | ASSIGNED | TRANSFERRED | FROZEN | UNFROZEN | REVOKED
  from_did   TEXT,
  to_did     TEXT,
  actor_id   TEXT,
  trace_id   TEXT,
  tx_hash    TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}',
  timestamp  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_asset_events_asset ON asset_events(asset_id);

CREATE TABLE IF NOT EXISTS agents (
  id                 TEXT PRIMARY KEY,
  organization_id    TEXT NOT NULL REFERENCES organizations(id),
  identity_id        TEXT NOT NULL REFERENCES identities(id),
  name               TEXT NOT NULL,
  owner_identity_id  TEXT REFERENCES identities(id),
  department_id      TEXT REFERENCES departments(id),
  status             TEXT NOT NULL DEFAULT 'REGISTERED', -- REGISTERED | ACTIVE | FROZEN | REVOKED
  limits_json        TEXT NOT NULL DEFAULT '{}',
  token_hash         TEXT,
  freeze_reason      TEXT,
  frozen_by          TEXT,
  frozen_at          TEXT,
  chain_tx_hash      TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  UNIQUE (organization_id, name)
);

CREATE TABLE IF NOT EXISTS agent_capabilities (
  agent_id      TEXT NOT NULL REFERENCES agents(id),
  capability_id TEXT NOT NULL REFERENCES capabilities(id),
  PRIMARY KEY (agent_id, capability_id)
);

CREATE TABLE IF NOT EXISTS agent_scopes (
  agent_id TEXT NOT NULL REFERENCES agents(id),
  scope_id TEXT NOT NULL REFERENCES scopes(id),
  PRIMARY KEY (agent_id, scope_id)
);

-- Tool allowlist. Separate from capabilities on purpose: a capability says what the
-- agent may cause to happen, a tool says which callable surface it may reach. An agent
-- can hold PAYMENT_CREATE and still be denied create_payment_intent if the tool is not
-- allowlisted, which is the containment layer for a compromised agent credential.
CREATE TABLE IF NOT EXISTS agent_tools (
  agent_id  TEXT NOT NULL REFERENCES agents(id),
  tool_name TEXT NOT NULL,
  PRIMARY KEY (agent_id, tool_name)
);

CREATE TABLE IF NOT EXISTS agent_tool_calls (
  id            TEXT PRIMARY KEY,
  agent_id      TEXT NOT NULL REFERENCES agents(id),
  trace_id      TEXT NOT NULL,
  tool_name     TEXT NOT NULL,
  args_json     TEXT NOT NULL DEFAULT '{}',
  decision      TEXT NOT NULL,
  reason_codes  TEXT NOT NULL DEFAULT '[]',
  result_ref    TEXT,
  latency_ms    INTEGER,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tool_calls_agent ON agent_tool_calls(agent_id);

CREATE TABLE IF NOT EXISTS payment_intents (
  id                  TEXT PRIMARY KEY,
  organization_id     TEXT NOT NULL REFERENCES organizations(id),
  actor_identity_id   TEXT NOT NULL REFERENCES identities(id),
  agent_id            TEXT REFERENCES agents(id),
  department_id       TEXT REFERENCES departments(id),
  raw_request         TEXT,
  merchant            TEXT,
  merchant_ref        TEXT,
  -- amount is always the server-derived value. The client-supplied number is kept in
  -- raw_request only, never promoted into this column without re-derivation.
  amount              REAL,
  currency            TEXT NOT NULL DEFAULT 'INR',
  purpose             TEXT,
  invoice_ref         TEXT,
  evidence_json       TEXT NOT NULL DEFAULT '[]',
  state               TEXT NOT NULL DEFAULT 'DRAFT',
  decision            TEXT,
  reason_codes        TEXT NOT NULL DEFAULT '[]',
  policy_id           TEXT,
  policy_version      INTEGER,
  approval_id         TEXT,
  idempotency_key     TEXT,
  provider_order_id   TEXT,
  provider_payment_id TEXT,
  provider_state      TEXT,
  provider_adapter    TEXT,   -- 'test' | 'live' — which adapter actually executed this
  failure_reason      TEXT,
  trace_id            TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pi_org ON payment_intents(organization_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_payment_intents_org_idem
  ON payment_intents (organization_id, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_pi_agent ON payment_intents(agent_id);
CREATE INDEX IF NOT EXISTS idx_pi_state ON payment_intents(state);

CREATE TABLE IF NOT EXISTS approvals (
  id               TEXT PRIMARY KEY,
  organization_id  TEXT NOT NULL REFERENCES organizations(id),
  request_type     TEXT NOT NULL,                      -- PAYMENT | ASSET_TRANSFER | ROLE_ASSIGN
  request_id       TEXT NOT NULL,
  requested_by     TEXT NOT NULL,
  reason           TEXT NOT NULL DEFAULT '',
  required_capability TEXT NOT NULL,
  evidence_json    TEXT NOT NULL DEFAULT '{}',
  policy_id        TEXT,
  policy_version   INTEGER,
  status           TEXT NOT NULL DEFAULT 'PENDING',    -- PENDING | APPROVED | REJECTED | EXPIRED
  approver_id      TEXT,
  decision_note    TEXT,
  decided_at       TEXT,
  trace_id         TEXT,
  created_at       TEXT NOT NULL,
  UNIQUE (request_type, request_id)
);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(organization_id, status);

-- Canonical audit event (SRD §13). Hash-chained per organization: each event's hash
-- incorporates the previous event's hash, so deleting or editing any row breaks every
-- hash after it. Carried forward from the baseline's per-intent chain and widened to
-- the whole organization, which closes the gap where deleting an entire intent's
-- events left no trace.
CREATE TABLE IF NOT EXISTS audit_events (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  seq             INTEGER NOT NULL,
  trace_id        TEXT NOT NULL,
  actor_id        TEXT,
  actor_did       TEXT,
  actor_kind      TEXT NOT NULL DEFAULT 'HUMAN',
  action          TEXT NOT NULL,
  resource_type   TEXT NOT NULL,
  resource_id     TEXT,
  decision        TEXT NOT NULL,                       -- ALLOW | DENY | REQUIRE_APPROVAL | EXECUTED | FAILED | INFO
  reason_codes    TEXT NOT NULL DEFAULT '[]',
  policy_id       TEXT,
  policy_version  INTEGER,
  approval_id     TEXT,
  execution_ref   TEXT,
  payload_json    TEXT NOT NULL DEFAULT '{}',
  payload_hash    TEXT NOT NULL,
  prev_event_hash TEXT NOT NULL,
  event_hash      TEXT NOT NULL,
  ip              TEXT,
  timestamp       TEXT NOT NULL,
  UNIQUE (organization_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_audit_org_ts ON audit_events(organization_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_events(actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_resource ON audit_events(resource_type, resource_id);
CREATE INDEX IF NOT EXISTS idx_audit_trace ON audit_events(trace_id);

CREATE TABLE IF NOT EXISTS proofs (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  event_id        TEXT REFERENCES audit_events(id),
  subject_type    TEXT NOT NULL,                       -- AUDIT_EVENT | ASSET | PAYMENT | POLICY | IDENTITY
  subject_id      TEXT NOT NULL,
  commitment      TEXT NOT NULL,
  chain_id        TEXT,
  tx_hash         TEXT,
  block_number    INTEGER,
  status          TEXT NOT NULL DEFAULT 'PENDING',     -- PENDING | ANCHORED | FAILED
  anchored_at     TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_proofs_subject ON proofs(subject_type, subject_id);

-- RAG corpus. scope_json carries the same selector shape as scopes.selector_json, so
-- retrieval filtering reuses the authorization scope matcher rather than inventing a
-- second, divergent notion of "who can see this".
CREATE TABLE IF NOT EXISTS documents (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  source_type     TEXT NOT NULL,                       -- POLICY | VENDOR | INVOICE | ASSET | PROCEDURE | HR
  title           TEXT NOT NULL,
  uri             TEXT,
  department_id   TEXT REFERENCES departments(id),
  classification  TEXT NOT NULL DEFAULT 'INTERNAL',    -- PUBLIC | INTERNAL | RESTRICTED
  scope_json      TEXT NOT NULL DEFAULT '{}',
  required_capability TEXT,
  version         INTEGER NOT NULL DEFAULT 1,
  status          TEXT NOT NULL DEFAULT 'INDEXED',     -- PENDING | INDEXED | FAILED
  -- Evidence freshness. A document that restates the rules of a governing policy is only
  -- trustworthy while that policy version is still in force. We record which policy the
  -- document was written against and the hash of that policy AT INGEST TIME; if the
  -- policy is later re-versioned, the hashes diverge and the evidence is provably stale.
  source_policy_key  TEXT,
  source_policy_hash TEXT,
  content         TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

-- Supabase pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS document_chunks (
  id            TEXT PRIMARY KEY,
  document_id   TEXT NOT NULL REFERENCES documents(id),
  ordinal       INTEGER NOT NULL,
  content       TEXT NOT NULL,
  embedding     vector(256),
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chunks_doc ON document_chunks(document_id);

CREATE TABLE IF NOT EXISTS sessions (
  id             TEXT PRIMARY KEY,
  identity_id    TEXT NOT NULL REFERENCES identities(id),
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  token_hash     TEXT NOT NULL UNIQUE,
  snapshot_json  TEXT NOT NULL DEFAULT '{}',           -- effective-permission snapshot, revalidated per request
  issued_at      TEXT NOT NULL,
  expires_at     TEXT NOT NULL,
  revoked_at     TEXT,
  user_agent     TEXT,
  ip             TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_identity ON sessions(identity_id);

CREATE TABLE IF NOT EXISTS auth_challenges (
  id         TEXT PRIMARY KEY,
  did        TEXT NOT NULL,
  nonce      TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_challenges_did ON auth_challenges(did);

CREATE TABLE IF NOT EXISTS security_events (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  kind            TEXT NOT NULL,
  severity        TEXT NOT NULL DEFAULT 'MEDIUM',      -- LOW | MEDIUM | HIGH | CRITICAL
  actor_id        TEXT,
  summary         TEXT NOT NULL,
  detail_json     TEXT NOT NULL DEFAULT '{}',
  acknowledged_at TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sec_org ON security_events(organization_id, created_at);

-- Org-wide kill switches. Checked by the authorization engine before anything else,
-- so flipping one takes effect on the very next request without a redeploy or a
-- cache flush.
CREATE TABLE IF NOT EXISTS emergency_flags (
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  flag_key        TEXT NOT NULL,                       -- AGENTS_DISABLED | PAYMENTS_DISABLED | MINTING_DISABLED
  enabled         INTEGER NOT NULL DEFAULT 0,
  reason          TEXT,
  actor_id        TEXT,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (organization_id, flag_key)
);

CREATE TABLE IF NOT EXISTS webhook_events (
  id              TEXT PRIMARY KEY,
  provider        TEXT NOT NULL,
  provider_event_id TEXT,
  event_type      TEXT NOT NULL,
  signature_valid INTEGER NOT NULL DEFAULT 0,
  payload_json    TEXT NOT NULL,
  payment_intent_id TEXT,
  processed_at    TEXT,
  outcome         TEXT,
  created_at      TEXT NOT NULL,
  UNIQUE (provider, provider_event_id)
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  name       TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);
