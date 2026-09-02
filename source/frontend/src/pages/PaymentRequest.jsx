import React, { useState, useEffect } from "react";
import Shell from "../components/Layout.jsx";
import PageHeader from "../components/PageHeader.jsx";
import { api } from "../lib/api.js";
import { Lock, Fingerprint, ArrowRight, Ban, MoreHorizontal, Loader2 } from "lucide-react";

const STEPS = ["Request", "Evidence", "Policy", "Authorization", "Execution", "Proof"];

function StepRail({ current = 1 }) {
  return (
    <div className="flex items-center mb-6">
      {STEPS.map((label, i) => {
        const n = i + 1;
        const active = n === current;
        return (
          <React.Fragment key={label}>
            <div className="flex flex-col items-center gap-1.5 shrink-0">
              <div
                className={[
                  "w-7 h-7 flex items-center justify-center text-[11px] font-mono",
                  active ? "bg-[#C4172C] text-white" : "bg-[#14151A] text-white/90",
                ].join(" ")}
              >
                {n}
              </div>
              <div className={`text-[9.5px] font-mono uppercase tracking-[0.08em] ${active ? "text-[#C4172C]" : "text-[#B4B6BC]"}`}>
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

const DEFAULT_INTENT = "Pay ₹4,500 to ABC Technologies for invoice INV-1024";

export default function PaymentRequest() {
  const [intent, setIntent] = useState(DEFAULT_INTENT);
  const [agents, setAgents] = useState([]);
  const [agentId, setAgentId] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadingBlocked, setLoadingBlocked] = useState(false);
  const [error, setError] = useState(null);

  const amountMatch = intent.match(/\d+([,.]\d+)?/);
  const amount = amountMatch ? parseFloat(amountMatch[0].replace(/,/g, "")) : null;
  const recipientMatch = intent.match(/to\s+([A-Za-z0-9\s]+?)(?=\s+(for|and|in|\.|$))/i);
  const recipient = recipientMatch ? recipientMatch[1].trim() : "Unknown";

  const previewJson = {
    action: "payment.create",
    amount: amount || null,
    currency: "INR",
    recipient: recipient,
    reference: "Pending extraction",
    mode: "test"
  };

  useEffect(() => {
    api
      .listAgents()
      .then((list) => {
        setAgents(list);
        const preferred = list.find((a) => a.name === "payables-orchestrator") ?? list[0];
        if (preferred) setAgentId(preferred.id);
      })
      .catch((err) => {
        setError("Failed to load agents: " + (err.message || String(err)));
      });
  }, []);

  async function handleAnalyze() {
    let targetAgentId = agentId;
    if (!targetAgentId) {
      const list = await api.listAgents().catch(() => []);
      const preferred = list.find((a) => a.name === "payables-orchestrator") ?? list[0];
      if (preferred) targetAgentId = preferred.id;
    }
    
    if (!targetAgentId || !intent.trim()) {
      setError("No agent available to process request.");
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const result = await api.createPaymentIntent({ agentId: targetAgentId, rawRequest: intent.trim() });
      window.location.hash = `#/ai-analysis/${result.intentId}`;
    } catch (err) {
      setError(err.message ?? "Request failed.");
      setLoading(false);
    }
  }

  async function handleBlockedPath() {
    let targetAgentId = agentId;
    if (!targetAgentId) {
      const list = await api.listAgents().catch(() => []);
      const preferred = list.find((a) => a.name === "payables-orchestrator") ?? list[0];
      if (preferred) targetAgentId = preferred.id;
    }
    
    if (!targetAgentId) {
      setError("No agent available to process request.");
      return;
    }

    setLoadingBlocked(true);
    setError(null);
    try {
      // Intentionally violating the 500k transaction limit to trigger policy block
      const result = await api.createPaymentIntent({ agentId: targetAgentId, rawRequest: "Pay ₹6,000,000 to personal account" });
      window.location.hash = `#/ai-analysis/${result.intentId}`;
    } catch (err) {
      setError(err.message ?? "Request failed.");
      setLoadingBlocked(false);
    }
  }

  return (
    <Shell active="payment-request" testMode crumbs={["Workspace", "Finance ops", "Payment request"]}>
      <PageHeader
        eyebrow="New action / Request"
        title="Create a payment request"
        subtitle="Start with the operator's exact intent. TrustWeave will preserve it as an immutable input to analysis."
      />

      <StepRail current={1} />

      <div className="grid grid-cols-2 gap-5">
        {/* Command input */}
        <div className="border border-[#E7E6E2]">
          <div className="flex items-center justify-between px-5 py-4 border-b border-[#E7E6E2]">
            <div>
              <div className="text-[10px] font-mono uppercase tracking-[0.1em] text-[#9A9CA4] mb-1">Command input</div>
              <div className="text-[15px] font-semibold">Payment instruction</div>
            </div>
            <MoreHorizontal size={16} className="text-[#B4B6BC]" />
          </div>
          <div className="p-5">
            {agents.length > 0 && (
              <div className="mb-4">
                <div className="text-[10px] font-mono uppercase tracking-[0.08em] text-[#9A9CA4] mb-2">Agent</div>
                <select
                  value={agentId}
                  onChange={(e) => setAgentId(e.target.value)}
                  className="w-full border border-[#E7E6E2] px-3 py-2.5 text-[13px] font-mono outline-none focus:border-[#C4172C]"
                >
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </select>
              </div>
            )}
            <div className="text-[10px] font-mono uppercase tracking-[0.08em] text-[#9A9CA4] mb-2">Natural language request</div>
            <div className="border border-[#C4172C] px-4 py-4 mb-4">
              <div className="text-[11px] font-mono text-[#B4B6BC] mb-2">$ agentproof / intent</div>
              <textarea
                value={intent}
                onChange={(e) => setIntent(e.target.value)}
                rows={3}
                className="w-full resize-none outline-none text-[15px] font-mono text-[#14151A] bg-transparent"
              />
            </div>
            <div className="flex items-center gap-5 pb-4 mb-4 border-b border-[#F0EFEC]">
              <span className="flex items-center gap-1.5 text-[10.5px] font-mono uppercase tracking-[0.06em] text-[#6B6D76]">
                <Lock size={12} className="text-[#9A9CA4]" /> Raw intent sealed
              </span>
              <span className="flex items-center gap-1.5 text-[10.5px] font-mono uppercase tracking-[0.06em] text-[#6B6D76]">
                <Fingerprint size={12} className="text-[#9A9CA4]" /> Request fingerprint generated
              </span>
            </div>
            {error && (
              <div className="mb-4 border border-[#F3CFCF] bg-[#FBEAEA] px-4 py-3 text-[12.5px] text-[#C4172C]">
                {error}
              </div>
            )}
            <div className="text-[10px] text-red-500 mb-2">DEBUG: agents.length = {agents.length}, agentId = {agentId || 'empty'}</div>
            <div className="flex items-center gap-3">
              <button
                onClick={handleAnalyze}
                disabled={loading || loadingBlocked}
                className="flex items-center gap-1.5 bg-[#C4172C] text-white text-[11px] font-mono uppercase tracking-[0.08em] px-4 py-2.5 hover:bg-[#A81225] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loading ? <Loader2 size={13} className="animate-spin" /> : null}
                {loading ? "Analyzing…" : "Run evidence analysis"} {!loading && <ArrowRight size={13} />}
              </button>
              <button 
                onClick={handleBlockedPath}
                disabled={loading || loadingBlocked}
                className="flex items-center gap-1.5 border border-[#E7E6E2] text-[#B4B6BC] text-[11px] font-mono uppercase tracking-[0.08em] px-4 py-2.5 hover:bg-[#F6F6F4] hover:text-[#14151A] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loadingBlocked ? <Loader2 size={13} className="animate-spin" /> : <Ban size={13} />}
                {loadingBlocked ? "Previewing…" : "Preview blocked path"}
              </button>
            </div>
          </div>
        </div>

        {/* Parsed preview */}
        <div className="border border-[#E7E6E2]">
          <div className="flex items-center justify-between px-5 py-4 border-b border-[#E7E6E2]">
            <div>
              <div className="text-[10px] font-mono uppercase tracking-[0.1em] text-[#9A9CA4] mb-1">Parsed preview</div>
              <div className="text-[15px] font-semibold">Expected structured intent</div>
            </div>
            <MoreHorizontal size={16} className="text-[#B4B6BC]" />
          </div>
          <div className="p-5">
            <pre className="bg-[#F6F6F4] border border-[#EDECE8] p-4 text-[12.5px] font-mono text-[#14151A] leading-[1.7] overflow-x-auto">
{JSON.stringify(previewJson, null, 2)}
            </pre>
            <p className="mt-4 text-[12px] leading-[1.6] text-[#6B6D76]">
              This is a live preview. TrustWeave's LLM will extract the actual structured
              intent from your request on the next screen, grounded in retrieved evidence.
            </p>
          </div>
        </div>
      </div>
    </Shell>
  );
}
