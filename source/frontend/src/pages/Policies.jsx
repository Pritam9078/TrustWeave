import React, { useEffect, useState } from "react";
import Shell from "../components/Layout.jsx";
import PageHeader from "../components/PageHeader.jsx";
import { api } from "../lib/api.js";
import { Search, ChevronRight, MoreHorizontal, Plus, ShieldCheck, PauseCircle, PlayCircle, KeyRound, Loader2 } from "lucide-react";

function TagBadge({ tag }) {
  const map = {
    LIVE: "bg-[#C4172C] text-white",
    MONITORING: "border border-[#B7791F] text-[#B7791F] bg-[#FBF3E3]",
    DRAFT: "border border-[#D6D5D0] text-[#9A9CA4] bg-[#F6F6F4]",
  };
  return <span className={`text-[9.5px] font-mono uppercase tracking-[0.08em] px-2 py-[3px] ${map[tag] ?? map.DRAFT}`}>{tag}</span>;
}

const DEFAULT_DRAFT = { name: "", transactionLimit: "10000", dailyLimit: "200000", allowlist: "", riskThreshold: "0.5", approvalThreshold: "" };

export default function Policies() {
  const [policies, setPolicies] = useState([]);
  const [selected, setSelected] = useState(null);
  const [draft, setDraft] = useState(DEFAULT_DRAFT);
  const [creating, setCreating] = useState(false);
  const [showHash, setShowHash] = useState(false);
  const [error, setError] = useState(null);
  const [updating, setUpdating] = useState(false);

  function reload() {
    api
      .listPolicies()
      .then((list) => {
        setPolicies(list);
        setSelected((prev) => prev ?? list[0] ?? null);
      })
      .catch((err) => setError(err.message));
  }

  useEffect(reload, []);

  async function handleCreateDraft() {
    if (!draft.name.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const created = await api.createPolicy({
        name: draft.name.trim(),
        transactionLimit: Number(draft.transactionLimit),
        dailyLimit: Number(draft.dailyLimit),
        allowlist: draft.allowlist.split(",").map((s) => s.trim()).filter(Boolean),
        riskThreshold: Number(draft.riskThreshold),
        ...(draft.approvalThreshold ? { approvalThreshold: Number(draft.approvalThreshold) } : {}),
      });
      setPolicies((prev) => [created, ...prev]);
      setSelected(created);
      setDraft(DEFAULT_DRAFT);
    } catch (err) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  }

  async function toggleMonitoring() {
    if (!selected) return;
    const next = selected.status === "LIVE" ? "MONITORING" : selected.status === "MONITORING" ? "LIVE" : "MONITORING";
    setUpdating(true);
    try {
      const updated = await api.updatePolicyStatus(selected.id, next);
      setSelected(updated);
      setPolicies((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
    } catch (err) {
      setError(err.message);
    } finally {
      setUpdating(false);
    }
  }

  const rules = selected
    ? [
        `₹${selected.transactionLimit.toLocaleString("en-IN")} per transaction hard limit`,
        `₹${selected.dailyLimit.toLocaleString("en-IN")} rolling daily limit`,
        selected.allowlist.length > 0 ? `Allowlist: ${selected.allowlist.join(", ")}` : "No allowlisted recipients yet",
        ...(selected.approvalThreshold ? [`₹${selected.approvalThreshold.toLocaleString("en-IN")}+ requires human approval`] : []),
      ]
    : [];

  return (
    <Shell active="policies" testMode crumbs={["Workspace", "Finance ops", "Policies"]}>
      <PageHeader
        eyebrow="System / Policies"
        title="Policy is the hard boundary."
        subtitle="Compose the deterministic rules that sit between an agent's intent and a provider request. Drafts never execute."
      />

      {error && <div className="mb-5 border border-[#F3CFCF] bg-[#FBEAEA] px-5 py-4 text-[13px] text-[#C4172C]">{error}</div>}

      {/* Draft composer */}
      <div className="border border-[#E7E6E2] mb-5">
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#E7E6E2]">
          <div>
            <div className="text-[10px] font-mono uppercase tracking-[0.1em] text-[#9A9CA4] mb-1">Policy authoring</div>
            <div className="text-[15px] font-semibold">Start a controlled draft</div>
          </div>
        </div>
        <div className="p-5 grid grid-cols-5 gap-3 items-end">
          <div className="col-span-2">
            <label className="text-[10px] font-mono uppercase tracking-[0.06em] text-[#9A9CA4] mb-1 block">Name</label>
            <input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="beneficiary-risk-v1"
              className="w-full border border-[#E7E6E2] px-3 py-2.5 text-[13px] font-mono outline-none placeholder:text-[#B4B6BC] focus:border-[#C4172C]"
            />
          </div>
          <div>
            <label className="text-[10px] font-mono uppercase tracking-[0.06em] text-[#9A9CA4] mb-1 block">Tx limit (₹)</label>
            <input
              value={draft.transactionLimit}
              onChange={(e) => setDraft({ ...draft, transactionLimit: e.target.value })}
              className="w-full border border-[#E7E6E2] px-3 py-2.5 text-[13px] font-mono outline-none focus:border-[#C4172C]"
            />
          </div>
          <div>
            <label className="text-[10px] font-mono uppercase tracking-[0.06em] text-[#9A9CA4] mb-1 block">Daily limit (₹)</label>
            <input
              value={draft.dailyLimit}
              onChange={(e) => setDraft({ ...draft, dailyLimit: e.target.value })}
              className="w-full border border-[#E7E6E2] px-3 py-2.5 text-[13px] font-mono outline-none focus:border-[#C4172C]"
            />
          </div>
          <button
            onClick={handleCreateDraft}
            disabled={!draft.name.trim() || creating}
            className={[
              "flex items-center justify-center gap-1.5 text-[11px] font-mono uppercase tracking-[0.08em] px-4 py-2.5 transition-colors h-[42px]",
              draft.name.trim() ? "bg-[#C4172C] text-white hover:bg-[#A81225]" : "bg-[#F6F6F4] text-[#C7C6C1] cursor-not-allowed",
            ].join(" ")}
          >
            {creating ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />} Create draft
          </button>
          <div className="col-span-3">
            <label className="text-[10px] font-mono uppercase tracking-[0.06em] text-[#9A9CA4] mb-1 block">Allowlist (comma-separated)</label>
            <input
              value={draft.allowlist}
              onChange={(e) => setDraft({ ...draft, allowlist: e.target.value })}
              placeholder="ABC Technologies, Cloud District"
              className="w-full border border-[#E7E6E2] px-3 py-2.5 text-[13px] font-mono outline-none placeholder:text-[#B4B6BC] focus:border-[#C4172C]"
            />
          </div>
          <div>
            <label className="text-[10px] font-mono uppercase tracking-[0.06em] text-[#9A9CA4] mb-1 block">Risk threshold</label>
            <input
              value={draft.riskThreshold}
              onChange={(e) => setDraft({ ...draft, riskThreshold: e.target.value })}
              className="w-full border border-[#E7E6E2] px-3 py-2.5 text-[13px] font-mono outline-none focus:border-[#C4172C]"
            />
          </div>
          <div>
            <label className="text-[10px] font-mono uppercase tracking-[0.06em] text-[#9A9CA4] mb-1 block">Approval threshold (₹, optional)</label>
            <input
              value={draft.approvalThreshold}
              onChange={(e) => setDraft({ ...draft, approvalThreshold: e.target.value })}
              placeholder="8000"
              className="w-full border border-[#E7E6E2] px-3 py-2.5 text-[13px] font-mono outline-none placeholder:text-[#B4B6BC] focus:border-[#C4172C]"
            />
          </div>
        </div>
      </div>

      <div className="flex items-center gap-3 mb-5">
        <div className="flex-1 flex items-center gap-2 border border-[#E7E6E2] px-3 py-2.5">
          <Search size={14} className="text-[#B4B6BC]" />
          <input placeholder="Search policy or owner…" className="flex-1 text-[13px] outline-none placeholder:text-[#B4B6BC]" />
        </div>
        <select className="border border-[#E7E6E2] px-3 py-2.5 text-[12px] font-mono text-[#6B6D76] outline-none">
          <option>All states</option>
        </select>
      </div>

      <div className="grid grid-cols-[1.1fr_1fr] gap-5">
        {/* Control library */}
        <div className="border border-[#E7E6E2] h-fit">
          <div className="flex items-center justify-between px-5 py-4 border-b border-[#E7E6E2]">
            <div>
              <div className="text-[10px] font-mono uppercase tracking-[0.1em] text-[#9A9CA4] mb-1">Control library</div>
              <div className="text-[15px] font-semibold">{policies.length} policies in view</div>
            </div>
            <MoreHorizontal size={16} className="text-[#B4B6BC]" />
          </div>
          <div>
            {policies.length === 0 && (
              <div className="px-5 py-6 text-[13px] text-[#B4B6BC] flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> Loading policies…</div>
            )}
            {policies.map((p) => {
              const active = selected?.id === p.id;
              return (
                <button
                  key={p.id}
                  onClick={() => { setSelected(p); setShowHash(false); }}
                  className={[
                    "w-full text-left flex items-center justify-between px-5 py-4 border-b border-[#F0EFEC] border-l-2 transition-colors",
                    active ? "border-l-[#C4172C] bg-[#FBEAEA]" : "border-l-transparent hover:bg-[#FAFAF9]",
                  ].join(" ")}
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-[13.5px] font-mono text-[#14151A]">{p.name}</span>
                      <TagBadge tag={p.status} />
                    </div>
                    <div className="text-[11.5px] text-[#6B6D76] mb-1">v{p.version} · updated {new Date(p.updatedAt).toLocaleDateString("en-IN")}</div>
                    <div className="text-[10.5px] font-mono text-[#B4B6BC]">₹{p.transactionLimit.toLocaleString("en-IN")} tx limit</div>
                  </div>
                  <ChevronRight size={16} className="text-[#D6D5D0] shrink-0" />
                </button>
              );
            })}
          </div>
        </div>

        {/* Policy detail */}
        {selected && (
          <div className="border border-[#E7E6E2] h-fit">
            <div className="flex items-center justify-between px-5 py-4 border-b border-[#E7E6E2]">
              <div>
                <div className="text-[10px] font-mono uppercase tracking-[0.1em] text-[#9A9CA4] mb-1">Policy detail</div>
                <div className="text-[15px] font-semibold">{selected.name}</div>
              </div>
              <MoreHorizontal size={16} className="text-[#B4B6BC]" />
            </div>
            <div className="p-5">
              <div className="flex items-center justify-between mb-5">
                <TagBadge tag={selected.status} />
                <div className="w-9 h-9 border border-[#F3CFCF] flex items-center justify-center text-[#C4172C]">
                  <ShieldCheck size={16} />
                </div>
              </div>

              <div className="mb-5">
                {rules.map((r) => (
                  <div key={r} className="flex items-center gap-3 py-2.5 border-b border-[#F0EFEC] last:border-b-0">
                    <span className="w-2.5 h-2.5 bg-[#C4172C] shrink-0" />
                    <span className="text-[13px] text-[#14151A]">{r}</span>
                  </div>
                ))}
              </div>

              <div className="grid grid-cols-2 gap-y-3 text-[12.5px] mb-5 pb-5 border-b border-[#F0EFEC]">
                <div>
                  <div className="text-[10px] font-mono uppercase tracking-[0.06em] text-[#B4B6BC] mb-1">Policy ID</div>
                  <div className="font-mono text-[#14151A] truncate">{selected.id}</div>
                </div>
                <div>
                  <div className="text-[10px] font-mono uppercase tracking-[0.06em] text-[#B4B6BC] mb-1">Version</div>
                  <div className="font-mono text-[#14151A]">v{selected.version}</div>
                </div>
              </div>

              <p className="text-[12px] leading-[1.6] text-[#6B6D76] border-l-2 border-[#F0EFEC] pl-3 mb-5">
                Changes are versioned. Existing proofs retain the exact policy hash used at decision time.
              </p>

              {showHash && (
                <div className="mb-5 border border-[#EDECE8] bg-[#F6F6F4] px-4 py-3 text-[12px] font-mono text-[#14151A] break-all">
                  {selected.hash}
                </div>
              )}

              <div className="flex items-center gap-3">
                <button
                  onClick={toggleMonitoring}
                  disabled={updating}
                  className="flex items-center gap-1.5 border border-[#C4172C] text-[#C4172C] text-[11px] font-mono uppercase tracking-[0.08em] px-4 py-2.5 hover:bg-[#FBEAEA] transition-colors disabled:opacity-50"
                >
                  {updating ? <Loader2 size={13} className="animate-spin" /> : selected.status === "LIVE" ? <PauseCircle size={13} /> : <PlayCircle size={13} />}
                  {selected.status === "LIVE" ? "Move to monitoring" : selected.status === "MONITORING" ? "Promote to live" : "Move to monitoring"}
                </button>
                <button
                  onClick={() => setShowHash((v) => !v)}
                  className="flex items-center gap-1.5 border border-[#E7E6E2] text-[#6B6D76] text-[11px] font-mono uppercase tracking-[0.08em] px-4 py-2.5 hover:bg-[#FAFAF9] transition-colors"
                >
                  <KeyRound size={13} /> {showHash ? "Hide" : "View"} policy hash
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </Shell>
  );
}
