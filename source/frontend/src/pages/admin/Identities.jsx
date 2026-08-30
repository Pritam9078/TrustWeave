import { useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { useApi, useMutation } from "../../lib/useApi.js";
import { api } from "../../lib/api.js";
import { useSession } from "../../state/session.jsx";
import {
  Card, PageHeader, Loading, ErrorState, DeniedState, Empty, Badge, Button, Table, Td,
  Field, Input, Select, Banner, SecretReveal, WarnBanner,
} from "../../components/ui.jsx";
import { dateTime, relative, shortDid, titleCase } from "../../lib/format.js";

export function IdentityList() {
  const navigate = useNavigate();
  const { can } = useSession();
  const { status, data, error, reload } = useApi("/api/identities");

  return (
    <>
      <PageHeader
        title="Identities"
        description="Every person and service holds a DID. Visibility here follows the same scope rules as everything else."
        actions={can("IDENTITY_CREATE") && <Link to="/app/admin/identities/new"><Button size="sm">Create identity</Button></Link>}
      />

      {data?.scopeFiltered && (
        <div className="mb-4">
          <Banner tone="info">
            You are seeing {data.identities.length} identity(s) within your scopes. {data.hiddenByScope} are hidden
            because they belong to departments you cannot access.
          </Banner>
        </div>
      )}

      <Card>
        {status === "loading" && <Loading />}
        {status === "denied" && <DeniedState error={error} />}
        {status === "error" && <ErrorState error={error} onRetry={reload} />}
        {status === "loaded" && (
          <Table
            columns={["Name", "DID", "Kind", "Status", "Created"]}
            rows={data.identities}
            onRowClick={(row) => navigate(`/app/admin/identities/${row.id}`)}
            empty={<Empty title="No identities visible" />}
            renderRow={(i) => (
              <>
                <Td>
                  <span className="font-medium text-slate-900">{i.displayName}</span>
                  {i.email && <span className="block text-xs text-slate-500">{i.email}</span>}
                </Td>
                <Td mono>{shortDid(i.did)}</Td>
                <Td className="text-slate-600">{titleCase(i.kind)}</Td>
                <Td><Badge>{i.status}</Badge></Td>
                <Td className="whitespace-nowrap text-slate-500">{relative(i.createdAt)}</Td>
              </>
            )}
          />
        )}
      </Card>
    </>
  );
}

export function IdentityCreate() {
  const navigate = useNavigate();
  const roles = useApi("/api/roles");
  const scopes = useApi("/api/scopes");
  const org = useApi("/api/organization");
  const [form, setForm] = useState({ displayName: "", email: "", kind: "HUMAN", departmentId: "", password: "", roleIds: [], scopeIds: [] });
  const [issued, setIssued] = useState(null);

  const create = useMutation(() => api.post("/api/identities", {
    displayName: form.displayName.trim(),
    email: form.email.trim() || null,
    kind: form.kind,
    departmentId: form.departmentId || null,
    password: form.password || undefined,
    roleIds: form.roleIds,
    scopeIds: form.scopeIds,
  }));

  async function submit(e) {
    e.preventDefault();
    const outcome = await create.run();
    if (outcome.ok) setIssued(outcome.data);
  }
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const toggle = (k, v) => setForm((f) => ({ ...f, [k]: f[k].includes(v) ? f[k].filter((x) => x !== v) : [...f[k], v] }));

  if (issued) {
    return (
      <>
        <PageHeader title="Identity created" description={`${issued.identity.displayName} can now sign in.`} />
        <div className="max-w-2xl space-y-4">
          {issued.privateKey && <SecretReveal label="Private key" value={issued.privateKey} notice={issued.privateKeyNotice} />}
          <Card title="DID">
            <code className="block break-all font-mono text-xs text-slate-700">{issued.identity.did}</code>
          </Card>
          <div className="flex gap-2">
            <Button onClick={() => navigate(`/app/admin/identities/${issued.identity.id}`)}>Open identity</Button>
            <Button variant="secondary" onClick={() => navigate("/app/admin/identities")}>Back to list</Button>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Create identity" description="A keypair is generated server-side. The private key is shown once and never stored." />
      <div className="max-w-2xl space-y-4">
        <Card title="Details">
          <div className="space-y-4">
            <Field label="Display name"><Input value={form.displayName} onChange={set("displayName")} required /></Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Email"><Input type="email" value={form.email} onChange={set("email")} /></Field>
              <Field label="Kind">
                <Select value={form.kind} onChange={set("kind")}>
                  <option value="HUMAN">Human</option>
                  <option value="SERVICE">Service</option>
                </Select>
              </Field>
            </div>
            <Field label="Department">
              <Select value={form.departmentId} onChange={set("departmentId")}>
                <option value="">No department</option>
                {(org.data?.departments ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </Select>
            </Field>
            <Field label="Development password" hint="Optional. Only usable while password sign-in is enabled; DID signature is the real path.">
              <Input type="password" value={form.password} onChange={set("password")} minLength={8} />
            </Field>
          </div>
        </Card>

        <Card title="Roles" description="Capabilities come from roles. Assigning none leaves the identity able to sign in but do nothing.">
          <div className="grid gap-1.5 sm:grid-cols-2">
            {(roles.data?.roles ?? []).map((r) => (
              <label key={r.id} className="flex items-start gap-2 rounded-lg border border-slate-200 px-2.5 py-2 text-sm hover:bg-slate-50">
                <input type="checkbox" className="mt-0.5" checked={form.roleIds.includes(r.id)} onChange={() => toggle("roleIds", r.id)} />
                <span>
                  <span className="font-medium text-slate-800">{r.name}</span>
                  <span className="block text-xs text-slate-500">{r.capabilities?.length ?? 0} capabilities</span>
                </span>
              </label>
            ))}
          </div>
        </Card>

        <Card title="Scopes" description="Which resources those capabilities apply to.">
          <div className="grid gap-1.5 sm:grid-cols-2">
            {(scopes.data?.scopes ?? []).map((s) => (
              <label key={s.id} className="flex items-start gap-2 rounded-lg border border-slate-200 px-2.5 py-2 text-sm hover:bg-slate-50">
                <input type="checkbox" className="mt-0.5" checked={form.scopeIds.includes(s.id)} onChange={() => toggle("scopeIds", s.id)} />
                <span>
                  <span className="font-medium text-slate-800">{s.name}</span>
                  <span className="block text-xs text-slate-500">{s.scopeType}</span>
                </span>
              </label>
            ))}
          </div>
        </Card>

        {create.status === "denied" && <DeniedState error={create.error} />}
        {create.status === "error" && <ErrorState error={create.error} />}
        <Button onClick={submit} loading={create.status === "running"} className="w-full">Create identity</Button>
      </div>
    </>
  );
}

export function IdentityDetail() {
  const { id } = useParams();
  const { can, session } = useSession();
  const { status, data, error, reload } = useApi(`/api/identities/${id}`);
  const roles = useApi("/api/roles");
  const scopes = useApi("/api/scopes");
  const [reason, setReason] = useState("");

  const setStatus = useMutation((s) => api.patch(`/api/identities/${id}/status`, { status: s, reason }));
  const addRole = useMutation((roleId) => api.post(`/api/identities/${id}/roles`, { roleId }));
  const removeRole = useMutation((roleId) => api.del(`/api/identities/${id}/roles/${roleId}`));
  const addScope = useMutation((scopeId) => api.post(`/api/identities/${id}/scopes`, { scopeId }));
  const removeScope = useMutation((scopeId) => api.del(`/api/identities/${id}/scopes/${scopeId}`));

  if (status === "loading") return <Loading />;
  if (status === "denied") return <DeniedState error={error} />;
  if (status === "error") return <ErrorState error={error} onRetry={reload} />;

  const { identity, effectivePermissions, recentActivity } = data;
  const isSelf = identity.id === session?.identity?.id;
  const run = async (m, ...args) => { const r = await m.run(...args); if (r.ok) reload(); };
  const anyError = [setStatus, addRole, removeRole, addScope, removeScope].find((m) => m.status === "denied" || m.status === "error");

  const heldRoleIds = new Set((effectivePermissions?.roles ?? []).map((r) => r.id));
  const heldScopeIds = new Set((effectivePermissions?.scopes ?? []).map((s) => s.id));

  return (
    <>
      <PageHeader
        title={identity.displayName}
        description={<span className="font-mono text-xs">{identity.did}</span>}
        actions={<Link to="/app/admin/identities"><Button variant="secondary" size="sm">Back</Button></Link>}
      />

      {anyError && <div className="mb-4">{anyError.status === "denied" ? <DeniedState error={anyError.error} /> : <ErrorState error={anyError.error} />}</div>}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card title="Effective permissions" description="Recomputed live from roles and scopes — never read from a stored snapshot.">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Capabilities ({effectivePermissions?.capabilities?.length ?? 0})</p>
              <div className="mt-1.5 flex flex-wrap gap-1">
                {effectivePermissions?.capabilities?.length
                  ? effectivePermissions.capabilities.map((c) => <code key={c} className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-700">{c}</code>)
                  : <span className="text-sm text-slate-500">None — this identity can sign in but do nothing.</span>}
              </div>
            </div>
            <div className="mt-4">
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Scopes</p>
              <div className="mt-1.5 space-y-1">
                {effectivePermissions?.scopes?.length
                  ? effectivePermissions.scopes.map((s) => (
                      <div key={s.id} className="flex items-center justify-between rounded-lg border border-slate-200 px-2.5 py-1.5">
                        <span className="text-sm text-slate-800">{s.name} <span className="text-xs text-slate-500">({s.scopeType})</span></span>
                        {can("SCOPE_ASSIGN") && <Button size="sm" variant="ghost" onClick={() => run(removeScope, s.id)}>Remove</Button>}
                      </div>
                    ))
                  : <span className="text-sm text-slate-500">No scopes — every scoped action will be denied.</span>}
              </div>
            </div>
          </Card>

          <Card title="Recent activity">
            {recentActivity?.length ? (
              <ul className="divide-y divide-slate-100">
                {recentActivity.slice(0, 12).map((e) => (
                  <li key={e.id} className="flex items-start justify-between gap-3 py-2">
                    <div>
                      <p className="text-sm font-medium text-slate-800">{titleCase(e.action)}</p>
                      <p className="text-xs text-slate-500">{dateTime(e.timestamp)}</p>
                    </div>
                    <Badge>{e.decision}</Badge>
                  </li>
                ))}
              </ul>
            ) : <Empty title="No recorded activity" />}
          </Card>
        </div>

        <div className="space-y-4">
          <Card title="Status">
            <Badge>{identity.status}</Badge>
            {can("IDENTITY_SUSPEND") && (
              <div className="mt-3 space-y-2">
                {isSelf ? (
                  <WarnBanner>You cannot suspend or revoke your own identity. Ask another administrator.</WarnBanner>
                ) : (
                  <>
                    <Field label="Reason"><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why?" /></Field>
                    {identity.status === "ACTIVE" && <Button variant="secondary" className="w-full" onClick={() => run(setStatus, "SUSPENDED")}>Suspend</Button>}
                    {identity.status === "SUSPENDED" && <Button variant="secondary" className="w-full" onClick={() => run(setStatus, "ACTIVE")}>Reactivate</Button>}
                    {identity.status !== "REVOKED" && <Button variant="danger" className="w-full" onClick={() => run(setStatus, "REVOKED")}>Revoke permanently</Button>}
                    <p className="text-xs text-slate-500">Suspending or revoking immediately invalidates all live sessions.</p>
                  </>
                )}
              </div>
            )}
          </Card>

          {can("ROLE_ASSIGN") && (
            <Card title="Roles">
              <div className="space-y-1.5">
                {(roles.data?.roles ?? []).map((r) => (
                  <div key={r.id} className="flex items-center justify-between rounded-lg border border-slate-200 px-2.5 py-1.5">
                    <span className="text-sm text-slate-800">{r.name}</span>
                    {heldRoleIds.has(r.id)
                      ? <Button size="sm" variant="ghost" onClick={() => run(removeRole, r.id)}>Remove</Button>
                      : <Button size="sm" variant="secondary" onClick={() => run(addRole, r.id)}>Assign</Button>}
                  </div>
                ))}
              </div>
            </Card>
          )}

          {can("SCOPE_ASSIGN") && (
            <Card title="Add scope">
              <div className="space-y-1.5">
                {(scopes.data?.scopes ?? []).filter((s) => !heldScopeIds.has(s.id)).map((s) => (
                  <div key={s.id} className="flex items-center justify-between rounded-lg border border-slate-200 px-2.5 py-1.5">
                    <span className="text-sm text-slate-800">{s.name}</span>
                    <Button size="sm" variant="secondary" onClick={() => run(addScope, s.id)}>Add</Button>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
