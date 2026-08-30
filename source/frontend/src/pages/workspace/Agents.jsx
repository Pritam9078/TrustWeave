import { useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { Bot, ShieldAlert } from "lucide-react";
import { useApi, useMutation } from "../../lib/useApi.js";
import { api } from "../../lib/api.js";
import { useSession } from "../../state/session.jsx";
import {
  Card, PageHeader, Loading, ErrorState, DeniedState, Empty, Badge, Button, Table, Td,
  Field, Input, Select, Banner, SuccessBanner, WarnBanner, SecretReveal,
} from "../../components/ui.jsx";
import { money, dateTime, relative, shortDid } from "../../lib/format.js";

export function AgentList() {
  const navigate = useNavigate();
  const { can } = useSession();
  const { status, data, error, reload } = useApi("/api/agents");

  return (
    <>
      <PageHeader
        title="AI Agents"
        description="Agents hold their own identity and their own narrow capability set — never their owner's. Everything they attempt is re-authorized server-side."
        actions={can("AGENT_REGISTER") && <Link to="/app/agents/new"><Button size="sm">Register agent</Button></Link>}
      />
      <Card>
        {status === "loading" && <Loading />}
        {status === "denied" && <DeniedState error={error} />}
        {status === "error" && <ErrorState error={error} onRetry={reload} />}
        {status === "loaded" && (
          <Table
            columns={["Agent", "DID", "Status", "Tools", "Transaction limit", "Registered"]}
            rows={data.agents}
            onRowClick={(row) => navigate(`/app/agents/${row.id}`)}
            empty={<Empty title="No agents registered" description="Register an agent to let it act under policy." />}
            renderRow={(a) => (
              <>
                <Td><span className="font-medium text-slate-900">{a.name}</span></Td>
                <Td mono>{shortDid(a.did)}</Td>
                <Td><Badge>{a.status}</Badge></Td>
                <Td className="text-slate-600">{a.tools?.length ?? 0}</Td>
                <Td className="tabular-nums">{a.limits?.transactionLimit ? money(a.limits.transactionLimit) : "—"}</Td>
                <Td className="whitespace-nowrap text-slate-500">{relative(a.createdAt)}</Td>
              </>
            )}
          />
        )}
      </Card>
    </>
  );
}

export function AgentCreate() {
  const navigate = useNavigate();
  const capabilities = useApi("/api/capabilities");
  const tools = useApi("/api/agents/tools");
  const scopes = useApi("/api/scopes");
  const org = useApi("/api/organization");
  const { session } = useSession();

  const [form, setForm] = useState({
    name: "", departmentId: "", capabilities: [], tools: [], scopeIds: [],
    transactionLimit: "50000", approvalThreshold: "50000", dailyLimit: "200000", velocityCountPerDay: "10",
  });
  const [issued, setIssued] = useState(null);

  const create = useMutation(() => api.post("/api/agents", {
    name: form.name.trim(),
    departmentId: form.departmentId || null,
    capabilities: form.capabilities,
    tools: form.tools,
    scopeIds: form.scopeIds,
    limits: {
      transactionLimit: Number(form.transactionLimit) || undefined,
      approvalThreshold: Number(form.approvalThreshold) || undefined,
      dailyLimit: Number(form.dailyLimit) || undefined,
      velocityCountPerDay: Number(form.velocityCountPerDay) || undefined,
    },
  }));

  async function submit(e) {
    e.preventDefault();
    const outcome = await create.run();
    if (outcome.ok) setIssued(outcome.data);
  }

  const toggle = (key, value) => setForm((f) => ({
    ...f,
    [key]: f[key].includes(value) ? f[key].filter((v) => v !== value) : [...f[key], value],
  }));

  if (issued) {
    return (
      <>
        <PageHeader title="Agent registered" description={`${issued.agent.name} is active and constrained by the limits you set.`} />
        <div className="max-w-2xl space-y-4">
          <SecretReveal label="Agent key" value={issued.token} notice={issued.tokenNotice} />
          <Card title="Identity">
            <p className="text-sm text-slate-600">This agent has its own DID and its own identity record — it does not borrow yours.</p>
            <code className="mt-2 block break-all font-mono text-xs text-slate-700">{issued.agent.did}</code>
          </Card>
          <div className="flex gap-2">
            <Button onClick={() => navigate(`/app/agents/${issued.agent.id}`)}>Open agent</Button>
            <Button variant="secondary" onClick={() => navigate("/app/agents")}>Back to list</Button>
          </div>
        </div>
      </>
    );
  }

  // An admin cannot grant what they do not hold; the server enforces this, and showing
  // it here explains why some capabilities are unavailable rather than silently failing.
  const grantable = (capabilities.data?.capabilities ?? []).filter((c) => session?.capabilities?.includes(c.action));
  const ungrantable = (capabilities.data?.capabilities ?? []).length - grantable.length;

  return (
    <>
      <PageHeader title="Register AI agent" description="Capabilities and tools are separate containment layers: a tool is only usable if the agent also holds the capability behind it." />
      <div className="max-w-3xl space-y-4">
        <Card title="Identity">
          <div className="space-y-4">
            <Field label="Name"><Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} required placeholder="FinanceAgent-01" /></Field>
            <Field label="Department" hint="Scopes the agent to a part of the organization.">
              <Select value={form.departmentId} onChange={(e) => setForm((f) => ({ ...f, departmentId: e.target.value }))}>
                <option value="">No department</option>
                {(org.data?.departments ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </Select>
            </Field>
          </div>
        </Card>

        <Card title="Capabilities" description="What the agent is permitted to do at all.">
          {ungrantable > 0 && (
            <div className="mb-3">
              <WarnBanner>{ungrantable} capability(s) are hidden because you do not hold them yourself. You cannot grant an agent more authority than you have.</WarnBanner>
            </div>
          )}
          <div className="grid gap-1.5 sm:grid-cols-2">
            {grantable.map((c) => (
              <label key={c.action} className="flex items-start gap-2 rounded-lg border border-slate-200 px-2.5 py-2 text-sm hover:bg-slate-50">
                <input type="checkbox" className="mt-0.5" checked={form.capabilities.includes(c.action)} onChange={() => toggle("capabilities", c.action)} />
                <span>
                  <span className="font-mono text-xs font-medium text-slate-800">{c.action}</span>
                  <span className="block text-xs text-slate-500">{c.description}</span>
                </span>
              </label>
            ))}
          </div>
        </Card>

        <Card title="Tools" description="The closed allowlist this agent may call. A tool not listed here is refused even if the capability is held.">
          <div className="space-y-1.5">
            {(tools.data?.tools ?? []).map((t) => (
              <label key={t.name} className="flex items-start gap-2 rounded-lg border border-slate-200 px-2.5 py-2 text-sm hover:bg-slate-50">
                <input type="checkbox" className="mt-0.5" checked={form.tools.includes(t.name)} onChange={() => toggle("tools", t.name)} />
                <span className="flex-1">
                  <span className="font-mono text-xs font-medium text-slate-800">{t.name}</span>
                  {t.mutating && <Badge tone="REQUIRE_APPROVAL">mutating</Badge>}
                  <span className="block text-xs text-slate-500">{t.description} · needs {t.capability}</span>
                </span>
              </label>
            ))}
          </div>
        </Card>

        <Card title="Scopes">
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

        <Card title="Spending limits" description="The approval threshold is where human review begins; the transaction limit is a hard ceiling nothing crosses.">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Approval threshold (₹)"><Input type="number" value={form.approvalThreshold} onChange={(e) => setForm((f) => ({ ...f, approvalThreshold: e.target.value }))} /></Field>
            <Field label="Transaction ceiling (₹)"><Input type="number" value={form.transactionLimit} onChange={(e) => setForm((f) => ({ ...f, transactionLimit: e.target.value }))} /></Field>
            <Field label="Daily limit (₹)"><Input type="number" value={form.dailyLimit} onChange={(e) => setForm((f) => ({ ...f, dailyLimit: e.target.value }))} /></Field>
            <Field label="Calls per day"><Input type="number" value={form.velocityCountPerDay} onChange={(e) => setForm((f) => ({ ...f, velocityCountPerDay: e.target.value }))} /></Field>
          </div>
        </Card>

        {create.status === "denied" && <DeniedState error={create.error} />}
        {create.status === "error" && <ErrorState error={create.error} />}
        <Button onClick={submit} loading={create.status === "running"} className="w-full">Register agent</Button>
      </div>
    </>
  );
}

export function AgentDetail() {
  const { id } = useParams();
  const { can } = useSession();
  const { status, data, error, reload } = useApi(`/api/agents/${id}`);
  const [reason, setReason] = useState("");
  const freeze = useMutation((newStatus) => api.post(`/api/agents/${id}/freeze`, { status: newStatus, reason }));
  const rotate = useMutation(() => api.post(`/api/agents/${id}/rotate-token`));
  const chain = useApi(`/api/agents/${id}/on-chain`);

  if (status === "loading") return <Loading />;
  if (status === "denied") return <DeniedState error={error} />;
  if (status === "error") return <ErrorState error={error} onRetry={reload} />;

  const { agent, toolCalls } = data;
  const run = async (m, ...args) => { const r = await m.run(...args); if (r.ok) reload(); };

  return (
    <>
      <PageHeader
        title={agent.name}
        description={<span className="font-mono text-xs">{agent.did}</span>}
        actions={<Link to="/app/agents"><Button variant="secondary" size="sm">Back</Button></Link>}
      />

      {agent.status === "FROZEN" && (
        <div className="mb-4">
          <Banner tone="warn" icon={ShieldAlert}>
            This agent is frozen. Its credential still authenticates, so every attempt it makes is
            recorded and refused with a reason — which is more useful during an incident than
            silently dropping it at the door.
          </Banner>
        </div>
      )}
      {rotate.status === "success" && <div className="mb-4"><SecretReveal label="New agent key" value={rotate.data.token} notice={rotate.data.tokenNotice} /></div>}
      {freeze.status === "denied" && <div className="mb-4"><DeniedState error={freeze.error} /></div>}
      {freeze.status === "error" && <div className="mb-4"><ErrorState error={freeze.error} /></div>}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card title="Recent tool calls" description="Everything the agent attempted, allowed or refused.">
            {toolCalls?.length ? (
              <Table
                columns={["Tool", "Decision", "Reasons", "Latency", "When"]}
                rows={toolCalls}
                renderRow={(c) => (
                  <>
                    <Td mono>{c.tool}</Td>
                    <Td><Badge>{c.decision}</Badge></Td>
                    <Td className="text-xs text-slate-500">{c.reasonCodes?.join(", ") || "—"}</Td>
                    <Td className="tabular-nums text-slate-500">{c.latencyMs}ms</Td>
                    <Td className="whitespace-nowrap text-slate-500">{relative(c.createdAt)}</Td>
                  </>
                )}
              />
            ) : <Empty title="No tool calls yet" description="Calls will be recorded here as the agent works." />}
          </Card>

          {chain.data && (
            <Card title="On-chain state" description="Read directly from the registry, independent of the application database.">
              <dl className="grid gap-3 sm:grid-cols-2">
                <Row label="Adapter" value={<Badge tone={chain.data.adapterKind === "memory" ? "INFO" : "ALLOW"}>{chain.data.adapterKind}</Badge>} />
                <Row label="Registered" value={chain.data.onChain?.exists ? "yes" : "no"} />
                <Row label="Active on-chain" value={String(chain.data.onChain?.active)} />
                <Row label="Agrees with database" value={chain.data.statusAgrees === null ? "—" : chain.data.statusAgrees ? "yes" : "NO — investigate"} />
              </dl>
              <p className="mt-2 text-xs text-slate-500">{chain.data.note}</p>
            </Card>
          )}
        </div>

        <div className="space-y-4">
          <Card title="Configuration">
            <dl className="space-y-2">
              <Row label="Status" value={<Badge>{agent.status}</Badge>} />
              <Row label="Owner" value={agent.ownerName ?? "—"} />
              <Row label="Approval above" value={agent.limits?.approvalThreshold ? money(agent.limits.approvalThreshold) : "—"} />
              <Row label="Hard ceiling" value={agent.limits?.transactionLimit ? money(agent.limits.transactionLimit) : "—"} />
              <Row label="Daily limit" value={agent.limits?.dailyLimit ? money(agent.limits.dailyLimit) : "—"} />
            </dl>
            <div className="mt-3">
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Capabilities</p>
              <div className="mt-1 flex flex-wrap gap-1">
                {agent.capabilities?.map((c) => <code key={c} className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-700">{c}</code>)}
              </div>
            </div>
            <div className="mt-3">
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Tools</p>
              <div className="mt-1 flex flex-wrap gap-1">
                {agent.tools?.map((t) => <code key={t} className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-700">{t}</code>)}
              </div>
            </div>
          </Card>

          {(can("AGENT_FREEZE") || can("AGENT_CONFIGURE")) && agent.status !== "REVOKED" && (
            <Card title="Controls">
              <div className="space-y-3">
                <Field label="Reason"><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why?" /></Field>
                {can("AGENT_FREEZE") && (
                  <>
                    <Button variant="secondary" className="w-full" loading={freeze.status === "running"} onClick={() => run(freeze, agent.status === "FROZEN" ? "ACTIVE" : "FROZEN")}>
                      {agent.status === "FROZEN" ? "Resume agent" : "Pause agent"}
                    </Button>
                    <Button variant="danger" className="w-full" loading={freeze.status === "running"} onClick={() => run(freeze, "REVOKED")}>
                      Revoke permanently
                    </Button>
                  </>
                )}
                {can("AGENT_CONFIGURE") && (
                  <Button variant="ghost" className="w-full" loading={rotate.status === "running"} onClick={() => rotate.run()}>Rotate key</Button>
                )}
              </div>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}

function Row({ label, value }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="text-right text-sm text-slate-900">{value}</dd>
    </div>
  );
}
