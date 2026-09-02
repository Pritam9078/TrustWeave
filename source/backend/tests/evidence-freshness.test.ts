import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHarness, destroyHarness, asUser, asAgent, type Harness } from "./helpers.js";
import * as ragService from "../src/services/ragService.js";

/**
 * Evidence freshness.
 *
 * Policies are versioned and immutable once ACTIVE, so a knowledge-base document that
 * restates a policy's rules has a shelf life. When the policy is re-versioned, the
 * document may describe limits or vendor lists that no longer apply.
 *
 * The threat is narrower than it first appears, and worth stating precisely: stale
 * evidence does not let an agent DO anything it otherwise could not — the authorization
 * engine always evaluates the live policy, so a proposal breaching current rules is
 * refused regardless. What stale evidence produces is a confidently-argued proposal
 * citing repealed rules, placed in front of a human approver who may reasonably trust
 * the citation. These tests cover both halves: the detection, and the refusal to act.
 */

let h: Harness;
beforeAll(async () => { h = await createHarness("freshness"); }, 60_000);
afterAll(async () => { await destroyHarness(h); });

async function ingestPolicyDoc(sourcePolicyKey: string | null, title: string) {
  const res = await asUser(h, "admin")("POST", "/api/knowledge/documents", {
    sourceType: "POLICY_DOC",
    title,
    content: "Payments up to fifty thousand rupees may be executed directly. "
      + "Acme Cloud Services is an approved vendor for cloud hosting spend.",
    classification: "INTERNAL",
    scope: {},
    ...(sourcePolicyKey ? { sourcePolicyKey } : {}),
  });
  expect(res.statusCode).toBe(201);
  return res.json().document.id as string;
}

describe("Freshness is only claimed where it can be established", () => {
  it("treats a document with no governing policy as neither fresh nor stale", async () => {
    const id = await ingestPolicyDoc(null, "Unlinked note");
    const result = await ragService.evidenceFreshness(h.orgId, [id]);
    // Not counted at all: a document that never claimed to restate a policy cannot go
    // stale against one, and pretending otherwise would make the signal meaningless.
    expect(result.checked).toBe(0);
    expect(result.fresh).toBe(true);
  });

  it("reports an empty evidence set as fresh without inventing a check", async () => {
    const result = await ragService.evidenceFreshness(h.orgId, []);
    expect(result).toEqual({ fresh: true, checked: 0, stale: [] });
  });

  it("considers a document fresh while its policy version is unchanged", async () => {
    const id = await ingestPolicyDoc("payment-limits", "Procurement rules v1");
    const result = await ragService.evidenceFreshness(h.orgId, [id]);
    expect(result.checked).toBe(1);
    expect(result.fresh).toBe(true);
    expect(result.stale).toEqual([]);
  });
});

describe("Re-versioning a policy makes its documents stale", () => {
  let docId: string;

  it("detects the divergence and explains it", async () => {
    docId = await ingestPolicyDoc("payment-limits", "Procurement rules pinned to v1");
    expect((await ragService.evidenceFreshness(h.orgId, [docId])).fresh).toBe(true);

    // Author a new version of the governing policy and activate it.
    const bumped = await asUser(h, "admin")("POST", "/api/policies/payment-limits/versions", {
      conditions: { rules: [
        { type: "AMOUNT_MAX", value: 400000, onFail: "DENY" },
        { type: "APPROVAL_THRESHOLD", value: 25000 },
      ] },
      activate: true,
    });
    expect(bumped.statusCode).toBe(201);

    const result = await ragService.evidenceFreshness(h.orgId, [docId]);
    expect(result.fresh).toBe(false);
    expect(result.stale).toHaveLength(1);
    expect(result.stale[0].policyKey).toBe("payment-limits");
    expect(result.stale[0].capturedHash).not.toBe(result.stale[0].currentHash);
    expect(result.stale[0].reason).toMatch(/re-versioned/i);
  });

  it("fails closed on an indeterminate answer rather than defaulting to fresh", async () => {
    // A policy with no ACTIVE version cannot confirm the document's rules are in force.
    const orphan = await ingestPolicyDoc("no-such-policy", "Doc citing a policy that does not exist");
    const result = await ragService.evidenceFreshness(h.orgId, [orphan]);
    expect(result.fresh).toBe(false);
    expect(result.stale[0].currentHash).toBeNull();
    expect(result.stale[0].reason).toMatch(/no active version/i);
  });

  it("does not leak staleness across tenants", async () => {
    // A document id from another organization is simply not found, so it contributes
    // nothing — the scan is tenant-scoped like every other read.
    const result = await ragService.evidenceFreshness(h.orgId, ["doc_from_another_tenant"]);
    expect(result.checked).toBe(0);
    expect(result.fresh).toBe(true);
  });
});

describe("The orchestrator refuses to act on stale evidence", () => {
  it("returns 409 STALE_RAG_EVIDENCE for a mutating proposal", async () => {
    // payment-limits was re-versioned above, so the seeded procurement document that
    // restates it is now stale and will be retrieved for a payment instruction.
    const res = await asAgent(h)("POST", "/api/agents/task", {
      instruction: "Pay Acme Cloud Services 3000 INR for July hosting.",
      execute: true,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("STALE_RAG_EVIDENCE");
    expect(res.json().details.stale.length).toBeGreaterThan(0);
    expect(res.json().message).toMatch(/out of date/i);
  });

  it("executed nothing when it refused", async () => {
    const intents = await asUser(h, "admin")("GET", "/api/payment-intents");
    const live = intents.json().intents.filter((p: any) =>
      ["AUTHORIZED", "EXECUTING", "EXECUTED", "RECONCILED"].includes(p.state));
    expect(live).toEqual([]);
  });

  it("records the staleness as a security event and in the audit trail", async () => {
    const events = await asUser(h, "admin")("GET", "/api/security/events");
    expect(events.json().events.some((e: any) => e.kind === "STALE_RAG_EVIDENCE")).toBe(true);

    const audit = await asUser(h, "auditor")("GET", "/api/audit/events?action=RAG_EVIDENCE_STALE");
    expect(audit.json().events.length).toBeGreaterThan(0);
  });

  it("still allows a dry run, so an operator can inspect what went stale", async () => {
    // A read costs nothing and refusing it would remove the operator's means of
    // diagnosing the problem.
    const res = await asAgent(h)("POST", "/api/agents/task", {
      instruction: "Pay Acme Cloud Services 3000 INR for July hosting.",
      execute: false,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().freshness.fresh).toBe(false);
    expect(res.json().freshness.stale.length).toBeGreaterThan(0);
  });

  it("does not block a pure retrieval tool call", async () => {
    const res = await asAgent(h)("POST", "/api/agents/tools/invoke", {
      tool: "search_knowledge", args: { query: "procurement rules" },
    });
    expect(res.json().decision).toBe("ALLOW");
  });
});

describe("Re-ingesting the document restores freshness", () => {
  it("captures the current policy hash and clears the block", async () => {
    const id = await ingestPolicyDoc("payment-limits", "Procurement rules, re-issued");
    const result = await ragService.evidenceFreshness(h.orgId, [id]);
    expect(result.fresh).toBe(true);
  });
});

describe("isEvidenceFresh — boolean projection over retrieved chunks", () => {
  const chunk = (over: Partial<ragService.RetrievedChunk> = {}): ragService.RetrievedChunk => ({
    documentId: "doc_1", chunkId: "chunk_1", title: "T", sourceType: "POLICY_DOC",
    classification: "INTERNAL", content: "…", score: 1,
    policyKey: null, policyHash: null, ...over,
  });

  it("returns true when every policy-bearing chunk matches the expected hash", () => {
    const chunks = [
      chunk({ policyKey: "payment-limits", policyHash: "hash-a" }),
      chunk({ documentId: "doc_2", policyKey: "payment-limits", policyHash: "hash-a" }),
    ];
    expect(ragService.isEvidenceFresh(chunks, "hash-a")).toBe(true);
  });

  it("ignores chunks that never claimed to restate a policy", () => {
    const chunks = [chunk(), chunk({ documentId: "doc_2" })];
    expect(ragService.isEvidenceFresh(chunks, "hash-a")).toBe(true);
  });

  it("returns false when any chunk has diverged", () => {
    const chunks = [
      chunk({ policyKey: "payment-limits", policyHash: "hash-a" }),
      chunk({ documentId: "doc_2", policyKey: "payment-limits", policyHash: "hash-OLD" }),
    ];
    expect(ragService.isEvidenceFresh(chunks, "hash-a")).toBe(false);
  });

  it("returns false when a policy-bearing chunk captured no hash", () => {
    // Ingested while the policy had no ACTIVE version — freshness was never established.
    expect(ragService.isEvidenceFresh([chunk({ policyKey: "payment-limits", policyHash: null })], "hash-a")).toBe(false);
  });

  it("fails closed on an empty expected hash rather than passing everything", () => {
    expect(ragService.isEvidenceFresh([chunk({ policyKey: "payment-limits", policyHash: "hash-a" })], "")).toBe(false);
  });

  it("agrees with evidenceFreshness on live data", async () => {
    const docId = await ingestPolicyDoc("payment-limits", "Agreement check");
    const live = await ragService.currentPolicyHash(h.orgId, "payment-limits");
    expect(live).toBeTruthy();

    const retrieved = await ragService.retrieveForActor(
      { ...await (await import("../src/services/identityService.js")).buildActorContext(h.ids.admin, h.orgId)! },
      "payments approved vendor", 10,
    );
    const ours = retrieved.chunks.filter((c) => c.documentId === docId);
    expect(ours.length).toBeGreaterThan(0);
    expect(ragService.isEvidenceFresh(ours, live!)).toBe(true);
    expect((await ragService.evidenceFreshness(h.orgId, [docId])).fresh).toBe(true);
  });

  it("carries the policy hash on every retrieved chunk", async () => {
    const docId = await ingestPolicyDoc("payment-limits", "Hash carrier");
    const retrieved = await ragService.retrieveForActor(
      await (await import("../src/services/identityService.js")).buildActorContext(h.ids.admin, h.orgId)!,
      "payments approved vendor", 10,
    );
    const chunks = retrieved.chunks.filter((c) => c.documentId === docId);
    expect(chunks[0].policyKey).toBe("payment-limits");
    expect(chunks[0].policyHash).toBeTruthy();
  });
});
