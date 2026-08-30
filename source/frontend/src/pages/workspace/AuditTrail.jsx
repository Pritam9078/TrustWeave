import { useState } from "react";
import { ShieldCheck, ShieldAlert, Download } from "lucide-react";
import { useApi } from "../../lib/useApi.js";
import { api, API_BASE, getToken } from "../../lib/api.js";
import {
  Card, PageHeader, Loading, ErrorState, DeniedState, Empty, Badge, Button,
  Table, Td, Banner, Select, Input,
} from "../../components/ui.jsx";
import { dateTime, shortHash, titleCase } from "../../lib/format.js";

export function AuditTrail() {
  const [filters, setFilters] = useState({ decision: "", action: "", traceId: "" });
  const query = new URLSearchParams(Object.entries(filters).filter(([, v]) => v)).toString();
  const { status, data, error, reload } = useApi(`/api/audit/events${query ? `?${query}` : ""}`);
  const [selected, setSelected] = useState(null);

  async function exportCsv() {
    // Fetched with the session token rather than a plain link, so the export obeys the
    // same capability check as everything else instead of being an open URL.
    const response = await fetch(`${API_BASE}/api/audit/export`, { headers: { authorization: `Bearer ${getToken()}` } });
    if (!response.ok) return;
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `trustweave-audit-${Date.now()}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <PageHeader
        title="Audit Trail"
        description="Append-only and hash-linked. Every entry commits to the one before it, so any alteration breaks the chain and is detectable."
        actions={<Button size="sm" variant="secondary" onClick={exportCsv}><Download className="h-3.5 w-3.5" aria-hidden="true" /> Export CSV</Button>}
      />

      {data?.chain && (
        <div className="mb-4">
          {data.chain.valid ? (
            <Banner tone="good" icon={ShieldCheck}>
              Chain verified — {data.chain.eventCount} events linked from genesis. Head {shortHash(data.chain.headHash)}.
            </Banner>
          ) : (
            <Banner tone="danger" icon={ShieldAlert}>
              <strong>Chain verification failed at sequence {data.chain.brokenAtSeq}.</strong> {data.chain.reason}
            </Banner>
          )}
        </div>
      )}

      <Card>
        <div className="mb-4 grid gap-2 sm:grid-cols-3">
          <Select value={filters.decision} onChange={(e) => setFilters((f) => ({ ...f, decision: e.target.value }))}>
            <option value="">All decisions</option>
            {["ALLOW", "DENY", "REQUIRE_APPROVAL", "EXECUTED", "INFO", "FAILED"].map((d) => <option key={d} value={d}>{titleCase(d)}</option>)}
          </Select>
          <Input placeholder="Filter by action…" value={filters.action} onChange={(e) => setFilters((f) => ({ ...f, action: e.target.value }))} />
          <Input placeholder="Filter by trace id…" value={filters.traceId} onChange={(e) => setFilters((f) => ({ ...f, traceId: e.target.value }))} />
        </div>

        {status === "loading" && <Loading />}
        {status === "denied" && <DeniedState error={error} />}
        {status === "error" && <ErrorState error={error} onRetry={reload} />}
        {status === "loaded" && (
          <Table
            columns={["Seq", "Time", "Actor", "Action", "Resource", "Decision", "Hash"]}
            rows={data.events}
            onRowClick={setSelected}
            empty={<Empty title="No matching events" />}
            renderRow={(e) => (
              <>
                <Td mono>{e.seq}</Td>
                <Td className="whitespace-nowrap text-slate-500">{dateTime(e.timestamp)}</Td>
                <Td>{e.actorName ?? e.actorDid ?? "system"}</Td>
                <Td><span className="font-medium text-slate-800">{titleCase(e.action)}</span></Td>
                <Td className="text-slate-600">{e.resourceType}{e.resourceId ? ` · ${e.resourceId.slice(0, 12)}…` : ""}</Td>
                <Td><Badge>{e.decision}</Badge></Td>
                <Td mono className="text-slate-500">{shortHash(e.eventHash)}</Td>
              </>
            )}
          />
        )}
      </Card>

      {selected && (
        <div className="mt-4">
          <Card title="Event detail" actions={<Button size="sm" variant="ghost" onClick={() => setSelected(null)}>Close</Button>}>
            <dl className="grid gap-3 sm:grid-cols-2">
              <Detail label="Sequence" value={selected.seq} />
              <Detail label="Timestamp" value={dateTime(selected.timestamp)} />
              <Detail label="Actor" value={`${selected.actorName ?? "system"} (${selected.actorKind ?? "—"})`} />
              <Detail label="Actor DID" value={<code className="break-all font-mono text-xs">{selected.actorDid ?? "—"}</code>} />
              <Detail label="Decision" value={<Badge>{selected.decision}</Badge>} />
              <Detail label="Policy" value={selected.policyId ? `${selected.policyId} v${selected.policyVersion}` : "—"} />
              <Detail label="Trace" value={<code className="break-all font-mono text-xs">{selected.traceId}</code>} />
              <Detail label="Previous hash" value={<code className="break-all font-mono text-xs">{selected.previousHash ?? "genesis"}</code>} />
            </dl>
            {selected.reasonCodes?.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1">
                {selected.reasonCodes.map((r) => <span key={r} className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-600">{r}</span>)}
              </div>
            )}
            {selected.payload && (
              <pre className="mt-3 overflow-x-auto rounded-lg bg-slate-900 p-3 font-mono text-xs text-slate-100">
                {JSON.stringify(selected.payload, null, 2)}
              </pre>
            )}
          </Card>
        </div>
      )}
    </>
  );
}

export function Proofs() {
  const { status, data, error, reload } = useApi("/api/proofs");
  const [verified, setVerified] = useState({});

  async function verify(proofId) {
    try {
      setVerified((v) => ({ ...v, [proofId]: { loading: true } }));
      const result = await api.post(`/api/proofs/${proofId}/verify`, {});
      setVerified((v) => ({ ...v, [proofId]: result }));
    } catch (err) {
      setVerified((v) => ({ ...v, [proofId]: { verified: false, error: err.message } }));
    }
  }

  return (
    <>
      <PageHeader
        title="Proofs"
        description="Cryptographic anchors for selected records. A proof shows a record existed and is unaltered — it does not attest that the underlying decision was correct."
      />
      <Card>
        {status === "loading" && <Loading />}
        {status === "denied" && <DeniedState error={error} />}
        {status === "error" && <ErrorState error={error} onRetry={reload} />}
        {status === "loaded" && (
          data.proofs.length ? (
            <ul className="space-y-2">
              {data.proofs.map((p) => {
                const result = verified[p.id];
                return (
                  <li key={p.id} className="rounded-lg border border-slate-200 px-3 py-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-slate-800">{titleCase(p.subjectType)} · {p.subjectId?.slice(0, 20)}…</p>
                        <code className="mt-0.5 block break-all font-mono text-xs text-slate-500">{p.commitment}</code>
                        {p.txHash && <code className="mt-0.5 block break-all font-mono text-xs text-slate-500">tx {p.txHash}</code>}
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge>{p.status}</Badge>
                        <Button size="sm" variant="secondary" loading={result?.loading} onClick={() => verify(p.id)}>Verify</Button>
                      </div>
                    </div>

                    {result && !result.loading && (
                      <div className="mt-3">
                        <Banner tone={result.verified ? "good" : "danger"} icon={result.verified ? ShieldCheck : ShieldAlert}>
                          {result.verified ? "All checks passed." : `Verification failed. ${result.error ?? ""}`}
                        </Banner>
                        {result.checks && (
                          <ul className="mt-2 space-y-1">
                            {result.checks.map((c, i) => (
                              <li key={i} className="flex items-start gap-2 text-sm">
                                <span className={c.pass ? "text-emerald-600" : "text-rose-600"}>{c.pass ? "✓" : "✗"}</span>
                                <div><span className="font-medium text-slate-800">{c.name}</span> <span className="text-slate-500">— {c.detail}</span></div>
                              </li>
                            ))}
                          </ul>
                        )}
                        {result.scope && <p className="mt-2 text-xs text-slate-500">{result.scope}</p>}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : <Empty title="No proofs anchored yet" description="Minting an asset or executing a payment anchors a proof." />
        )}
      </Card>
    </>
  );
}

function Detail({ label, value }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-0.5 text-sm text-slate-900">{value}</dd>
    </div>
  );
}
