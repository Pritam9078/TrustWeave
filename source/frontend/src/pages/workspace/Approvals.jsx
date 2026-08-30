import { useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { useApi, useMutation } from "../../lib/useApi.js";
import { api } from "../../lib/api.js";
import {
  Card, PageHeader, Loading, ErrorState, DeniedState, Empty, Badge, Button,
  Table, Td, Textarea, Field, Banner, EvaluationTrace, SuccessBanner,
} from "../../components/ui.jsx";
import { money, dateTime, relative, titleCase } from "../../lib/format.js";

export function ApprovalList() {
  const [filter, setFilter] = useState("PENDING");
  const { status, data, error, reload } = useApi(`/api/approvals?status=${filter}`);
  const navigate = useNavigate();

  return (
    <>
      <PageHeader
        title="Approval Center"
        description="Actions the policy engine held for human judgement. Approving is a capability, not a courtesy — and nobody may approve their own request."
        actions={
          <div className="flex gap-1 rounded-lg bg-slate-100 p-1">
            {["PENDING", "APPROVED", "REJECTED"].map((s) => (
              <button
                key={s}
                onClick={() => setFilter(s)}
                className={`rounded-md px-3 py-1 text-xs font-medium ${filter === s ? "bg-white text-slate-900 shadow-sm" : "text-slate-600"}`}
              >
                {titleCase(s)}
              </button>
            ))}
          </div>
        }
      />

      <Card>
        {status === "loading" && <Loading />}
        {status === "denied" && <DeniedState error={error} />}
        {status === "error" && <ErrorState error={error} onRetry={reload} />}
        {status === "loaded" && (
          <Table
            columns={["Type", "Reason", "Requested by", "Required capability", "Status", "When"]}
            rows={data.approvals}
            onRowClick={(row) => navigate(`/app/approvals/${row.id}`)}
            empty={<Empty title={`No ${filter.toLowerCase()} approvals`} description="Requests routed to approval by policy will appear here." />}
            renderRow={(a) => (
              <>
                <Td><span className="font-medium text-slate-900">{titleCase(a.requestType)}</span></Td>
                <Td className="max-w-md text-slate-600">{a.reason}</Td>
                <Td>{a.requesterName ?? "—"}</Td>
                <Td mono>{a.requiredCapability}</Td>
                <Td><Badge>{a.status}</Badge></Td>
                <Td className="whitespace-nowrap text-slate-500">{relative(a.createdAt)}</Td>
              </>
            )}
          />
        )}
      </Card>
    </>
  );
}

export function ApprovalDetail() {
  const { id } = useParams();
  const { status, data, error, reload } = useApi(`/api/approvals/${id}`);
  const [note, setNote] = useState("");
  const decide = useMutation((decision) => api.post(`/api/approvals/${id}/decide`, { decision, note }));

  if (status === "loading") return <Loading />;
  if (status === "denied") return <DeniedState error={error} />;
  if (status === "error") return <ErrorState error={error} onRetry={reload} />;

  const { approval, intent, timeline, canDecide, cannotDecideReason } = data;

  async function submit(decision) {
    const result = await decide.run(decision);
    if (result.ok) reload();
  }

  return (
    <>
      <PageHeader
        title={`${titleCase(approval.requestType)} approval`}
        description={approval.reason}
        actions={<Link to="/app/approvals"><Button variant="secondary" size="sm">Back to list</Button></Link>}
      />

      {decide.status === "success" && (
        <div className="mb-4">
          {decide.data?.alreadyDecided
            ? <Banner tone="warn">This request had already been decided. No duplicate action was taken.</Banner>
            : <SuccessBanner>Decision recorded: {decide.data?.approval?.status}. {decide.data?.intent?.state === "AUTHORIZED" ? "The payment is now cleared to execute." : ""}</SuccessBanner>}
        </div>
      )}
      {decide.status === "denied" && <div className="mb-4"><DeniedState error={decide.error} /></div>}
      {decide.status === "error" && <div className="mb-4"><ErrorState error={decide.error} /></div>}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          {intent && (
            <Card title="What is being approved">
              <dl className="grid gap-3 sm:grid-cols-2">
                <Detail label="Vendor" value={intent.merchant} />
                <Detail label="Amount" value={money(intent.amount, intent.currency)} />
                <Detail label="Purpose" value={intent.purpose || "—"} />
                <Detail label="Invoice reference" value={intent.invoiceRef || "—"} />
                <Detail label="Requested by" value={intent.agentName ? `${intent.agentName} (AI agent)` : intent.actorName} />
                <Detail label="Department" value={intent.departmentName || "—"} />
                <Detail label="Current state" value={<Badge>{intent.state}</Badge>} />
                <Detail label="Policy version" value={intent.policyVersion ? `v${intent.policyVersion}` : "—"} />
              </dl>
            </Card>
          )}

          <Card title="Decision trail" description="Every step recorded under this request's trace.">
            {timeline?.length ? (
              <ul className="divide-y divide-slate-100">
                {timeline.map((e) => (
                  <li key={e.id} className="flex items-start justify-between gap-3 py-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-slate-800">{titleCase(e.action)}</p>
                      <p className="text-xs text-slate-500">{e.actorName ?? e.actorDid ?? "system"} · {dateTime(e.timestamp)}</p>
                      {e.reasonCodes?.length > 0 && (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {e.reasonCodes.map((r) => <span key={r} className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-600">{r}</span>)}
                        </div>
                      )}
                    </div>
                    <Badge>{e.decision}</Badge>
                  </li>
                ))}
              </ul>
            ) : <Empty title="No recorded steps" />}
          </Card>
        </div>

        <div className="space-y-4">
          <Card title="Your decision">
            {approval.status !== "PENDING" ? (
              <div className="space-y-2">
                <Badge>{approval.status}</Badge>
                <p className="text-sm text-slate-600">
                  Decided by {approval.approverName ?? "—"} on {dateTime(approval.decidedAt)}.
                </p>
                {approval.decisionNote && <p className="rounded-lg bg-slate-50 p-2 text-sm text-slate-700">{approval.decisionNote}</p>}
              </div>
            ) : canDecide ? (
              <div className="space-y-3">
                <Field label="Note" hint="Recorded permanently in the audit trail alongside your decision.">
                  <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What did you check?" />
                </Field>
                <div className="flex gap-2">
                  <Button variant="approve" className="flex-1" loading={decide.status === "running"} onClick={() => submit("APPROVED")}>Approve</Button>
                  <Button variant="danger" className="flex-1" loading={decide.status === "running"} onClick={() => submit("REJECTED")}>Reject</Button>
                </div>
              </div>
            ) : (
              <Banner tone="warn">{cannotDecideReason ?? "You cannot decide this request."}</Banner>
            )}
          </Card>

          <Card title="Governing policy">
            <dl className="space-y-2">
              <Detail label="Required capability" value={<code className="font-mono text-xs">{approval.requiredCapability}</code>} />
              <Detail label="Policy" value={approval.policyId ? `${approval.policyId} v${approval.policyVersion}` : "—"} />
              <Detail label="Trace" value={<code className="break-all font-mono text-xs">{approval.traceId}</code>} />
            </dl>
          </Card>
        </div>
      </div>
    </>
  );
}

function Detail({ label, value }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-0.5 text-sm text-slate-900">{value}</dd>
    </div>
  );
}
