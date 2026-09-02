import React, { useEffect, useState } from "react";
import Shell from "../components/Layout.jsx";
import PageHeader from "../components/PageHeader.jsx";
import { api } from "../lib/api.js";
import { XCircle, Ban, MoreHorizontal, ArrowRight, Loader2, ShieldCheck } from "lucide-react";

const STEPS = ["Request", "Evidence", "Policy", "Authorization", "Execution", "Proof"];
const STOPPED_AT = 3; // Policy

function StepRail() {
  return (
    <div className="flex items-center mb-6">
      {STEPS.map((label, i) => {
        const n = i + 1;
        const isStop = n === STOPPED_AT;
        const isReq = n === 1;
        return (
          <React.Fragment key={label}>
            <div className="flex flex-col items-center gap-1.5 shrink-0">
              <div
                className={[
                  "w-7 h-7 flex items-center justify-center text-[11px] font-mono",
                  isStop || isReq ? "bg-[#C4172C] text-white" : "bg-[#14151A] text-white/90",
                ].join(" ")}
              >
                {n}
              </div>
              <div className={`text-[9.5px] font-mono uppercase tracking-[0.08em] ${isStop || isReq ? "text-[#C4172C]" : "text-[#B4B6BC]"}`}>
                {label}
              </div>
            </div>
            {i < STEPS.length - 1 && <div className="flex-1 h-px bg-[#E7E6E2] mx-2 -mt-4" />}
          </React.Fragment>
        );
      })}
    </div>
  );
}

const REASON_EXPLAIN = {
  TX_LIMIT: "Amount exceeds the per-transaction hard limit. This is never softened by a human-approval path.",
  NEW_OR_BLOCKED_RECIPIENT: "Recipient is not on the allowlist and the amount is below the approval threshold — blocked outright, not escalated.",
  DAILY_LIMIT: "Executing this would push the agent's cumulative spend today over the daily limit.",
  RISK_THRESHOLD: "The request's risk score (missing evidence, or language resembling a policy-override attempt) exceeded the policy's risk threshold.",
  AGENT_INACTIVE: "The requesting agent is not currently active.",
};

const STATIC_REVIEW_CHAIN = [
  { label: "Request", desc: "Original text sealed", ref: "req_01J8XG7YV4", filled: true },
  { label: "Evidence", desc: "No invoice reference supplied", ref: "evd_01J8XG7YV4", filled: true },
  { label: "Policy", desc: "Hard limit exceeded", ref: "pol_01J8XG7YV4", filled: true },
  { label: "Authorization", desc: "Not issued", ref: "", filled: false },
];

export default function BlockedRequest({ param: intentId }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [emptyState, setEmptyState] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (intentId) {
      api.getPaymentIntent(intentId)
        .then((d) => !cancelled && setData(d))
        .catch((err) => !cancelled && setError(err.message));
    } else {
      api.listPaymentIntents({ limit: "50" })
        .then((list) => {
          if (cancelled) return;
          const blocked = list.find((i) => i.status === "BLOCKED");
          if (blocked) {
            window.location.hash = `#/blocked-requests/${blocked.id}`;
          } else {
            setEmptyState(true);
          }
        })
        .catch((err) => !cancelled && setError(err.message));
    }
    return () => { cancelled = true; };
  }, [intentId]);

  const isLive = !!intentId;
  const loading = !emptyState && (!isLive || (!data && !error));

  const headline = isLive && data ? `"${data.intent.rawRequest}"` : '""';
  const reqId = isLive && data ? data.intent.id : "";
  const agentId = isLive && data ? data.intent.agentId : "";
  const reasonCode = isLive && data ? data.authorization?.reasonCodes?.[0] : "";
  const amount = isLive && data ? data.intent.amount : 0;
  const recipient = isLive && data ? data.intent.recipient : "";
  const reviewChain = isLive && data
    ? [
        { label: "Request", desc: "Original text sealed", ref: data.intent.id, filled: true },
        { label: "Evidence", desc: `${data.intent.evidenceRefs?.length ?? 0} reference(s) on file`, ref: "", filled: true },
        { label: "Policy", desc: REASON_EXPLAIN[reasonCode]?.split(".")[0] ?? "Policy violation", ref: data.authorization?.policyHash ?? "", filled: true },
        { label: "Authorization", desc: "Not issued", ref: "", filled: false },
      ]
    : STATIC_REVIEW_CHAIN;

  if (emptyState) {
    return (
      <Shell active="blocked-requests" crumbs={["Workspace", "Finance ops", "Blocked request"]} footer={false}>
        <PageHeader
          eyebrow="Security event / Blocked"
          title="The rail stopped the request."
          subtitle="TrustWeave does not negotiate with a violated policy. The original instruction, decision, and evidence remain available for review."
        />
        <div className="mt-8 p-10 border border-[#E7E6E2] text-center bg-[#FAFAF9]">
          <div className="flex items-center justify-center w-12 h-12 rounded-full bg-white border border-[#E7E6E2] mb-4 mx-auto text-[#3B8F5C]">
             <ShieldCheck size={20} />
          </div>
          <div className="text-[15px] font-semibold text-[#14151A] mb-1">No blocked requests</div>
          <div className="text-[13px] text-[#6B6D76]">All payment intents have successfully passed policy checks.</div>
        </div>
      </Shell>
    );
  }

  return (
    <Shell active="blocked-requests" crumbs={["Workspace", "Finance ops", "Blocked request"]} footer={false}>
      <PageHeader
        eyebrow="Security event / Blocked"
        title="The rail stopped the request."
        subtitle="TrustWeave does not negotiate with a violated policy. The original instruction, decision, and evidence remain available for review."
      />

      {error && <div className="mb-5 border border-[#F3CFCF] bg-[#FBEAEA] px-5 py-4 text-[13px] text-[#C4172C]">{error}</div>}
      {loading && <div className="mb-5 flex items-center gap-2 text-[13px] text-[#6B6D76]"><Loader2 size={15} className="animate-spin" /> Loading blocked request…</div>}

      <StepRail />

      <div className="border border-[#F3CFCF] bg-[#FBEAEA] mb-5">
        <div className="flex items-center justify-between px-6 py-5">
          <div className="flex items-center gap-4">
            <div className="w-10 h-10 border border-[#E9A9A9] flex items-center justify-center shrink-0">
              <XCircle size={18} className="text-[#C4172C]" />
            </div>
            <div>
              <div className="text-[10px] font-mono uppercase tracking-[0.08em] text-[#C4172C] mb-1.5">Blocked / No provider call</div>
              <div className="text-[19px] font-semibold text-[#14151A]" style={{ fontFamily: "Georgia, serif" }}>
                &ldquo;{headline.replace(/^"|"$/g, "")}&rdquo;
              </div>
              <div className="text-[11px] font-mono text-[#8A6B6B] mt-1.5">{reqId} · {agentId}</div>
            </div>
          </div>
          <span className="flex items-center gap-1.5 border border-[#C4172C] text-[#C4172C] text-[10px] font-mono uppercase tracking-[0.08em] px-3 py-1.5 shrink-0">
            <Ban size={12} /> Blocked
          </span>
        </div>
        <div className="grid grid-cols-3 border-t border-[#F3CFCF]">
          <div className="px-6 py-4 border-r border-[#F3CFCF]">
            <div className="text-[10px] font-mono uppercase tracking-[0.08em] text-[#9A8080] mb-1.5">Violated policy</div>
            <div className="text-[14px] font-mono text-[#14151A] mb-1">{reasonCode ?? "—"}</div>
            <div className="text-[11px] text-[#8A6B6B]">{REASON_EXPLAIN[reasonCode] ?? "Policy check failed."}</div>
          </div>
          <div className="px-6 py-4 border-r border-[#F3CFCF]">
            <div className="text-[10px] font-mono uppercase tracking-[0.08em] text-[#9A8080] mb-1.5">Requested amount</div>
            <div className="text-[14px] font-mono text-[#14151A] mb-1">₹{amount?.toLocaleString("en-IN") ?? "—"}</div>
            <div className="text-[11px] text-[#8A6B6B]">to {recipient || "unresolved recipient"}</div>
          </div>
          <div className="px-6 py-4">
            <div className="text-[10px] font-mono uppercase tracking-[0.08em] text-[#9A8080] mb-1.5">Money moved</div>
            <div className="text-[14px] font-mono text-[#14151A] mb-1">NO</div>
            <div className="text-[11px] text-[#8A6B6B]">Request terminated pre-execution</div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-[1.2fr_1fr] gap-5">
        {/* Adversarial analysis */}
        <div className="border border-[#E7E6E2]">
          <div className="flex items-center justify-between px-5 py-4 border-b border-[#E7E6E2]">
            <div>
              <div className="text-[10px] font-mono uppercase tracking-[0.1em] text-[#9A9CA4] mb-1">Adversarial analysis</div>
              <div className="text-[15px] font-semibold">What was rejected</div>
            </div>
            <MoreHorizontal size={16} className="text-[#B4B6BC]" />
          </div>
          <div className="p-5">
            <div className="border-l-2 border-[#E9A9A9] pl-4 py-1 mb-5">
              <p className="text-[13px] leading-[1.6] text-[#6B6D76]">
                {REASON_EXPLAIN[reasonCode] ?? 'The phrase "ignore the transaction limit" is an explicit attempt to override a policy gate. Natural language cannot alter the authorization contract.'}
              </p>
            </div>
            <div className="space-y-0">
              {[
                ["Parsed action", "payment.create"],
                ["Amount", `INR ${amount?.toLocaleString("en-IN") ?? "—"}`],
                ["Policy result", `DENY · ${reasonCode ?? "hard stop"}`, true],
                ["Provider request", "Not created"],
              ].map(([k, v, isRed]) => (
                <div key={k} className="flex items-center justify-between py-2.5 border-b border-[#F0EFEC] text-[13px]">
                  <span className="text-[#9A9CA4]">{k}</span>
                  <span className={`font-mono ${isRed ? "text-[#C4172C]" : "text-[#14151A]"}`}>{v}</span>
                </div>
              ))}
            </div>
            <div className="flex items-center gap-3 mt-5">
              <button className="flex items-center gap-1.5 border border-[#E7E6E2] text-[#B4B6BC] text-[11px] font-mono uppercase tracking-[0.08em] px-4 py-2.5 cursor-not-allowed">
                <Ban size={13} /> Override unavailable
              </button>
              <button className="flex items-center gap-1.5 border border-[#C4172C] text-[#C4172C] text-[11px] font-mono uppercase tracking-[0.08em] px-4 py-2.5 hover:bg-[#FBEAEA] transition-colors">
                Create compliant request <ArrowRight size={13} />
              </button>
            </div>
          </div>
        </div>

        {/* Independent review chain */}
        <div className="border border-[#E7E6E2] h-fit">
          <div className="flex items-center justify-between px-5 py-4 border-b border-[#E7E6E2]">
            <div>
              <div className="text-[10px] font-mono uppercase tracking-[0.1em] text-[#9A9CA4] mb-1">Review chain</div>
              <div className="text-[15px] font-semibold">Independent record</div>
            </div>
            <MoreHorizontal size={16} className="text-[#B4B6BC]" />
          </div>
          <div className="p-5">
            {reviewChain.map((r, i) => (
              <div key={r.label} className={`flex items-start gap-3 pb-4 ${i !== reviewChain.length - 1 ? "mb-4 border-b border-[#F0EFEC]" : ""}`}>
                <span className={`w-2.5 h-2.5 mt-1 shrink-0 ${r.filled ? "bg-[#C4172C]" : "border border-[#D6D5D0]"}`} />
                <div className="min-w-0">
                  <div className="text-[10px] font-mono uppercase tracking-[0.08em] text-[#B4B6BC] mb-0.5">{r.label}</div>
                  <div className="text-[13px] text-[#14151A] mb-0.5">{r.desc}</div>
                  {r.ref && <div className="text-[10.5px] font-mono text-[#B4B6BC]">{r.ref}</div>}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Shell>
  );
}
