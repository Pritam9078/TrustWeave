import { useState } from "react";
import { Siren, ShieldAlert } from "lucide-react";
import { useApi, useMutation } from "../../lib/useApi.js";
import { api } from "../../lib/api.js";
import { useSession } from "../../state/session.jsx";
import {
  Card, PageHeader, Loading, ErrorState, DeniedState, Empty, Badge, Button,
  Field, Input, Banner, Table, Td,
} from "../../components/ui.jsx";
import { dateTime, relative, titleCase } from "../../lib/format.js";

const FLAGS = [
  { key: "AGENTS_DISABLED", label: "Disable all AI agents", detail: "Every agent tool call is refused organization-wide, regardless of the agent's own configuration." },
  { key: "PAYMENTS_DISABLED", label: "Disable all payments", detail: "No payment may be authorized or executed by anyone, including administrators." },
  { key: "MINTING_DISABLED", label: "Disable asset minting", detail: "No new assets may be anchored on-chain." },
];

export function Security() {
  const { can } = useSession();
  const flags = useApi("/api/security/emergency");
  const events = useApi("/api/security/events");
  const [reason, setReason] = useState("");

  const toggle = useMutation(({ flagKey, enabled }) => api.post("/api/security/emergency", { flagKey, enabled, reason }));
  const acknowledge = useMutation((id) => api.post(`/api/security/events/${id}/acknowledge`, {}));

  const active = (flags.data?.flags ?? []).filter((f) => f.enabled);

  async function run(m, arg) { const r = await m.run(arg); if (r.ok) { flags.reload(); events.reload(); } }

  return (
    <>
      <PageHeader
        title="Security & Emergency Controls"
        description="Organization-wide kill switches and the security event log. These controls override individual permissions — nobody is exempt."
      />

      {active.length > 0 && (
        <div className="mb-4">
          <Banner tone="danger" icon={Siren}>
            <strong>{active.length} emergency control(s) active.</strong> Affected operations are being refused across the entire organization.
          </Banner>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Emergency controls" description="Immediate, organization-wide, and recorded as critical security events.">
          {flags.status === "loading" && <Loading />}
          {flags.status === "denied" && <DeniedState error={flags.error} />}
          {flags.status === "loaded" && (
            <div className="space-y-3">
              {can("EMERGENCY_CONTROL") && (
                <Field label="Reason" hint="Recorded permanently with whichever control you change.">
                  <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why are you doing this?" />
                </Field>
              )}
              {FLAGS.map((f) => {
                const current = flags.data.flags.find((x) => x.flagKey === f.key);
                const enabled = Boolean(current?.enabled);
                return (
                  <div key={f.key} className={`rounded-lg border px-3 py-3 ${enabled ? "border-rose-300 bg-rose-50" : "border-slate-200"}`}>
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-medium text-slate-900">{f.label}</p>
                        <p className="mt-0.5 text-xs text-slate-600">{f.detail}</p>
                        {enabled && current?.reason && <p className="mt-1 text-xs text-rose-700">Reason: {current.reason}</p>}
                      </div>
                      {can("EMERGENCY_CONTROL") && (
                        <Button
                          size="sm"
                          variant={enabled ? "secondary" : "danger"}
                          loading={toggle.status === "running"}
                          onClick={() => run(toggle, { flagKey: f.key, enabled: !enabled })}
                        >
                          {enabled ? "Lift" : "Activate"}
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
              {toggle.status === "denied" && <DeniedState error={toggle.error} />}
            </div>
          )}
        </Card>

        <Card title="Security events" description="Injection attempts, blocked agent actions, invalid webhook signatures and emergency changes.">
          {events.status === "loading" && <Loading />}
          {events.status === "denied" && <DeniedState error={events.error} />}
          {events.status === "loaded" && (
            events.data.events.length ? (
              <ul className="space-y-2">
                {events.data.events.slice(0, 20).map((e) => (
                  <li key={e.id} className={`rounded-lg border px-3 py-2 ${
                    e.severity === "CRITICAL" ? "border-rose-200 bg-rose-50" : e.severity === "HIGH" ? "border-amber-200 bg-amber-50" : "border-slate-200"
                  }`}>
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-slate-500" aria-hidden="true" />
                          <span className="font-mono text-xs font-medium text-slate-800">{e.kind}</span>
                          <Badge tone={e.severity === "CRITICAL" ? "DENY" : e.severity === "HIGH" ? "REQUIRE_APPROVAL" : "INFO"}>{e.severity}</Badge>
                        </div>
                        <p className="mt-1 text-sm text-slate-700">{e.summary}</p>
                        <p className="mt-0.5 text-xs text-slate-500">{dateTime(e.createdAt)}</p>
                      </div>
                      {!e.acknowledgedAt && (
                        <Button size="sm" variant="ghost" onClick={() => run(acknowledge, e.id)}>Acknowledge</Button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            ) : <Empty title="No security events" description="Injection attempts and blocked actions will appear here." />
          )}
        </Card>
      </div>
    </>
  );
}

export function Integrations() {
  const { status, data, error, reload } = useApi("/api/integrations/status");

  if (status === "loading") return <Loading />;
  if (status === "denied") return <DeniedState error={error} />;
  if (status === "error") return <ErrorState error={error} onRetry={reload} />;

  const sections = [
    { key: "blockchain", title: "Blockchain", detail: data.blockchain },
    { key: "payments", title: "Payments (Razorpay)", detail: data.payments },
    { key: "ai", title: "AI provider", detail: data.ai },
  ];

  return (
    <>
      <PageHeader
        title="Integrations"
        description="Which adapters are live and which are simulated. Nothing here pretends a simulated call reached a real provider."
      />
      <div className="grid gap-4 md:grid-cols-3">
        {sections.map(({ key, title, detail }) => (
          <Card key={key} title={title}>
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Badge tone={detail.mode === "LIVE" ? "ALLOW" : "INFO"}>{detail.mode}</Badge>
                <code className="font-mono text-xs text-slate-600">{detail.adapter ?? detail.provider}</code>
              </div>
              <p className="text-sm text-slate-600">{detail.note}</p>
              {detail.contracts && Object.keys(detail.contracts).length > 0 && (
                <dl className="mt-2 space-y-1">
                  {Object.entries(detail.contracts).map(([name, address]) => (
                    <div key={name}>
                      <dt className="text-xs font-medium text-slate-500">{name}</dt>
                      <dd className="break-all font-mono text-xs text-slate-700">{address}</dd>
                    </div>
                  ))}
                </dl>
              )}
              {"keyConfigured" in detail && (
                <p className="text-xs text-slate-500">API key configured: {detail.keyConfigured ? "yes" : "no"}</p>
              )}
              {"webhookSecretConfigured" in detail && (
                <p className="text-xs text-slate-500">Webhook secret configured: {detail.webhookSecretConfigured ? "yes" : "no"}</p>
              )}
            </div>
          </Card>
        ))}
      </div>
    </>
  );
}
