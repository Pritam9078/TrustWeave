import { Link } from "react-router-dom";
import { ShieldCheck, AlertTriangle } from "lucide-react";
import { useApi } from "../lib/useApi.js";
import { useSession } from "../state/session.jsx";
import { Card, PageHeader, Stat, Loading, ErrorState, Empty, Badge, Button, Banner } from "../components/ui.jsx";
import { money, relative, titleCase } from "../lib/format.js";

/**
 * One dashboard, assembled from whatever the viewer is entitled to see. The server
 * omits entire sections for actors without the relevant capability, so the page adapts
 * to the role rather than rendering empty admin panels for a normal user.
 */
export default function Dashboard() {
  const { session } = useSession();
  const { status, data, error, reload } = useApi("/api/dashboard");

  if (status === "loading") return <Loading label="Loading your workspace…" />;
  if (status === "error") return <ErrorState error={error} onRetry={reload} />;

  const firstName = (session?.identity?.displayName ?? "").split(" ")[0];

  return (
    <>
      <PageHeader
        title={firstName ? `Welcome back, ${firstName}` : "Dashboard"}
        description={`Signed in as ${session?.roles?.map((r) => r.name).join(", ") || "member"}${
          session?.departmentId ? " · department-scoped" : ""
        }. You are shown only what your roles and scopes permit.`}
      />

      {data?.auditChain && !data.auditChain.valid && (
        <div className="mb-6">
          <Banner tone="danger" icon={AlertTriangle}>
            <strong>The audit chain does not verify.</strong> A record appears to have been altered
            at sequence {data.auditChain.brokenAtSeq}. Investigate before trusting recent reports.
          </Banner>
        </div>
      )}

      <div className="mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {data?.payments && (
          <>
            <Stat label="Awaiting approval" value={data.payments.pendingApproval} tone={data.payments.pendingApproval ? "warn" : "default"} />
            <Stat label="Executed value" value={money(data.payments.valueExecuted)} hint={`${data.payments.executed} payment(s)`} />
            <Stat label="Denied by policy" value={data.payments.denied} tone={data.payments.denied ? "danger" : "default"} />
            <Stat label="Unreconciled" value={data.payments.unreconciled} tone={data.payments.unreconciled ? "warn" : "good"} />
          </>
        )}
        {!data?.payments && data?.assets && (
          <>
            <Stat label="Assets" value={data.assets.total} />
            <Stat label="Minted on-chain" value={data.assets.minted} />
            <Stat label="Frozen" value={data.assets.frozen} tone={data.assets.frozen ? "warn" : "default"} />
            <Stat label="Revoked" value={data.assets.revoked} />
          </>
        )}
      </div>

      {(data?.agents || data?.identities || data?.security) && (
        <div className="mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {data?.agents && (
            <>
              <Stat label="Active agents" value={`${data.agents.active}/${data.agents.total}`} hint={data.agents.frozen ? `${data.agents.frozen} frozen` : undefined} />
              <Stat label="Agent calls today" value={data.agents.callsToday} hint={`${data.agents.deniedToday} denied`} tone={data.agents.deniedToday ? "warn" : "default"} />
            </>
          )}
          {data?.identities && <Stat label="Identities" value={`${data.identities.active}/${data.identities.total}`} hint={data.identities.suspended ? `${data.identities.suspended} suspended` : "all active"} />}
          {data?.security && <Stat label="Open security events" value={data.security.open} tone={data.security.critical ? "danger" : data.security.open ? "warn" : "good"} hint={data.security.critical ? `${data.security.critical} critical` : undefined} />}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card
          title="Waiting for your decision"
          description="Requests you are authorised to approve. You will never see your own here."
          actions={<Link to="/app/approvals"><Button size="sm" variant="secondary">Open Approval Center</Button></Link>}
        >
          {data?.pendingForMe?.length ? (
            <ul className="space-y-2">
              {data.pendingForMe.map((a) => (
                <li key={a.id}>
                  <Link to={`/app/approvals/${a.id}`} className="block rounded-lg border border-slate-200 px-3 py-2 hover:bg-slate-50">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium text-slate-900">{titleCase(a.requestType)}</span>
                      <Badge>PENDING</Badge>
                    </div>
                    <p className="mt-0.5 text-sm text-slate-600">{a.reason}</p>
                    <p className="mt-0.5 text-xs text-slate-500">Requires {a.requiredCapability} · {relative(a.createdAt)}</p>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <Empty title="Nothing awaiting you" description="Approvals you are entitled to decide will appear here." />
          )}
        </Card>

        <Card
          title="Recent activity"
          description="Every decision, allowed or denied, in the order it was recorded."
          actions={<Link to="/app/audit"><Button size="sm" variant="secondary">Full audit trail</Button></Link>}
        >
          {data?.recentActivity?.length ? (
            <ul className="divide-y divide-slate-100">
              {data.recentActivity.slice(0, 8).map((e) => (
                <li key={e.id} className="flex items-start justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-slate-800">{titleCase(e.action)}</p>
                    <p className="truncate text-xs text-slate-500">{e.actorName ?? e.actorDid ?? "system"} · {relative(e.timestamp)}</p>
                  </div>
                  <Badge>{e.decision}</Badge>
                </li>
              ))}
            </ul>
          ) : (
            <Empty title="No activity yet" description="Actions you take will be recorded here." />
          )}
        </Card>
      </div>

      {data?.auditChain?.valid && (
        <div className="mt-4">
          <Banner tone="good" icon={ShieldCheck}>
            Audit chain verified: {data.auditChain.eventCount} events hash-linked from genesis with no gaps or alterations.
          </Banner>
        </div>
      )}
    </>
  );
}
