import { one, many, run, tx, j } from "../db/client.js";
import { newId } from "../core/ids.js";
import { nowIso } from "../core/time.js";
import { notFound } from "../core/errors.js";
import { scopeMatches, type ScopeRecord } from "../authorization/scope.js";
import { loadScopesForActor } from "./authorizationService.js";
import type { ActorContext } from "../authorization/types.js";

/**
 * RAG knowledge layer (PRD §5.7, SRD §9).
 *
 * The security-critical property here is that **retrieval itself is authorized**.
 * The baseline retrieved from a flat corpus, which meant a Finance agent could pull an
 * HR-only document into its context simply because the document existed in the vector
 * store — and once text is in the context window, no downstream check can un-see it.
 *
 * Filtering happens in two stages, and the order matters:
 *   1. a SQL pre-filter, so unauthorized rows never load into memory at all;
 *   2. a scope-matcher post-filter reusing the *same* `scopeMatches` function the
 *      authorization engine uses, so "who can see this document" can never drift away
 *      from "who can act on this resource".
 *
 * Embeddings: a deterministic local hashing embedder is used by default so the demo has
 * no external dependency. It is genuinely weaker than a trained model at semantic
 * similarity — that limitation is stated rather than hidden. The access-control
 * property, which is the part that matters for the spec, is entirely independent of
 * embedding quality.
 */

const EMBEDDING_DIM = 256;

/** Deterministic bag-of-hashed-tokens embedding with sublinear term weighting. */
export function embed(text: string): number[] {
  const vec = new Array(EMBEDDING_DIM).fill(0);
  const tokens = text.toLowerCase().match(/[a-z0-9][a-z0-9'-]{1,}/g) ?? [];
  const counts = new Map<string, number>();
  for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);

  for (const [token, count] of counts) {
    let h = 2166136261;
    for (let i = 0; i < token.length; i++) { h ^= token.charCodeAt(i); h = Math.imul(h, 16777619); }
    const idx = Math.abs(h) % EMBEDDING_DIM;
    vec[idx] += 1 + Math.log(count);
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) dot += a[i] * b[i];
  return dot; // both vectors are pre-normalised
}

export function chunkText(text: string, maxChars = 900): string[] {
  const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = "";
  for (const p of paragraphs) {
    if ((current + "\n\n" + p).length > maxChars && current) { chunks.push(current); current = p; }
    else current = current ? `${current}\n\n${p}` : p;
  }
  if (current) chunks.push(current);
  return chunks.length ? chunks : [text.slice(0, maxChars)];
}

export interface IngestInput {
  organizationId: string;
  sourceType: string;
  title: string;
  content: string;
  departmentId?: string | null;
  classification?: "PUBLIC" | "INTERNAL" | "RESTRICTED";
  scope?: Record<string, unknown>;
  requiredCapability?: string | null;
  uri?: string | null;
  /** The policy this document restates. Enables staleness detection — see evidenceFreshness. */
  sourcePolicyKey?: string | null;
}

/** Hash of the currently ACTIVE version of a policy, or null if there is no active version. */
function activePolicyHash(organizationId: string, policyKey: string): string | null {
  const row = one<any>(
    `SELECT hash FROM policies WHERE organization_id = ? AND policy_key = ? AND status = 'ACTIVE'
     ORDER BY version DESC LIMIT 1`,
    organizationId, policyKey,
  );
  return row?.hash ?? null;
}

export function ingest(input: IngestInput) {
  const id = newId("doc");
  const ts = nowIso();
  const chunks = chunkText(input.content);
  // Captured at ingest, deliberately not resolved lazily at read time: the point is to
  // detect that the world moved after this text was written.
  const policyHash = input.sourcePolicyKey
    ? activePolicyHash(input.organizationId, input.sourcePolicyKey)
    : null;

  tx(() => {
    run(
      `INSERT INTO documents (id, organization_id, source_type, title, uri, department_id, classification, scope_json, required_capability, version, status, content, source_policy_key, source_policy_hash, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, input.organizationId, input.sourceType, input.title, input.uri ?? null,
      input.departmentId ?? null, input.classification ?? "INTERNAL",
      j.enc(input.scope ?? {}), input.requiredCapability ?? null, 1, "INDEXED", input.content,
      input.sourcePolicyKey ?? null, policyHash, ts, ts,
    );
    chunks.forEach((content, ordinal) => {
      run(`INSERT INTO document_chunks (id, document_id, ordinal, content, embedding_json, created_at) VALUES (?,?,?,?,?,?)`,
        newId("chunk"), id, ordinal, content, j.enc(embed(content)), ts);
    });
  });

  return getDocument(input.organizationId, id)!;
}

export function getDocument(organizationId: string, id: string) {
  return one<any>(`SELECT * FROM documents WHERE organization_id = ? AND id = ?`, organizationId, id);
}

export function listDocuments(organizationId: string, opts: { sourceType?: string; classification?: string } = {}) {
  const where = ["d.organization_id = ?"];
  const params: unknown[] = [organizationId];
  if (opts.sourceType) { where.push("d.source_type = ?"); params.push(opts.sourceType); }
  if (opts.classification) { where.push("d.classification = ?"); params.push(opts.classification); }
  return many<any>(
    `SELECT d.*, (SELECT COUNT(*) FROM document_chunks c WHERE c.document_id = d.id) AS chunk_count
     FROM documents d WHERE ${where.join(" AND ")} ORDER BY d.created_at DESC`,
    ...params,
  );
}

export function deleteDocument(organizationId: string, id: string) {
  const doc = getDocument(organizationId, id);
  if (!doc) throw notFound("Document not found.");
  tx(() => {
    run(`DELETE FROM document_chunks WHERE document_id = ?`, id);
    run(`DELETE FROM documents WHERE id = ?`, id);
  });
}

export interface RetrievedChunk {
  documentId: string;
  chunkId: string;
  title: string;
  sourceType: string;
  classification: string;
  content: string;
  score: number;
  /** The policy this chunk's document restates, and that policy's hash captured at
   *  ingest. Null when the document does not claim to restate a policy. Carried on the
   *  chunk so a caller holding only chunks can assess freshness without another query. */
  policyKey: string | null;
  policyHash: string | null;
}

export interface RetrievalResult {
  chunks: RetrievedChunk[];
  /** Diagnostics: how many candidates were removed by access filtering, and why.
   *  Surfaced in the AI evidence panel so a reviewer can see the filter working
   *  rather than having to take it on faith. */
  filtered: { totalDocuments: number; accessibleDocuments: number; excluded: { documentId: string; title: string; reason: string }[] };
}

/**
 * Retrieve for a specific actor. There is no unfiltered variant of this function —
 * an actor is required, so it is not possible to accidentally call a "retrieve
 * everything" path from an agent context.
 */
export function retrieveForActor(actor: ActorContext, query: string, limit = 5): RetrievalResult {
  const scopes: ScopeRecord[] = loadScopesForActor(actor);

  // Stage 1: SQL pre-filter. RESTRICTED documents require an explicit capability;
  // department-owned documents require the actor to be in that department or to hold
  // an organization-wide scope.
  const allDocs = many<any>(`SELECT * FROM documents WHERE organization_id = ? AND status = 'INDEXED'`, actor.organizationId);
  const excluded: { documentId: string; title: string; reason: string }[] = [];
  const accessible: any[] = [];

  const hasOrgWideScope = scopes.some((s) => s.scopeType === "ORGANIZATION");

  for (const doc of allDocs) {
    if (doc.required_capability && !actor.capabilities.has(doc.required_capability)) {
      excluded.push({ documentId: doc.id, title: doc.title, reason: `Requires capability ${doc.required_capability}.` });
      continue;
    }
    if (doc.classification === "RESTRICTED" && !actor.capabilities.has("KNOWLEDGE_MANAGE")) {
      excluded.push({ documentId: doc.id, title: doc.title, reason: "RESTRICTED classification." });
      continue;
    }
    if (doc.department_id && !hasOrgWideScope && doc.department_id !== actor.departmentId) {
      excluded.push({ documentId: doc.id, title: doc.title, reason: "Belongs to another department." });
      continue;
    }

    // Stage 2: the document's own scope selector, matched with the same matcher the
    // authorization engine uses.
    const docScope = j.dec<Record<string, any>>(doc.scope_json, {});
    if (docScope && Object.keys(docScope).length > 0) {
      const descriptor = {
        type: "DOCUMENT",
        id: doc.id,
        organizationId: doc.organization_id,
        departmentId: doc.department_id,
        collectionId: null,
        vendor: docScope.vendor ?? null,
      };
      const permitted = scopes.some((s) => scopeMatches(s, descriptor));
      if (!permitted) {
        excluded.push({ documentId: doc.id, title: doc.title, reason: "Outside every assigned resource scope." });
        continue;
      }
    }
    accessible.push(doc);
  }

  if (accessible.length === 0) {
    return { chunks: [], filtered: { totalDocuments: allDocs.length, accessibleDocuments: 0, excluded } };
  }

  const ids = accessible.map((d) => d.id);
  const placeholders = ids.map(() => "?").join(",");
  const chunks = many<any>(`SELECT * FROM document_chunks WHERE document_id IN (${placeholders})`, ...ids);
  const byDoc = new Map(accessible.map((d) => [d.id, d]));
  const queryVec = embed(query);

  const scored = chunks
    .map((c) => {
      const doc = byDoc.get(c.document_id)!;
      return {
        documentId: c.document_id,
        chunkId: c.id,
        title: doc.title,
        sourceType: doc.source_type,
        classification: doc.classification,
        policyKey: doc.source_policy_key ?? null,
        policyHash: doc.source_policy_hash ?? null,
        content: c.content,
        score: cosine(queryVec, j.dec<number[]>(c.embedding_json, [])),
      };
    })
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return {
    chunks: scored,
    filtered: { totalDocuments: allDocs.length, accessibleDocuments: accessible.length, excluded },
  };
}

/**
 * Detect instruction-shaped text inside retrieved content.
 *
 * This is a *reporting* control, not a security boundary — it exists so the UI and the
 * audit trail can flag "this document tried to talk to the model", and so a security
 * event is raised for a human to look at. The actual containment is that retrieved text
 * only ever reaches a forced-tool-call schema whose output is re-authorized server-side.
 * A pattern list would be trivially evaded on its own; it is not load-bearing here.
 */
const INJECTION_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /ignore (all |any |the )?(previous|prior|above)? ?(instructions|rules|policy)/i, label: "instruction override" },
  { pattern: /you are now (an? )?(admin|administrator|root|superuser)/i, label: "role reassignment" },
  { pattern: /\b(approve|authorize|execute) (this|it|the payment) (immediately|now|without)/i, label: "self-authorization" },
  { pattern: /disregard (the )?(policy|limit|threshold|approval)/i, label: "policy bypass" },
  { pattern: /system prompt|<\/?(system|instructions)>/i, label: "prompt boundary spoofing" },
  { pattern: /do not (log|audit|record)/i, label: "audit evasion" },
  { pattern: /raise (the |your )?(limit|threshold)/i, label: "limit escalation" },
];

export function detectInjection(text: string): { detected: boolean; labels: string[]; excerpts: string[] } {
  const labels: string[] = [];
  const excerpts: string[] = [];
  for (const { pattern, label } of INJECTION_PATTERNS) {
    const m = pattern.exec(text);
    if (m) {
      labels.push(label);
      excerpts.push(text.slice(Math.max(0, m.index - 40), m.index + m[0].length + 40).trim());
    }
  }
  return { detected: labels.length > 0, labels: [...new Set(labels)], excerpts };
}

export interface StaleEvidence {
  documentId: string;
  title: string;
  policyKey: string;
  capturedHash: string | null;
  currentHash: string | null;
  reason: string;
}

export interface FreshnessResult {
  fresh: boolean;
  checked: number;
  stale: StaleEvidence[];
}

/**
 * Evidence freshness.
 *
 * Policies here are versioned and immutable once ACTIVE — editing one creates a new
 * version. A knowledge-base document that restates a policy's rules therefore has a
 * shelf life: the moment the policy is re-versioned, the document may describe limits,
 * thresholds or vendor lists that no longer apply.
 *
 * That matters because retrieved evidence is what an agent reasons over when it forms a
 * proposal. Stale evidence does not let the agent DO anything it could not otherwise do —
 * the authorization engine still evaluates the live policy, so a stale-evidence proposal
 * that breaches current rules is refused like any other. What stale evidence produces is
 * a confidently-argued proposal citing rules that were repealed, which is a bad thing to
 * put in front of a human approver who may reasonably trust the citation.
 *
 * Fails closed on an indeterminate answer: a document whose governing policy has no ACTIVE
 * version at all is treated as stale, not as fresh-by-default.
 */
export function evidenceFreshness(organizationId: string, documentIds: string[]): FreshnessResult {
  const unique = [...new Set(documentIds)].filter(Boolean);
  if (!unique.length) return { fresh: true, checked: 0, stale: [] };

  const placeholders = unique.map(() => "?").join(",");
  const docs = many<any>(
    `SELECT id, title, source_policy_key, source_policy_hash FROM documents
     WHERE organization_id = ? AND id IN (${placeholders})`,
    organizationId, ...unique,
  );

  const stale: StaleEvidence[] = [];
  let checked = 0;

  for (const doc of docs) {
    // A document that does not claim to restate a policy cannot go stale against one.
    if (!doc.source_policy_key) continue;
    checked++;

    const current = activePolicyHash(organizationId, doc.source_policy_key);

    if (current === null) {
      stale.push({
        documentId: doc.id, title: doc.title, policyKey: doc.source_policy_key,
        capturedHash: doc.source_policy_hash, currentHash: null,
        reason: `Policy "${doc.source_policy_key}" has no active version, so this document's rules cannot be confirmed to be in force.`,
      });
      continue;
    }

    if (doc.source_policy_hash !== current) {
      stale.push({
        documentId: doc.id, title: doc.title, policyKey: doc.source_policy_key,
        capturedHash: doc.source_policy_hash, currentHash: current,
        reason: `Policy "${doc.source_policy_key}" has been re-versioned since this document was ingested; it may describe rules that no longer apply.`,
      });
    }
  }

  return { fresh: stale.length === 0, checked, stale };
}

/**
 * Boolean freshness check over already-retrieved chunks.
 *
 * A thin projection of `evidenceFreshness` for callers that hold chunks rather than
 * document ids and want a yes/no answer. Two things worth knowing before using it:
 *
 * 1. It compares every chunk against ONE expected hash, so it is only meaningful when
 *    the evidence set relates to a single governing policy. Mixed evidence — an invoice
 *    plus a procurement policy plus a vendor notice — will report stale for any chunk
 *    whose policy is not the one you named. `evidenceFreshness` resolves each document's
 *    own governing policy and is the right call for a mixed set.
 * 2. It collapses the per-document reason to a boolean. The 409 payload and the evidence
 *    panel both render those reasons, so prefer `evidenceFreshness` where a human will
 *    read the result.
 *
 * Fails closed: an absent or empty expected hash means freshness cannot be established,
 * which is treated as stale rather than as fresh-by-default.
 */
export function isEvidenceFresh(chunks: RetrievedChunk[], currentPolicyHash: string): boolean {
  if (!currentPolicyHash) return false;

  for (const chunk of chunks) {
    // A chunk that never claimed to restate a policy cannot go stale against one.
    if (!chunk.policyKey) continue;
    // No hash captured at ingest, or a hash that has since diverged.
    if (!chunk.policyHash || chunk.policyHash !== currentPolicyHash) return false;
  }
  return true;
}

/** Hash of the ACTIVE version of a policy, for callers pairing with isEvidenceFresh. */
export function currentPolicyHash(organizationId: string, policyKey: string): string | null {
  return activePolicyHash(organizationId, policyKey);
}

export function toApiDocument(row: any) {
  return {
    sourcePolicyKey: row.source_policy_key ?? null,
    id: row.id, sourceType: row.source_type, title: row.title, uri: row.uri,
    departmentId: row.department_id, classification: row.classification,
    scope: j.dec(row.scope_json, {}), requiredCapability: row.required_capability,
    version: row.version, status: row.status, chunkCount: row.chunk_count ?? null,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}
