import { useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { useApi, useMutation } from "../../lib/useApi.js";
import { api } from "../../lib/api.js";
import { useSession } from "../../state/session.jsx";
import {
  Card, PageHeader, Loading, ErrorState, DeniedState, Empty, Badge, Button, Table, Td,
  Field, Input, Textarea, Banner, EvaluationTrace, SuccessBanner, WarnBanner,
} from "../../components/ui.jsx";
import { money, dateTime, relative } from "../../lib/format.js";

export function PaymentList() {
  const navigate = useNavigate();
  const { can } = useSession();
  const { status, data, error, reload } = useApi("/api/payment-intents");

  return (
    <>
      <PageHeader
        title="Payments"
        description="Every payment passes authorization, policy and (where required) human approval before a provider is ever contacted."
        actions={can("PAYMENT_CREATE") && <Link to="/app/payments/new"><Button size="sm">New payment</Button></Link>}
      />
      <Card>
        {status === "loading" && <Loading />}
        {status === "denied" && <DeniedState error={error} />}
        {status === "error" && <ErrorState error={error} onRetry={reload} />}
        {status === "loaded" && (
          <Table
            columns={["Vendor", "Amount", "Requested by", "State", "Decision", "When"]}
            rows={data.intents}
            onRowClick={(row) => navigate(`/app/payments/${row.id}`)}
            empty={<Empty title="No payments yet" description="Payments you raise or are entitled to see will appear here." />}
            renderRow={(p) => (
              <>
                <Td><span className="font-medium text-slate-900">{p.merchant}</span></Td>
                <Td className="tabular-nums">{money(p.amount, p.currency)}</Td>
                <Td>{p.agentName ? <span>{p.agentName} <Badge tone="INFO">AI</Badge></span> : p.actorName ?? "—"}</Td>
                <Td>
                  <Badge>{p.state}</Badge>
                  {p.simulated && <Badge tone="REQUIRE_APPROVAL">SIMULATED</Badge>}
                </Td>
                <Td>{p.decision ? <Badge>{p.decision}</Badge> : "—"}</Td>
                <Td className="whitespace-nowrap text-slate-500">{relative(p.createdAt)}</Td>
              </>
            )}
          />
        )}
      </Card>
    </>
  );
}

/**
 * The create → authorize flow, shown as two visible steps rather than one hidden one.
 * Seeing the authorization decision separately from the request is the entire point:
 * the user watches the engine decide, including when it refuses them.
 */
export function PaymentCreate() {
  const navigate = useNavigate();
  const [form, setForm] = useState({ merchant: "", amount: "", currency: "INR", purpose: "", invoiceRef: "" });
  const [result, setResult] = useState(null);

  const create = useMutation(async () => {
    const created = await api.post("/api/payment-intents", {
      merchant: form.merchant.trim(),
      amount: Number(form.amount),
      currency: form.currency,
      purpose: form.purpose,
      invoiceRef: form.invoiceRef || null,
    });
    const authorized = await api.post(`/api/payment-intents/${created.intent.id}/authorize`);
    return { ...authorized, intentId: created.intent.id, deduplicated: created.deduplicated };
  });

  async function submit(event) {
    event.preventDefault();
    const outcome = await create.run();
    if (outcome.ok) setResult(outcome.data);
  }

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  return (
    <>
      <PageHeader title="New payment" description="The authorization engine evaluates this before any money moves." />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Payment details">
          <form onSubmit={submit} className="space-y-4">
            <Field label="Vendor"><Input value={form.merchant} onChange={set("merchant")} required placeholder="Acme Cloud Services" /></Field>
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2">
                <Field label="Amount"><Input type="number" step="0.01" min="0.01" value={form.amount} onChange={set("amount")} required /></Field>
              </div>
              <Field label="Currency"><Input value={form.currency} onChange={set("currency")} maxLength={3} /></Field>
            </div>
            <Field label="Purpose"><Textarea rows={2} value={form.purpose} onChange={set("purpose")} placeholder="What is this for?" /></Field>
            <Field label="Invoice reference" hint="Optional, but strengthens the audit record."><Input value={form.invoiceRef} onChange={set("invoiceRef")} placeholder="INV-2026-0042" /></Field>
            <Button type="submit" loading={create.status === "running"} className="w-full">Submit for authorization</Button>
          </form>
          {create.status === "denied" && <div className="mt-4"><DeniedState error={create.error} /></div>}
          {create.status === "error" && <div className="mt-4"><ErrorState error={create.error} /></div>}
        </Card>

        <Card title="Authorization outcome" description="The engine's decision, step by step.">
          {!result ? (
            <Empty title="Not evaluated yet" description="Submit the form and the full decision trace appears here." />
          ) : (
            <div className="space-y-4">
              {result.decision === "ALLOW" && <SuccessBanner>Authorized. This payment is cleared to execute.</SuccessBanner>}
              {result.decision === "REQUIRE_APPROVAL" && <WarnBanner>Policy requires human approval. It has been sent to the Approval Center and cannot execute until someone else approves it.</WarnBanner>}
              {result.decision === "DENY" && (
                <DeniedState
                  title="Denied by policy"
                  error={{ message: result.reasonCodes?.join(", "), reasonCodes: result.reasonCodes, evaluation: result.evaluation }}
                />
              )}
              {result.deduplicated && <Banner tone="info">An identical request already existed, so it was reused rather than creating a duplicate.</Banner>}

              {result.evaluation?.length > 0 && result.decision !== "DENY" && (
                <div>
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Decision trace</p>
                  <EvaluationTrace steps={result.evaluation} />
                </div>
              )}

              <Button variant="secondary" className="w-full" onClick={() => navigate(`/app/payments/${result.intentId}`)}>
                Open payment
              </Button>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}

export function PaymentDetail() {
  const { id } = useParams();
  const { can } = useSession();
  const { status, data, error, reload } = useApi(`/api/payment-intents/${id}`);
  const execute = useMutation(() => api.post(`/api/payment-intents/${id}/execute`));
  const simulate = useMutation(() => api.post(`/api/payments/${id}/simulate-webhook`, { event: "payment.captured" }));

  if (status === "loading") return <Loading />;
  if (status === "denied") return <DeniedState error={error} />;
  if (status === "error") return <ErrorState error={error} onRetry={reload} />;

  const { intent, approval, timeline, proofs } = data;

  async function run(mutation) {
    const outcome = await mutation.run();
    if (outcome.ok) reload();
  }

  return (
    <>
      <PageHeader
        title={intent.merchant}
        description={`${money(intent.amount, intent.currency)} · ${intent.purpose || "no stated purpose"}`}
        actions={<Link to="/app/payments"><Button variant="secondary" size="sm">Back</Button></Link>}
      />

      {execute.status === "denied" && <div className="mb-4"><DeniedState error={execute.error} /></div>}
      {execute.status === "error" && <div className="mb-4"><ErrorState error={execute.error} /></div>}
      {execute.status === "success" && (
        <div className="mb-4">
          {execute.data?.intent?.simulated === false ? (
            <SuccessBanner>Sent to Razorpay. Order {execute.data.intent.providerOrderId}.</SuccessBanner>
          ) : (
            <WarnBanner>
              <strong>Simulated payment — no money moved.</strong> This was executed against the local
              test provider, which performs real signature verification and idempotency but makes no
              network call. Order {execute.data?.intent?.providerOrderId}.
            </WarnBanner>
          )}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card title="Lifecycle" description="Each step recorded under one trace, from request to reconciliation.">
            <StateFlow state={intent.state} />
            <ul className="mt-4 divide-y divide-slate-100">
              {timeline.map((e) => (
                <li key={e.id} className="flex items-start justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-slate-800">{e.action.replace(/_/g, " ")}</p>
                    <p className="text-xs text-slate-500">{e.actorName ?? e.actorDid ?? "system"} · {dateTime(e.timestamp)}</p>
                  </div>
                  <Badge>{e.decision}</Badge>
                </li>
              ))}
            </ul>
          </Card>

          {proofs?.length > 0 && (
            <Card title="Anchored proofs">
              <ul className="space-y-2">
                {proofs.map((p) => (
                  <li key={p.id} className="rounded-lg border border-slate-200 px-3 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <code className="truncate font-mono text-xs text-slate-700">{p.commitment}</code>
                      <Badge>{p.status}</Badge>
                    </div>
                    <p className="mt-0.5 text-xs text-slate-500">{p.txHash ? `tx ${p.txHash}` : "not yet anchored"}</p>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>

        <div className="space-y-4">
          <Card title="Status">
            <dl className="space-y-2">
              <Row label="State" value={<Badge>{intent.state}</Badge>} />
              <Row label="Decision" value={intent.decision ? <Badge>{intent.decision}</Badge> : "—"} />
              <Row
                label="Provider"
                value={
                  intent.simulated === null || intent.simulated === undefined
                    ? "not executed"
                    : intent.simulated
                      ? <Badge tone="REQUIRE_APPROVAL">SIMULATED</Badge>
                      : <Badge tone="ALLOW">LIVE — Razorpay</Badge>
                }
              />
              <Row label="Provider order" value={intent.providerOrderId ?? "—"} mono />
              <Row label="Provider payment" value={intent.providerPaymentId ?? "—"} mono />
              <Row label="Policy" value={intent.policyVersion ? `v${intent.policyVersion}` : "—"} />
            </dl>

            {intent.reasonCodes?.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1">
                {intent.reasonCodes.map((r) => <span key={r} className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-600">{r}</span>)}
              </div>
            )}

            <div className="mt-4 space-y-2">
              {intent.state === "AUTHORIZED" && can("PAYMENT_EXECUTE") && (
                <Button className="w-full" loading={execute.status === "running"} onClick={() => run(execute)}>Execute payment</Button>
              )}
              {intent.state === "AWAITING_APPROVAL" && approval && (
                <Link to={`/app/approvals/${approval.id}`}><Button variant="secondary" className="w-full">View approval request</Button></Link>
              )}
              {intent.state === "EXECUTED" && can("PAYMENT_EXECUTE") && (
                <Button variant="secondary" className="w-full" loading={simulate.status === "running"} onClick={() => run(simulate)}>
                  Simulate provider webhook
                </Button>
              )}
            </div>

            {intent.simulated && (
              <p className="mt-2 rounded-md bg-amber-50 px-2 py-1.5 text-xs text-amber-900">
                No funds were transferred. This payment exists to demonstrate the authorization,
                approval and reconciliation path.
              </p>
            )}

            {intent.state === "EXECUTED" && (
              <p className="mt-2 text-xs text-slate-500">
                Reconciliation waits for a signed provider callback. In local development the button above
                generates a genuinely signed webhook and posts it through the same verification path.
              </p>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}

function StateFlow({ state }) {
  const states = ["DRAFT", "AUTHORIZING", "AUTHORIZED", "EXECUTING", "EXECUTED", "RECONCILED"];
  const terminal = { DENIED: "Denied by policy", FAILED: "Failed at the provider", AWAITING_APPROVAL: "Held for approval" };
  if (terminal[state]) {
    return <Banner tone={state === "DENIED" || state === "FAILED" ? "danger" : "warn"}>{terminal[state]}</Banner>;
  }
  const index = states.indexOf(state);
  return (
    <ol className="flex flex-wrap items-center gap-1.5 text-xs">
      {states.map((s, i) => (
        <li key={s} className={`rounded-md px-2 py-1 font-medium ${
          i < index ? "bg-emerald-50 text-emerald-700" : i === index ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-500"
        }`}>
          {s.replace(/_/g, " ")}
        </li>
      ))}
    </ol>
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
