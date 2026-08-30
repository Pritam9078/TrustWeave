import { useState } from "react";
import { FileSearch } from "lucide-react";
import { useApi, useMutation } from "../../lib/useApi.js";
import { api } from "../../lib/api.js";
import { useSession } from "../../state/session.jsx";
import {
  Card, PageHeader, Loading, ErrorState, DeniedState, Empty, Badge, Button,
  Table, Td, Field, Input, Textarea, Select, Banner,
} from "../../components/ui.jsx";
import { relative } from "../../lib/format.js";

export default function Knowledge() {
  const { can } = useSession();
  const { status, data, error, reload } = useApi("/api/knowledge/documents");
  const [query, setQuery] = useState("");
  const [showIngest, setShowIngest] = useState(false);
  const search = useMutation((q) => api.post("/api/knowledge/search", { query: q }));

  return (
    <>
      <PageHeader
        title="Knowledge Base"
        description="Documents the AI may retrieve from. Retrieval is filtered by the asking actor's own scopes — there is no unfiltered search path in the codebase."
        actions={can("KNOWLEDGE_MANAGE") && <Button size="sm" onClick={() => setShowIngest((s) => !s)}>{showIngest ? "Cancel" : "Add document"}</Button>}
      />

      {showIngest && <div className="mb-4"><IngestForm onDone={() => { setShowIngest(false); reload(); }} /></div>}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Search" description="Run a retrieval as yourself and see exactly what is withheld.">
          <form onSubmit={(e) => { e.preventDefault(); search.run(query); }} className="flex gap-2">
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="invoice, policy, compensation…" />
            <Button type="submit" loading={search.status === "running"}>Search</Button>
          </form>

          {search.status === "denied" && <div className="mt-4"><DeniedState error={search.error} /></div>}
          {search.status === "success" && (
            <div className="mt-4 space-y-3">
              {search.data.chunks?.length ? (
                <ul className="space-y-2">
                  {search.data.chunks.map((c) => (
                    <li key={c.chunkId} className="rounded-lg border border-slate-200 px-3 py-2">
                      <p className="text-sm font-medium text-slate-800">{c.title}</p>
                      <p className="mt-0.5 text-xs text-slate-600">{c.content}</p>
                    </li>
                  ))}
                </ul>
              ) : <Empty title="No accessible matches" />}

              {search.data.filtered?.excluded?.length > 0 && (
                <Banner tone="info" icon={FileSearch}>
                  <strong>{search.data.filtered.excluded.length} document(s) withheld from you:</strong>
                  <ul className="mt-1 space-y-0.5">
                    {search.data.filtered.excluded.map((x) => <li key={x.documentId} className="text-xs">{x.title} — {x.reason}</li>)}
                  </ul>
                </Banner>
              )}
            </div>
          )}
        </Card>

        <Card title="Documents">
          {status === "loading" && <Loading />}
          {status === "denied" && <DeniedState error={error} />}
          {status === "error" && <ErrorState error={error} onRetry={reload} />}
          {status === "loaded" && (
            <Table
              columns={["Title", "Type", "Classification", "Added"]}
              rows={data.documents}
              empty={<Empty title="No documents" />}
              renderRow={(d) => (
                <>
                  <Td><span className="font-medium text-slate-900">{d.title}</span></Td>
                  <Td className="text-slate-600">{d.sourceType}</Td>
                  <Td><Badge tone={d.classification === "RESTRICTED" ? "DENY" : "INFO"}>{d.classification}</Badge></Td>
                  <Td className="whitespace-nowrap text-slate-500">{relative(d.createdAt)}</Td>
                </>
              )}
            />
          )}
        </Card>
      </div>
    </>
  );
}

function IngestForm({ onDone }) {
  const org = useApi("/api/organization");
  const [form, setForm] = useState({ title: "", sourceType: "POLICY_DOC", classification: "INTERNAL", departmentId: "", content: "" });
  const ingest = useMutation(() => api.post("/api/knowledge/documents", {
    title: form.title.trim(), sourceType: form.sourceType, classification: form.classification,
    departmentId: form.departmentId || null, content: form.content,
    scope: form.departmentId ? { departmentId: form.departmentId } : {},
  }));

  async function submit(e) {
    e.preventDefault();
    const outcome = await ingest.run();
    if (outcome.ok) onDone();
  }
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <Card title="Add document" description="Scoping a document to a department is what keeps it out of other departments' retrievals.">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Title"><Input value={form.title} onChange={set("title")} required /></Field>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Type"><Input value={form.sourceType} onChange={set("sourceType")} /></Field>
          <Field label="Classification">
            <Select value={form.classification} onChange={set("classification")}>
              {["PUBLIC", "INTERNAL", "RESTRICTED"].map((c) => <option key={c} value={c}>{c}</option>)}
            </Select>
          </Field>
          <Field label="Department">
            <Select value={form.departmentId} onChange={set("departmentId")}>
              <option value="">Organization-wide</option>
              {(org.data?.departments ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </Select>
          </Field>
        </div>
        <Field label="Content"><Textarea rows={6} value={form.content} onChange={set("content")} required /></Field>
        {ingest.status === "denied" && <DeniedState error={ingest.error} />}
        {ingest.status === "error" && <ErrorState error={ingest.error} />}
        <Button type="submit" loading={ingest.status === "running"} className="w-full">Ingest</Button>
      </form>
    </Card>
  );
}
