import { useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { useApi, useMutation } from "../../lib/useApi.js";
import { api } from "../../lib/api.js";
import { useSession } from "../../state/session.jsx";
import {
  Card, PageHeader, Loading, ErrorState, DeniedState, Empty, Badge, Button,
  Table, Td, Field, Input, Textarea, Select, Banner, WarnBanner, SuccessBanner,
} from "../../components/ui.jsx";
import { dateTime, relative, shortHash, money } from "../../lib/format.js";

const RULE_TYPES = [
  { type: "AMOUNT_MAX", label: "Hard maximum amount", field: "value", hint: "Nothing above this is permitted, and approval cannot override it." },
  { type: "AMOUNT_MIN", label: "Minimum amount", field: "value" },
  { type: "APPROVAL_THRESHOLD", label: "Approval threshold", field: "value", hint: "Above this, a human must approve." },
  { type: "DUAL_APPROVAL_ABOVE", label: "Dual approval above", field: "value" },
  { type: "MERCHANT_ALLOWLIST", label: "Vendor allowlist", field: "values" },
  { type: "MERCHANT_BLOCKLIST", label: "Vendor blocklist", field: "values" },
  { type: "CURRENCY_ALLOWLIST", label: "Currency allowlist", field: "values" },
  { type: "REQUIRE_EVIDENCE", label: "Require evidence", field: "min" },
];

export function PolicyList() {
  const navigate = useNavigate();
  const { can } = useSession();
  const { status, data, error, reload } = useApi("/api/policies");

  return (
    <>
      <PageHeader
        title="Policies"
        description="Versioned and immutable once active. Editing creates a new version so every past decision can still be explained by the rules in force at the time."
        actions={can("POLICY_CREATE") && <Link to="/app/admin/policies/new"><Button size="sm">New policy</Button></Link>}
      />
      <Card>
        {status === "loading" && <Loading />}
        {status === "denied" && <DeniedState error={error} />}
        {status === "error" && <ErrorState error={error} onRetry={reload} />}
        {status === "loaded" && (
          <Table
            columns={["Policy", "Version", "Status", "Rules", "Hash", "Updated"]}
            rows={data.policies}
            onRowClick={(row) => navigate(`/app/admin/policies/${row.id}`)}
            empty={<Empty title="No policies" description="Without policies, only capability and scope checks apply." />}
            renderRow={(p) => (
              <>
                <Td>
                  <span className="font-medium text-slate-900">{p.name}</span>
                  <span className="block font-mono text-xs text-slate-500">{p.policyKey}</span>
                </Td>
                <Td mono>v{p.version}</Td>
                <Td><Badge>{p.status}</Badge></Td>
                <Td className="text-slate-600">{p.conditions?.rules?.length ?? 0}</Td>
                <Td mono className="text-slate-500">{shortHash(p.hash)}</Td>
                <Td className="whitespace-nowrap text-slate-500">{relative(p.updatedAt ?? p.createdAt)}</Td>
              </>
            )}
          />
        )}
      </Card>
    </>
  );
}

export function PolicyCreate() {
  const navigate = useNavigate();
  const [meta, setMeta] = useState({ policyKey: "", name: "", description: "" });
  const [rules, setRules] = useState([]);
  const [activate, setActivate] = useState(false);

  const create = useMutation(() => api.post("/api/policies", {
    policyKey: meta.policyKey.trim(), name: meta.name.trim(), description: meta.description,
    conditions: { rules }, appliesTo: {}, activate,
  }));

  async function submit(e) {
    e.preventDefault();
    const outcome = await create.run();
    if (outcome.ok) navigate(`/app/admin/policies/${outcome.data.policy.id}`);
  }

  return (
    <>
      <PageHeader title="New policy" description="Rules are evaluated together; a DENY always beats a REQUIRE_APPROVAL." />
      <div className="max-w-3xl space-y-4">
        <Card title="Identity">
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Key" hint="Stable identifier across versions."><Input value={meta.policyKey} onChange={(e) => setMeta((m) => ({ ...m, policyKey: e.target.value }))} required placeholder="payment-limits" /></Field>
              <Field label="Name"><Input value={meta.name} onChange={(e) => setMeta((m) => ({ ...m, name: e.target.value }))} required /></Field>
            </div>
            <Field label="Description"><Textarea rows={2} value={meta.description} onChange={(e) => setMeta((m) => ({ ...m, description: e.target.value }))} /></Field>
          </div>
        </Card>

        <RuleBuilder rules={rules} setRules={setRules} />

        <Card title="Activation">
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-0.5" checked={activate} onChange={(e) => setActivate(e.target.checked)} />
            <span>
              <span className="font-medium text-slate-800">Activate immediately</span>
              <span className="block text-xs text-slate-500">Active policies apply to every matching action from the moment they are saved.</span>
            </span>
          </label>
        </Card>

        {create.status === "denied" && <DeniedState error={create.error} />}
        {create.status === "error" && <ErrorState error={create.error} />}
        {create.data?.warnings?.length > 0 && (
          <WarnBanner>
            Conflicts detected: {create.data.warnings.join("; ")}
          </WarnBanner>
        )}
        <Button onClick={submit} loading={create.status === "running"} className="w-full">Create policy</Button>
      </div>
    </>
  );
}

export function PolicyDetail() {
  const { id } = useParams();
  const { can } = useSession();
  const { status, data, error, reload } = useApi(`/api/policies/${id}`);
  const activate = useMutation(() => api.post(`/api/policies/${id}/activate`));
  const disable = useMutation(() => api.post(`/api/policies/${id}/disable`));
  const [newRules, setNewRules] = useState(null);

  const createVersion = useMutation(() => api.post(`/api/policies/${data.policy.policyKey}/versions`, {
    conditions: { rules: newRules }, activate: true,
  }));

  if (status === "loading") return <Loading />;
  if (status === "denied") return <DeniedState error={error} />;
  if (status === "error") return <ErrorState error={error} onRetry={reload} />;

  const { policy, versions, decisionHistory } = data;
  const run = async (m) => { const r = await m.run(); if (r.ok) { reload(); setNewRules(null); } };

  return (
    <>
      <PageHeader
        title={policy.name}
        description={<span className="font-mono text-xs">{policy.policyKey} · v{policy.version} · {shortHash(policy.hash)}</span>}
        actions={<Link to="/app/admin/policies"><Button variant="secondary" size="sm">Back</Button></Link>}
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card title="Rules" description={policy.status === "ACTIVE" ? "Active versions are immutable. Editing creates a new version." : "This version is not active."}>
            {newRules ? (
              <>
                <RuleBuilder rules={newRules} setRules={setNewRules} embedded />
                {createVersion.status === "denied" && <div className="mt-3"><DeniedState error={createVersion.error} /></div>}
                <div className="mt-3 flex gap-2">
                  <Button loading={createVersion.status === "running"} onClick={() => run(createVersion)}>Save as v{policy.version + 1}</Button>
                  <Button variant="secondary" onClick={() => setNewRules(null)}>Cancel</Button>
                </div>
              </>
            ) : (
              <>
                <ul className="space-y-1.5">
                  {policy.conditions?.rules?.map((r, i) => (
                    <li key={i} className="rounded-lg border border-slate-200 px-3 py-2">
                      <div className="flex items-center gap-2">
                        <code className="font-mono text-xs font-medium text-slate-800">{r.type}</code>
                        {r.onFail && <Badge tone={r.onFail === "DENY" ? "DENY" : "REQUIRE_APPROVAL"}>{r.onFail}</Badge>}
                      </div>
                      <p className="mt-0.5 text-sm text-slate-600">
                        {r.value != null && `Value: ${typeof r.value === "number" && r.value > 1000 ? money(r.value) : r.value}`}
                        {r.values && `Values: ${r.values.join(", ")}`}
                        {r.min != null && `Minimum: ${r.min}`}
                      </p>
                    </li>
                  ))}
                </ul>
                {can("POLICY_UPDATE") && (
                  <Button variant="secondary" className="mt-3" onClick={() => setNewRules(policy.conditions?.rules ?? [])}>
                    Edit as new version
                  </Button>
                )}
              </>
            )}
          </Card>

          <Card title="Recent decisions" description="Where this policy actually changed an outcome.">
            {decisionHistory?.length ? (
              <ul className="divide-y divide-slate-100">
                {decisionHistory.slice(0, 12).map((d, i) => (
                  <li key={i} className="flex items-start justify-between gap-3 py-2">
                    <div>
                      <p className="text-sm font-medium text-slate-800">{d.action?.replace(/_/g, " ")}</p>
                      <p className="text-xs text-slate-500">{dateTime(d.timestamp)} · v{d.policyVersion}</p>
                    </div>
                    <Badge>{d.decision}</Badge>
                  </li>
                ))}
              </ul>
            ) : <Empty title="No decisions recorded yet" />}
          </Card>
        </div>

        <div className="space-y-4">
          <Card title="Status">
            <Badge>{policy.status}</Badge>
            <div className="mt-3 space-y-2">
              {policy.status !== "ACTIVE" && can("POLICY_ACTIVATE") && (
                <Button className="w-full" loading={activate.status === "running"} onClick={() => run(activate)}>Activate</Button>
              )}
              {policy.status === "ACTIVE" && can("POLICY_DISABLE") && (
                <Button variant="danger" className="w-full" loading={disable.status === "running"} onClick={() => run(disable)}>Disable</Button>
              )}
            </div>
            {(activate.status === "denied" || disable.status === "denied") && (
              <div className="mt-3"><DeniedState error={activate.error ?? disable.error} /></div>
            )}
          </Card>

          <Card title="Version history">
            <ul className="space-y-1.5">
              {versions?.map((v) => (
                <li key={v.id} className="flex items-center justify-between rounded-lg border border-slate-200 px-2.5 py-1.5">
                  <span className="text-sm text-slate-800">v{v.version}</span>
                  <div className="flex items-center gap-2">
                    <Badge>{v.status}</Badge>
                    <code className="font-mono text-xs text-slate-500">{shortHash(v.hash)}</code>
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
    </>
  );
}

function RuleBuilder({ rules, setRules, embedded }) {
  const [draft, setDraft] = useState({ type: "APPROVAL_THRESHOLD", value: "", values: "", onFail: "" });

  function addRule() {
    const spec = RULE_TYPES.find((r) => r.type === draft.type);
    const rule = { type: draft.type };
    if (spec.field === "value") rule.value = Number(draft.value);
    if (spec.field === "min") rule.min = Number(draft.value);
    if (spec.field === "values") rule.values = draft.values.split(",").map((v) => v.trim()).filter(Boolean);
    if (draft.onFail) rule.onFail = draft.onFail;
    setRules([...rules, rule]);
    setDraft({ type: draft.type, value: "", values: "", onFail: "" });
  }

  const spec = RULE_TYPES.find((r) => r.type === draft.type);
  const body = (
    <>
      {rules.length > 0 && (
        <ul className="mb-3 space-y-1.5">
          {rules.map((r, i) => (
            <li key={i} className="flex items-center justify-between rounded-lg border border-slate-200 px-2.5 py-1.5">
              <span className="text-sm">
                <code className="font-mono text-xs font-medium text-slate-800">{r.type}</code>
                <span className="text-slate-500"> {r.value ?? r.min ?? r.values?.join(", ")}</span>
                {r.onFail && <Badge tone={r.onFail === "DENY" ? "DENY" : "REQUIRE_APPROVAL"}>{r.onFail}</Badge>}
              </span>
              <Button size="sm" variant="ghost" onClick={() => setRules(rules.filter((_, j) => j !== i))}>Remove</Button>
            </li>
          ))}
        </ul>
      )}

      <div className="grid gap-2 sm:grid-cols-4">
        <Select value={draft.type} onChange={(e) => setDraft((d) => ({ ...d, type: e.target.value }))}>
          {RULE_TYPES.map((r) => <option key={r.type} value={r.type}>{r.label}</option>)}
        </Select>
        {spec.field === "values" ? (
          <Input placeholder="Comma separated" value={draft.values} onChange={(e) => setDraft((d) => ({ ...d, values: e.target.value }))} />
        ) : (
          <Input type="number" placeholder="Value" value={draft.value} onChange={(e) => setDraft((d) => ({ ...d, value: e.target.value }))} />
        )}
        <Select value={draft.onFail} onChange={(e) => setDraft((d) => ({ ...d, onFail: e.target.value }))}>
          <option value="">Default outcome</option>
          <option value="DENY">Deny</option>
          <option value="REQUIRE_APPROVAL">Require approval</option>
        </Select>
        <Button variant="secondary" onClick={addRule}>Add rule</Button>
      </div>
      {spec.hint && <p className="mt-1.5 text-xs text-slate-500">{spec.hint}</p>}
    </>
  );

  return embedded ? body : <Card title="Rules" description="Unknown rule types are rejected — the engine fails closed rather than ignoring what it cannot interpret.">{body}</Card>;
}
