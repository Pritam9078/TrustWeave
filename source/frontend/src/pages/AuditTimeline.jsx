import React, { useEffect, useState } from "react";
import Shell from "../components/Layout.jsx";
import PageHeader from "../components/PageHeader.jsx";
import { api } from "../lib/api.js";
import { Loader2, Circle, ShieldCheck, ExternalLink } from "lucide-react";

const EVENT_LABEL = {
  REQUEST_SUBMITTED: "User submitted request",
  EVIDENCE_RETRIEVED: "RAG retrieved policy + evidence",
  INTENT_EXTRACTED: "AI created structured payment intent",
  POLICY_EVALUATED: "Policy check evaluated",
  AUTHORIZATION_RECORDED: "Smart contract authorization recorded",
  HUMAN_APPROVAL_DECIDED: "Human approval decision recorded",
  EXECUTION_CREATED: "Razorpay test payment created",
  WEBHOOK_RECEIVED: "Webhook received",
  PROOF_COMMITTED: "Execution proof committed",
  FAILURE: "Failure recorded",
};

function formatTime(iso) {
  try {
    return new Date(iso).toLocaleTimeString("en-IN", { hour12: false });
  } catch {
    return iso;
  }
}

export default function AuditTimeline({ param: intentId }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [verifyResult, setVerifyResult] = useState(null);
  const [verifying, setVerifying] = useState(false);

  useEffect(() => {
    if (!intentId) return;
    let cancelled = false;
    api.getPaymentIntent(intentId).then((d) => !cancelled && setData(d)).catch((err) => !cancelled && setError(err.message));
    return () => { cancelled = true; };
  }, [intentId]);

  async function handleVerify() {
    if (!data?.proof) return;
    setVerifying(true);
    try {
      const result = await api.verifyProof(data.proof.id);
      setVerifyResult(result);
    } catch (err) {
      setError(err.message);
    } finally {
      setVerifying(false);
    }
  }

  if (!intentId) {
    return (
      <Shell active="proof-explorer" crumbs={["Workspace", "Finance ops", "Audit timeline"]}>
        <PageHeader eyebrow="Audit timeline" title="No request selected." subtitle="Pick a request from Proof Explorer or Overview." />
      </Shell>
    );
  }
  if (error) {
    return (
      <Shell active="proof-explorer" crumbs={["Workspace", "Finance ops", "Audit timeline"]}>
        <div className="border border-[#F3CFCF] bg-[#FBEAEA] px-5 py-4 text-[13px] text-[#C4172C]">{error}</div>
      </Shell>
    );
  }
  if (!data) {
    return (
      <Shell active="proof-explorer" crumbs={["Workspace", "Finance ops", "Audit timeline"]}>
        <div className="flex items-center gap-2 text-[13px] text-[#6B6D76]"><Loader2 size={15} className="animate-spin" /> Loading timeline…</div>
      </Shell>
    );
  }

  const { intent, timeline, proof, auditChain } = data;

  return (
    <Shell active="proof-explorer" testMode crumbs={["Workspace", "Finance ops", "Audit timeline"]}>
      <PageHeader
        eyebrow="Payment detail / Audit timeline"
        title={`₹${intent.amount?.toLocaleString("en-IN") ?? "—"} to ${intent.recipient ?? "—"}`}
        subtitle={`Full decision → authorization → payment → verification trail for ${intentId}.`}
      />

      <div className="grid grid-cols-[1.3fr_1fr] gap-5">
        <div className="border border-[#E7E6E2]">
          <div className="px-5 py-4 border-b border-[#E7E6E2] flex items-center justify-between">
            <div>
              <div className="text-[10px] font-mono uppercase tracking-[0.1em] text-[#9A9CA4] mb-1">Timeline</div>
              <div className="text-[15px] font-semibold">{timeline.length} events</div>
            </div>
            {auditChain && (
              <span
                className={[
                  "flex items-center gap-1.5 text-[9.5px] font-mono uppercase tracking-[0.06em] px-2.5 py-1",
                  auditChain.valid ? "border border-[#B7E0C6] bg-[#F0FAF4] text-[#2C6E48]" : "border border-[#C4172C] bg-[#FBEAEA] text-[#C4172C]",
                ].join(" ")}
                title={auditChain.reason ?? "Hash-chain verified: no event has been altered or removed."}
              >
                <ShieldCheck size={11} />
                {auditChain.valid ? "Chain intact" : `Tampered at #${auditChain.brokenAtSeq}`}
              </span>
            )}
          </div>
          <div className="p-5">
            {timeline.map((event, i) => (
              <div key={event.id} className={`flex items-start gap-3 pb-4 ${i !== timeline.length - 1 ? "mb-4 border-b border-[#F0EFEC]" : ""}`}>
                <Circle size={9} className="text-[#C4172C] fill-[#C4172C] mt-1 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-[13px] text-[#14151A]">{EVENT_LABEL[event.eventType] ?? event.eventType}</span>
                    <span className="text-[11px] font-mono text-[#B4B6BC] shrink-0">{formatTime(event.timestamp)}</span>
                  </div>
                  <div className="text-[10.5px] font-mono text-[#B4B6BC] mt-0.5">{event.actor} · {event.payloadHash.slice(0, 20)}…</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="border border-[#E7E6E2] h-fit">
          <div className="px-5 py-4 border-b border-[#E7E6E2]">
            <div className="text-[10px] font-mono uppercase tracking-[0.1em] text-[#9A9CA4] mb-1">Proof</div>
            <div className="text-[15px] font-semibold">Verification</div>
          </div>
          <div className="p-5">
            {proof ? (
              <>
                <div className="space-y-2 mb-5 text-[12.5px]">
                  <Row label="Proof ID" value={proof.id} />
                  <Row label="Decision hash" value={proof.decisionHash} />
                  <Row label="Chain tx hash" value={proof.chainTxHash ?? "—"} />
                </div>
                <button
                  onClick={handleVerify}
                  disabled={verifying}
                  className="w-full flex items-center justify-center gap-1.5 bg-[#C4172C] text-white text-[11px] font-mono uppercase tracking-[0.08em] px-4 py-2.5 hover:bg-[#A81225] transition-colors disabled:opacity-50"
                >
                  {verifying ? <Loader2 size={13} className="animate-spin" /> : <ShieldCheck size={13} />}
                  {verifying ? "Verifying…" : "Verify proof"}
                </button>
                {verifyResult && (
                  <div className={`mt-4 px-4 py-3 text-[12.5px] border ${verifyResult.valid ? "border-[#B7E0C6] bg-[#F0FAF4] text-[#2C6E48]" : "border-[#F3CFCF] bg-[#FBEAEA] text-[#C4172C]"}`}>
                    {verifyResult.valid ? "Verified — recomputed hash matches on-chain record." : verifyResult.reasons.join(" ")}
                  </div>
                )}
              </>
            ) : (
              <div className="text-[13px] text-[#6B6D76]">No proof committed yet — this request hasn't completed execution.</div>
            )}
          </div>
        </div>
      </div>
    </Shell>
  );
}

function Row({ label, value }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="text-[#9A9CA4] shrink-0">{label}</span>
      <span className="font-mono text-[#14151A] text-right break-all">{value}</span>
    </div>
  );
}
