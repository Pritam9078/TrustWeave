import React, { useEffect, useState } from "react";
import Shell from "../components/Layout.jsx";
import PageHeader from "../components/PageHeader.jsx";
import { api } from "../lib/api.js";
import {
  ArrowUpRight,
  ShieldCheck,
  Boxes,
  Circle,
  Loader2,
} from "lucide-react";

function statusColor(s) {
  if (s === "BLOCKED" || s === "FAILED") return "text-[#C4172C]";
  if (s === "REVIEW" || s === "HUMAN_APPROVAL_PENDING") return "text-[#B7791F]";
  return "text-[#3B8F5C]";
}

function formatTime(iso) {
  try {
    return new Date(iso).toLocaleTimeString("en-IN", { hour12: false });
  } catch {
    return iso;
  }
}

export default function Overview() {
  const [metrics, setMetrics] = useState(null);
  const [agents, setAgents] = useState([]);
  const [activity, setActivity] = useState([]);
  const [error, setError] = useState(null);

  useEffect(() => {
    Promise.allSettled([api.getMetrics(), api.listAgents(), api.listPaymentIntents({ limit: "8" })])
      .then(([mResult, aResult, iResult]) => {
        if (mResult.status === "fulfilled") {
          setMetrics(mResult.value);
        } else {
          setMetrics({ paymentsRequested: 0, executed: 0, blocked: 0, humanApprovals: 0 });
        }
        
        if (aResult.status === "fulfilled") {
          setAgents(aResult.value);
        } else {
          setAgents([]);
        }

        if (iResult.status === "fulfilled") {
          setActivity(iResult.value);
        } else {
          setActivity([]);
        }

        const errors = [mResult, aResult, iResult]
          .filter(r => r.status === "rejected")
          .map(r => r.reason.message);
          
        if (errors.length === 3) {
          setError("You do not hold the capabilities required to view this dashboard.");
        } else if (errors.length > 0) {
          // If some but not all fail, we just log it and show what we can
          console.warn("Some dashboard widgets failed to load due to permissions:", errors);
        }
      });
  }, []);

  const kpis = metrics
    ? [
        { label: "Payments requested", value: metrics.paymentsRequested, sub: "this cycle", tone: "ink" },
        { label: "Approved & executed", value: metrics.executed, sub: `${metrics.paymentsRequested ? Math.round((metrics.executed / metrics.paymentsRequested) * 100) : 0}% pass rate`, tone: "ink" },
        { label: "Blocked by policy", value: metrics.blocked, sub: "policy violations stopped", tone: "accent" },
        { label: "Human overrides", value: metrics.humanApprovals, sub: "escalated for review", tone: "amber" },
      ]
    : [];

  return (
    <Shell active="overview" testMode crumbs={["Workspace", "Finance ops", "Overview"]}>
      <PageHeader
        eyebrow="System / Overview"
        title="Every agent, one accountable trail."
        subtitle="A live read on what your autonomous agents are asking for, what policy is stopping, and what actually moved money — all with a signed proof behind it."
        right={
          <a
            href="#/payment-request"
            className="shrink-0 flex items-center gap-1.5 bg-[#C4172C] text-white text-[11px] font-mono uppercase tracking-[0.08em] px-4 py-2.5 hover:bg-[#A81225] transition-colors"
          >
            Create payment request
          </a>
        }
      />

      {error && <div className="mb-5 border border-[#F3CFCF] bg-[#FBEAEA] px-5 py-4 text-[13px] text-[#C4172C]">{error}</div>}

      {!metrics ? (
        <div className="flex items-center gap-2 text-[13px] text-[#6B6D76] mb-6"><Loader2 size={15} className="animate-spin" /> Loading system status…</div>
      ) : (
        <div className="grid grid-cols-4 gap-4 mb-6">
          {kpis.map((k) => (
            <div key={k.label} className="border border-[#E7E6E2] p-4">
              <div className="text-[10px] font-mono uppercase tracking-[0.1em] text-[#9A9CA4] mb-3">{k.label}</div>
              <div
                className={`text-[28px] font-bold leading-none mb-2 ${k.tone === "accent" ? "text-[#C4172C]" : k.tone === "amber" ? "text-[#B7791F]" : "text-[#14151A]"}`}
                style={{ fontFamily: "Georgia, serif" }}
              >
                {k.value}
              </div>
              <div className="text-[11px] text-[#9A9CA4]">{k.sub}</div>
            </div>
          ))}
        </div>
      )}

      <div className="grid grid-cols-[1.4fr_1fr] gap-4">
        {/* Recent activity */}
        <div className="border border-[#E7E6E2]">
          <div className="flex items-center justify-between px-5 py-4 border-b border-[#E7E6E2]">
            <div>
              <div className="text-[10px] font-mono uppercase tracking-[0.1em] text-[#9A9CA4] mb-1">Live feed</div>
              <div className="text-[15px] font-semibold">Recent activity</div>
            </div>
            <a href="#/proof-explorer" className="text-[11px] font-mono uppercase tracking-[0.08em] text-[#C4172C] flex items-center gap-1">
              Proof explorer <ArrowUpRight size={12} />
            </a>
          </div>
          <div>
            {(!activity || activity.length === 0) && (
              <div className="px-5 py-6 text-[13px] text-[#B4B6BC]">No activity yet — create a payment request to get started.</div>
            )}
            {(activity || []).map((a, i) => {
              const href = a.status === "BLOCKED" ? `#/blocked-requests/${a.id}` : `#/audit-timeline/${a.id}`;
              return (
                <a
                  key={a.id}
                  href={href}
                  className={`flex items-center justify-between px-5 py-3.5 hover:bg-[#FAFAF9] transition-colors ${i !== activity.length - 1 ? "border-b border-[#F0EFEC]" : ""}`}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <Circle size={7} className={a.status === "BLOCKED" ? "text-[#C4172C] fill-[#C4172C]" : "text-[#3B8F5C] fill-[#3B8F5C]"} />
                    <div className="min-w-0">
                      <div className="text-[13px] text-[#14151A] truncate">
                        ₹{a.amount?.toLocaleString("en-IN") ?? "—"} to {a.recipient || "—"} — {a.agentName}
                      </div>
                      <div className="text-[10px] font-mono text-[#B4B6BC]">{a.id.slice(0, 12)}</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-4 shrink-0 pl-4">
                    <span className={`text-[10px] font-mono uppercase tracking-[0.08em] ${statusColor(a.status)}`}>{a.status}</span>
                    <span className="text-[11px] font-mono text-[#B4B6BC]">{formatTime(a.createdAt)}</span>
                  </div>
                </a>
              );
            })}
          </div>
        </div>

        {/* Agent health + status */}
        <div className="flex flex-col gap-4">
          <div className="border border-[#E7E6E2]">
            <div className="flex items-center justify-between px-5 py-4 border-b border-[#E7E6E2]">
              <div className="text-[15px] font-semibold flex items-center gap-2">
                <Boxes size={15} className="text-[#9A9CA4]" /> Agent health
              </div>
              <a href="#/agents" className="text-[11px] font-mono uppercase tracking-[0.08em] text-[#C4172C]">View all</a>
            </div>
            <div>
              {agents.map((a, i) => (
                <div key={a.id} className={`flex items-center justify-between px-5 py-3 ${i !== agents.length - 1 ? "border-b border-[#F0EFEC]" : ""}`}>
                  <div>
                    <div className="text-[12.5px] font-mono text-[#14151A]">{a.name}</div>
                    <div className="text-[10.5px] text-[#9A9CA4]">{a.status}</div>
                  </div>
                  <span className={`text-[10px] font-mono uppercase tracking-[0.08em] ${statusColor(a.status)}`}>{a.status}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="border border-[#E7E6E2] p-5">
            <div className="flex items-center gap-2 mb-3">
              <ShieldCheck size={15} className="text-[#C4172C]" />
              <div className="text-[15px] font-semibold">Environment status</div>
            </div>
            <div className="space-y-2 text-[12px]">
              <div className="flex items-center justify-between">
                <span className="text-[#6B6D76]">Razorpay API</span>
                <span className="font-mono text-[#3B8F5C] uppercase text-[10px]">Live mode</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[#6B6D76]">Ledger sync</span>
                <span className="font-mono text-[#3B8F5C] uppercase text-[10px]">Healthy</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[#6B6D76]">Policy engine</span>
                <span className="font-mono text-[#3B8F5C] uppercase text-[10px]">Enforcing</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Shell>
  );
}
