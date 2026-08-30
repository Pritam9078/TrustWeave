import { useState } from "react";
import { Gauge } from "lucide-react";
import { useApi, useMutation } from "../../lib/useApi.js";
import { api } from "../../lib/api.js";
import {
  Card, PageHeader, Empty, Badge, Button, Field, Input, Select,
  Banner, DeniedState, ErrorState, EvaluationTrace,
} from "../../components/ui.jsx";

/**
 * "What would happen if X tried Y?" answered without doing it.
 *
 * This runs the real engine against a hypothetical, using the non-auditing `check`
 * path so a simulation never mutates state or leaves a misleading ALLOW in the audit
 * trail. It is the fastest way to understand why a permission model behaves as it does
 * — and the fastest way to catch a scope you thought you had granted but hadn't.
 */
export default function Simulator() {
  const identities = useApi("/api/identities");
  const agents = useApi("/api/agents");
  const capabilities = useApi("/api/capabilities");
  const org = useApi("/api/organization");

  const [form, setForm] = useState({
    subjectKind: "identity", subjectId: "", action: "PAYMENT_CREATE",
    resourceType: "PAYMENT", departmentId: "", amount: "", merchant: "", currency: "INR",
  });
  const [result, setResult] = useState(null);

  const simulate = useMutation(() => api.post("/api/authorize/simulate", {
    ...(form.subjectKind === "identity" ? { identityId: form.subjectId } : { agentId: form.subjectId }),
    action: form.action,
    resource: {
      type: form.resourceType,
      departmentId: form.departmentId || null,
      vendor: form.merchant || null,
    },
    context: {
      ...(form.amount ? { amount: Number(form.amount) } : {}),
      ...(form.merchant ? { merchant: form.merchant } : {}),
      currency: form.currency,
    },
  }));

  async function run(e) {
    e.preventDefault();
    const outcome = await simulate.run();
    if (outcome.ok) setResult(outcome.data);
  }

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <>
      <PageHeader
        title="Permission Simulator"
        description="Test an authorization decision without performing it. Nothing is mutated and nothing misleading is written to the audit trail."
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Hypothetical">
          <form onSubmit={run} className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Subject kind">
                <Select value={form.subjectKind} onChange={(e) => setForm((f) => ({ ...f, subjectKind: e.target.value, subjectId: "" }))}>
                  <option value="identity">Person</option>
                  <option value="agent">AI agent</option>
                </Select>
              </Field>
              <Field label="Subject">
                <Select value={form.subjectId} onChange={set("subjectId")} required>
                  <option value="">Select…</option>
                  {form.subjectKind === "identity"
                    ? (identities.data?.identities ?? []).map((i) => <option key={i.id} value={i.id}>{i.displayName}</option>)
                    : (agents.data?.agents ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </Select>
              </Field>
            </div>

            <Field label="Action">
              <Select value={form.action} onChange={set("action")}>
                {(capabilities.data?.capabilities ?? []).map((c) => <option key={c.action} value={c.action}>{c.action}</option>)}
              </Select>
            </Field>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Resource type"><Input value={form.resourceType} onChange={set("resourceType")} /></Field>
              <Field label="Resource department">
                <Select value={form.departmentId} onChange={set("departmentId")}>
                  <option value="">No department</option>
                  {(org.data?.departments ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                </Select>
              </Field>
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Amount (₹)"><Input type="number" value={form.amount} onChange={set("amount")} /></Field>
              <Field label="Vendor"><Input value={form.merchant} onChange={set("merchant")} /></Field>
              <Field label="Currency"><Input value={form.currency} onChange={set("currency")} maxLength={3} /></Field>
            </div>

            <Button type="submit" loading={simulate.status === "running"} className="w-full">
              <Gauge className="h-3.5 w-3.5" aria-hidden="true" /> Simulate
            </Button>
          </form>

          {simulate.status === "denied" && <div className="mt-4"><DeniedState error={simulate.error} /></div>}
          {simulate.status === "error" && <div className="mt-4"><ErrorState error={simulate.error} /></div>}
        </Card>

        <Card title="Result" description="The full ordered gate sequence the engine walked.">
          {!result ? (
            <Empty title="No simulation yet" description="Pick a subject and an action to see exactly how the engine would decide." />
          ) : (
            <div className="space-y-4">
              <Banner tone={result.result.decision === "ALLOW" ? "good" : result.result.decision === "DENY" ? "danger" : "warn"}>
                <strong>{result.result.decision}</strong>
                {result.result.reasonCodes?.length > 0 && ` — ${result.result.reasonCodes.join(", ")}`}
              </Banner>

              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Subject</p>
                <p className="mt-1 text-sm text-slate-800">
                  {result.subject.kind} · roles: {result.subject.roles?.join(", ") || "none"}
                </p>
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {result.subject.capabilities.slice(0, 12).map((c) => (
                    <code key={c} className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-600">{c}</code>
                  ))}
                  {result.subject.capabilities.length > 12 && <span className="text-xs text-slate-500">+{result.subject.capabilities.length - 12} more</span>}
                </div>
              </div>

              <div>
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Decision trace</p>
                <EvaluationTrace steps={result.result.evaluation} />
              </div>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
