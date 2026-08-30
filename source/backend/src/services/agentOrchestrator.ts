import { newTraceId } from "../core/ids.js";
import { getLLMProvider } from "../adapters/llm/index.js";
import * as ragService from "./ragService.js";
import * as toolGateway from "./toolGateway.js";
import * as audit from "./auditService.js";
import * as orgService from "./orgService.js";
import type { ActorContext } from "../authorization/types.js";
import type { ProposedAction } from "../adapters/llm/types.js";
import { conflict } from "../core/errors.js";

/**
 * End-to-end AI action flow (PRD §7.4):
 *   intent → scope-filtered RAG → structured proposal → risk classification →
 *   Tool Gateway → authorization → decision.
 *
 * Note what this function does NOT do: it never touches a domain service directly.
 * The only way anything happens is `toolGateway.invoke`, so the model's output cannot
 * reach a mutation except through the full authorization pipeline.
 */

export interface RiskAssessment {
  score: number;              // 0..1
  band: "LOW" | "MEDIUM" | "HIGH";
  factors: { factor: string; weight: number; detail: string }[];
}

/**
 * Explainable risk scoring, kept deliberately simple and additive so a reviewer can
 * reconstruct any score by hand. Risk *informs* — it never decides. A high score does
 * not block anything on its own; the authorization engine does the blocking.
 */
export function classifyRisk(params: {
  proposal: ProposedAction;
  injectionDetected: boolean;
  evidenceCount: number;
}): RiskAssessment {
  const factors: { factor: string; weight: number; detail: string }[] = [];

  if (params.injectionDetected) {
    factors.push({ factor: "PROMPT_INJECTION_SIGNAL", weight: 0.5, detail: "Instruction-shaped text was detected in the request or retrieved evidence." });
  }
  if (params.evidenceCount === 0) {
    factors.push({ factor: "NO_EVIDENCE", weight: 0.25, detail: "No supporting document was retrieved for this proposal." });
  }
  if (params.proposal.confidence < 0.6) {
    factors.push({ factor: "LOW_CONFIDENCE", weight: 0.2, detail: `Model confidence ${params.proposal.confidence.toFixed(2)} is below 0.60.` });
  }
  if (params.proposal.actionType === "CREATE_PAYMENT" && !params.proposal.invoiceRef) {
    factors.push({ factor: "NO_INVOICE_REFERENCE", weight: 0.15, detail: "A payment was proposed with no invoice reference." });
  }
  if (params.proposal.uncertainty) {
    factors.push({ factor: "MODEL_UNCERTAINTY", weight: 0.1, detail: params.proposal.uncertainty });
  }

  const score = Math.min(1, factors.reduce((s, f) => s + f.weight, 0));
  return { score, band: score >= 0.6 ? "HIGH" : score >= 0.3 ? "MEDIUM" : "LOW", factors };
}

export interface RunResult {
  traceId: string;
  instruction: string;
  retrieval: ragService.RetrievalResult;
  freshness: ragService.FreshnessResult;
  proposal: ProposedAction;
  risk: RiskAssessment;
  injection: { detected: boolean; labels: string[]; excerpts: string[] };
  toolCall: toolGateway.ToolCallResult | null;
  note: string;
}

export async function run(actor: ActorContext, instruction: string, opts: { execute?: boolean } = {}): Promise<RunResult> {
  const traceId = newTraceId();

  // 1. Retrieval, filtered by the actor's own scopes.
  const retrieval = ragService.retrieveForActor(actor, instruction, 5);

  // 2. Injection screening across the instruction AND every retrieved chunk. Reporting
  //    only — the containment is structural, further down.
  const corpus = [instruction, ...retrieval.chunks.map((c) => c.content)].join("\n");
  const injection = ragService.detectInjection(corpus);
  if (injection.detected) {
    orgService.recordSecurityEvent({
      organizationId: actor.organizationId, kind: "PROMPT_INJECTION_DETECTED", severity: "HIGH",
      actorId: actor.identityId,
      summary: `Instruction-shaped content detected (${injection.labels.join(", ")}). The proposal was still evaluated by the authorization engine, which is unaffected by it.`,
      detail: { labels: injection.labels, excerpts: injection.excerpts },
    });
  }

  // 3. Evidence freshness. Retrieved text that restates a policy is only trustworthy
  //    while that policy version is still in force.
  const freshness = ragService.evidenceFreshness(
    actor.organizationId,
    retrieval.chunks.map((c) => c.documentId),
  );

  if (!freshness.fresh) {
    orgService.recordSecurityEvent({
      organizationId: actor.organizationId, kind: "STALE_RAG_EVIDENCE", severity: "HIGH",
      actorId: actor.identityId,
      summary: `Retrieved evidence cites ${freshness.stale.length} policy document(s) that are no longer current.`,
      detail: { stale: freshness.stale },
    });
    audit.record({
      organizationId: actor.organizationId, traceId,
      actorId: actor.identityId, actorDid: actor.did, actorKind: actor.kind,
      action: "RAG_EVIDENCE_STALE", resourceType: "DOCUMENT",
      decision: "INFO", reasonCodes: ["STALE_RAG_EVIDENCE"],
      payload: { stale: freshness.stale, checked: freshness.checked },
    });
  }

  // 4. Structured proposal. The model's only output channel is a typed schema.
  const llm = getLLMProvider();
  const proposal = await llm.proposeAction({
    instruction,
    evidence: retrieval.chunks.map((c) => ({ id: c.chunkId, title: c.title, content: c.content })),
    allowedTools: actor.agent?.tools ?? [],
  });

  const risk = classifyRisk({ proposal, injectionDetected: injection.detected, evidenceCount: retrieval.chunks.length });

  audit.record({
    organizationId: actor.organizationId, traceId,
    actorId: actor.identityId, actorDid: actor.did, actorKind: actor.kind,
    action: "AI_PROPOSAL", resourceType: "AGENT", resourceId: actor.agent?.id ?? actor.identityId,
    decision: "INFO",
    payload: {
      provider: llm.name,
      actionType: proposal.actionType,
      confidence: proposal.confidence,
      risk: risk.band, riskScore: risk.score,
      injectionDetected: injection.detected, injectionLabels: injection.labels,
      evidenceCount: retrieval.chunks.length,
      documentsExcludedByAccessControl: retrieval.filtered.excluded.length,
    },
  });

  if (!opts.execute || proposal.actionType === "NONE" || proposal.actionType === "LOOKUP") {
    return {
      traceId, instruction, retrieval, freshness, proposal, risk, injection, toolCall: null,
      note: opts.execute
        ? "The proposal did not request a mutating tool; nothing was executed."
        : "Dry run: the proposal was prepared and evaluated but no tool was invoked.",
    };
  }

  // 4. Everything real happens through the gateway.
  const toolName = proposal.requestedTool
    ?? (proposal.actionType === "CREATE_PAYMENT" ? "create_payment_intent" : "request_asset_transfer");

  const args = proposal.actionType === "CREATE_PAYMENT"
    ? {
        merchant: proposal.merchant ?? "",
        amount: proposal.amount ?? 0,
        currency: proposal.currency ?? "INR",
        invoiceRef: proposal.invoiceRef ?? null,
        purpose: proposal.purpose,
        evidenceIds: proposal.evidenceIds.slice(0, 20),
      }
    : {
        assetId: proposal.assetId ?? "",
        newOwnerDid: proposal.newOwnerDid ?? "",
        reason: proposal.purpose,
      };

  // Fail closed before dispatching anything that changes state. A read can tolerate an
  // out-of-date citation; a payment argued from repealed rules should not be placed in
  // front of an approver who may reasonably trust the citation. Reads and dry runs
  // already returned above, so reaching here means the proposal mutates.
  if (!freshness.fresh) {
    throw conflict(
      "STALE_RAG_EVIDENCE",
      "This action was not attempted because the supporting evidence is out of date. "
      + `${freshness.stale.length} retrieved document(s) restate a policy that has since been re-versioned. `
      + "Re-ingest the affected documents so the proposal is argued from the rules currently in force.",
      { traceId, stale: freshness.stale, checked: freshness.checked },
    );
  }

  // An incomplete proposal is a model failure, not a security decision. Dispatching it
  // anyway produces an INVALID_ARGUMENTS denial that *looks* like the authorization
  // engine blocked something dangerous, when in fact the engine was never reached. Stop
  // here instead, and say so plainly.
  const missing = describeMissingFields(proposal.actionType, args);
  if (missing.length) {
    audit.record({
      organizationId: actor.organizationId, traceId,
      actorId: actor.identityId, actorDid: actor.did, actorKind: actor.kind,
      action: "AI_PROPOSAL_INCOMPLETE", resourceType: "AGENT", resourceId: actor.agent?.id ?? actor.identityId,
      decision: "INFO", reasonCodes: ["INCOMPLETE_PROPOSAL"],
      payload: { missing, actionType: proposal.actionType },
    });
    return {
      traceId, instruction, retrieval, freshness, proposal, risk, injection, toolCall: null,
      note: `The proposal was missing ${missing.join(" and ")}, so it was not dispatched. No authorization decision was made because no action was requested.`,
    };
  }

  const toolCall = await toolGateway.invoke({ actor, toolName, args, traceId });

  return {
    traceId, instruction, retrieval, freshness, proposal, risk, injection, toolCall,
    note: `Proposal routed through the Tool Gateway as "${toolName}"; the authorization engine returned ${toolCall.decision}.`,
  };
}

/** Fields a tool cannot run without. Checked before dispatch so a malformed proposal is
 *  reported as such rather than being disguised as a policy denial. */
function describeMissingFields(actionType: ProposedAction["actionType"], args: any): string[] {
  const missing: string[] = [];
  if (actionType === "CREATE_PAYMENT") {
    if (!args.merchant) missing.push("a vendor");
    if (!args.amount || args.amount <= 0) missing.push("an amount");
  }
  if (actionType === "TRANSFER_ASSET") {
    if (!args.assetId) missing.push("an asset");
    if (!args.newOwnerDid) missing.push("a new owner");
  }
  return missing;
}
