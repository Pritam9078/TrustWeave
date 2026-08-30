import { AlertTriangle, Ban, CheckCircle2, ChevronRight, Clock, Info, Loader2, ShieldAlert, XCircle } from "lucide-react";

/* ------------------------------------------------------------------ layout */

export function Card({ eyebrow, title, description, actions, children, className = "", variant = "default" }) {
  const isAlert = variant === "alert";
  const borderClass = isAlert ? "border-[#F3CFCF]" : "border-[#E7E6E2]";
  const bgClass = isAlert ? "bg-[#FBEAEA]" : "bg-white";
  const titleClass = isAlert ? "text-[#14151A]" : "text-slate-900";
  
  return (
    <section className={`rounded-md border shadow-sm ${borderClass} ${bgClass} ${className}`}>
      {(eyebrow || title || actions) && (
        <header className={`flex items-start justify-between gap-4 border-b px-5 py-4 ${borderClass}`}>
          <div>
            {eyebrow && <div className="text-[10px] font-mono uppercase tracking-[0.1em] text-[#9A9CA4] mb-1">{eyebrow}</div>}
            {title && <h2 className={`text-[15px] font-semibold ${titleClass}`}>{title}</h2>}
            {description && <p className="mt-0.5 text-sm text-slate-500">{description}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className="px-5 py-4">{children}</div>
    </section>
  );
}

export function PageHeader({ title, description, actions }) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-slate-900">{title}</h1>
        {description && <p className="mt-1 max-w-2xl text-sm text-slate-500">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Stat({ label, value, hint, tone = "default" }) {
  const tones = {
    default: "text-slate-900",
    warn: "text-amber-600",
    danger: "text-rose-600",
    good: "text-emerald-600",
  };
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p className={`mt-1 text-2xl font-semibold tabular-nums ${tones[tone]}`}>{value}</p>
      {hint && <p className="mt-0.5 text-xs text-slate-500">{hint}</p>}
    </div>
  );
}

/* ------------------------------------------------------------------ controls */

export function Button({ variant = "primary", size = "md", loading, children, className = "", ...props }) {
  const base = "inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition " +
    "focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:ring-offset-2 " +
    "disabled:cursor-not-allowed disabled:opacity-50";
  const sizes = { sm: "px-2.5 py-1.5 text-xs", md: "px-3.5 py-2 text-sm" };
  const variants = {
    primary: "bg-slate-900 text-white hover:bg-slate-800",
    secondary: "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50",
    danger: "bg-rose-600 text-white hover:bg-rose-500",
    approve: "bg-emerald-600 text-white hover:bg-emerald-500",
    ghost: "text-slate-600 hover:bg-slate-100",
  };
  return (
    <button className={`${base} ${sizes[size]} ${variants[variant]} ${className}`} disabled={loading || props.disabled} {...props}>
      {loading && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
      {children}
    </button>
  );
}

export function Field({ label, hint, error, children }) {
  // A wrapping <label> associates the control implicitly, which survives refactors better
  // than a hand-maintained htmlFor/id pair. The error is announced when it appears.
  return (
    <label className="block">
      <span className="text-sm font-medium text-slate-700">{label}</span>
      <div className="mt-1">{children}</div>
      {error ? <p role="alert" className="mt-1 text-xs text-rose-700">{error}</p>
        : hint ? <p className="mt-1 text-xs text-slate-600">{hint}</p> : null}
    </label>
  );
}

export function Input(props) {
  return <input {...props} className={`w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-900 focus:ring-2 focus:ring-slate-900 ${props.className ?? ""}`} />;
}

export function Select({ children, ...props }) {
  return (
    <select {...props} className={`w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-slate-900 focus:ring-2 focus:ring-slate-900 ${props.className ?? ""}`}>
      {children}
    </select>
  );
}

export function Textarea(props) {
  return <textarea {...props} className={`w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-900 focus:ring-2 focus:ring-slate-900 ${props.className ?? ""}`} />;
}

/* ------------------------------------------------------------------ status */

const BADGE_TONES = {
  ALLOW: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
  EXECUTED: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
  RECONCILED: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
  APPROVED: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
  ACTIVE: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
  MINTED: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
  DENY: "bg-rose-50 text-rose-700 ring-rose-600/20",
  DENIED: "bg-rose-50 text-rose-700 ring-rose-600/20",
  REJECTED: "bg-rose-50 text-rose-700 ring-rose-600/20",
  REVOKED: "bg-rose-50 text-rose-700 ring-rose-600/20",
  FAILED: "bg-rose-50 text-rose-700 ring-rose-600/20",
  REQUIRE_APPROVAL: "bg-amber-50 text-amber-700 ring-amber-600/20",
  AWAITING_APPROVAL: "bg-amber-50 text-amber-700 ring-amber-600/20",
  PENDING: "bg-amber-50 text-amber-700 ring-amber-600/20",
  FROZEN: "bg-amber-50 text-amber-700 ring-amber-600/20",
  SUSPENDED: "bg-amber-50 text-amber-700 ring-amber-600/20",
  DRAFT: "bg-slate-100 text-slate-600 ring-slate-500/20",
  INFO: "bg-sky-50 text-sky-700 ring-sky-600/20",
  DEFERRED: "bg-sky-50 text-sky-700 ring-sky-600/20",
};

export function Badge({ children, tone }) {
  const key = tone ?? String(children ?? "").toUpperCase();
  const style = BADGE_TONES[key] ?? "bg-slate-100 text-slate-700 ring-slate-500/20";
  return (
    <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${style}`}>
      {String(children ?? "").replace(/_/g, " ")}
    </span>
  );
}

/* ------------------------------------------------------------------ states */

export function Loading({ label = "Loading…" }) {
  // role="status" so a screen reader announces the wait rather than reporting an empty
  // region; the spinner itself carries no meaning and is hidden.
  return (
    <div role="status" className="flex items-center justify-center gap-2 py-12 text-sm text-slate-600">
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> {label}
    </div>
  );
}

export function Empty({ title = "Nothing here yet", description, action }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-slate-300 py-12 text-center">
      <Info className="h-5 w-5 text-slate-500" aria-hidden="true" />
      <p className="text-sm font-medium text-slate-700">{title}</p>
      {description && <p className="max-w-sm text-sm text-slate-500">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry }) {
  return (
    <div role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-4">
      <div className="flex items-start gap-2">
        <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-600" aria-hidden="true" />
        <div className="flex-1">
          <p className="text-sm font-medium text-rose-900">{error?.message ?? "Something went wrong."}</p>
          {error?.code && error.code !== "UNKNOWN" && (
            <p className="mt-0.5 font-mono text-xs text-rose-700">{error.code}</p>
          )}
          {error?.issues && (
            <ul className="mt-2 space-y-0.5 text-xs text-rose-700">
              {error.issues.map((issue, i) => (
                <li key={i}><span className="font-mono">{issue.path}</span>: {issue.message}</li>
              ))}
            </ul>
          )}
          {onRetry && <Button size="sm" variant="secondary" className="mt-3" onClick={onRetry}>Try again</Button>}
        </div>
      </div>
    </div>
  );
}

/**
 * The denial panel.
 *
 * A refusal here is not an error — it is the authorization engine doing its job, and it
 * arrives with the full ordered evaluation trace. Showing that trace turns "Forbidden"
 * into "you hold the capability but the resource is in another department", which is
 * the difference between a user filing a support ticket and a user understanding the
 * system. It also makes the security model legible to an auditor at a glance.
 */
export function DeniedState({ error, title = "This action was not permitted" }) {
  const evaluation = error?.evaluation ?? [];
  const reasons = error?.reasonCodes ?? [];
  return (
    <div role="alert" className="rounded-lg border border-amber-200 bg-amber-50 p-4">
      <div className="flex items-start gap-2">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
        <div className="flex-1">
          <p className="text-sm font-medium text-amber-900">{title}</p>
          <p className="mt-0.5 text-sm text-amber-800">{error?.message}</p>

          {reasons.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {reasons.map((r) => (
                <span key={r} className="rounded bg-amber-100 px-1.5 py-0.5 font-mono text-xs text-amber-900">{r}</span>
              ))}
            </div>
          )}

          {evaluation.length > 0 && (
            <details className="mt-3">
              <summary className="cursor-pointer text-xs font-medium text-amber-900">
                Show the decision trace ({evaluation.length} checks)
              </summary>
              <ol className="mt-2 space-y-1">
                {evaluation.map((step, i) => (
                  <li key={i} className="flex items-start gap-2 text-xs">
                    <EvaluationIcon outcome={step.outcome} />
                    <div>
                      <span className="font-mono font-medium text-amber-900">{step.step}</span>
                      <span className="text-amber-800"> — {step.detail}</span>
                    </div>
                  </li>
                ))}
              </ol>
            </details>
          )}
        </div>
      </div>
    </div>
  );
}

export function EvaluationIcon({ outcome }) {
  if (outcome === "PASS") return <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" aria-hidden="true" />;
  if (outcome === "FAIL") return <Ban className="mt-0.5 h-3.5 w-3.5 shrink-0 text-rose-600" aria-hidden="true" />;
  if (outcome === "HOLD") return <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" aria-hidden="true" />;
  if (outcome === "DEFERRED") return <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-sky-600" aria-hidden="true" />;
  return <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-500" aria-hidden="true" />;
}

/** Renders an evaluation trace inline (used on success paths, not only denials). */
export function EvaluationTrace({ steps = [] }) {
  if (!steps.length) return null;
  return (
    <ol className="space-y-1.5">
      {steps.map((step, i) => (
        <li key={i} className="flex items-start gap-2 text-sm">
          <EvaluationIcon outcome={step.outcome} />
          <div>
            <span className="font-mono text-xs font-medium text-slate-700">{step.step}</span>
            <span className="text-slate-600"> — {step.detail}</span>
          </div>
        </li>
      ))}
    </ol>
  );
}

export function Banner({ tone = "info", icon: Icon = Info, children }) {
  const tones = {
    info: "border-sky-200 bg-sky-50 text-sky-900",
    warn: "border-amber-200 bg-amber-50 text-amber-900",
    danger: "border-rose-200 bg-rose-50 text-rose-900",
    good: "border-emerald-200 bg-emerald-50 text-emerald-900",
  };
  return (
    <div className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-sm ${tones[tone]}`}>
      <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <div className="flex-1">{children}</div>
    </div>
  );
}

export function SuccessBanner({ children }) {
  return <Banner tone="good" icon={CheckCircle2}>{children}</Banner>;
}

export function WarnBanner({ children }) {
  return <Banner tone="warn" icon={AlertTriangle}>{children}</Banner>;
}

/* ------------------------------------------------------------------ table */

export function Table({ columns, rows, renderRow, empty, onRowClick }) {
  if (!rows?.length) return empty ?? <Empty />;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-slate-200">
            {columns.map((c) => (
              <th key={c} scope="col" className="whitespace-nowrap px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-600">{c}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((row, i) => (
            <tr
              key={row.id ?? i}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              // A clickable row is unreachable by keyboard without these. The detail view
              // is also linked from within the row, so this is an enhancement rather than
              // the only route in.
              tabIndex={onRowClick ? 0 : undefined}
              onKeyDown={onRowClick ? (e) => {
                if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onRowClick(row); }
              } : undefined}
              className={onRowClick
                ? "cursor-pointer hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-slate-900"
                : undefined}
            >
              {renderRow(row)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Td({ children, mono, className = "" }) {
  return <td className={`px-3 py-2 align-top ${mono ? "font-mono text-xs" : ""} ${className}`}>{children}</td>;
}

/** Copyable one-time secrets (private keys, agent tokens) shown once and never again. */
export function SecretReveal({ label, value, notice }) {
  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 p-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-amber-900">{label}</p>
      <code className="mt-1 block break-all rounded bg-white px-2 py-1.5 font-mono text-xs text-slate-800">{value}</code>
      {notice && <p className="mt-1.5 text-xs text-amber-800">{notice}</p>}
      <Button
        size="sm"
        variant="secondary"
        className="mt-2"
        onClick={() => navigator.clipboard?.writeText(value)}
      >
        Copy
      </Button>
    </div>
  );
}
