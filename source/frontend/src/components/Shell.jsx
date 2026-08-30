import { useEffect, useRef, useState } from "react";
import { NavLink, Navigate, useLocation } from "react-router-dom";
import {
  Activity, AlertTriangle, BadgeCheck, Bot, Boxes, FileText, Gauge, KeyRound,
  LayoutDashboard, LogOut, Menu, ScrollText, ShieldCheck, Siren, SlidersHorizontal,
  Users, Wallet, X,
} from "lucide-react";
import { useSession } from "../state/session.jsx";
import { Loading, DeniedState, Badge } from "./ui.jsx";
import { useApi } from "../lib/useApi.js";

/**
 * Navigation is filtered by capability so people are not shown doors they cannot open.
 * This is presentation only — the server enforces the same rules independently, and
 * every one of these routes is guarded again on the API side.
 */
const NAV = [
  { to: "/app", label: "Dashboard", icon: LayoutDashboard, end: true },
  { to: "/app/approvals", label: "Approvals", icon: BadgeCheck, capability: "PAYMENT_READ" },
  { to: "/app/payments", label: "Payments", icon: Wallet, capability: "PAYMENT_READ" },
  { to: "/app/assets", label: "Assets", icon: Boxes, capability: "ASSET_READ" },
  { to: "/app/agents", label: "AI Agents", icon: Bot, capability: "AGENT_READ" },
  { to: "/app/assistant", label: "Assistant", icon: Activity, capability: "AGENT_INVOKE" },
  { to: "/app/knowledge", label: "Knowledge", icon: FileText, capability: "KNOWLEDGE_READ" },
  { to: "/app/audit", label: "Audit Trail", icon: ScrollText, capability: "AUDIT_READ" },
  { to: "/app/proofs", label: "Proofs", icon: ShieldCheck, capability: "PROOF_VERIFY" },
];

const ADMIN_NAV = [
  { to: "/app/admin/identities", label: "Identities", icon: Users, capability: "IDENTITY_READ" },
  { to: "/app/admin/roles", label: "Roles & Capabilities", icon: KeyRound, capability: "ROLE_READ" },
  { to: "/app/admin/scopes", label: "Scopes", icon: SlidersHorizontal, capability: "SCOPE_READ" },
  { to: "/app/admin/policies", label: "Policies", icon: FileText, capability: "POLICY_READ" },
  { to: "/app/admin/simulator", label: "Permission Simulator", icon: Gauge, capability: "PERMISSION_SIMULATE" },
  { to: "/app/admin/security", label: "Security & Emergency", icon: Siren, capability: "SECURITY_READ" },
  { to: "/app/admin/integrations", label: "Integrations", icon: Activity, capability: "INTEGRATION_READ" },
];

export function Shell({ children }) {
  const { session, signOut, can } = useSession();
  const emergency = useApi("/api/security/emergency", { skip: !can("SECURITY_READ") });
  const activeFlags = (emergency.data?.flags ?? []).filter((f) => f.enabled);
  const location = useLocation();

  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerRef = useRef(null);
  const openerRef = useRef(null);

  const visible = NAV.filter((item) => !item.capability || can(item.capability));
  const visibleAdmin = ADMIN_NAV.filter((item) => !item.capability || can(item.capability));

  // Navigating closes the drawer. Without this the panel stays over the page the user
  // just asked for, which reads as the tap having failed.
  useEffect(() => { setDrawerOpen(false); }, [location.pathname]);

  // Escape closes, and focus returns to the button that opened it — otherwise a keyboard
  // user is dropped back at the top of the document with no idea where they are.
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (event) => {
      if (event.key === "Escape") { setDrawerOpen(false); openerRef.current?.focus(); }
    };
    document.addEventListener("keydown", onKey);
    // Move focus into the panel so the next Tab lands on a link rather than page content
    // sitting behind the overlay.
    drawerRef.current?.querySelector("a, button")?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [drawerOpen]);

  const sidebar = (
    <>
      <div className="flex items-center gap-3 border-b border-slate-100 px-5 py-4">
        <div className="flex h-8 w-8 items-center justify-center rounded bg-red-600">
          <ShieldCheck className="h-5 w-5 text-white" aria-hidden="true" />
        </div>
        <div>
          <p className="text-sm font-semibold text-slate-900">TrustWeave</p>
          <p className="text-xs text-slate-500">{session?.organization?.name ?? "—"}</p>
        </div>
      </div>

      <nav aria-label="Main" className="flex-1 space-y-6 overflow-y-auto py-4">
        <NavGroup items={visible} />
        {visibleAdmin.length > 0 && <NavGroup label="Control Plane" items={visibleAdmin} />}
      </nav>

      <div className="flex flex-col gap-3 border-t border-slate-100 px-5 py-4">
        <div>
          <p className="truncate text-sm font-medium text-slate-900" title={session?.identity?.email || session?.identity?.id}>
            {session?.identity?.displayName || session?.identity?.email || session?.identity?.id || "Admin"}
          </p>
          <div className="mt-1.5 flex flex-wrap gap-1">
            {session?.roles?.map((r) => <Badge key={r.id ?? r.name} tone="INFO">{r.name}</Badge>)}
          </div>
        </div>
        <button
          onClick={signOut}
          className="inline-flex w-full items-center justify-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 shadow-sm transition-colors hover:bg-red-50 hover:text-red-600 focus:outline-none focus:ring-2 focus:ring-red-600 focus:ring-offset-2"
        >
          <LogOut className="h-3.5 w-3.5" aria-hidden="true" /> Sign out
        </button>
      </div>
    </>
  );

  return (
    <div className="flex min-h-screen bg-slate-50">
      {/* Desktop sidebar — unchanged behaviour at lg and above. */}
      <aside className="sticky top-0 h-screen hidden w-64 shrink-0 flex-col border-r border-slate-200 bg-white lg:flex">
        {sidebar}
      </aside>

      {/* Mobile drawer. Rendered only below lg, so desktop is untouched. */}
      {drawerOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div
            className="absolute inset-0 bg-slate-900/50"
            onClick={() => setDrawerOpen(false)}
            aria-hidden="true"
          />
          <div
            ref={drawerRef}
            id="mobile-navigation"
            role="dialog"
            aria-modal="true"
            aria-label="Navigation"
            className="absolute inset-y-0 left-0 flex w-72 max-w-[85%] flex-col bg-white shadow-xl"
          >
            <div className="flex justify-end px-3 pt-3">
              <button
                onClick={() => { setDrawerOpen(false); openerRef.current?.focus(); }}
                className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-900"
              >
                <X className="h-5 w-5" aria-hidden="true" />
                <span className="sr-only">Close navigation</span>
              </button>
            </div>
            {sidebar}
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile header. Hidden at lg, so the desktop layout is byte-identical. */}
        <header className="flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-3 lg:hidden">
          <button
            ref={openerRef}
            onClick={() => setDrawerOpen(true)}
            aria-expanded={drawerOpen}
            aria-controls="mobile-navigation"
            className="rounded-lg p-2 text-slate-700 hover:bg-red-50 hover:text-red-600 focus:outline-none focus:ring-2 focus:ring-red-600"
          >
            <Menu className="h-5 w-5" aria-hidden="true" />
            <span className="sr-only">Open navigation menu</span>
          </button>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-slate-900">TrustWeave</p>
            <p className="truncate text-xs text-slate-500">{session?.organization?.name ?? "—"}</p>
          </div>
        </header>

        {activeFlags.length > 0 && (
          <div role="status" className="flex items-center gap-2 border-b border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-900 sm:px-6">
            <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>
              <strong>Emergency controls active:</strong>{" "}
              {activeFlags.map((f) => f.flagKey.replace(/_/g, " ").toLowerCase()).join(", ")}. Affected operations are being refused.
            </span>
          </div>
        )}
        <main className="flex-1 px-4 py-5 sm:px-6 sm:py-6">{children}</main>
      </div>
    </div>
  );
}

function NavGroup({ label, items }) {
  return (
    <div>
      {label && <p className="px-5 pb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>}
      <ul className="space-y-0.5">
        {items.map(({ to, label: text, icon: Icon, end }) => (
          <li key={to}>
            <NavLink
              to={to}
              end={end}
              className={({ isActive }) =>
                `flex items-center gap-3 pl-4 pr-5 py-2 text-sm transition border-l-4 ${
                  isActive ? "border-red-600 bg-red-50 font-medium text-red-600" : "border-transparent text-slate-600 hover:bg-red-50 hover:text-red-600"
                }`
              }
            >
              <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
              {text}
            </NavLink>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Requires a signed-in session; bounces to login otherwise, preserving the target. */
export function RequireSession({ children }) {
  const { session, loading } = useSession();
  const location = useLocation();
  if (loading) return <Loading label="Restoring your session…" />;
  if (!session) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return children;
}

/**
 * Client-side capability gate. This exists to give a clear explanation instead of a
 * broken screen — it is NOT the security boundary. Someone who bypasses it by editing
 * the bundle simply reaches an API that refuses them anyway.
 */
export function RequireCapability({ capability, children }) {
  const { can, session } = useSession();
  if (!can(capability)) {
    return (
      <DeniedState
        title="You do not have access to this area"
        error={{
          message: `This page requires the ${capability} capability. Your roles (${
            session?.roles?.map((r) => r.name).join(", ") || "none"
          }) do not include it. Ask an administrator if you believe this is wrong.`,
          reasonCodes: ["CAPABILITY_MISSING"],
          evaluation: [],
        }}
      />
    );
  }
  return children;
}
