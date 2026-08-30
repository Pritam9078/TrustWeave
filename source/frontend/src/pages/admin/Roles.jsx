import { useState } from "react";
import { useApi, useMutation } from "../../lib/useApi.js";
import { api } from "../../lib/api.js";
import { useSession } from "../../state/session.jsx";
import {
  Card, PageHeader, Loading, ErrorState, DeniedState, Empty, Badge, Button,
  Field, Input, Textarea, Banner, WarnBanner, SuccessBanner,
} from "../../components/ui.jsx";

/**
 * Roles are bundles of capabilities; capabilities themselves are defined in server code
 * and are not user-editable. That asymmetry is deliberate — an admin can compose new
 * roles freely, but cannot invent a permission the enforcement layer has never heard of.
 */
export function Roles() {
  const { can } = useSession();
  const roles = useApi("/api/roles");
  const capabilities = useApi("/api/capabilities");
  const [selected, setSelected] = useState(null);
  const [creating, setCreating] = useState(false);

  if (roles.status === "loading") return <Loading />;
  if (roles.status === "denied") return <DeniedState error={roles.error} />;
  if (roles.status === "error") return <ErrorState error={roles.error} onRetry={roles.reload} />;

  const byDomain = {};
  for (const c of capabilities.data?.capabilities ?? []) {
    (byDomain[c.domain] ??= []).push(c);
  }

  return (
    <>
      <PageHeader
        title="Roles & Capabilities"
        description="Capabilities are fixed in code and mirrored into the database on boot. Roles combine them; nobody can create a capability from the UI."
        actions={can("ROLE_CREATE") && <Button size="sm" onClick={() => { setCreating(true); setSelected(null); }}>New role</Button>}
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Roles" className="lg:col-span-1">
          <ul className="space-y-1.5">
            {roles.data.roles.map((r) => (
              <li key={r.id}>
                <button
                  onClick={() => { setSelected(r); setCreating(false); }}
                  className={`w-full rounded-lg border px-3 py-2 text-left transition ${
                    selected?.id === r.id ? "border-slate-900 bg-slate-50" : "border-slate-200 hover:bg-slate-50"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium text-slate-900">{r.name}</span>
                    <Badge tone="INFO">v{r.version}</Badge>
                  </div>
                  <p className="mt-0.5 text-xs text-slate-500">{r.capabilities?.length ?? 0} capabilities</p>
                </button>
              </li>
            ))}
          </ul>
        </Card>

        <div className="lg:col-span-2">
          {creating ? (
            <RoleEditor byDomain={byDomain} onDone={() => { setCreating(false); roles.reload(); }} />
          ) : selected ? (
            <RoleEditor key={selected.id} role={selected} byDomain={byDomain} onDone={() => { roles.reload(); setSelected(null); }} />
          ) : (
            <Card><Empty title="Select a role" description="Choose a role to inspect or edit its capabilities." /></Card>
          )}
        </div>
      </div>
    </>
  );
}

function RoleEditor({ role, byDomain, onDone }) {
  const { can } = useSession();
  const editable = role ? can("ROLE_UPDATE") : can("ROLE_CREATE");
  const [name, setName] = useState(role?.name ?? "");
  const [description, setDescription] = useState(role?.description ?? "");
  const [caps, setCaps] = useState(role?.capabilities ?? []);

  const save = useMutation(() => role
    ? api.patch(`/api/roles/${role.id}`, { name, description, capabilities: caps })
    : api.post("/api/roles", { name: name.trim(), description, capabilities: caps }));

  const original = new Set(role?.capabilities ?? []);
  const added = caps.filter((c) => !original.has(c));
  const removed = [...original].filter((c) => !caps.includes(c));
  const privileged = added.filter((c) =>
    Object.values(byDomain).flat().find((d) => d.action === c)?.isPrivileged);

  const toggle = (action) => setCaps((cs) => cs.includes(action) ? cs.filter((c) => c !== action) : [...cs, action]);

  async function submit() {
    const outcome = await save.run();
    if (outcome.ok) onDone();
  }

  return (
    <Card
      title={role ? `Edit ${role.name}` : "New role"}
      description={role ? `Version ${role.version}. Changing capabilities bumps the version and is recorded as a diff.` : "Define a new role from existing capabilities."}
    >
      <div className="space-y-4">
        <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} disabled={!editable} required /></Field>
        <Field label="Description"><Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} disabled={!editable} /></Field>

        {privileged.length > 0 && (
          <WarnBanner>
            You are adding {privileged.length} privileged capability(s): {privileged.join(", ")}. Everyone holding
            this role gains them immediately.
          </WarnBanner>
        )}

        {(added.length > 0 || removed.length > 0) && (
          <Banner tone="info">
            Pending change: {added.length ? `+${added.length} added` : ""}{added.length && removed.length ? ", " : ""}
            {removed.length ? `−${removed.length} removed` : ""}. The diff is written to the audit trail.
          </Banner>
        )}

        <div className="space-y-3">
          {Object.entries(byDomain).map(([domain, list]) => (
            <div key={domain}>
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{domain}</p>
              <div className="mt-1 grid gap-1.5 sm:grid-cols-2">
                {list.map((c) => (
                  <label key={c.action} className={`flex items-start gap-2 rounded-lg border px-2.5 py-2 text-sm ${
                    caps.includes(c.action) ? "border-slate-900 bg-slate-50" : "border-slate-200"
                  } ${editable ? "cursor-pointer hover:bg-slate-50" : "opacity-70"}`}>
                    <input type="checkbox" className="mt-0.5" disabled={!editable} checked={caps.includes(c.action)} onChange={() => toggle(c.action)} />
                    <span>
                      <span className="font-mono text-xs font-medium text-slate-800">{c.action}</span>
                      {c.isPrivileged && <Badge tone="REQUIRE_APPROVAL">privileged</Badge>}
                      <span className="block text-xs text-slate-500">{c.description}</span>
                    </span>
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>

        {save.status === "denied" && <DeniedState error={save.error} />}
        {save.status === "error" && <ErrorState error={save.error} />}
        {save.status === "success" && <SuccessBanner>Saved.</SuccessBanner>}

        {editable && (
          <Button className="w-full" loading={save.status === "running"} onClick={submit}>
            {role ? "Save changes" : "Create role"}
          </Button>
        )}
      </div>
    </Card>
  );
}
