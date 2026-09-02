import React, { useEffect, useState } from "react";
import Shell from "../components/Layout.jsx";
import PageHeader from "../components/PageHeader.jsx";
import { api } from "../lib/api.js";
import { CheckCircle2, XCircle, Loader2, MoreHorizontal, ArrowRight } from "lucide-react";

const STEPS = ["Request", "Evidence", "Policy", "Authorization", "Execution", "Proof"];

function StepRail({ current }) {
  return (
    <div className="flex items-center mb-6">
      {STEPS.map((label, i) => {
        const n = i + 1;
        const active = n <= current;
        return (
          <React.Fragment key={label}>
            <div className="flex flex-col items-center gap-1.5 shrink-0">
              <div className={`w-7 h-7 flex items-center justify-center text-[11px] font-mono ${active ? "bg-[#C4172C] text-white" : "bg-[#14151A] text-white/90"}`}>
                {n}
              </div>
              <div className={`text-[9.5px] font-mono uppercase tracking-[0.08em] ${active ? "text-[#C4172C]" : "text-[#B4B6BC]"}`}>{label}</div>
            </div>
            {i < STEPS.length - 1 && <div className="flex-1 h-px bg-[#E7E6E2] mx-2 -mt-4" />}
          </React.Fragment>
        );
      })}
    </div>
  );
}

const REASON_LABEL = {
  OK: "Within policy — no violations found",
  AGENT_INACTIVE: "Agent is not active",
  TX_LIMIT: "Exceeds per-transaction hard limit",
  NEW_OR_BLOCKED_RECIPIENT: "Recipient not on the allowlist",
  DAILY_LIMIT: "Would exceed rolling daily limit",
  RISK_THRESHOLD: "Risk score exceeds policy threshold",
  APPROVAL_THRESHOLD: "Above the autonomous approval threshold",
};

export default function AIAnalysis({ param: intentId }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!intentId) return;
    let cancelled = false;
    
    api
      .authorizePaymentIntent(intentId)
      .then((authResult) => {
        if (cancelled) return;
        return api.getPaymentIntent(intentId).then((fullIntentData) => {
          if (cancelled) return;
          setData({
            ...fullIntentData,
            authorization: {
              decision: authResult.decision,
              reasonCodes: authResult.reasonCodes,
              evaluation: authResult.evaluation
            }
          });
        });
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      });
      
    return () => { cancelled = true; };
  }, [intentId]);

  if (!intentId) {
    return (
      <Shell active="payment-request" crumbs={["Workspace", "Finance ops", "AI Analysis"]}>
        <PageHeader eyebrow="AI Analysis" title="No request selected." subtitle="Start a payment request first." />
      </Shell>
    );
  }

  if (error) {
    return (
      <Shell active="payment-request" crumbs={["Workspace", "Finance ops", "AI Analysis"]}>
        <div className="border border-[#F3CFCF] bg-[#FBEAEA] px-5 py-4 text-[13px] text-[#C4172C]">{error}</div>
      </Shell>
    );
  }

  if (!data) {
    return (
      <Shell active="payment-request" crumbs={["Workspace", "Finance ops", "AI Analysis"]}>
        <div className="flex items-center gap-2 text-[13px] text-[#6B6D76]">
          <Loader2 size={15} className="animate-spin" /> Retrieving evidence and checking policy…
        </div>
      </Shell>
    );
  }

  const { intent, authorization } = data;
  const recommendation = authorization?.decision ?? "PENDING";
  const nextHref =
    recommendation === "HUMAN_APPROVAL" ? `#/human-approval/${intentId}` :
    recommendation === "BLOCK" ? `#/blocked-requests/${intentId}` :
    `#/authorization/${intentId}`;

  return (
    <Shell active="payment-request" testMode crumbs={["Workspace", "Finance ops", "AI Analysis"]}>
      <PageHeader
        eyebrow="AI Analysis / Evidence &amp; Policy Review"
        title="Here's what the agent found."
        subtitle="Facts, retrieved sources, and policy checks — not hidden model reasoning."
      />

      <StepRail current={3} />

      <div className="grid grid-cols-3 gap-5">
        {/* Intent */}
        <div className="border border-[#E7E6E2]">
          <div className="flex items-center justify-between px-5 py-4 border-b border-[#E7E6E2]">
            <div>
              <div className="text-[10px] font-mono uppercase tracking-[0.1em] text-[#9A9CA4] mb-1">Structured intent</div>
              <div className="text-[15px] font-semibold">What it wants to do</div>
            </div>
          </div>
          <div className="p-5 space-y-3 text-[13px]">
            <Row label="Payment" value={`₹${intent.amount?.toLocaleString("en-IN") ?? "—"}`} />
            <Row label="Recipient" value={intent.recipient || "—"} />
            <Row label="Purpose" value={intent.purpose || "—"} />
            <Row label="Status" value={intent.status} mono />
          </div>
        </div>

        {/* Evidence */}
        <div className="border border-[#E7E6E2]">
          <div className="flex items-center justify-between px-5 py-4 border-b border-[#E7E6E2]">
            <div>
              <div className="text-[10px] font-mono uppercase tracking-[0.1em] text-[#9A9CA4] mb-1">Evidence</div>
              <div className="text-[15px] font-semibold">Retrieved &amp; cited</div>
            </div>
          </div>
          <div className="p-5 space-y-3">
            {intent.evidenceRefs?.length > 0 ? (
              intent.evidenceRefs.map((ref) => (
                <div key={ref} className="flex items-center gap-2 text-[13px]">
                  <CheckCircle2 size={14} className="text-[#3B8F5C] shrink-0" />
                  <span className="font-mono text-[11.5px] text-[#6B6D76] truncate">{ref}</span>
                </div>
              ))
            ) : (
              <div className="flex items-center gap-2 text-[13px]">
                <XCircle size={14} className="text-[#C4172C] shrink-0" />
                <span className="text-[#6B6D76]">No evidence references found</span>
              </div>
            )}
          </div>
        </div>

        {/* Policy + recommendation */}
        <div className="border border-[#E7E6E2]">
          <div className="flex items-center justify-between px-5 py-4 border-b border-[#E7E6E2]">
            <div>
              <div className="text-[10px] font-mono uppercase tracking-[0.1em] text-[#9A9CA4] mb-1">Policy</div>
              <div className="text-[15px] font-semibold">Checks &amp; recommendation</div>
            </div>
          </div>
          <div className="p-5">
            {authorization ? (
              <>
                <div className="space-y-2 mb-5">
                  {authorization.reasonCodes.map((code) => (
                    <div key={code} className="flex items-center gap-2 text-[12.5px]">
                      {code === "OK" ? (
                        <CheckCircle2 size={14} className="text-[#3B8F5C] shrink-0" />
                      ) : (
                        <XCircle size={14} className="text-[#C4172C] shrink-0" />
                      )}
                      <span className="text-[#6B6D76]">{REASON_LABEL[code] ?? code}</span>
                    </div>
                  ))}
                </div>
                <div className="border-t border-[#F0EFEC] pt-4">
                  <div className="text-[10px] font-mono uppercase tracking-[0.08em] text-[#9A9CA4] mb-2">Recommendation</div>
                  <div
                    className={`text-[18px] font-bold mb-4 ${recommendation === "APPROVE" ? "text-[#3B8F5C]" : recommendation === "BLOCK" ? "text-[#C4172C]" : "text-[#B7791F]"}`}
                    style={{ fontFamily: "Georgia, serif" }}
                  >
                    {recommendation === "APPROVE" ? "Approve" : recommendation === "BLOCK" ? "Block" : "Human approval"}
                  </div>
                  <a
                    href={nextHref}
                    className="flex items-center justify-center gap-1.5 bg-[#C4172C] text-white text-[11px] font-mono uppercase tracking-[0.08em] px-4 py-2.5 hover:bg-[#A81225] transition-colors"
                  >
                    Continue <ArrowRight size={13} />
                  </a>
                </div>
              </>
            ) : (
              <div className="flex items-center gap-2 text-[13px] text-[#6B6D76]">
                <Loader2 size={14} className="animate-spin" /> Evaluating policy…
              </div>
            )}
          </div>
        </div>
      </div>
    </Shell>
  );
}

function Row({ label, value, mono }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[#9A9CA4]">{label}</span>
      <span className={mono ? "font-mono text-[12px] text-[#14151A]" : "text-[#14151A]"}>{value}</span>
    </div>
  );
}
