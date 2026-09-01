import React, { useEffect, useState } from "react";
import Shell from "../components/Layout.jsx";
import PageHeader from "../components/PageHeader.jsx";
import { api } from "../lib/api.js";
import { Search, ChevronRight, MoreHorizontal, PauseCircle, PlayCircle, Activity, Bot, Loader2, Link2 } from "lucide-react";

function StatusBadge({ status }) {
  const map = {
    ACTIVE: "bg-[#C4172C] text-white",
    REVIEW: "border border-[#B7791F] text-[#B7791F] bg-[#FBF3E3]",
    PAUSED: "border border-[#D6D5D0] text-[#9A9CA4] bg-[#F6F6F4]",
  };
  return <span className={`text-[9.5px] font-mono uppercase tracking-[0.08em] px-2 py-[3px] ${map[status] ?? map.PAUSED}`}>{status}</span>;
}

export default function Agents() {
  const [agents, setAgents] = useState([]);
  const [selected, setSelected] = useState(null);
  const [onChain, setOnChain] = useState(null);
  const [error, setError] = useState(null);
  const [updating, setUpdating] = useState(false);

  function reload() {
    api
      .listAgents()
      .then((list) => {
        setAgents(list);
        setSelected((prev) => prev ?? list[0] ?? null);
      })
      .catch((err) => setError(err.message));
  }

  useEffect(reload, []);

  useEffect(() => {
    if (!selected) return;
    setOnChain(null);
    api.getAgentOnChain(selected.id).then(setOnChain).catch(() => setOnChain(null));
  }, [selected?.id]);

  async function toggleStatus() {
    if (!selected) return;
    const next = selected.status === "PAUSED" ? "ACTIVE" : "PAUSED";
    setUpdating(true);
    try {
      const updated = await api.updateAgentStatus(selected.id, next);
      setSelected(updated);
      setAgents((prev) => prev.map((a) => (a.id === updated.id ? updated : a)));
    } catch (err) {
      setError(err.message);
    } finally {
      setUpdating(false);
    }
  }

  const stats = {
    registered: agents.length,
    live: agents.filter((a) => a.status === "ACTIVE").length,
    review: agents.filter((a) => a.status === "REVIEW").length,
    paused: agents.filter((a) => a.status === "PAUSED").length,
  };
  const STATS = [
    { label: "Registered", value: stats.registered, sub: "workspace agents", tone: "ink" },
    { label: "Live now", value: stats.live, sub: "active agents", tone: "accent" },
    { label: "Review", value: stats.review, sub: "operator attention", tone: "amber" },
    { label: "Paused", value: stats.paused, sub: "no provider access", tone: "muted" },
  ];

  return (
    <Shell active="agents" crumbs={["Workspace", "Finance ops", "Agents"]} footer={false}>
      <PageHeader
        eyebrow="System / Agents"
        title="Agents with a bounded remit."
        subtitle="See which autonomous operators are connected, what they can touch, and when their last action crossed the proof rail."
      />

      {error && <div className="mb-5 border border-[#F3CFCF] bg-[#FBEAEA] px-5 py-4 text-[13px] text-[#C4172C]">{error}</div>}

      <div className="grid grid-cols-4 gap-4 mb-6">
        {STATS.map((s) => (
          <div key={s.label} className="border-t border-[#E7E6E2] pt-3">
            <div className="text-[10px] font-mono uppercase tracking-[0.1em] text-[#9A9CA4] mb-2">{s.label}</div>
            <div
              className={`text-[26px] font-bold leading-none mb-1 ${
                s.tone === "accent" ? "text-[#C4172C]" : s.tone === "amber" ? "text-[#B7791F]" : s.tone === "muted" ? "text-[#C7C6C1]" : "text-[#14151A]"
              }`}
              style={{ fontFamily: "Georgia, serif" }}
            >
              {s.value}
            </div>
            <div className="text-[11px] text-[#9A9CA4]">{s.sub}</div>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-3 mb-5">
        <div className="flex-1 flex items-center gap-2 border border-[#E7E6E2] px-3 py-2.5">
          <Search size={14} className="text-[#B4B6BC]" />
          <input placeholder="Search agent, team, scope…" className="flex-1 text-[13px] outline-none placeholder:text-[#B4B6BC]" />
        </div>
        <select className="border border-[#E7E6E2] px-3 py-2.5 text-[12px] font-mono text-[#6B6D76] outline-none">
          <option>All agents</option>
        </select>
      </div>

      <div className="grid grid-cols-[1.15fr_1fr] gap-5">
        {/* Registered runtime list */}
        <div className="border border-[#E7E6E2]">
          <div className="flex items-center justify-between px-5 py-4 border-b border-[#E7E6E2]">
            <div>
              <div className="text-[10px] font-mono uppercase tracking-[0.1em] text-[#9A9CA4] mb-1">Registered runtime</div>
              <div className="text-[15px] font-semibold">{agents.length} agents in view</div>
            </div>
            <MoreHorizontal size={16} className="text-[#B4B6BC]" />
          </div>
          <div>
            {agents.length === 0 && (
              <div className="px-5 py-6 text-[13px] text-[#B4B6BC] flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> Loading agents…</div>
            )}
            {agents.map((a, i) => {
              const active = selected?.id === a.id;
              return (
                <button
                  key={a.id}
                  onClick={() => setSelected(a)}
                  className={[
                    "w-full text-left flex items-center justify-between px-5 py-4 border-b border-[#F0EFEC] border-l-2 transition-colors",
                    active ? "border-l-[#C4172C] bg-[#FBEAEA]" : "border-l-transparent hover:bg-[#FAFAF9]",
                    a.status === "PAUSED" ? "opacity-60" : "",
                  ].join(" ")}
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-[13.5px] font-mono text-[#14151A]">{a.name}</span>
                      <StatusBadge status={a.status} />
                    </div>
                    <div className="text-[10.5px] font-mono text-[#B4B6BC]">{a.walletAddress ?? "—"}</div>
                  </div>
                  <ChevronRight size={16} className="text-[#D6D5D0] shrink-0" />
                </button>
              );
            })}
          </div>
        </div>

        {/* Runtime detail */}
        {selected && (
          <div className="border border-[#E7E6E2] h-fit">
            <div className="flex items-center justify-between px-5 py-4 border-b border-[#E7E6E2]">
              <div>
                <div className="text-[10px] font-mono uppercase tracking-[0.1em] text-[#9A9CA4] mb-1">Runtime detail</div>
                <div className="text-[15px] font-semibold">{selected.name}</div>
              </div>
              <MoreHorizontal size={16} className="text-[#B4B6BC]" />
            </div>
            <div className="p-5">
              <div className="flex items-center justify-between mb-5">
                <StatusBadge status={selected.status} />
                <div className="w-9 h-9 border border-[#F3CFCF] flex items-center justify-center text-[#C4172C]">
                  <Bot size={16} />
                </div>
              </div>
              <div className="text-[11px] font-mono text-[#9A9CA4] mb-1">{selected.id}</div>
              <p className="text-[13px] text-[#6B6D76] leading-[1.5] mb-5">
                Policy ID: <span className="font-mono">{selected.policyId}</span>
              </p>
              <div className="grid grid-cols-2 gap-y-3 text-[12.5px] mb-5 pb-5 border-b border-[#F0EFEC]">
                <div>
                  <div className="text-[10px] font-mono uppercase tracking-[0.06em] text-[#B4B6BC] mb-1">Wallet address</div>
                  <div className="font-mono text-[#14151A] truncate">{selected.walletAddress || "—"}</div>
                </div>
                <div>
                  <div className="text-[10px] font-mono uppercase tracking-[0.06em] text-[#B4B6BC] mb-1">Registered</div>
                  <div className="font-mono text-[#14151A]">{new Date(selected.createdAt).toLocaleDateString("en-IN")}</div>
                </div>
              </div>

              <div className="flex items-center gap-2 mb-2">
                <Link2 size={12} className="text-[#9A9CA4]" />
                <span className="text-[10px] font-mono uppercase tracking-[0.06em] text-[#9A9CA4]">On-chain record</span>
              </div>
              {onChain ? (
                <p className="text-[12px] font-mono text-[#14151A] mb-5 break-all">{onChain.policyHash}</p>
              ) : (
                <p className="text-[12px] text-[#B4B6BC] mb-5">Not yet registered on-chain (registers on first payment request).</p>
              )}

              <p className="text-[12px] leading-[1.6] text-[#6B6D76] border-l-2 border-[#F0EFEC] pl-3 mb-5">
                Every request from this agent is sealed with its runtime identity before evidence analysis begins.
                Pausing blocks new provider calls without deleting its ledger history.
              </p>
              <div className="flex items-center gap-3">
                <button
                  onClick={toggleStatus}
                  disabled={updating}
                  className="flex items-center gap-1.5 border border-[#C4172C] text-[#C4172C] text-[11px] font-mono uppercase tracking-[0.08em] px-4 py-2.5 hover:bg-[#FBEAEA] transition-colors disabled:opacity-50"
                >
                  {updating ? <Loader2 size={13} className="animate-spin" /> : selected.status === "PAUSED" ? <PlayCircle size={13} /> : <PauseCircle size={13} />}
                  {selected.status === "PAUSED" ? "Reactivate agent" : "Pause agent"}
                </button>
                <a
                  href={`#/agent-reputation`}
                  className="flex items-center gap-1.5 border border-[#E7E6E2] text-[#6B6D76] text-[11px] font-mono uppercase tracking-[0.08em] px-4 py-2.5 hover:bg-[#FAFAF9] transition-colors"
                >
                  <Activity size={13} /> View activity
                </a>
              </div>
            </div>
          </div>
        )}
      </div>
    </Shell>
  );
}
