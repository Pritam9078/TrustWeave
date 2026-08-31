import React, { useEffect, useState } from "react";
import Shell from "../components/Layout.jsx";
import PageHeader from "../components/PageHeader.jsx";
import { api } from "../lib/api.js";
import { Loader2, TrendingUp, ShieldCheck, Target, AlertTriangle } from "lucide-react";

const TRUST_DIMENSIONS = [
  { key: "reliability", label: "Reliability", icon: TrendingUp },
  { key: "compliance", label: "Compliance", icon: ShieldCheck },
  { key: "accuracy", label: "Accuracy", icon: Target },
  { key: "risk", label: "Risk", icon: AlertTriangle },
];

export default function AgentReputation() {
  const [metrics, setMetrics] = useState(null);
  const [agents, setAgents] = useState([]);
  const [error, setError] = useState(null);

  useEffect(() => {
    Promise.all([api.getMetrics(), api.listAgents()])
      .then(([m, a]) => { setMetrics(m); setAgents(a); })
      .catch((err) => setError(err.message));
  }, []);

  if (error) {
    return (
      <Shell active="agent-reputation" crumbs={["Workspace", "Finance ops", "Agent reputation"]}>
        <div className="border border-[#F3CFCF] bg-[#FBEAEA] px-5 py-4 text-[13px] text-[#C4172C]">{error}</div>
      </Shell>
    );
  }
  if (!metrics) {
    return (
      <Shell active="agent-reputation" crumbs={["Workspace", "Finance ops", "Agent reputation"]}>
        <div className="flex items-center gap-2 text-[13px] text-[#6B6D76]"><Loader2 size={15} className="animate-spin" /> Computing reputation…</div>
      </Shell>
    );
  }

  const complianceRate = metrics.paymentsRequested === 0 ? 100 : ((1 - metrics.blockRate) * 100).toFixed(1);

  return (
    <Shell active="agent-reputation" crumbs={["Workspace", "Finance ops", "Agent reputation"]}>
      <PageHeader
        eyebrow="System / Agent reputation"
        title="Trust, earned action by action."
        subtitle="Reputation computed only from verified outcomes — not self-reported agent behavior."
      />

      <div className="grid grid-cols-3 gap-4 mb-6">
        <Metric label="Tasks processed" value={metrics.paymentsRequested} />
        <Metric label="Policy compliance" value={`${complianceRate}%`} tone="good" />
        <Metric label="Successful executions" value={metrics.executed} />
        <Metric label="Human overrides" value={metrics.humanApprovals} tone="amber" />
        <Metric label="Blocked unsafe actions" value={metrics.blocked} tone="accent" />
        <Metric label="Payment failures" value={metrics.executionFailures} />
      </div>

      <div className="grid grid-cols-[1fr_1.2fr] gap-5">
        <div className="border border-[#E7E6E2]">
          <div className="px-5 py-4 border-b border-[#E7E6E2]">
            <div className="text-[10px] font-mono uppercase tracking-[0.1em] text-[#9A9CA4] mb-1">Trust dimensions</div>
            <div className="text-[15px] font-semibold">Composite score</div>
          </div>
          <div className="p-5 space-y-4">
            {TRUST_DIMENSIONS.map(({ key, label, icon: Icon }) => (
              <div key={key} className="flex items-center gap-3">
                <Icon size={15} className="text-[#9A9CA4] shrink-0" />
                <span className="text-[13px] text-[#14151A] w-24 shrink-0">{label}</span>
                <div className="flex-1 h-1.5 bg-[#F0EFEC]">
                  <div className="h-full bg-[#C4172C]" style={{ width: `${complianceRate}%` }} />
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="border border-[#E7E6E2]">
          <div className="px-5 py-4 border-b border-[#E7E6E2]">
            <div className="text-[10px] font-mono uppercase tracking-[0.1em] text-[#9A9CA4] mb-1">Per-agent</div>
            <div className="text-[15px] font-semibold">{agents.length} agents</div>
          </div>
          <div>
            {agents.map((a, i) => (
              <div key={a.id} className={`flex items-center justify-between px-5 py-3.5 ${i !== agents.length - 1 ? "border-b border-[#F0EFEC]" : ""}`}>
                <div>
                  <div className="text-[13px] font-mono text-[#14151A]">{a.name}</div>
                  <div className="text-[10.5px] text-[#9A9CA4]">{a.status}</div>
                </div>
                <span className="text-[10px] font-mono uppercase tracking-[0.08em] text-[#3B8F5C]">verified</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Shell>
  );
}

function Metric({ label, value, tone = "ink" }) {
  const color = tone === "accent" ? "text-[#C4172C]" : tone === "amber" ? "text-[#B7791F]" : tone === "good" ? "text-[#3B8F5C]" : "text-[#14151A]";
  return (
    <div className="border border-[#E7E6E2] p-4">
      <div className="text-[10px] font-mono uppercase tracking-[0.1em] text-[#9A9CA4] mb-3">{label}</div>
      <div className={`text-[26px] font-bold leading-none ${color}`} style={{ fontFamily: "Georgia, serif" }}>{value}</div>
    </div>
  );
}
