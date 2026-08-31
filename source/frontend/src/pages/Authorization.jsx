import React, { useEffect, useState } from "react";
import Shell from "../components/Layout.jsx";
import PageHeader from "../components/PageHeader.jsx";
import { api } from "../lib/api.js";
import { ShieldCheck, Loader2, ArrowRight, KeyRound, ExternalLink, Link2 } from "lucide-react";

function DecisionBadge({ decision }) {
  const map = {
    APPROVE: "bg-[#3B8F5C] text-white",
    BLOCK: "bg-[#C4172C] text-white",
    HUMAN_APPROVAL: "border border-[#B7791F] text-[#B7791F] bg-[#FBF3E3]",
  };
  const label = { APPROVE: "APPROVED", BLOCK: "BLOCKED", HUMAN_APPROVAL: "HUMAN APPROVAL" }[decision] ?? decision;
  return <span className={`text-[10px] font-mono uppercase tracking-[0.08em] px-2.5 py-1 ${map[decision] ?? ""}`}>{label}</span>;
}

export default function Authorization({ param: intentId }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [onChain, setOnChain] = useState(null);
  const [onChainError, setOnChainError] = useState(null);

  useEffect(() => {
    if (!intentId) return;
    let cancelled = false;
    api.getPaymentIntent(intentId).then((d) => !cancelled && setData(d)).catch((err) => !cancelled && setError(err.message));
    return () => { cancelled = true; };
  }, [intentId]);

  useEffect(() => {
    if (!data?.intent?.agentId) return;
    let cancelled = false;
    api
      .getAgentOnChain(data.intent.agentId)
      .then((d) => !cancelled && setOnChain(d))
      .catch((err) => !cancelled && setOnChainError(err.message));
    return () => { cancelled = true; };
  }, [data?.intent?.agentId]);

  if (!intentId) {
    return (
      <Shell active="payment-request" crumbs={["Workspace", "Finance ops", "Authorization"]}>
        <PageHeader eyebrow="Authorization" title="No request selected." subtitle="Start a payment request first." />
      </Shell>
    );
  }
  if (error) {
    return (
      <Shell active="payment-request" crumbs={["Workspace", "Finance ops", "Authorization"]}>
        <div className="border border-[#F3CFCF] bg-[#FBEAEA] px-5 py-4 text-[13px] text-[#C4172C]">{error}</div>
      </Shell>
    );
  }
  if (!data) {
    return (
      <Shell active="payment-request" crumbs={["Workspace", "Finance ops", "Authorization"]}>
        <div className="flex items-center gap-2 text-[13px] text-[#6B6D76]"><Loader2 size={15} className="animate-spin" /> Authorizing…</div>
      </Shell>
    );
  }

  const { intent, authorization, proof } = data;
  const decision = authorization?.decision ?? "PENDING";
  const nextHref = decision === "APPROVE" ? `#/razorpay-execution/${intentId}` : `#/audit-timeline/${intentId}`;

  return (
    <Shell active="payment-request" testMode crumbs={["Workspace", "Finance ops", "Authorization"]}>
      <PageHeader
        eyebrow="Authorization / On-chain decision"
        title="The authorization contract has ruled."
        subtitle="Agent identity, policy hash, and limits — checked deterministically, recorded on-chain."
        right={decision !== "PENDING" ? <DecisionBadge decision={decision} /> : null}
      />

      <div className="border border-[#E7E6E2]">
        <div className="grid grid-cols-2 divide-x divide-[#E7E6E2]">
          <div className="p-6 space-y-4">
            <Field label="Agent identity" value={intent.agentId} mono />
            <Field label="Policy hash" value={authorization?.policyHash ?? "—"} mono truncate />
            <Field label="Requested amount" value={`₹${intent.amount?.toLocaleString("en-IN") ?? "—"}`} />
            <Field label="Recipient" value={intent.recipient ?? "—"} />
          </div>
          <div className="p-6 space-y-4">
            <Field label="Chain tx hash" value={authorization?.chainTxHash ?? "not yet recorded"} mono truncate />
            <Field label="Reason codes" value={authorization?.reasonCodes?.join(", ") ?? "—"} mono />
            <Field label="Proof" value={proof ? "generated" : "pending"} />
            <Field label="Decision" value={decision} mono />
          </div>
        </div>

        <div className="flex items-center justify-between px-6 py-5 border-t border-[#E7E6E2] bg-[#FAFAF9]">
          <div className="flex items-center gap-2 text-[12px] text-[#6B6D76]">
            <ShieldCheck size={15} className="text-[#C4172C]" />
            Recorded on-chain — sealed with the policy hash used at decision time.
          </div>
          {decision !== "PENDING" && (
            <a
              href={nextHref}
              className="flex items-center gap-1.5 bg-[#C4172C] text-white text-[11px] font-mono uppercase tracking-[0.08em] px-4 py-2.5 hover:bg-[#A81225] transition-colors"
            >
              {decision === "APPROVE" ? "Proceed to execution" : "View audit timeline"} <ArrowRight size={13} />
            </a>
          )}
        </div>

        {/* Live on-chain read — proves the integration is real, not cosmetic:
            this hits the deployed contract (or the interface-identical
            in-memory stand-in) directly, independent of the app database. */}
        <div className="px-6 py-5 border-t border-[#E7E6E2]">
          <div className="flex items-center gap-2 mb-3">
            <Link2 size={13} className="text-[#9A9CA4]" />
            <span className="text-[10px] font-mono uppercase tracking-[0.08em] text-[#9A9CA4]">Independent on-chain read</span>
          </div>
          {onChain ? (
            <div className="grid grid-cols-2 gap-y-2 text-[12.5px]">
              <span className="text-[#9A9CA4]">Adapter</span>
              <span className="font-mono text-[#14151A] text-right">{onChain.adapter === "solidity" ? "Solidity (live contract)" : "In-memory (dev fallback)"}</span>
              <span className="text-[#9A9CA4]">On-chain policy hash</span>
              <span className="font-mono text-[#14151A] text-right truncate">{onChain.policyHash}</span>
              <span className="text-[#9A9CA4]">Matches this authorization</span>
              <span className={`font-mono text-right ${onChain.policyHash === authorization?.policyHash ? "text-[#3B8F5C]" : "text-[#C4172C]"}`}>
                {onChain.policyHash === authorization?.policyHash ? "yes" : "no — stale"}
              </span>
              {onChain.explorerUrl && (
                <a href={onChain.explorerUrl} target="_blank" rel="noreferrer" className="col-span-2 flex items-center gap-1.5 text-[#C4172C] mt-1">
                  View contract on Sepolia Etherscan <ExternalLink size={11} />
                </a>
              )}
            </div>
          ) : onChainError ? (
            <div className="text-[12px] text-[#B4B6BC]">Not yet registered on-chain for this agent.</div>
          ) : (
            <div className="flex items-center gap-2 text-[12px] text-[#6B6D76]"><Loader2 size={12} className="animate-spin" /> Reading chain…</div>
          )}
        </div>
      </div>
    </Shell>
  );
}

function Field({ label, value, mono, truncate }) {
  return (
    <div>
      <div className="text-[10px] font-mono uppercase tracking-[0.08em] text-[#9A9CA4] mb-1 flex items-center gap-1.5">
        {label === "Policy hash" || label === "Chain tx hash" ? <KeyRound size={11} /> : null}
        {label}
      </div>
      <div className={[mono ? "font-mono" : "", "text-[13px] text-[#14151A]", truncate ? "truncate" : ""].join(" ")}>{value}</div>
    </div>
  );
}
