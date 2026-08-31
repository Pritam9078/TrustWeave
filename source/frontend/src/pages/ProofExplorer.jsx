import React, { useEffect, useState } from "react";
import Shell from "../components/Layout.jsx";
import PageHeader from "../components/PageHeader.jsx";
import { api } from "../lib/api.js";
import { Search, MoreHorizontal, FileText, Layers, ShieldCheck, Radio, Fingerprint, Terminal, Loader2 } from "lucide-react";

function formatTime(iso) {
  try {
    return new Date(iso).toLocaleTimeString("en-IN", { hour12: false });
  } catch {
    return iso;
  }
}

export default function ProofExplorer() {
  const [records, setRecords] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [verifyResult, setVerifyResult] = useState(null);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    api
      .listPaymentIntents({ limit: "50" })
      .then((list) => {
        setRecords(list);
        if (list.length > 0) setSelectedId(list[0].id);
      })
      .catch((err) => setError(err.message));
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    setDetail(null);
    setVerifyResult(null);
    api.getPaymentIntent(selectedId).then(setDetail).catch((err) => setError(err.message));
  }, [selectedId]);

  async function handleVerify() {
    if (!detail?.proof) return;
    setVerifying(true);
    try {
      const result = await api.verifyProof(detail.proof.id);
      setVerifyResult(result);
    } catch (err) {
      setError(err.message);
    } finally {
      setVerifying(false);
    }
  }

  const selectedRecord = records.find((r) => r.id === selectedId);

  return (
    <Shell active="proof-explorer" testMode crumbs={["Workspace", "Finance ops", "Proof explorer"]}>
      <PageHeader
        eyebrow="Proof explorer / Signed ledger"
        title="Every execution has a receipt."
        subtitle="Searchable, independently verifiable records of what was requested, allowed, executed, and settled."
      />

      {error && <div className="mb-5 border border-[#F3CFCF] bg-[#FBEAEA] px-5 py-4 text-[13px] text-[#C4172C]">{error}</div>}

      <div className="flex items-center gap-3 mb-5">
        <div className="flex-1 flex items-center gap-2 border border-[#E7E6E2] px-3 py-2.5">
          <Search size={14} className="text-[#B4B6BC]" />
          <input placeholder="Search proof ID, recipient, agent…" className="flex-1 text-[13px] outline-none placeholder:text-[#B4B6BC]" />
        </div>
        <span className="text-[11px] font-mono text-[#9A9CA4] shrink-0">{records.length} records</span>
      </div>

      <div className="grid grid-cols-[1.15fr_1fr] gap-5">
        {/* Signed records list */}
        <div className="border border-[#E7E6E2]">
          <div className="flex items-center justify-between px-5 py-4 border-b border-[#E7E6E2]">
            <div>
              <div className="text-[10px] font-mono uppercase tracking-[0.1em] text-[#9A9CA4] mb-1">Signed records</div>
              <div className="text-[15px] font-semibold">Recent activity</div>
            </div>
            <MoreHorizontal size={16} className="text-[#B4B6BC]" />
          </div>
          <div className="grid grid-cols-[1.4fr_1fr_0.6fr_0.6fr] px-5 py-2.5 border-b border-[#F0EFEC] text-[10px] font-mono uppercase tracking-[0.08em] text-[#B4B6BC]">
            <span>Proof / Action</span>
            <span>Agent</span>
            <span>Status</span>
            <span>Time</span>
          </div>
          <div>
            {records.length === 0 && (
              <div className="px-5 py-6 text-[13px] text-[#B4B6BC] flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> Loading records…</div>
            )}
            {records.map((r) => {
              const active = selectedId === r.id;
              const blocked = r.status === "BLOCKED";
              return (
                <button
                  key={r.id}
                  onClick={() => setSelectedId(r.id)}
                  className={[
                    "w-full text-left grid grid-cols-[1.4fr_1fr_0.6fr_0.6fr] items-center px-5 py-3.5 border-b border-[#F0EFEC] transition-colors",
                    active ? "bg-[#14151A]" : "hover:bg-[#FAFAF9]",
                  ].join(" ")}
                >
                  <div className="min-w-0 pr-2">
                    <div className={`text-[12px] font-mono truncate ${active ? "text-[#E9788A]" : "text-[#C4172C]"}`}>{(r.proofId ?? r.id).slice(0, 12)}</div>
                    <div className={`text-[12px] truncate ${active ? "text-white/70" : "text-[#6B6D76]"}`}>
                      ₹{r.amount?.toLocaleString("en-IN") ?? "—"} → {r.recipient || "—"}
                    </div>
                  </div>
                  <div className={`text-[12px] truncate pr-2 ${active ? "text-white/70" : "text-[#6B6D76]"}`}>{r.agentName}</div>
                  <div>
                    <span
                      className={[
                        "text-[9.5px] font-mono uppercase tracking-[0.06em] px-2 py-[3px]",
                        blocked ? "border border-[#C4172C] text-[#C4172C]" : "bg-[#C4172C] text-white",
                      ].join(" ")}
                    >
                      {r.status}
                    </span>
                  </div>
                  <div className={`text-[11px] font-mono ${active ? "text-white/50" : "text-[#B4B6BC]"}`}>{formatTime(r.createdAt)}</div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Forensic detail */}
        <div className="border border-[#E7E6E2] h-fit">
          <div className="flex items-center justify-between px-5 py-4 border-b border-[#E7E6E2]">
            <div>
              <div className="text-[10px] font-mono uppercase tracking-[0.1em] text-[#9A9CA4] mb-1">Forensic detail</div>
              <div className="text-[15px] font-semibold">Proof record</div>
            </div>
            <MoreHorizontal size={16} className="text-[#B4B6BC]" />
          </div>
          {!detail ? (
            <div className="p-5 flex items-center gap-2 text-[13px] text-[#6B6D76]"><Loader2 size={14} className="animate-spin" /> Loading…</div>
          ) : (
            <div className="p-5">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[12px] font-mono text-[#C4172C]">{(detail.proof?.id ?? detail.intent.id).slice(0, 16)}</span>
                <span
                  className={[
                    "text-[9.5px] font-mono uppercase tracking-[0.06em] px-2 py-[3px]",
                    detail.intent.status === "BLOCKED" ? "border border-[#C4172C] text-[#C4172C]" : "bg-[#C4172C] text-white",
                  ].join(" ")}
                >
                  {detail.intent.status}
                </span>
              </div>
              <div className="text-[20px] font-semibold text-[#14151A] mb-5" style={{ fontFamily: "Georgia, serif" }}>
                ₹{detail.intent.amount?.toLocaleString("en-IN") ?? "—"} to {detail.intent.recipient || "—"}
              </div>

              {[
                { icon: FileText, label: "Original intent", value: detail.intent.rawRequest },
                { icon: Layers, label: "Evidence set", value: `${detail.intent.evidenceRefs?.length ?? 0} reference(s) on file` },
                { icon: ShieldCheck, label: "Policy decision", value: detail.authorization ? `${detail.authorization.decision} · ${detail.authorization.reasonCodes.join(", ")}` : "pending" },
                { icon: Radio, label: "Provider event", value: detail.execution ? `${detail.execution.status.toLowerCase()} · test mode` : "not created" },
                { icon: Fingerprint, label: "Integrity hash", value: detail.proof?.decisionHash ?? "—" },
              ].map(({ icon: Icon, label, value }) => (
                <div key={label} className="flex items-start gap-3 py-3 border-b border-[#F0EFEC]">
                  <Icon size={14} className="text-[#B4B6BC] mt-0.5 shrink-0" />
                  <div className="min-w-0">
                    <div className="text-[10px] font-mono uppercase tracking-[0.06em] text-[#B4B6BC] mb-0.5">{label}</div>
                    <div className="text-[12.5px] font-mono text-[#14151A] break-words">{value}</div>
                  </div>
                </div>
              ))}

              {detail.proof ? (
                <>
                  <button
                    onClick={handleVerify}
                    disabled={verifying}
                    className="w-full mt-4 flex items-center justify-center gap-1.5 bg-[#C4172C] text-white text-[11px] font-mono uppercase tracking-[0.08em] px-4 py-2.5 hover:bg-[#A81225] transition-colors disabled:opacity-50"
                  >
                    {verifying ? <Loader2 size={13} className="animate-spin" /> : <ShieldCheck size={13} />}
                    {verifying ? "Verifying…" : "Verify proof"}
                  </button>
                  {verifyResult && (
                    <div className={`mt-3 px-4 py-3 text-[12.5px] border ${verifyResult.valid ? "border-[#B7E0C6] bg-[#F0FAF4] text-[#2C6E48]" : "border-[#F3CFCF] bg-[#FBEAEA] text-[#C4172C]"}`}>
                      {verifyResult.valid ? "Verified — recomputed hash matches on-chain record." : verifyResult.reasons.join(" ")}
                    </div>
                  )}
                </>
              ) : (
                <div className="mt-4 border border-[#EDECE8] bg-[#F6F6F4] px-4 py-3">
                  <div className="flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-[0.06em] text-[#9A9CA4] mb-2">
                    <Terminal size={11} /> No proof yet
                  </div>
                  <div className="text-[12px] text-[#6B6D76]">
                    This request hasn't reached a captured execution — no proof to verify.
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </Shell>
  );
}
