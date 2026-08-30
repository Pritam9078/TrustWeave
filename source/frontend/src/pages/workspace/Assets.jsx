import { useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { useApi, useMutation } from "../../lib/useApi.js";
import { api } from "../../lib/api.js";
import { useSession } from "../../state/session.jsx";
import {
  Card, PageHeader, Loading, ErrorState, DeniedState, Empty, Badge, Button, Table, Td,
  Field, Input, Textarea, Select, Banner, SuccessBanner,
} from "../../components/ui.jsx";
import { dateTime, relative, shortDid, shortHash } from "../../lib/format.js";

export function AssetList() {
  const navigate = useNavigate();
  const { can } = useSession();
  const { status, data, error, reload } = useApi("/api/assets");

  return (
    <>
      <PageHeader
        title="Assets"
        description="Organizational assets anchored on-chain as commitments. You see only those inside your scopes."
        actions={can("ASSET_CREATE") && <Link to="/app/assets/new"><Button size="sm">Register asset</Button></Link>}
      />
      <Card>
        {status === "loading" && <Loading />}
        {status === "denied" && <DeniedState error={error} />}
        {status === "error" && <ErrorState error={error} onRetry={reload} />}
        {status === "loaded" && (
          <Table
            columns={["Asset", "Type", "Owner", "Status", "Token", "Updated"]}
            rows={data.assets}
            onRowClick={(row) => navigate(`/app/assets/${row.id}`)}
            empty={<Empty title="No assets in your scope" description="Assets in departments you can access will appear here." />}
            renderRow={(a) => (
              <>
                <Td><span className="font-medium text-slate-900">{a.name}</span></Td>
                <Td className="text-slate-600">{a.assetType}</Td>
                <Td mono>{shortDid(a.ownerDid)}</Td>
                <Td><Badge>{a.status}</Badge></Td>
                <Td mono>{a.nftTokenId ? shortHash(a.nftTokenId) : "—"}</Td>
                <Td className="whitespace-nowrap text-slate-500">{relative(a.updatedAt)}</Td>
              </>
            )}
          />
        )}
      </Card>
    </>
  );
}

export function AssetCreate() {
  const navigate = useNavigate();
  const collections = useApi("/api/collections");
  const org = useApi("/api/organization");
  const [form, setForm] = useState({ name: "", assetType: "LAPTOP", collectionId: "", departmentId: "", ownerDid: "", metadata: "{}" });

  const create = useMutation(async () => {
    let metadata = {};
    try { metadata = JSON.parse(form.metadata || "{}"); }
    catch { throw new Error("Metadata must be valid JSON."); }
    return api.post("/api/assets", {
      name: form.name.trim(), assetType: form.assetType,
      collectionId: form.collectionId || null,
      departmentId: form.departmentId || null,
      ownerDid: form.ownerDid.trim() || null,
      metadata,
    });
  });

  async function submit(e) {
    e.preventDefault();
    const outcome = await create.run();
    if (outcome.ok) navigate(`/app/assets/${outcome.data.asset.id}`);
  }
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <>
      <PageHeader title="Register asset" description="Creates a draft. Minting anchors it on-chain as a separate, separately-authorized step." />
      <div className="max-w-2xl">
        <Card>
          <form onSubmit={submit} className="space-y-4">
            <Field label="Name"><Input value={form.name} onChange={set("name")} required placeholder="MacBook Pro 16in — NW-0417" /></Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Type"><Input value={form.assetType} onChange={set("assetType")} required /></Field>
              <Field label="Department">
                <Select value={form.departmentId} onChange={set("departmentId")}>
                  <option value="">No department</option>
                  {(org.data?.departments ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                </Select>
              </Field>
            </div>
            <Field label="Collection">
              <Select value={form.collectionId} onChange={set("collectionId")}>
                <option value="">No collection</option>
                {(collections.data?.collections ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
            </Field>
            <Field label="Owner DID" hint="Required before the asset can be minted.">
              <Input value={form.ownerDid} onChange={set("ownerDid")} placeholder="did:key:z6Mk…" spellCheck={false} />
            </Field>
            <Field label="Metadata" hint="Only a hash of this reaches the chain — the contents stay in the database.">
              <Textarea rows={4} value={form.metadata} onChange={set("metadata")} className="font-mono text-xs" />
            </Field>
            <Button type="submit" loading={create.status === "running"} className="w-full">Create draft</Button>
          </form>
          {create.status === "denied" && <div className="mt-4"><DeniedState error={create.error} /></div>}
          {create.status === "error" && <div className="mt-4"><ErrorState error={create.error} /></div>}
        </Card>
      </div>
    </>
  );
}

export function AssetDetail() {
  const { id } = useParams();
  const { can } = useSession();
  const { status, data, error, reload } = useApi(`/api/assets/${id}`);
  const [transferTo, setTransferTo] = useState("");
  const [reason, setReason] = useState("");

  const mint = useMutation(() => api.post(`/api/assets/${id}/mint`));
  const transfer = useMutation(() => api.post(`/api/assets/${id}/transfer`, { newOwnerDid: transferTo.trim(), reason }));
  const freeze = useMutation((frozen) => api.post(`/api/assets/${id}/freeze`, { frozen, reason }));
  const revoke = useMutation(() => api.post(`/api/assets/${id}/revoke`, { reason }));
  const verify = useMutation(() => api.get(`/api/assets/${id}/verify`));

  if (status === "loading") return <Loading />;
  if (status === "denied") return <DeniedState error={error} />;
  if (status === "error") return <ErrorState error={error} onRetry={reload} />;

  const { asset, history, proofs } = data;
  const run = async (m, ...args) => { const r = await m.run(...args); if (r.ok) reload(); };
  const anyError = [mint, transfer, freeze, revoke].find((m) => m.status === "denied" || m.status === "error");

  return (
    <>
      <PageHeader
        title={asset.name}
        description={`${asset.assetType}${asset.departmentName ? ` · ${asset.departmentName}` : ""}`}
        actions={<Link to="/app/assets"><Button variant="secondary" size="sm">Back</Button></Link>}
      />

      {anyError && (
        <div className="mb-4">
          {anyError.status === "denied" ? <DeniedState error={anyError.error} /> : <ErrorState error={anyError.error} />}
        </div>
      )}
      {mint.status === "success" && <div className="mb-4"><SuccessBanner>Minted on-chain. Transaction {mint.data?.receipt?.txHash}{mint.data?.receipt?.simulated ? " (simulated chain)" : ""}.</SuccessBanner></div>}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card title="Ownership history" description="Every state change, with the actor who caused it.">
            {history?.length ? (
              <ul className="divide-y divide-slate-100">
                {history.map((h) => (
                  <li key={h.id} className="py-2">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-medium text-slate-800">{h.eventType.replace(/_/g, " ")}</p>
                        <p className="text-xs text-slate-500">{h.actorName ?? "system"} · {dateTime(h.createdAt)}</p>
                      </div>
                      {h.txHash && <code className="font-mono text-xs text-slate-500">{shortHash(h.txHash)}</code>}
                    </div>
                  </li>
                ))}
              </ul>
            ) : <Empty title="No events yet" />}
          </Card>

          {verify.status === "success" && (
            <Card title="On-chain verification">
              <Banner tone={verify.data.verified ? "good" : "danger"}>
                {verify.data.verified
                  ? "The chain record matches the database exactly."
                  : `Mismatch detected: ${verify.data.reason}`}
              </Banner>
              <ul className="mt-3 space-y-1.5">
                {verify.data.checks.map((c, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm">
                    <span className={c.pass ? "text-emerald-600" : "text-rose-600"}>{c.pass ? "✓" : "✗"}</span>
                    <div><span className="font-medium text-slate-800">{c.name}</span> <span className="text-slate-500">— {c.detail}</span></div>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>

        <div className="space-y-4">
          <Card title="Status">
            <dl className="space-y-2">
              <Row label="Status" value={<Badge>{asset.status}</Badge>} />
              <Row label="Owner" value={shortDid(asset.ownerDid)} mono />
              <Row label="Token" value={asset.nftTokenId ? shortHash(asset.nftTokenId) : "not minted"} mono />
              <Row label="Metadata hash" value={shortHash(asset.metadataHash)} mono />
            </dl>
          </Card>

          <Card title="Actions">
            <div className="space-y-3">
              {asset.status === "DRAFT" && can("ASSET_MINT") && (
                <Button className="w-full" loading={mint.status === "running"} onClick={() => run(mint)}>Mint on-chain</Button>
              )}
              {can("PROOF_VERIFY") && asset.nftTokenId && (
                <Button variant="secondary" className="w-full" loading={verify.status === "running"} onClick={() => verify.run()}>Verify against chain</Button>
              )}

              {(can("ASSET_TRANSFER") || can("ASSET_FREEZE") || can("ASSET_REVOKE")) && (
                <div className="space-y-2 border-t border-slate-100 pt-3">
                  <Field label="Reason" hint="Recorded in the audit trail.">
                    <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why?" />
                  </Field>

                  {can("ASSET_TRANSFER") && asset.status === "ACTIVE" && (
                    <>
                      <Field label="Transfer to DID">
                        <Input value={transferTo} onChange={(e) => setTransferTo(e.target.value)} placeholder="did:key:z6Mk…" spellCheck={false} />
                      </Field>
                      <Button variant="secondary" className="w-full" disabled={!transferTo} loading={transfer.status === "running"} onClick={() => run(transfer)}>Transfer</Button>
                    </>
                  )}
                  {can("ASSET_FREEZE") && ["ACTIVE", "FROZEN"].includes(asset.status) && (
                    <Button variant="secondary" className="w-full" loading={freeze.status === "running"} onClick={() => run(freeze, asset.status !== "FROZEN")}>
                      {asset.status === "FROZEN" ? "Unfreeze" : "Freeze"}
                    </Button>
                  )}
                  {can("ASSET_REVOKE") && asset.status !== "REVOKED" && (
                    <Button variant="danger" className="w-full" loading={revoke.status === "running"} onClick={() => run(revoke)}>Revoke permanently</Button>
                  )}
                </div>
              )}
            </div>
          </Card>

          {proofs?.length > 0 && (
            <Card title="Proofs">
              <ul className="space-y-1.5">
                {proofs.map((p) => (
                  <li key={p.id} className="flex items-center justify-between gap-2">
                    <code className="truncate font-mono text-xs text-slate-600">{shortHash(p.commitment)}</code>
                    <Badge>{p.status}</Badge>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}

function Row({ label, value, mono }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className={`text-right text-sm text-slate-900 ${mono ? "break-all font-mono text-xs" : ""}`}>{value}</dd>
    </div>
  );
}
