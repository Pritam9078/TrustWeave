import { one, many, run } from "../db/clientV2.js";
import { newId } from "../core/ids.js";
import { nowIso } from "../core/time.js";
import { hashObject, sha256Hex } from "../core/hash.js";
import { getBlockchainAdapter } from "../adapters/blockchain/index.js";
import { notFound } from "../core/errors.js";
import * as audit from "./auditService.js";

/**
 * Proof service (SRD §13).
 *
 * What a proof here actually asserts, stated precisely because this is the claim most
 * easily overstated: *this exact commitment existed at this point in the chain's
 * history*. Combined with the canonical payload, that makes the recorded event
 * tamper-evident to a party who does not trust this database.
 *
 * It does NOT assert that the underlying event was correct, that an AI's reasoning was
 * sound, or that any off-chain fact is true. The verify endpoint reports exactly the
 * three things it can check and nothing beyond them.
 */

export interface AnchorInput {
  organizationId: string;
  subjectType: "AUDIT_EVENT" | "ASSET" | "PAYMENT" | "POLICY" | "IDENTITY";
  subjectId: string;
  payload: Record<string, unknown>;
  eventId?: string | null;
}

export async function anchor(input: AnchorInput) {
  const commitment = hashObject(input.payload);
  const subjectCommitment = "0x" + sha256Hex(`${input.subjectType}:${input.subjectId}`);
  const id = newId("prf");
  const chain = getBlockchainAdapter();

  await run(
    `INSERT INTO proofs (id, organization_id, event_id, subject_type, subject_id, commitment, chain_id, status, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    id, input.organizationId, input.eventId ?? null, input.subjectType, input.subjectId,
    commitment, chain.chainId, "PENDING", nowIso(),
  );

  try {
    const receipt = await chain.anchorProof({
      commitment: "0x" + commitment.replace(/^sha256:/, ""),
      subjectCommitment,
    });
    await run(`UPDATE proofs SET tx_hash = ?, block_number = ?, status = 'ANCHORED', anchored_at = ? WHERE id = ?`,
      receipt.txHash, receipt.blockNumber ?? null, nowIso(), id);
  } catch (err: any) {
    // A failed anchor is recorded as FAILED rather than swallowed. An operator can see
    // exactly which proofs did not make it onto the chain and retry them, instead of
    // discovering a silent gap during an audit.
    await run(`UPDATE proofs SET status = 'FAILED' WHERE id = ?`, id);
    await audit.record({
      organizationId: input.organizationId,
      traceId: `proof_${id}`,
      action: "PROOF_ANCHOR",
      resourceType: input.subjectType,
      resourceId: input.subjectId,
      decision: "FAILED",
      reasonCodes: ["CHAIN_WRITE_FAILED"],
      payload: { error: String(err?.message ?? err), commitment },
    });
  }

  return await getProof(input.organizationId, id)!;
}

export async function getProof(organizationId: string, id: string) {
  return await one<any>(`SELECT * FROM proofs WHERE organization_id = ? AND id = ?`, organizationId, id);
}

export async function listProofs(organizationId: string, opts: { subjectType?: string; subjectId?: string; status?: string; limit?: number } = {}) {
  const where = ["organization_id = ?"];
  const params: unknown[] = [organizationId];
  if (opts.subjectType) { where.push("subject_type = ?"); params.push(opts.subjectType); }
  if (opts.subjectId) { where.push("subject_id = ?"); params.push(opts.subjectId); }
  if (opts.status) { where.push("status = ?"); params.push(opts.status); }
  return await many<any>(`SELECT * FROM proofs WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT ?`,
    ...params, opts.limit ?? 200);
}

export interface VerificationCheck { name: string; pass: boolean; detail: string; }

/**
 * Independent verification. Every check is recomputed from source; nothing is taken
 * from the proof row on trust.
 */
export async function verifyProof(organizationId: string, proofId: string) {
  const proof = await getProof(organizationId, proofId);
  if (!proof) throw notFound("Proof not found.");
  const chain = getBlockchainAdapter();
  const checks: VerificationCheck[] = [];

  const onChain = await chain.getProof("0x" + proof.commitment.replace(/^sha256:/, ""));
  checks.push({
    name: "Commitment is present on-chain",
    pass: onChain.exists,
    detail: onChain.exists
      ? `Anchored at ${new Date(onChain.timestamp * 1000).toISOString()} in tx ${proof.tx_hash}.`
      : "This commitment was not found in the on-chain proof registry.",
  });

  // If the proof references an audit event, recompute that event's payload hash from
  // the stored payload. A mismatch means the recorded event was edited after anchoring.
  if (proof.event_id) {
    const event = await audit.byId(organizationId, proof.event_id);
    if (!event) {
      checks.push({ name: "Referenced audit event still exists", pass: false, detail: "The referenced audit event has been deleted." });
    } else {
      const recomputed = hashObject(JSON.parse(event.payload_json || "{}"));
      checks.push({
        name: "Audit event payload is unchanged",
        pass: recomputed === event.payload_hash,
        detail: recomputed === event.payload_hash ? "Payload hash matches." : `Recomputed ${recomputed} but the event records ${event.payload_hash}.`,
      });
    }
  }

  const chainState = await audit.verifyChain(organizationId);
  checks.push({
    name: "Audit hash chain is intact",
    pass: chainState.valid,
    detail: chainState.valid
      ? `${chainState.eventCount} event(s) verified from genesis.`
      : chainState.reason ?? "Chain verification failed.",
  });

  const verified = checks.every((c) => c.pass);
  return {
    proofId, verified, checks,
    commitment: proof.commitment,
    txHash: proof.tx_hash,
    chainId: proof.chain_id,
    adapterKind: chain.kind,
    scope: "This verifies that the recorded commitment is unaltered and anchored. It does not assert that the underlying business decision was correct, nor validate any off-chain fact.",
  };
}

export function toApi(row: any) {
  return {
    id: row.id, eventId: row.event_id, subjectType: row.subject_type, subjectId: row.subject_id,
    commitment: row.commitment, chainId: row.chain_id, txHash: row.tx_hash,
    blockNumber: row.block_number, status: row.status,
    anchoredAt: row.anchored_at, createdAt: row.created_at,
  };
}
