import { useState } from "react";
import { useApi, useMutation } from "../../lib/useApi.js";
import { api } from "../../lib/api.js";
import { useSession } from "../../state/session.jsx";
import {
  Card, PageHeader, Loading, ErrorState, DeniedState, Empty, Badge, Button,
  Table, Td, Field, Input, Select, Banner,
} from "../../components/ui.jsx";

const SCOPE_TYPES = ["ORGANIZATION", "DEPARTMENT", "COLLECTION", "RESOURCE", "VENDOR"];

const SELECTOR_HELP = {
  ORGANIZATION: "Applies to everything in this organization. Leave the selector empty.",
  DEPARTMENT: "Choose the departments this scope covers.",
  COLLECTION: "Comma-separated collection ids.",
  RESOURCE: "Comma-separated resource ids — the narrowest possible scope.",
  VENDOR: "Comma-separated vendor names this scope permits.",
};

export default function Scopes() {
  const { can } = useSession();
  const scopes = useApi("/api/scopes");
  const org = useApi("/api/organization");
  const [creating, setCreating] = useState(false);

  return (
    <>
      <PageHeader
        title="Scopes"
        description="A capability says what you may do; a scope says where. Scope matching fails closed — a resource that matches no scope is refused, never allowed by default."
        actions={can("SCOPE_CREATE") && <Button size="sm" onClick={() => setCreating((c) => !c)}>{creating ? "Cancel" : "New scope"}</Button>}
      />

      {creating && <div className="mb-4"><ScopeForm departments={org.data?.departments ?? []} onDone={() => { setCreating(false); scopes.reload(); }} /></div>}

      <Card>
        {scopes.status === "loading" && <Loading />}
        {scopes.status === "denied" && <DeniedState error={scopes.error} />}
        {scopes.status === "error" && <ErrorState error={scopes.error} onRetry={scopes.reload} />}
        {scopes.status === "loaded" && (
          <Table
            columns={["Name", "Type", "Selector", "Constraints"]}
            rows={scopes.data.scopes}
            empty={<Empty title="No scopes defined" />}
            renderRow={(s) => (
              <>
                <Td><span className="font-medium text-slate-900">{s.name}</span></Td>
                <Td><Badge tone="INFO">{s.scopeType}</Badge></Td>
                <Td mono className="max-w-xs truncate text-slate-600">{JSON.stringify(s.selector)}</Td>
                <Td mono className="max-w-xs truncate text-slate-600">{Object.keys(s.constraints ?? {}).length ? JSON.stringify(s.constraints) : "—"}</Td>
              </>
            )}
          />
        )}
      </Card>
    </>
  );
}

function ScopeForm({ departments, onDone }) {
  const [form, setForm] = useState({ name: "", scopeType: "DEPARTMENT", selectorValues: [], maxAmount: "", windowFrom: "", windowTo: "" });

  const create = useMutation(() => {
    const selector =
      form.scopeType === "ORGANIZATION" ? {}
      : form.scopeType === "DEPARTMENT" ? { departmentIds: form.selectorValues }
      : form.scopeType === "COLLECTION" ? { collectionIds: form.selectorValues }
      : form.scopeType === "RESOURCE" ? { resourceIds: form.selectorValues }
      : { vendors: form.selectorValues };

    const constraints = {};
    if (form.maxAmount) constraints.maxAmount = Number(form.maxAmount);
    if (form.windowFrom && form.windowTo) constraints.timeWindow = { from: form.windowFrom, to: form.windowTo };

    return api.post("/api/scopes", { name: form.name.trim(), scopeType: form.scopeType, selector, constraints });
  });

  async function submit(e) {
    e.preventDefault();
    const outcome = await create.run();
    if (outcome.ok) onDone();
  }

  const isDept = form.scopeType === "DEPARTMENT";

  return (
    <Card title="New scope">
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name"><Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} required /></Field>
          <Field label="Type">
            <Select value={form.scopeType} onChange={(e) => setForm((f) => ({ ...f, scopeType: e.target.value, selectorValues: [] }))}>
              {SCOPE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </Select>
          </Field>
        </div>

        <Banner tone="info">{SELECTOR_HELP[form.scopeType]}</Banner>

        {form.scopeType !== "ORGANIZATION" && (
          isDept ? (
            <div className="grid gap-1.5 sm:grid-cols-2">
              {departments.map((d) => (
                <label key={d.id} className="flex items-center gap-2 rounded-lg border border-slate-200 px-2.5 py-2 text-sm hover:bg-slate-50">
                  <input
                    type="checkbox"
                    checked={form.selectorValues.includes(d.id)}
                    onChange={() => setForm((f) => ({
                      ...f,
                      selectorValues: f.selectorValues.includes(d.id) ? f.selectorValues.filter((v) => v !== d.id) : [...f.selectorValues, d.id],
                    }))}
                  />
                  {d.name}
                </label>
              ))}
            </div>
          ) : (
            <Field label="Values" hint="Comma separated.">
              <Input
                value={form.selectorValues.join(", ")}
                onChange={(e) => setForm((f) => ({ ...f, selectorValues: e.target.value.split(",").map((v) => v.trim()).filter(Boolean) }))}
              />
            </Field>
          )
        )}

        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Max amount (₹)" hint="Optional ceiling."><Input type="number" value={form.maxAmount} onChange={(e) => setForm((f) => ({ ...f, maxAmount: e.target.value }))} /></Field>
          <Field label="Window from"><Input type="time" value={form.windowFrom} onChange={(e) => setForm((f) => ({ ...f, windowFrom: e.target.value }))} /></Field>
          <Field label="Window to"><Input type="time" value={form.windowTo} onChange={(e) => setForm((f) => ({ ...f, windowTo: e.target.value }))} /></Field>
        </div>

        {create.status === "denied" && <DeniedState error={create.error} />}
        {create.status === "error" && <ErrorState error={create.error} />}
        <Button type="submit" loading={create.status === "running"} className="w-full">Create scope</Button>
      </form>
    </Card>
  );
}
