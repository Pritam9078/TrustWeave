import React, { useEffect, useState } from "react";
import Shell from "../components/Layout.jsx";
import PageHeader from "../components/PageHeader.jsx";
import { api } from "../lib/api.js";
import { Loader2, Check, X, FileText } from "lucide-react";

const REASON_EXPLAIN = {
  NEW_OR_BLOCKED_RECIPIENT: "New beneficiary above the approval threshold.",
  APPROVAL_THRESHOLD: "Amount is above the autonomous approval threshold.",
  TX_LIMIT: "Amount is above the per-transaction limit.",
};

export default function HumanApproval({ param: intentId }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [decided, setDecided] = useState(null);

  useEffect(() => {
    if (!intentId) return;
    let cancelled = false;
    api.getPaymentIntent(intentId).then((d) => !cancelled && setData(d)).catch((err) => !cancelled && setError(err.message));
    return () => { cancelled = true; };
  }, [intentId]);

  async function decide(decision) {
    setSubmitting(true);
    try {
      await api.approvePaymentIntent(intentId, { approver: "rhea.kulkarni", decision });
      setDecided(decision);
      if (decision === "APPROVE") {
        setTimeout(() => { window.location.hash = `#/razorpay-execution/${intentId}`; }, 600);
      } else {
        setTimeout(() => { window.location.hash = `#/audit-timeline/${intentId}`; }, 600);
      }
    } catch (err) {
      setError(err.message);
      setSubmitting(false);
    }
  }

  if (!intentId) {
    return (
      <Shell active="payment-request" crumbs={["Workspace", "Finance ops", "Human approval"]}>
        <PageHeader eyebrow="Human approval" title="No request selected." subtitle="Nothing is waiting on your review right now." />
      </Shell>
    );
  }
  if (error) {
    return (
      <Shell active="payment-request" crumbs={["Workspace", "Finance ops", "Human approval"]}>
        <div className="border border-[#F3CFCF] bg-[#FBEAEA] px-5 py-4 text-[13px] text-[#C4172C]">{error}</div>
      </Shell>
    );
  }
  if (!data) {
    return (
      <Shell active="payment-request" crumbs={["Workspace", "Finance ops", "Human approval"]}>
        <div className="flex items-center gap-2 text-[13px] text-[#6B6D76]"><Loader2 size={15} className="animate-spin" /> Loading…</div>
      </Shell>
    );
  }

  const { intent, authorization } = data;
  const reasonCode = authorization?.reasonCodes?.[0];

  return (
    <Shell active="payment-request" testMode crumbs={["Workspace", "Finance ops", "Human approval"]}>
      <PageHeader
        eyebrow="Human-in-the-loop / Exception"
        title="This one needs a person."
        subtitle="Policy routed this request to a human instead of auto-deciding it."
      />

      <div className="border border-[#E7E6E2] max-w-2xl">
        <div className="px-6 py-5 border-b border-[#E7E6E2] bg-[#FBF3E3]">
          <div className="text-[10px] font-mono uppercase tracking-[0.08em] text-[#8A6415] mb-1.5">Why human approval?</div>
          <div className="text-[15px] text-[#14151A]">{REASON_EXPLAIN[reasonCode] ?? "Policy flagged this request for review."}</div>
        </div>

        <div className="px-6 py-5 space-y-3 border-b border-[#E7E6E2]">
          <div className="flex items-center justify-between text-[13px]">
            <span className="text-[#9A9CA4]">Amount</span>
            <span className="font-mono text-[#14151A]">₹{intent.amount?.toLocaleString("en-IN")}</span>
          </div>
          <div className="flex items-center justify-between text-[13px]">
            <span className="text-[#9A9CA4]">Recipient</span>
            <span className="text-[#14151A]">{intent.recipient}</span>
          </div>
          <div className="flex items-center justify-between text-[13px]">
            <span className="text-[#9A9CA4]">Purpose</span>
            <span className="text-[#14151A]">{intent.purpose}</span>
          </div>
          <div className="flex items-center gap-2 pt-2">
            <FileText size={13} className="text-[#9A9CA4]" />
            <span className="text-[11.5px] font-mono text-[#6B6D76]">
              {intent.evidenceRefs?.length > 0 ? `${intent.evidenceRefs.length} evidence reference(s) on file` : "no evidence on file"}
            </span>
          </div>
        </div>

        <div className="px-6 py-5">
          {decided ? (
            <div className={`text-[13px] font-mono uppercase tracking-[0.08em] ${decided === "APPROVE" ? "text-[#3B8F5C]" : "text-[#C4172C]"}`}>
              {decided === "APPROVE" ? "Approved — moving to execution…" : "Rejected — blocked."}
            </div>
          ) : (
            <div className="flex items-center gap-3">
              <button
                onClick={() => decide("APPROVE")}
                disabled={submitting}
                className="flex items-center gap-1.5 bg-[#3B8F5C] text-white text-[11px] font-mono uppercase tracking-[0.08em] px-5 py-2.5 hover:opacity-90 transition-opacity disabled:opacity-50"
              >
                <Check size={13} /> Approve
              </button>
              <button
                onClick={() => decide("REJECT")}
                disabled={submitting}
                className="flex items-center gap-1.5 border border-[#C4172C] text-[#C4172C] text-[11px] font-mono uppercase tracking-[0.08em] px-5 py-2.5 hover:bg-[#FBEAEA] transition-colors disabled:opacity-50"
              >
                <X size={13} /> Reject
              </button>
            </div>
          )}
        </div>
      </div>
    </Shell>
  );
}
